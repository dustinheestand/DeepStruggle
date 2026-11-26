/**
 * One game room's rules, apart from the Durable Object that keeps it (index.ts), so they run under
 * node too (tests/web/js/online_play.ts).
 *
 * The room is the agreed list of steps. It does not run the engine and does not know whose turn
 * it is: each page refuses to move for the other side, and each page re-checks every step it is
 * sent by playing it. What the room guarantees is order: a step is appended only at the index the
 * room is at, so the list cannot fork.
 */
import {
  Abandoned, ClientMessage, MAX_BATCH, MAX_NOTE, MAX_STEPS, NextToMove, Presence, PushSubscriptionJSON, RoomSnapshot, SEAT_NAMES, Seat,
  ServerMessage, WireStep, isSeat, isWireStep,
} from "../../ui/src/game/online_protocol";

export interface RoomData {
  room: string;
  seed: number;
  /** The engine fingerprint of the page that made the room. */
  engine: string;
  created: string;
  seats: Record<Seat, string>;
  steps: WireStep[];
  /** Each seat's phones to tell when it is that seat's move, with the seat's page to open. */
  push?: Partial<Record<Seat, PushTarget[]>>;
  /** Set once a player abandons the game: no more moves, no more pushes. */
  abandoned?: Abandoned;
}

export interface PushTarget {
  subscription: PushSubscriptionJSON;
  url: string;
}

/** Most phones one seat keeps subscribed. */
export const MAX_PUSH_PER_SEAT = 4;

/** Add (or refresh) a seat's subscription, newest first. */
export function addPushTarget(d: RoomData, side: Seat, t: PushTarget): void {
  const list = (d.push ??= {})[side] ?? [];
  d.push[side] = [t, ...list.filter(x => x.subscription.endpoint !== t.subscription.endpoint)].slice(0, MAX_PUSH_PER_SEAT);
}

export function removePushTarget(d: RoomData, side: Seat, endpoint: string): void {
  const list = d.push?.[side];
  if (list) d.push![side] = list.filter(x => x.subscription.endpoint !== endpoint);
}

export type MoveResult =
  | { kind: "appended"; message: Extract<ServerMessage, { t: "moves" }> }
  /** The page's list is behind or ahead of the room's: send it the room's. */
  | { kind: "stale" }
  | { kind: "bad"; why: string };

/** The seat a secret opens, if any. */
export function seatOf(d: RoomData, secret: string | null): Seat | null {
  if (!secret) return null;
  for (const s of SEAT_NAMES) if (d.seats[s] === secret) return s;
  return null;
}

export function syncMessage(d: RoomData, side: Seat, seen: Record<Seat, Presence>): ServerMessage {
  return { t: "sync", seed: d.seed, engine: d.engine, side, steps: d.steps, online: onlineOf(seen), seen,
           ...(d.abandoned ? { abandoned: d.abandoned } : {}) };
}

/** Connected at all, from the presences (what pages before `seen` read). */
export function onlineOf(seen: Record<Seat, Presence>): Record<Seat, boolean> {
  return { US: seen.US !== "offline", USSR: seen.USSR !== "offline" };
}

/** A seat's presence from its sockets: here if any is in front of its player, away if any is open. */
export function presenceOf(sockets: Array<{ side: Seat; visible: boolean }>): Record<Seat, Presence> {
  const seen: Record<Seat, Presence> = { US: "offline", USSR: "offline" };
  for (const s of sockets) {
    if (s.visible) seen[s.side] = "here";
    else if (seen[s.side] === "offline") seen[s.side] = "away";
  }
  return seen;
}

export function snapshot(d: RoomData, side: Seat): RoomSnapshot {
  return { room: d.room, seed: d.seed, engine: d.engine, created: d.created, side, steps: d.steps,
           ...(d.abandoned ? { abandoned: d.abandoned } : {}) };
}

/** Parse a page's message. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const m = v as Record<string, unknown>;
  if (m.t === "visible") return typeof m.visible === "boolean" ? { t: "visible", visible: m.visible } : null;
  if (m.t === "activity") return { t: "activity" };
  if (m.t !== "move" || !Number.isInteger(m.at) || !Array.isArray(m.steps)) return null;
  if (m.steps.length === 0 || m.steps.length > MAX_BATCH || !m.steps.every(isWireStep)) return null;
  const msg: ClientMessage = { t: "move", at: m.at as number, steps: m.steps as WireStep[] };
  const n = m.next as NextToMove | undefined;
  if (n !== undefined) {
    if (typeof n !== "object" || n === null || !isSeat(n.side) || typeof n.note !== "string") return null;
    msg.next = { side: n.side, note: n.note.slice(0, MAX_NOTE) };
  }
  return msg;
}

/** Append `msg`'s steps if they start where the room is; changes `d` only when they do. */
export function applyMove(d: RoomData, msg: Extract<ClientMessage, { t: "move" }>, by: Seat): MoveResult {
  if (d.abandoned) return { kind: "bad", why: "the game was abandoned" };
  if (msg.at !== d.steps.length) return { kind: "stale" };
  if (d.steps.length + msg.steps.length > MAX_STEPS) return { kind: "bad", why: "the game is too long" };
  d.steps.push(...msg.steps.map(s => [...s] as WireStep));
  return { kind: "appended", message: { t: "moves", at: msg.at, steps: msg.steps, by } };
}
