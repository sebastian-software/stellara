# Konzept: Stellara — AI Tool Gateway für Firecrawl, Exa, Qdrant, ChatGPT und Claude

## 1. Ziel

Es soll ein leichtgewichtiges Node.js-Gateway betrieben werden.

Primäre Zielumgebung:

```text
Deploymenthost mit Docker
```

Die externe Erreichbarkeit erfolgt über einen Edge/Reverse Proxy.
Dessen konkrete Produkt- und Anbieteranbindung ist nicht Teil dieses Konzepts.

Ein klassischer VPS bleibt als mögliche Alternative für später offen,
ohne dass sich das Gateway selbst dadurch ändert.

Das Gateway dient als zentrale, private Tool-Schicht für:

- ChatGPT Actions
- Claude Desktop / Claude-kompatible MCP-Clients
- spätere Remote-MCP-Nutzung
- eigene Scripts oder Apps
- iPhone-Nutzung über HTTPS

Das Gateway kapselt externe Dienste:

- Firecrawl
- Exa
- Qdrant
- spätere weitere Tools

Der Betrieb dieser externen Dienste ist nicht Teil dieses Konzepts.
Sie werden über ihre HTTP-APIs angebunden, unabhängig davon, ob sie
selbst gehostet oder als Managed Service betrieben werden.

Es wird nicht als einfacher Proxy gebaut, sondern als kleiner Tool-Orchestrator.

---

## 2. Name und Domain

Projektname:

```text
Stellara
```

Der öffentliche HTTPS-Origin wird je Deployment konfiguriert:

```text
PUBLIC_BASE_URL=https://stellara.example.com
```

`https://stellara.example.com` ist eine reservierte Beispieldomain und muss
durch den eigenen öffentlichen HTTPS-Origin ersetzt werden. Clients und
Discovery-Metadaten verwenden ausschließlich diesen konfigurierten Origin.

---

## 3. Architektur

```text
ChatGPT / Claude / iPhone / eigene Clients
        |
        | HTTPS
        v
Edge/Reverse Proxy (nicht Teil dieses Konzepts)
        |
        v
Node.js AI Tool Gateway
        |
        +--> Firecrawl   (extern)
        |
        +--> Exa         (extern)
        |
        +--> Qdrant      (extern)
        |
        +--> Embeddings  (extern, für Qdrant)
        |
        +--> spätere Tools
```

---

## 4. Betriebsmodell

Zielgruppe:

```text
maximal 3 vertraute User
```

Für direkte API-Aufrufe bleibt das einfache Token-Modell maßgeblich:

```text
HTTPS + Bearer Token pro User
```

Für grafische und andere OAuth-fähige MCP-Clients ergänzt Stellara diesen
Zugriff um einen eigenen OAuth-2.1-Authorization-Server (§6.6). Beide Wege
führen auf dieselbe User-ID und dieselbe Tool-Sichtbarkeit.

Beispiel:

```http
Authorization: Bearer <USER_TOKEN>
```

---

## 5. Domains

Kanonischer öffentlicher Origin:

```text
${PUBLIC_BASE_URL}
```

Alle client-sichtbaren URLs werden daraus abgeleitet. Ein interner Hostname
oder eine Proxy-Adresse darf hier nicht verwendet werden.

Wichtige Endpunkte:

```text
GET  /health          (public, §6.4)
GET  /ready           (public, §6.4)
GET  /openapi.json    (public, §6.4)
POST /tools/search
POST /tools/scrape
POST /tools/crawl
POST /tools/research
POST /tools/memory/upsert
POST /tools/memory/search
POST /tools/memory/list
POST /tools/memory/delete
POST /mcp             (Token-gesichert)
GET  /mcp             (405 Method Not Allowed in v1, §9)
```

---

## 6. Authentifizierung

### 6.1 Token-Modell

Jeder User bekommt einen eigenen Token. Env-Variablen folgen
dem Pattern `STELLARA_TOKEN_<USERID>` (Suffix uppercase, User-ID
in den Logs und im Memory-Scope dann lowercase):

```env
STELLARA_TOKEN_USER_A=...
STELLARA_TOKEN_USER_B=...
# weitere User: STELLARA_TOKEN_<USERID>=...
```

Empfehlung für die Token-Generierung:

```bash
openssl rand -hex 48
```

---

### 6.2 Request-Beispiel

```bash
BASE_URL=https://stellara.example.com
curl "${BASE_URL}/tools/search" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"query":"Model Context Protocol Streamable HTTP","maxResults":5}'
```

---

### 6.3 Token → User-Mapping

Das Gateway iteriert beim Start über alle Env-Variablen mit
Prefix `STELLARA_TOKEN_`. Das Suffix (lowercased) wird zur
User-ID, der Wert ist der erwartete Bearer-Token:

```text
STELLARA_TOKEN_USER_A=<token>  -> userId "user_a"
STELLARA_TOKEN_USER_B=<token>  -> userId "user_b"
```

Neue User können ohne Code-Änderung über zusätzliche
Env-Variablen aufgenommen werden.

Die aufgelöste User-ID:

- wird in jeden Log-Eintrag und Trace gesetzt
- bestimmt die Sichtbarkeit im Memory-Speicher
  (siehe §8.9 Per-User-Isolation)
- wird auch im MCP-Kontext angewendet (§9)

Unbekannte oder fehlende Tokens werden mit
`401 UNAUTHORIZED` abgelehnt.

---

### 6.4 Public Endpunkte (kein Auth)

Folgende Basis-Endpunkte sind bewusst von der Bearer-Auth ausgenommen:

```text
GET /health         Liveness — für Docker- und Proxy-Probes
GET /ready          Readiness — für Edge/Monitoring
GET /openapi.json   Spec-Discovery für ChatGPT Actions u. a.
```

Zusätzlich sind die OAuth-Discovery-, Authorize-, Login-, Token-,
Registrierungs- und JWKS-Routen aus §6.6 öffentlich. Sie besitzen eigene
Validierungs-, PKCE- und Rate-Limit-Grenzen. Alle `/tools/*`- und
`/mcp`-Routen bleiben Bearer-gesichert.

### 6.5 Token-Rotation und Revocation

Tokens und Upstream-API-Keys leben in `.env` auf dem
Deploymenthost. Es gibt zwei Operationspfade — einen für
geplante Rotation, einen für den Incident-Response-Fall
„Token geleakt".

#### 6.5.1 Geplante Rotation

```bash
# .env bearbeiten (neuen STELLARA_TOKEN_<USERID> Wert setzen)
docker compose up -d
```

`docker compose up -d` ersetzt den Container. Es entsteht
ein kurzer Health-Flap (Container-Stop bis `start_period`
+ erster erfolgreicher Healthcheck), in dem der Edge/Reverse Proxy 502 liefern
kann. Alte Tokens sind nach dem Wechsel sofort ungültig.

#### 6.5.2 Sofort-Revocation eines geleakten Tokens

Wenn ein Token kompromittiert ist und ein vollständiger
Container-Restart vermieden oder verzögert werden soll,
kann der Token-Wert in `STELLARA_REVOKED_TOKENS`
eingetragen werden (komma-separierte Liste der rohen
Token-Werte):

```env
STELLARA_REVOKED_TOKENS=<geleakter-token-1>,<geleakter-token-2>
```

Das Gateway prüft die Revocation-Liste vor dem regulären
Token-Lookup und antwortet mit `401 UNAUTHORIZED` — exakt
wie bei einem unbekannten Token, sodass ein Angreifer den
Unterschied nicht messen kann. Der Eintrag wird beim
Container-Start eingelesen; ein Reload ohne Restart ist
bewusst nicht vorgesehen, weil die Quelle der Wahrheit
weiterhin `.env` bleibt.

Ablauf für den Incident:

1. `STELLARA_REVOKED_TOKENS` um den geleakten Wert
   ergänzen.
2. `docker compose up -d` — der neue Container startet
   mit aktiver Revocation.
3. Im nächsten Wartungsfenster den betroffenen
   `STELLARA_TOKEN_<USERID>` neu erzeugen
   (`openssl rand -hex 48`) und den Revocation-Eintrag
   wieder entfernen.

#### 6.5.3 Langfristig

Die in §6.5.3 erwähnte JWT-Direction wurde mit §6.6
umgesetzt: kurzlebige Access-Tokens plus rotierender
Refresh-Token sind seit Plan 0004 verfügbar. Die
statische Revocation-Liste bleibt für direkt mit
`STELLARA_TOKEN_<USERID>` authentisierte Aufrufe
weiterhin nutzbar und wird beim Boot automatisch auf
verwaiste OAuth-Sessions angewendet.

---

### 6.6 OAuth-2.1-Authorization-Server (MCP-Discovery)

Neben der statischen `STELLARA_TOKEN_<USERID>`-Auth (§6.1) betreibt Stellara
einen OAuth-2.1-Authorization-Server für den geschützten MCP-Resource-Identifier
`${PUBLIC_BASE_URL}/mcp`. GUI-MCP-Clients finden die Endpunkte über das
Standard-Discovery-Protokoll und führen einen PKCE-Flow durch. Als
Clientregistrierung unterstützt Stellara sowohl Dynamic Client Registration
(DCR) als auch Client-ID Metadata Documents (CIMD).

Endpoints (alle ohne Bearer, hidden in OpenAPI):

```text
GET  /.well-known/oauth-authorization-server   RFC 8414 Discovery
GET  /.well-known/oauth-protected-resource     RFC 9728 Root-Alias
GET  /.well-known/oauth-protected-resource/mcp RFC 9728 MCP Resource Hint
POST /oauth/register                           Dynamic Client Registration (RFC 7591)
GET  /oauth/authorize                          Browser-Login + Code-Issuance
POST /oauth/login                              Token-Submit aus Login-Form
POST /oauth/token                              authorization_code + refresh_token grant
GET  /oauth/jwks                               Public-Key-Set für JWT-Verify
```

Token-Modell:

- **Access-Token** — RS256-signiertes JWT mit
  Claims `iss=publicBaseUrl`,
  `aud=publicBaseUrl/mcp`, `sub=userId`,
  `exp=iat+3600s`, `client_id`, `scope=mcp`, `jti`.
- **Refresh-Token** — opaker 32-byte-Hex-Wert in
  SQLite. Single-use mit Rotation pro OAuth-2.1
  §6.3; Replay (erneute Vorlage eines bereits
  rotierten Tokens) invalidiert die gesamte Kette
  für das `(userId, clientId)`-Tupel.

Persistenz: SQLite-Datei `stellara.db` im `STELLARA_DATA_DIR`-Volume (Default
`/data`, `:memory:` in Tests). Fünf fachliche Tabellen speichern Clients,
Codes, Refresh-Tokens, Sessions und Schlüssel; `oauth_meta` hält zusätzlich
Schema- und Cutover-Metadaten. Der beim ersten Upgrade-Start atomar angelegte
Wert `oauth_resource_required_since` trennt alte DCR-Clients von neuen
Registrierungen. Nur opake DCR-Clients mit `created_at` vor diesem Zeitpunkt
dürfen den `resource`-Parameter vorübergehend weglassen; Stellara bindet sie
dann auf `${PUBLIC_BASE_URL}/mcp` und protokolliert
`oauth_resource_legacy_default`. Neuere DCR- und alle CIMD-Clients müssen den
exakten Resource-Identifier bei Authorization, Code-Austausch und Refresh
senden. Ein abweichender Wert wird immer abgelehnt.

Session-Cookie: `stellara_session`, HttpOnly,
SameSite=Lax, `Path=/oauth/`, Secure in production.
Das Cookie ist opaker 64-char-Hex-Wert; die userId
steckt nur im SQLite-Lookup-Result, nicht im
Cookie selbst.

Login-Mechanismus: Das `STELLARA_TOKEN_<USERID>`
dient sowohl als direkter API-Bearer (§6.1) als auch
als Login-Credential im OAuth-Browser-Flow. Der User
tippt seinen Token-Wert in das Login-Form auf
`/oauth/authorize`; ein erfolgreicher Match setzt das
Session-Cookie und führt die Code-Issuance durch.
Das Form selbst echot den Token-Wert nicht zurück;
bei Mismatch muss er erneut eingetippt werden.

Backward-Compat zu §6.1: Beide Bearer-Formate werden
vom Auth-Hook akzeptiert. Eine Format-Heuristik
(genau zwei Punkte → JWT, sonst Static-Token)
entscheidet, welcher Pfad läuft. Eine JWT-Format-
Eingabe, die die Verifikation nicht besteht, wird
mit 401 abgewiesen — kein Fallback auf die
Token-Map, damit ein Angreifer keine Format-
Confusion ausnutzen kann. Bei Rotation eines
`STELLARA_TOKEN_<USERID>` werden beim nächsten Boot
alle Refresh-Tokens und Sessions dieses Users
invalidiert.

DCR-Sicherheit: `/oauth/register` ist offen
(public clients per OAuth 2.1), aber mit einem
Per-IP-Rate-Limit (Default 5/h, konfigurierbar via
`STELLARA_OAUTH_DCR_RATE_LIMIT_PER_HOUR`). Redirect-
URIs müssen HTTPS sein, mit Ausnahme von
`http://localhost`/`http://127.0.0.1`/`http://[::1]`
für native Clients (z. B. Claude Desktop).
Stale-Client-Sweep: Clients, die >90 Tage nicht
benutzt wurden, können per
`OAuthStorage.sweepStaleClients(cutoff)` aufgeräumt
werden (im v1 noch nicht automatisch verdrahtet).

CIMD-Sicherheit: Eine HTTPS-URL als `client_id` wird als Metadatendokument
behandelt; sie benötigt einen expliziten Dokumentpfad, darf weder Userinfo noch
Fragment enthalten und muss sich im JSON-Dokument lexikalisch exakt selbst
binden. Stellara erlaubt höchstens drei Redirects innerhalb der ursprünglichen
Origin. Jeder Hop wird erneut geprüft; DNS-Auflösung und tatsächlich
verbundener Socket müssen auf dieselbe öffentliche Adresse zeigen. Private,
Loopback-, Link-local-, Multicast- und andere nicht öffentliche Ziele sind
gesperrt. Pro Fetch gelten 5 Sekunden Timeout, 64 KiB Antwortlimit und ein
JSON-Content-Type.

Positive CIMD-Antworten werden gemäß `Cache-Control` oder `Expires`, höchstens
eine Stunde und standardmäßig fünf Minuten gecacht; negative Ergebnisse etwa
30 Sekunden. Positive und negative Einträge teilen einen LRU-Cache mit
standardmäßig 512 Einträgen. Je Quell-IP sind standardmäßig zehn echte
Cache-Misses pro Minute und pro Prozess höchstens 16 parallele Fetches erlaubt.
Es gibt keine Warteschlange: Der IP-Bucket antwortet lokal mit HTTP 429 und
`Retry-After`, das Prozesslimit lokal mit HTTP 503 und
`temporarily_unavailable`. Solange Client und Redirect-URI nicht autoritativ
verifiziert sind, wird kein Fehler an die angegebene Redirect-URI weitergeleitet.

Authorize und Login lösen CIMD asynchron auf und validieren Client,
Redirect-URI, Scope, PKCE und Resource nach dem Formular-POST erneut. Die
Login-Seite zeigt den verifizierten Clientnamen und Redirect-Host; bei
localhost warnt sie sichtbar. Authorization Codes binden Client und Redirect,
sodass Code-Austausch und Refresh keine weitere CIMD-Netzwerkabfrage auslösen.
Erfolgreiche und sicher redirectbare Authorization-Antworten enthalten
`iss=${PUBLIC_BASE_URL}`. Unbekannte Clients oder nicht registrierte
Redirect-URIs bleiben als lokale Fehler auf Stellara.

Audit-Logging: OAuth-relevante Vorgänge erzeugen strukturierte Pino-Logs mit
einem Event-Namen. Dazu gehören `oauth_client_registered`,
`oauth_code_issued`, `oauth_login_succeeded`, `oauth_login_failed`,
`oauth_token_issued`, `oauth_token_refreshed`,
`oauth_refresh_replay_detected` und `oauth_resource_legacy_default`.
Clientbezug wird als `clientIdHash` protokolliert, nicht als rohe Client-ID;
weitere Felder wie `userId`, `ip`, `grant`, `redirectUriCount` oder
`chainDeleted` erscheinen nur an der jeweils zuständigen Log-Stelle. Token-Werte
(Static, JWT, Refresh oder Auth-Code) erscheinen **nie** im Log.

Konfiguration über `STELLARA_OAUTH_*`-Env-Vars
(§12).

---

## 7. Sicherheit

Nur das Gateway ist öffentlich erreichbar:

```text
Internet
   |
   v
Edge/Reverse Proxy (nicht Teil dieses Konzepts)
   |
   v
Node Gateway
```

Nicht öffentlich erreichbar (bzw. nicht direkt durch Clients):

```text
Firecrawl Endpoint / API Key
Exa API Key
Qdrant Endpoint / API Key
Embedding-Provider API Key
interne Admin-Ports
```

Alle Credentials für externe Dienste leben ausschließlich im Gateway.
Clients sehen davon nie etwas — sie sprechen nur das Gateway.

### 7.1 Client-IP & Trust-Chain

Die Kette ist:

```text
Client → Edge/Reverse Proxy → Gateway
```

Der Edge/Reverse Proxy setzt die vereinbarten Forwarding-Header. Das Gateway:

- vertraut `X-Forwarded-For` und optional weiteren vereinbarten Forwarding-Headern nur, wenn der
  direkte Peer (TCP-Source-IP) in `TRUSTED_PROXY_CIDRS` liegt
- nutzt den Wert für Logging (`clientIp`) und als Fallback-Key
  für Rate-Limiting bei unauthentifizierten 401-Versuchen
- ignoriert beliebige `X-Forwarded-For`-Header von extern

`trustProxy` in Fastify ist entsprechend konfiguriert
(explizit vertrauenswürdige direkte Proxy-Peers oder CIDRs).

### 7.2 Body-Size-Limits

Fastify `bodyLimit`:

```text
default:                  1 MB
/tools/memory/upsert:     256 KB pro Eintrag
/tools/scrape Antwort:    intern bis 4 MB Markdown, danach Truncation
```

Überschreitung → `413 PAYLOAD_TOO_LARGE` (§16.2) mit
Hinweis im `details`-Feld.

---

## 8. Tool-Design

Alle Endpunkte sind `POST` mit `Content-Type: application/json`,
Antworten sind JSON. Felder mit `?` sind optional.
Defaults und Limits sind Empfehlungen — die finale Validierung
erfolgt über Zod-Schemata im Code.

### 8.1 `/tools/search` — Exa-Websuche

Request:

```jsonc
{
  "query": "string",
  "maxResults": 5,        // ?, default 5, max 25
  "type": "auto"          // ?, "auto" | "neural" | "keyword"
}
```

Response:

```jsonc
{
  "results": [
    {
      "title": "string",
      "url": "string",
      "snippet": "string",
      "score": 0.87,
      "publishedAt": "2025-01-01T00:00:00Z"  // ? wenn von Exa geliefert
    }
  ]
}
```

### 8.2 `/tools/scrape` — Einzelne URL via Firecrawl

Request:

```jsonc
{
  "url": "string",
  "formats": ["markdown"],   // ?, default ["markdown"], erlaubt "markdown" | "html"
  "onlyMainContent": true    // ?, default true
}
```

Response:

```jsonc
{
  "url": "string",
  "title": "string",
  "markdown": "string",
  "html": "string",          // nur wenn in formats angefragt
  "metadata": { }
}
```

### 8.3 `/tools/crawl` — Mehrere Seiten via Firecrawl

Request:

```jsonc
{
  "url": "string",
  "maxDepth": 2,             // ?, default 2
  "maxPages": 20,            // ?, default 20, max 100
  "includePatterns": [],     // ?
  "excludePatterns": []      // ?
}
```

Response:

```jsonc
{
  "status": "completed",      // oder "in_progress" (Soft-Cap, siehe Plan 0005)
  "jobId": "string",          // Firecrawl-Job-ID, auch im in_progress-Fall
  "pages": [ /* Items wie 8.2 Response */ ],
  "stats": { "pagesScraped": 12, "durationMs": 18432 }
}
```

`/tools/crawl` ruft Firecrawls async `/v1/crawl` und pollt intern bis zum
Soft-Cap (55 s). Bei `status: "in_progress"` läuft der Job noch — der Caller
kann via `/tools/crawl/status` (§8.16) mit `jobId` weiterpollen oder den Job
über `/tools/crawl/start` (§8.15) explizit asynchron starten.

### 8.4 `/tools/research` — Exa + Firecrawl kombiniert

Request:

```jsonc
{
  "query": "string",
  "maxSources": 5,           // ?, default 5, max 10
  "timeBudgetMs": 45000      // ?, default 45000
}
```

Response:

```jsonc
{
  "query": "string",
  "sources": [
    {
      "url": "string",
      "title": "string",
      "snippet": "string",
      "content": "string"    // Markdown des gescrapeten Inhalts, falls erfolgreich
    }
  ]
}
```

### 8.5 `/tools/memory/upsert`

Request:

```jsonc
{
  "id": "string",            // ?, sonst generiert das Gateway eine UUID v4
  "text": "string",
  "source": "string",        // ?, z. B. URL oder Notiz-Quelle
  "tags": [],                // ?
  "metadata": { }            // ?, frei strukturierbar
}
```

Response:

```jsonc
{
  "id": "string",
  "status": "upserted"
}
```

Das Gateway erzeugt das Embedding über den konfigurierten Provider
und schreibt Vektor + Payload (`userId`, `text`, `source`, `tags`,
`metadata`, `createdAt`) in die Collection.

**Semantik bei vorhandener `id`:** vollständiger Replace. Der
existierende Eintrag wird durch den neuen ersetzt (Vektor, Text,
`source`, `tags`, `metadata` neu, `createdAt` bleibt der Originalwert,
`updatedAt` wird gesetzt). Es gibt keinen Merge-Modus.

### 8.6 `/tools/memory/search`

Request:

```jsonc
{
  "query": "string",
  "topK": 5,                 // ?, default 5, max 50
  "minScore": 0,             // ?, default 0
  "filter": {                // ?
    "tags": [],
    "source": "string"
  }
}
```

Response:

```jsonc
{
  "results": [
    {
      "id": "string",
      "score": 0.84,
      "text": "string",
      "source": "string",
      "tags": [],
      "metadata": { },
      "createdAt": "2025-01-01T00:00:00Z",
      "updatedAt": "2025-01-02T00:00:00Z"
    }
  ]
}
```

### 8.7 `/tools/memory/list` — Auflisten ohne Query

Listet die eigenen Memory-Einträge mit Cursor-Pagination.
Sortiert absteigend nach `updatedAt` (Fallback `createdAt`).

Request:

```jsonc
{
  "filter": {                // ?, gleiche Felder wie 8.6
    "tags": [],
    "source": "string"
  },
  "limit": 50,               // ?, default 50, max 200
  "cursor": "string"         // ?, aus vorheriger Response
}
```

Response:

```jsonc
{
  "items": [ /* Items wie 8.6 results, ohne score */ ],
  "nextCursor": "string"     // null, wenn keine weiteren Seiten
}
```

### 8.8 `/tools/memory/delete`

Request: entweder `id` ODER `filter`, nie beides.

```jsonc
{
  "id": "string",            // entweder ...
  "filter": {                // ... oder
    "tags": [],
    "source": "string"
  }
}
```

Response:

```jsonc
{
  "deleted": 3
}
```

### 8.9 Per-User-Isolation des Memory-Speichers

Eine gemeinsame Qdrant-Collection `stellara-memory`, aber
jeder Eintrag bekommt zusätzlich die `userId` aus §6.3 in den
Payload:

```jsonc
{
  "userId": "user_a",
  "text": "...",
  "source": "...",
  "tags": [],
  "metadata": { },
  "createdAt": "2025-01-01T00:00:00Z",
  "updatedAt": "2025-01-02T00:00:00Z"
}
```

Alle Memory-Endpunkte hängen serverseitig einen Filter
`userId = <Caller>` an Read-, Update- und Delete-Operationen.
User sehen, ändern und löschen ausschließlich ihre eigenen Einträge.

**ID-Schichten:** Es gibt zwei UUIDs pro Memory-Eintrag,
die nicht verwechselt werden sollten:

- **Caller-ID** (`id` in §8.5/8.6/8.7): UUID v4, vom Caller
  übergeben oder vom Gateway generiert. Nur im User-Scope
  eindeutig. Wird in API-Responses verwendet.
- **Qdrant-Point-ID**: intern, deterministisch aus
  `uuidv5(namespace=userId, name=caller-id)` abgeleitet,
  damit zwei User dieselbe logische `id` verwenden können
  ohne Kollision im physischen Qdrant-Store. Wird nie
  nach außen gegeben.

---

### 8.10 `/tools/map` — Sitemap-Discovery via Firecrawl

Discovery-Tool, das vor einem gezielten Crawl die URL-Liste
einer Website ermittelt. Wrapt Firecrawls `/v1/map`.

Request:

```jsonc
{
  "url": "string",
  "search": "string",     // ?, Suchfilter
  "maxUrls": 500          // ?, default 500, max 5000
}
```

Response:

```jsonc
{
  "urls": ["string", "..."]
}
```

---

### 8.11 `/tools/extract` — Strukturierte Extraktion via Firecrawl

LLM-getriebene Extraktion mit Prompt und/oder JSON-Schema.
Wrapt Firecrawls `/v1/extract`. Mindestens eines von `prompt`
oder `schema` ist erforderlich (Zod-`refine`).

Request:

```jsonc
{
  "urls": ["string", "..."],         // 1–20 URLs
  "prompt": "string",                // ?
  "schema": { /* JSON-Schema */ },   // ?
  "systemPrompt": "string"           // ?
}
```

Response:

```jsonc
{
  "data": { /* caller- oder LLM-bestimmte Struktur */ },
  "status": "completed" | "failed" | "in_progress"
}
```

---

### 8.12 – 8.14 ehemals Firecrawl-Interact-Tools

Die Sektionen `8.12 /tools/session/start`, `8.13 /tools/interact` und
`8.14 /tools/interact/stop` wurden in Plan 0008 ersatzlos entfernt.
Die Lücke in der Nummerierung bleibt bewusst bestehen, weil ein
Renumerieren downstream-Verweise auf §8.15/§8.16 brechen würde.

Der Ersatz auf Playwright-Basis ist die `browser_*`-Tool-Familie in
§8.19-§8.24 (Kern-Tools, Plan 0009); die Comprehensive-Erweiterung
folgt in §8.25-§8.30 (Plan 0010).

---

### 8.15 `/tools/crawl/start` — Async-Crawl starten

Identische Request-Shape wie §8.3, liefert aber sofort
nur die Firecrawl-Job-ID zurück. Caller pollt §8.16.

Response:

```jsonc
{ "jobId": "string" }
```

---

### 8.16 `/tools/crawl/status` — Async-Crawl-Status pollen

Request:

```jsonc
{ "jobId": "string" }
```

Response:

```jsonc
{
  "status": "scraping" | "completed" | "failed" | "cancelled",
  "completed": 12,
  "total": 50,
  "pages": [ /* Items wie 8.2 Response */ ]
}
```

---

### 8.17 `/tools/fetch` — Leichtgewichtiger HTTP-Fetch

Generischer HTTP-Aufruf gegen einen öffentlichen Endpoint. Ergänzt
die Firecrawl-Tools (§8.2/§8.3) um den Fall, in dem JS-Rendering und
Markdown-Konvertierung zu schwergewichtig oder im Antwortformat
ungeeignet sind — typischerweise REST/JSON-APIs und einfache
Text-Endpoints. Authentifizierte Aufrufe via `Authorization`-Header
sind ausdrücklich vorgesehen.

Sicherheit:

- `url` wird durch `safeExternalUrl` validiert (§17, dieselbe
  SSRF-Liste wie Firecrawl-Tools). Auch jeder Redirect-Hop wird
  geprüft.
- Hop-by-Hop-Headers (`Host`, `Connection`, `Transfer-Encoding`,
  `Content-Length`, `Keep-Alive`, `TE`, `Upgrade`, `Proxy-*`) sowie
  `Cookie` werden vom Caller-Header-Bag entfernt. Geblockte Einträge
  werden im Result-Feld `droppedRequestHeaders` gemeldet.
- Response-Headers werden auf die Whitelist `Content-Type`,
  `Content-Length`, `ETag`, `Last-Modified`, `Cache-Control`,
  `Location`, `Retry-After` reduziert. `Set-Cookie` wird nie
  durchgereicht.
- Body-Cap 10 MB (Streaming-Read mit harter Grenze). Bei `json`
  führt Truncation zu `400 BAD_REQUEST` mit
  `details.reason: "response_truncated_json"`. Bei `auto` wird auf
  `format: "text"` heruntergestuft, das Flag `truncated: true` zeigt
  die Kürzung. Bei `text`/`binary` bleibt `truncated: true` der
  einzige Hinweis.
- HTTP-Status 4xx/5xx werden 1:1 im Result zurückgegeben — der Sinn
  eines Fetch-Tools ist, den Server-Status zu sehen. Nur Netzwerk-
  und Abort-Fehler werden zu `UPSTREAM_ERROR` bzw. `TIMEOUT`.

Request:

```jsonc
{
  "url": "string",
  "method": "GET",              // ?, default "GET", erlaubt GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS
  "headers": { },               // ?, Caller-Headers (vor Sanitization)
  "body": {                     // ?, nur für nicht-GET/HEAD/OPTIONS
    "type": "json",             // "json" | "text" | "form" | "base64"
    "value": { /* … */ }
  },
  "responseFormat": "auto",     // ?, default "auto", erlaubt "auto"|"json"|"text"|"binary"
  "followRedirects": true,      // ?, default true
  "maxRedirects": 5             // ?, default 5, max 10
}
```

Response:

```jsonc
{
  "status": 200,
  "statusText": "OK",
  "headers": { /* Whitelist-Subset, lowercased */ },
  "format": "json",             // tatsächlich gelieferte Form
  "body": { /* unknown — String bei text/binary, Wert bei json */ },
  "url": "string",              // finale URL nach Redirects
  "truncated": false,
  "droppedRequestHeaders": ["host", "cookie"]
}
```

---

### 8.18 `/tools/graphql` — GraphQL-Aufruf

Spezialisiertes Tool für GraphQL-Endpoints. Baut intern den
kanonischen Body `{ query, variables, operationName }` zusammen,
setzt `Content-Type: application/json` und ruft den
gleichen Service-Layer wie §8.17 auf. SSRF-Guard, Header- und
Body-Policies sind identisch.

Errors-im-200-Body (GraphQL-Standard) werden 1:1 im Result-Feld
`errors` durchgereicht — kein Throw. Antwortet der Endpoint mit
non-JSON (z. B. eine HTML-Fehlerseite vom API-Gateway), wird
`errors: [{ message: "endpoint did not return JSON", status }]`
synthetisiert, damit der Caller einen einheitlichen Fehlerpfad
sieht.

Request:

```jsonc
{
  "endpoint": "string",
  "query": "string",
  "variables": { /* … */ },     // ?
  "operationName": "string",    // ?
  "headers": { }                // ?
}
```

Response:

```jsonc
{
  "status": 200,
  "data": { /* … */ },          // ?
  "errors": [ /* … */ ],        // ?
  "extensions": { /* … */ }     // ?
}
```

---

### 8.19 `/tools/browser/session/start` — Playwright-Session öffnen

Öffnet eine neue Playwright-Browser-Session und navigiert die initiale Page
zur angegebenen URL. Liefert eine vom Gateway erzeugte `sessionId` (ULID)
zurück, die an §8.20-§8.24 weitergegeben wird. Pool-Limit per
`STELLARA_PLAYWRIGHT_MAX_SESSIONS` und `STELLARA_PLAYWRIGHT_MAX_SESSIONS_PER_USER`
(siehe §12); Überschreitung liefert `429 RATE_LIMITED` mit
`details.reason: "global_session_limit"` bzw. `"user_session_limit"`.

Sessions räumen sich nach 5 Minuten Inaktivität auf, spätestens nach
30 Minuten Hard-Lifetime. Beide Werte sind im Code fixiert
(`src/services/playwright-config.ts`).

Request:

```jsonc
{
  "url": "string"
}
```

Response:

```jsonc
{
  "sessionId": "string",   // ULID
  "url": "string",
  "title": "string"        // ?
}
```

---

### 8.20 `/tools/browser/session/stop` — Playwright-Session schließen

Schließt die angegebene Session des aufrufenden Users. Fremde oder unbekannte
`sessionId`s werden mit `404 NOT_FOUND` quittiert (kein User-Enumeration).

Request:

```jsonc
{ "sessionId": "string" }
```

Response:

```jsonc
{ "stopped": true }
```

---

### 8.21 `/tools/browser/navigate` — neue URL in bestehender Session

Navigiert die aktive Page einer Session auf eine neue URL. SSRF-Guard
(`safeExternalUrl`) gilt analog zu §8.2.

Request:

```jsonc
{
  "sessionId": "string",
  "url": "string"
}
```

Response:

```jsonc
{
  "url": "string",
  "title": "string"        // ?
}
```

---

### 8.22 `/tools/browser/interact` — Action-Chain in Playwright-Session

Sendet eine geordnete Action-Kette gegen die aktive Page. Action-Vokabular
ist eine `z.discriminatedUnion` über `click`, `type`, `fill`, `wait`,
`wait_for_selector`, `scroll`, `hover`, `press`, `select` (siehe
`src/schemas/browser.ts`). Pro Action liefert die Response einen
strukturierten Result-Eintrag; nach dem ersten `failed`-Schritt bricht die
Kette ab.

Request:

```jsonc
{
  "sessionId": "string",
  "actions": [
    { "type": "click", "selector": "button.submit", "timeout": 5000 },
    { "type": "fill", "selector": "input[name=q]", "text": "stellara" },
    { "type": "wait", "durationMs": 200 }
  ]
}
```

Response:

```jsonc
{
  "results": [
    { "type": "click", "status": "completed" },
    { "type": "fill", "status": "completed" },
    { "type": "wait", "status": "completed" }
  ]
}
```

---

### 8.23 `/tools/browser/screenshot` — PNG-Screenshot

Liefert einen PNG-Screenshot der aktiven Page oder eines Selektors als
Base64-String. Output-Cap 10 MB (siehe `PLAYWRIGHT_OUTPUT_LIMIT_BYTES`);
darüber 502 `UPSTREAM_ERROR` mit `details.reason: "output_too_large"`.

Request:

```jsonc
{
  "sessionId": "string",
  "selector": "string",     // ? ohne: ganze Page/Viewport
  "fullPage": false         // ?, default false
}
```

Response:

```jsonc
{
  "data": "iVBORw0KGgo...",
  "mimeType": "image/png"
}
```

---

### 8.24 `/tools/browser/content` — DOM auslesen

Liefert das aktuelle DOM der aktiven Page als HTML oder als extrahierten
Plain-Text. 10 MB Output-Cap analog §8.23.

Request:

```jsonc
{
  "sessionId": "string",
  "format": "html"          // ?, "html" | "text", default "html"
}
```

Response:

```jsonc
{
  "url": "string",
  "title": "string",        // ?
  "content": "string",
  "format": "html"          // tatsächlich geliefertes Format
}
```

---

### 8.25 `/tools/browser/eval` — JS im Page-Context auswerten

Plan 0010. Führt eine vom Caller gelieferte JavaScript-Expression im V8
des aktiven Tabs aus und gibt das Ergebnis JSON-serialisiert zurück.
Non-serialisierbare Returns (Funktionen, `undefined`, DOM-Knoten,
`BigInt`) werden via JSON-Replacer auf `"[non-serializable]"` (bzw.
String für BigInt) abgebildet. Output-Cap 1 MB JSON, Hard-Timeout 30 s.

Sicherheitsmodell: kein zusätzlicher Sandbox für den Caller — wer den
Bearer-Token besitzt, hat ohnehin volle Browser-Kontrolle. Die Limits
sind die einzigen Guardrails.

Request:

```jsonc
{
  "sessionId": "string",
  "expression": "document.querySelectorAll('h2').length"
}
```

Response:

```jsonc
{ "result": 12 }
```

---

### 8.26 `/tools/browser/pdf` — PDF-Render der Page

Rendert die aktive Page als PDF (`printBackground: true`) und gibt die
Bytes Base64-kodiert zurück. 10 MB Output-Cap, Hard-Timeout 60 s.
Chromium-Standard-Format ist `A4`; alternativ `Letter` oder `Legal`.

Request:

```jsonc
{
  "sessionId": "string",
  "format": "A4",          // ?, default "A4"
  "landscape": false,      // ?, default false
  "scale": 1               // ?, 0.1-2, default 1
}
```

Response:

```jsonc
{
  "data": "JVBERi0xL...",
  "mimeType": "application/pdf"
}
```

---

### 8.27 `/tools/browser/cookies` — Cookie-Verwaltung

Plan 0010. Discriminated Union über `mode: get|set|clear`. Cookies sind
Context-scope, gelten also über alle Tabs der Session.

Request — `get`:

```jsonc
{
  "sessionId": "string",
  "mode": "get",
  "urls": ["https://example.com/path"] // ?, optionaler URL-Filter
}
```

Request — `set`:

```jsonc
{
  "sessionId": "string",
  "mode": "set",
  "cookies": [
    { "name": "sid", "value": "abc", "domain": "example.com", "path": "/" }
  ]
}
```

Request — `clear`:

```jsonc
{ "sessionId": "string", "mode": "clear" }
```

Response:

```jsonc
{
  "mode": "get",            // gespiegelter Modus
  "cookies": [ /* nur bei mode=get */ ]
}
```

---

### 8.28 `/tools/browser/storage` — Web-Storage-Verwaltung

Plan 0010. Discriminated Union über `mode: get|set|clear` plus
`target: local|session` (entspricht `localStorage` und `sessionStorage`).
Get ohne `keys` liefert den gesamten Inhalt.

Request — `get`:

```jsonc
{
  "sessionId": "string",
  "mode": "get",
  "target": "local",        // ?, default "local"
  "keys": ["session-id"]    // ?, ohne: alle Keys
}
```

Request — `set`:

```jsonc
{
  "sessionId": "string",
  "mode": "set",
  "target": "session",
  "entries": { "draft": "..." }
}
```

Response:

```jsonc
{
  "mode": "get",
  "target": "local",
  "entries": { "session-id": "..." }  // nur bei mode=get
}
```

---

### 8.29 `/tools/browser/har` — HAR-Recording

Plan 0010. Discriminated Union über `mode: start|stop`. Stellara
schreibt ein minimales HAR-1.2-Envelope (Status, Headers, Body-Preview,
zero/empty Cookies/Timings statt erfundener Werte).

**Datenschutz-Hinweis:** Captured Request-Header enthalten
`Authorization`- und `Cookie`-Werte 1:1. Stellara filtert sie bewusst
nicht — der Caller weiß, wozu er das HAR braucht. Wer das HAR weitergibt,
trägt die Verantwortung für den Inhalt. Stop bei nicht aktiver
Aufzeichnung liefert `BAD_REQUEST` mit `details.reason: "no_har_recording"`,
Start bei bereits aktiver Aufzeichnung analog mit
`"har_already_recording"`.

Request:

```jsonc
{ "sessionId": "string", "mode": "start" }
```

Response — `start`:

```jsonc
{ "mode": "start" }
```

Response — `stop`:

```jsonc
{
  "mode": "stop",
  "har": { /* HAR 1.2 envelope */ }
}
```

---

### 8.30 `/tools/browser/tabs` — Multi-Tab-Verwaltung

Plan 0010. Discriminated Union über `mode: list|switch|close|new`.
Maximal fünf Tabs pro Session; das Schließen des letzten Tabs ist
verboten (`cannot_close_last_tab`) — dafür gibt es §8.20
(`session_stop`).

Request — `list`:

```jsonc
{ "sessionId": "string", "mode": "list" }
```

Request — `switch` / `close`:

```jsonc
{ "sessionId": "string", "mode": "switch", "index": 1 }
```

Request — `new`:

```jsonc
{
  "sessionId": "string",
  "mode": "new",
  "url": "https://example.com" // ?, optional initial navigation
}
```

Response (für alle Modi):

```jsonc
{
  "mode": "list",
  "activeIndex": 1,
  "tabs": [
    { "index": 0, "url": "https://example.com/", "title": "Home" },
    { "index": 1, "url": "https://example.com/login", "title": "Login" }
  ]
}
```

---

### 8.31 `/tools/get` — Read-only-HTTP-Fetch

Plan 0014. Read-only-Geschwister von §8.17 (`web_fetch`). Beschränkt
`method` auf die HTTP-„safe methods“ `GET`, `HEAD` und `OPTIONS` und
kennt **kein** `body`-Feld — safe methods tragen keine Nutzlast. Das
Schema ist `.strict()`: ein versehentlich mitgesendeter `body` (oder ein
anderer unbekannter Schlüssel) wird mit einem Validierungsfehler (422)
abgelehnt statt still verworfen. Dadurch schließt das Schema
Schreibzugriffe strukturell aus, und das MCP-Tool darf ehrlich
`annotations.readOnlyHint: true` führen (MCP-Clients nutzen das für
Auto-Freigabe).

Der gesamte Sicherheitspfad ist identisch zu §8.17: `url` und jeder
Redirect-Hop laufen durch `safeExternalUrl` (SSRF, §17), Hop-by-Hop-
und `Cookie`-Header werden entfernt (Meldung via
`droppedRequestHeaders`), die Response-Header werden auf dieselbe
Whitelist reduziert, `Set-Cookie` wird nie durchgereicht und der
10-MB-Body-Cap greift unverändert. Die Response-Form ist exakt
`fetchResponseSchema` (§8.17).

Wer `POST`/`PUT`/`PATCH`/`DELETE` oder einen Request-Body braucht,
nutzt weiterhin `web_fetch` (§8.17).

> **Hinweis:** Die Read-only-Zusage ist HTTP-Standardsemantik, keine
> Server-Garantie. Ein Server kann auf ein `GET` (z. B. via
> `X-HTTP-Method-Override`) mutierend reagieren — `web_get` sendet
> ehrlich einen safe-method-Request, mehr kann das Gateway nicht
> zusichern.

Request:

```jsonc
{
  "url": "string",
  "method": "GET",              // ?, default "GET", erlaubt GET|HEAD|OPTIONS
  "headers": { },               // ?, Caller-Headers (vor Sanitization)
  "responseFormat": "auto",     // ?, default "auto", erlaubt "auto"|"json"|"text"|"binary"
  "followRedirects": true,      // ?, default true
  "maxRedirects": 5             // ?, default 5, max 10
}
```

Response: identisch zu §8.17 (`fetchResponseSchema`).

---

### 8.32 `/tools/graphql-query` — Read-only-GraphQL-Query

Plan 0014. Read-only-Geschwister von §8.18 (`web_graphql`). Der
`query`-String wird vor dem Aufruf mit dem offiziellen `graphql`-Parser
(nur `parse` + AST-Inspektion) eingelesen. Enthält das Dokument
**irgendeine** `mutation`- oder `subscription`-Operation, wird der
Aufruf mit `400 BAD_REQUEST` abgewiesen — schon eine einzige
Nicht-Query-Operation im Dokument genügt, damit die Read-only-Zusage
offensichtlich und vorhersehbar bleibt. Anonymer Shorthand (`{ field }`)
parst als `query` und ist erlaubt. Dadurch darf das MCP-Tool ehrlich
`annotations.readOnlyHint: true` führen.

Nach bestandenem Guard läuft exakt derselbe Pfad wie §8.18: kanonischer
Body `{ query, variables, operationName }`, `Content-Type:
application/json`, gemeinsamer Service-Layer (SSRF-, Header- und
Body-Policies identisch), `errors`-im-200-Body werden 1:1
durchgereicht. Die Response-Form ist exakt `graphqlResponseSchema`
(§8.18).

Für Mutationen/Subscriptions nutzt man weiterhin `web_graphql`
(§8.18).

> **Hinweis:** `web_graphql_query` parst lokal und lehnt unparsebare
> Queries mit `BAD_REQUEST` ab — bewusst strenger als `web_graphql`,
> das rohe Queries durchreicht und den Endpoint den Syntaxfehler melden
> lässt.

Request:

```jsonc
{
  "endpoint": "string",
  "query": "string",            // nur query-Operationen; Mutation/Subscription → 400
  "variables": { /* … */ },     // ?
  "operationName": "string",    // ?
  "headers": { }                // ?
}
```

Response: identisch zu §8.18 (`graphqlResponseSchema`).

---

## 9. MCP-Strategie

### Phase 1

HTTP + OpenAPI.

### Phase 2

Gateway ist MCP-Server über **Streamable HTTP** und priorisiert den modernen
Vertrag aus MCP `2026-07-28`:

```text
POST /mcp   JSON-RPC Request, vollständige Antwort als ein Body
GET  /mcp   405 Method Not Allowed in v1 (siehe Sessions unten)
```

- Auth wie bei den HTTP-Endpunkten: Bearer Token. Das gilt
  für `POST /mcp` und `GET /mcp` gleichermaßen.
- Die User-ID-Auflösung aus §6.3 gilt auch im MCP-Kontext
  und steuert insbesondere die Memory-Tool-Sichtbarkeit.
- Der SSE-Legacy-Transport (eigener `/sse`-Endpunkt) wird
  nicht implementiert.
- Moderne Requests tragen die Version und Client-Capabilities request-spezifisch
  in `_meta` sowie in den HTTP-Headern `MCP-Protocol-Version`, `Mcp-Method` und
  bei benannten Operationen `Mcp-Name`. Es gibt keinen `initialize`-Handshake.
  `server/discover` ist der Einstiegspunkt für die Servererkennung.
- Der moderne Protokollrand wird mit den öffentlichen High-Level-APIs von
  `@modelcontextprotocol/server` v2 und dem Node-Adapter
  `@modelcontextprotocol/node` umgesetzt. Der Handler läuft mit
  `responseMode: "json"` und `legacy: "reject"`; er stellt ausdrücklich keinen
  SDK-Legacy-SSE-Fallback bereit.
- Vor dem modernen Handler klassifiziert der öffentliche SDK-Helper
  `isLegacyRequest` echte Legacy-Aufrufe. Nur diese laufen durch Stellaras
  isolierten bisherigen JSON-Dispatcher. Unterstützt werden vorübergehend
  `2025-11-25`, `2025-06-18`, `2025-03-26` und `2024-11-05` mit
  `initialize`, `notifications/initialized`, `tools/list` und `tools/call`.
- Teilweise moderne oder widersprüchliche Requests fallen nicht auf Legacy
  zurück. Fehlende beziehungsweise widersprüchliche Header liefern `-32020`,
  eine unbekannte moderne Version `-32022` und fehlende Pflicht-Metadaten
  `-32602`.
- **Sessions: stateless.** Es wird kein `Mcp-Session-Id`
  ausgegeben oder erwartet. Jeder JSON-RPC-Request wird
  unabhängig anhand des Bearer-Tokens verarbeitet. Begründung:
  Tools-Only-Setup ohne Notifications, Progress-Events oder
  Resumable Streams (siehe Phase-2-Scope unten). Wechsel auf
  stateful Sessions ist eine bewusste Folgeentscheidung.
- Konsequenz: `GET /mcp` würde ohne Session keinen Inhalt
  haben und antwortet daher mit `405 Method Not Allowed`.
  Ein zukünftiger Wechsel auf stateful Sessions schaltet
  diesen Endpunkt frei.

**MCP-Capabilities in Phase 2:** ausschließlich `tools`.
`resources`, `prompts` und `sampling` werden bewusst
nicht angeboten und kommen frühestens in einer späteren
Iteration in Frage.

Die moderne Toolregistrierung verwendet für jedes Tool das kanonische Zod-
Input- und Outputschema aus `MCP_TOOLS`. `tools/list` bewirbt deshalb neben
`inputSchema` auch `outputSchema`; ein erfolgreicher Aufruf liefert weiterhin
`content` und ein gegen dieses Schema validiertes `structuredContent`. Bekannte
Argumentvalidierungs- und Ausführungsfehler sind im modernen Pfad
`CallToolResult`-Antworten mit `isError: true`. Methoden-, Unknown-Tool-,
Header- und Versionsfehler bleiben JSON-RPC-Fehler. Im Legacy-Pfad bleiben
Argumentfehler JSON-RPC-Fehler; erst Fehler nach erfolgreicher
Argumentvalidierung werden zu `isError: true`.

`server/discover` und `tools/list` liefern im modernen Pfad
`resultType: "complete"`, Servermetadaten sowie `cacheScope: "private"` und
`ttlMs: 300000`. Ein Client darf den eigenen Katalog damit fünf Minuten
wiederverwenden, aber nicht über Authkontexte hinweg teilen. Nach einer
Feature-Flag-Änderung kann ein zuvor gecachter Katalog bis zum TTL-Ablauf
sichtbar bleiben.

### LLM-Discoverability-Surface (Plan 0011)

Damit MCP-Clients und OpenAPI-Konsumenten die richtige
Tool-Auswahl treffen, liefert Stellara an drei Stellen
zusätzliche Tool-Selection-Guidance:

1. **Instructions** — moderne Clients erhalten die gemeinsame
   Markdown-Übersicht über `server/discover`; der isolierte Legacy-
   `initialize`-Handler liefert denselben Inhalt als
   `InitializeResult.instructions`.
2. **`tools/list[*].annotations`** — pro Tool sind die MCP-Hints
   `readOnlyHint`, `destructiveHint`, `idempotentHint`,
   `openWorldHint` und ein UI-`title` gesetzt. Spec-konform seit MCP
   2025-03-26. Annotations sind reine UI-Hilfsmittel — sie ersetzen
   keine Auth-/Rate-Limit-Enforcement.
3. **Tool-Descriptions** mit 2-4 Sätzen pro Tool, einschließlich
   moderater Cross-Refs („prefer `web_scrape` for static content"
   etc.). Wird über den gemeinsamen Helper `describeMcpTool(name)`
   identisch in die OpenAPI-Route-Schemas (§20) gespiegelt.

Die Konstante mit der Tool-Suite-Übersicht (`STELLARA_SUITE_OVERVIEW`
in `src/llm-instructions.ts`) ist Single Source of Truth für moderne
Discovery-Instructions, Legacy-`initialize.instructions` und OpenAPI-
`info.description`. Konvention für neue
Tools: jede MCP_TOOLS-Erweiterung pflegt zusätzlich ihre `description`,
`annotations` und — wo semantisch sinnvoll — `.describe()`-Strings auf
den Schema-Feldern.

**MCP-Tool-Namen** (Snake-Case mit Bereichs-Prefix):

```text
web_search          ← /tools/search
web_scrape          ← /tools/scrape
web_crawl           ← /tools/crawl
web_research        ← /tools/research
web_map             ← /tools/map
web_extract         ← /tools/extract
web_crawl_start     ← /tools/crawl/start
web_crawl_status    ← /tools/crawl/status
web_fetch           ← /tools/fetch
web_graphql         ← /tools/graphql
memory_upsert       ← /tools/memory/upsert
memory_search       ← /tools/memory/search
memory_list         ← /tools/memory/list
memory_delete       ← /tools/memory/delete
browser_session_start  ← /tools/browser/session/start  (Plan 0009)
browser_session_stop   ← /tools/browser/session/stop   (Plan 0009)
browser_navigate       ← /tools/browser/navigate       (Plan 0009)
browser_interact       ← /tools/browser/interact       (Plan 0009)
browser_screenshot     ← /tools/browser/screenshot     (Plan 0009)
browser_content        ← /tools/browser/content        (Plan 0009)
browser_eval           ← /tools/browser/eval           (Plan 0010)
browser_pdf            ← /tools/browser/pdf            (Plan 0010)
browser_cookies        ← /tools/browser/cookies        (Plan 0010)
browser_storage        ← /tools/browser/storage        (Plan 0010)
browser_har            ← /tools/browser/har            (Plan 0010)
browser_tabs           ← /tools/browser/tabs           (Plan 0010)
```

Die Input-Schemata jedes MCP-Tools entsprechen 1:1 den
Zod-Schemata der REST-Routen aus §8.

### Phase 3

Gateway wird zusätzlich MCP-Client.

---

## 10. Projektstruktur

```text
stellara/
  src/
    server.ts
    config.ts
    auth.ts
    logger.ts
    errors.ts            (Fehlerkatalog §16)
    rate-limit.ts

    routes/
      health.ts          (/health + /ready)
      openapi.ts
      search.ts
      scrape.ts
      crawl.ts
      research.ts
      memory.ts
      mcp.ts
      browser/           (Plan 0009 — sechs Playwright-Routen)

    services/
      exa.ts
      firecrawl.ts
      qdrant.ts
      embeddings.ts
      playwright.ts             (Plan 0009 — Session-Pool)
      playwright-config.ts      (Plan 0009 — TTL- und Limit-Konstanten)
      playwright-actions.ts     (Plan 0009 — Action-Dispatcher)
      playwright-helpers.ts     (Plan 0009/0010 — extrahierte Helpers)
      playwright-types.ts       (Plan 0010 — Options/Result-Types)
      playwright-har.ts         (Plan 0010 — HAR-1.2-Recorder)
      playwright-extensions.ts  (Plan 0010 — eval/pdf/cookies/storage/har/tabs)

    schemas/             (zentrale Zod-Schemata pro Tool)
      browser.ts                (Plan 0009 — `browser_*`-Tools)

    tools/
      browser.ts                (Plan 0009 — `runBrowser*`-Functions)

  scripts/
    migrate-embeddings.ts  (§25)

  tests/
    unit/
    integration/

  docker/
    Dockerfile

  docker-compose.yml
  .env.example
  package.json
  pnpm-lock.yaml
  tsconfig.json
  vitest.config.ts
```

---

## 11. Node.js Stack

Empfohlen:

```text
Node.js 24 LTS
TypeScript
Fastify
Zod
Pino
pnpm                   (Package Manager)
Vitest                 (Tests)
Docker
```

---

## 12. Environment

```env
NODE_ENV=production
PORT=8787

PUBLIC_BASE_URL=https://stellara.example.com

STELLARA_TOKEN_USER_A=
STELLARA_TOKEN_USER_B=
# weitere User: STELLARA_TOKEN_<USERID>=

# Bereits vorhandenes externes Docker-Netz zum Edge/Reverse Proxy
STELLARA_PROXY_NETWORK=proxy-network

# Direkte vertrauenswürdige Proxy-Peers oder CIDRs
TRUSTED_PROXY_CIDRS=127.0.0.1/8,::1/128

# Firecrawl (extern)
FIRECRAWL_BASE_URL=
FIRECRAWL_API_KEY=

# Exa (extern)
EXA_API_KEY=

# Qdrant (extern)
QDRANT_BASE_URL=
QDRANT_API_KEY=
QDRANT_COLLECTION=stellara-memory

# Embeddings (extern, für Qdrant)
EMBEDDINGS_PROVIDER=openai
EMBEDDINGS_MODEL=text-embedding-3-small
EMBEDDINGS_API_KEY=
EMBEDDINGS_DIMENSIONS=1536

LOG_LEVEL=info
# Globale Obergrenze, muss >= max per-Tool-Timeout (§17) sein
REQUEST_TIMEOUT_MS=90000

# Rate Limiting (pro Token)
RATE_LIMIT_MAX=60
RATE_LIMIT_WINDOW_MS=60000

# OAuth-Server (§6.6)
# Volume-Pfad für stellara.db (SQLite). Mit dem
# Compose-Volume `./stellara-data:/data` deckungsgleich.
STELLARA_DATA_DIR=/data
# Access-Token-Lebensdauer (Default 1 h).
STELLARA_OAUTH_ACCESS_TOKEN_TTL_SECONDS=3600
# Refresh-Token-Lebensdauer (Default 30 d).
STELLARA_OAUTH_REFRESH_TOKEN_TTL_SECONDS=2592000
# Browser-Session-Lebensdauer mit Sliding-Renewal
# (Default 12 h).
STELLARA_OAUTH_SESSION_TTL_SECONDS=43200
# Per-IP-Rate-Limit für /oauth/register (Default 5/h).
STELLARA_OAUTH_DCR_RATE_LIMIT_PER_HOUR=5
# Echte CIMD-Cache-Misses pro Quell-IP und Minute (Default 10).
STELLARA_OAUTH_CIMD_RATE_LIMIT_PER_MINUTE=10
# Maximale parallele CIMD-Netzwerkabrufe pro Prozess (Default 16).
STELLARA_OAUTH_CIMD_MAX_IN_FLIGHT=16
# Gemeinsame Obergrenze für positive und negative CIMD-LRU-Einträge (Default 512).
STELLARA_OAUTH_CIMD_CACHE_MAX_ENTRIES=512

# Feature-Flag für die leichtgewichtigen HTTP-Fetch-Tools (§8.17/§8.18).
# Default `true`, weil keine externen Credentials gebraucht werden.
# Setze `false` oder `0`, um `web_fetch` und `web_graphql` deployment-
# weit zu deaktivieren.
STELLARA_FETCH_ENABLED=true

# Feature-Flag für die Playwright-Browser-Tools (§8.19+, Plan 0009/0010).
# Default `true`, weil das gebündelte Chromium aus dem Runtime-Image
# kommt und keine externen Credentials gebraucht werden.
STELLARA_PLAYWRIGHT_ENABLED=true
# Globale Obergrenze paralleler Playwright-Sessions. Default 3 passt zum
# 1.5 GB Container-Budget (siehe docker-compose.yml `mem_limit`).
STELLARA_PLAYWRIGHT_MAX_SESSIONS=3
# Maximale parallele Sessions pro User. Default 1; ≤ MAX_SESSIONS halten.
STELLARA_PLAYWRIGHT_MAX_SESSIONS_PER_USER=1
```

---

## 13. Docker Compose

```yaml
services:
  stellara:
    image: ghcr.io/sebastian-software/stellara:latest
    container_name: stellara
    restart: unless-stopped
    env_file:
      - .env
    networks:
      - internal
      - proxy
    expose:
      - "8787"
    volumes:
      # Persistente SQLite-Datei für den OAuth-Server (§6.6).
      # Beim ersten Boot wird hier das RSA-Keypair und das
      # Schema angelegt; Backup-Strategie ist Sache des Operators.
      - ./stellara-data:/data
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "fetch('http://localhost:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    mem_limit: 512m
    cpus: 1.0

networks:
  internal:
    external: true
  proxy:
    external: true
    name: ${STELLARA_PROXY_NETWORK:?Set STELLARA_PROXY_NETWORK to the external proxy network name}
```

Das logische Netzwerk `proxy` verbindet Stellara mit dem Edge/Reverse Proxy.
Sein tatsächlicher externer Name wird verpflichtend über
`STELLARA_PROXY_NETWORK` gesetzt; ohne den Wert muss bereits das Rendern der
Compose-Konfiguration fehlschlagen.

---

## 14. Reverse Proxy

Der Edge/Reverse Proxy terminiert HTTPS für `${PUBLIC_BASE_URL}` und leitet
Requests im externen Docker-Netz `proxy` an Stellara weiter. Der
produktunabhängige Routing-Vertrag lautet:

```text
Host:   öffentlicher Host aus PUBLIC_BASE_URL
Target: http://stellara:8787
```

Der Proxy muss Security-Header wie `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY` und `Referrer-Policy: no-referrer` setzen. Forwarding-
Header sind nur dann vertrauenswürdig, wenn der direkte TCP-Peer in
`TRUSTED_PROXY_CIDRS` steht; der Proxy darf die ursprüngliche Client-IP nicht
durch ungeprüfte externe Header ersetzen.

Der MCP-Endpunkt antwortet im JSON-Modus und verwendet weder SSE noch
Transportsessions. Für lange Toolaufrufe soll der Proxy Request- und Response-
Buffering deaktivieren und Read-/Send-Timeouts von mindestens 3600 Sekunden
zulassen. Die konkrete Produktsyntax bleibt Betreiberkonfiguration.

### TLS-Zertifikat

Der Edge/Reverse Proxy verwaltet das TLS-Zertifikat für den öffentlichen
Origin. Ausstellungs- und Erneuerungsverfahren sind produkt- und
deploymentabhängig und liegen außerhalb dieses Konzepts.

---

## 15. Health Checks

### 15.1 `/health` — Liveness

Reine Liveness-Prüfung, antwortet immer wenn der Prozess läuft.
Wird vom Docker-Healthcheck und Reverse Proxy verwendet.

```json
{
  "status": "ok",
  "service": "stellara",
  "version": "1.0.0"
}
```

`version` wird beim Build aus `package.json` in eine
Env-Variable (`APP_VERSION`) gespiegelt; das Container-Tag
(`vX.Y.Z`) entspricht derselben Versionsnummer (§19, §24).

HTTP-Status immer `200`.

### 15.2 `/ready` — Readiness

Prüft erreichbare Abhängigkeiten (Exa, Firecrawl, Qdrant,
Embedding-Provider) mit kurzem Timeout (z. B. 2 s).

```json
{
  "status": "ok",
  "checks": {
    "exa": "ok",
    "firecrawl": "ok",
    "qdrant": "ok",
    "embeddings": "ok"
  }
}
```

HTTP-Status `200` bei `ok`, `503` wenn mindestens
ein Dependency-Check fehlschlägt.

---

## 16. Fehlerformat

### 16.1 Envelope

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Unauthorized",
    "details": {}
  }
}
```

`details` ist optional und kann z. B. Validierungsfehler
oder Upstream-Reason-Strings enthalten.

### 16.2 Fehlerkatalog

| Code               | HTTP | Bedeutung                                                        |
|--------------------|------|------------------------------------------------------------------|
| `BAD_REQUEST`      | 400  | Anfrage syntaktisch falsch (kein JSON, falscher Content-Type).   |
| `UNAUTHORIZED`     | 401  | Kein oder unbekannter Bearer Token.                              |
| `FORBIDDEN`        | 403  | Token gültig, Operation aber nicht erlaubt (reserviert).         |
| `NOT_FOUND`        | 404  | Ressource (z. B. Memory-ID) nicht gefunden.                      |
| `PAYLOAD_TOO_LARGE`| 413  | Request-Body überschreitet die Limits aus §7.2.                  |
| `VALIDATION_ERROR` | 422  | Zod-Validierung der Payload fehlgeschlagen.                      |
| `RATE_LIMITED`     | 429  | Token-Quota überschritten (§22).                                 |
| `INTERNAL_ERROR`   | 500  | Unerwarteter Fehler im Gateway.                                  |
| `UPSTREAM_ERROR`   | 502  | Externer Dienst hat Fehler oder ungültige Antwort geliefert.     |
| `TIMEOUT`          | 504  | Upstream- oder Gesamt-Timeout (§17) überschritten.               |

---

## 17. Timeouts

Empfohlene Defaults (Route-Level Hard-Caps):

```text
Search:                10 Sekunden
Scrape:                30 Sekunden
Crawl:                 60 Sekunden
Research:              60 Sekunden    (timeBudgetMs aus §8.4 ist Soft-Cap innerhalb dessen)
Memory Upsert:         15 Sekunden
Memory Search:         10 Sekunden
Fetch:                 15 Sekunden    (§8.17)
GraphQL:               15 Sekunden    (§8.18)
Browser Session Start: 60 Sekunden    (§8.19, Plan 0009 — Chromium-Spawn + erste Navigation)
Browser Session Stop:   5 Sekunden    (§8.20)
Browser Navigate:      30 Sekunden    (§8.21)
Browser Interact:      60 Sekunden    (§8.22 — Action-Kette)
Browser Screenshot:    30 Sekunden    (§8.23)
Browser Content:       15 Sekunden    (§8.24)
Browser Eval:          30 Sekunden    (§8.25, Plan 0010)
Browser PDF:           60 Sekunden    (§8.26)
Browser Cookies:        5 Sekunden    (§8.27)
Browser Storage:        5 Sekunden    (§8.28)
Browser HAR:           30 Sekunden    (§8.29 — Stop serialisiert den Buffer)
Browser Tabs:          10 Sekunden    (§8.30)
```

Enforcement:

- Jeder Upstream-Call läuft mit einem `AbortController`,
  der nach Ablauf das `fetch` abbricht.
- Die Fastify-Route setzt zusätzlich ein Gesamt-Timeout
  (siehe `REQUEST_TIMEOUT_MS` als Obergrenze).
- Bei Ablauf wird `504 TIMEOUT` (§16) zurückgegeben,
  laufende Upstream-Requests werden abgebrochen.

### 17.1 SSRF-Restpunkte

`safeExternalUrl` (`src/schemas/common.ts`) sperrt vor dem Connect alle
URLs auf Loopback-, RFC1918-, CGNAT-, Link-Local-, Multicast- und
interne Docker-Namen ab. Diese Validierung wirkt auf den vom Caller
gelieferten Host-String und auf jeden Redirect-Hop von `web_fetch` /
`web_graphql`.

Bekannter Restpunkt — **TOCTOU (Time-of-Check vs. Time-of-Use)**: Ein
öffentlich auflösender Hostname kann zum Connect-Zeitpunkt auf eine
private IP zeigen (DNS-Rebinding, DNS-Repoint bei laufendem Job). Die
String-basierte Validierung erkennt das nicht. Betroffen sind alle
ausgehenden Tools, die einen Caller-Host dialen: `web_scrape` (§8.2),
`web_crawl` (§8.3), `web_map` (§8.10), `web_extract` (§8.11),
`web_crawl_start` (§8.15), `web_fetch` (§8.17), `web_graphql` (§8.18).

Mitigation in v1: Firecrawl-Tools haben zusätzlich `BLOCKED_URLS` in
`docker-compose.yml` als zweite Verteidigungslinie; alle Tools nutzen
strikte Bearer-Auth und Per-User-Rate-Limits (§6, §22), damit ein
TOCTOU-Erfolg nicht zur breiten Lateral-Movement-Quelle wird.

Zukünftige Verbesserung (außerhalb dieses Konzept-Stands): Custom
DNS-Dispatcher auf undici-Ebene, der die aufgelöste IP gegen die
Blocklist prüft, bevor der TCP-Connect öffnet. Wird hier als bewusster
Restpunkt vermerkt und nicht als Bug behandelt.

---

## 18. Caching

Optional später:

```text
Exa Search Cache:       5–30 Minuten
Firecrawl Scrape Cache: 1–24 Stunden
Research Cache:         5–60 Minuten
Embeddings Cache:       dauerhaft pro (Provider, Modell, Texthash)
```

---

## 19. Deployment

### Image-Build & Publish über GitHub Actions

Der Release-Flow ist zweistufig und wird zentral über
[release-please](https://github.com/googleapis/release-please)
gesteuert. Ein Push auf `main` triggert **keinen** Image-Build mehr;
Image-Builds entstehen ausschließlich durch ein veröffentlichtes GitHub
Release, das release-please beim Merge eines „Release Please"-PRs erzeugt.

```text
Stufe 1 — .github/workflows/release-please.yml
  Trigger:
    - push auf main
  Schritte:
    - googleapis/release-please-action@v5
      (analysiert Conventional Commits, legt/aktualisiert Release-PR,
       erzeugt beim Merge Tag vX.Y.Z + GitHub-Release)
  Token:
    - STELLARA_RELEASE_PLEASE_TOKEN (fein-granularer PAT, ausschließlich auf
      sebastian-software/stellara begrenzt, Contents: Read and write,
      Pull requests: Read and write und Issues: Read and write; im GitHub
      Environment release)

Stufe 2 — .github/workflows/release.yml
  Trigger:
    - release.published       -> Tags :X.Y.Z + :X.Y + :latest
  Schritte:
    - Checkout
    - Setup Buildx
    - Login bei ghcr.io (GITHUB_TOKEN)
    - Verify Tag == package.json-Version
    - docker/build-push-action mit Multi-Stage Dockerfile und SBOM
    - GitHub Build-Provenance-Attestation für den Image-Digest
```

**Versionsbumping (Conventional Commits → Version):**

- `feat:` und `fix:` lösen einen Release-PR aus.
- `chore:`, `docs:`, `refactor:`, `test:` lösen keinen Bump aus.
- `BREAKING CHANGE:` / `feat!:` markiert einen Major-Bruch.
- Pre-1.0-konservativ (Stellara aktuell): `bump-minor-pre-major: false`
  und `bump-patch-for-minor-pre-major: false` — `feat:` → Patch,
  `BREAKING CHANGE:` → Minor. Sobald Stellara `1.0.0` erreicht, gilt
  das reguläre SemVer-Mapping (`feat:` → Minor, `BREAKING` → Major).

**Bootstrap:** Das öffentliche Repository beginnt mit dem Release `v0.1.15`
und dem gleichen Stand in `.release-please-manifest.json`. release-please
berechnet nachfolgende Versionen ab diesem öffentlichen Ausgangspunkt.

**Operator-Setup:** Der `STELLARA_RELEASE_PLEASE_TOKEN` muss als
Environment-Secret im GitHub Environment `release` einmalig vom Operator
angelegt werden. Der fein-granulare PAT ist ausschließlich auf
`sebastian-software/stellara` begrenzt und benötigt Contents: Read and write,
Pull requests: Read and write sowie Issues: Read and write. Bis dahin bleibt
`RELEASE_AUTOMATION_ENABLED=false`. Das Default-`GITHUB_TOKEN` würde den
Tag-Push erzeugen, ohne dass weitere Workflows triggern.

### Image-Visibility & Registry-Auth

Das Image ist öffentlich unter `ghcr.io/sebastian-software/stellara`
verfügbar. Öffentliche Pulls benötigen keinen Registry-Token. Für
reproduzierbare Deployments sollte die exakte Version oder der Digest
statt eines beweglichen Tags verwendet werden.

Tags in ghcr.io sind mutable: ein manuelles Löschen und
Neu-Erzeugen eines `vX.Y.Z`-Tags überschreibt das
versionierte Image im Registry. Versionen sind damit nicht
kryptografisch fixiert — operationell sollte ein einmal
veröffentlichter Tag nicht recreated werden, weil bereits
laufende Pulls auf eine andere Codebasis verweisen können.

### Update-Strategie auf dem Deploymenthost

Updates werden bewusst **manuell** ausgelöst:

```bash
docker compose pull
docker compose up -d
```

Keine Watchtower, kein Cron, kein Auto-Pull. Bei 3 Usern
und seltenen Releases ist explizite Kontrolle wichtiger
als Automatisierung; spontane Auto-Updates während
laufender Nutzung sind unerwünscht.

### Lokaler Dev-Build

```bash
docker build -t stellara .
docker compose up -d
```

### Logs

```bash
docker logs -f stellara
```

### Multi-Stage-Dockerfile (Skizze)

```dockerfile
# build
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
RUN pnpm prune --prod

# runtime
FROM node:24-alpine
ARG APP_VERSION=0.0.0
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/dist        ./dist
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/package.json ./
USER app
ENV NODE_ENV=production
ENV APP_VERSION=${APP_VERSION}
EXPOSE 8787
CMD ["node", "dist/server.js"]
```

`APP_VERSION` wird im GitHub-Actions-Workflow aus
`package.json` ausgelesen und als `--build-arg` gesetzt;
das Container-Tag entspricht derselben Versionsnummer
(§15.1, §24).

### Graceful Shutdown

Auf `SIGTERM` (z. B. von `docker compose up -d`):

- Fastify schließt den HTTP-Server für neue Requests.
- Laufende Requests laufen bis `REQUEST_TIMEOUT_MS` zu Ende.
- Aktive Upstream-Calls werden über ihren `AbortController`
  abgebrochen, sobald das Gesamt-Timeout greift.
- Danach Prozess-Exit mit Status `0`.

---

## 20. OpenAPI-Generierung

Die Spec unter `/openapi.json` wird **aus den Zod-Schemata
der Routen generiert**:

- Fastify-Routen verwenden Zod als Validator.
- `@fastify/swagger` plus `zod-to-openapi` rendert die
  Schemata in OpenAPI 3.1.
- Routen und Validierung sind damit Single Source of Truth.

ChatGPT-Actions-Spezifika:

- `/openapi.json` ist public (§6.4), damit der Action-Builder
  die Spec direkt laden kann.
- `securitySchemes.bearerAuth` ist auf alle `/tools/*`
  und `/mcp`-Operationen angewendet.
- Jede Operation hat eine prägnante `summary` und
  `operationId` für den Action-Builder. `operationId`
  spiegelt den MCP-Tool-Namen (§9), z. B. `web_search`,
  `memory_upsert`.
- Jede Operation trägt zusätzlich eine ausführliche
  `description` (2-4 Sätze), die über den Helper
  `describeMcpTool(name)` aus dem MCP-Tool-Registry
  bezogen wird. Dadurch sind die Tool-Beschreibungen in
  OpenAPI und in MCP `tools/list` 1:1 gleich (Plan 0011).
- `info.description` enthält die Tool-Suite-Übersicht
  (`STELLARA_SUITE_OVERVIEW`), die auch moderne
  `server/discover`-Instructions und Legacy-
  `initialize.instructions` liefert. Swagger-UI rendert
  den Markdown, Custom-GPT-Actions sehen denselben Text.
- `PUBLIC_BASE_URL` ist die kanonische Quelle für
  `servers[0].url`. OpenAPI entfernt davon einen oder mehrere
  abschließende Slashes; ein Wert ohne abschließenden Slash bleibt
  unverändert. Da die OpenAPI-Pfadschlüssel mit `/` beginnen, entsteht
  beim Zusammensetzen der Request-URL dadurch genau ein Trennzeichen
  statt `//`. Diese Normalisierung betrifft nur die OpenAPI-Ausgabe;
  Konfigurationswert und -validierung sowie OAuth- und MCP-Semantik
  bleiben unverändert. Der einzige Servereintrag trägt die anbieter-
  und installationsneutrale Beschreibung `Public API`.

Die Spec wird beim Start einmal gebaut und im Speicher gehalten;
`/openapi.json` liefert sie ohne weiteren Aufbau aus.

**`/mcp` ist nicht Teil der OpenAPI-Spec.** Moderne MCP-Clients entdecken den
Server ohne `initialize` über `server/discover` und anschließend `tools/list`;
Legacy-Clients verwenden vorübergehend `initialize` → `tools/list`. ChatGPT
Actions kann mit `/mcp` nichts anfangen, und ein separater `openapi-mcp.json` hätte
keinen Consumer. Die OpenAPI-Spec dokumentiert ausschließlich
die REST-Tools unter `/tools/*` und die Public-Endpunkte
aus §6.4.

**OAuth-Endpoints sind ebenfalls aus der OpenAPI-Spec
ausgeblendet** (`schema.hide: true` pro Route). Sie
folgen den separaten RFC-8414/9728/7591/6749-Discovery-
und Wire-Formaten; sie über OpenAPI auch zu dokumentieren
würde nur zwei nicht-kongruente Definitionen entstehen
lassen. MCP-Clients beziehen die OAuth-Endpunkt-URLs
aus `/.well-known/oauth-authorization-server` (§6.6).

---

## 21. Logging

Pino schreibt strukturierte JSON-Logs nach `stdout`
(durch Docker eingesammelt).

Pro Request enthalten:

```text
requestId         (ULID, auch im Response-Header gesetzt)
userId            (aufgelöst aus Bearer Token, §6.3)
route             (z. B. POST /tools/search)
status            (HTTP-Status)
durationMs
upstream.exa      (Latenz, optional)
upstream.firecrawl
upstream.qdrant
upstream.embeddings
```

Redaction (Pino `redact`):

```text
req.headers.authorization
req.body.text           (bei Memory-Upserts auf Hash + Länge reduziert)
```

Query-Strings für `/tools/search` und `/tools/research`
werden vollständig geloggt — die User-Gruppe ist klein
und vertrauenswürdig (§4).

**Observability-Scope v1:** ausschließlich diese Logs.
Es gibt keinen Prometheus-`/metrics`-Endpunkt, keine
OpenTelemetry-Traces und keinen Log-Shipper. Bei Bedarf
werden Logs direkt mit `docker logs` oder einer
externen Pipeline (z. B. Loki, Promtail) eingesammelt.
Metriken und Traces sind explizit für spätere Iterationen
vorgesehen, sobald Nutzungs- oder Performance-Fragen
das rechtfertigen.

Für das Dual-Stack-Rollout erzeugt jeder authentifizierte `POST /mcp` nach
erfolgreicher Body- und Originprüfung das strukturierte Event
`mcp_request_classified`. Es trägt die request-gebundene `requestId` und
ausschließlich kontrollierte Klassifizierungsfelder:
`protocolEra` ist `modern` oder `legacy`, `mcpMethod` eine bekannte MCP-Methode
oder `unknown`. `protocolVersion` ist für Modern `2026-07-28` oder `unknown`;
für Legacy enthält es die ausgehandelte beziehungsweise als erlaubt erkannte
Version oder `unknown`. Tokens, Toolargumente, freie Clientnamen und rohe
Claims werden nicht in dieses Event übernommen.

Die Klassifizierungslogs lassen sich für Rollout und spätere
Legacy-Abschaltung nach Era, Version und Methode aggregieren. MCP-Protokoll- und
Node-Adapterfehler ergänzen diese Nutzungsdaten. Die eng begrenzte DCR-Ausnahme
für fehlendes `resource` ist separat über `oauth_resource_legacy_default` mit
`clientIdHash` sichtbar. Stellara besitzt weiterhin keinen Metrics-Exporter und
keine eigene MCP-Era-Metrik. Vor einer Entfernung des Legacy-Dispatchers sind
deshalb ein separater Plan und belastbare Produktionsdaten aus diesen Logs oder
einer späteren Metrikpipeline erforderlich.

---

## 22. Rate-Limiting

`@fastify/rate-limit` mit Per-Token-Bucket:

```text
Default:        RATE_LIMIT_MAX requests pro RATE_LIMIT_WINDOW_MS
Schlüssel:      user-id (aus §6.3) bei erfolgreich aufgelöstem Token
                fallback clientIp (aus §7.1) für 401-Versuche ohne Token
Antwort:        429 RATE_LIMITED mit Retry-After-Header
```

Health-, Readiness- und `/openapi.json`-Endpunkte sind
ausgenommen (siehe §6.4).

Öffentliche OAuth-Pfade verwenden eigene Grenzen: DCR erlaubt standardmäßig
fünf Registrierungen pro IP und Stunde. CIMD zählt nur echte ausgehende
Cache-Misses und erlaubt standardmäßig zehn pro IP und Minute; Cache-Hits
verbrauchen dieses Budget nicht. Zusätzlich begrenzt ein globales
In-flight-Limit die gleichzeitigen CIMD-Fetches auf 16 (§6.6).

---

## 23. CORS

Standardmäßig **kein** CORS aktiv. Alle vorgesehenen Clients
(ChatGPT Actions, Claude Desktop, Apple Shortcuts, eigene
Scripts) sprechen das Gateway serverseitig an und benötigen
keine Origin-Freigabe. Sollte später ein Browser-Client
hinzukommen, wird CORS gezielt für eine Origin-Allowlist
aktiviert.

---

## 24. API-Versionierung

Aktuelle Pfade haben **keinen** Versions-Prefix
(`/tools/search`, nicht `/v1/tools/search`).

Regeln:

- Additive Änderungen (neue optionale Felder, neue Endpunkte)
  bleiben unter den bestehenden Pfaden.
- Breaking Changes erhalten einen neuen Prefix (`/v2/tools/...`),
  und die OpenAPI-Spec listet beide Versionen parallel,
  bis die alte abgeschaltet wird.
- Die `version` im `/health`-Response folgt SemVer und ist
  identisch mit dem Container-Tag.

---

## 25. Embedding-Modell-Migration

Vektoren in Qdrant sind an `EMBEDDINGS_PROVIDER`,
`EMBEDDINGS_MODEL` und `EMBEDDINGS_DIMENSIONS` gebunden.
Wechsel dieser Werte ist eine bewusste Migration:

- Beim Start prüft das Gateway, ob die Collection mit der
  konfigurierten Dimension kompatibel ist. Falls nicht,
  bricht der Start mit klarer Fehlermeldung ab.
- Eine Migration erfolgt über ein separates Script
  (`pnpm run migrate:embeddings`), das eine neue Collection
  mit dem neuen Modell anlegt, alle Texte re-embeddet und
  am Ende die Collection-Referenz umschwenkt.
- Automatische Migration im laufenden Betrieb ist
  ausdrücklich nicht vorgesehen.
- Das Script läuft offline (Gateway pausiert oder
  schreibgeschützt). Bei vielen Einträgen kann es
  mehrere Minuten dauern, da jeder Text neu embedded
  werden muss.

---

## 26. Tests-Strategie

Vitest, zweistufig:

### Unit (in CI bei jedem Push)

- Alle Routen mit gemockten Upstream-Services
  (Exa, Firecrawl, Qdrant, Embedding-Provider).
- Schemata aus §8 sind Vertragsgrundlage; Mocks
  liefern realistische Beispiel-Responses.
- Auth, Rate-Limit, Fehlerkatalog, Per-User-Isolation,
  Memory-Point-ID-Ableitung.
- Schnell genug für jeden Commit, keine Netzwerk-Kosten.

### Integration (nur lokal und manuell)

- Manueller Lauf über `pnpm test:integration` gegen eigene,
  isolierte Testzugänge der Upstreams.
- Smoke-Suite je Tool (Search, Scrape, Crawl, Research,
  Memory-Upsert/Search/List/Delete, MCP-Handshake).
- Erkennt Schema-Drift vor einem geplanten Release oder bei einer
  gezielten Providerprüfung.
- GitHub Actions erhält keine Integration-Secrets und führt diese
  Suite nicht aus.

---

## 27. Zusammenfassung

Empfohlener Start:

```text
Public Origin:
PUBLIC_BASE_URL=https://stellara.example.com

Deployment:
Docker auf einem Deploymenthost

Proxy:
Edge/Reverse Proxy

TLS:
am Edge/Reverse Proxy

Auth:
Bearer Token pro User
(Token → User-ID-Mapping, §6.3)

Backend:
Node.js 24 LTS + TypeScript
Fastify, Zod, Pino, pnpm, Vitest

Externe Dienste (nicht Teil dieses Konzepts):
Firecrawl
Exa
Qdrant
Embedding-Provider

Erste Schnittstelle:
HTTP + OpenAPI
(aus Zod-Schemata generiert)

MCP-Schnittstelle:
Modernes MCP 2026-07-28 via Streamable HTTP,
vorübergehend ergänzt um vier initialisierungsbasierte Legacy-Versionen

Querschnittsthemen:
Rate-Limiting pro Token (§22)
Logging mit Redaction (§21)
Kein CORS (§23)
Versionierung über /vN-Prefix bei Breaking Changes (§24)
Embedding-Migration nur über dediziertes Script (§25)
Public: /health, /ready, /openapi.json (§6.4)
Client-IP nur über vertrauenswürdige direkte Proxy-Peers/CIDRs (§7.1)
MCP-Tools snake_case mit Bereichs-Prefix, Capabilities nur tools (§9)
MCP stateless, GET /mcp → 405 in v1 (§9)
Memory-Listing mit Cursor-Pagination (§8.7)
TLS-Terminierung am Edge/Reverse Proxy (§14)
Image öffentlich auf ghcr.io, manueller Pull-Deploy (§19)
Observability v1: nur Pino-Logs (§21)
Tests zweistufig: Unit gemockt in CI, Integration lokal live (§26)
```
