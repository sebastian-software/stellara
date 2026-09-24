# Tests

Die Test-Suite besteht aus drei bewusst getrennten Schichten:

- **Unit-Tests** (`tests/unit/**`) laufen über `pnpm test` und `pnpm agent:check`. Sie verwenden gestubbte Service-Clients, benötigen kein Netzwerk und keine externen Zugangsdaten.
- **Integrationstests** (`tests/integration/**`) laufen ausschließlich über `pnpm test:integration`. Sie senden echte Aufrufe an Firecrawl, Exa, Qdrant und den Embedding-Provider.
- **Container-Tests** (`tests/container/**`) laufen ausschließlich über `pnpm test:container`. Sie bauen das finale Runtime-Image und prüfen Produktionsabhängigkeiten, Image-Metadaten, SQLite, Playwright sowie den Server-Healthcheck in isolierten Containern.

## GitHub Actions

Pull Requests und Merge-Queue-Gruppen starten auf GitHub-hosted Runnern zwei getrennte Jobs:

- **`agent-check`** führt `pnpm agent:check` aus. Bei Pull Requests prüft der Job zuvor auch, ob der PR-Titel dem Conventional-Commits-Format entspricht.
- **`container-validation`** führt `pnpm test:container` aus. Die Suite baut das finale Runtime-Image und prüft dessen Abhängigkeiten, Metadaten und Laufzeitverhalten. Zusätzlich prüft sie anhand synthetischer Dateien, welche Pfade der Docker-Build-Kontext ausschließt, und wertet die Compose-Konfiguration mit und ohne lokalen Image-Override aus. Sie startet dabei keinen Compose-Stack.

Beide Jobs liefern eigenständige Statusprüfungen und können separat als verpflichtende Checks ausgewählt werden. Ob sie tatsächlich verpflichtend konfiguriert sind, legt der Workflow nicht fest. Er besitzt nur `contents: read` und erhält weder Secrets noch OIDC-Tokens. Fork-PRs werden nicht auf einem Self-hosted Runner ausgeführt.

Live-Integrationstests laufen nicht in GitHub Actions. Dadurch bleiben Pull-Request-Checks reproduzierbar und benötigen keine Providerzugänge.

`pnpm agent:check` umfasst weder Integrations- noch Container-Tests. Das lokale verpflichtende Quality Gate bleibt dadurch Docker-unabhängig und hermetisch; die Container-Validierung läuft in CI als eigener Job.

## Lokale Container-Tests

`pnpm test:container` benötigt eine laufende Docker Engine und Zugriff auf die für den Image-Build erforderlichen Basis-Images und Pakete. Der Aufruf verwendet die in `package.json` festgelegte pnpm-Version und führt ausschließlich die serielle Suite aus `tests/container/**` aus.

Die Test-Container selbst laufen mit `--network none`. Die Suite liest keine `.env`-Datei, übernimmt keine Providerzugänge aus der Host-Umgebung und greift nicht auf `stellara-data/` zu. Stattdessen verwendet sie nicht geheime Fixture-Werte, eindeutig benannte temporäre Docker-Ressourcen und entfernt Container, Volumes und das Test-Image nach jedem behandelten Lauf.

Der Test schlägt mit einer verständlichen Meldung fehl, wenn der Docker-Daemon nicht erreichbar ist. Für die Browser-Prüfung müssen genügend Arbeitsspeicher und freier Plattenplatz für das Chromium-Image verfügbar sein.

## Lokale Integrationstests

`pnpm test:integration` liest dieselben Standard-Umgebungsvariablen wie die Anwendung. Maintainer können sie mit einem eigenen Secret-Manager für den einzelnen Prozess bereitstellen; das Repository setzt kein bestimmtes Secret-Werkzeug voraus.

Für die vollständige Suite sind erforderlich:

| Umgebungsvariable | Zweck |
| --- | --- |
| `PUBLIC_BASE_URL` | öffentlicher Stellara-Origin für OAuth- und MCP-Metadaten |
| `FIRECRAWL_BASE_URL` | Firecrawl-Endpunkt |
| `FIRECRAWL_API_KEY` | Firecrawl-Testzugang |
| `EXA_API_KEY` | Exa-Testzugang |
| `QDRANT_BASE_URL` | isolierter Qdrant-Testendpunkt |
| `QDRANT_API_KEY` | Qdrant-Testzugang |
| `QDRANT_COLLECTION` | isolierte Test-Collection |
| `EMBEDDINGS_MODEL` | Modell des Embedding-Providers |
| `EMBEDDINGS_API_KEY` | Embedding-Testzugang |
| `EMBEDDINGS_DIMENSIONS` | Vektordimension der Test-Collection |
| `STELLARA_TOKEN_INTEGRATION` | lokaler Bearer-Token des Integrationstest-Users |

Die Suite verwendet die zugehörigen Variablennamen aus `.env.example`. Für Qdrant sollte eine isolierte Test-Collection verwendet werden. Der Memory-Test schreibt einen markierten Testpunkt, prüft ihn und löscht ihn anschließend wieder; ein abgebrochener Lauf kann trotzdem Testdaten hinterlassen.

Zugangsdaten dürfen nicht in Dateien unter Versionskontrolle, Test-Fixtures, Logs oder Issues gelangen. Lokale Environment-Dateien werden durch `.gitignore` ausgeschlossen, sind aber nicht der dokumentierte Standardweg.

## Weiterführende Dokumentation

- Setup, Quality Gate und Scripts: [`entwicklung.md`](entwicklung.md)
- Tool-API und Beispielaufrufe: [`tool-api.md`](tool-api.md)
- Architektur und Tool-Design: [`stellara-konzept.md`](stellara-konzept.md)
