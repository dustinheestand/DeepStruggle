/**
 * The wire protocol between the page (game/online.ts) and the play relay (web/play_worker/).
 *
 * A game between two people is a seed and the list of steps both have agreed on: each page runs
 * the engine itself, and the dice come from the seed through the engine's own PRNG, so a step is
 * just its MicroAction. The relay never runs the engine. It keeps the list, appends a step only
 * at the index it already has (so two pages cannot both write step n), and tells both pages.
 *
 * Imported by the Worker too: keep it free of anything but types and plain functions.
 */

export type Seat = "US" | "USSR";
export const SEAT_NAMES: readonly Seat[] = ["US", "USSR"];

/** One step: decision_type, primary_id, secondary_id, flags. */
export type WireStep = [number, number, number, number];

/** The most steps one game may hold (a game is about 500), and one message may add. */
export const MAX_STEPS = 6000;
export const MAX_BATCH = 16;

/** POST /rooms: the page making the room says which engine it runs, so the other can check. */
export interface CreateRoomRequest {
  engine: string;
}

/** POST /rooms answers with the room and one secret per seat: the link a player opens. */
export interface CreateRoomResponse {
  room: string;
  seed: number;
  seats: Record<Seat, string>;
}

/** GET /rooms/<room>?seat=<secret>: the game so far, for a download or a script. */
export interface RoomSnapshot {
  room: string;
  seed: number;
  engine: string;
  created: string;
  side: Seat;
  steps: WireStep[];
  abandoned?: Abandoned;
}

/** A game one player gave up on: it leaves both players' lists; its steps are kept. */
export interface Abandoned {
  by: Seat;
  at: string;
}

/** A seat's presence: its page open in front of its player, open behind something (a background
 *  tab, a locked phone), or not connected. */
export type Presence = "here" | "away" | "offline";

export type ServerMessage =
  /** On connecting, and again whenever the page's view of the list is out of date. */
  | { t: "sync"; seed: number; engine: string; side: Seat; steps: WireStep[]; online: Record<Seat, boolean>; seen?: Record<Seat, Presence>; abandoned?: Abandoned }
  /** Steps appended at `at`, by `by`: sent to both pages, so the mover's copy is its ack. */
  | { t: "moves"; at: number; steps: WireStep[]; by: Seat }
  | { t: "presence"; online: Record<Seat, boolean>; seen?: Record<Seat, Presence> }
  /** The other player tapped something: no more than that (play.html shows a pulse). */
  | { t: "activity"; by: Seat }
  | ({ t: "abandoned" } & Abandoned)
  | { t: "error"; why: string };

/** Who moves after a move, as the mover's page sees it: the relay tells that player's phone (Web
 *  Push) unless that player has the game in front of them. `note`: the move in a few words. */
export interface NextToMove {
  side: Seat;
  note: string;
}

export type ClientMessage =
  | { t: "move"; at: number; steps: WireStep[]; next?: NextToMove }
  /** The page is in front of its player, or not (a background tab, a locked phone). */
  | { t: "visible"; visible: boolean }
  /** The player tapped something (throttled by the page); passed on to the other seat, not kept. */
  | { t: "activity" };

/** A browser's push subscription (PushSubscription.toJSON()), and the seat's page to open from it. */
export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** POST /rooms/<room>/push?seat=<secret>. */
export interface SubscribeRequest {
  subscription: PushSubscriptionJSON;
  url: string;
}

/** GET /push-key: the relay's VAPID public key, for PushManager.subscribe. */
export interface PushKeyResponse {
  key: string;
}

/** What a push carries to the service worker (web/ui/public/sw.js). */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export const MAX_NOTE = 140;

export function isWireStep(v: unknown): v is WireStep {
  return Array.isArray(v) && v.length === 4 &&
    v.every(x => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 0xffff);
}

export function isSeat(v: unknown): v is Seat {
  return v === "US" || v === "USSR";
}

export function otherSeat(s: Seat): Seat {
  return s === "US" ? "USSR" : "US";
}

export function sameSteps(a: readonly WireStep[], b: readonly WireStep[]): boolean {
  return a.length === b.length && a.every((s, i) => s.every((x, j) => x === b[i][j]));
}
