import { describe, expect, it } from "vitest";

import {
  createReviewScope,
  parseScopedReviewMarkdown,
  renderScopedReviewMarkdown,
  reviewGroups,
  reviewScopeErrors,
} from "../../scripts/license-audit-review-scoped.mjs";
import { validateDecisions } from "../../scripts/license-audit.mjs";

const manifest = JSON.stringify({ dependencies: { direct: "1.0.0" } });
const baseDpkg = "base\t1.0.0\tamd64\nbase-only\t2.0.0\tamd64\n";

function fixture() {
  const components: Array<Record<string, unknown>> = [
    {
      id: "deb:base@1.0.0:amd64",
      kind: "debian",
      name: "base",
      version: "1.0.0",
      copyright: { path: "/usr/share/doc/base/copyright" },
    },
    {
      id: "deb:added@1.0.0:amd64",
      kind: "debian",
      name: "added",
      version: "1.0.0",
      copyright: { path: "/usr/share/doc/added/copyright" },
    },
    {
      id: "base-npm:cli@1.0.0:/usr/local/cli",
      kind: "base-npm",
      name: "cli",
      version: "1.0.0",
      location: "/usr/local/cli",
      declaredLicense: "MIT",
    },
    {
      id: "node:v24.0.0",
      kind: "node",
      name: "node",
      version: "v24.0.0",
      location: "/usr/local/bin/node",
    },
    {
      id: "npm:direct@1.0.0:x",
      kind: "npm",
      name: "direct",
      version: "1.0.0",
      location: "/app/node_modules/direct",
      declaredLicense: "MIT",
    },
    {
      id: "npm:transitive@2.0.0:x",
      kind: "npm",
      name: "transitive",
      version: "2.0.0",
      location: "/app/node_modules/transitive",
      declaredLicense: "Apache-2.0",
    },
    {
      id: "browser:chromium",
      kind: "browser",
      name: "chromium",
      version: "1",
      location: "/ms-playwright/chromium",
    },
  ];
  const findings = [
    {
      id: "imprecise-sbom:base-npm:cli",
      type: "imprecise-sbom",
      componentId: "base-npm:cli@1.0.0:/usr/local/cli",
    },
    { id: "missing-sbom:browser:chromium", type: "missing-sbom", componentId: "browser:chromium" },
  ];
  const evidence = {
    sourceCommit: "a".repeat(40),
    image: { reference: `example@sha256:${"b".repeat(64)}` },
    base: { reference: `node@sha256:${"c".repeat(64)}` },
    platform: "linux/amd64",
    inventory: { components },
    findings,
    boundary: { developmentOnly: [], unexpected: [] },
  };
  const scope = createReviewScope(evidence, manifest, baseDpkg);
  const sbom = { packages: [] };
  return { evidence, scope, sbom };
}

describe("focused license review", () => {
  it("separates inherited and added Debian packages, direct and transitive npm packages, and finding groups", () => {
    const { evidence, scope } = fixture();
    const groups = reviewGroups(evidence, scope);

    expect(reviewScopeErrors(evidence, scope, manifest)).toStrictEqual([]);
    expect(groups.components["base-debian"]).toStrictEqual(["deb:base@1.0.0:amd64"]);
    expect(groups.components["runtime-debian"]).toStrictEqual(["deb:added@1.0.0:amd64"]);
    expect(groups.components["npm-transitive"]).toStrictEqual(["npm:transitive@2.0.0:x"]);
    expect(groups.individualComponents).toMatchObject([
      { id: "npm:direct@1.0.0:x" },
      { id: "browser:chromium" },
    ]);
    expect(groups.findings["imprecise-base-npm"]).toStrictEqual(["imprecise-sbom:base-npm:cli"]);
    expect(groups.individualFindings).toMatchObject([{ id: "missing-sbom:browser:chromium" }]);
  });

  it("rejects a source manifest that differs from the copied application manifest", () => {
    const { evidence, scope } = fixture();
    evidence.inventory.components.push({
      id: "app:stellara",
      kind: "application",
      name: "stellara",
      version: "1.0.0",
      location: "/app",
      manifest: { path: "/app/package.json", sha256: "0".repeat(64) },
    });
    expect(reviewScopeErrors(evidence, scope, manifest)).toContain(
      "Source manifest differs from the application manifest in the image",
    );
  });

  it("imports a short pending worksheet without silently approving any group members", () => {
    const { evidence, scope, sbom } = fixture();
    const view = renderScopedReviewMarkdown(evidence, sbom, scope);
    const decisions = parseScopedReviewMarkdown(view, evidence, scope);

    expect(view).toContain("Vollständige Mitgliederliste");
    expect(Object.keys(decisions.components)).toHaveLength(2);
    expect(Object.keys(decisions.groups.components)).toHaveLength(4);
    expect(decisions.groups.components["base-debian"]).toMatchObject({
      decision: null,
      memberIds: ["deb:base@1.0.0:amd64"],
    });
    expect(validateDecisions(evidence, decisions, scope)).toContain(
      "Incomplete component group decision: base-debian",
    );
  });

  it("accepts an explicit, fully documented group and rejects tampered membership or scope", () => {
    const { evidence, scope, sbom } = fixture();
    const decisions = parseScopedReviewMarkdown(
      renderScopedReviewMarkdown(evidence, sbom, scope),
      evidence,
      scope,
    );
    decisions.groups.components["base-debian"] = {
      decision: "covered",
      reviewer: "Qualified reviewer",
      method: "Checked the exact base-image inventory and Debian copyright records",
      obligations: "Recorded package-specific license and notice obligations",
      evidence: ["review/base-inventory.json"],
      delivery: "Required notices retained in the image",
      memberIds: ["deb:base@1.0.0:amd64"],
    };

    expect(validateDecisions(evidence, decisions, scope)).not.toContain(
      "Incomplete component group decision: base-debian",
    );
    decisions.groups.components["base-debian"] = {
      ...decisions.groups.components["base-debian"],
      memberIds: ["deb:added@1.0.0:amd64"],
    };
    expect(validateDecisions(evidence, decisions, scope)).toContain(
      "Incorrect component group membership: base-debian",
    );
    expect(() =>
      parseScopedReviewMarkdown(renderScopedReviewMarkdown(evidence, sbom, scope), evidence, {
        ...scope,
        baseReference: "other",
      }),
    ).toThrow(/not bound/u);
  });

  it("rejects a changed displayed group inventory", () => {
    const { evidence, scope, sbom } = fixture();
    const view = renderScopedReviewMarkdown(evidence, sbom, scope);
    const changed = view.replace("- `deb:base@1.0.0:amd64` –", "- `deb:added@1.0.0:amd64` –");
    expect(() => parseScopedReviewMarkdown(changed, evidence, scope)).toThrow(
      /Group member list differs from evidence/u,
    );
  });

  it("passes only after every individual and group record is explicitly completed", () => {
    const { evidence, scope, sbom } = fixture();
    const decisions = parseScopedReviewMarkdown(
      renderScopedReviewMarkdown(evidence, sbom, scope),
      evidence,
      scope,
    );
    for (const id of Object.keys(decisions.components)) {
      decisions.components[id] = {
        decision: "approved",
        reviewer: "Qualified reviewer",
        terms: "MIT",
        evidence: ["test-fixture/LICENSE"],
        noticeDisposition: { action: "included", location: "test-fixture/NOTICES" },
      };
    }
    for (const id of Object.keys(decisions.findings)) {
      decisions.findings[id] = {
        decision: "resolved",
        reviewer: "Qualified reviewer",
        resolution: "Verified against the fixture inventory",
        evidence: ["test-fixture/SBOM"],
      };
    }
    for (const [id, record] of Object.entries(decisions.groups.components)) {
      decisions.groups.components[id] = {
        ...record,
        decision: "covered",
        reviewer: "Qualified reviewer",
        method: "Reviewed every fixture member",
        obligations: "Recorded fixture obligations",
        evidence: ["test-fixture/inventory"],
        delivery: "Fixture notice bundle",
      };
    }
    for (const [id, record] of Object.entries(decisions.groups.findings)) {
      decisions.groups.findings[id] = {
        ...record,
        decision: "resolved",
        reviewer: "Qualified reviewer",
        resolution: "Verified every fixture finding",
        evidence: ["test-fixture/SBOM"],
      };
    }

    expect(validateDecisions(evidence, decisions, scope)).toStrictEqual([]);
  });
});
