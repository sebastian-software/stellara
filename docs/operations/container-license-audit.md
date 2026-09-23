# Container license audit

This procedure is for the release maintainer and the qualified license reviewer. It captures the contents of one immutable image digest on one platform, reconciles the attached SPDX SBOM with the observed runtime, and records review decisions. The audit command supplies evidence and enforces completeness; it does not determine license obligations or approve a release.

The initial candidate must come from a clean checkout containing the production-only container introduced by #17 (at or after commit `7ee61b4`). Final sign-off also requires a separate audit of the exact published digest of a release containing #17. The earlier `v0.1.15` release cannot satisfy that requirement.

## Capture a clean-checkout candidate

Use Node.js 24 or later, the repository's pnpm version, Docker with Buildx, and `jq`. Docker must be able to reach an ephemeral registry on local port 5000. The example uses `linux/amd64`; repeat the procedure for every platform being reviewed. Keep the evidence directory outside the checkout because `capture` rejects modified or untracked repository files and refuses to overwrite an output directory.

From the repository root, with no output from `git status --porcelain --untracked-files=all`:

```sh
set -eu
test -z "$(git status --porcelain --untracked-files=all)"

platform=linux/amd64
source_commit=$(git rev-parse HEAD)
app_version=$(node -p "require('./package.json').version")
base_tag=node:24-bookworm-slim
base_digest=$(docker buildx imagetools inspect "$base_tag" --format '{{json .}}' | jq -er '.manifest.digest')
base_ref="$base_tag@$base_digest"
audit_root=$(mktemp -d)

docker run -d --name stellara-audit-registry -p 127.0.0.1:5000:5000 registry:2
docker buildx create --name stellara-audit-builder --driver docker-container --driver-opt network=host --bootstrap
docker buildx build \
  --builder stellara-audit-builder \
  --platform "$platform" \
  --file docker/Dockerfile \
  --build-arg "NODE_BASE_IMAGE=$base_ref" \
  --build-arg "SOURCE_COMMIT=$source_commit" \
  --build-arg "APP_VERSION=$app_version" \
  --sbom=true --provenance=false \
  --output type=registry,registry.insecure=true \
  --tag localhost:5000/stellara:audit .

candidate_digest=$(docker buildx imagetools inspect localhost:5000/stellara:audit --format '{{json .}}' | jq -er '.manifest.digest')
candidate_ref="localhost:5000/stellara@$candidate_digest"
pnpm license:audit -- capture \
  --image "$candidate_ref" \
  --base "$base_ref" \
  --platform "$platform" \
  --output "$audit_root/candidate"
printf 'Candidate evidence: %s\n' "$audit_root/candidate"
```

The local registry preserves the SBOM attestation while Buildx pushes the candidate. Buildx's container driver and host networking let the builder reach `localhost:5000`; the registry must be reserved for this audit. Docker documents [SBOM attestations](https://docs.docker.com/build/metadata/attestations/sbom/) and the [local-registry pattern](https://docs.docker.com/build/ci/github-actions/local-registry/).

`capture` pulls both immutable references for the selected platform. It checks the candidate's source and base labels against the checkout and requested base, checks that the runtime layers begin with the base layers, and requires an attached SPDX SBOM for that digest and platform. It then writes three new files in `$audit_root/candidate/`:

| File | Purpose |
| --- | --- |
| `evidence.json` | Source commit, lockfile hash, image and base references and platform manifests, runtime component and file inventory, production-dependency boundary, and reconciliation findings. |
| `sbom.spdx.json` | The attached SPDX document extracted from that image digest and platform. |
| `decisions.template.json` | Blank component and finding decisions bound to the evidence hash; this is not an approval. |

The runtime inventory includes installed Debian packages and their copyright-file evidence, production pnpm packages and notices, base Node packages and files, Node itself, Playwright browser files and notices, fonts, native binaries, and copied application assets. A missing copyright file, notice, version, or precise SBOM identity is an evidence gap for the reviewer. The attached SBOM alone does not establish the applicable terms.

After capture, remove only the disposable builder and registry created above:

```sh
docker buildx rm stellara-audit-builder
docker rm -f stellara-audit-registry
```

## Review and verify decisions

Keep `evidence.json` and `sbom.spdx.json` with the review record. A qualified reviewer checks primary license and notice sources for every component, including Debian's installed copyright files, Node and base-image material, Chromium's bundled third-party material, fonts, native modules, and other copied assets. Reconcile every missing, extra, duplicate, or imprecise SBOM item and every production-boundary finding. Record a named, versioned upstream inventory and evidence link where a bundled component needs one. Do not infer a component's terms from its parent package or treat absent slim-image documentation as proof that no obligation exists.

Copy the template to a separate decision file and have the reviewer complete it:

```sh
cp "$audit_root/candidate/decisions.template.json" "$audit_root/candidate/decisions.json"
# Edit decisions.json using the reviewed primary evidence.
pnpm license:audit -- verify \
  --evidence "$audit_root/candidate" \
  --decisions "$audit_root/candidate/decisions.json"
```

Each component needs `decision: "approved"`, a reviewer, specific `terms`, evidence links or references, and a `noticeDisposition` action (`included`, `linked`, `source-offer`, or `not-required`). The first three actions also need a location. Each reconciliation finding needs `decision: "resolved"`, a reviewer, resolution, and evidence. `verify` exits nonzero for incomplete or unknown decisions, unresolved findings, a changed SBOM, decisions bound to another evidence file, or a failed production-dependency boundary. It does not verify the legal correctness of the entered terms or that required materials actually reached the distributed image.

The reviewer determines whether a `THIRD_PARTY_NOTICES.md`, verbatim license text, source offer, or image or release metadata is required. The maintainer checks the approved distribution location in the built image or release documentation and confirms that `.dockerignore` and the Dockerfile allow required material to be included. Unknown terms, possible incompatibilities, missing materials, or an unresolved exception block sign-off. The maintainer records the qualified review and approves any exception only after its evidence and disposition are documented.

Any `development-only-runtime` or `unexpected-runtime-npm` finding requires an image or dependency-boundary fix and a fresh capture. `verify` blocks approval while either boundary array is nonempty, regardless of a written finding resolution.

Every production lockfile identity absent from the image is recorded as a `lockfile-absent-runtime` finding. The reviewer must explain each absence with lockfile and platform evidence. For the current Linux candidate, `fsevents@2.3.2` is the sole such identity: the lockfile marks it optional and limits it to `os: [darwin]` through Playwright. That documented platform exclusion may resolve the finding; a missing required package cannot be dismissed on the same basis.

## Audit the published release digest

When a release containing #17 exists, use a separate clean checkout at its tag. Record the digest published by the release workflow or resolve it from the exact version tag, then pin the reference. The following uses `vX.Y.Z` as a placeholder; replace it with that release tag. Use the same platform as the candidate, or repeat for each platform manifest in a multi-platform release.

```sh
set -eu
test -z "$(git status --porcelain --untracked-files=all)"
platform=linux/amd64
release_tag=vX.Y.Z
test "$(git rev-parse "refs/tags/$release_tag^{commit}")" = "$(git rev-parse HEAD)"
release_version=${release_tag#v}
audit_root=$(mktemp -d)
release_digest=$(docker buildx imagetools inspect "ghcr.io/sebastian-software/stellara:$release_version" --format '{{json .}}' | jq -er '.manifest.digest')
release_ref="ghcr.io/sebastian-software/stellara@$release_digest"
docker pull --platform "$platform" "$release_ref"
release_base=$(docker image inspect "$release_ref" --format '{{index .Config.Labels "org.opencontainers.image.base.name"}}')

pnpm license:audit -- capture \
  --image "$release_ref" \
  --base "$release_base" \
  --platform "$platform" \
  --output "$audit_root/release"
printf 'Release evidence: %s\n' "$audit_root/release"
```

Use a fresh evidence directory for the release. Inspect its `evidence.json` and `sbom.spdx.json`, then complete and verify a new decision file:

```sh
cp "$audit_root/release/decisions.template.json" "$audit_root/release/decisions.json"
# Complete decisions.json using the release evidence and qualified review.
pnpm license:audit -- verify \
  --evidence "$audit_root/release" \
  --decisions "$audit_root/release/decisions.json"
```

Candidate decisions cannot be reused without checking and rebinding them to the release evidence. `capture` fails if the release image's source label differs from the tag checkout, its base label or layers differ from the declared immutable base, or the selected platform lacks an attached SPDX document. Record both the index digest and the selected platform manifest digest from the evidence; never substitute one for the other.

The published digest is the final audit target even if the candidate passed. If no post-#17 release exists, leave release sign-off open. A green `verify` is necessary for the review record, but the maintainer signs off only after the qualified reviewer has resolved every component and finding and confirmed the required distributed materials.

## Refresh the evidence

Repeat `capture`, review, and `verify` when dependencies or `pnpm-lock.yaml`, the Node base digest, Dockerfile, Playwright browser version or assets, Debian packages, fonts, native binaries, copied runtime files, SBOM generation, build inputs, platform, or published image digest changes. A source-commit or evidence change invalidates the previous decision binding. Keep the immutable references, platform, `evidence.json`, `sbom.spdx.json`, completed decisions, reviewer identity, and release sign-off together so the next review can compare them.
