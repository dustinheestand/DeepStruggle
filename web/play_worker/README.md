# The play relay (`web/play_worker/`)

Two people playing each other, each in their own browser: on the phone page (`play.html`) or in
the workbench, which serve the same rooms. Each
page runs the engine itself. The game is a seed plus the list of steps both pages have agreed on,
and the dice come from the seed through the engine's PRNG, so the relay only passes steps around.
It never runs the engine. This Cloudflare Worker keeps one Durable Object per game, which holds that
list and pushes each new step to both pages over a WebSocket.

* `POST /rooms` `{engine}` → `{room, seed, seats: {US, USSR}}`: a new game. Each seat's secret is
  that player's link (`?room=<room>&seat=<secret>`). The maker's own link also carries
  `&invite=<the other secret>`, so the maker's page can show the invite again.
* `GET /rooms/<room>/ws?seat=<secret>`: the live game (`web/ui/src/game/online_protocol.ts`). On
  connect the relay sends `sync` (seed, side, every step); after that it sends `moves` (to both
  pages, so the mover's copy acts as its ack) and `presence`. A `move` is appended only at the index
  the room is at. Otherwise the relay answers with a fresh `sync`, and the page reconciles
  (`web/ui/src/game/online.ts`).
* `GET /rooms/<room>?seat=<secret>`: the game so far as JSON (seed and steps), for a script.
* `POST /rooms/<room>/push?seat=<secret>` `{subscription, url}`: notify this phone when it is the
  seat's move (at most 4 phones a seat), and `GET /push-key`: the VAPID public key to subscribe with.
  A `move` may carry `next: {side, note}`. When `side` is the other seat and that seat is not
  "here" (no socket whose page is in front of its player), the relay sends each of its phones a Web
  Push (`src/push.ts`: RFC 8291 encryption, RFC 8292 VAPID, on WebCrypto; only to known push
  services). A 404 or 410 drops the subscription.
* Presence: each socket's `visible` message makes its seat `here`, `away` or `offline` (`seen` in
  `sync` and `presence`). An `activity` message is passed to the other seat and not kept.
* `GET /health`: `{"ok": true}`.

**Trust.** This is for friends. Both pages know the seed, so a player who reads the page's memory
can work out the deck and the other hand. The relay does not know whose move it is. Each page
refuses to move for the other side, and each page checks every step by playing it in its own
engine. A step the engine refuses stops the game as *out of sync*, which in practice means the two
pages are on different builds. The room keeps the engine fingerprint of the page that made it, and
the other page warns on a mismatch.

**Analysis.** When the game is over, *Download game* in the online bar saves the full
`.tslog.json` replay, and the result dialog's *Download record* saves the compact record. Both
files work with the `deepstruggle-review` skill and the workbench's Replay Mode. The replay is
offered only after the game ends because it holds both hands at every step.

## Setting it up (once)

It needs a Cloudflare account (the free plan covers it: SQLite-backed Durable Objects and
hibernating WebSockets, so an idle game costs nothing) and node. From this directory:

```bash
npm install
npx wrangler login
npx wrangler deploy          # prints the Worker's URL: https://ts-play-relay.<subdomain>.workers.dev
```

For turn notifications, make a VAPID key pair (P-256): put its public key (uncompressed point,
base64url) in `wrangler.toml` as `VAPID_PUBLIC`, and its private JWK in the secret:
`npx wrangler secret put VAPID_PRIVATE_JWK < private.jwk.json`. Without them the relay sends no pushes,
and the page's bell does not appear to work (`/push-key` answers 404).

Then point the page at it. Set the repository variable `TS_PLAY_ENDPOINT` (Settings → Secrets and
variables → Actions → Variables) to the Worker's URL; `.github/workflows/pages.yml` passes it to
the build. Locally, use `TS_PLAY_ENDPOINT=<url> tools/scripts/build_web.sh`. A page built without
it does not offer the online game. `ALLOWED_ORIGINS` in `wrangler.toml` lists the origins the page
is served from.

## Testing locally

```bash
# terminal 1, in web/play_worker/
npx wrangler dev --port 8787                                  # http://localhost:8787
# terminal 2, in web/ui/
TS_PLAY_ENDPOINT=http://localhost:8787 npm run dev
```

Open `http://localhost:5173/`, choose *I play the US* under *Play a friend online*, and open the
invite link in a second browser profile (or on a phone on the same network, with both servers
started with `--ip 0.0.0.0` / `--host` and the phone's origin added to `ALLOWED_ORIGINS`).

`tests/web/test_online_play.py` plays a whole game between two pages through the room's own rules
(`src/room.ts`), with disconnects, moves made offline and a corrupted list. Both pages must end
on the same position as a page that plays the relay's list from the seed alone.
