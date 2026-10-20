# Slotwave – Projektkontext

> Übernommen aus SLOTWAVE_HANDOFF.md (Stand 20.10.2026). Nach Änderungen `npm run check` ausführen.


**Was es ist:** Slotwave macht pump.fun hörbar. Jede Transaktion auf der pump.fun Bonding Curve und auf PumpSwap wird live zu einem Ton und einer Blase, im Takt von Solanas Slots. Vorbilder: BitListen („Listen to Bitcoin“) und „Listen to Wikipedia“. Später soll es auf ganz Solana ausgeweitet werden (Zoom-Stufen: Netzwerk → Bereich → Token → Wallet).

**Nutzer:** spricht Deutsch (Antworten auf Deutsch, Code/Kommentare auf Englisch). Möchte, dass Claude selbst entscheidet, wie viel Aufwand eine Frage braucht. Arbeitet parallel an „Rug Guard“ (Telegram-Bot, gleicher Stack: TypeScript, Helius) – Decoder und Insider-Wissen könnten später geteilt werden.

**Entscheidungen**
- **Kurswechsel (Okt. 2026, nach Live-Test 2):** Hauptmodus ist jetzt „CA(s) eingeben → diese Coins hören“ (bis `MAX_COINS` = 5, endgültige Zahl offen). Grund: Der ganze Markt liefert ~2,3 MB/s (unbezahlbar, Musik nur Rauschen); ein Coin braucht grob 1–60 KB/s. Der Marktmodus bleibt als „Explore the whole market“.
- Coin-Modus: ein `logsSubscribe` mit `mentions: [mint]` pro Coin auf derselben Verbindung + `slotSubscribe`. Melodie = Kurs (1 Pentatonik-Schritt pro 3 % gegenüber einem mitwandernden Bezugspreis, Halbwertszeit 3 min), jeder Coin eigene Farbe (`COIN_COLORS`, Reihenfolge der Eingabe), eigene Tonlage, eigene Stereo-/Bildspalte. Kauf = gefüllte Blase + Glocke, Verkauf = Ring + Zupfen. Blasen zeigen „$TICKER ±Betrag“, Klick öffnet die Transaktion auf Solscan.
- PumpSwap-Events nennen nur den Pool: Pool→Coin wird gelernt, wenn eine Tx des Coins genau einen unbekannten Pool handelt und der Coin nicht (mehr) auf der Curve ist.
- Ticker eines bestehenden Coins: nur mit Helius-Endpunkt per DAS `getAsset` (ein Aufruf pro Coin), sonst kurze CA.
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
- Echte Pump-Logs: ca. 5–7 KB pro Transaktion. Die frühere Schätzung (12–15 Tx/s, 80–120 KB/s) ist durch Live-Test 2 widerlegt: real ~2,3 MB/s (siehe Status).

**Status**
- Fertig: Decoder + Log-Parser, WebSocket-Stream (Reconnect mit Backoff, Watchdog, Dedupe, API-Key-Maskierung), Demo-Stream, Slot-Uhr (Regression, Reset bei Sprüngen), Musiktheorie, 13 Instrumente + Pad, Engine, BitListen-artige Blasen-Visualisierung, Statistik-/Kosten-Panel, Mixer, Mobile-Layout, Fake-RPC (`scripts/mock-rpc.mjs`) mit echten Logs.
- Getestet: 35 Unit-Tests (echte Fixtures, abgeglichen mit unabhängigem IDL-Decoder), Headless-Chromium-Durchläufe (Demo, Mock-RPC mit Abbruch/Reconnect, abgelehntes Abo, Stop/Start, Mobile), Offline-Rendering aller Instrumente (Pegel ausbalanciert).
- Live auf GitHub Pages: https://staticmeow23.github.io/pumpmusic/ (Repo `staticmeow23/pumpmusic`, Deploy per GitHub Actions nach grünem `npm run check`).
- **Nicht getestet:** live gegen den öffentlichen RPC (Cloud-Umgebung blockiert die Hosts). Erster Live-Versuch des Nutzers mit `mainnet-beta` verband nicht → Endpunkt auf `api.mainnet.solana.com` umgestellt, mit automatischem Wechsel zwischen beiden. Offene Frage: erlaubt/drosselt der öffentliche RPC `logsSubscribe` auf Pump dauerhaft?

- Fokus-Modus (Blase anklicken → nur dieser Coin, `#coin=<mint>` teilbar), Feed (Ereignis-Log), Hilfekarte bei wiederholter RPC-Ablehnung (Okt. 2026).
- **Live-Test 1 (Nutzer, Okt. 2026):** `api.mainnet.solana.com` und `mainnet-beta` schließen die Verbindung von github.io sofort (1006). Vermutlich Website-/Origin-Sperre (Solana-Doku: 403 = IP oder Website gesperrt). Nächster Versuch: eigener Helius-Key (Free-Plan reicht für ~100+ h/Monat).
- **Live-Test 2 (Nutzer, Okt. 2026):** Mit eigenem Helius-Key („My own endpoint“) funktioniert der Live-Stream. **Gemessen (60-s-Mittel):** 325 Trades/s (Curve 38,5 Buys + 35 Sells, PumpSwap 252/s), 605 fehlgeschlagene Tx/s, 46 neue Coins/min, Stream **2,3 MB/s** (≈ 200 GB/Tag, ≈ 120 Mio. Helius-Credits/Monat bei Dauerbetrieb), Slotzeit 225 ms, Late 0 %, Decoder fallback 142 / foreign 100.299 / bad 0, Notes 5,7K vs. merged 58,3K. → Die Annahme 12–15 Tx/s war ~20× zu niedrig; der Helius-Free-Plan (50 GB) reicht nur für ~6 h Zuhören im Monat. Hauptlast: PumpSwap-Bot-/Arbitrage-Trades und fehlgeschlagene Bot-Tx.

- **Coin-Modus (Okt. 2026):** CA-Eingabe (auch mehrere, auch pump.fun-/Solscan-Links), teilbarer Link `#coins=A,B`, Kursmelodie, Stats pro Coin (Market Cap, Änderung seit Start, Curve-Fortschritt, Buys/Sells pro Minute), Demo mit simulierten Curves (x·y=k) inkl. Graduation. Getestet: Unit-Tests, Headless (Demo 3 Coins, Fake-RPC mit echtem Fixture-Coin: 33,8 SOL / 12,2 % korrekt, Marktmodus, Mobile). **Noch nicht live getestet.**

**Datenquellen für Zuhörer ohne eigenen Key (recherchiert Okt. 2026, noch nicht entschieden)**
- Öffentlicher RPC: blockt Websites (Live-Test 1) → raus.
- PumpPortal: seit 1.5.2026 `subscribeTokenTrade` nur mit API-Key + Wallet, 0,01 SOL pro 10.000 Trades; NewToken/Migration gratis. Key muss geheim bleiben → braucht Server.
- pumpdev.io: anonym 5 Abos, 20 Mints/Aufruf, 1 Verbindung/IP, 10k Trade-Nachrichten/Monat; Gratis-Key 50k/Monat; ab 49 $/Monat 1,5 Mio. Drittanbieter, Browser-Tauglichkeit ungeprüft.
- Eigenes Relay mit Helius-Key auf Cloudflare (Worker + Durable Object): Free 100k Requests/Tag, 13.000 GB-s/Tag; eingehende WS-Nachrichten 20:1 berechnet, ausgehende gratis; ausgehende WS (zu Helius) verhindert Hibernation → Laufzeit wird berechnet (ein DO mit 128 MB rund um die Uhr ≈ 11.000 GB-s/Tag, knapp im Free-Tier). Helius-Kosten pro Coin-Stunde statt pro Zuhörer. Ob Cloudflare-Free für ausgehende WS reicht: ungeprüft, nur per Test.

**Ideen aus ähnlichen Projekten (Backlog, Okt. 2026 recherchiert)**
- Listen to Wikipedia (hatnote): Position per Seed aus dem Titel (gleicher Coin = gleiche Stelle); Zähler „You have listened to N trades“; Einstellungen per URL-Hash; Rate gewichtet über 6×10-s-Buckets; harte Obergrenze gleichzeitiger Noten (haben wir).
- BitListen: Preis-Ticker (SOL/USD) – braucht externe Quelle, Kosten/Abhängigkeit vorher klären; Mindestgröße-Filter („nur Wale“); Instrumentwahl.
- Ethereum Listener / ethersong: Instrumentwahl pro Ereignis, Lautstärke je Ereignis (Mixer haben wir).
- Eine fertige Sonifikation für Solana wurde nicht gefunden → Slotwave wäre die erste.

**Nächste Schritte (Vorschlag)**
1. Live-Test mit dem öffentlichen RPC (`npm run dev`, Quelle „Public Solana RPC“): Stabilität, Late-%, echte Datenrate und Credit-Schätzung im Panel ablesen.
2. Je nach Ergebnis: Puffer/Notenlimits feinjustieren; Klang nach Gehör nachschärfen.
3. Später mit Helius: Relay-Server (eine Helius-Verbindung, kompakte Events ~50 B/Trade an alle Zuhörer); `src/pump/` läuft unverändert in Node.
4. Danach: Ausweitung auf ganz Solana mit Zoom-Stufen; Replays berühmter Momente; Hosting kostenlos (GitHub Pages / Cloudflare Pages).

**Arbeitsweise:** Vor Änderungen die betroffenen Module und ihre Verbindungen verstehen; Tests zuerst für Decoder/Parser; nach Änderungen `npm run check`; aktuelle Doku (Helius, pump-public-docs) prüfen statt aus dem Gedächtnis; Kosten vor jedem neuen Dienst mit dem Nutzer klären; nicht ohne Freigabe committen.

