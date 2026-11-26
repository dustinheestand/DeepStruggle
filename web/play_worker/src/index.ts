/**
 * The play relay's Worker (README.md): makes rooms and routes each page's connection to its
 * room's Durable Object, which keeps the game's steps and passes them between the two pages.
 *
 *   POST /rooms                      {engine}          -> {room, seed, seats: {US, USSR}}
 *   GET  /rooms/<room>?seat=<secret>                   -> the game so far (RoomSnapshot)
 *   GET  /rooms/<room>/ws?seat=<secret>  (WebSocket)   -> the live game (online_protocol.ts)
 *   GET  /health
 */
import { DurableObject } from "cloudflare:workers";
import {
  CreateRoomResponse, SEAT_NAMES, Seat, ServerMessage,
} from "../../ui/src/game/online_protocol";
import { RoomData, applyMove, parseClientMessage, seatOf, snapshot, syncMessage } from "./room";

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  /** Comma-separated origins the page is served from; unset or "*": any. */
  ALLOWED_ORIGINS?: string;
}

const ROOM_RE = /^[A-Za-z0-9_-]{16,32}$/;

function randomToken(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function allowedOrigin(req: Request, env: Env): string | null {
  const origin = req.headers.get("Origin");
  const list = (env.ALLOWED_ORIGINS ?? "*").split(",").map(s => s.trim()).filter(Boolean);
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

    if (url.pathname === "/rooms" && req.method === "POST") {
      if (!origin) return json({ error: "origin not allowed" }, 403, null);
      const body = await req.json().catch(() => null) as { engine?: unknown } | null;
      const engine = typeof body?.engine === "string" ? body.engine.slice(0, 128) : "";
      const room = randomToken(12);
      const seed = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
      const seats = { US: randomToken(18), USSR: randomToken(18) };
      const data: RoomData = { room, seed, engine, created: new Date().toISOString(), seats, steps: [] };
      await env.ROOMS.get(env.ROOMS.idFromName(room)).init(data);
      const reply: CreateRoomResponse = { room, seed, seats };
      return json(reply, 200, origin);
    }

    const m = url.pathname.match(/^\/rooms\/([^/]+)(\/ws)?$/);
    if (m && req.method === "GET" && ROOM_RE.test(m[1])) {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
      if (m[2]) {
        if (req.headers.get("Upgrade") !== "websocket") return json({ error: "expected a WebSocket" }, 426, origin);
        return stub.fetch(req);
      }
      const snap = await stub.read(url.searchParams.get("seat"));
      return snap ? json(snap, 200, origin) : json({ error: "no such room or seat" }, 404, origin);
    }
    return json({ error: "not found" }, 404, origin);
  },
};

interface Attachment {
  side: Seat;
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

  async init(d: RoomData): Promise<void> {
    if (await this.load()) throw new Error("room exists");
    await this.ctx.storage.put("room", d);
    this.data = d;
  }

  async read(secret: string | null) {
    const d = await this.load();
    const side = d ? seatOf(d, secret) : null;
    return d && side ? snapshot(d, side) : null;
  }

  private online(except?: WebSocket): Record<Seat, boolean> {
    const on: Record<Seat, boolean> = { US: false, USSR: false };
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || ws.readyState !== WebSocket.OPEN) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a) on[a.side] = true;
    }
    return on;
  }

  private broadcast(m: ServerMessage, except?: WebSocket): void {
    const raw = JSON.stringify(m);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(raw);
      } catch {
        // Closing: its close handler tells the others.
      }
    }
  }

  async fetch(req: Request): Promise<Response> {
    const d = await this.load();
    const side = d ? seatOf(d, new URL(req.url).searchParams.get("seat")) : null;
    if (!d || !side) return new Response("no such room or seat", { status: 404 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [side]);
    server.serializeAttachment({ side } satisfies Attachment);
    server.send(JSON.stringify(syncMessage(d, side, this.online())));
    this.broadcast({ t: "presence", online: this.online() }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const d = await this.load();
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!d || !a || !SEAT_NAMES.includes(a.side)) return;
    const msg = typeof raw === "string" ? parseClientMessage(raw) : null;
    if (!msg) {
      ws.send(JSON.stringify({ t: "error", why: "malformed message" } satisfies ServerMessage));
      return;
    }
    const r = applyMove(d, msg, a.side);
    if (r.kind === "stale") {
      ws.send(JSON.stringify(syncMessage(d, a.side, this.online())));
      return;
    }
    if (r.kind === "bad") {
      ws.send(JSON.stringify({ t: "error", why: r.why } satisfies ServerMessage));
      return;
    }
    await this.ctx.storage.put("room", d);
    this.broadcast(r.message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
    this.broadcast({ t: "presence", online: this.online(ws) }, ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.broadcast({ t: "presence", online: this.online(ws) }, ws);
  }
}
