// Bundled by tests/web/test_online_play.py: two people's game through the play relay, under node.
//   node online_play.mjs <public dir>
// Two pages, each with its own WebAssembly engine and GameSession, linked by an in-memory relay that
// runs the play Worker's own room rules (web/play_worker/src/room.ts). Each page moves only for its
// side, with random legal moves. Midway the USSR page drops off, the US moves while it is away, then
// the US drops off and makes moves the relay never gets before it comes back; and one page's list is
// corrupted so the relay's must replace it. The game must end the same on both pages and on a third
// page that plays the relay's list from the seed.
import { pathToFileURL } from "node:url";
import { WasmEngine } from "../../../web/ui/src/engine/wasm_engine";
import { GameSession } from "../../../web/ui/src/game/session";
import { Connect, LinkHandlers, OnlineGame, reconcile } from "../../../web/ui/src/game/online";
import { Seat, ServerMessage, WireStep, sameSteps } from "../../../web/ui/src/game/online_protocol";
import { applyWireSteps, sessionSteps, startOnlineGame } from "../../../web/ui/src/game/online_session";
import { RoomData, applyMove, parseClientMessage, seatOf, syncMessage } from "../../../web/play_worker/src/room";

const base = pathToFileURL(process.argv[2]).href;

/** The relay, as the Durable Object runs it, with messages delivered when pumped. */
class MemoryRelay {
  readonly data: RoomData;
  private sockets: { side: Seat; h: LinkHandlers; open: boolean }[] = [];
  private queue: (() => void)[] = [];

  constructor(seed: number, engine: string) {
    this.data = { room: "r".repeat(16), seed, engine, created: "now", seats: { US: "us-secret", USSR: "ussr-secret" }, steps: [] };
  }

  private online(): Record<Seat, boolean> {
    const on = { US: false, USSR: false };
    for (const s of this.sockets) if (s.open) on[s.side] = true;
    return on;
  }

  private deliver(to: { h: LinkHandlers; open: boolean }, m: ServerMessage): void {
    const raw = JSON.stringify(m);
    this.queue.push(() => { if (to.open) to.h.message(JSON.parse(raw)); });
  }

  connect(secret: string): Connect {
    return (h) => {
      const side = seatOf(this.data, secret);
      if (!side) throw new Error("bad seat");
      const sock = { side, h, open: true };
      this.sockets.push(sock);
      this.queue.push(() => {
        if (!sock.open) return;
        h.open();
        this.deliver(sock, syncMessage(this.data, side, this.online()));
        for (const o of this.sockets) if (o !== sock && o.open) this.deliver(o, { t: "presence", online: this.online() });
      });
      return {
        send: (m) => {
          const raw = JSON.stringify(m);
          this.queue.push(() => {
            if (!sock.open) return;
            const msg = parseClientMessage(raw);
            if (!msg) throw new Error(`the relay refused ${raw}`);
            const r = applyMove(this.data, msg, side);
            if (r.kind === "stale") this.deliver(sock, syncMessage(this.data, side, this.online()));
            else if (r.kind === "bad") throw new Error(r.why);
            else for (const o of this.sockets) if (o.open) this.deliver(o, r.message);
          });
        },
        close: () => {
          if (!sock.open) return;
          sock.open = false;
          this.queue.push(() => h.closed());
          for (const o of this.sockets) if (o.open) this.deliver(o, { t: "presence", online: this.online() });
        },
      };
    };
  }

  /** Deliver everything in flight (and what that sends). */
  pump(): void {
    for (let n = 0; this.queue.length; n++) {
      if (n > 100000) throw new Error("the relay does not settle");
      this.queue.shift()!();
    }
  }
}

interface Page {
  side: Seat;
  engine: WasmEngine;
  session: GameSession;
  game: OnlineGame;
  starts: number;
}

async function page(relay: MemoryRelay, secret: string, side: Seat): Promise<Page> {
  const engine = await WasmEngine.load(base);
  const session = new GameSession(engine);
  const p: Page = { side, engine, session, game: null as unknown as OnlineGame, starts: 0 };
  p.game = new OnlineGame(relay.connect(secret), {
    steps: () => sessionSteps(session),
    start: (seed) => { p.starts++; startOnlineGame(session, seed); },
    apply: (steps) => applyWireSteps(session, steps),
    changed: () => {},
  });
  return p;
}

function decider(e: WasmEngine): Seat | "" {
  const d = e.decisionPlayer();
  return d > 0 ? "US" : d < 0 ? "USSR" : "";
}

let x = 12345;
function rand(n: number): number {
  x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
  return x % n;
}

/** A random legal move, but none that ends the game before turn 6 while another is legal. */
function move(p: Page): void {
  const e = p.engine;
  for (let tries = 0; tries < 40; tries++) {
    const legal: number[] = [];
    e.mask(false).forEach((v, i) => { if (v) legal.push(i); });
    const why = p.session.applyFlat(legal[rand(legal.length)], false, 0, { source: "human", analysis: false });
    if (why) throw new Error(why);
    if (!e.isTerminal() || e.display().turn >= 6 || tries === 39) return;
    p.session.undo(false);
  }
}

const probe = await WasmEngine.load(base);
const relay = new MemoryRelay(424242, probe.fingerprint);
const us = await page(relay, "us-secret", "US");
const ussr = await page(relay, "ussr-secret", "USSR");
const pages = { US: us, USSR: ussr };
us.game.start();
ussr.game.start();
relay.pump();

const checks: Record<string, boolean> = {
  reconcile_rules:
    reconcile([[1, 2, 3, 4]], [[1, 2, 3, 4]]).kind === "same" &&
    reconcile([[1, 2, 3, 4]], [[1, 2, 3, 4], [5, 6, 7, 8]]).kind === "extend" &&
    reconcile([[1, 2, 3, 4], [5, 6, 7, 8]], [[1, 2, 3, 4]]).kind === "push" &&
    reconcile([[1, 2, 3, 9]], [[1, 2, 3, 4], [5, 6, 7, 8]]).kind === "rebuild",
  both_online_at_start: us.game.status === "online" && ussr.game.status === "online" && us.game.online.USSR && ussr.game.online.US,
  sides: us.game.side === "US" && ussr.game.side === "USSR",
};

let moves = 0;
let ussrAway = false;
let usOffline = false;
let corrupted = false;
let rebuiltOnCorruption = false;
let movedWhileAway = 0;
let movedOffline = 0;
let refusedForOtherSide = 0;
for (let n = 0; n < 20000 && !us.engine.isTerminal(); n++) {
  const side = decider(us.engine);
  if (!side) throw new Error("no one decides in a game that is not over");
  const p = pages[side];
  if (decider(p.engine) !== side) throw new Error(`the ${side} page is not at the US page's position`);
  const other = pages[side === "US" ? "USSR" : "US"];
  // The other page sees the decision as its opponent's (main.ts refuses a click then).
  if (decider(other.engine) === other.side) refusedForOtherSide++;
  move(p);
  moves++;
  p.game.push();

  // The USSR page drops off for a while; the US moves on without it.
  if (moves === 30) { ussr.game.stop(); ussrAway = true; }
  if (ussrAway && side === "US") movedWhileAway++;
  if (ussrAway && side === "USSR") throw new Error("the USSR moved while away");
  if (ussrAway && decider(us.engine) === "USSR") { ussrAway = false; ussr.game.start(); }

  // The US page loses its connection (its messages are lost) and keeps moving; then it comes back.
  if (moves >= 70 && side === "US" && movedOffline === 0 && !usOffline) {
    us.game.stop();
    usOffline = true;
  }
  if (usOffline && side === "US") movedOffline++;
  if (usOffline && decider(us.engine) === "USSR") {
    usOffline = false;
    us.game.start();
  }

  relay.pump();
  if (ussrAway || usOffline) {
    if (ussrAway && decider(us.engine) === "USSR" && !usOffline) throw new Error("waiting on an absent USSR");
    continue;
  }

  // Once: the USSR page's last step is replaced by another, legal or not; its next connect must
  // rebuild from the relay's list.
  if (!corrupted && moves >= 110 && !us.engine.isTerminal()) {
    corrupted = true;
    const before = ussr.starts;
    ussr.session.undo(false);
    move(ussr);   // a different step at the same index (or the same one: then nothing is rebuilt)
    const differs = !sameSteps(sessionSteps(ussr.session), relay.data.steps);
    ussr.game.stop();   // a reload: its next connect meets the relay's list
    ussr.game.start();
    relay.pump();
    rebuiltOnCorruption = !differs || ussr.starts === before + 1;
  }

  for (const q of [us, ussr]) {
    if (!sameSteps(sessionSteps(q.session), relay.data.steps)) throw new Error(`the ${q.side} page parted from the relay at move ${moves}`);
  }
}

// A third page: the relay's list from the seed alone, as a download would be played.
const replay = new GameSession(probe);
startOnlineGame(replay, relay.data.seed);
const replayWhy = applyWireSteps(replay, relay.data.steps);

const steps = relay.data.steps as WireStep[];
Object.assign(checks, {
  game_over: us.engine.isTerminal() && ussr.engine.isTerminal(),
  same_end: us.engine.saveJson() === ussr.engine.saveJson(),
  replay_same_end: replayWhy === null && probe.saveJson() === us.engine.saveJson(),
  same_result: JSON.stringify(us.session.result) === JSON.stringify(ussr.session.result),
  away_and_back: movedWhileAway >= 1,
  offline_moves_pushed: movedOffline >= 1,
  corruption_rebuilt: corrupted && rebuiltOnCorruption,
  other_side_never_decided: refusedForOtherSide === 0,
});
console.log(JSON.stringify({ checks, steps: steps.length, moves, result: us.session.result, movedWhileAway, movedOffline }));
