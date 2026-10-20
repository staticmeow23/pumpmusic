# Slotwave-Relay

Ein kleiner Cloudflare Worker, der **eine** Verbindung zu Helius hält und die Trades an alle Zuhörer
verteilt. Dein Helius-Key bleibt dabei geheim: Er liegt nur als verschlüsseltes Secret bei Cloudflare,
nie im Browser.

```
Browser ─┐
Browser ─┼──► Relay (Cloudflare) ──► Helius
Browser ─┘    1 Abo pro Coin, egal wie viele zuhören
```

## Was das Relay erlaubt (und was nicht)

- Nur `logsSubscribe` mit **genau einer** Adresse, `slotSubscribe` und die passenden Unsubscribes.
  Alles andere wird abgelehnt. Niemand kann deinen Key für andere Zwecke benutzen.
- Höchstens **3 Coins pro Zuhörer** (wie in der App), höchstens 25 verschiedene Coins und 200 Zuhörer gleichzeitig.
- **Tagesbudget:** Nach 1,5 GB Daten von Helius pro Tag (≈ 30.000 Credits, ≈ 0,9 Mio. im Monat) stoppt das
  Relay bis Mitternacht UTC. So bleibt es im Helius-Gratis-Plan. Ändern mit der Variable `DAILY_BYTES`.
- **Schutz vor Missbrauch:** Liefert eine Adresse mehr als 30 MB pro Minute (z. B. jemand abonniert ein ganzes
  Programm statt eines Coins), wird sie für den Rest des Tages gesperrt.
- Nur die Slotwave-Seite darf sich verbinden (`ALLOWED_ORIGINS` in `wrangler.toml`).
- Hört niemand zu, schließt das Relay nach 30 Sekunden die Verbindung zu Helius: Dann kostet es nichts.

## Einrichten (einmalig, ca. 10 Minuten)

Du brauchst: einen Computer mit [Node.js](https://nodejs.org) (Version 20 oder neuer), deinen Helius-Key
und ein kostenloses Cloudflare-Konto ([dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up)).

1. **Code holen und installieren** (im Terminal):
   ```bash
   git clone https://github.com/staticmeow23/pumpmusic.git
   cd pumpmusic/relay
   npm install
   ```
2. **Bei Cloudflare anmelden** (öffnet den Browser, dort „Allow“ klicken):
   ```bash
   npx wrangler login
   ```
3. **Veröffentlichen:**
   ```bash
   npx wrangler deploy
   ```
   Beim ersten Mal fragt Cloudflare evtl. nach einer eigenen Subdomain (z. B. `deinname`), dann geht es weiter.
   Am Ende steht eine Adresse wie `https://slotwave-relay.deinname.workers.dev`.
4. **Helius-Key hinterlegen** (der Befehl fragt nach dem Wert, er wird nicht angezeigt):
   ```bash
   npx wrangler secret put HELIUS_WS_URL
   ```
   Einfügen: `wss://mainnet.helius-rpc.com/?api-key=DEIN_KEY`
5. **Prüfen:** `https://slotwave-relay.deinname.workers.dev/health` im Browser öffnen. Es sollte etwas wie
   `{"clients":0,"coins":0,"upstream":false,"dayBytes":0}` erscheinen.
6. **Die Adresse an Claude schicken.** Claude trägt sie in die App ein (`RELAY_WS_URL` in `src/config.ts`,
   mit `wss://` und `/ws` am Ende), danach steht „Slotwave relay“ als Standard-Quelle in der App.

## Überwachen

- `…/health` zeigt Zuhörer, Coins, ob Helius verbunden ist und die heutigen Bytes.
- Cloudflare-Dashboard → Workers & Pages → slotwave-relay: Anfragen, Fehler, Logs.
- Helius-Dashboard: verbrauchte Credits.

## Kosten

- **Helius:** 2 Credits pro 0,1 MB. Das Tagesbudget hält das Relay im Gratis-Plan (1 Mio. Credits/Monat).
- **Cloudflare:** Gratis-Plan mit 100.000 Anfragen und 13.000 GB-Sekunden Durable-Object-Laufzeit pro Tag.
  Ausgehende WebSocket-Nachrichten sind kostenlos, eingehende zählen 20:1. Weil das Relay eine Verbindung zu
  Helius hält, läuft es, solange jemand zuhört (rund um die Uhr wären das ~11.000 GB-s/Tag: knapp im Gratis-Rahmen).
  Wird ein Limit überschritten, antwortet Cloudflare mit Fehlern, es entstehen **keine** Kosten.
  Ob der Gratis-Plan im Alltag reicht, zeigt erst der echte Betrieb.

## Lokal testen (ohne Cloudflare-Konto)

```bash
# Terminal 1, im Projektordner: Fake-RPC mit echten Transaktions-Logs
node scripts/mock-rpc.mjs
# Terminal 2, in relay/:
printf 'HELIUS_WS_URL=ws://127.0.0.1:8899\nALLOWED_ORIGINS=\n' > .dev.vars
npx wrangler dev
```
In der App „My own endpoint“ → `ws://127.0.0.1:8787/ws`.
