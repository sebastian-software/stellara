import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  checkProductionBoundary,
  parseProductionClosure,
  readAttachedSpdx,
  reconcileInventory,
  validateDecisions,
} from "../../scripts/license-audit.mjs";

const lockfile = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      '@example/server':
        specifier: 1.0.0
        version: 1.0.0(@example/peer@2.0.0)
    devDependencies:
      '@example/test-runner':
        specifier: 4.0.0
        version: 4.0.0

snapshots:

  '@example/server@1.0.0(@example/peer@2.0.0)':
    dependencies:
      nested: 3.0.0
    optionalDependencies:
      '@example/peer': 2.0.0

  '@example/peer@2.0.0': {}

  nested@3.0.0:
    dependencies:
      shared: 5.0.0

  shared@5.0.0: {}

  '@example/test-runner@4.0.0':
    dependencies:
      shared: 5.0.0
      dev-only: 6.0.0

  dev-only@6.0.0: {}
`;

function component(id: string, name: string, version: string) {
  return { id, kind: "npm", name, version };
}

// cspell:ignore SPDXID
function spdxPackage(id: string, name: string, version: string) {
  return {
    SPDXID: id,
    name,
    versionInfo: version,
    externalRefs: [{ referenceType: "purl", referenceLocator: `pkg:npm/${name}@${version}` }],
  };
}

function evidenceWithDecisions() {
  const evidence = {
    inventory: {
      components: [component("npm:server", "@example/server", "1.0.0")],
    },
    boundary: { developmentOnly: [], unexpected: [] },
    findings: [{ id: "missing-sbom:npm:server", type: "missing-sbom" }],
  };
  const decisions = {
    evidenceSha256: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
    components: {
      "npm:server": {
        decision: "approved",
        reviewer: "License reviewer",
        terms: "MIT",
        evidence: ["https://example.test/server/LICENSE"],
        noticeDisposition: { action: "linked", location: "release/THIRD_PARTY_NOTICES.md" },
      },
    },
    findings: {
      "missing-sbom:npm:server": {
        decision: "resolved",
        reviewer: "License reviewer",
        resolution: "Verified against the installed package manifest and license file",
        evidence: ["https://example.test/server/package.json"],
      },
    },
  };
  return { evidence, decisions };
}

describe("production lockfile boundary", () => {
  it("traverses peer-qualified, nested, and optional production snapshots without admitting dev-only packages", () => {
    const closure = parseProductionClosure(lockfile);

    expect(closure.production).toStrictEqual([
      "@example/peer@2.0.0",
      "@example/server@1.0.0",
      "nested@3.0.0",
      "shared@5.0.0",
    ]);
    expect(closure.development).toStrictEqual([
      "@example/test-runner@4.0.0",
      "dev-only@6.0.0",
      "shared@5.0.0",
    ]);
    expect(
      checkProductionBoundary(
        [
          component("npm:server", "@example/server", "1.0.0"),
          component("npm:shared", "shared", "5.0.0"),
          component("npm:dev", "dev-only", "6.0.0"),
          component("npm:unknown", "unexpected", "7.0.0"),
          { ...component("deb:unknown", "unexpected", "7.0.0"), kind: "debian" },
        ],
        closure,
      ),
    ).toStrictEqual({
      developmentOnly: ["npm:dev"],
      unexpected: ["npm:unknown"],
      absentProduction: ["@example/peer@2.0.0", "nested@3.0.0"],
    });
  });

  it("reports a production snapshot that is absent from the installed runtime", () => {
    const closure = parseProductionClosure(lockfile);
    const boundary = checkProductionBoundary(
      [
        component("npm:server", "@example/server", "1.0.0"),
        component("npm:nested", "nested", "3.0.0"),
        component("npm:shared", "shared", "5.0.0"),
      ],
      closure,
    );

    expect(boundary).toStrictEqual({
      developmentOnly: [],
      unexpected: [],
      absentProduction: ["@example/peer@2.0.0"],
    });
  });

  it("fails closed when a referenced snapshot is absent", () => {
    expect(() => parseProductionClosure(lockfile.replace("  nested@3.0.0:\n", ""))).toThrow(
      /Missing lockfile snapshot/u,
    );
  });
});

describe("runtime and SPDX reconciliation", () => {
  it("requires the requested platform's attached SBOM for an image index", () => {
    const amd64 = { packages: [spdxPackage("SPDXRef-amd64", "amd64-only", "1.0.0")] };
    const misleadingDefault = {
      packages: [spdxPackage("SPDXRef-default", "wrong-platform", "1.0.0")],
    };
    const indexedImage = {
      manifest: { manifests: [{ platform: { os: "linux", architecture: "amd64" } }] },
      sbom: { SPDX: misleadingDefault, "linux/amd64": { SPDX: amd64 } },
    };

    expect(readAttachedSpdx(indexedImage, "linux/amd64")).toStrictEqual(amd64);
    expect(() => {
      readAttachedSpdx(indexedImage, "linux/arm64");
    }).toThrow(/No attached SPDX SBOM for the exact linux\/arm64 image digest/u);
  });

  it("accepts exact purl identities for npm and Debian components", () => {
    const components = [
      component("npm:server", "@example/server", "1.0.0"),
      { ...component("deb:libfoo", "libfoo", "2.0-1"), kind: "debian" },
    ];
    const spdx = {
      packages: [
        {
          ...spdxPackage("SPDXRef-server", "@example/server", "1.0.0"),
          externalRefs: [
            { referenceType: "purl", referenceLocator: "pkg:npm/%40example/server@1.0.0" },
          ],
        },
        {
          ...spdxPackage("SPDXRef-libfoo", "libfoo", "2.0-1"),
          externalRefs: [
            { referenceType: "purl", referenceLocator: "pkg:deb/debian/libfoo@2.0-1" },
          ],
        },
      ],
    };

    expect(reconcileInventory(components, spdx)).toStrictEqual([]);
  });

  it("reports missing, extra, duplicate, and imprecise SBOM entries", () => {
    const components = [
      component("npm:missing", "missing", "1.0.0"),
      component("npm:duplicate", "duplicate", "2.0.0"),
      component("npm:imprecise", "imprecise", "3.0.0"),
    ];
    const spdx = {
      packages: [
        spdxPackage("SPDXRef-duplicate-1", "duplicate", "2.0.0"),
        spdxPackage("SPDXRef-duplicate-2", "duplicate", "2.0.0"),
        { ...spdxPackage("SPDXRef-imprecise", "imprecise", "3.0.0"), externalRefs: [] },
        spdxPackage("SPDXRef-extra", "extra", "4.0.0"),
      ],
    };

    expect(reconcileInventory(components, spdx)).toMatchObject([
      {
        type: "duplicate-sbom",
        componentId: "npm:duplicate",
        spdxIds: ["SPDXRef-duplicate-1", "SPDXRef-duplicate-2"],
      },
      { type: "extra-sbom", spdxId: "SPDXRef-extra" },
      { type: "imprecise-sbom", componentId: "npm:imprecise" },
      { type: "missing-sbom", componentId: "npm:missing" },
    ]);
  });

  it("flags two installed copies of the same package", () => {
    const components = [
      component("npm:copy-a", "shared", "5.0.0"),
      component("npm:copy-b", "shared", "5.0.0"),
    ];
    const spdx = {
      packages: [spdxPackage("SPDXRef-shared", "shared", "5.0.0")],
    };

    expect(reconcileInventory(components, spdx)).toMatchObject([
      { type: "duplicate-runtime", count: 2 },
    ]);
  });
});

describe("review decisions", () => {
  it("accepts a complete review bound to the captured evidence", () => {
    const { evidence, decisions } = evidenceWithDecisions();

    expect(validateDecisions(evidence, decisions)).toStrictEqual([]);
  });

  it.each(["unknown", "NOASSERTION", "TBD"])("rejects %s as a license decision", (terms) => {
    const { evidence, decisions } = evidenceWithDecisions();
    decisions.components["npm:server"].terms = terms;

    expect(validateDecisions(evidence, decisions)).toContain(
      "Unapproved or incomplete component decision: npm:server",
    );
  });

  it("rejects incomplete component and finding decisions", () => {
    const { evidence, decisions } = evidenceWithDecisions();
    decisions.components["npm:server"].noticeDisposition.location = "";
    decisions.findings["missing-sbom:npm:server"].evidence = [];

    expect(validateDecisions(evidence, decisions)).toStrictEqual(
      expect.arrayContaining([
        "Unapproved or incomplete component decision: npm:server",
        "Unresolved reconciliation finding: missing-sbom:npm:server",
      ]),
    );
  });

  it("rejects decisions for unknown components or findings", () => {
    const { evidence, decisions } = evidenceWithDecisions();
    const withUnknown = {
      ...decisions,
      components: { ...decisions.components, "npm:other": decisions.components["npm:server"] },
      findings: {
        ...decisions.findings,
        "extra-sbom:other": decisions.findings["missing-sbom:npm:server"],
      },
    };

    expect(validateDecisions(evidence, withUnknown)).toStrictEqual(
      expect.arrayContaining([
        "Unknown component decision: npm:other",
        "Unknown finding decision: extra-sbom:other",
      ]),
    );
  });

  it("rejects stale evidence and runtime packages outside the production boundary even after review", () => {
    const { evidence, decisions } = evidenceWithDecisions();
    const changedEvidence = {
      ...evidence,
      boundary: { developmentOnly: ["npm:dev"], unexpected: ["npm:unknown"] },
    };

    expect(validateDecisions(changedEvidence, decisions)).toStrictEqual(
      expect.arrayContaining([
        "Review decisions are not bound to this evidence file",
        "Runtime image contains development-only npm packages",
        "Runtime image contains npm packages outside the production lockfile closure",
      ]),
    );
  });
});
