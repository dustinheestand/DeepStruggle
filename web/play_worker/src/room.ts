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
  ClientMessage, MAX_BATCH, MAX_STEPS, RoomSnapshot, SEAT_NAMES, Seat, ServerMessage, WireStep, isWireStep,
} from "../../ui/src/game/online_protocol";

export interface RoomData {
  room: string;
  seed: number;
  /** The engine fingerprint of the page that made the room. */
  engine: string;
  created: string;
  seats: Record<Seat, string>;
  steps: WireStep[];
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

export function syncMessage(d: RoomData, side: Seat, online: Record<Seat, boolean>): ServerMessage {
  return { t: "sync", seed: d.seed, engine: d.engine, side, steps: d.steps, online };
}

export function snapshot(d: RoomData, side: Seat): RoomSnapshot {
  return { room: d.room, seed: d.seed, engine: d.engine, created: d.created, side, steps: d.steps };
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
  if (m.t !== "move" || !Number.isInteger(m.at) || !Array.isArray(m.steps)) return null;
  if (m.steps.length === 0 || m.steps.length > MAX_BATCH || !m.steps.every(isWireStep)) return null;
  return { t: "move", at: m.at as number, steps: m.steps as WireStep[] };
}

/** Append `msg`'s steps if they start where the room is; changes `d` only when they do. */
export function applyMove(d: RoomData, msg: ClientMessage, by: Seat): MoveResult {
  if (msg.at !== d.steps.length) return { kind: "stale" };
  if (d.steps.length + msg.steps.length > MAX_STEPS) return { kind: "bad", why: "the game is too long" };
  d.steps.push(...msg.steps.map(s => [...s] as WireStep));
  return { kind: "appended", message: { t: "moves", at: msg.at, steps: msg.steps, by } };
}
