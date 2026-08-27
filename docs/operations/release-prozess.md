# Release-Prozess

Stellara verwendet [release-please](https://github.com/googleapis/release-please) für Versionierung und Release Notes. Container-Images entstehen ausschließlich aus einem veröffentlichten GitHub Release.

## Ablauf

1. Änderungen werden über Pull Requests mit englischen Conventional-Commit-Titeln nach `main` gemergt.
2. Der GitHub-hosted Workflow `.github/workflows/release-please.yml` aktualisiert einen Release-PR.
3. Das Mergen des Release-PRs erzeugt einen Tag `vX.Y.Z` und veröffentlicht das zugehörige GitHub Release.
4. Das `release.published`-Event startet `.github/workflows/release.yml`.
5. Der Workflow prüft Tag und `package.json`, baut das Image und veröffentlicht drei Tags:
   - exakte Version, zum Beispiel `0.1.15`;
   - Minor-Serie, zum Beispiel `0.1`;
   - `latest`.
6. Der Build hängt eine SBOM an das OCI-Image und veröffentlicht eine GitHub Build-Provenance-Attestation für den erzeugten Digest.

Normale Pushes nach `main`, Pull Requests und manuell erzeugte Tags veröffentlichen kein Container-Image.

## Pre-1.0-Versionierung

Solange die Version unter `1.0.0` liegt, gilt:

- `feat:` → Patch-Bump, zum Beispiel `0.1.15` → `0.1.16`;
- `fix:` → Patch-Bump;
- `BREAKING CHANGE:` oder `feat!:` → Minor-Bump, zum Beispiel `0.1.15` → `0.2.0`;
- `chore:`, `docs:`, `refactor:` und `test:` lösen kein Release aus.

## Environment `release`

Der release-please-Job verwendet das GitHub Environment `release`. Darin liegt `STELLARA_RELEASE_PLEASE_TOKEN` als fein-granularer Personal Access Token, der ausschließlich auf `sebastian-software/stellara` begrenzt ist:

- Contents: Read and write;
- Pull requests: Read and write;
- Issues: Read and write.

Der Token wird benötigt, weil ein mit dem Standard-`GITHUB_TOKEN` erzeugter Tag keinen nachfolgenden Release-Workflow startet. Das Environment ist auf `main` beschränkt und benötigt keine manuelle Deployment-Freigabe. Bis das Environment-Secret gesetzt ist, bleibt die Repository-Variable `RELEASE_AUTOMATION_ENABLED` auf `false`; der Workflow kann dann keinen Release-PR erzeugen.

## Hinweise

- Versionstags werden nicht gelöscht oder neu erzeugt.
- `latest` bezeichnet ausschließlich das neueste stabile GitHub Release.
- Deployments sollten für reproduzierbare Rollbacks die exakte Version oder den Image-Digest verwenden.
- Der Build veröffentlicht keine Providerzugänge und verwendet nur das automatisch bereitgestellte `GITHUB_TOKEN` zum Push nach GHCR.

## Weiterführende Dokumentation

- Betrieb: [`betrieb.md`](betrieb.md)
- Architektur und Tool-Design: [`../developer-guide/stellara-konzept.md`](../developer-guide/stellara-konzept.md)
