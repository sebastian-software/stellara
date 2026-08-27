# Tool-API

Diese Seite zeigt Beispiel-Aufrufe für die REST- und MCP-Oberfläche von Stellara sowie die aktuelle, aus der Code-Registry abgeleitete Liste aller Tools.

Alle nicht-öffentlichen Endpunkte erwarten einen `Authorization: Bearer <STELLARA_TOKEN_*>`-Header. Die folgenden Beispiele setzen `BASE_URL` auf die `PUBLIC_BASE_URL` aus `.env` und `STELLARA_TOKEN` auf einen gültigen User-Token (siehe [Konzept](stellara-konzept.md) §6.3).

> Hinweis: `STELLARA_TOKEN` ist in den Beispielen nur eine lokale Shell-Variable für den `curl`-Aufruf. Stellara selbst erwartet die Tokens server-seitig in der Form `STELLARA_TOKEN_<USERID>` (z. B. `STELLARA_TOKEN_USER_A`) – der Wert von `STELLARA_TOKEN` muss also dem Inhalt einer dieser server-seitigen Variablen entsprechen (siehe [Konzept](stellara-konzept.md) §6.3).

## Beispiel-Aufrufe

### REST – `POST /tools/search` (web_search)

```bash
curl -sS \
  -X POST "$BASE_URL/tools/search" \
  -H "Authorization: Bearer $STELLARA_TOKEN" \
  -H "content-type: application/json" \
  --data '{
    "query": "model context protocol",
    "maxResults": 5,
    "type": "auto"
  }'
```

Das Antwort-Schema (`results[]`) ist im [Konzept](stellara-konzept.md) §8.1 spezifiziert und im automatisch erzeugten OpenAPI-Dokument unter `GET /openapi.json` abrufbar.

### REST – `POST /tools/map` (web_map, Sitemap-Discovery)

```bash
curl -sS \
  -X POST "$BASE_URL/tools/map" \
  -H "Authorization: Bearer $STELLARA_TOKEN" \
  -H "content-type: application/json" \
  --data '{
    "url": "https://docs.example.com",
    "search": "api",
    "maxUrls": 200
  }'
```

Liefert eine Liste der von Firecrawl entdeckten URLs zurück (siehe [Konzept](stellara-konzept.md) §8.10). Ideal als Planungsschritt vor einem gezielten `web_scrape` oder `web_crawl_start`.

### REST – `POST /tools/extract` (web_extract, strukturierte Extraktion)

```bash
curl -sS \
  -X POST "$BASE_URL/tools/extract" \
  -H "Authorization: Bearer $STELLARA_TOKEN" \
  -H "content-type: application/json" \
  --data '{
    "urls": ["https://example.com/product/42"],
    "prompt": "Extrahiere Produktname, Preis und Verfügbarkeit.",
    "schema": {
      "type": "object",
      "properties": {
        "name":  { "type": "string" },
        "price": { "type": "number" },
        "inStock": { "type": "boolean" }
      },
      "required": ["name", "price"]
    }
  }'
```

Mindestens eines von `prompt` oder `schema` ist erforderlich (siehe [Konzept](stellara-konzept.md) §8.11). Wenn beides gesetzt ist, nutzt Firecrawls Extractor das Schema als Ziel-Form und den Prompt als zusätzliche Anweisung.

### REST – `POST /tools/fetch` (web_fetch, generischer HTTP-Aufruf)

```bash
curl -sS \
  -X POST "$BASE_URL/tools/fetch" \
  -H "Authorization: Bearer $STELLARA_TOKEN" \
  -H "content-type: application/json" \
  --data '{
    "url": "https://api.github.com/repos/sebastian-software/stellara",
    "method": "GET",
    "headers": { "Accept": "application/vnd.github+json" },
    "responseFormat": "auto"
  }'
```

Leichtgewichtiger HTTP-Fetch (siehe [Konzept](stellara-konzept.md) §8.17) für JSON-APIs und Text-Endpoints. `Authorization`-Header darf an den Upstream durchgereicht werden — der primäre Use-Case ist die Konsumierung authentifizierter APIs. SSRF-Schutz, Header-Sanitization, 10-MB-Body-Cap und Redirect-Hop-Validierung leben im gemeinsamen Service-Layer (`src/services/http-fetch.ts`).

### REST – `POST /tools/get` (web_get, read-only HTTP-Fetch)

```bash
curl -sS \
  -X POST "$BASE_URL/tools/get" \
  -H "Authorization: Bearer $STELLARA_TOKEN" \
  -H "content-type: application/json" \
  --data '{
    "url": "https://api.github.com/repos/sebastian-software/stellara",
    "method": "GET",
    "headers": { "Accept": "application/vnd.github+json" },
    "responseFormat": "auto"
  }'
```

Read-only-Geschwister von `web_fetch` (siehe [Konzept](stellara-konzept.md) §8.31). Das Schema erlaubt nur die HTTP-„safe methods“ `GET`, `HEAD` und `OPTIONS` und kennt kein `body`-Feld — Schreibzugriffe sind strukturell ausgeschlossen, deshalb führt das MCP-Tool `annotations.readOnlyHint: true`. Sicherheitspfad, Response-Form (`fetchResponseSchema`) und Header-Sanitization sind identisch zu `web_fetch`.

### REST – `POST /tools/graphql` (web_graphql)

```bash
curl -sS \
  -X POST "$BASE_URL/tools/graphql" \
  -H "Authorization: Bearer $STELLARA_TOKEN" \
  -H "content-type: application/json" \
  --data '{
    "endpoint": "https://api.github.com/graphql",
    "query": "query($login: String!) { user(login: $login) { name } }",
    "variables": { "login": "sebastian-software" },
    "headers": { "Authorization": "Bearer <github-pat>" }
  }'
```

GraphQL-Wrapper um `web_fetch` (siehe [Konzept](stellara-konzept.md) §8.18). Errors-im-200-Body (GraphQL-Standard) werden 1:1 als `errors`-Array durchgereicht — kein Throw. Non-JSON-Antworten erzeugen einen synthetischen `errors`-Eintrag, damit der Caller einen einheitlichen Fehlerpfad sieht.

### REST – `POST /tools/graphql-query` (web_graphql_query, read-only GraphQL-Query)

```bash
curl -sS \
  -X POST "$BASE_URL/tools/graphql-query" \
  -H "Authorization: Bearer $STELLARA_TOKEN" \
  -H "content-type: application/json" \
  --data '{
    "endpoint": "https://api.github.com/graphql",
    "query": "query($login: String!) { user(login: $login) { name } }",
    "variables": { "login": "sebastian-software" },
    "headers": { "Authorization": "Bearer <github-pat>" }
  }'
```

Read-only-Geschwister von `web_graphql` (siehe [Konzept](stellara-konzept.md) §8.32). Der `query`-String wird vor dem Aufruf serverseitig mit dem `graphql`-Parser eingelesen; enthält das Dokument irgendeine `mutation`- oder `subscription`-Operation, weist der Endpunkt den Aufruf mit `400 BAD_REQUEST` ab. Nach bestandenem Guard läuft exakt derselbe Pfad wie `web_graphql` (kanonischer Body, Response-Form `graphqlResponseSchema`).

### REST – `POST /tools/browser/session/start` (browser_session_start)

```bash
curl -sS \
  -X POST "$BASE_URL/tools/browser/session/start" \
  -H "Authorization: Bearer $STELLARA_TOKEN" \
  -H "content-type: application/json" \
  --data '{ "url": "https://example.com" }'
```

Öffnet eine neue Playwright-Session (siehe [Konzept](stellara-konzept.md) §8.19) und liefert eine `sessionId` (ULID) zurück. Sessions räumen sich nach 5 Minuten Inaktivität auf, spätestens nach 30 Minuten. Concurrency-Limits werden über `STELLARA_PLAYWRIGHT_MAX_SESSIONS` (Default 3) und `STELLARA_PLAYWRIGHT_MAX_SESSIONS_PER_USER` (Default 1) gesteuert; Überschreitung liefert `429` mit `details.reason: "global_session_limit"`/`"user_session_limit"`.

Per Default spooft jede Session eine Linux-Chrome-Identität (`de-DE`, `Europe/Berlin`, Viewport 1366×768) und patcht browserinterne Automatisierungsmerkmale (`navigator.webdriver`, `window.chrome` u. a.) über das Stealth-Plugin. Das optionale Feld `stealth: false` deaktiviert die Context-Identität für diese Session – die Plugin-Patches bleiben aktiv. Mit `STELLARA_PLAYWRIGHT_STEALTH=false` schaltet der Operator beides global aus; dann verhält sich der Browser wie Headless-Chromium ohne Modifikationen, und das `stealth`-Feld im Tool-Aufruf wird ignoriert.

### REST – `POST /tools/browser/interact` (browser_interact)

```bash
curl -sS \
  -X POST "$BASE_URL/tools/browser/interact" \
  -H "Authorization: Bearer $STELLARA_TOKEN" \
  -H "content-type: application/json" \
  --data '{
    "sessionId": "01JABC...",
    "actions": [
      { "type": "fill", "selector": "input[name=q]", "text": "stellara" },
      { "type": "press", "selector": "input[name=q]", "key": "Enter" },
      { "type": "wait_for_selector", "selector": "h3", "state": "visible" }
    ]
  }'
```

Action-Vokabular: `click`, `type`, `fill`, `wait`, `wait_for_selector`, `scroll`, `hover`, `press`, `select` (siehe [Konzept](stellara-konzept.md) §8.22). Jede Action wird strukturiert validiert; unbekannte `type`-Werte ergeben `422`. Nach dem ersten `failed`-Schritt bricht die Kette ab und der Result-Array enthält den bis dahin gesammelten Stand.

> **Image-Hinweis:** Das Runtime-Image bündelt Chromium (~400 MB) für die Playwright-Tools. Mit `STELLARA_PLAYWRIGHT_ENABLED=false` werden Routen, MCP-Einträge und Pool komplett deaktiviert; das Image bleibt aus operativer Konsistenz auf bookworm-slim-Basis.

### MCP – `POST /mcp` (MCP `2026-07-28`)

Die MCP-Streamable-HTTP-Oberfläche teilt sich Authentifizierung und Rate Limits mit der REST-API. Der bevorzugte moderne Pfad benötigt keinen `initialize`-Handshake: `server/discover` ist der erste Aufruf. Moderne Requests müssen Protokollversion und Methode sowohl in den MCP-HTTP-Headern als auch request-spezifisch in `_meta` angeben; `clientCapabilities` ist ebenfalls Pflicht.

```bash
curl -sS \
  -X POST "$BASE_URL/mcp" \
  -H "Authorization: Bearer $STELLARA_TOKEN" \
  -H "Accept: application/json" \
  -H "content-type: application/json" \
  -H "MCP-Protocol-Version: 2026-07-28" \
  -H "Mcp-Method: server/discover" \
  --data '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "server/discover",
    "params": {
      "_meta": {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": {
          "name": "stellara-curl",
          "version": "1.0.0"
        }
      }
    }
  }'
```

`server/discover` liefert `resultType: "complete"`, Servermetadaten, die unterstützte moderne Version und Stellaras Tool-Suite-Instructions. Für die Toolliste folgt ein eigener moderner Request:

```bash
curl -sS \
  -X POST "$BASE_URL/mcp" \
  -H "Authorization: Bearer $STELLARA_TOKEN" \
  -H "Accept: application/json" \
  -H "content-type: application/json" \
  -H "MCP-Protocol-Version: 2026-07-28" \
  -H "Mcp-Method: tools/list" \
  --data '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {
      "_meta": {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": {
          "name": "stellara-curl",
          "version": "1.0.0"
        }
      }
    }
  }'
```

Die Antwort enthält die kanonischen Stellara-Tools mit `name`, `description` (mehrsätzig, inklusive Querverweisen auf verwandte Tools), MCP-`annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `title`) sowie JSON-Schema-`inputSchema` und `outputSchema`. `server/discover` und `tools/list` sind mit `cacheScope: "private"` und `ttlMs: 300000` für den jeweiligen Authkontext fünf Minuten cachebar. Responses verwenden ausschließlich JSON und senden keinen `Mcp-Session-Id`.

Bei `tools/call` muss zusätzlich `Mcp-Name` exakt den Toolnamen aus dem Body tragen. Ein erfolgreicher Aufruf liefert `content` plus das gegen `outputSchema` validierte `structuredContent`. Bei einem bekannten Tool werden sowohl ungültige Argumente als auch Ausführungsfehler im modernen Pfad als Toolresultat mit `isError: true` zurückgegeben. Unknown-Tool-, Methoden-, Header- und Versionsfehler bleiben JSON-RPC-Fehler. Fehlende oder widersprüchliche moderne Header liefern `-32020`, eine nicht unterstützte Protokollversion `-32022` und fehlende Pflicht-Metadaten `-32602`; ein teilweise moderner Request fällt nicht auf Legacy zurück.

Für die kurze Übergangszeit erkennt derselbe Endpunkt echte initialisierungsbasierte Requests der Versionen `2025-11-25`, `2025-06-18`, `2025-03-26` und `2024-11-05`. Diese Aufrufe laufen über Stellaras isolierten JSON-Dispatcher – nicht über einen SDK-Legacy-SSE-Fallback. Legacy behält `initialize`, antwortlose `notifications/initialized`, `tools/list` und `tools/call`; Argumentfehler bleiben JSON-RPC-Fehler, Ausführungsfehler nach erfolgreicher Argumentvalidierung werden als `isError: true` geliefert. Neue Integrationen sollten ausschließlich MCP `2026-07-28` verwenden. Die praktische Einbindung in LLM-Apps steht im [User-Guide](../user-guide/llm-clients-einbinden.md).

## Kanonische Tool-Liste

Die folgende Liste ist die autoritative `MCP_TOOLS`-Registry aus `src/schemas/mcp-tools.ts`, ergänzt um die Tool-Familien-Einordnung aus `src/llm-instructions.ts`. Welche Tools ein konkretes Deployment tatsächlich anbietet, hängt von den Feature-Flags ab (siehe [Konzept](stellara-konzept.md) §12).

### `web_*` — Content-Beschaffung (Firecrawl + Exa)

| Tool               | Zweck                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `web_search`        | Semantische Suche via Exa; liefert Titel/Snippet ohne Volltext.                               |
| `web_scrape`        | Einzelne URL via Firecrawl → sauberes Markdown (oder HTML), inkl. JS-Rendering.                |
| `web_crawl`         | Mehrseitiger Firecrawl-Crawl, synchroner Wrapper mit ~55-Sekunden-Soft-Cap.                    |
| `web_research`      | Exa-Suche + Firecrawl-Scrape in einem Aufruf, mit `sources[]` inkl. Inhalt.                     |
| `web_map`           | Discovery erreichbarer URLs ab einer Start-URL, ohne Inhalt.                                     |
| `web_extract`       | Strukturierte Datenextraktion via Firecrawls LLM-Extractor (Prompt und/oder JSON-Schema).       |
| `web_crawl_start`   | Startet einen asynchronen Firecrawl-Crawl-Job und liefert die Job-ID.                            |
| `web_crawl_status`  | Pollt einen laufenden Firecrawl-Crawl-Job.                                                        |

### `web_fetch` / `web_graphql` — generisches HTTP (SSRF-geschützt)

| Tool                 | Zweck                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `web_fetch`          | Generischer HTTP-Request gegen einen öffentlichen Endpunkt, `Authorization` wird durchgereicht.     |
| `web_get`            | Read-only-Geschwister von `web_fetch`: nur die HTTP-„safe methods“ `GET`/`HEAD`/`OPTIONS`, kein `body`. |
| `web_graphql`        | GraphQL-Wrapper um `web_fetch`, baut den kanonischen `{ query, variables, operationName }`-Body.    |
| `web_graphql_query`  | Read-only-Geschwister von `web_graphql`: lehnt jede `mutation`/`subscription` im Dokument mit `400` ab. |

### `browser_*` — interaktiver Browser (Playwright)

| Tool                    | Zweck                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `browser_session_start` | Öffnet eine Playwright-Session, liefert eine `sessionId`; Stealth-Profil standardmäßig aktiv. |
| `browser_session_stop`  | Schließt eine Playwright-Session und gibt den Chromium-Context frei.                          |
| `browser_navigate`      | Navigiert die aktive Seite einer Session zu einer neuen URL.                                   |
| `browser_interact`      | Führt eine Kette von Browser-Aktionen aus (`click`, `type`, `fill`, `wait`, …).                |
| `browser_screenshot`    | Erstellt einen PNG-Screenshot der aktiven Seite oder eines Selektors.                          |
| `browser_content`       | Liest das DOM der aktiven Seite als HTML oder Klartext.                                        |
| `browser_eval`          | Wertet einen JavaScript-Ausdruck im V8-Kontext der Seite aus.                                  |
| `browser_pdf`           | Rendert die aktive Seite als PDF.                                                               |
| `browser_cookies`       | Liest oder setzt Cookies auf dem Session-Context (`get`/`set`/`clear`).                        |
| `browser_storage`       | Liest oder setzt `localStorage`/`sessionStorage` der aktiven Seite (`get`/`set`/`clear`).      |
| `browser_har`           | Startet oder stoppt die HAR-Aufzeichnung der Session.                                          |
| `browser_tabs`          | Listet, wechselt, schließt oder öffnet Tabs innerhalb einer Session.                            |

### `memory_*` — persistente Vektor-Memory (Qdrant)

| Tool             | Zweck                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `memory_upsert`  | Speichert oder ersetzt einen Memory-Point für den aufrufenden User.                               |
| `memory_search`  | Vektor-Suche über die Memory-Points des aufrufenden Users.                                        |
| `memory_list`    | Listet Memory-Points cursor-paginiert, neueste zuerst.                                            |
| `memory_delete`  | Löscht Memory-Points per ID oder Filter (exklusiv, dauerhaft).                                    |

### `domain_*` — Registry-Lookups

| Tool                  | Zweck                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `domain_availability` | Prüft, ob eine Domain registriert ist (RDAP-first, WHOIS-Fallback); liefert `registered`/`available`/`unsupported_tld`/`indeterminate`, keine Registrant-Daten. |

## Weiterführende Dokumentation

- Setup, Quality Gate und Scripts: [`entwicklung.md`](entwicklung.md)
- Teststrategie und Integration-Suite: [`tests.md`](tests.md)
- Architektur und Tool-Design: [`stellara-konzept.md`](stellara-konzept.md)
- LLM-App-Einbindung und Auth (End-User-Sicht): [`../user-guide/llm-clients-einbinden.md`](../user-guide/llm-clients-einbinden.md)
- OAuth-Betrieb, Volumes, Operations: [`../operations/betrieb.md`](../operations/betrieb.md)
