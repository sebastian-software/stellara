import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseReviewMarkdown, renderReviewMarkdown } from "./license-audit-review.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUNTIME_PROBE = fileURLToPath(new URL("license-audit-runtime.mjs", import.meta.url));
const DIGEST_REFERENCE = /^[^\s@]+@sha256:[a-f0-9]{64}$/u;
const PLATFORM = /^linux\/(?:amd64|arm64|arm\/v\d+)$/u;

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: 900_000,
    ...options,
  }).trim();
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function identity(name, version) {
  return `${name}@${version}`.toLowerCase();
}

function splitSnapshotKey(key) {
  const withoutPeers = key.split("(", 1)[0];
  const separator = withoutPeers.lastIndexOf("@");
  if (separator < 1) fail(`Invalid lockfile snapshot key: ${key}`);
  return { name: withoutPeers.slice(0, separator), version: withoutPeers.slice(separator + 1) };
}

function yamlScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return JSON.parse(trimmed);
  return trimmed;
}

function parseImporterLine(state, line) {
  if (/^ {2}\.:\s*$/u.test(line)) {
    state.root = true;
    return;
  }
  if (/^ {2}\S/u.test(line)) state.root = false;
  if (!state.root) return;
  const category = /^ {4}(dependencies|devDependencies):\s*$/u.exec(line);
  if (category) {
    state.category = category[1];
    return;
  }
  if (/^ {4}\S/u.test(line)) state.category = "";
  const dependency =
    line.startsWith("      ") && !line.startsWith("       ") ? line.slice(6).trimEnd() : "";
  if (dependency.endsWith(":") && state.category) state.name = yamlScalar(dependency.slice(0, -1));
  recordImporterVersion(state, line);
}

function recordImporterVersion(state, line) {
  if (!line.startsWith("        version:") || !state.category || !state.name) return;
  state[state.category].set(state.name, yamlScalar(line.slice("        version:".length)));
}

function parseSnapshotLine(state, line) {
  const heading = line.startsWith("  ") && !line.startsWith("   ") ? line.slice(2).trimEnd() : "";
  if (heading.endsWith(":") || heading.endsWith(": {}")) {
    state.name = yamlScalar(heading.slice(0, heading.endsWith(": {}") ? -4 : -1));
    state.snapshots.set(state.name, []);
    state.category = "";
    return;
  }
  const category = /^ {4}(dependencies|optionalDependencies):\s*$/u.exec(line);
  if (category) {
    state.category = category[1];
    return;
  }
  if (/^ {4}\S/u.test(line)) state.category = "";
  recordSnapshotDependency(state, line);
}

function recordSnapshotDependency(state, line) {
  if (!line.startsWith("      ") || line.startsWith("       ") || !state.category || !state.name)
    return;
  const separator = line.indexOf(": ", 6);
  if (separator === -1) return;
  state.snapshots
    .get(state.name)
    .push([yamlScalar(line.slice(6, separator)), yamlScalar(line.slice(separator + 2))]);
}

function traverseClosure(roots, snapshots) {
  const visited = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const [name, version] = queue.pop();
    if (version.startsWith("link:") || version.startsWith("workspace:")) {
      fail(`Unsupported local dependency in lockfile: ${name}@${version}`);
    }
    const requested = `${name}@${version}`;
    const key = snapshots.has(requested) ? requested : version;
    if (visited.has(key)) continue;
    if (!snapshots.has(key)) fail(`Missing lockfile snapshot: ${key}`);
    visited.add(key);
    queue.push(...snapshots.get(key));
  }
  return sortedUnique(
    [...visited].map((key) => {
      const parsed = splitSnapshotKey(key);
      return identity(parsed.name, parsed.version);
    }),
  );
}

// Only the lockfile's importer and snapshot dependency shapes are read. Any
// unsupported shape fails closed rather than silently shrinking the closure.
export function parseProductionClosure(lockfile) {
  const importer = {
    root: false,
    category: "",
    name: "",
    dependencies: new Map(),
    devDependencies: new Map(),
  };
  const snapshotState = { name: "", category: "", snapshots: new Map() };
  let section = "";
  for (const line of lockfile.split(/\r?\n/u)) {
    if (["importers:", "snapshots:", "packages:"].includes(line)) section = line.slice(0, -1);
    else if (section === "importers") parseImporterLine(importer, line);
    else if (section === "snapshots") parseSnapshotLine(snapshotState, line);
  }
  if (snapshotState.snapshots.size === 0 || importer.dependencies.size === 0) {
    fail("Lockfile has no root production dependencies or snapshots");
  }
  return {
    production: traverseClosure(importer.dependencies, snapshotState.snapshots),
    development: traverseClosure(importer.devDependencies, snapshotState.snapshots),
  };
}

export function checkProductionBoundary(components, closure) {
  const production = new Set(closure.production);
  const development = new Set(closure.development);
  const observed = new Set();
  const unexpected = [];
  const developmentOnly = [];
  for (const component of components.filter((item) => item.kind === "npm")) {
    const key = identity(component.name, component.version);
    observed.add(key);
    if (production.has(key)) continue;
    if (development.has(key)) developmentOnly.push(component.id);
    else unexpected.push(component.id);
  }
  return {
    unexpected: sortedUnique(unexpected),
    developmentOnly: sortedUnique(developmentOnly),
    absentProduction: sortedUnique([...production].filter((key) => !observed.has(key))),
  };
}

function purlIdentity(ref) {
  if (ref.referenceType !== "purl" || typeof ref.referenceLocator !== "string") return null;
  const locator = ref.referenceLocator;
  const kind = locator.startsWith("pkg:npm/")
    ? "npm"
    : locator.startsWith("pkg:deb/")
      ? "debian"
      : null;
  if (!kind) return null;
  const packagePath = locator
    .slice(kind === "npm" ? "pkg:npm/".length : "pkg:deb/".length)
    .split("?", 1)[0];
  const separator = packagePath.lastIndexOf("@");
  if (separator < 1) return null;
  const name = decodeURIComponent(packagePath.slice(0, separator)).replace(/^debian\//u, "");
  return {
    kind,
    key: identity(name, decodeURIComponent(packagePath.slice(separator + 1))),
  };
}

function finding(type, key, details) {
  return { id: `${type}:${key}`, type, ...details };
}

function spdxEntries(spdx) {
  if (!Array.isArray(spdx?.packages)) fail("Attached SPDX document has no packages array");
  return spdx.packages.map((item, index) => {
    const refs = Array.isArray(item.externalRefs) ? item.externalRefs : [];
    const purls = refs.map((ref) => purlIdentity(ref)).filter(Boolean);
    return { index, spdxId: item.SPDXID, name: item.name, version: item.versionInfo, purls };
  });
}

function matchSpdx(component, entries) {
  const key = identity(component.name, component.version ?? "");
  const exact = entries.filter((item) =>
    item.purls.some((purl) => purl.kind === component.kind && purl.key === key),
  );
  const matches =
    exact.length > 0
      ? exact
      : entries.filter((item) => identity(item.name ?? "", item.version ?? "") === key);
  return { exact, matches };
}

function componentFinding(component, match) {
  const { exact, matches } = match;
  if (matches.length === 0)
    return finding("missing-sbom", component.id, { componentId: component.id });
  const spdxIds = matches.map((item) => item.spdxId);
  if (matches.length > 1)
    return finding("duplicate-sbom", component.id, { componentId: component.id, spdxIds });
  if (exact.length === 0 || !component.version || !matches[0].version) {
    return finding("imprecise-sbom", component.id, { componentId: component.id, spdxIds });
  }
  return null;
}

function duplicateRuntimeFindings(components) {
  const counts = new Map();
  for (const component of components) {
    const key = `${component.kind}:${identity(component.name, component.version ?? "")}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([key, count]) => finding("duplicate-runtime", key, { count }));
}

export function reconcileInventory(components, spdx) {
  const entries = spdxEntries(spdx);
  const matched = new Set();
  const findings = duplicateRuntimeFindings(components);
  for (const component of components) {
    const match = matchSpdx(component, entries);
    for (const item of match.matches) matched.add(item.index);
    const result = componentFinding(component, match);
    if (result) findings.push(result);
  }
  for (const item of entries.filter((entry) => !matched.has(entry.index))) {
    findings.push(
      finding("extra-sbom", `${item.index}`, {
        spdxId: item.spdxId,
        name: item.name,
        version: item.version,
      }),
    );
  }
  return findings.sort((a, b) => a.id.localeCompare(b.id));
}

function validEvidence(sources) {
  return (
    Array.isArray(sources) &&
    sources.length > 0 &&
    sources.every((source) => typeof source === "string" && source.trim())
  );
}

function validDisposition(disposition) {
  const action = disposition?.action;
  if (!["included", "linked", "source-offer", "not-required"].includes(action)) return false;
  return action === "not-required" || Boolean(disposition.location);
}

function validComponentDecision(decision) {
  if (!decision || decision.decision !== "approved" || !decision.reviewer) return false;
  if (typeof decision.terms !== "string" || !decision.terms.trim()) return false;
  if (/^(?:unknown|none|noassertion|tbd)$/iu.test(decision.terms.trim())) return false;
  return validEvidence(decision.evidence) && validDisposition(decision.noticeDisposition);
}

function validFindingDecision(decision) {
  return Boolean(
    decision?.decision === "resolved" &&
    decision.reviewer &&
    decision.resolution &&
    validEvidence(decision.evidence),
  );
}

function evidenceBindingErrors(evidence, decisions) {
  return decisions.evidenceSha256 === sha256(JSON.stringify(evidence))
    ? []
    : ["Review decisions are not bound to this evidence file"];
}

function boundaryErrors(boundary) {
  const errors = [];
  if (boundary?.developmentOnly?.length) {
    errors.push("Runtime image contains development-only npm packages");
  }
  if (boundary?.unexpected?.length) {
    errors.push("Runtime image contains npm packages outside the production lockfile closure");
  }
  return errors;
}

function requiredDecisionErrors({ expected, decisions, valid, message }) {
  return [...expected].filter((id) => !valid(decisions[id])).map((id) => `${message}: ${id}`);
}

export function validateDecisions(evidence, decisions) {
  const expectedComponents = new Set(evidence.inventory.components.map((item) => item.id));
  const expectedFindings = new Set(evidence.findings.map((item) => item.id));
  const componentDecisions = decisions.components ?? {};
  const findingDecisions = decisions.findings ?? {};
  return [
    ...evidenceBindingErrors(evidence, decisions),
    ...boundaryErrors(evidence.boundary),
    ...requiredDecisionErrors({
      expected: expectedComponents,
      decisions: componentDecisions,
      valid: validComponentDecision,
      message: "Unapproved or incomplete component decision",
    }),
    ...requiredDecisionErrors({
      expected: expectedFindings,
      decisions: findingDecisions,
      valid: validFindingDecision,
      message: "Unresolved reconciliation finding",
    }),
    ...unknownDecisionErrors(componentDecisions, expectedComponents, "component"),
    ...unknownDecisionErrors(findingDecisions, expectedFindings, "finding"),
  ];
}

function unknownDecisionErrors(decisions, expected, kind) {
  return Object.keys(decisions)
    .filter((id) => !expected.has(id))
    .map((id) => `Unknown ${kind} decision: ${id}`);
}

function optionsFrom(argv, allowed) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.includes(flag) || !value || value.startsWith("--") || options[flag]) {
      fail(`Invalid or duplicate option: ${flag ?? "<missing>"}`);
    }
    options[flag] = value;
  }
  for (const flag of allowed) if (!options[flag]) fail(`Missing required option: ${flag}`);
  return options;
}

function imageDetails(reference, platform) {
  const details = JSON.parse(
    run("docker", ["buildx", "imagetools", "inspect", reference, "--format", "{{json .}}"]),
  );
  const manifest = details.manifest;
  if (!manifest || typeof manifest.digest !== "string")
    fail(`Cannot inspect manifest: ${reference}`);
  const requestedDigest = reference.slice(reference.lastIndexOf("@") + 1);
  if (manifest.digest !== requestedDigest) fail(`Registry digest mismatch: ${reference}`);
  const selected = Array.isArray(manifest.manifests)
    ? manifest.manifests.filter((item) => {
        const selectedPlatform = `${item.platform?.os}/${item.platform?.architecture}${item.platform?.variant ? `/${item.platform.variant}` : ""}`;
        return (
          selectedPlatform === platform &&
          item.annotations?.["vnd.docker.reference.type"] !== "attestation-manifest"
        );
      })
    : [{ digest: manifest.digest }];
  if (selected.length !== 1)
    fail(`Expected one ${platform} manifest for ${reference}; found ${selected.length}`);
  return { details, manifestDigest: selected[0].digest };
}

export function readAttachedSpdx(details, platform, sbom) {
  const manifests = details.manifest?.manifests;
  if (!Array.isArray(manifests)) {
    fail("Attached SBOM extraction requires an image index with a bound attestation");
  }
  const imageManifests = manifests.filter(
    (item) => item.annotations?.["vnd.docker.reference.type"] !== "attestation-manifest",
  );
  const selected = imageManifests.filter(
    (item) =>
      `${item.platform?.os}/${item.platform?.architecture}${item.platform?.variant ? `/${item.platform.variant}` : ""}` ===
      platform,
  );
  if (selected.length !== 1) fail(`Expected one ${platform} image manifest for attached SBOM`);
  const attestations = manifests.filter(
    (item) =>
      item.annotations?.["vnd.docker.reference.type"] === "attestation-manifest" &&
      item.annotations?.["vnd.docker.reference.digest"] === selected[0].digest,
  );
  if (attestations.length !== 1) {
    fail(`Expected one SBOM attestation manifest bound to ${platform} image digest`);
  }
  const spdx = sbom?.SPDX;
  if (!spdx || !Array.isArray(spdx.packages)) {
    fail(`No attached SPDX SBOM for the exact ${platform} image digest`);
  }
  return spdx;
}

function localImage(reference, platform) {
  run("docker", ["pull", "--platform", platform, reference]);
  const result = JSON.parse(
    run("docker", [
      "image",
      "inspect",
      "--platform",
      platform,
      reference,
      "--format",
      "{{json .}}",
    ]),
  );
  const digest = reference.slice(reference.lastIndexOf("@"));
  if (!result.RepoDigests?.some((item) => item.endsWith(digest))) {
    fail(`Pulled image does not retain digest ${reference}`);
  }
  const actualPlatform = `${result.Os}/${result.Architecture}${result.Variant ? `/${result.Variant}` : ""}`;
  if (actualPlatform !== platform)
    fail(`Pulled image platform ${actualPlatform} differs from ${platform}`);
  return result;
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function readEvidence(directory) {
  const evidencePath = path.resolve(directory);
  const evidence = JSON.parse(fs.readFileSync(path.join(evidencePath, "evidence.json"), "utf8"));
  const spdx = JSON.parse(fs.readFileSync(path.join(evidencePath, "sbom.spdx.json"), "utf8"));
  if (sha256(JSON.stringify(spdx)) !== evidence.sbomSha256)
    fail("SBOM differs from the captured evidence");
  return { evidence, spdx };
}

function captureOptions(argv) {
  const options = optionsFrom(argv, ["--image", "--base", "--platform", "--output"]);
  if (!DIGEST_REFERENCE.test(options["--image"]) || !DIGEST_REFERENCE.test(options["--base"])) {
    fail("Image and base must be immutable name@sha256:<64 hex> references");
  }
  if (!PLATFORM.test(options["--platform"]))
    fail("Platform must be an explicit linux/architecture[/variant]");
  if (run("git", ["status", "--porcelain", "--untracked-files=all"])) {
    fail("Capture requires a clean checkout; commit the exact source before auditing");
  }
  const output = path.resolve(options["--output"]);
  if (fs.existsSync(output)) fail(`Output path already exists: ${output}`);
  return { options, output };
}

function validateImageLineage({ imageLocal, baseLocal, sourceCommit, baseReference }) {
  const imageLayers = imageLocal.RootFS.Layers;
  const baseLayers = baseLocal.RootFS.Layers;
  if (!baseLayers.length || !baseLayers.every((layer, index) => layer === imageLayers[index])) {
    fail("Runtime image does not begin with the declared immutable base image layers");
  }
  const labels = imageLocal.Config?.Labels ?? {};
  const hasRevision = labels["org.opencontainers.image.revision"] === sourceCommit;
  const hasBase = labels["org.opencontainers.image.base.name"] === baseReference;
  if (!hasRevision || !hasBase) {
    fail("Runtime image source/base labels differ from the audit inputs");
  }
}

function inspectCaptureImages(options, sourceCommit) {
  const image = imageDetails(options["--image"], options["--platform"]);
  const base = imageDetails(options["--base"], options["--platform"]);
  const imageManifests = image.details.manifest.manifests.filter(
    (item) => item.annotations?.["vnd.docker.reference.type"] !== "attestation-manifest",
  );
  const sbomTemplate =
    imageManifests.length === 1
      ? "{{json .SBOM}}"
      : `{{json (index .SBOM "${options["--platform"]}")}}`;
  const attached = JSON.parse(
    run("docker", [
      "buildx",
      "imagetools",
      "inspect",
      options["--image"],
      "--format",
      sbomTemplate,
    ]),
  );
  const spdx = readAttachedSpdx(image.details, options["--platform"], attached);
  const imageLocal = localImage(options["--image"], options["--platform"]);
  const baseLocal = localImage(options["--base"], options["--platform"]);
  validateImageLineage({ imageLocal, baseLocal, sourceCommit, baseReference: options["--base"] });
  return { image, base, spdx };
}

function runtimeInventory(options) {
  const runtimeSource = fs.readFileSync(RUNTIME_PROBE, "utf8");
  return JSON.parse(
    run("docker", [
      "run",
      "--rm",
      "--read-only",
      "--network",
      "none",
      "--platform",
      options["--platform"],
      "--user",
      "0",
      "--entrypoint",
      "node",
      options["--image"],
      "--input-type=module",
      "--eval",
      runtimeSource,
    ]),
  );
}

function collectFindings(inventory, spdx, boundary) {
  const findings = reconcileInventory(inventory.components, spdx);
  for (const id of boundary.developmentOnly) {
    findings.push(finding("development-only-runtime", id, { componentId: id }));
  }
  for (const id of boundary.unexpected) {
    findings.push(finding("unexpected-runtime-npm", id, { componentId: id }));
  }
  for (const packageIdentity of boundary.absentProduction) {
    findings.push(finding("lockfile-absent-runtime", packageIdentity, { packageIdentity }));
  }
  return findings.sort((a, b) => a.id.localeCompare(b.id));
}

function reviewTemplate(evidence) {
  return {
    evidenceSha256: sha256(JSON.stringify(evidence)),
    components: Object.fromEntries(
      evidence.inventory.components.map((item) => [
        item.id,
        {
          decision: null,
          reviewer: null,
          terms: null,
          evidence: [],
          noticeDisposition: { action: null, location: null },
        },
      ]),
    ),
    findings: Object.fromEntries(
      evidence.findings.map((item) => [
        item.id,
        {
          decision: null,
          reviewer: null,
          resolution: null,
          evidence: [],
        },
      ]),
    ),
  };
}

function capture(argv) {
  const { options, output } = captureOptions(argv);
  const sourceCommit = run("git", ["rev-parse", "HEAD"]);
  const lockfile = fs.readFileSync(path.join(ROOT, "pnpm-lock.yaml"));
  const { image, base, spdx } = inspectCaptureImages(options, sourceCommit);
  const inventory = runtimeInventory(options);
  const boundary = checkProductionBoundary(
    inventory.components,
    parseProductionClosure(lockfile.toString("utf8")),
  );
  const findings = collectFindings(inventory, spdx, boundary);
  const evidence = {
    schemaVersion: 1,
    sourceCommit,
    lockfileSha256: sha256(lockfile),
    platform: options["--platform"],
    image: { reference: options["--image"], manifestDigest: image.manifestDigest },
    base: { reference: options["--base"], manifestDigest: base.manifestDigest },
    inventory,
    boundary,
    findings,
    sbomSha256: sha256(JSON.stringify(spdx)),
  };
  fs.mkdirSync(output);
  writeJson(path.join(output, "evidence.json"), evidence);
  writeJson(path.join(output, "sbom.spdx.json"), spdx);
  writeJson(path.join(output, "decisions.template.json"), reviewTemplate(evidence));
  process.stdout.write(
    `Captured ${inventory.components.length} components and ${findings.length} unresolved findings in ${output}\n`,
  );
}

function verify(argv) {
  const options = optionsFrom(argv, ["--evidence", "--decisions"]);
  const { evidence } = readEvidence(options["--evidence"]);
  const decisions = JSON.parse(fs.readFileSync(path.resolve(options["--decisions"]), "utf8"));
  const errors = validateDecisions(evidence, decisions);
  if (errors.length > 0) fail(errors.join("\n"));
  process.stdout.write(`Review complete for ${evidence.image.reference} (${evidence.platform})\n`);
}

function reviewInit(argv) {
  const options = optionsFrom(argv, ["--evidence", "--output"]);
  const { evidence, spdx } = readEvidence(options["--evidence"]);
  const output = path.resolve(options["--output"]);
  fs.writeFileSync(output, renderReviewMarkdown(evidence, spdx), { flag: "wx" });
  process.stdout.write(`Wrote review worksheet: ${output}\n`);
}

function reviewImport(argv) {
  const options = optionsFrom(argv, ["--evidence", "--review", "--output"]);
  const { evidence } = readEvidence(options["--evidence"]);
  const markdown = fs.readFileSync(path.resolve(options["--review"]), "utf8");
  const decisions = parseReviewMarkdown(markdown, evidence);
  const output = path.resolve(options["--output"]);
  writeJson(output, decisions);
  process.stdout.write(`Imported review decisions: ${output}\n`);
}

function help() {
  process.stdout.write(`Usage:
  pnpm license:audit capture --image NAME@sha256:DIGEST --base NAME@sha256:DIGEST --platform linux/amd64 --output DIRECTORY
  pnpm license:audit review-init --evidence DIRECTORY --output FILE.md
  pnpm license:audit review-import --evidence DIRECTORY --review FILE.md --output FILE.json
  pnpm license:audit verify --evidence DIRECTORY --decisions FILE

Capture requires a clean checkout and an immutable registry image (a disposable
local registry is suitable). It verifies source/base labels and base layers,
extracts the attached SPDX SBOM for the same digest/platform, and writes new
evidence.json, sbom.spdx.json, and decisions.template.json files. The template
contains no legal approvals. Review-init creates a fillable Markdown worksheet;
review-import converts it into decisions.json without approving pending items.
Both refuse to overwrite their output. Verify checks the completed decisions against the
bound evidence; missing terms, dispositions, reviewers, or reconciliations exit
nonzero. None of these commands signs off a release on its own.
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const command = process.argv[2];
    const args = process.argv.slice(3);
    if (command === "capture") capture(args);
    else if (command === "review-init") reviewInit(args);
    else if (command === "review-import") reviewImport(args);
    else if (command === "verify") verify(args);
    else if (command === "--help" || command === "help" || command === undefined) help();
    else fail(`Unknown command: ${command}`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
