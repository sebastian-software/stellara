import { createHash } from "node:crypto";

const REVIEW_HEADER = /^<!-- license-audit-review:v1:([a-f0-9]{64}) -->$/u;
const REVIEW_ITEM = /^<!-- license-audit:(component|finding):([\w-]+) -->$/u;
const COMPONENT_FIELDS = [
  "Decision",
  "Reviewer",
  "Terms",
  "Evidence",
  "Notice action",
  "Notice location",
];
const FINDING_FIELDS = ["Decision", "Reviewer", "Resolution", "Evidence"];

function evidenceHash(evidence) {
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

function itemMarker(kind, id) {
  return `<!-- license-audit:${kind}:${Buffer.from(id).toString("base64url")} -->`;
}

function markdownValue(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("`", "\\`").replaceAll("\n", " ");
}

function observedComponent(component, sbom) {
  const lines = [
    `- Art: ${markdownValue(component.kind)}`,
    `- Version: ${markdownValue(component.version ?? "not recorded")}`,
    `- Pfad im Image: \`${markdownValue(component.location)}\``,
  ];
  if (component.declaredLicense) {
    lines.push(
      `- Lizenzangabe im Paketmanifest (ungeprüft): \`${markdownValue(component.declaredLicense)}\``,
    );
  }
  for (const [label, file] of [
    ["Copyright-Datei", component.copyright],
    ["Paketmanifest", component.manifest],
    ["Anwendungslizenz", component.license],
  ]) {
    if (file?.path) lines.push(`- ${label} im Image: \`${markdownValue(file.path)}\``);
  }
  for (const notice of component.notices ?? []) {
    lines.push(`- Lizenz-/Hinweisdatei im Image: \`${markdownValue(notice.path)}\``);
  }
  const packages = sbom.packages.filter(
    (item) => item.name === component.name && item.versionInfo === component.version,
  );
  if (packages.length > 0) {
    const declarations = [
      ...new Set(packages.map((item) => item.licenseDeclared ?? "not recorded")),
    ];
    lines.push(`- SPDX-Lizenzangabe (ungeprüft): ${markdownValue(declarations.join(", "))}`);
  }
  return lines.join("\n");
}

function observedFinding(finding) {
  const details = Object.entries(finding)
    .filter(([key]) => !["id", "type"].includes(key))
    .map(
      ([key, value]) =>
        `- ${key}: \`${markdownValue(Array.isArray(value) ? value.join(", ") : value)}\``,
    );
  return [`- Art: ${markdownValue(finding.type)}`, ...details].join("\n");
}

export function renderReviewMarkdown(evidence, sbom) {
  const lines = [
    "# Prüfbogen: Container-Lizenzen",
    "",
    `<!-- license-audit-review:v1:${evidenceHash(evidence)} -->`,
    "",
    `Kandidat: \`${markdownValue(evidence.image.reference)}\` auf \`${markdownValue(evidence.platform)}\`.`,
    `Quell-Commit: \`${evidence.sourceCommit}\`.`,
    `Umfang: ${evidence.inventory.components.length} Komponenten und ${evidence.findings.length} Abgleichbefunde.`,
    "",
    "Dieser Bogen dokumentiert die menschliche Prüfung. Lizenzangaben aus Manifesten und SPDX sind Hinweise, keine Freigabe. HTML-Markierungen und Feldnamen unverändert lassen. Für jeden Eintrag genau einen Prüfblock ausfüllen. Pro geprüfter Quelle oder Datei im Image eine eigene `Evidence:`-Zeile verwenden; bei Bedarf weitere Zeilen hinzufügen. Jede Antwort muss in einer Zeile stehen. `pending` bedeutet »offen«. Anschließend mit `pnpm license:audit review-import` in JSON umwandeln und mit `verify` prüfen. Der Import erteilt niemals selbst eine Freigabe.",
    "",
    "**Wo »Lizenz ist in Ordnung« eintragen?** Im Block der jeweiligen Komponente `Decision: pending` zu `Decision: approved` ändern – erst nach Prüfung der konkreten Bedingungen und Pflichten. Dazu `Reviewer` (prüfende Person), `Terms` (festgestellte Lizenzbedingungen), mindestens eine `Evidence`-Quelle und `Notice action` ausfüllen (`included`, `linked`, `source-offer` oder `not-required`). Außer bei `not-required` ist auch `Notice location` nötig. Für einen Abgleichbefund `Decision: resolved` setzen und `Reviewer`, `Resolution` sowie mindestens eine `Evidence`-Quelle eintragen.",
    "",
    "## Komponenten",
    "",
  ];
  for (const [index, component] of evidence.inventory.components.entries()) {
    lines.push(
      `### ${index + 1}. ${markdownValue(component.name)} (${markdownValue(component.id)})`,
      "",
      observedComponent(component, sbom),
      "",
      itemMarker("component", component.id),
      "```license-review",
      "Decision: pending",
      "Reviewer:",
      "Terms:",
      "Evidence:",
      "Notice action: pending",
      "Notice location:",
      "```",
      "",
    );
  }
  lines.push("## Abgleichbefunde", "");
  for (const [index, finding] of evidence.findings.entries()) {
    lines.push(
      `### ${index + 1}. ${markdownValue(finding.id)}`,
      "",
      observedFinding(finding),
      "",
      itemMarker("finding", finding.id),
      "```license-review",
      "Decision: pending",
      "Reviewer:",
      "Resolution:",
      "Evidence:",
      "```",
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

function parseFieldLine(line, expected, state) {
  const colon = line.indexOf(":");
  if (colon < 1 || (line[colon + 1] && line[colon + 1] !== " ")) {
    throw new Error(`Invalid review field for ${state.id}: ${line}`);
  }
  const name = line.slice(0, colon);
  const index = expected.indexOf(name);
  if (
    index === -1 ||
    index < state.lastIndex ||
    (index === state.lastIndex && name !== "Evidence")
  ) {
    throw new Error(`Unexpected or out-of-order review field for ${state.id}: ${name}`);
  }
  return { index, name, value: line.slice(colon + 1).trim() };
}

function collectFields(lines, expected, id) {
  const values = new Map();
  let lastIndex = -1;
  for (const line of lines) {
    const field = parseFieldLine(line, expected, { lastIndex, id });
    lastIndex = field.index;
    const value =
      field.name === "Evidence" ? [...(values.get("Evidence") ?? []), field.value] : field.value;
    values.set(field.name, value);
  }
  if (expected.some((field) => !values.has(field)))
    throw new Error(`Missing review field for ${id}`);
  return values;
}

function checkedDecision(values, allowed, id) {
  const decision = values.get("Decision");
  if (!allowed.includes(decision)) throw new Error(`Invalid decision for ${id}: ${decision}`);
  return decision === "pending" ? null : decision;
}

function findingDecision(values, id) {
  return {
    decision: checkedDecision(values, ["pending", "resolved"], id),
    reviewer: values.get("Reviewer") || null,
    resolution: values.get("Resolution") || null,
    evidence: values.get("Evidence").filter(Boolean),
  };
}

function componentDecision(values, id) {
  const action = values.get("Notice action");
  if (!["pending", "included", "linked", "source-offer", "not-required"].includes(action)) {
    throw new Error(`Invalid notice action for ${id}: ${action}`);
  }
  return {
    decision: checkedDecision(values, ["pending", "approved"], id),
    reviewer: values.get("Reviewer") || null,
    terms: values.get("Terms") || null,
    evidence: values.get("Evidence").filter(Boolean),
    noticeDisposition: {
      action: action === "pending" ? null : action,
      location: values.get("Notice location") || null,
    },
  };
}

function parseFields(lines, kind, id) {
  const expected = kind === "component" ? COMPONENT_FIELDS : FINDING_FIELDS;
  const values = collectFields(lines, expected, id);
  return kind === "component" ? componentDecision(values, id) : findingDecision(values, id);
}

function checkHeader(lines, evidence) {
  const headers = lines.filter((line) => REVIEW_HEADER.test(line));
  if (headers.length !== 1 || REVIEW_HEADER.exec(headers[0])[1] !== evidenceHash(evidence)) {
    throw new Error("Review worksheet is not bound to this evidence file");
  }
}

function parseReviewItem(lines, index, context) {
  const match = REVIEW_ITEM.exec(lines[index]);
  if (!match) return index;
  const [, kind, encoded] = match;
  const id = Buffer.from(encoded, "base64url").toString("utf8");
  const target = kind === "component" ? context.decisions.components : context.decisions.findings;
  if (!context.expected[kind].has(id)) throw new Error(`Unknown ${kind} review item: ${id}`);
  if (Object.hasOwn(target, id)) throw new Error(`Duplicate ${kind} review item: ${id}`);
  if (lines[index + 1] !== "```license-review") throw new Error(`Missing review block for ${id}`);
  const end = lines.indexOf("```", index + 2);
  if (end === -1 || lines.slice(index + 2, end).some((line) => REVIEW_ITEM.test(line))) {
    throw new Error(`Unclosed review block for ${id}`);
  }
  target[id] = parseFields(lines.slice(index + 2, end), kind, id);
  return end;
}

function checkCoverage(expected, decisions) {
  for (const [kind, ids] of Object.entries(expected)) {
    const target = kind === "component" ? decisions.components : decisions.findings;
    for (const id of ids) {
      if (!Object.hasOwn(target, id)) throw new Error(`Missing ${kind} review item: ${id}`);
    }
  }
}

export function parseReviewMarkdown(markdown, evidence) {
  const lines = markdown.split(/\r?\n/u);
  checkHeader(lines, evidence);
  const expected = {
    component: new Set(evidence.inventory.components.map((item) => item.id)),
    finding: new Set(evidence.findings.map((item) => item.id)),
  };
  const decisions = {
    evidenceSha256: evidenceHash(evidence),
    components: /** @type {Record<string, ReturnType<typeof parseFields>>} */ ({}),
    findings: /** @type {Record<string, ReturnType<typeof parseFields>>} */ ({}),
  };
  for (let index = 0; index < lines.length; index += 1) {
    index = parseReviewItem(lines, index, { expected, decisions });
  }
  checkCoverage(expected, decisions);
  return decisions;
}
