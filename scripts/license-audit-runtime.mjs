import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function filesUnder(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const item = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(item);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(item);
    }
  }
  return files.sort();
}

function fileEvidence(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(file);
    return {
      path: file,
      symlink: target,
      sha256: createHash("sha256").update(target).digest("hex"),
    };
  }
  return {
    path: file,
    bytes: stat.size,
    sha256: sha256(file),
    executable: (stat.mode & 0o111) !== 0,
  };
}

function noticeFiles(root) {
  return filesUnder(root)
    .filter((file) =>
      /(?:^|\/)(?:license|licence|copying|notice|copyright|third.party)(?:[._/-]|$)/iu.test(file),
    )
    .map((file) => fileEvidence(file));
}

function debianPackages() {
  const dollar = String.fromCodePoint(36);
  const format = `-f=${dollar}{binary:Package}\t${dollar}{Version}\t${dollar}{Architecture}\n`;
  const result = spawnSync("dpkg-query", ["-W", format], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`dpkg-query failed: ${result.stderr}`);
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [binaryName, version, architecture] = line.split("\t");
      const name = binaryName.replace(/:[^:]+$/u, "");
      if (!name || !version || !architecture) throw new Error(`Malformed dpkg entry: ${line}`);
      const documentPath = `/usr/share/doc/${name}/copyright`;
      return {
        id: `deb:${binaryName}@${version}:${architecture}`,
        kind: "debian",
        name,
        binaryName,
        version,
        architecture,
        location: documentPath,
        copyright: fs.existsSync(documentPath) ? fileEvidence(documentPath) : null,
      };
    });
}

function npmPackageRoots(moduleRoot) {
  return fs
    .readdirSync(moduleRoot)
    .flatMap((name) => {
      const nameRoot = path.join(moduleRoot, name);
      return name.startsWith("@")
        ? fs.readdirSync(nameRoot).map((scoped) => path.join(nameRoot, scoped))
        : [nameRoot];
    })
    .filter((root) => fs.lstatSync(root).isDirectory());
}

function readNpmPackage(packageRoot, storeEntry) {
  const manifestPath = path.join(packageRoot, "package.json");
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new TypeError(`Incomplete npm identity: ${manifestPath}`);
  }
  return {
    id: `npm:${manifest.name}@${manifest.version}:${storeEntry}`,
    kind: "npm",
    name: manifest.name,
    version: manifest.version,
    location: packageRoot,
    realPath: fs.realpathSync(packageRoot),
    declaredLicense: manifest.license ?? null,
    manifest: fileEvidence(manifestPath),
    notices: noticeFiles(packageRoot),
  };
}

function npmPackages() {
  const store = "/app/node_modules/.pnpm";
  if (!fs.existsSync(store))
    throw new Error("Production pnpm store is absent from the runtime image");
  return fs
    .readdirSync(store, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const moduleRoot = path.join(store, entry.name, "node_modules");
      return fs.existsSync(moduleRoot)
        ? npmPackageRoots(moduleRoot)
            .map((root) => readNpmPackage(root, entry.name))
            .filter(Boolean)
        : [];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function baseNpmPackages() {
  return filesUnder("/usr/local/lib/node_modules")
    .filter((file) => path.basename(file) === "package.json")
    .map((file) => {
      const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!manifest.name || !manifest.version) return null;
      return {
        id: `base-npm:${manifest.name}@${manifest.version}:${file}`,
        kind: "base-npm",
        name: manifest.name,
        version: manifest.version,
        location: path.dirname(file),
        declaredLicense: manifest.license ?? null,
        manifest: fileEvidence(file),
      };
    })
    .filter(Boolean);
}

function unownedRuntimeFiles() {
  const owned = new Set(
    filesUnder("/var/lib/dpkg/info")
      .filter((file) => file.endsWith(".list"))
      .flatMap((file) => fs.readFileSync(file, "utf8").split("\n")),
  );
  const roots = ["/etc", "/opt", "/usr", "/var"];
  return [...new Set(roots.flatMap((root) => filesUnder(root)))]
    .filter((file) => !file.startsWith("/usr/local/") && !owned.has(file))
    .map((file) => fileEvidence(file));
}

function browserComponents() {
  const root = "/ms-playwright";
  if (!fs.existsSync(root)) throw new Error("Playwright browser directory is absent");
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const location = path.join(root, entry.name);
      const files = filesUnder(location);
      const inventoryDigest = createHash("sha256");
      for (const file of files) {
        inventoryDigest.update(`${path.relative(location, file)}\0${sha256(file)}\n`);
      }
      return {
        id: `browser:${entry.name}`,
        kind: "browser",
        name: entry.name,
        version: entry.name.match(/-(\d+)$/u)?.[1] ?? null,
        location,
        fileCount: files.length,
        fileInventorySha256: inventoryDigest.digest("hex"),
        notices: noticeFiles(location),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

const appFiles = filesUnder("/app/dist").map((file) => fileEvidence(file));
const browserFiles = filesUnder("/ms-playwright").map((file) => fileEvidence(file));
const fontFiles = filesUnder("/usr/share/fonts").map((file) => fileEvidence(file));
const baseFiles = filesUnder("/usr/local").map((file) => fileEvidence(file));
const unownedFiles = unownedRuntimeFiles();
const nativeBinaries = filesUnder("/app/node_modules")
  .filter(
    (file) =>
      [".node", ".so", ".dylib", ".dll"].some((extension) => file.endsWith(extension)) ||
      file.includes(".so."),
  )
  .map((file) => fileEvidence(file));
const nodeBinary = fileEvidence(process.execPath);
const ownLicense = fileEvidence("/app/LICENSE");
const packageManifest = fileEvidence("/app/package.json");

process.stdout.write(
  JSON.stringify({
    node: { version: process.version, binary: nodeBinary },
    components: [
      ...debianPackages(),
      ...npmPackages(),
      ...baseNpmPackages(),
      ...browserComponents(),
      {
        id: `node:${process.version}`,
        kind: "node",
        name: "node",
        version: process.version,
        location: process.execPath,
        binary: nodeBinary,
      },
      {
        id: "base:unowned-files",
        kind: "base-assets",
        name: "unowned base files",
        version: process.version,
        location: "/",
        fileCount: unownedFiles.length,
      },
      {
        id: "app:stellara",
        kind: "application",
        name: "stellara",
        version: JSON.parse(fs.readFileSync("/app/package.json", "utf8")).version,
        location: "/app",
        manifest: packageManifest,
        license: ownLicense,
      },
    ],
    files: {
      app: appFiles,
      browser: browserFiles,
      fonts: fontFiles,
      base: baseFiles,
      unowned: unownedFiles,
      nativeBinaries,
    },
  }),
);
