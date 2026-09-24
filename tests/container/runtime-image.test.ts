import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RUN_ID = `${process.pid}-${randomUUID().replaceAll("-", "")}`.toLowerCase();
const IMAGE = `stellara-runtime-test-${RUN_ID}:latest`;
const SERVER_CONTAINER = `stellara-runtime-server-${RUN_ID}`;
const DATA_VOLUME = `stellara-runtime-data-${RUN_ID}`;
const packageJson: unknown = JSON.parse(
  await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8"),
);
if (!isRecord(packageJson) || typeof packageJson.version !== "string") {
  throw new Error("package.json version must be a string");
}
const APP_VERSION = packageJson.version;
const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const DOCKER_TIMEOUT_MS = 30_000;
const BUILD_TIMEOUT_MS = 900_000;
const HEALTH_DEADLINE_MS = 30_000;
const HEALTH_RETRY_MS = 250;
const DOCKER_ENV_KEYS = [
  "PATH",
  "HOME",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_API_VERSION",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
] as const;

function dockerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of DOCKER_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

type CommandResult = {
  stderr: string;
  stdout: string;
};

class DockerCommandError extends Error {
  public readonly args: readonly string[];
  public readonly stdout: string;
  public readonly stderr: string;

  public constructor(input: {
    args: readonly string[];
    cause: unknown;
    stderr: string;
    stdout: string;
  }) {
    super(
      `docker ${input.args.join(" ")} failed: ${input.stderr.trim() || "no diagnostic output"}`,
      { cause: input.cause },
    );
    this.args = input.args;
    this.stdout = input.stdout;
    this.stderr = input.stderr;
  }
}

async function runDocker(
  args: readonly string[],
  timeout = DOCKER_TIMEOUT_MS,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      [...args],
      {
        cwd: options.cwd ?? REPOSITORY_ROOT,
        encoding: "utf8",
        env: options.env,
        killSignal: "SIGKILL",
        maxBuffer: 10 * 1024 * 1024,
        timeout,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new DockerCommandError({ args, cause: error, stderr, stdout }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function isConfirmedNotFound(error: unknown, resource: "container" | "image" | "volume"): boolean {
  if (!(error instanceof DockerCommandError)) return false;
  const diagnostic = `${error.stdout}\n${error.stderr}`;
  const patterns = {
    container: /No such container:/u,
    image: /No such image:/u,
    volume: /no such volume/u,
  } as const;
  return patterns[resource].test(diagnostic);
}

async function removeResource(
  resource: "container" | "image" | "volume",
  args: readonly string[],
): Promise<void> {
  try {
    await runDocker(args);
  } catch (error) {
    if (!isConfirmedNotFound(error, resource)) throw error;
  }
}

async function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type ImageConfig = {
  Cmd: unknown;
  Entrypoint: unknown;
  Env: unknown;
  User: unknown;
  Volumes: unknown;
};

function parseImageConfig(serialized: string): ImageConfig {
  const parsed: unknown = JSON.parse(serialized);
  if (!isRecord(parsed)) throw new Error("Docker image Config is not an object");
  return {
    Cmd: parsed.Cmd,
    Entrypoint: parsed.Entrypoint,
    Env: parsed.Env,
    User: parsed.User,
    Volumes: parsed.Volumes,
  };
}

function parseComposeImage(serialized: string): unknown {
  const config: unknown = JSON.parse(serialized);
  if (!isRecord(config) || !isRecord(config.services) || !isRecord(config.services.stellara)) {
    throw new Error("Compose config was missing the stellara service");
  }
  return config.services.stellara.image;
}

function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  return new Error("A Docker operation failed without an Error object");
}

const dependencyProbe = String.raw`
import { createRequire } from "node:module";
const require = createRequire("/app/package.json");
for (const name of ["fastify", "better-sqlite3", "playwright-extra"]) {
  require.resolve(name);
}
for (const name of ["typescript", "vitest", "eslint"]) {
  try {
    require.resolve(name);
    throw new Error(name + " unexpectedly resolves from the runtime image");
  } catch (error) {
    if (error instanceof Error && error.message.includes("unexpectedly resolves")) throw error;
    if (!(error && typeof error === "object" && "code" in error && error.code === "MODULE_NOT_FOUND")) {
      throw error;
    }
  }
}
console.log("runtime dependency boundary verified");
`;

const finalFilesystemProbe = String.raw`
import { existsSync, readdirSync } from "node:fs";
const forbidden = [".git", "stellara-data", "tests", "docs", ".github"];
for (const name of forbidden) {
  if (existsSync("/app/" + name)) throw new Error("Unexpected /app/" + name);
}
const environmentFiles = readdirSync("/app").filter((name) => name.startsWith(".env"));
if (environmentFiles.length > 0) throw new Error("Unexpected /app/.env* entries");
console.log("final image repository boundary verified");
`;

const sqliteProbe = String.raw`
import Database from "better-sqlite3";
const database = new Database("/data/container-probe.db");
try {
  database.exec("CREATE TABLE values_probe (value TEXT NOT NULL)");
  database.prepare("INSERT INTO values_probe (value) VALUES (?)").run("round-trip-ok");
  const row = database.prepare("SELECT value FROM values_probe").get();
  if (row?.value !== "round-trip-ok") throw new Error("SQLite round trip returned the wrong value");
} finally {
  database.close();
}
console.log("SQLite round trip verified");
`;

const playwrightProbe = String.raw`
import { once } from "node:events";
import { createServer } from "node:http";
import { PlaywrightClient } from "/app/dist/services/playwright.js";

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>Stellara container fixture</title><main>browser-content-ok</main>");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (address === null || typeof address === "string") throw new Error("Loopback fixture did not bind");

const client = new PlaywrightClient({
  playwright: { maxSessions: 2, maxSessionsPerUser: 1, stealth: true },
});
const userId = "container-fixture";
const signal = new AbortController().signal;
let session;
let failure;
try {
  session = await client.startSession({
    userId,
    url: "http://127.0.0.1:" + address.port + "/fixture",
    signal,
  });
  if (session.title !== "Stellara container fixture") {
    throw new Error("Unexpected fixture title: " + session.title);
  }
  const content = await client.content({
    userId,
    sessionId: session.sessionId,
    format: "text",
    signal,
  });
  if (!content.content.includes("browser-content-ok")) {
    throw new Error("Fixture content was not observed through PlaywrightClient");
  }
} catch (error) {
  failure = error;
}

const cleanupErrors = [];
if (session !== undefined) {
  try {
    await client.stopSession({ userId, sessionId: session.sessionId });
  } catch (error) {
    cleanupErrors.push(error);
  }
}
try {
  await client.close();
} catch (error) {
  cleanupErrors.push(error);
}
try {
  await new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
} catch (error) {
  cleanupErrors.push(error);
}
if (failure !== undefined) throw failure;
if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Playwright probe cleanup failed");
console.log("PlaywrightClient session verified");
`;

const healthProbe = `
const response = await fetch("http://127.0.0.1:8787/health");
const body = await response.json();
if (response.status !== 200) throw new Error(\`Unexpected health status: \${response.status}\`);
if (body.status !== "ok") throw new Error(\`Unexpected health status field: \${body.status}\`);
if (body.service !== "stellara") throw new Error(\`Unexpected health service: \${body.service}\`);
if (body.version !== ${JSON.stringify(APP_VERSION)}) {
  throw new Error(\`Unexpected APP_VERSION: \${body.version}\`);
}
console.log(JSON.stringify(body));
`;

async function waitForHealthyServer(): Promise<CommandResult> {
  let lastFailure: Error | undefined;
  const deadline = Date.now() + HEALTH_DEADLINE_MS;
  while (Date.now() < deadline) {
    try {
      return await runDocker(
        ["exec", SERVER_CONTAINER, "node", "--input-type=module", "--eval", healthProbe],
        5000,
      );
    } catch (error) {
      lastFailure = asError(error);
      await delay(HEALTH_RETRY_MS);
    }
  }
  throw lastFailure ?? new Error("Health verification deadline expired before the first probe");
}

async function createServerFailure(error: unknown): Promise<Error> {
  let logs = "Container logs were unavailable.";
  try {
    const result = await runDocker(["container", "logs", SERVER_CONTAINER]);
    logs = [result.stdout, result.stderr].filter((stream) => stream.length > 0).join("\n");
  } catch (logError) {
    if (!isConfirmedNotFound(logError, "container")) {
      logs += `\nLog capture also failed: ${asError(logError).message}`;
    }
  }
  return new Error(`Default server startup or health verification failed.\n${logs}`, {
    cause: asError(error),
  });
}

describe("runtime Docker image", () => {
  let imageMutationAttempted = false;
  let volumeMutationAttempted = false;
  let serverMutationAttempted = false;

  // Register teardown before the first Docker mutation so every handled path
  // owns deterministic cleanup, including failures in the image build hook.
  afterAll(async () => {
    const failures: unknown[] = [];
    if (serverMutationAttempted) {
      try {
        await removeResource("container", [
          "container",
          "rm",
          "--force",
          "--volumes",
          SERVER_CONTAINER,
        ]);
      } catch (error) {
        failures.push(error);
      }
    }
    if (volumeMutationAttempted) {
      try {
        await removeResource("volume", ["volume", "rm", "--force", DATA_VOLUME]);
      } catch (error) {
        failures.push(error);
      }
    }
    if (imageMutationAttempted) {
      try {
        await removeResource("image", ["image", "rm", "--force", IMAGE]);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Docker cleanup failed");
    }
  });

  beforeAll(async () => {
    try {
      await runDocker(["version", "--format", "{{.Server.Version}}"], 15_000);
    } catch (error) {
      throw new Error(
        "Docker is required for pnpm test:container, but the Docker CLI or daemon is unavailable.",
        { cause: error },
      );
    }

    imageMutationAttempted = true;
    await runDocker(
      [
        "build",
        "--file",
        "docker/Dockerfile",
        "--tag",
        IMAGE,
        "--build-arg",
        `APP_VERSION=${APP_VERSION}`,
        ".",
      ],
      BUILD_TIMEOUT_MS,
    );
  });

  it("contains production dependencies without development tooling", async () => {
    const result = await runDocker([
      "run",
      "--rm",
      "--network",
      "none",
      "--workdir",
      "/app",
      IMAGE,
      "node",
      "--input-type=module",
      "--eval",
      dependencyProbe,
    ]);
    expect(result.stdout).toContain("runtime dependency boundary verified");
  });

  it("excludes repository-only paths from the final filesystem", async () => {
    const result = await runDocker([
      "run",
      "--rm",
      "--network",
      "none",
      IMAGE,
      "node",
      "--input-type=module",
      "--eval",
      finalFilesystemProbe,
    ]);
    expect(result.stdout).toContain("final image repository boundary verified");
  });

  it("preserves the exact runtime metadata and non-root identity", async () => {
    const inspection = await runDocker(["image", "inspect", IMAGE, "--format", "{{json .Config}}"]);
    const config = parseImageConfig(inspection.stdout);
    expect(config.User).toBe("app");
    expect(config.Entrypoint).toStrictEqual(["/usr/bin/tini", "--"]);
    expect(config.Cmd).toStrictEqual(["node", "dist/server.js"]);
    expect(config.Volumes).toStrictEqual({ "/data": {} });
    expect(config.Env).toContain("NODE_ENV=production");
    expect(config.Env).toContain(`APP_VERSION=${APP_VERSION}`);

    const identity = await runDocker([
      "run",
      "--rm",
      "--network",
      "none",
      IMAGE,
      "node",
      "--eval",
      'console.log(String(process.getuid?.()) + ":" + String(process.getgid?.()))',
    ]);
    expect(identity.stdout.trim()).toBe("999:999");
  });

  it("selects the locally built image through the Compose image override", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "stellara-compose-image-"));
    try {
      await cp(join(REPOSITORY_ROOT, "docker-compose.yml"), join(fixture, "docker-compose.yml"));
      await writeFile(join(fixture, ".env"), "");
      await mkdir(join(fixture, "stellara-data"));
      const result = await runDocker(
        [
          "compose",
          "--file",
          "docker-compose.yml",
          "--project-directory",
          fixture,
          "--env-file",
          "/dev/null",
          "config",
          "--no-env-resolution",
          "--format",
          "json",
        ],
        DOCKER_TIMEOUT_MS,
        {
          cwd: fixture,
          env: {
            ...dockerEnvironment(),
            STELLARA_PROXY_NETWORK: "ci-proxy",
            STELLARA_IMAGE: IMAGE,
          },
        },
      );
      expect(parseComposeImage(result.stdout)).toBe(IMAGE);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("supports a better-sqlite3 round trip on the data volume", async () => {
    volumeMutationAttempted = true;
    await runDocker(["volume", "create", "--name", DATA_VOLUME]);
    const result = await runDocker([
      "run",
      "--rm",
      "--network",
      "none",
      "--volume",
      `${DATA_VOLUME}:/data`,
      "--workdir",
      "/app",
      IMAGE,
      "node",
      "--input-type=module",
      "--eval",
      sqliteProbe,
    ]);
    expect(result.stdout).toContain("SQLite round trip verified");
  });

  it("opens a loopback fixture through the production PlaywrightClient", async () => {
    const result = await runDocker(
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--workdir",
        "/app",
        IMAGE,
        "node",
        "--input-type=module",
        "--eval",
        playwrightProbe,
      ],
      120_000,
    );
    expect(result.stdout).toContain("PlaywrightClient session verified");
  });

  it("starts the default server and persists its database", async () => {
    serverMutationAttempted = true;
    try {
      await runDocker([
        "run",
        "--detach",
        "--name",
        SERVER_CONTAINER,
        "--network",
        "none",
        "--env",
        "PUBLIC_BASE_URL=https://stellara.example.test",
        "--env",
        "FIRECRAWL_BASE_URL=https://firecrawl.example.test",
        "--env",
        "FIRECRAWL_API_KEY=container-fixture",
        "--env",
        `STELLARA_TOKEN_CONTAINER=${TOKEN}`,
        "--volume",
        `${DATA_VOLUME}:/data`,
        IMAGE,
      ]);

      const health = await waitForHealthyServer();
      expect(JSON.parse(health.stdout)).toMatchObject({
        status: "ok",
        service: "stellara",
        version: APP_VERSION,
      });

      await runDocker([
        "exec",
        SERVER_CONTAINER,
        "node",
        "--input-type=module",
        "--eval",
        'import { access } from "node:fs/promises"; await access("/data/stellara.db");',
      ]);
    } catch (error) {
      throw await createServerFailure(error);
    }
  });
});
