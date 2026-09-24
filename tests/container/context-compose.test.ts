import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DOCKER_TIMEOUT_MS = 60_000;
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

async function runDocker(
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        env: options.env,
        killSignal: "SIGKILL",
        maxBuffer: 10 * 1024 * 1024,
        timeout: options.timeout ?? DOCKER_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`docker ${args.join(" ")} failed: ${stderr.trim()}`, { cause: error }));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function writeFixtureFile(root: string, path: string): Promise<void> {
  const destination = join(root, path);
  await mkdir(join(destination, ".."), { recursive: true });
  await writeFile(destination, "synthetic fixture\n");
}

type ComposeConfig = {
  networks: Record<string, { external?: boolean; name?: string }>;
  services: {
    stellara: {
      env_file?: Array<{ path: string } | string>;
      expose?: string[];
      healthcheck?: { test?: string[] };
      image?: string;
      networks?: Record<string, unknown>;
      ports?: unknown[];
      volumes?: Array<{ source?: string; target?: string; type?: string }>;
    };
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isComposeConfig(value: unknown): value is ComposeConfig {
  return (
    isRecord(value) &&
    isRecord(value.networks) &&
    isRecord(value.services) &&
    isRecord(value.services.stellara)
  );
}

async function loadComposeConfig(
  fixture: string,
  environment: NodeJS.ProcessEnv,
): Promise<ComposeConfig> {
  const output = await runDocker(
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
    { cwd: fixture, env: environment },
  );
  const parsed: unknown = JSON.parse(output);
  if (!isComposeConfig(parsed)) {
    throw new Error("Compose config was missing networks or the stellara service");
  }
  return parsed;
}

describe("container build context and Compose contract", () => {
  it("excludes synthetic private paths while retaining runtime build inputs", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "stellara-context-"));
    try {
      const context = join(fixture, "context");
      const output = join(fixture, "output");
      await mkdir(context);
      await mkdir(output);
      await cp(join(REPOSITORY_ROOT, ".dockerignore"), join(context, ".dockerignore"));
      await writeFile(join(context, "Dockerfile"), "FROM scratch\nCOPY . /context\n");

      for (const path of [
        ".env.ci-canary",
        "stellara-data/ci-canary",
        ".git/ci-canary",
        "tests/ci-canary",
        "docs/ci-canary",
        ".github/ci-canary",
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "src/ci-canary",
        "LICENSE",
      ]) {
        await writeFixtureFile(context, path);
      }

      await runDocker(
        ["build", "--file", "Dockerfile", "--output", `type=local,dest=${output}`, "."],
        { cwd: context, timeout: 120_000 },
      );

      for (const path of [
        ".env.ci-canary",
        "stellara-data/ci-canary",
        ".git/ci-canary",
        "tests/ci-canary",
        "docs/ci-canary",
        ".github/ci-canary",
      ]) {
        await expect(access(join(output, "context", path))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      for (const path of [
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "src/ci-canary",
        "LICENSE",
      ]) {
        await expect(access(join(output, "context", path))).resolves.toBeUndefined();
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("renders the pinned image and deployment contract without checkout secrets", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "stellara-compose-"));
    try {
      await cp(join(REPOSITORY_ROOT, "docker-compose.yml"), join(fixture, "docker-compose.yml"));
      await writeFile(join(fixture, ".env"), "");
      await mkdir(join(fixture, "stellara-data"));

      const environment: NodeJS.ProcessEnv = {
        ...dockerEnvironment(),
        STELLARA_PROXY_NETWORK: "ci-proxy",
      };
      const defaultConfig = await loadComposeConfig(fixture, environment);
      const service = defaultConfig.services.stellara;
      expect(service.image).toBe("ghcr.io/sebastian-software/stellara:0.1.15");
      expect(defaultConfig.networks.internal).toMatchObject({ external: true });
      expect(defaultConfig.networks.proxy).toMatchObject({ external: true, name: "ci-proxy" });
      expect(service.networks).toHaveProperty("internal");
      expect(service.networks).toHaveProperty("proxy");
      expect(service.env_file).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: join(fixture, ".env"),
          }),
        ]),
      );
      expect(service.volumes).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "bind",
            source: join(fixture, "stellara-data"),
            target: "/data",
          }),
        ]),
      );
      expect(service.expose).toContain("8787");
      expect(service).not.toHaveProperty("ports");
      expect(service.healthcheck?.test?.join(" ")).toContain("/health");

      const missingProxyEnvironment = { ...environment };
      delete missingProxyEnvironment.STELLARA_PROXY_NETWORK;
      await expect(loadComposeConfig(fixture, missingProxyEnvironment)).rejects.toThrow(
        /STELLARA_PROXY_NETWORK/u,
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
