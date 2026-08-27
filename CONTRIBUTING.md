# Contributing to Stellara

Thank you for improving Stellara. Contributions are accepted through GitHub pull requests and are licensed under the repository's MIT License.

## Before you start

- Use Node.js 24 or newer.
- Use the pnpm version declared in `package.json` through Corepack.
- Search the issue tracker and existing pull requests before starting overlapping work.
- Report suspected vulnerabilities through GitHub Private Vulnerability Reporting, not through an issue or pull request.

For a substantial feature or behavior change, open a focused issue first so that the scope and compatibility impact can be discussed.

## Set up the repository

```bash
corepack enable
pnpm install
```

Create a branch in your fork or in the repository if you have write access. Keep each pull request focused on one change.

## Quality gate

Run the complete hermetic quality gate before submitting a pull request:

```bash
pnpm agent:check
```

Fix failures instead of bypassing or omitting checks. GitHub runs the same command on a GitHub-hosted runner without secrets.

The live provider suite is optional and local-only:

```bash
pnpm test:integration
```

It calls real upstream services, may consume quota, and performs temporary writes in the configured Qdrant collection. Supply credentials through normal environment variables and use isolated test resources. Never commit credentials or local environment files.

## Pull requests

- Write code, identifiers, tests, commit messages, and pull request titles in English.
- Use a Conventional Commit pull request title such as `feat: add ...` or `fix: handle ...`.
- Add or update tests for behavior changes.
- Update the owning documentation when a public contract changes.
- Keep generated files and lockfile changes scoped to the contribution.
- Confirm that the pull request contains no credentials, private URLs, personal data, or internal infrastructure details.

Stellara uses squash merges and a merge queue. The pull request title becomes the commit message on `main`. Formal approval is not required, but only repository owners can merge. Required checks and unresolved review threads still block a merge.

## AI-assisted contributions

You remain responsible for every submitted change, including generated code or documentation. Review the complete diff, verify licenses and provenance, and run the same checks as for manually written work.
