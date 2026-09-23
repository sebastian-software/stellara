import { createHash } from "node:crypto";

const HEADER = /^<!-- license-audit-review:v2:([a-f0-9]{64}):([a-f0-9]{64}) -->$/u;
const ITEM = /^<!-- license-audit:(component|finding|component-group|finding-group):([\w-]+) -->$/u;
const COMPONENT_FIELDS = [
  "Decision",
  "Reviewer",
  "Terms",
  "Evidence",
  "Notice action",
  "Notice location",
];
const FINDING_FIELDS = ["Decision", "Reviewer", "Resolution", "Evidence"];
const COMPONENT_GROUP_FIELDS = [
  "Decision",
  "Reviewer",
  "Review method",
  "Obligations",
  "Evidence",
  "Delivery",
];

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function reviewScopeHash(scope) {
  return hash(JSON.stringify(scope));
}

function evidenceHash(evidence) {
  return hash(JSON.stringify(evidence));
}

export function createReviewScope(evidence, manifestText, baseDpkgText) {
  const manifest = JSON.parse(manifestText);
  const directDependencyNames = Object.keys(manifest.dependencies ?? {}).sort();
  if (directDependencyNames.length === 0) throw new Error("Source manifest has no dependencies");
  const baseDebianIds = baseDpkgText
    .trim()
    .split("\n")
    .map((line) => {
      const [name, version, architecture] = line.split("\t");
      if (!name || !version || !architecture) throw new Error(`Invalid base dpkg entry: ${line}`);
      return `deb:${name}@${version}:${architecture}`;
    })
    .sort();
  if (baseDebianIds.length === 0 || new Set(baseDebianIds).size !== baseDebianIds.length) {
    throw new Error("Base Debian inventory is empty or duplicated");
  }
  return {
    schemaVersion: 1,
    evidenceSha256: evidenceHash(evidence),
    sourceCommit: evidence.sourceCommit,
    sourceManifestSha256: hash(manifestText),
    baseReference: evidence.base.reference,
    directDependencyNames,
    baseDebianIds,
  };
}

function validBasePackageIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return false;
  if (!ids.every((id) => typeof id === "string" && id.startsWith("deb:"))) return false;
  return JSON.stringify(ids) === JSON.stringify([...new Set(ids)].sort());
}

export function reviewScopeErrors(evidence, scope, manifestText) {
  const actual = scope || {};
  const expected = JSON.parse(manifestText);
  const direct = Object.keys(expected.dependencies ?? {}).sort();
  const imageManifest = evidence.inventory.components.find(
    (item) => item.kind === "application" && item.manifest?.path === "/app/package.json",
  );
  const checks = [
    [actual.schemaVersion === 1, "Unsupported review scope version"],
    [
      actual.evidenceSha256 === evidenceHash(evidence),
      "Review scope is not bound to this evidence",
    ],
    [actual.sourceCommit === evidence.sourceCommit, "Review scope source commit differs"],
    [actual.sourceManifestSha256 === hash(manifestText), "Review scope source manifest differs"],
    [
      !imageManifest || imageManifest.manifest.sha256 === hash(manifestText),
      "Source manifest differs from the application manifest in the image",
    ],
    [actual.baseReference === evidence.base.reference, "Review scope base image differs"],
    [
      JSON.stringify(actual.directDependencyNames) === JSON.stringify(direct),
      "Review scope direct dependencies differ",
    ],
    [validBasePackageIds(actual.baseDebianIds), "Review scope base package IDs are invalid"],
  ];
  return checks.filter(([valid]) => !valid).map(([, message]) => message);
}

function groupedIds(evidence, scope) {
  const direct = new Set(scope.directDependencyNames);
  const baseDebian = new Set(scope.baseDebianIds);
  const components = evidence.inventory.components;
  const componentKind = new Map(components.map((item) => [item.id, item.kind]));
  const selectComponents = (predicate) =>
    components
      .filter((item) => predicate(item))
      .map((item) => item.id)
      .sort();
  const selectFindings = (type, kind) =>
    evidence.findings
      .filter((item) => item.type === type && componentKind.get(item.componentId) === kind)
      .map((item) => item.id)
      .sort();
  return {
    components: {
      "base-debian": selectComponents((item) => item.kind === "debian" && baseDebian.has(item.id)),
      "runtime-debian": selectComponents(
        (item) => item.kind === "debian" && !baseDebian.has(item.id),
      ),
      "node-base": selectComponents((item) => ["base-npm", "node"].includes(item.kind)),
      "npm-transitive": selectComponents((item) => item.kind === "npm" && !direct.has(item.name)),
    },
    findings: {
      "imprecise-base-npm": selectFindings("imprecise-sbom", "base-npm"),
      "duplicate-base-npm": selectFindings("duplicate-sbom", "base-npm"),
      "duplicate-runtime-npm": selectFindings("duplicate-sbom", "npm"),
    },
  };
}

export function reviewGroups(evidence, scope) {
  const groups = groupedIds(evidence, scope);
  const components = Object.fromEntries(
    Object.entries(groups.components).filter(([, ids]) => ids.length > 0),
  );
  const findings = Object.fromEntries(
    Object.entries(groups.findings).filter(([, ids]) => ids.length > 0),
  );
  const groupedComponents = new Set(Object.values(components).flat());
  const groupedFindings = new Set(Object.values(findings).flat());
  return {
    components,
    findings,
    individualComponents: evidence.inventory.components.filter(
      (item) => !groupedComponents.has(item.id),
    ),
    individualFindings: evidence.findings.filter((item) => !groupedFindings.has(item.id)),
  };
}

function marker(kind, id) {
  return `<!-- license-audit:${kind}:${Buffer.from(id).toString("base64url")} -->`;
}

function clean(value) {
  return String(value ?? "not recorded")
    .replaceAll("`", "\\`")
    .replaceAll("\n", " ");
}

function componentNotes(component, sbom) {
  const spdx = sbom.packages.filter(
    (item) => item.name === component.name && item.versionInfo === component.version,
  );
  const licenses = [...new Set(spdx.map((item) => item.licenseDeclared ?? "NOASSERTION"))];
  return [
    `- Typ/Version: ${clean(component.kind)} / ${clean(component.version)}`,
    `- Pfad: \`${clean(component.location)}\``,
    `- Paketmanifest: \`${clean(component.declaredLicense)}\` (ungeprüft)`,
    `- SPDX-Angabe: \`${clean(licenses.join(", ") || "NOASSERTION")}\` (ungeprüft)`,
    ...[component.copyright, component.license, ...(component.notices ?? [])]
      .filter(Boolean)
      .map((file) => `- Lizenz-/Hinweisdatei: \`${clean(file.path)}\``),
  ];
}

function individualBlock(kind, item, sbom) {
  const fields =
    kind === "component"
      ? [
          "Decision: pending",
          "Reviewer:",
          "Terms:",
          "Evidence:",
          "Notice action: pending",
          "Notice location:",
        ]
      : ["Decision: pending", "Reviewer:", "Resolution:", "Evidence:"];
  const details =
    kind === "component"
      ? componentNotes(item, sbom)
      : [
          `- Typ: ${clean(item.type)}`,
          `- Bezug: \`${clean(item.componentId ?? item.spdxId ?? item.packageIdentity)}\``,
        ];
  return [
    `### ${clean(item.name ?? item.id)} (${clean(item.id)})`,
    "",
    ...details,
    "",
    marker(kind, item.id),
    "```license-review",
    ...fields,
    "```",
    "",
  ];
}

function componentLicense(item, sbom) {
  const spdx = sbom.packages.find(
    (entry) => entry.name === item.name && entry.versionInfo === item.version,
  );
  return item.declaredLicense ?? spdx?.licenseDeclared ?? "NOASSERTION";
}

function componentSource(item) {
  return item.copyright?.path ?? item.manifest?.path ?? item.binary?.path ?? item.location;
}

function groupInventoryLine(member, context) {
  if (context.kind === "finding-group") return `- \`${clean(member)}\``;
  const item = context.lookup.get(member);
  const license = componentLicense(item, context.sbom);
  const source = componentSource(item);
  return `- \`${clean(member)}\` – Lizenzhinweis \`${clean(license)}\`, Quelle \`${clean(source)}\``;
}

function groupBlock(kind, id, context) {
  const { members } = context;
  const explanation =
    kind === "component-group"
      ? "`covered` bedeutet: Umfang, Lizenzquellen und Pflichten wurden für genau diese Gruppe qualifiziert geprüft und dokumentiert – nicht, dass alle Pakete dieselbe Lizenz haben."
      : "`resolved` bedeutet: Die angegebene Auflösung und ihre Belege gelten für jeden unten aufgeführten Befund.";
  const fields =
    kind === "component-group"
      ? [
          "Decision: pending",
          "Reviewer:",
          "Review method:",
          "Obligations:",
          "Evidence:",
          "Delivery:",
        ]
      : ["Decision: pending", "Reviewer:", "Resolution:", "Evidence:"];
  const inventory = members.map((member) => groupInventoryLine(member, { ...context, kind }));
  return [
    `### ${id} (${members.length} Einträge)`,
    "",
    `Eine Entscheidung gilt genau für die unten aufgelisteten IDs. ${explanation}`,
    "",
    marker(kind, id),
    "```license-review",
    ...fields,
    "```",
    "",
    `<details><summary>Vollständige Mitgliederliste (${members.length})</summary>`,
    "",
    ...inventory,
    "",
    "</details>",
    "",
  ];
}

export function renderScopedReviewMarkdown(evidence, sbom, scope) {
  const groups = reviewGroups(evidence, scope);
  const components = new Map(evidence.inventory.components.map((item) => [item.id, item]));
  const findings = new Map(evidence.findings.map((item) => [item.id, item]));
  const lines = [
    "# Prüfbogen: Container-Lizenzen (fokussiert)",
    "",
    `<!-- license-audit-review:v2:${evidenceHash(evidence)}:${reviewScopeHash(scope)} -->`,
    "",
    `Kandidat: \`${clean(evidence.image.reference)}\` auf \`${clean(evidence.platform)}\`.`,
    `Quell-Commit: \`${clean(evidence.sourceCommit)}\`.`,
    `Vollständiges Inventar: ${evidence.inventory.components.length} Komponenten, ${evidence.findings.length} Abgleichbefunde. Manuell zu bearbeiten: ${groups.individualComponents.length} Einzelkomponenten, ${Object.keys(groups.components).length} Komponentengruppen, ${groups.individualFindings.length} Einzelbefunde und ${Object.keys(groups.findings).length} Befundgruppen.`,
    "",
    "Alle Komponenten und Befunde bleiben im JSON-Nachweis erhalten. Die Gruppen ersetzen keine Prüfung: Nur eine ausdrücklich ausgefüllte Gruppenentscheidung mit Methode, Quellen, Pflichten und Auslieferungsnachweis kann die aufgeführten Mitglieder abdecken. Ungeprüfte Gruppen bleiben `pending` und blockieren `verify`. HTML-Markierungen und Feldnamen nicht ändern. Antworten auf jeweils eine Zeile schreiben; für weitere Quellen zusätzliche `Evidence:`-Zeilen einfügen.",
    "",
    "Direkte Stellara-Abhängigkeiten und Sonderfälle werden einzeln geprüft. Bei ihnen `Decision: pending` nur nach Prüfung zu `Decision: approved` ändern und die übrigen Felder ausfüllen. Für Sammelnachweise `Decision: covered` setzen. Für Abgleichbefunde `Decision: resolved` setzen und die gemeinsame oder individuelle Ursache belegen. Lizenzangaben aus Manifesten und SBOM sind Hinweise, keine Freigaben.",
    "",
    "## Einzelkomponenten",
    "",
    ...groups.individualComponents.flatMap((item) => individualBlock("component", item, sbom)),
    "## Komponentengruppen",
    "",
    ...Object.entries(groups.components).flatMap(([id, members]) =>
      groupBlock("component-group", id, { members, lookup: components, sbom }),
    ),
    "## Einzelne Abgleichbefunde",
    "",
    ...groups.individualFindings.flatMap((item) => individualBlock("finding", item, sbom)),
    "## Gebündelte Abgleichbefunde",
    "",
    ...Object.entries(groups.findings).flatMap(([id, members]) =>
      groupBlock("finding-group", id, { members, lookup: findings, sbom }),
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function fieldsFrom(lines, expected, id) {
  const values = new Map();
  let previous = -1;
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 1) throw new Error(`Invalid review field for ${id}: ${line}`);
    const name = line.slice(0, colon);
    const index = expected.indexOf(name);
    if (index === -1 || index < previous || (index === previous && name !== "Evidence")) {
      throw new Error(`Unexpected review field for ${id}: ${name}`);
    }
    previous = index;
    const value = line.slice(colon + 1).trim();
    values.set(name, name === "Evidence" ? [...(values.get(name) ?? []), value] : value);
  }
  if (expected.some((name) => !values.has(name))) throw new Error(`Missing review field for ${id}`);
  return values;
}

function commonDecision(values, kind, id) {
  const decision = values.get("Decision");
  const allowed =
    kind === "component" ? "approved" : kind === "component-group" ? "covered" : "resolved";
  if (!["pending", allowed].includes(decision))
    throw new Error(`Invalid decision for ${id}: ${decision}`);
  return {
    decision: decision === "pending" ? null : decision,
    reviewer: values.get("Reviewer") || null,
    evidence: values.get("Evidence").filter(Boolean),
  };
}

function individualComponentDecision(values, common, id) {
  const action = values.get("Notice action");
  if (!["pending", "included", "linked", "source-offer", "not-required"].includes(action)) {
    throw new Error(`Invalid notice action for ${id}: ${action}`);
  }
  return {
    ...common,
    terms: values.get("Terms") || null,
    noticeDisposition: {
      action: action === "pending" ? null : action,
      location: values.get("Notice location") || null,
    },
  };
}

function decisionFrom(lines, kind, id) {
  const expected = {
    component: COMPONENT_FIELDS,
    "component-group": COMPONENT_GROUP_FIELDS,
    finding: FINDING_FIELDS,
    "finding-group": FINDING_FIELDS,
  }[kind];
  const values = fieldsFrom(lines, expected, id);
  const common = commonDecision(values, kind, id);
  if (kind === "component") return individualComponentDecision(values, common, id);
  if (kind === "component-group") {
    return {
      ...common,
      method: values.get("Review method") || null,
      obligations: values.get("Obligations") || null,
      delivery: values.get("Delivery") || null,
    };
  }
  return { ...common, resolution: values.get("Resolution") || null };
}

function expectedItems(groups) {
  return {
    component: new Set(groups.individualComponents.map((item) => item.id)),
    finding: new Set(groups.individualFindings.map((item) => item.id)),
    "component-group": new Set(Object.keys(groups.components)),
    "finding-group": new Set(Object.keys(groups.findings)),
  };
}

function decisionTarget(decisions, kind) {
  if (kind === "component-group") return decisions.groups.components;
  if (kind === "finding-group") return decisions.groups.findings;
  return kind === "component" ? decisions.components : decisions.findings;
}

function memberIds(members, kind, id) {
  return kind === "component-group" ? members.components[id] : members.findings[id];
}

function displayedMemberId(line) {
  if (!line.startsWith("- `")) return null;
  const close = line.indexOf("`", 3);
  if (close === -1) return null;
  const suffix = line.slice(close + 1);
  return suffix === "" || suffix.startsWith(" – ") ? line.slice(3, close) : null;
}

function checkGroupMemberList(lines, end, { members, id }) {
  const opening = `<details><summary>Vollständige Mitgliederliste (${members.length})</summary>`;
  if (lines[end + 2] !== opening || lines[end + 3] !== "") {
    throw new Error(`Group member list is missing or changed for ${id}`);
  }
  const closing = lines.indexOf("</details>", end + 4);
  if (closing === -1) throw new Error(`Group member list is unclosed for ${id}`);
  const displayed = lines
    .slice(end + 4, closing)
    .filter(Boolean)
    .map((line) => displayedMemberId(line));
  if (JSON.stringify(displayed) !== JSON.stringify(members)) {
    throw new Error(`Group member list differs from evidence for ${id}`);
  }
}

function parseItem(lines, index, state) {
  const match = ITEM.exec(lines[index]);
  if (!match) return index;
  const [, kind, encoded] = match;
  const id = Buffer.from(encoded, "base64url").toString("utf8");
  const target = decisionTarget(state.decisions, kind);
  if (!state.expected[kind].has(id)) throw new Error(`Unknown ${kind}: ${id}`);
  if (Object.hasOwn(target, id)) throw new Error(`Duplicate ${kind}: ${id}`);
  if (lines[index + 1] !== "```license-review") throw new Error(`Missing review block for ${id}`);
  const end = lines.indexOf("```", index + 2);
  if (end === -1 || lines.slice(index + 2, end).some((line) => ITEM.test(line)))
    throw new Error(`Unclosed review block for ${id}`);
  const decision = decisionFrom(lines.slice(index + 2, end), kind, id);
  if (kind.endsWith("group")) {
    checkGroupMemberList(lines, end, { members: memberIds(state.members, kind, id), id });
  }
  target[id] = kind.endsWith("group")
    ? { ...decision, memberIds: memberIds(state.members, kind, id) }
    : decision;
  return end;
}

function checkScopedHeader(lines, evidence, scope) {
  const headers = lines.filter((line) => HEADER.test(line));
  const header = headers.length === 1 ? HEADER.exec(headers[0]) : null;
  if (!header || header[1] !== evidenceHash(evidence) || header[2] !== reviewScopeHash(scope)) {
    throw new Error("Review worksheet is not bound to this evidence and scope");
  }
}

function checkItems(expected, decisions) {
  for (const [kind, ids] of Object.entries(expected)) {
    const target = decisionTarget(decisions, kind);
    for (const id of ids) if (!Object.hasOwn(target, id)) throw new Error(`Missing ${kind}: ${id}`);
  }
}

export function parseScopedReviewMarkdown(markdown, evidence, scope) {
  const lines = markdown.split(/\r?\n/u);
  checkScopedHeader(lines, evidence, scope);
  const members = reviewGroups(evidence, scope);
  const expected = expectedItems(members);
  const decisions = {
    reviewSchemaVersion: 2,
    evidenceSha256: evidenceHash(evidence),
    scopeSha256: reviewScopeHash(scope),
    components: /** @type {Record<string, object>} */ ({}),
    findings: /** @type {Record<string, object>} */ ({}),
    groups: {
      components: /** @type {Record<string, object>} */ ({}),
      findings: /** @type {Record<string, object>} */ ({}),
    },
  };
  for (let index = 0; index < lines.length; index += 1)
    index = parseItem(lines, index, { expected, members, decisions });
  checkItems(expected, decisions);
  return decisions;
}
