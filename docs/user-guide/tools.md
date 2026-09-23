# Verfügbare Tools

Diese Seite listet **alle Tools**, die Stellara anbietet, und beschreibt, was
jedes davon tut. Die Tools werden nicht von dir direkt, sondern von deiner
LLM-App (Claude Desktop, ChatGPT Connector, …) im Gespräch aufgerufen — du
beschreibst dein Ziel in natürlicher Sprache, das Modell wählt das passende Tool.

**Welche Tools tatsächlich verfügbar sind, hängt vom Deployment ab.** Jede
Tool-Familie ist an ein Feature-Flag gekoppelt und erscheint nur, wenn der
Betreiber die zugehörigen Zugangsdaten hinterlegt hat (z. B. Firecrawl, Exa,
Qdrant). Die für deine Verbindung aktiven Tools liefert der MCP-Handshake
(`tools/list`); die meisten Clients zeigen sie in ihrer Tool-Übersicht an.

Legende in der Spalte „Art":

- **Lesend** — ruft nur Daten ab, verändert nichts.
- **Verändert Daten** — schreibt oder löscht (persistent oder in einer
  Browser-Session).

> Für die technischen Aufruf-Details (REST-Endpunkte, MCP-Beispiele,
> Request-Felder) siehe die [Tool-API im Developer-Guide](../developer-guide/tool-api.md).

## `web_*` — Web-Recherche & HTTP (Firecrawl + Exa)

| Tool | Was es macht | Art |
| --- | --- | --- |
| `web_search` | Semantische Websuche über Exa. Liefert eine Rangliste passender URLs mit Titel und Snippet, aber **ohne** Seiteninhalt — zum Abrufen mit `web_scrape` oder `web_fetch` kombinieren. Guter Startpunkt, wenn du eine Frage hast und Quellen finden willst. | Lesend |
| `web_scrape` | Ruft eine einzelne URL ab und liefert sauberes Markdown (oder HTML). Rendert JavaScript automatisch. Erste Wahl für menschenlesbare HTML-Seiten. | Lesend |
| `web_crawl` | Crawlt mehrere Seiten ab einer Start-URL und liefert deren Markdown. Synchron mit ~55-Sekunden-Soft-Cap; für größere Crawls `web_crawl_start` + `web_crawl_status` nutzen. | Lesend |
| `web_research` | Kombinierte Pipeline aus Exa-Suche und Firecrawl-Scrape in **einem** Aufruf: sucht, holt die besten Quellen (Standard 5, max. 10) und liest sie parallel. Liefert Quellen inklusive Inhalt — „recherchiere dieses Thema" in einem Schritt. | Lesend |
| `web_map` | Ermittelt die von einer Start-URL erreichbaren URLs (nur die Liste, kein Inhalt). Discovery-Schritt vor gezieltem Scrape oder Crawl. | Lesend |
| `web_extract` | Extrahiert strukturierte Daten aus einer oder mehreren URLs über Firecrawls LLM-Extractor (per Prompt und/oder JSON-Schema). Liefert geparste Felder (z. B. Preis, Autor, Termin) statt Roh-Markdown. Langsamer und teurer als `web_scrape`. | Lesend |
| `web_crawl_start` | Startet einen asynchronen Crawl-Job und liefert dessen Job-ID. Für Crawls, die länger als der synchrone `web_crawl` brauchen. | Lesend |
| `web_crawl_status` | Fragt einen zuvor gestarteten Crawl-Job ab (beliebig oft aufrufbar). Liefert die bisher gesammelten Seiten plus Status. Gehört zu `web_crawl_start`. | Lesend |
| `web_fetch` | Generischer HTTP-Request gegen einen öffentlichen Endpunkt (REST/JSON, Text). Unterstützt neben `GET` auch schreibende Methoden (`POST`, `PUT`, `PATCH`, `DELETE`), kann also externen Zustand ändern. Reicht `Authorization` unverändert durch — für authentifizierte APIs. Für rein lesende Aufrufe die read-only-Variante `web_get` nutzen; für HTML-Seiten lieber `web_scrape`. | Lesend / Verändert Daten |
| `web_get` | Read-only-Geschwister von `web_fetch`: derselbe generische HTTP-Request, aber auf die HTTP-„safe methods“ `GET`, `HEAD` und `OPTIONS` beschränkt — kein Request-Body möglich. Dieselbe SSRF-Absicherung, Header-Sanitisierung und Response-Form wie `web_fetch`. | Lesend |
| `web_graphql` | GraphQL-Operation gegen einen öffentlichen Endpunkt. Kann auch Mutations ausführen, also externen Zustand ändern. Baut den Standard-Body, reicht `Authorization` durch und nutzt dieselbe SSRF-Absicherung wie `web_fetch`. Für rein lesende Operationen die read-only-Variante `web_graphql_query` nutzen. | Lesend / Verändert Daten |
| `web_graphql_query` | Read-only-Geschwister von `web_graphql`: der `query`-String wird serverseitig geparst, jede `mutation`- oder `subscription`-Operation im Dokument wird mit einem Fehler abgelehnt. Ansonsten identisches Verhalten (Body-Format, Header-Durchreichung, SSRF-Absicherung). | Lesend |

<a id="memory-tools"></a>

## `memory_*` — Persistentes Gedächtnis (pro User isoliert)

Die Memory-Tools speichern Fakten und Kontext dauerhaft in einem Vektor-Store,
**strikt getrennt pro Nutzer** — dein Gedächtnis ist an deinen Token gebunden und
für andere nicht sichtbar.

Dabei handelt es sich um explizite MCP-Tool-Aufrufe, nicht um automatisch in
jede Unterhaltung eingefügten Gesprächsspeicher. Der Client muss
`memory_search` oder `memory_list` aufrufen; erst deren Treffer stehen im
aktuellen Kontext zur Verfügung. Mit `memory_upsert` bleibt eine Information
über die aktuelle Unterhaltung hinaus erhalten. Claude Code und Codex teilen
Einträge daher nur, wenn beide als derselbe Stellara-Nutzer authentifiziert
sind.

| Tool | Was es macht | Art |
| --- | --- | --- |
| `memory_upsert` | Speichert oder ersetzt einen Eintrag im persönlichen Gedächtnis. Für Fakten oder Notizen, die über die aktuelle Konversation hinaus erhalten bleiben sollen. Ein bereits vorhandenes `id` ersetzt den Eintrag vollständig. | Verändert Daten |
| `memory_search` | Durchsucht das eigene Gedächtnis per Vektorsuche und liefert die besten Treffer mit Ähnlichkeits-Score. | Lesend |
| `memory_list` | Listet die eigenen Gedächtnis-Einträge (neueste zuerst, mit Pagination). Zum Durchsehen oder Exportieren; für relevanzbasiertes Erinnern `memory_search`. | Lesend |
| `memory_delete` | Löscht Gedächtnis-Einträge per ID oder Filter. Endgültig und pro User. Im Zweifel vorher `memory_list`, um zu sehen, was ein Filter trifft. | Verändert Daten |

Geeignet sind dauerhafte Präferenzen, getroffene Entscheidungen und
sitzungsübergreifender Kontext. Nicht ins Memory gehören Zugangsdaten und
andere Geheimnisse, personenbezogene Daten, vorübergehender Aufgabenstatus,
rohe Chatverläufe oder unbestätigte Annahmen. Repository-Dateien, aktuelle
Anweisungen des Nutzers und maßgebliche Dokumentation haben immer Vorrang vor
Memory-Einträgen; bei Widersprüchen sollte der Client den Konflikt offenlegen.

## `browser_*` — Interaktiver Browser (Playwright)

Die Browser-Tools steuern eine echte, per Stealth-Profil getarnte
Playwright-Session — für Flows, die einfaches Scraping nicht abdeckt (Logins,
Formulare, JavaScript-lastige Seiten). Fast alle arbeiten auf einer **Session**,
die zuerst mit `browser_session_start` geöffnet und über eine `sessionId`
angesprochen wird. Sessions laufen nach 5 Minuten Inaktivität (spätestens nach
30 Minuten) automatisch ab.

| Tool | Was es macht | Art |
| --- | --- | --- |
| `browser_session_start` | Öffnet eine Playwright-Session auf einer URL und liefert eine `sessionId`. Nur für Flows, die JS-Rendering, Interaktion, Login-Status oder mehrere Tabs brauchen — für statische Inhalte ist `web_scrape` schneller. Standardmäßig mit realistischem Desktop-Fingerprint (`stealth: false` schaltet ihn ab). | Verändert Daten |
| `browser_session_stop` | Schließt eine Session und gibt ihre Ressourcen frei. Nach getaner Arbeit immer aufrufen, damit der Platz sofort frei wird. | Verändert Daten |
| `browser_navigate` | Navigiert die aktive Seite einer Session zu einer neuen URL (wartet aufs Laden). Für mehrstufige Flows in derselben Session. | Lesend |
| `browser_interact` | Führt eine Kette von Aktionen (`click`, `type`, `fill`, `wait`, `scroll`, `hover`, `press`, `select`) auf der aktiven Seite aus. Bricht beim ersten fehlgeschlagenen Schritt ab. Für Formulare, Logins und UI-Workflows. | Verändert Daten |
| `browser_screenshot` | Erstellt einen PNG-Screenshot der aktiven Seite oder eines einzelnen Elements (Base64, max. 10 MB). | Lesend |
| `browser_content` | Liest das DOM der aktiven Seite als HTML oder reinen Text — der aktuelle gerenderte Stand einer interaktiven Session. | Lesend |
| `browser_eval` | Führt einen JavaScript-Ausdruck im Kontext der Seite aus und liefert das JSON-Ergebnis (max. 1 MB). Mächtiger Notausgang, wenn kein anderes Browser-Tool passt. | Verändert Daten |
| `browser_pdf` | Rendert die aktive Seite als PDF (Base64, max. 10 MB). Für Reports, Rechnungen oder layoutstabile Artefakte. | Lesend |
| `browser_cookies` | Liest oder setzt Cookies der Session (Modi `get`, `set`, `clear`). Cookies gelten für alle Tabs der Session. | Verändert Daten |
| `browser_storage` | Liest oder setzt Web Storage (`localStorage`/`sessionStorage`) der aktiven Seite (Modi `get`, `set`, `clear`). | Verändert Daten |
| `browser_har` | Startet oder stoppt den HAR-Recorder der Session. **Datenschutz-Hinweis:** aufgezeichnete Header enthalten `Authorization` und `Cookie` im Klartext — das HAR nur mit vertrauenswürdigen Stellen teilen. | Verändert Daten |
| `browser_tabs` | Listet, wechselt, schließt oder öffnet Tabs einer Session (Modi `list`, `switch`, `close`, `new`). Maximal 5 Tabs; den letzten Tab schließt man über `browser_session_stop`. | Verändert Daten |

## `domain_*` — Domain-Verfügbarkeit

| Tool | Was es macht | Art |
| --- | --- | --- |
| `domain_availability` | Prüft, ob eine Domain registriert oder frei ist. RDAP-first (plus DENIC-Sonderweg für `.de`), WHOIS-Fallback für ccTLDs ohne RDAP. Liefert genau einen Status: `registered`, `available`, `unsupported_tld` oder `indeterminate` — **keine** Registrant-Daten. | Lesend |

## Weiterführende Dokumentation

- [Stellara in LLM-Apps einbinden](llm-clients-einbinden.md) — Einrichtung und Authentifizierung
- [Tool-API (Developer-Guide)](../developer-guide/tool-api.md) — REST-/MCP-Aufrufe und Request-Felder
