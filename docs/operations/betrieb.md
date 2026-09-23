# Betrieb

Diese Anleitung führt einen Betreiber von einem neuen Docker-Host bis zum ersten
Stellara-Start sowie durch Sicherung, Wiederherstellung und Upgrade. Die
vollständige Liste der Laufzeitvariablen und ihrer Abhängigkeiten steht in der
[Konfigurationsreferenz](configuration.md).

## Stellara auf einem neuen Host bereitstellen

### Voraussetzungen und Topologie

Benötigt werden Docker Engine mit dem Compose-Plugin (`docker compose version`),
ein bereits bereitgestellter Firecrawl-Dienst, ein TLS-terminierender
Edge/Reverse Proxy sowie ein öffentlicher DNS-Name mit gültigem Zertifikat.
Firecrawl und Proxy werden separat betrieben; das Stellara-Compose-File startet
sie nicht. Stellara veröffentlicht Port `8787` nur innerhalb der Docker-Netze,
nicht auf dem Host. Der Proxy leitet HTTPS-Anfragen auf
`http://stellara:8787` weiter. Auf dem Deploymenthost liegen das Repository
mit `docker-compose.yml` und `docker/Dockerfile`, eine nicht getrackte `.env`
sowie das persistente Verzeichnis `./stellara-data`.

Führe die folgenden Befehle im Repository-Verzeichnis auf dem Deploymenthost
aus. Ersetze Container- und Netzwerknamen durch die tatsächlichen Namen. Falls
Firecrawl oder der Proxy auf anderen Hosts laufen, muss deren Adresse von
Stellara aus erreichbar sein; die Docker-Netzanschlüsse unten gelten für
Container auf demselben Host.

### Netze und Upstream-Dienste verbinden

Compose erwartet zwei **bereits vorhandene** externe Docker-Netze: `internal`
für Firecrawl und `proxy` als logischen Namen für das durch
`STELLARA_PROXY_NETWORK` benannte Edge-Netz. Wähle einen eindeutigen Namen für
das Edge-Netz, trage ihn in `.env` ein und exportiere ihn für die
Compose-Interpolation. Prüfe vorhandene Netze vor dem Anlegen, um einen
Namensfehler nicht durch ein leeres neues Netz zu verdecken:

```sh
export STELLARA_PROXY_NETWORK=proxy-network
docker network inspect internal >/dev/null 2>&1 || docker network create internal >/dev/null
docker network inspect "$STELLARA_PROXY_NETWORK" >/dev/null 2>&1 || docker network create "$STELLARA_PROXY_NETWORK" >/dev/null
docker network inspect internal --format '{{.Name}} {{.Driver}}'
docker network inspect "$STELLARA_PROXY_NETWORK" --format '{{.Name}} {{.Driver}}'
```

Wenn Firecrawl und Proxy bereits als Container laufen, prüfe zunächst deren
Netzanschlüsse. Verbinde nur fehlende Anschlüsse; `docker network connect`
meldet bei einem bereits angeschlossenen Container einen Fehler.

```sh
docker inspect firecrawl --format '{{json .NetworkSettings.Networks}}'
docker inspect reverse-proxy --format '{{json .NetworkSettings.Networks}}'
docker network connect internal firecrawl
docker network connect "$STELLARA_PROXY_NETWORK" reverse-proxy
```

Die letzten beiden Befehle nur für jeweils fehlende Anschlüsse ausführen.
Prüfe anschließend erneut mit `docker inspect`. Trage die externen Netze auch
in den Compose-Dateien oder Deployment-Spezifikationen von Firecrawl und Proxy
ein: Ein manuelles `docker network connect` gilt nur für die aktuelle
Containerinstanz und geht bei deren Neuerstellung verloren. Konfiguriere
Firecrawl so,
dass sein HTTP-Endpunkt im Netz `internal` unter seinem dortigen Namen und Port
erreichbar ist, zum Beispiel `http://firecrawl:<firecrawl-port>`. Der konkrete
Port und API-Key kommen aus der separaten Firecrawl-Installation. Die
gewählte Firecrawl-Version muss Stellaras `/v1`-Aufrufe für Scrape, Crawl,
Map und Extract unterstützen; der Adapter verwendet diese Endpunkte direkt.
Der Proxy muss im Edge-Netz `stellara:8787` erreichen und den ursprünglichen Host sowie
die Weiterleitungsinformationen korrekt übermitteln.

Stellara prüft über `safeExternalUrl` URL-Eingaben, aber eine DNS-Änderung
zwischen Prüfung und Verbindung bleibt bei Firecrawl-Aufrufen relevant. Prüfe
**für die tatsächlich eingesetzte Firecrawl-Version** deren dokumentierte
SSRF-Sperren oder einen ausgehenden Filter am Firecrawl-Host. Verifiziere mit
einem kontrollierten Test, dass Firecrawl keine Loopback-, Link-Local- oder
internen Adressen abrufen kann. Eine bloße `BLOCKED_URLS`-Zeile in einem
Beispiel ist kein Nachweis: Stellaras Compose-File konfiguriert Firecrawl
nicht. Für OSS-Playwright weist [Firecrawls Sicherheitsmeldung](https://github.com/firecrawl/firecrawl/security/advisories/GHSA-vjp8-2wgg-p734)
auf das Restrisiko hin und empfiehlt einen `PROXY_SERVER`-Egress-Proxy, der
insbesondere Link-Local-Adressen sperrt. Verwende die zur Version passende
[Firecrawl-Self-Host-Anleitung](https://github.com/firecrawl/firecrawl/blob/main/SELF_HOST.md).

### Konfiguration, Image und Verzeichnis vorbereiten

Erstelle die nicht getrackte Konfiguration mit restriktiven Rechten und bearbeite
sie in einem geschützten Editor. Erzeuge für jeden `STELLARA_TOKEN_<USERID>`
einen eigenen Zufallswert; der Befehl gibt einen geheimen Wert aus, der nur in
die `.env` oder einen Secret Store gehört:

```sh
install -m 600 .env.example .env
openssl rand -hex 48
${EDITOR:-vi} .env
mkdir -p ./stellara-data
sudo chown -R 999:999 ./stellara-data
sudo chmod 700 ./stellara-data
```

Vor dem Start müssen `PUBLIC_BASE_URL` auf den öffentlichen HTTPS-Origin,
`FIRECRAWL_BASE_URL` auf den aus Stellara erreichbaren Firecrawl-Endpunkt,
`FIRECRAWL_API_KEY`, mindestens ein `STELLARA_TOKEN_<USERID>` und
`STELLARA_PROXY_NETWORK` gesetzt sein. `TRUSTED_PROXY_CIDRS` muss **nur** die
direkten kontrollierten Proxy-Peers oder CIDRs enthalten; ein breites Netz
würde gefälschte Forwarding-Header vertrauen. Für die minimale Installation
`STELLARA_PLAYWRIGHT_ENABLED=false` und `STELLARA_DOMAIN_ENABLED=false` setzen.
Die `.env.example` zeigt für beide Funktionen ihre normalen aktivierten
Defaults; diese Anleitung deaktiviert sie ausdrücklich für den kleinen
Erststart. Alle Werte und Abhängigkeiten erklärt die
[Konfigurationsreferenz](configuration.md).

Wähle für `STELLARA_IMAGE` einen festen veröffentlichten Tag oder Digest,
zum Beispiel `ghcr.io/sebastian-software/stellara:0.1.15`, und halte den Wert
für Sicherung und Rollback fest. Dieser veröffentlichte Tag ist nur für
`linux/amd64` verfügbar und liegt **vor** der #11-Token-Snapshot-Einführung.
Prüfe die Architektur des Zielhosts und die Manifest-Plattform des gewählten
Tags oder Digests vor dem Pull. Für einen nativen ARM64-Host oder den aktuellen
#11-Stand ein lokales Image aus genau diesem Checkout bauen und
`STELLARA_IMAGE=stellara:local` in `.env` setzen. Verwende denselben
nicht geheimen Image-Wert für den untenstehenden Preflight. Die Zuweisung gilt
nur für diesen Befehl, sodass spätere Compose-Befehle wieder den Wert aus
`.env` verwenden. `latest` ist beweglich und eignet sich nicht als
reproduzierbarer Stand:

```sh
docker build -f docker/Dockerfile -t stellara:local .
```

Prüfe danach die Compose-Syntax, ohne Secret-Werte aus `.env` oder den
Service-Env-Dateien in die Ausgabe zu übernehmen. Der **nicht geheime**
Netzname bleibt exportiert; die gewählte Image-Referenz gilt nur für den
Preflight-Befehl. Wähle exakt den Wert aus `.env`. Der Befehl gibt bei Erfolg
keine gerenderte Konfiguration aus; ein Fehler muss vor dem Start behoben
werden.

```sh
STELLARA_IMAGE=ghcr.io/sebastian-software/stellara:0.1.15 docker compose --env-file /dev/null config --no-env-resolution >/dev/null
# Bei einem lokalen Build stattdessen:
# STELLARA_IMAGE=stellara:local docker compose --env-file /dev/null config --no-env-resolution >/dev/null
```

Prüfe außerdem mit `docker network inspect internal` und
`docker network inspect "$STELLARA_PROXY_NETWORK"`, dass beide Netze existieren.
Fehlt `STELLARA_PROXY_NETWORK`, muss die Compose-Interpolation bereits hier
scheitern. Ein erfolgreicher Syntaxcheck prüft weder Credentials noch die
Firecrawl-Erreichbarkeit.

### Start und erste Prüfung

Für ein Registry-Image zunächst `docker compose pull stellara` ausführen. Bei
einem lokalen Image diesen Schritt auslassen. Anschließend:

```sh
docker compose up -d stellara
docker compose ps stellara
docker compose exec -T stellara node -e 'fetch("http://127.0.0.1:8787/health").then(r=>{console.log(r.status);process.exit(r.ok?0:1)}).catch(()=>process.exit(1))'
docker compose exec -T stellara node -e 'fetch("http://127.0.0.1:8787/ready").then(r=>{console.log(r.status);process.exit(r.ok?0:1)}).catch(()=>process.exit(1))'
```

`/health` meldet die Prozess-Liveness und steuert den Docker-Healthcheck. `/ready` prüft Firecrawl,
den OAuth-Speicher und alle aktivierten optionalen Abhängigkeiten; `503`
bedeutet, dass mindestens eine davon nicht bereit ist. Die beiden Endpunkte
sind außerdem über die konfigurierte HTTPS-Domain erreichbar. Stelle sicher,
dass der Proxy sie an Stellara weiterleitet und OAuth-Discovery, `/oauth/jwks`
sowie `/mcp` unter demselben öffentlichen Origin erreichbar sind. Ist
`/health` erfolgreich und `/ready` nicht, prüfe zuerst Firecrawl-Adresse,
Netzanschluss und Upstream-Logs. Der Firecrawl-Readiness-Probe ruft `GET /`
mit Bearer-Header auf; ein erfolgreicher Root-Request ersetzt keinen Test
der echten Scrape-Funktion oder der Kompatibilität der `/v1`-Endpunkte.

Prüfe, dass `./stellara-data/stellara.db` nach dem ersten Start angelegt wurde.
Ein Neustart mit `docker compose restart stellara` muss dasselbe Volume behalten.
Dieser Befehl prüft nur die Persistenz; geänderte `.env`-Werte werden dadurch
nicht in den vorhandenen Container übernommen. Registrierte OAuth-Clients und
der Signing-Key liegen im Volume; lösche es nicht für einen gewöhnlichen
Neustart.

### Optionale Funktionen einschalten

`EXA_API_KEY` aktiviert Exa-Suche. Speicherfunktionen benötigen
`QDRANT_BASE_URL`, `QDRANT_API_KEY` und `EMBEDDINGS_API_KEY` gemeinsam;
Collection und Dimensionen müssen zusammenpassen. Für Browser-Tools
`STELLARA_PLAYWRIGHT_ENABLED=true` setzen und den zusätzlichen RAM-Bedarf
einplanen. Für Domain-Tools `STELLARA_DOMAIN_ENABLED=true` setzen; WHOIS
benötigt ausgehendes TCP auf Port 43. Nach jeder Änderung an `.env` den
Container mit `docker compose up -d --force-recreate stellara` neu erstellen;
`docker compose restart` übernimmt die geänderten Umgebungswerte nicht. Nach
jeder Aktivierung `/ready` erneut prüfen. Die vollständigen Kombinationen stehen in der
[Konfigurationsreferenz](configuration.md).

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

Beim ersten Boot wird das Schema migriert und ein RSA-2048-Keypair erzeugt.
Der private Schlüssel wird nicht über die API ausgegeben, liegt aber in der
bind-gemounteten SQLite-Datei auf dem Host und in deren Sicherungen. Der
öffentliche Schlüssel ist über `GET /oauth/jwks` abrufbar.

**Sicherung:** `./stellara-data/stellara.db` enthält den privaten Signing-Key,
OAuth-Credentials und Fingerprints statischer Tokens. Auch Sicherungen sind
sensible Daten. Das isolierte Kopieren einer laufenden Datenbankdatei im
SQLite-WAL-Modus ist nicht konsistent. Die vollständige, angehaltene Kopie
steht unter [Sicherung und Wiederherstellung](#sicherung-und-wiederherstellung).

**UID/GID:** Der Container läuft als `app` (UID/GID `999`). Das gemountete Verzeichnis (und alle bestehenden Dateien darin) muss `999:999` gehören, sonst scheitert der Boot mit `SQLITE_CANTOPEN`. Beim Upgrade von einer früheren Alpine-basierten Stellara-Version (UID `100`) müssen die Eigentümer einmalig angepasst werden:

```sh
sudo docker compose stop stellara
sudo chown -R 999:999 ./stellara-data
sudo docker compose start stellara
```

## Sicherung und Wiederherstellung

Die folgenden Befehle laufen im Repository-Verzeichnis auf dem Docker-Host.
Sie verwenden eine kurze Betriebsunterbrechung und sichern das **gesamte**
Verzeichnis `stellara-data` einschließlich SQLite-Datei, möglicher WAL-Dateien
und Signing-Key. Für Restore ist zusätzlich eine lokale `sqlite3`-CLI nötig.
Wähle einen privaten Sicherungsort außerhalb des aktiven Datenverzeichnisses.
Der Beispielpfad liegt neben dem Checkout; passe ihn an einen geschützten,
regelmäßig gesicherten Speicherort an. Kopiere weder die laufende
`stellara.db` allein noch ein unvollständiges Verzeichnis.

### Vollständige Offline-Sicherung

Lies `REQUEST_TIMEOUT_MS` aus der Betreiberkonfiguration. `STOP_SECONDS` muss
**größer** als dessen Wert in Sekunden sein; `120` genügt nur für den Default
`90000` ms. Ein erzwungener Exit (typisch Exit-Code `137`) ist kein sauberer
Stop und darf nicht als Basis für diese Kopie dienen. Der folgende Check
bricht ab, bevor Daten gelesen werden:

```bash
set -euo pipefail
STOP_SECONDS=120
BACKUP_ROOT="$(pwd)/../stellara-backups"
BACKUP_ID="$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"
container_id="$(docker compose ps -q stellara)"
test -n "$container_id"
metadata="$BACKUP_ROOT/stellara-$BACKUP_ID.image.txt"
docker inspect --format 'configured-image={{.Config.Image}} image-id={{.Image}}' "$container_id" >"$metadata"
docker compose exec -T stellara node -e 'fetch("http://127.0.0.1:8787/oauth/jwks").then(r=>r.json()).then(j=>console.log(j.keys.map(k=>k.kid).join(",")))' >"$BACKUP_ROOT/stellara-$BACKUP_ID.jwks-kid.txt"
docker compose stop -t "$STOP_SECONDS" stellara
state="$(docker inspect --format '{{.State.Status}}:{{.State.ExitCode}}:{{.State.OOMKilled}}' "$container_id")"
if [ "$state" != 'exited:0:false' ]; then
  printf 'Stellara nicht sauber gestoppt (%s); Sicherung abgebrochen.\n' "$state" >&2
  exit 1
fi
archive="$BACKUP_ROOT/stellara-$BACKUP_ID.tar.gz"
test ! -e "$archive"
if ! sudo tar -czf - -C . stellara-data >"$archive"; then
  rm -f -- "$archive" "$metadata" "$BACKUP_ROOT/stellara-$BACKUP_ID.jwks-kid.txt"
  docker compose start stellara
  printf 'Sicherung fehlgeschlagen; unvollständiges Archiv entfernt.\n' >&2
  exit 1
fi
chmod 600 "$archive" "$metadata" "$BACKUP_ROOT/stellara-$BACKUP_ID.jwks-kid.txt"
docker compose start stellara
```

Notiere neben der Image-Referenz und der lokalen Image-ID die Version der
Compose-Datei sowie `PUBLIC_BASE_URL`, die konfigurierten OAuth-User-IDs und
welche optionalen Funktionen aktiv waren. **Tokenwerte, API-Keys,
Revocation-Werte und die `.env` nicht in der unverschlüsselten Metadatei
ablegen.** Sichere diese geheimen Werte getrennt in einem Secret Store. Wenn
der Stop oder Exit-Check fehlschlägt, zunächst Logs und Containerzustand
prüfen, den Dienst kontrolliert wiederherstellen und erst nach einem späteren
sauberen Stop erneut sichern. Ein laufender oder erzwungen beendeter Zustand
ist kein Erfolgssignal. `sudo tar` liest das nur für UID/GID `999` zugängliche
Datenverzeichnis; die Shell legt das Archiv mit der privaten `umask` im
operator-eigenen Sicherungsverzeichnis an. Prüfe nach der Sicherung `/ready`
wie beim Erststart.
Bewahre das Archiv mit Zugriff nur für Berechtigte und festgelegter
Aufbewahrungsdauer auf; lösche abgelaufene Kopien samt Metadaten aus allen
Ablagen nach deiner Retention-Regel. Nach Ablauf einer geprüften
Aufbewahrungsfrist die konkrete Archivgeneration und ihre beiden
Begleitdateien auswählen und mit `rm -- "$archive" "$metadata"
"$BACKUP_ROOT/stellara-$BACKUP_ID.jwks-kid.txt"` entfernen; vorher die
Dateinamen und ein neueres, geprüftes Backup kontrollieren.

### Archiv prüfen und Zustand wiederherstellen

Verwende ein Archiv aus der obigen Sicherung und das **dazu kompatible**
gepinnte Image. Vor einem Restore auf einem anderen Host müssen derselbe
`PUBLIC_BASE_URL`, dieselben OAuth-User-IDs, dieselben wirksamen statischen
Tokenwerte und dieselbe Revocation-Liste aus dem Secret Store bereitstehen.
Eine bewusste Änderung kann die unten beschriebene Autorisierungsbereinigung
auslösen. Lies die private Metadatei und prüfe das gewünschte Image, ohne
Secrets auszugeben. `ARCHIVE` und `STOP_SECONDS` vor Ausführung anpassen.
Die Archivprüfung und das Entpacken erfolgen **vor** dem Stop außerhalb des
aktiven Datenverzeichnisses. Die Prüfung verwirft fremde Pfade und
Traversal-Komponenten; das Archiv muss aus vertrauenswürdiger Quelle kommen.
Die SQLite-Integritätsprüfung öffnet nur die entpackte Staging-Kopie mit
Schreibzugriff: Bei einem WAL-Archiv kann SQLite dabei Sidecar-Dateien anlegen
oder aktualisieren. Das aktive Datenverzeichnis bleibt bis nach der Prüfung
unberührt. Auf einem neuen Zielhost zuerst die obigen Netz-, Konfigurations-,
Volume- und Erststartschritte abschließen, damit ein laufender Stellara-Container
für den Stop-Check existiert; dessen gerade erzeugter Datenstand bleibt als
`$previous` bis zur erfolgreichen Restore-Prüfung erhalten. Für `mktemp`
und beide `mv`-Befehle braucht der Betreiber Schreibrechte im
Repository-Verzeichnis. Das entpackte Staging-Verzeichnis bleibt bis zum
Verschieben im Besitz des Betreibers. Erst danach werden Besitzer und Rechte
des neuen Datenverzeichnisses für den Container gesetzt; `$previous` bleibt
unverändert für einen Rückweg erhalten.

```bash
set -euo pipefail
ARCHIVE="$(pwd)/../stellara-backups/stellara-YYYYMMDDTHHMMSSZ.tar.gz"
STOP_SECONDS=120
umask 077
test -f "$ARCHIVE"
tar -tzf "$ARCHIVE" | awk '
  $0 !~ /^stellara-data(\/|$)/ || $0 ~ /(^|\/)\.\.(\/|$)/ { bad=1 }
  END { exit bad }
'
stage="$(mktemp -d ./stellara-restore.XXXXXXXX)"
tar -xzf "$ARCHIVE" -C "$stage" --no-same-owner
test -s "$stage/stellara-data/stellara.db"
test -z "$(find "$stage/stellara-data" -type l -print -quit)"
test "$(sqlite3 "$stage/stellara-data/stellara.db" 'PRAGMA integrity_check;')" = ok
container_id="$(docker compose ps -q stellara)"
test -n "$container_id"
docker compose stop -t "$STOP_SECONDS" stellara
state="$(docker inspect --format '{{.State.Status}}:{{.State.ExitCode}}:{{.State.OOMKilled}}' "$container_id")"
if [ "$state" != 'exited:0:false' ]; then
  printf 'Stellara nicht sauber gestoppt (%s); Restore abgebrochen.\n' "$state" >&2
  exit 1
fi
previous="./stellara-data.before-restore.$(date -u +%Y%m%dT%H%M%SZ)"
test ! -e "$previous"
mv ./stellara-data "$previous"
mv "$stage/stellara-data" ./stellara-data
sudo chown -R 999:999 ./stellara-data
sudo find ./stellara-data -type d -exec chmod 700 {} +
sudo find ./stellara-data -type f -exec chmod 600 {} +
docker compose up -d stellara
```

Bricht der zweite `mv`-Befehl ab, das bisherige Verzeichnis sofort mit
`mv "$previous" ./stellara-data` zurücksetzen und den Container erst danach
starten. Schlagen `chown`, `chmod` oder der Boot nach dem zweiten Verschieben
fehl, den Container gestoppt lassen, das neue Verzeichnis unter einem anderen
Namen im Repository-Verzeichnis sichern und `$previous` mit `mv` als
`./stellara-data` zurücksetzen. Danach das zuvor verwendete Image starten;
vor einem weiteren Versuch Ursache und Schema-Kompatibilität klären. **Das alte Verzeichnis erst
nach erfolgreicher Prüfung löschen.** Prüfe `/health` und `/ready` per
`docker compose exec -T stellara` wie beim Erststart, den öffentlichen
HTTPS-OAuth-Discovery-Pfad und `/oauth/jwks`. Vergleiche den JWKS-`kid` mit
`stellara-<Backup-ID>.jwks-kid.txt` aus der Sicherung. Der im Erststart
gezeigte `docker compose exec`-Ansatz funktioniert auch für `/oauth/jwks`;
dessen `keys[].kid` muss gleich bleiben. Teste mit einem bestehenden OAuth-Client
die Anmeldung sowie Refresh- und Session-Nutzung. Bei einer Probe auf
wegwerfbaren Daten zusätzlich vor dem Backup einen Client und eine Sitzung mit
Refresh-Token erzeugen und nach dem Restore deren Fortbestand verifizieren.
Erst danach das vorige Verzeichnis und das leere Staging-Verzeichnis gemäß
der lokalen Retention-Regel entfernen. Das Archiv bleibt bis zum Ende der
festgelegten Aufbewahrung privat verfügbar.

### OAuth-Kontinuität, Upgrade und Rollback

Bei gleichem Image-Stand ab der in [#11](configuration.md#per-user-static-tokens)
beschriebenen Token-Snapshot-Einführung, unveränderten **wirksamen** Tokens,
User-IDs, Revocation-Liste und `PUBLIC_BASE_URL` bleiben die committed
OAuth-Clients, Refresh-Tokens, Sessions und der Signing-Key nach einem
vollständigen Restore erhalten. Das erste Upgrade **von einer Datenbank ohne
#11-Snapshot** löscht hingegen einmalig ausstehende Codes, Refresh-Tokens und
Sessions; Clients und Signing-Key bleiben erhalten. Entfernen oder Rotieren
eines zuvor wirksamen statischen Tokens löscht beim nächsten Boot die
zugehörigen Codes, Refresh-Tokens und Sessions; das bloße Hinzufügen eines
weiteren gültigen Tokens tut das nicht. Bereits ausgegebene Access-JWTs
bleiben bis zu ihrem `exp` gültig. Fehlt die persistierte Datenbank, gehen
registrierte Clients und Refresh-Tokens verloren; ein neuer Signing-Key macht
bestehende Access-JWTs ungültig.

Für ein Upgrade zuerst eine vollständige Sicherung anlegen, dann eine
**fest gepinnte** neue Image-Referenz in `.env` setzen und `docker compose
pull stellara` (Registry-Image) sowie `docker compose up -d stellara`
ausführen. Danach `/ready`, OAuth-Discovery, JWKS und einen echten
Client-Flow prüfen. Für einen Rollback das zuvor dokumentierte Image und die
passende Betreiberkonfiguration wiederherstellen. Ein Daten-Rollback nutzt
das **vor** dem Upgrade angelegte Archiv mit dem obigen Restore-Verfahren;
nie eine beliebige ältere Image-Version auf eine möglicherweise migrierte
neuere Datenbank starten. Ob ein älterer Build das neuere Schema oder
MCP-Protokoll lesen kann, ist releaseabhängig und muss vor dem Rollback
geprüft werden. Ein Rollback vor #11 bringt dessen frühere Lücke beim
OAuth-Token-Widerruf zurück; die Konfigurationsreferenz beschreibt diese
Grenze.

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

- **Token-Rotation und Widerruf:** Änderungen an `.env` mit `docker compose up -d --force-recreate stellara` übernehmen; `docker compose restart` reicht dafür nicht. Wird ein zuvor wirksamer statischer Token entfernt, rotiert oder neu in `STELLARA_REVOKED_TOKENS` aufgenommen, löscht der nächste Boot die ausstehenden OAuth-Codes, Refresh-Tokens und Sessions dieses Users in einer Transaktion. Zusätzlich hinzugefügte gültige Tokens ändern bestehende OAuth-Autorisierungen nicht. Bereits ausgegebene Access-JWTs bleiben bis zu ihrem `exp` gültig; eine Änderung der TTL wirkt nicht rückwirkend.
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
