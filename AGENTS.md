# AGENTS.md

Last updated: 2026-08-27

Diese Datei ist die verbindliche Regelquelle für alle KI-Agenten (Codex, Claude Code, weitere LLM-Tools), die in diesem Repository Code oder Doku ändern. Sie ergänzt das Architektur-Konzept und gilt für jeden Beitrag.

## Überblick

Stellara ist ein selbst gehostetes AI-Tool-Gateway (Fastify + TypeScript) für Firecrawl, Exa, Qdrant und ein Embedding-Backend. Architektonische Grundlage ist `docs/developer-guide/stellara-konzept.md`; öffentlich geplante Arbeiten werden als GitHub Issues geführt.

## Sprache

- Code, Bezeichner, Testbeschreibungen, Commit-Messages und Pull-Request-Titel auf Englisch.
- Öffentliche Einstiegs- und Community-Dokumente (`README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `SUPPORT.md`, Issue- und PR-Templates) auf Englisch.
- Die vertiefende Bestandsdokumentation bleibt bis zur vollständigen Übersetzung auf Deutsch, mit korrekten Umlauten und Typografie. Neue oder vollständig überarbeitete öffentliche Dokumente werden auf Englisch geschrieben.

## Quality Gate

`pnpm agent:check` muss vor Abschluss einer Aufgabe einmal vollständig grün gelaufen sein — also bevor `git commit` ausgeführt oder die Aufgabe an den User zurückgegeben wird. Zwischenzeitliche Checks während eines Bearbeitungslaufs sind erlaubt, aber nicht verpflichtend. Das Skript verkettet `typecheck`, `lint`, `format:check` und `test`.

- Fehler werden behoben, nicht umgangen.
- Kein `--no-verify`, kein Auslassen einzelner Checks.
- Wenn ein Check langfristig stört, wird die Konfiguration angepasst — nicht der Aufruf umgangen.

## Scope

- `docs/developer-guide/stellara-konzept.md` ist die architektonische Grundlage. Abweichungen werden zuerst dort diskutiert.
- GitHub Issues beschreiben öffentliche Vorhaben. Interne Planarchive gehören nicht in dieses Repository.
- Neue Module, Routen oder Services folgen der Struktur aus §10 des Konzepts.

## Neue Tools hinzufügen

Wenn ein neues Tool (REST + MCP) eingeführt wird, muss es an allen folgenden Stellen registriert werden — vergessene Einträge führen entweder zu kompilierenden, aber unentdeckbaren Tools oder zu fehlschlagenden Tests:

1. `src/schemas/<area>.ts` — Zod-Schemas für Request und Response.
2. `src/services/<area>.ts` — Upstream-Adapter (falls nicht wiederverwendbar).
3. `src/tools/<area>.ts` — Orchestrator `runX(app, input)`.
4. `src/tools/index.ts` — Re-Export von `runX` und Result-Typ.
5. `src/routes/<name>.ts` — REST-Route mit `operationId` (= MCP-Toolname).
6. `src/server.ts` — Route-Registrierung, ggf. Feature-Gate.
7. `src/schemas/mcp-tools.ts` — Eintrag in der `MCP_TOOLS`-Registry (Name, Beschreibung, Feature, Schema, Annotations).
8. `src/routes/mcp/tools-adapters.ts` — Adapter in `TOOL_ADAPTERS` und Result-Typ in der `ToolCallResult`-Union.
9. `src/routes/mcp/tools.ts` — Feature-Flag im `TOOL_PAYLOAD_CACHE`-Bootstrap (falls neues Feature).
10. `src/config.ts` — Env-Var, `ConfigFeatures.<flag>` und `deriveFeatures` (falls neues Feature).
11. `src/timeouts.ts` — neuer Key in `PER_ROUTE_TIMEOUTS_MS`.
12. **`src/llm-instructions.ts` — Eintrag in `STELLARA_SUITE_OVERVIEW`.** Diese Übersicht wird als MCP-`initialize.instructions` und in der OpenAPI-`info.description` ausgespielt; ohne den Eintrag ist das Tool für LLM-Clients (Claude Desktop, ChatGPT Connectors, Codex) bei der Tool-Auswahl unsichtbar, auch wenn `tools/list` es korrekt führt. Aktualisiere sowohl die Familien-Aufzählung in der Einleitung als auch die passende `### <area>_*`-Sektion und ggf. den `## Prefer Stellara`-Steering-Block.
13. Tests:
    - `tests/unit/schemas/<area>.test.ts`, `tests/unit/services/<area>.test.ts`, `tests/unit/routes/<name>.test.ts` für das neue Tool.
    - `tests/unit/config.test.ts`, `tests/unit/server.test.ts`, `tests/unit/routes/mcp.test.ts` anpassen, wenn `ConfigFeatures` oder die MCP-Tool-Liste sich ändern (`toStrictEqual`-Vergleiche erweitern).

Das zugehörige GitHub Issue sollte diese Checkliste im Scope oder in den Akzeptanzkriterien abbilden, damit kein Registrierungsschritt ausgelassen wird.

## Commits

- Conventional Commits in Englisch (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).
- Kein `Co-Authored-By`-Trailer, auch nicht aus Templates oder LLM-Defaults.
- Keine internen Tracking-IDs (Review-Findings, Plan-Plätze) in Commit-Messages.

## Node-Version

`engines.node` in `package.json` ist verbindlich (>= 24). Lokale Setups, die davon abweichen, müssen vor der Arbeit angepasst werden — `nvm`/`fnm`/Volta sind erlaubte Werkzeuge.

## Weiteres

- pnpm ist der einzige unterstützte Package-Manager. Lockfile-Änderungen entstehen ausschließlich durch `pnpm install`.
- Pre-commit-Hooks gibt es bewusst nicht; die Verantwortung für das Quality Gate liegt beim Agenten.
