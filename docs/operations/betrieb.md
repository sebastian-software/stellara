# Betrieb

Diese Seite beschreibt den Betrieb von Stellara aus Betreiber-Sicht: OAuth-Server-Setup, Volume-Mount, Einbindung von LLM-Apps sowie Routine-Operationen wie Token-Rotation und Storage-Reset.
Die vollständige Liste der Laufzeitvariablen und ihrer Abhängigkeiten steht in der [Konfigurationsreferenz](configuration.md).

## Externes Proxy-Netz konfigurieren

Compose verwendet das logische Netz `proxy`. Dessen bereits vorhandener
externer Docker-Netzname muss auf jedem Deploymenthost verpflichtend über
`STELLARA_PROXY_NETWORK` in der nicht getrackten Betreiberkonfiguration gesetzt
werden. Es gibt keinen Default; fehlt der Wert, bricht bereits das Rendern der
Compose-Konfiguration mit einer Fehlermeldung ab.

Beim Cutover gilt diese Reihenfolge:

1. `STELLARA_PROXY_NETWORK` vor dem Rollout auf den tatsächlichen externen
   Netzwerknamen des Zielsystems setzen.
2. Die Konfiguration hermetisch rendern, ohne Werte aus einer lokalen `.env`
   oder aus Service-Env-Dateien aufzulösen:

   ```sh
   export STELLARA_PROXY_NETWORK=proxy-network
   docker compose --env-file /dev/null config --no-env-resolution
   ```

3. Auf dem Zielsystem prüfen, dass das aufgelöste externe Netz bereits
   existiert:

   ```sh
   docker network inspect "$STELLARA_PROXY_NETWORK"
   ```

4. Erst danach das neue Compose-Artefakt deployen.

Ein Rollback stellt das vorherige Compose-Artefakt und die dazu passende
bisherige, nicht getrackte Betreiberkonfiguration wieder her. Das neue logische
Netz darf nicht stillschweigend auf ein anderes physisches Netz umgebogen
werden; der Edge/Reverse Proxy und Stellara müssen dasselbe externe Netz
verwenden.

## OAuth-Setup

Stellara betreibt einen OAuth-2.1-Authorization-Server (siehe [Konzept](../developer-guide/stellara-konzept.md) §6.6), damit GUI-MCP-Clients wie **Claude Desktop** oder **ChatGPT Connectors** die Discovery-Endpoints automatisch entdecken und den PKCE-Flow durchführen können. Direkter API-Zugriff mit `STELLARA_TOKEN_<USERID>`-Bearer bleibt unverändert nutzbar – der OAuth-Server ist additiv. Der geschützte Resource-Identifier ist exakt `${PUBLIC_BASE_URL}/mcp`; die pfadspezifischen Metadaten liegen unter `${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource/mcp`, der bisherige Root-Alias bleibt verfügbar.

Neben DCR akzeptiert der Authorization- und Login-Pfad HTTPS-Client-IDs als Client-ID Metadata Documents (CIMD). CIMD ist standardmäßig aktiv und besitzt eine eigene Egress-Grenze: maximal drei Redirects innerhalb der ursprünglichen Origin, 5 Sekunden Timeout, 64 KiB Antwortlimit sowie DNS- und Socket-Pinning auf öffentliche Adressen. Code-Austausch und Refresh verwenden die bereits gebundene Client-ID und lösen keinen weiteren CIMD-Fetch aus.

Folgende Variablen steuern die lokalen Schutzgrenzen:

```env
# Echte CIMD-Cache-Misses je Quell-IP und Minute
STELLARA_OAUTH_CIMD_RATE_LIMIT_PER_MINUTE=10
# Gleichzeitige CIMD-Netzwerkabrufe je Prozess
STELLARA_OAUTH_CIMD_MAX_IN_FLIGHT=16
# Gemeinsame LRU-Obergrenze für positive und negative Ergebnisse
STELLARA_OAUTH_CIMD_CACHE_MAX_ENTRIES=512
```

Cache-Hits zählen nicht gegen das IP-Budget. Bei Ausschöpfung antwortet Stellara ohne Warteschlange lokal mit HTTP 429 und `Retry-After` beziehungsweise HTTP 503 und `temporarily_unavailable`. Positive Einträge folgen den Upstream-Cacheheadern, höchstens eine Stunde und standardmäßig fünf Minuten; negative Einträge bleiben ungefähr 30 Sekunden im gemeinsamen Cache.

### Volume-Mount

Die OAuth-Persistenz (registrierte Clients, Refresh-Tokens, Sessions, signierender RSA-Schlüssel und OAuth-Metadaten) liegt in `/data/stellara.db` im Container. Im Compose-File ist dafür ein Bind-Mount neben das Compose-File eingetragen:

```yaml
volumes:
  - ./stellara-data:/data
```

Beim ersten Boot wird das Schema migriert und ein RSA-2048-Keypair erzeugt. Der private Schlüssel verlässt den Container nicht; der öffentliche Schlüssel ist über `GET /oauth/jwks` abrufbar.

**Backup-Hinweis:** `./stellara-data/stellara.db` enthält den privaten Signing-Key, OAuth-Credentials und Fingerprints statischer Tokens. Die Datenbank und ihre Sicherungen sind sensible Daten. Für eine konsistente Sicherung den Dienst vor dem Kopieren anhalten oder ein SQLite-taugliches Backup-Verfahren verwenden; das isolierte Kopieren der laufenden Datenbankdatei im WAL-Modus genügt nicht.

**UID/GID:** Der Container läuft als `app` (UID/GID `999`). Das gemountete Verzeichnis (und alle bestehenden Dateien darin) muss `999:999` gehören, sonst scheitert der Boot mit `SQLITE_CANTOPEN`. Beim Upgrade von einer früheren Alpine-basierten Stellara-Version (UID `100`) müssen die Eigentümer einmalig angepasst werden:

```sh
sudo docker compose stop stellara
sudo chown -R 999:999 ./stellara-data
sudo docker compose start stellara
```

## LLM-Apps einbinden

Die konkrete Einrichtung für Claude Desktop, ChatGPT Connectors und andere MCP-Clients steht im [User-Guide](../user-guide/llm-clients-einbinden.md). Beim ersten Verbinden öffnet ein OAuth-fähiger Client einen Browser-Login. Der User tippt seinen `STELLARA_TOKEN_<USERID>`-Wert in das Form ein; nach Match wird ein Session-Cookie gesetzt (12 h, sliding renewal nach 1 h) und der OAuth-Code-Flow läuft durch. Anschließend hat der Client ein Refresh-Token (30 d), das pro Aufruf rotiert wird.

**Wichtig:** `PUBLIC_BASE_URL` in `.env` muss die öffentliche Domain sein, unter der Clients den Server erreichen — nicht die interne Proxy-Adresse. Aus diesem Wert werden alle OAuth-Discovery-URLs und der JWT-`iss`-Claim abgeleitet. Stimmt er nicht mit dem Host überein, den der Client aufruft, lehnen MCP-Clients die Verbindung ab oder landen in einem Redirect-Loop auf den internen Hostnamen.

Authorization- und Token-Requests neuer DCR-Clients und aller CIMD-Clients müssen `${PUBLIC_BASE_URL}/mcp` als `resource` senden. Beim ersten Start dieses Upgrades schreibt Stellara einmalig `oauth_resource_required_since` nach `oauth_meta`. Nur bereits davor registrierte opake DCR-Clients dürfen `resource` vorübergehend weglassen; jeder solche Fallback erzeugt das Event `oauth_resource_legacy_default`. Der Cutover-Zeitpunkt bleibt über Neustarts stabil.

## MCP-Dual-Stack ausrollen

`POST /mcp` priorisiert MCP `2026-07-28` über das offizielle TypeScript SDK v2. Dieser Pfad verwendet `server/discover`, request-spezifische `_meta`, die MCP-HTTP-Header und JSON-Antworten; es gibt weder `initialize` noch `Mcp-Session-Id`. Echte Legacy-Requests werden davor mit `isLegacyRequest` klassifiziert und für die kurze Übergangszeit über Stellaras isolierten JSON-Dispatcher verarbeitet. Das ist kein SDK-Legacy-SSE-Fallback.

Für ein kontrolliertes Rollout:

1. Vor dem Deployment `stellara.db` sichern und `PUBLIC_BASE_URL` sowie `TRUSTED_PROXY_CIDRS` gegen den realen Proxy-Pfad prüfen.
2. Im Staging einen offiziellen modernen Client mit Auto-Negotiation verbinden und `server/discover`, `tools/list` sowie einen ungefährlichen `tools/call` ausführen.
3. Zusätzlich jeden noch produktiv benötigten Legacy-Client prüfen. Unterstützt werden `2025-11-25`, `2025-06-18`, `2025-03-26` und `2024-11-05`.
4. OAuth je einmal mit einem bestehenden DCR-Client und einem kontrollierten öffentlichen CIMD-Testclient durchlaufen. Falsche Resource-Werte, Cross-Origin-Redirects und private CIMD-Ziele müssen scheitern.
5. Nach einem Feature-Flag-Wechsel berücksichtigen, dass moderne Clients ihren privaten Toolkatalog bis zu 300 Sekunden cachen dürfen.

Rollback benötigt keine Datenmigration: Der neue Cutover ist nur ein zusätzlicher Schlüssel in der bestehenden `oauth_meta`-Tabelle, den ältere Builds ignorieren. Rolle auf das vorherige Container-Artefakt zurück und lasse das SQLite-Volume unverändert. Bereits von einem modernen Client erwartetes MCP `2026-07-28` steht nach dem Rollback jedoch nicht zur Verfügung; die betroffenen Clients müssen bis zum erneuten Roll-forward einen unterstützten Legacy-Pfad verwenden.

Nach erfolgreicher Body- und Originprüfung erzeugt jeder authentifizierte `POST /mcp` das strukturierte Event `mcp_request_classified`. Die request-gebundene `requestId` erlaubt die Korrelation mit Fehler- und Abschlusslogs. `protocolEra` ist kontrolliert auf `modern` oder `legacy` begrenzt, `protocolVersion` enthält für Modern `2026-07-28` oder `unknown` und für Legacy die ausgehandelte beziehungsweise als erlaubt erkannte Version oder `unknown`. `mcpMethod` enthält nur eine bekannte MCP-Methode oder `unknown`. Das Event übernimmt keine Tokens, Toolargumente, freien Clientnamen oder rohen Claims.

Für das Rollout lassen sich diese Events nach `protocolEra`, `protocolVersion` und `mcpMethod` aggregieren. Sie zeigen, welche Legacy-Versionen und Aufrufarten noch produktiv verwendet werden; `mcp protocol error` und `mcp node adapter error` ergänzen die Fehlerdiagnose am modernen SDK-Rand. `oauth_resource_legacy_default` zeigt mit `clientIdHash`, wie oft die befristete Resource-Ausnahme noch greift. Stellara besitzt weiterhin weder einen Metrics-Exporter noch eine eigene MCP-Era-Metrik. Entferne den Legacy-Dispatcher daher nicht allein aufgrund ruhiger Fehlerlogs: Eine Abschaltung benötigt einen separaten Plan und belastbare Nutzungsdaten aus den Klassifizierungslogs oder einer späteren Metrikpipeline.

## Operations

- **Token-Rotation und Widerruf:** Änderungen an `.env` benötigen einen Container-Neustart. Wird ein zuvor wirksamer statischer Token entfernt, rotiert oder neu in `STELLARA_REVOKED_TOKENS` aufgenommen, löscht der nächste Boot die ausstehenden OAuth-Codes, Refresh-Tokens und Sessions dieses Users in einer Transaktion. Zusätzlich hinzugefügte gültige Tokens ändern bestehende OAuth-Autorisierungen nicht. Bereits ausgegebene Access-JWTs bleiben bis zu ihrem `exp` gültig; eine Änderung der TTL wirkt nicht rückwirkend.
- **Storage-Reset:** Bei massivem Schaden (z. B. korruptes SQLite-File) kann `./stellara-data/stellara.db` gelöscht werden. Beim nächsten Boot wird ein neues Schema und ein **neuer** Signing-Key erzeugt — alle bisherigen Access-Tokens werden ungültig, MCP-Clients müssen sich neu authorizen.
- **Audit-Trail:** Jeder OAuth-Event landet in den Pino-Logs (`oauth_client_registered`, `oauth_login_succeeded`, `oauth_token_issued`, `oauth_refresh_replay_detected`, `oauth_resource_legacy_default`, …). Client-IDs werden für die Korrelation gehasht; Token-Werte erscheinen niemals im Log.
- **CIMD-Überlast:** HTTP 429 mit `Retry-After` zeigt ein ausgeschöpftes Quell-IP-Budget. HTTP 503 mit `temporarily_unavailable` zeigt ein ausgeschöpftes globales In-flight-Limit. Beide Antworten bleiben lokal und werden nicht an eine noch unverifizierte Redirect-URI weitergeleitet.

### Upgrade des Token-Abgleichs

Vor dem Upgrade das SQLite-Volume konsistent sichern. Beim ersten Start mit dem Token-Snapshot werden vorhandene OAuth-Codes, Refresh-Tokens und Sessions einmalig gelöscht; Clients und Signing-Key bleiben erhalten. Die Nutzer müssen den OAuth-Flow erneut durchlaufen. Weitere unveränderte Starts löschen nichts. Auch bei fehlenden, beschädigten oder nicht unterstützten Snapshot-Metadaten wird der Autorisierungszustand einmalig vollständig gelöscht. Ein SQL-Fehler bricht den Start ab und setzt die Löschungen samt Snapshot-Änderung zurück. Das strukturierte Logevent `oauth_static_token_reconciled` enthält nur Zähler und Status, keine Tokenwerte oder Fingerprints.

Ein Rollback auf einen älteren Build benötigt keine Datenmigration, stellt aber dessen frühere Lücke bei OAuth-Login und fortbestehendem OAuth-Zustand wieder her. Den Widerrufseintrag beibehalten, den alten Build nur für die notwendige Dauer verwenden und anschließend wieder auf den korrigierten Build vorrollen. Der erneute Start gleicht den gespeicherten Snapshot mit den aktuell wirksamen Tokens ab. Die vollständigen Schritte und Sicherheitsgrenzen stehen in der [Konfigurationsreferenz](configuration.md).

## Weiterführende Dokumentation

- Release-Prozess: [`release-prozess.md`](release-prozess.md)
- Laufzeitkonfiguration: [`configuration.md`](configuration.md)
- Architektur und Tool-Design: [`../developer-guide/stellara-konzept.md`](../developer-guide/stellara-konzept.md)
- LLM-App-Einbindung und Auth (End-User-Sicht): [`../user-guide/llm-clients-einbinden.md`](../user-guide/llm-clients-einbinden.md)
