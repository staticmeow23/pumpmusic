# Slotwave – pump.fun als Musik

CA eintragen, zuhören: Jeder Trade deiner Coins wird live zu einem Ton und einer Blase, im Takt von Solanas Slots.
Die Melodie folgt dem Kurs. Bis zu 3 Coins gleichzeitig, jeder in seiner Farbe.
Inspiriert von BitListen („Listen to Bitcoin“) und „Listen to Wikipedia“.

**Kosten: 0 €.** Die App ist eine einzige HTML-Datei, die sich direkt mit dem kostenlosen
öffentlichen Solana-RPC verbindet. Kein Server, keine Datenbank, keine API-Keys.

## Starten

**Live:** https://staticmeow23.github.io/pumpmusic/ (wird bei jedem Push auf `main` automatisch neu gebaut, nur wenn `npm run check` grün ist).

**Ohne Installation:** `dist/index.html` doppelklicken, „Start listening“ drücken.

**Mit Node (zum Weiterentwickeln):**

```bash
npm install
npm run dev        # baut bei jeder Änderung neu, http://localhost:5173
npm run check      # Typecheck + Tests + Build
```

**Offline testen** (ohne echtes Netz, mit echten Transaktions-Logs):

```bash
node scripts/mock-rpc.mjs            # Fake-RPC auf ws://127.0.0.1:8899
```

In der App dann „My own endpoint“ wählen und `ws://127.0.0.1:8899` eintragen.
Optionen: `--drop-after=6` (Verbindung bricht nach 6 s ab), `--refuse-logs` (RPC verweigert das Abo).

## Was man hört und sieht

| Ereignis | Ton | Bild |
|---|---|---|
| Kauf auf der Bonding Curve | Glocke (FM, wie BitListens Celesta) | gefüllte türkise Blase |
| Verkauf auf der Bonding Curve | gezupfte Saite, eine Oktave tiefer | gefüllte rosa Blase |
| Trade auf PumpSwap (graduierter Coin) | E-Piano, Verkäufe dunkler | Ring statt Blase |
| Neuer Coin | kleines Glitzer-Arpeggio | lila Stern mit Ticker |
| Bonding Curve voll | steigende Quinte | goldener Ring |
| Graduation (Migration zu PumpSwap) | großer Streicher-Swell + Gong | goldene Welle über den ganzen Bildschirm |
| Wal (≥ 3 % der Reserven) | zusätzlicher Sub-Bass | Druckwelle um die Blase |
| Fehlgeschlagene Transaktion (meist Bots) | fast unhörbarer Klick | winziger grauer Punkt |
| Jeder Slot | leiser Tick, Leader-Wechsel (alle 4 Slots) = Herzschlag | Leiste unten |
| Übersprungener Slot | digitaler Glitch | roter Strich in der Leiste |

**Regeln dahinter**

- **Groß = tief** (wie BitListen): Die Größe misst, wie viel Prozent der Pool-Reserven ein Trade bewegt.
  Das funktioniert auch für Coins, die nicht in SOL, sondern z. B. in USDC gehandelt werden.
- **Jeder Coin hat „seinen“ Ton:** Ein Hash der Mint-Adresse wählt die Tonstufe. Auch nach der Graduation behält der Coin seinen Ton, sobald die App seinen Pool kennt.
- **Links/rechts = Stereo:** Eine Blase erscheint dort, wo man ihren Ton hört.
- **Marktstimmung = Tonart:** Mehr Kaufdruck → Dur-Pentatonik, ausgeglichen → neutral, Verkaufsdruck → Moll-Pentatonik (mit Hysterese, damit es nicht flackert).
- **Grundton wechselt jede Epoche** (~24 h) im Quintenzirkel, Akkorde wechseln alle 32 Slots. Alles wird aus der Slot-Nummer berechnet: Wer gleichzeitig zuhört, hört denselben Song.
- **Takt = Netzwerk:** Die Uhr misst die echte Slot-Zeit (Regression über die letzte Minute). 4 Slots = 1 Schlag ≈ 75 BPM.
- **Puffer:** Slot S erklingt bei „Zeitpunkt von S + Puffer“ (Standard 1,2 s). So landen auch spät eintreffende Trades auf ihrem Slot und die Reihenfolge der Chain bleibt erhalten. Pro Slot spielt jedes Instrument höchstens 2 Noten; alles darüber wird trotzdem gezeichnet und macht das Pad heller.

## Coins hören (Hauptmodus)

- Eine oder mehrere **Contract Addresses (CA)** eintragen, getrennt durch Zeilen, Leerzeichen oder Kommas.
  pump.fun- und Solscan-Links funktionieren auch. Höchstens `MAX_COINS` (3) auf einmal.
- **Melodie = Kurs:** Jeder 3-%-Schritt über oder unter dem „Zuhause“-Preis ist ein Tonleiterschritt. Das Zuhause
  wandert langsam mit (Halbwertszeit 3 Minuten): Ein Pump steigt, ein Dump fällt, ein langes Plateau kehrt zur Mitte zurück.
- **Jeder Coin hat seine Farbe, Tonlage und Spalte** (links → rechts in der Reihenfolge der Eingabe).
  Kauf = gefüllte Blase + Glocke, Verkauf = Ring + gedämpfte, düstere Saite eine Oktave tiefer.
  Jede Blase zeigt den Ticker und darunter den Betrag (`$TICKER` / `+0.52 SOL`).
- **Rugpull-Alarm:** Nur wenn der **Dev** (Ersteller des Coins) in einem Zug mindestens **50 % seiner eigenen Tokens**
  verkauft (`RUG.devSellShare` in `src/config.ts`). Dann ertönt eine dissonante Orgel, rote Druckwellen laufen über den
  Bildschirm und der Feed meldet „⚠ $TICKER possible rug: dev sold 83 % of their tokens“. Den Bestand des Devs kennt die
  App aus den PumpSwap-Events, aus einer einmaligen Abfrage über das Relay oder (bei neuen Coins) von Anfang an.
  Verteilt der Dev seine Tokens vorher auf andere Wallets, sieht die App das nicht.
  Klick auf eine Blase öffnet die Transaktion auf Solscan.
- **Stats** pro Coin: Market Cap, Änderung seit dem Einschalten, Bonding-Curve-Fortschritt, Käufe/Verkäufe pro Minute.
- Der Link `#coins=<CA1>,<CA2>` öffnet die Seite mit diesen Coins.
- Ticker eines Coins, der schon vor dem Einschalten existierte: nur mit Helius-Endpunkt (ein `getAsset`-Aufruf), sonst steht dort die gekürzte CA.

## Relay (Daten ohne eigenen Key)

`relay/` ist ein Cloudflare Worker, der eine Helius-Verbindung hält und an alle Zuhörer verteilt
(ein Abo pro Coin, egal wie viele zuhören; Key bleibt geheim; Tagesbudget). Einrichtung: [relay/README.md](relay/README.md).
Sobald es läuft und `RELAY_WS_URL` in `src/config.ts` gesetzt ist, ist „Slotwave relay“ die Standard-Quelle.

## Ganzer Markt (Explore)

Über „Or explore the whole market“. Live gemessen: ~325 Trades/s und ~2,3 MB/s – als Musik eher Rauschen und für
Helius teuer. Gedacht zum Reinhören, vor allem mit der Demo.

## Bedienen (Marktmodus)

- **Blase anklicken = nur noch diesen Coin hören** (wie der Tag-Filter bei „Listen to Wikipedia“).
  Alle anderen Trades werden leise und blass, damit man den Markt drumherum noch sieht. Oben steht
  „Only $TICKER“ mit Link zu pump.fun und „Show all“ (oder Esc). Die Adresse bekommt `#coin=<mint>`,
  so lässt sich ein Coin als Link teilen.
- **Feed** (F): Liste der letzten Ereignisse wie das Edit-Log bei „Listen to Wikipedia“: neue Coins,
  volle Curves, Graduations, Trades ab 1 SOL und Wale. Im Fokus-Modus jeder Trade des Coins.
- **Stats** (S), **Mixer** (X), **Mute** (M).
- Lehnt der öffentliche RPC mehrmals hintereinander ab, bietet die App an, auf einen eigenen Endpunkt
  oder die Demo zu wechseln.

## Daten & Kosten

- Die App abonniert per `logsSubscribe` beide Pump-Programme (Bonding Curve `6EF8…F6P`, PumpSwap `pAMM…EA`) und per `slotSubscribe` die Slots.
- Die Trade-Daten stecken direkt in den Logs (`Program data:`, Anchor-Events). Es sind **keine Zusatzabfragen** nötig.
- **Sicherheit:** `Program data:` sagt nicht, welches Programm es geschrieben hat. Die App ordnet jede Zeile über den Aufruf-Stack in den Logs dem richtigen Programm zu. Gefälschte „Pump-Events“ anderer Programme (z. B. Wrapper oder andere Launchpads mit demselben Event-Format) werden ignoriert und im Panel als `foreign` gezählt.
- Das Panel **Data & cost** misst live, wie viele Daten ankommen, und rechnet aus, was derselbe Strom bei Helius kosten würde (2 Credits pro 0,1 MB).

**Ehrliche Einschätzung nach Messung mit echten Logs:** Eine Pump-Transaktion kommt mit ca. 5–7 KB an.
Bei ~12–15 Transaktionen pro Sekunde sind das grob 80–120 KB/s pro Zuhörer, also etwa
**0,3–0,4 GB pro Stunde Zuhören**. Über den öffentlichen RPC kostet das nichts, aber auf Mobilfunk merkt man es.
Über Helius wären das grob 4–7 Mio. Credits im Monat, also mehr als der Gratis-Plan (1 Mio.).
Die echte Zahl zeigt das Panel nach ein paar Minuten Live-Betrieb.

## Upgrade-Pfad (später, mit Helius)

1. **Sofort, für dich selbst:** Unter „My own endpoint“ deine Helius-WebSocket-URL eintragen
   (`wss://mainnet.helius-rpc.com/?api-key=…`). Schneller und stabiler als der öffentliche RPC.
   Der Key liegt dann im Browser, also nur für den eigenen Gebrauch, nicht auf einer öffentlichen Seite.
2. **Für eine öffentliche Seite:** ein kleiner Relay-Server mit **einer** Helius-Verbindung, der die Events dekodiert
   und kompakt (≈ 50 Bytes pro Trade statt ~6 KB) an alle Zuhörer verteilt. Kosten bleiben dann gleich, egal
   wie viele zuhören, und Zuhörer brauchen nur noch ~1 KB/s. Der Decoder (`src/pump/`) ist dafür schon
   unabhängig vom Browser und läuft genauso in Node.

## Aufbau

```
src/
  config.ts              Programm-IDs, Event-Diskriminatoren, alle Schwellwerte
  solana/encoding.ts     base58/base64, Hash
  solana/borsh.ts        Borsh-Reader (verträgt kürzere, ältere Event-Versionen)
  pump/events.ts         Decoder für TradeEvent, CreateEvent, Complete, Migration, Buy/Sell/CreatePool (PumpSwap)
  pump/logs.ts           Logs → Events, mit Programm-Zuordnung über den Aufruf-Stack
  stream/rpc-stream.ts   WebSocket-Client: Abos, Reconnect mit Backoff, Watchdog, Deduplizierung
  stream/demo-stream.ts  simulierter Datenstrom (offline)
  audio/clock.ts         Slot-Uhr (misst die echte Slot-Zeit)
  audio/theory.ts        Tonleitern, Akkorde, Stimmung
  audio/voices.ts        Instrumente (reines Web Audio, keine Samples)
  audio/engine.ts        Events → Noten + Bilder, Timing, Mixer
  viz/renderer.ts        Canvas mit Blasen, Wellen und Slot-Leiste
  ui/metrics.ts          Raten, Kostenabschätzung
  ui/feed.ts             Zeilen fürs Ereignis-Log
  ui/focus.ts            CA-Eingabe, teilbare Links (#coins=…)
  ui/coin-stats.ts       Market Cap, Änderung, Curve-Fortschritt pro Coin
  ui/labels.ts           Blasen-Beschriftung „$TICKER ±Betrag“
  stream/coin-demo.ts    simulierte Coins mit echter Curve-Formel (x·y=k)
  stream/coin-info.ts    Ticker per Helius getAsset
  main.ts                Oberfläche
scripts/build.mjs        baut alles in eine einzige dist/index.html
scripts/mock-rpc.mjs     Fake-RPC für Offline-Tests
test/                    Tests mit echten Transaktions-Logs
```

Keine Laufzeit-Abhängigkeiten. Entwicklungs-Tools: TypeScript, esbuild, tsx.

## Tests

`npm test` prüft u. a.:

- Dekodierung echter Transaktionen: Kauf über ein Wrapper-Programm, Create + erster Kauf (alt und neu),
  USDC-gehandelter Coin, PumpSwap-Verkauf.
- Die Erwartungswerte in `test/fixtures/expected.json` stammen aus einem **unabhängigen** Decoder,
  der direkt aus den offiziellen IDLs liest. Beide Decoder müssen übereinstimmen.
- Gefälschte Events von fremden Programmen werden ignoriert, kaputte Daten werfen nie.
- Slot-Uhr mit Jitter, übersprungenen Slots und Endpunkt-Wechsel; Musiktheorie; Kostenformel;
  API-Keys tauchen nie in der Anzeige auf.

## Bekannte Grenzen

- **Öffentlicher RPC:** Die App verbindet sich mit `api.mainnet.solana.com` (laut Solana-Doku der aktuelle Name)
  und weicht auf `api.mainnet-beta.solana.com` aus. Beim ersten Live-Test (Okt. 2026) haben beide die
  Verbindung aus dem Browser sofort geschlossen (Code 1006). Die Solana-Doku sagt, dass öffentliche Endpunkte
  IPs oder Websites sperren können (HTTP 403); der Browser zeigt den Grund nicht. Verlässlich ist daher ein
  eigener Endpunkt. Für den eigenen Gebrauch reicht der Helius-Gratis-Plan: 1 Mio. Credits = 50 GB,
  bei 0,3–0,4 GB pro Stunde also gut 100 Stunden Zuhören im Monat.
- Bei PumpSwap-Trades kennt das Event nur den Pool, nicht die Quote-Währung. Deshalb steht dort kein SOL-Betrag.
- Commitment `processed`: Trades werden so früh wie möglich gehört. Sehr selten kann eine Transaktion
  danach noch verworfen werden.

## Quellen

- Programm-IDs und Event-Layouts: offizielle IDLs, [pump-fun/pump-public-docs](https://github.com/pump-fun/pump-public-docs)
- Test-Fixtures: öffentliche On-Chain-Transaktions-Logs, entnommen aus den Testdaten von
  [chainstacklabs/pump-fun-bot](https://github.com/chainstacklabs/pump-fun-bot) (Apache-2.0)

Keine Finanzberatung.
