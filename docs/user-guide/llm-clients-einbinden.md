# Stellara in LLM-Apps einbinden

Diese Anleitung beschreibt Schritt für Schritt, wie du Stellara als MCP-Server in Claude Desktop, ChatGPT Connectors und andere LLM-Apps einbindest. Alle Beispiele verwenden den reservierten Beispielorigin:

```text
https://stellara.example.com
```

Ersetze ihn durch die `PUBLIC_BASE_URL` deines Deployments. Für Shell-Beispiele
kannst du denselben Wert als `BASE_URL` setzen:

```bash
BASE_URL=https://stellara.example.com
```

Der MCP-Endpunkt ist entsprechend:

```text
https://stellara.example.com/mcp
```

Stellara bevorzugt MCP `2026-07-28`. Aktuelle Clients erkennen den Server über
`server/discover` und benötigen keinen `initialize`-Handshake. Derselbe
Endpunkt akzeptiert während der Übergangszeit noch die initialisierungsbasierten
Versionen `2025-11-25`, `2025-06-18`, `2025-03-26` und `2024-11-05`. Für neue
Einbindungen solltest du keine Legacy-Version erzwingen.

## Authentifizierung

Stellara unterstützt zwei Authentifizierungswege.

### OAuth 2.1 mit PKCE

Das ist der bevorzugte Weg für grafische MCP-Clients wie Claude Desktop oder ChatGPT Connectors.

Der Client nutzt die öffentliche OAuth-Discovery:

```text
https://stellara.example.com/.well-known/oauth-authorization-server
```

Der geschützte MCP-Resource-Identifier lautet exakt:

```text
https://stellara.example.com/mcp
```

Die pfadspezifischen Resource-Metadaten liegen unter:

```text
https://stellara.example.com/.well-known/oauth-protected-resource/mcp
```

Beim ersten Verbinden öffnet die LLM-App einen Browser-Login. Dort gibst du deinen persönlichen `STELLARA_TOKEN_<USERID>`-Wert ein. Nach erfolgreicher Anmeldung erhält die App ein OAuth-Refresh-Token und ruft Stellara anschließend mit kurzlebigen Bearer-JWTs auf.

Der statische `STELLARA_TOKEN_<USERID>` bleibt dabei dein initiales Login-Geheimnis. Er wird nicht als dauerhaftes Client-Token in der App gespeichert, sofern der Client den OAuth-Flow unterstützt.

Stellara unterstützt zwei Arten der OAuth-Clientregistrierung. Bestehende
Clients können sich weiterhin per Dynamic Client Registration (DCR)
registrieren. Moderne Clients dürfen stattdessen eine HTTPS-URL mit
Dokumentpfad als `client_id` verwenden; Stellara lädt dann das Client-ID
Metadata Document (CIMD). Die Login-Seite zeigt den daraus verifizierten
Clientnamen und den exakten Redirect-Host. Bei einem localhost-Redirect
erscheint zusätzlich eine Warnung – prüfe in diesem Fall besonders, ob du
dieser lokalen App vertraust.

### Direkter Bearer Token

Für API-Clients, Skripte oder MCP-Clients ohne OAuth-Unterstützung kannst du den statischen Token direkt als HTTP-Header setzen:

```text
Authorization: Bearer <STELLARA_TOKEN_USERID>
```

Dieser Weg ist praktisch für Tests und Automatisierung, aber weniger komfortabel für Desktop-Apps, weil du den Token im Client speichern musst.

## Claude Desktop

Claude Desktop kann Stellara über Remote-MCP mit OAuth einbinden.

Unter macOS liegt die Konfiguration hier:

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

Unter Windows liegt sie hier:

```text
%APPDATA%\Claude\claude_desktop_config.json
```

Füge Stellara als HTTP-MCP-Server hinzu:

```json
{
  "mcpServers": {
    "stellara": {
      "type": "http",
      "url": "https://stellara.example.com/mcp",
      "oauth": {
        "discovery_url": "https://stellara.example.com/.well-known/oauth-authorization-server"
      }
    }
  }
}
```

Nach dem Neustart von Claude Desktop startet beim ersten Zugriff der Browser-Login. Gib dort deinen persönlichen Stellara-Token ein.

## ChatGPT Connector

In ChatGPT:

1. Öffne **Settings**.
2. Gehe zu **Connectors**.
3. Wähle **Add custom MCP server**.
4. Trage als Server-URL ein:

```text
https://stellara.example.com
```

ChatGPT erkennt die OAuth-Discovery-Endpoints automatisch, registriert sich per Dynamic Client Registration und startet anschließend den Browser-Login. Gib dort deinen persönlichen Stellara-Token ein.

Falls deine ChatGPT-Oberfläche ausdrücklich nach dem MCP-Endpunkt fragt, verwende stattdessen:

```text
https://stellara.example.com/mcp
```

## Andere MCP-Clients

Wenn der Client OAuth-Discovery unterstützt, verwende:

```text
Server: https://stellara.example.com
MCP:    https://stellara.example.com/mcp
OAuth: https://stellara.example.com/.well-known/oauth-authorization-server
Resource-Metadaten: https://stellara.example.com/.well-known/oauth-protected-resource/mcp
```

Wenn der Client nur eine HTTP-URL und Header unterstützt, verwende:

```json
{
  "type": "http",
  "url": "https://stellara.example.com/mcp",
  "headers": {
    "Authorization": "Bearer <STELLARA_TOKEN_USERID>"
  }
}
```

## Schnelltest mit curl

Mit einem gültigen Token kannst du den bevorzugten modernen Discovery-Aufruf
prüfen:

```bash
curl -sS \
  -X POST "${BASE_URL}/mcp" \
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

`STELLARA_TOKEN` ist hier nur eine lokale Shell-Variable. Ihr Wert muss deinem persönlichen `STELLARA_TOKEN_<USERID>` entsprechen.

Eine erfolgreiche Antwort enthält unter anderem `supportedVersions` mit
`2026-07-28`, `resultType: "complete"` und Stellaras Serverinformationen. Es
wird kein `Mcp-Session-Id` ausgegeben.

## Hinweise für Fehlerfälle

- Wenn der Client in einer Redirect-Schleife landet, ist meist die öffentliche Basis-URL des Deployments falsch konfiguriert. `PUBLIC_BASE_URL` muss exakt dem öffentlichen HTTPS-Origin entsprechen, den der Client aufruft.
- Wenn der Browser-Login „Invalid token" meldet, ist der eingegebene `STELLARA_TOKEN_<USERID>` ungültig oder rotiert worden.
- Wenn ein Client nach erfolgreichem Login später erneut fragt, kann das Refresh-Token abgelaufen oder serverseitig invalidiert worden sein. Melde dich dann erneut mit deinem Stellara-Token an.
- Wenn ein Client OAuth nicht unterstützt, nutze den direkten Bearer-Header.
- Wenn die Authorization mit `invalid_request` oder der Token-Austausch mit `invalid_target` endet, muss der Client den Resource-Identifier exakt als `${PUBLIC_BASE_URL}/mcp` senden. Abweichende Hosts, Querystrings oder Slash-Varianten werden nicht normalisiert.
- Wenn eine CIMD-basierte Anmeldung lokal mit HTTP 429 und `Retry-After` endet, hat die Quell-IP zu viele neue Metadaten-URLs in kurzer Zeit aufgelöst. Warte die angegebene Zeit ab. HTTP 503 mit `temporarily_unavailable` bedeutet, dass das globale CIMD-Fetch-Limit gerade ausgelastet ist; wiederhole den Verbindungsversuch später.
- Wenn ein selbst gebauter moderner Client `-32020`, `-32022` oder `-32602` erhält, prüfe die MCP-Header und die request-spezifische `_meta`. Unvollständige moderne Requests werden absichtlich nicht als Legacy interpretiert.
