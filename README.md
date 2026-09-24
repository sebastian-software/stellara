# Stellara

[![PR CI](https://github.com/sebastian-software/stellara/actions/workflows/pr-ci.yml/badge.svg)](https://github.com/sebastian-software/stellara/actions/workflows/pr-ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Stellara is a self-hosted AI tool gateway for Firecrawl, Exa, Qdrant, and an embeddings backend. It exposes one token-protected HTTP and Model Context Protocol (MCP) interface for LLM clients such as Claude Desktop and ChatGPT connectors.

The gateway centralizes upstream credentials, authentication, rate limits, response validation, and network safeguards. It also provides Playwright browser sessions, per-user vector memory, and domain availability checks.

## Capabilities

- **`web_*`** — search, scrape, crawl, extract, and make guarded HTTP or GraphQL requests.
- **`browser_*`** — run interactive Playwright sessions for navigation, forms, screenshots, PDFs, and JavaScript evaluation.
- **`memory_*`** — store and retrieve per-user context through embeddings and Qdrant.
- **`domain_availability`** — check domain registration through RDAP with a WHOIS fallback.
- **OAuth 2.1 and MCP** — connect token-based clients or OAuth-capable MCP clients through one gateway.

See the [tool reference](docs/user-guide/tools.md) for the complete catalog.

## Requirements

- Node.js 24 or newer
- pnpm 10.33.4 through Corepack
- Provider credentials for the features you enable
- Docker for the container deployment

## Local development

```bash
corepack enable
pnpm install
cp .env.example .env
```

Set a public base URL, at least one `STELLARA_TOKEN_<USERID>`, and the required Firecrawl values in `.env`. Optional Exa, Qdrant, and embeddings credentials enable their matching tool families.
See the [runtime configuration reference](docs/operations/configuration.md) for every key, its default, dependencies, and restart behavior.

Start the development server:

```bash
pnpm dev
```

The health endpoint is available at `http://localhost:8787/health` unless `PORT` is changed.

## Container deployment

To deploy on a new host, you need Docker Engine with the Compose plugin, a separately running Firecrawl service, a TLS reverse proxy, and a public HTTPS URL. Stellara uses two existing external Docker networks: `internal` to reach Firecrawl and the network named by `STELLARA_PROXY_NETWORK` shared with the proxy. Prepare `.env` with `FIRECRAWL_BASE_URL`, `FIRECRAWL_API_KEY`, `PUBLIC_BASE_URL`, `STELLARA_PROXY_NETWORK`, and at least one strong `STELLARA_TOKEN_<USERID>`; the persistent `stellara-data/` directory must belong to UID/GID 999.

Compose selects its image through `STELLARA_IMAGE`. Pin a release tag or digest for production: the current default, `ghcr.io/sebastian-software/stellara:0.1.15`, is available only for `linux/amd64` and predates the #11 token-snapshot changes. To run this checkout or use an ARM64 host, build from `docker/Dockerfile` and set `STELLARA_IMAGE=stellara:local`. The `latest` tag moves and does not identify a reproducible release.

Follow the [operations guide](docs/operations/betrieb.md) for network attachment, a secret-safe Compose preflight, first boot, health checks, and backup and restore before exposing the service.

## Development and tests

The required local quality gate is:

```bash
pnpm agent:check
```

This command runs type checking, linting, formatting verification, and the hermetic unit suite. Live provider tests are optional, local-only, and require credentials supplied through normal environment variables:

```bash
pnpm test:integration
```

GitHub Actions never receives or runs these integration credentials.

## Documentation

- [User guide](docs/user-guide/README.md)
- [Tool reference](docs/user-guide/tools.md)
- [Development guide](docs/developer-guide/entwicklung.md)
- [Tool API](docs/developer-guide/tool-api.md)
- [Test strategy](docs/developer-guide/tests.md)
- [Architecture](docs/developer-guide/stellara-konzept.md)
- [Operations](docs/operations/betrieb.md)
- [Runtime configuration](docs/operations/configuration.md)
- [Release process](docs/operations/release-prozess.md)

Some in-depth documentation is currently available in German. Translation work is tracked in the public issue tracker.

## Contributing and support

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Use GitHub Issues for reproducible bugs and focused feature proposals. See [SUPPORT.md](SUPPORT.md) for the project support policy.

Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not disclose vulnerabilities in public issues.

## License

Stellara is available under the [MIT License](LICENSE).
The project currently adopts no separate naming or trademark policy.
