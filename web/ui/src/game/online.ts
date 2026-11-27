/**
 * Playing a friend: two pages, one game, through the play relay (web/play_worker/).
 *
 * Each page runs the engine; the relay keeps the agreed list of steps (online_protocol.ts). This
 * page sends the steps its player makes and plays the steps the relay sends, and the dice agree
 * because they come from the shared seed. It never trusts its own list over the relay's: on every
 * (re)connect the relay sends its list, and the page extends its own, pushes what the relay is
 * missing (moves made while offline -- only the side to move can move, so nothing else can be
 * waiting), or, if the two have parted, plays the relay's list again from the seed.
 *
 * The transport is a `Connect` so a test can link two pages without a network.
 */
import {
  AbandonRequest, Abandoned, ClientMessage, CreateRoomRequest, CreateRoomResponse, MAX_BATCH, NextToMove, Presence, PushKeyResponse,
  RoomSnapshot, Seat, ServerMessage, SubscribeRequest, WireStep, sameSteps,
} from "./online_protocol";

export interface Link {
  send(m: ClientMessage): void;
  close(): void;
}

export interface LinkHandlers {
  open(): void;
  message(m: ServerMessage): void;
  closed(): void;
}

export type Connect = (h: LinkHandlers) => Link;

/** What the page does for the online game. */
export interface OnlineHost {
  /** The steps of the game on the board. */
  steps(): WireStep[];
  /** A fresh game from `seed`, as `side` sees it. `engine`: the room maker's engine fingerprint. */
  start(seed: number, side: Seat, engine: string): void;
  /** Play `steps` after the last one; null, or why the engine refused one (nothing after it is played). */
  apply(steps: WireStep[]): string | null;
  /** The board, the status or the presence changed. */
  changed(): void;
  /** How many of `steps()` may be sent: the rest are the player's still to confirm (play.html keeps a
   *  move it can take back until it is sent). All of them when absent. */
  pushable?(): number;
  /** Who moves once the steps being sent are in, and the move in a few words: the relay tells that
   *  player's phone. Asked once per send; null or absent, nobody is told. */
  next?(): NextToMove | null;
  /** The other player tapped something (play.html pulses). */
  activity?(by: Seat): void;
}

export type OnlineStatus = "connecting" | "online" | "offline" | "desync";

export type Reconcile =
  | { kind: "same" }
  /** The relay has more: play its steps from `from`. */
  | { kind: "extend"; from: number }
  /** This page has more: send its steps from `from`. */
  | { kind: "push"; from: number }
  | { kind: "rebuild" };

/** How this page's list stands against the relay's. */
export function reconcile(local: readonly WireStep[], relay: readonly WireStep[]): Reconcile {
  const n = Math.min(local.length, relay.length);
  if (!sameSteps(local.slice(0, n), relay.slice(0, n))) return { kind: "rebuild" };
  if (local.length === relay.length) return { kind: "same" };
  return local.length < relay.length ? { kind: "extend", from: local.length } : { kind: "push", from: relay.length };
}

const RETRY_MS = [500, 1000, 2000, 4000, 8000, 15000];

export class OnlineGame {
  status: OnlineStatus = "connecting";
  side: Seat | null = null;
  seed: number | null = null;
  engine = "";
  online: Record<Seat, boolean> = { US: false, USSR: false };
  /** Each seat's presence: here (page in front of its player), away, offline. */
  seen: Record<Seat, Presence> = { US: "offline", USSR: "offline" };
  /** Set once either player gave the game up: no more moves. */
  abandoned: Abandoned | null = null;
  /** This page is in front of its player (the relay's presence, and whether to notify). */
  private visible = true;
  private lastActivity = 0;
  /** Why the game stopped agreeing with the relay, when it did. */
  error = "";
  private link: Link | null = null;
  private connected = false;
  /** The relay has, or has been sent, this page's steps up to here. */
  private sent = 0;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly connect: Connect, private readonly host: OnlineHost) {}

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    const link = this.link;
    this.link = null;   // closed by us: no retry
    link?.close();
  }

  /**
   * Back in front of the player (the tab shown, the network back): reconnect now if not connected
   * -- or, with `force`, anyway: a phone may have let the connection die without saying so.
   */
  wake(force = false): void {
    if (this.stopped || (this.connected && !force)) return;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const link = this.link;
    this.link = null;   // replaced, not lost: no retry
    link?.close();
    this.open();
  }

  /** Send the steps the player has made that the relay does not have. Call after every move. */
  push(): void {
    if (!this.connected || !this.link || this.status === "desync") return;
    const local = this.host.steps();
    const limit = Math.min(local.length, this.host.pushable?.() ?? local.length);
    if (this.sent >= limit) return;
    // Who moves next is the position after every step being sent: told with the last batch.
    const next = limit === local.length ? this.host.next?.() ?? null : null;
    while (this.sent < limit) {
      const batch = local.slice(this.sent, Math.min(limit, this.sent + MAX_BATCH));
      const last = this.sent + batch.length >= limit;
      this.link.send({ t: "move", at: this.sent, steps: batch, ...(last && next ? { next } : {}) });
      this.sent += batch.length;
    }
  }

  /** The page came in front of its player, or went behind something. */
  setVisible(v: boolean): void {
    this.visible = v;
    if (this.connected) this.link?.send({ t: "visible", visible: v });
  }

  /** The player tapped something: the other page is told, at most every two seconds. */
  activity(): void {
    const now = Date.now();
    if (!this.connected || now - this.lastActivity < 2000) return;
    this.lastActivity = now;
    this.link?.send({ t: "activity" });
  }

  private setPresence(online: Record<Seat, boolean>, seen?: Record<Seat, Presence>): void {
    this.online = online;
    this.seen = seen ?? { US: online.US ? "here" : "offline", USSR: online.USSR ? "here" : "offline" };
  }

  private open(): void {
    this.status = "connecting";
    this.connected = false;
    let link: Link | null = null;
    const current = () => link !== null && this.link === link;
    link = this.connect({
      open: () => {
        if (!current()) return;
        this.retries = 0;
      },
      message: (m) => {
        if (current()) this.onMessage(m);
      },
      closed: () => {
        if (!current()) return;
        this.connected = false;
        this.link = null;
        if (this.status !== "desync") this.status = "offline";
        this.setPresence({ US: false, USSR: false });
        this.host.changed();
        this.retry();
      },
    });
    this.link = link;
  }

  private retry(): void {
    if (this.stopped || this.retryTimer !== null) return;
    const ms = RETRY_MS[Math.min(this.retries++, RETRY_MS.length - 1)];
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped && this.link === null) this.open();
    }, ms);
  }

  /** The relay and this page disagree about a step: start over from its list. */
  private resync(): void {
    this.link?.close();
  }

  private fail(why: string): void {
    this.status = "desync";
    this.error = why;
    this.host.changed();
  }

  private onMessage(m: ServerMessage): void {
    if (m.t === "presence") {
      this.setPresence(m.online, m.seen);
      this.host.changed();
      return;
    }
    if (m.t === "activity") {
      this.host.activity?.(m.by);
      return;
    }
    if (m.t === "abandoned") {
      this.abandoned = { by: m.by, at: m.at, ...(m.forfeit ? { forfeit: true } : {}) };
      this.host.changed();
      return;
    }
    if (m.t === "error") {
      console.warn("play relay:", m.why);
      return;
    }
    if (m.t === "sync") {
      this.connected = true;
      this.status = "online";
      this.error = "";
      this.setPresence(m.online, m.seen);
      this.abandoned = m.abandoned ?? null;
      if (!this.visible) this.link?.send({ t: "visible", visible: false });
      if (this.seed !== m.seed || this.side !== m.side) {
        this.seed = m.seed;
        this.side = m.side;
        this.engine = m.engine;
        this.host.start(m.seed, m.side, m.engine);
      }
      const r = reconcile(this.host.steps(), m.steps);
      if (r.kind === "rebuild") {
        this.host.start(m.seed, m.side, m.engine);
      }
      if (r.kind === "rebuild" || r.kind === "extend") {
        const from = r.kind === "extend" ? r.from : 0;
        const why = this.host.apply(m.steps.slice(from));
        if (why) return this.fail(why);
      }
      this.sent = m.steps.length;
      this.host.changed();
      this.push();
      return;
    }
    // Moves: the other side's, or this page's own coming back.
    // Before this connection's sync, its list already holds them.
    if (this.status === "desync" || !this.connected) return;
    const local = this.host.steps();
    if (m.at > local.length) return this.resync();
    const overlap = Math.min(local.length - m.at, m.steps.length);
    if (!sameSteps(local.slice(m.at, m.at + overlap), m.steps.slice(0, overlap))) return this.resync();
    const rest = m.steps.slice(overlap);
    if (rest.length) {
      const why = this.host.apply(rest);
      if (why) return this.fail(why);
    }
    this.sent = Math.max(this.sent, m.at + m.steps.length);
    this.host.changed();
  }
}

/** The relay over a WebSocket, with a keep-alive that notices a connection a phone let die. */
export function webSocketConnect(url: string): Connect {
  return (h) => {
    const ws = new WebSocket(url);
    let last = Date.now();
    let timer: ReturnType<typeof setInterval> | null = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer !== null) clearInterval(timer);
      h.closed();
    };
    ws.onopen = () => {
      last = Date.now();
      timer = setInterval(() => {
        if (Date.now() - last > 45_000) {
          ws.close();
          finish();
          return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, 15_000);
      h.open();
    };
    ws.onmessage = (e) => {
      last = Date.now();
      if (e.data === "pong" || typeof e.data !== "string") return;
      try {
        h.message(JSON.parse(e.data) as ServerMessage);
      } catch (err) {
        console.warn("play relay: unreadable message", err);
      }
    };
    ws.onclose = finish;
    ws.onerror = () => ws.close();
    return {
      send: (m) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
      },
      close: () => {
        ws.close();
        finish();
      },
    };
  };
}

/** The relay's WebSocket address for a seat. */
export function roomSocketUrl(endpoint: string, room: string, seat: string): string {
  const base = endpoint.replace(/\/+$/, "").replace(/^http/, "ws");
  return `${base}/rooms/${encodeURIComponent(room)}/ws?seat=${encodeURIComponent(seat)}`;
}

export function roomSnapshotUrl(endpoint: string, room: string, seat: string): string {
  return `${endpoint.replace(/\/+$/, "")}/rooms/${encodeURIComponent(room)}?seat=${encodeURIComponent(seat)}`;
}

/** The relay refused the password for making rooms (HTTP 401). */
export class WrongPassword extends Error {}

export async function createRoom(endpoint: string, engine: string, password?: string): Promise<CreateRoomResponse> {
  const body: CreateRoomRequest = { engine, ...(password ? { password } : {}) };
  const res = await fetch(`${endpoint.replace(/\/+$/, "")}/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const reply = await res.json().catch(() => ({}));
  if (res.status === 401) throw new WrongPassword((reply as { error?: string }).error ?? "wrong password");
  if (!res.ok) throw new Error((reply as { error?: string }).error ?? `HTTP ${res.status}`);
  return reply as CreateRoomResponse;
}

const PASSWORD_KEY = "ts.play.password";

/**
 * Make a room, asking for the relay's password when it wants one: the password this browser last
 * used first, then the player's answer (remembered once it works). Null if the player gives up.
 * `ask` is the prompt, given whether the last password was refused.
 */
export async function createRoomAsking(endpoint: string, engine: string, ask: (refused: boolean) => string | null): Promise<CreateRoomResponse | null> {
  let password: string | undefined;
  try { password = localStorage.getItem(PASSWORD_KEY) ?? undefined; } catch { /* no storage */ }
  for (let refused = false; ; refused = true) {
    try {
      const r = await createRoom(endpoint, engine, password);
      try { if (password) localStorage.setItem(PASSWORD_KEY, password); } catch { /* no storage */ }
      return r;
    } catch (e) {
      if (!(e instanceof WrongPassword)) throw e;
      try { localStorage.removeItem(PASSWORD_KEY); } catch { /* no storage */ }
      const answer = ask(refused || password !== undefined);
      if (answer === null) return null;
      password = answer.trim();
    }
  }
}

/** The page's address for a seat of a room; `invite` (the maker's own link only) keeps the other seat's. */
export function seatLink(pageUrl: string, room: string, seat: string, invite?: string): string {
  const u = new URL(pageUrl);
  u.search = "";
  u.hash = "";
  u.searchParams.set("room", room);
  u.searchParams.set("seat", seat);
  if (invite) u.searchParams.set("invite", invite);
  return u.toString();
}

/** The relay's VAPID key, to subscribe with; null when the relay sends no pushes. */
export async function pushKey(endpoint: string): Promise<string | null> {
  const res = await fetch(`${endpoint.replace(/\/+$/, "")}/push-key`);
  if (!res.ok) return null;
  return ((await res.json()) as PushKeyResponse).key;
}

/** Tell the relay to push to this subscription when it is `seat`'s move in `room`. */
export async function subscribeSeat(endpoint: string, room: string, seat: string, body: SubscribeRequest): Promise<void> {
  const res = await fetch(`${endpoint.replace(/\/+$/, "")}/rooms/${encodeURIComponent(room)}/push?seat=${encodeURIComponent(seat)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
}

/** A seat's game as the relay keeps it (seed, steps, abandoned), for a list of games. */
export async function fetchRoom(endpoint: string, room: string, seat: string): Promise<RoomSnapshot> {
  const res = await fetch(roomSnapshotUrl(endpoint, room, seat));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as RoomSnapshot;
}

/** Give a game up: abandoned, both players' lists drop it; resigned (`forfeit`), the other side wins.
 *  The relay keeps its steps either way. */
export async function abandonRoom(endpoint: string, room: string, seat: string, forfeit = false): Promise<void> {
  const body: AbandonRequest = forfeit ? { forfeit: true } : {};
  const res = await fetch(`${endpoint.replace(/\/+$/, "")}/rooms/${encodeURIComponent(room)}/abandon?seat=${encodeURIComponent(seat)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
