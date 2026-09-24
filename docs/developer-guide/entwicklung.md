# Entwicklung

Diese Seite beschreibt, wie du Stellara lokal einrichtest, welche Quality-Gate-Regeln gelten und wie der Entwicklungs-Workflow im Alltag aussieht.

## Voraussetzungen

- Node.js >= 24 (verbindlich über `engines.node`)
- pnpm 10 (über `packageManager` gepinnt; Corepack reicht aus)
- Docker (nur für den Image-Build und das Compose-Setup)

## Installation

```bash
pnpm install
```

## Quality Gate

`pnpm agent:check` ist die verbindliche Quality-Gate-Pforte. Sie muss nach jeder Code-Änderung lokal grün laufen, bevor die Aufgabe als erledigt gilt. Fehlschläge werden behoben, nicht umgangen — kein `--no-verify`, keine ausgelassenen Checks.

Das Skript verkettet die folgenden Prüfungen sequenziell:

```bash
pnpm agent:check
# = pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```

## Scripts

| Script                    | Aufgabe                                                       |
| ------------------------- | -------------------------------------------------------------- |
| `pnpm dev`                | `tsx watch src/server.ts`                                      |
| `pnpm build`              | `tsc -b ./tsconfig.src.json --force` (Build nach `dist/`)      |
| `pnpm start`              | startet den gebauten Server (`node dist/server.js`)            |
| `pnpm typecheck`          | `tsc -b`                                                        |
| `pnpm lint`               | `oxlint . && eslint .`                                         |
| `pnpm lint:fix`           | `oxlint --fix . && eslint --fix .`                              |
| `pnpm format`             | `prettier --write .`                                            |
| `pnpm format:check`       | `prettier --check .`                                             |
| `pnpm test`               | `vitest run` (nur Unit-Suite, hermetisch)                        |
| `pnpm test:watch`         | `vitest` (Watch-Modus)                                            |
| `pnpm test:container`     | `vitest run --config vitest.container.config.ts`                 |
| `pnpm test:integration`   | `vitest run --config vitest.integration.config.ts`                |
| `pnpm agent:check`        | Aggregator: `typecheck`, `lint`, `format:check`, `test`            |
| `pnpm migrate:embeddings` | führt das Embedding-Migrationsskript aus (siehe [Konzept §25](stellara-konzept.md)) |

## Entwicklungs-Workflow

- Änderungen folgen Conventional Commits in Englisch, ohne `Co-Authored-By`-Trailer.
- Vor dem Commit lokal `pnpm agent:check` ausführen und grün sehen.
- Öffentliche Vorhaben werden als GitHub Issues geführt; das Architektur-Konzept lebt in [`stellara-konzept.md`](stellara-konzept.md).

## Konfigurationsdateien

- `tsconfig.json` ist das Root-Projekt für den Typecheck: Es prüft Skripte, Tests und Konfigurationsdateien ohne Emit und referenziert `tsconfig.src.json` für `src/`. Das Source-Projekt erzeugt beim Build JavaScript, Deklarationen und Source Maps unter `dist/`.
- `eslint-config-setup` bringt einen CSpell-Plugin mit; `cspell.config.json` hält das Projekt-Wörterbuch (Stellara-spezifische Begriffe wie Qdrant, Firecrawl, pino-spezifisches Vokabular).
- `oxlint.config.ts` exportiert `getOxlintConfig({ node: true })` aus `eslint-config-setup`. oxlint lädt die Datei direkt via Node-Loader (ab oxlint 1.67 / Node ≥ 20.19 unterstützt), sodass oxlint- und ESLint-Profil aus derselben Quelle stammen.

## Weiterführende Dokumentation

- Tool-API und Beispiel-Aufrufe: [`tool-api.md`](tool-api.md)
- Teststrategie und Integration-Suite: [`tests.md`](tests.md)
- Container-Tests: [`tests.md#lokale-container-tests`](tests.md#lokale-container-tests)
- Architektur und Tool-Design: [`stellara-konzept.md`](stellara-konzept.md)
- Dependency-Security-Audit-Trail: [`dependencies.md`](dependencies.md)
- Betrieb (OAuth, Volumes, Operations): [`../operations/betrieb.md`](../operations/betrieb.md)
