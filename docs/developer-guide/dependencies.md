# Externe Runtime-Dependencies

Audit-Trail für ausgewählte Runtime-Dependencies mit Sicherheits- oder Maintenance-Relevanz. Verzeichnet Maintainer, Release-Stand und Bedrohungsmodell-Bewertung zum Zeitpunkt der Aufnahme. Bei späteren Renovate-Bumps wird der jeweilige Eintrag aktualisiert; bei Sicherheits-Audits dient die Datei als Einstiegspunkt.

---

## MCP TypeScript SDK v2 (`@modelcontextprotocol/*@2.0.0`)

- **Runtime-Pakete:** [`@modelcontextprotocol/server`](https://www.npmjs.com/package/@modelcontextprotocol/server), [`@modelcontextprotocol/node`](https://www.npmjs.com/package/@modelcontextprotocol/node)
- **Test-Paket:** [`@modelcontextprotocol/client`](https://www.npmjs.com/package/@modelcontextprotocol/client) als Dev-Dependency
- **Quell-Repository:** [`modelcontextprotocol/typescript-sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
- **Maintainer laut Paketmetadaten:** Anthropic, PBC
- **Lizenz:** MIT
- **Geprüfter Stand:** 2.0.0 am 25. August 2026; alle drei Pakete sind exakt auf dieselbe Version gepinnt
- **Einsatz:** Moderner MCP-`2026-07-28`-Serverrand, Node-/Fastify-Bridge und hermetischer offizieller Clienttest

### Bedrohungsmodell

`@modelcontextprotocol/server` verarbeitet den modernen, extern erreichbaren
MCP-Protokollrand und besitzt damit sicherheitsrelevante Parsing-, Header-,
Metadaten- und Fehlersemantik. Stellara verwendet ausschließlich öffentliche
High-Level-Exports (`McpServer`, `createMcpHandler`, `isLegacyRequest`) und
konfiguriert den Handler strikt mit JSON-Antworten und abgelehntem SDK-Legacy-
Fallback. Der kurze Legacy-Pfad bleibt bewusst in Stellaras isoliertem
JSON-Dispatcher; es werden weder `@modelcontextprotocol/core-internal` noch
kopierte SDK-Interna importiert.

`@modelcontextprotocol/node` konvertiert Fastifys bereits authentifizierte
Node-Requests in den SDK-Handler und schreibt direkt auf die rohe Response.
Origin-Prüfung, Authentifizierung, User-Isolation und Rate Limits bleiben
deshalb vor dieser Bridge in Stellara. Ein Upgrade muss insbesondere
Fastify-Hijacking, Body-Übergabe, Handler-Shutdown und das Ausbleiben von
`Mcp-Session-Id` erneut testen.

`@modelcontextprotocol/client` läuft nur in Tests. Es prüft die automatische
Negotiation des modernen Pfads und die noch zugesagte Legacy-Kompatibilität
gegen denselben lokalen Server. Die drei Pakete werden gemeinsam aktualisiert,
weil voneinander abweichende SDK-Versionen Wire- und Typverträge auseinander
ziehen können. Bei Renovate-Updates sind mindestens die modernen MCP-Tests,
der SDK-Clienttest und das vollständige Quality Gate auszuführen.

---

## playwright-extra@4.3.6

- **npm-Paket:** [`playwright-extra`](https://www.npmjs.com/package/playwright-extra)
- **Quell-Repository:** `git+https://github.com/berstend/puppeteer-extra.git` (Monorepo)
- **Maintainer:** berstend
- **Lizenz:** MIT
- **Letzter Release:** 2023-03-01
- **Einsatz im Code:** [`src/services/playwright-pool.ts`](../../src/services/playwright-pool.ts)

### Bedrohungsmodell

Single-Maintainer-Paket im Maintenance-Mode – neue Features sind nicht zu erwarten. Das Paket erweitert die `playwright`-API um ein Plugin-System; die eigentliche Stealth-Logik liegt in `puppeteer-extra-plugin-stealth`. Akzeptiert für den Einsatz gegen Cloudflare- und Akamai-Light-Detection. Neu zu bewerten bei aktiver Detection-Eskalation oder einem Sicherheits-Audit, da ein Single-Maintainer-Account mit unveröffentlichten Push-Rechten ein erhöhtes Supply-Chain-Risiko darstellt.

---

## puppeteer-extra-plugin-stealth@2.11.2

- **npm-Paket:** [`puppeteer-extra-plugin-stealth`](https://www.npmjs.com/package/puppeteer-extra-plugin-stealth)
- **Quell-Repository:** `git+https://github.com/berstend/puppeteer-extra.git` (Monorepo, gleich wie oben)
- **Maintainer:** berstend
- **Lizenz:** MIT
- **Letzter Release:** 2023-04-11
- **Einsatz im Code:** [`src/services/playwright-pool.ts`](../../src/services/playwright-pool.ts)

### Bedrohungsmodell

Gleiche Single-Maintainer- und Maintenance-Mode-Einschätzung wie `playwright-extra`. Das Plugin injiziert eine Reihe von Browser-Evasions (ua-override, navigator-platform, webgl-vendor u. a.), die als Browser-Context-Patches wirken. Akzeptiert für Cloudflare- und Akamai-Light-Detection. Neu zu bewerten bei aktiver Detection-Eskalation oder einem Sicherheits-Audit.
