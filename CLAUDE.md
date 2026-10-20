# Slotwave – Projektkontext

> Übernommen aus SLOTWAVE_HANDOFF.md (Stand 20.10.2026). Nach Änderungen `npm run check` ausführen.


**Was es ist:** Slotwave macht pump.fun hörbar. Jede Transaktion auf der pump.fun Bonding Curve und auf PumpSwap wird live zu einem Ton und einer Blase, im Takt von Solanas Slots. Vorbilder: BitListen („Listen to Bitcoin“) und „Listen to Wikipedia“. Später soll es auf ganz Solana ausgeweitet werden (Zoom-Stufen: Netzwerk → Bereich → Token → Wallet).

**Nutzer:** spricht Deutsch (Antworten auf Deutsch, Code/Kommentare auf Englisch). Möchte, dass Claude selbst entscheidet, wie viel Aufwand eine Frage braucht. Arbeitet parallel an „Rug Guard“ (Telegram-Bot, gleicher Stack: TypeScript, Helius) – Decoder und Insider-Wissen könnten später geteilt werden.

**Entscheidungen**
- Erst nur pump.fun (Bonding Curve `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` + PumpSwap `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`).
- **Vorerst 0 € Kosten:** reine statische Seite, Browser verbindet sich direkt mit dem öffentlichen RPC `wss://api.mainnet.solana.com` (Fallback: alter Name `api.mainnet-beta.solana.com`) (`logsSubscribe` je Programm + `slotSubscribe`). Später Helius kaufen und upgraden.
- Keine Laufzeit-Abhängigkeiten (eigener Borsh-Decoder, reines Web Audio, Canvas). Dev-Tools: TypeScript, esbuild, tsx (node:test). Build erzeugt **eine** selbstständige `dist/index.html`.
- Musik: Slot = Sechzehntel, 4 Slots (Leader-Fenster) = 1 Schlag (~75 BPM bei 200-ms-Slots). Groß = tief (Impact = Anteil an den Quote-Reserven). Coin-Hash → Tonstufe + Stereoposition. Pentatonik je nach Marktstimmung (bright/neutral/dark), Grundton pro Epoche, Akkordwechsel alle 32 Slots. Slot S erklingt bei timeOf(S) + Puffer (Standard 1,2 s); max. 2 Noten pro Instrument und Slot, Rest wird gezeichnet und hellt das Pad auf.

**Verifizierte Fakten (Okt. 2026)**
- Offizieller öffentlicher Mainnet-Endpunkt laut solana.com/docs/references/clusters: `api.mainnet.solana.com` (nicht mehr `mainnet-beta`). Limits: 100 Requests/10 s pro IP, 40 gleichzeitige Verbindungen, 100 MB pro 30 s.
- Programm-IDs und Event-Layouts aus den offiziellen IDLs (github.com/pump-fun/pump-public-docs). Pump emittiert Events als `Program data:`-Logs (zusätzlich zu emit_cpi), daher reicht `logsSubscribe` ohne Zusatzabfragen.
- Echte Events sind oft kürzer als die aktuelle IDL → Decoder liest den Anfang fest und den Rest best-effort.
- `Program data:` nennt kein Programm → Zuordnung über den invoke/success-Stack in den Logs; fremde Payloads werden verworfen (andere Launchpads nutzen denselben TradeEvent-Diskriminator).
- Coins mit USDC-Quote: `sol_amount` = 0, Größe über `quote_amount / virtual_quote_reserves`.
- PumpSwap Buy/SellEvent enthalten keine Mint, nur den Pool → Mapping Pool→Mint über CreatePoolEvent/Migration.
- Solana-Slotzeit seit 9.10.2026: 200 ms (SIMD-0525). Alpenglow (Finalität ~100–150 ms) für Agave 4.3 geplant – Datum prüfen.
- Helius: Free 1 Mio. Credits/Monat, Developer 49 $ / 10 Mio.; WebSocket-Streaming 2 Credits pro 0,1 MB; Free-Plan 5 gleichzeitige Verbindungen.
- Echte Pump-Logs: ca. 5–7 KB pro Transaktion → bei ~12–15 Tx/s grob 80–120 KB/s pro Zuhörer (0,3–0,4 GB/h) bzw. 4–7 Mio. Helius-Credits/Monat. Das Kosten-Panel misst den echten Wert.

**Status**
- Fertig: Decoder + Log-Parser, WebSocket-Stream (Reconnect mit Backoff, Watchdog, Dedupe, API-Key-Maskierung), Demo-Stream, Slot-Uhr (Regression, Reset bei Sprüngen), Musiktheorie, 13 Instrumente + Pad, Engine, BitListen-artige Blasen-Visualisierung, Statistik-/Kosten-Panel, Mixer, Mobile-Layout, Fake-RPC (`scripts/mock-rpc.mjs`) mit echten Logs.
- Getestet: 29 Unit-Tests (echte Fixtures, abgeglichen mit unabhängigem IDL-Decoder), Headless-Chromium-Durchläufe (Demo, Mock-RPC mit Abbruch/Reconnect, abgelehntes Abo, Stop/Start, Mobile), Offline-Rendering aller Instrumente (Pegel ausbalanciert).
- Live auf GitHub Pages: https://staticmeow23.github.io/pumpmusic/ (Repo `staticmeow23/pumpmusic`, Deploy per GitHub Actions nach grünem `npm run check`).
- **Nicht getestet:** live gegen den öffentlichen RPC (Cloud-Umgebung blockiert die Hosts). Erster Live-Versuch des Nutzers mit `mainnet-beta` verband nicht → Endpunkt auf `api.mainnet.solana.com` umgestellt, mit automatischem Wechsel zwischen beiden. Offene Frage: erlaubt/drosselt der öffentliche RPC `logsSubscribe` auf Pump dauerhaft?

**Nächste Schritte (Vorschlag)**
1. Live-Test mit dem öffentlichen RPC (`npm run dev`, Quelle „Public Solana RPC“): Stabilität, Late-%, echte Datenrate und Credit-Schätzung im Panel ablesen.
2. Je nach Ergebnis: Puffer/Notenlimits feinjustieren; Klang nach Gehör nachschärfen.
3. Später mit Helius: Relay-Server (eine Helius-Verbindung, kompakte Events ~50 B/Trade an alle Zuhörer); `src/pump/` läuft unverändert in Node.
4. Danach: Ausweitung auf ganz Solana mit Zoom-Stufen; Replays berühmter Momente; Hosting kostenlos (GitHub Pages / Cloudflare Pages).

**Arbeitsweise:** Vor Änderungen die betroffenen Module und ihre Verbindungen verstehen; Tests zuerst für Decoder/Parser; nach Änderungen `npm run check`; aktuelle Doku (Helius, pump-public-docs) prüfen statt aus dem Gedächtnis; Kosten vor jedem neuen Dienst mit dem Nutzer klären; nicht ohne Freigabe committen.

