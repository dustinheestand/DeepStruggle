/**
 * The play relay's Worker (README.md): makes rooms and routes each page's connection to its
 * room's Durable Object, which keeps the game's steps and passes them between the two pages.
 *
 *   POST /rooms                      {engine, password} -> {room, seed, seats: {US, USSR}}
 *   GET  /rooms/<room>?seat=<secret>                   -> the game so far (RoomSnapshot)
 *   GET  /rooms/<room>/ws?seat=<secret>  (WebSocket)   -> the live game (online_protocol.ts)
 *   POST /rooms/<room>/push?seat=<secret> {subscription, url} -> tell this phone when it is the seat's move
 *   POST /rooms/<room>/abandon?seat=<secret> {forfeit?} -> give the game up: abandon it (both lists
 *                                                         drop it) or resign it (the other side wins)
 *   POST /rooms/<room>/rewind?seat=<secret> {to, from} -> take the game back to its first `to` steps
 *   GET  /push-key                                     -> the VAPID public key to subscribe with
 *   GET  /health
 */
import { DurableObject } from "cloudflare:workers";
import {
  AbandonRequest, CreateRoomRequest, RewindRequest, CreateRoomResponse, NextToMove, PushKeyResponse, PushPayload, SEAT_NAMES, Seat, ServerMessage, SubscribeRequest,
} from "../../ui/src/game/online_protocol";
import {
  RoomData, addPushTarget, applyMove, onlineOf, parseClientMessage, presenceOf, removePushTarget, rewindRoom, seatOf, snapshot,
  syncMessage,
} from "./room";
import { isPushEndpoint, isSubscription, sendPush } from "./push";

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  /** Comma-separated origins the page is served from; unset or "*": any. */
  ALLOWED_ORIGINS?: string;
  /** VAPID (RFC 8292): the public key (uncompressed point, base64url), its private JWK (a secret),
   *  and the contact the push services are given. Without them no push is sent. */
  VAPID_PUBLIC?: string;
  VAPID_PRIVATE_JWK?: string;
  VAPID_SUBJECT?: string;
  /** The password for making rooms (a secret): unset, anyone may make one. Joining and playing a
   *  room need only its seat's link. */
  CREATE_PASSWORD?: string;
}

/** `a === b`, in time that does not depend on where they differ. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

const ROOM_RE = /^[A-Za-z0-9_-]{16,32}$/;

function randomToken(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function origins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? "*").split(",").map(s => s.trim()).filter(Boolean);
}

function allowedOrigin(req: Request, env: Env): string | null {
  const origin = req.headers.get("Origin");
  const list = origins(env);
  if (list.includes("*")) return origin ?? "*";
  return origin && list.includes(origin) ? origin : null;
}

function json(body: unknown, status: number, origin: string | null): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = allowedOrigin(req, env);
    if (req.method === "OPTIONS") {
      if (!origin) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
          "Vary": "Origin",
        },
      });
    }
    if (url.pathname === "/health") return json({ ok: true }, 200, origin);
    // A browser always names its page's origin on a POST and a WebSocket; anything else is refused.
    if (req.headers.get("Origin") !== null && !origin) return json({ error: "origin not allowed" }, 403, null);

    if (url.pathname === "/push-key" && req.method === "GET") {
      if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE_JWK) return json({ error: "no push here" }, 404, origin);
      const reply: PushKeyResponse = { key: env.VAPID_PUBLIC };
      return json(reply, 200, origin);
    }

    if (url.pathname === "/rooms" && req.method === "POST") {
      if (!origin) return json({ error: "origin not allowed" }, 403, null);
      const body = await req.json().catch(() => null) as Partial<Record<keyof CreateRoomRequest, unknown>> | null;
      if (env.CREATE_PASSWORD) {
        const given = typeof body?.password === "string" ? body.password : "";
        if (!(await sameSecret(given, env.CREATE_PASSWORD))) {
          return json({ error: given ? "wrong password" : "a password is needed to make a game" }, 401, origin);
        }
      }
      const engine = typeof body?.engine === "string" ? body.engine.slice(0, 128) : "";
      const room = randomToken(12);
      const seed = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
      const seats = { US: randomToken(18), USSR: randomToken(18) };
      const data: RoomData = { room, seed, engine, created: new Date().toISOString(), seats, steps: [] };
      await env.ROOMS.get(env.ROOMS.idFromName(room)).init(data);
      const reply: CreateRoomResponse = { room, seed, seats };
      return json(reply, 200, origin);
    }

    const m = url.pathname.match(/^\/rooms\/([^/]+)(\/ws|\/push|\/abandon|\/rewind)?$/);
    if (m && ROOM_RE.test(m[1])) {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
      const seat = url.searchParams.get("seat");
      if (m[2] === "/ws" && req.method === "GET") {
        if (req.headers.get("Upgrade") !== "websocket") return json({ error: "expected a WebSocket" }, 426, origin);
        return stub.fetch(req);
      }
      if (m[2] === "/push" && req.method === "POST") {
        if (!origin) return json({ error: "origin not allowed" }, 403, null);
        const body = await req.json().catch(() => null) as SubscribeRequest | null;
        const why = body ? subscriptionProblem(body.subscription) ?? seatPageProblem(body.url, m[1], env) : "no JSON body";
        if (why || !body) {
          const host = (() => { try { return new URL(String(body?.subscription?.endpoint)).host; } catch { return "?"; } })();
          console.log(`subscribe refused: ${why} (endpoint host ${host})`);
          return json({ error: `not a push subscription for this room: ${why}` }, 400, origin);
        }
        const ok = await stub.subscribe(seat, { subscription: body.subscription, url: body.url });
        return ok ? json({ ok: true }, 200, origin) : json({ error: "no such room or seat" }, 404, origin);
      }
      if (m[2] === "/abandon" && req.method === "POST") {
        if (!origin) return json({ error: "origin not allowed" }, 403, null);
        const body = await req.json().catch(() => null) as AbandonRequest | null;
        const ok = await stub.abandon(seat, body?.forfeit === true);
        return ok ? json({ ok: true }, 200, origin) : json({ error: "no such room or seat" }, 404, origin);
      }
      if (m[2] === "/rewind" && req.method === "POST") {
        const body = await req.json().catch(() => null) as Partial<Record<keyof RewindRequest, unknown>> | null;
        const r = await stub.rewind(seat, body?.to, body?.from);
        return r === null ? json({ ok: true }, 200, origin) : json({ error: r }, r === "no such room or seat" ? 404 : 409, origin);
      }
      if (!m[2] && req.method === "GET") {
        const snap = await stub.read(seat);
        return snap ? json(snap, 200, origin) : json({ error: "no such room or seat" }, 404, origin);
      }
    }
    return json({ error: "not found" }, 404, origin);
  },
};

/** Why a seat's page cannot be opened from a notification (it must be on the page's own origin and
 *  name this room), or null. */
function seatPageProblem(raw: unknown, room: string, env: Env): string | null {
  if (typeof raw !== "string" || raw.length > 600) return "the page address is missing or too long";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "the page address is not a URL";
  }
  const list = origins(env);
  if (!list.includes("*") && !list.includes(u.origin)) return `the page is not on an allowed origin (${u.origin})`;
  if (u.searchParams.get("room") !== room) return "the page address names another room";
  return null;
}

/** Why `v` is not a push subscription the relay may send to, or null. */
function subscriptionProblem(v: unknown): string | null {
  if (isSubscription(v)) return null;
  const s = v as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!s || typeof s.endpoint !== "string") return "no endpoint";
  if (!isPushEndpoint(s.endpoint)) {
    try {
      return `the endpoint is not a known push service (${new URL(s.endpoint).host})`;
    } catch {
      return "the endpoint is not a URL";
    }
  }
  if (typeof s.keys?.p256dh !== "string" || typeof s.keys?.auth !== "string") return "the subscription has no keys";
  return "the subscription is malformed";
}

interface Attachment {
  side: Seat;
  /** The page is in front of its player (its last "visible"; a page that has said nothing is). */
  visible: boolean;
}

/** One game. Its sockets hibernate between moves, so an idle game costs nothing. */
export class Room extends DurableObject<Env> {
  private data: RoomData | null | undefined = undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The page's keep-alive, answered without waking the room.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private async load(): Promise<RoomData | null> {
    if (this.data === undefined) this.data = (await this.ctx.storage.get<RoomData>("room")) ?? null;
    return this.data;
  }

  private async save(): Promise<void> {
    if (this.data) await this.ctx.storage.put("room", this.data);
  }

  async init(d: RoomData): Promise<void> {
    if (await this.load()) throw new Error("room exists");
    this.data = d;
    await this.save();
  }

  async read(secret: string | null) {
    const d = await this.load();
    const side = d ? seatOf(d, secret) : null;
    return d && side ? snapshot(d, side) : null;
  }

  async subscribe(secret: string | null, target: { subscription: SubscribeRequest["subscription"]; url: string }): Promise<boolean> {
    const d = await this.load();
    const side = d ? seatOf(d, secret) : null;
    if (!d || !side) return false;
    addPushTarget(d, side, target);
    await this.save();
    return true;
  }

  /** Abandon the game, or resign it (`forfeit`): either way no more moves. A resignation is told to
   *  the other side's phones as well. */
  async abandon(secret: string | null, forfeit = false): Promise<boolean> {
    const d = await this.load();
    const side = d ? seatOf(d, secret) : null;
    if (!d || !side) return false;
    if (!d.abandoned) {
      d.abandoned = { by: side, at: new Date().toISOString(), ...(forfeit ? { forfeit: true } : {}) };
      await this.save();
      this.broadcast({ t: "abandoned", ...d.abandoned });
      const winner = side === "US" ? "USSR" : "US";
      if (forfeit) await this.tell(d, winner, `${side} resigned -- ${winner} wins`);
    }
    return true;
  }

  /** Take the game back (rewindRoom), then send each page the list: null, or why not. */
  async rewind(secret: string | null, to: unknown, from: unknown): Promise<string | null> {
    const d = await this.load();
    const side = d ? seatOf(d, secret) : null;
    if (!d || !side) return "no such room or seat";
    const why = rewindRoom(d, to, from);
    if (why) return why;
    await this.save();
    const seen = this.seen();
    for (const s of this.sockets()) this.send(s.ws, syncMessage(d, s.a.side, seen));
    return null;
  }

  private sockets(except?: WebSocket): Array<{ ws: WebSocket; a: Attachment }> {
    const out: Array<{ ws: WebSocket; a: Attachment }> = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || ws.readyState !== WebSocket.OPEN) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a) out.push({ ws, a });
    }
    return out;
  }

  private seen(except?: WebSocket) {
    return presenceOf(this.sockets(except).map(s => ({ side: s.a.side, visible: s.a.visible !== false })));
  }

  private send(ws: WebSocket, m: ServerMessage): void {
    try {
      ws.send(JSON.stringify(m));
    } catch {
      // Closing: its close handler tells the others.
    }
  }

  private broadcast(m: ServerMessage, except?: WebSocket): void {
    const raw = JSON.stringify(m);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(raw);
      } catch {
        // Closing.
      }
    }
  }

  /** Tell every page the presences. `gone`: a socket closing, counted out and not told; `skip`: a
   *  socket counted but not told (the one just connected, which its sync told). */
  private presence(gone?: WebSocket, skip?: WebSocket): void {
    const seen = this.seen(gone);
    this.broadcast({ t: "presence", online: onlineOf(seen), seen }, gone ?? skip);
  }

  async fetch(req: Request): Promise<Response> {
    const d = await this.load();
    const side = d ? seatOf(d, new URL(req.url).searchParams.get("seat")) : null;
    if (!d || !side) return new Response("no such room or seat", { status: 404 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [side]);
    server.serializeAttachment({ side, visible: true } satisfies Attachment);
    server.send(JSON.stringify(syncMessage(d, side, this.seen())));
    this.presence(undefined, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const d = await this.load();
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!d || !a || !SEAT_NAMES.includes(a.side)) return;
    const msg = typeof raw === "string" ? parseClientMessage(raw) : null;
    if (!msg) {
      this.send(ws, { t: "error", why: "malformed message" });
      return;
    }
    if (msg.t === "visible") {
      ws.serializeAttachment({ ...a, visible: msg.visible } satisfies Attachment);
      this.presence();
      return;
    }
    if (msg.t === "activity") {
      for (const s of this.sockets()) if (s.a.side !== a.side) this.send(s.ws, { t: "activity", by: a.side });
      return;
    }
    const r = applyMove(d, msg, a.side);
    if (r.kind === "stale") {
      this.send(ws, syncMessage(d, a.side, this.seen()));
      return;
    }
    if (r.kind === "bad") {
      this.send(ws, { t: "error", why: r.why });
      return;
    }
    await this.save();
    this.broadcast(r.message);
    if (msg.next && msg.next.side !== a.side) await this.notify(d, msg.next);
  }

  /** It is `next.side`'s move: tell its phones, unless it has the game in front of it. */
  private async notify(d: RoomData, next: NextToMove): Promise<void> {
    if (d.abandoned) return;
    await this.tell(d, next.side, next.note ? `${next.note} -- your move` : "Your move");
  }

  /** Push `body` to `side`'s phones, unless it has the game in front of it. */
  private async tell(d: RoomData, side: Seat, body: string): Promise<void> {
    const env = this.env;
    if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE_JWK) return;
    if (this.seen()[side] === "here") return;
    const targets = d.push?.[side] ?? [];
    console.log(`telling ${side}: ${targets.length} phone(s)`);
    if (!targets.length) return;
    const vapid = {
      subject: env.VAPID_SUBJECT || "https://github.com/",
      publicKey: env.VAPID_PUBLIC,
      privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK) as JsonWebKey,
    };
    let changed = false;
    await Promise.all(targets.map(async t => {
      const payload: PushPayload = {
        title: "Twilight Struggle",
        body,
        url: t.url,
        tag: d.room,
      };
      try {
        const status = await sendPush(t.subscription, payload, vapid);
        console.log(`push to ${new URL(t.subscription.endpoint).host}: HTTP ${status}`);
        if (status === 404 || status === 410) {
          removePushTarget(d, side, t.subscription.endpoint);
          changed = true;
        }
      } catch (e) {
        console.warn("push failed:", e);
      }
    }));
    if (changed) await this.save();
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
    this.presence(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.presence(ws);
  }
}
