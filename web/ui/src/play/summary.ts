/**
 * What the phone page (play.html) summarises, apart from how it draws it, so it runs under node
 * (tests/web/js/play_summary.ts).
 *
 * - A region in short: each side's battlegrounds and total countries controlled, as the engine's
 *   scoring counts them (WasmEngine.regionScores), written "bg-total" -- "2-5".
 * - A play's upshot: the regions whose counts it changed ("Asia 2-5/2-5 → 3-6/2-5"), the countries
 *   whose Influence it changed, VP and DEFCON. Read from the board before and after the play, all
 *   of it public; the play's words come from the log as the player's view may read it
 *   (game/view.ts redactLogs), grouped into plays (game/log_view.ts groupLog).
 * - Where each region's scoring card is, as the player may know it.
 */
import { ActionLogItem, GameState, RegionScores } from "../types";
import { WasmEngine } from "../engine/wasm_engine";
import { ReplayStep } from "../replay_controls";
import { LogEntry, groupLog } from "../game/log_view";
import { LogLine, cardsIn } from "../game/log";
import { CARDS_METADATA, MAP_METADATA } from "../metadata";
import { SpaceBoxMetadata } from "../tracks_view";

export type Side = "US" | "USSR";

/** The six regions in scoring-slot order (Region: Europe 0 .. South America 5); 6 is Southeast Asia. */
export const REGIONS: ReadonlyArray<{ slot: number; name: string }> = [
  { slot: 0, name: "Europe" }, { slot: 1, name: "Asia" }, { slot: 2, name: "Middle East" },
  { slot: 3, name: "Africa" }, { slot: 4, name: "Central America" }, { slot: 5, name: "South America" },
];
export const SE_ASIA = { slot: 6, name: "Southeast Asia" };

export interface Count {
  bg: number;
  total: number;
}

export interface RegionCount {
  us: Count;
  ussr: Count;
}

/** "bg-total" for each side of each scoring slot. */
export function regionCounts(scores: RegionScores): Map<number, RegionCount> {
  const m = new Map<number, RegionCount>();
  for (const r of scores.regions) {
    m.set(r.slot, {
      us: { bg: r.us.battlegrounds, total: r.us.countries },
      ussr: { bg: r.ussr.battlegrounds, total: r.ussr.countries },
    });
  }
  return m;
}

export function countText(c: Count): string {
  return `${c.bg}-${c.total}`;
}

const sameCount = (a: Count, b: Count) => a.bg === b.bg && a.total === b.total;

export interface CountryChange {
  id: number;
  name: string;
  us: number;
  ussr: number;
}

export interface Upshot {
  regions: Array<{ slot: number; name: string; before: RegionCount; after: RegionCount }>;
  countries: CountryChange[];
  /** Toward the US, as victory_points. */
  vp: number;
  /** DEFCON before and after, when it changed and the play did not carry into the turn's end. */
  defcon: [number, number] | null;
}

/** A display state's countries by id (the state keys them by name). */
export function countriesById(s: GameState): Map<number, GameState["countries"][string]> {
  return new Map(Object.values(s.countries || {}).map(c => [c.id, c]));
}

/** What the board shows changed between `before` and `after`. */
export function upshot(engine: WasmEngine, before: GameState, after: GameState, vp: number, withDefcon: boolean): Upshot {
  const a = regionCounts(engine.regionScores(before));
  const b = regionCounts(engine.regionScores(after));
  const regions: Upshot["regions"] = [];
  for (const r of REGIONS) {
    const x = a.get(r.slot), y = b.get(r.slot);
    if (x && y && (!sameCount(x.us, y.us) || !sameCount(x.ussr, y.ussr))) regions.push({ ...r, before: x, after: y });
  }
  const countries: CountryChange[] = [];
  // Keyed by name in the display state: matched by id.
  const was = countriesById(before);
  for (const c of Object.values(after.countries || {})) {
    const p = was.get(c.id);
    const us = c.us_influence - (p?.us_influence ?? 0);
    const ussr = c.ussr_influence - (p?.ussr_influence ?? 0);
    if (us || ussr) countries.push({ id: c.id, name: c.name, us, ussr });
  }
  const defcon: [number, number] | null = withDefcon && before.defcon !== after.defcon ? [before.defcon, after.defcon] : null;
  return { regions, countries, vp, defcon };
}

export interface HistoryEntry {
  entry: LogEntry;
  upshot: Upshot;
  /** The last step the entry covers (1-based, as ActionLogItem.step_index). */
  step: number;
}

/**
 * The game's plays, oldest first, each with its upshot. `logs` is the log as the viewer may read
 * it; `start` and `steps` the session's (their snapshots are read only for the public board).
 * A play's "before" is the previous play's "after", so a turn's end -- logged on the step that
 * carried into it -- is told by its own entry, not twice.
 */
export function history(engine: WasmEngine, start: GameState, steps: ReplayStep[], logs: ActionLogItem[]): HistoryEntry[] {
  const entries = groupLog(logs);
  const stateAfter = (n: number) => (n <= 0 ? start : steps[Math.min(n, steps.length) - 1].state_snapshot);
  const out: HistoryEntry[] = [];
  let prev = start;
  entries.forEach((e, i) => {
    let last = 0;
    for (let k = e.first; k <= e.last; k++) last = Math.max(last, logs[k]?.step_index ?? 0);
    const after = stateAfter(last);
    // A play whose last step carried into the turn's end: the snapshot is after the end, whose
    // DEFCON step is the end's own entry's to tell (its lines do).
    const next = entries[i + 1];
    const crosses = !!next && next.phase === "TURN_END";
    const isEnd = e.phase === "TURN_END";
    out.push({ entry: e, upshot: upshot(engine, prev, after, e.vp_delta, !crosses && !isEnd), step: last });
    prev = after;
  });
  return out;
}

/** Card lines that say nothing a player needs told: a deal, the new era's cards, a reshuffle. */
const QUIET_CARD_LINES = new Set(["log:card.draws", "log:card.newEra", "log:card.reshuffled"]);

/**
 * The lines of a play worth showing without opening it -- what was not fixed by the move itself:
 * every die (🎲), a random discard (✂), Missile Envy's exchange (⇄), a card a choice or an Event
 * moved (chosen, taken, discarded, removed) and a hand card revealed. The play's own card going
 * where its play sends it is not news: the heading names it. Influence, VP and DEFCON are the
 * upshot's. `step`, when given, keeps only the lines that step made.
 */
export function notableLines(e: LogEntry, step?: number): LogLine[] {
  const own = new Set(cardsIn(e.title).map(c => c.card));
  return e.lines.filter((l, i) => {
    if (step !== undefined && e.steps[i] !== step) return false;
    if (l.mark === "🎲" || l.mark === "✂" || l.mark === "⇄") return true;
    const k = l.msg.key;
    if (l.mark === "▸" && k.startsWith("log:choice.")) return true;
    if (k.startsWith("log:card.") && !QUIET_CARD_LINES.has(k)) return !cardsIn(l.msg).some(c => own.has(c.card));
    return false;
  });
}

/** The scoring card of each scoring slot, by the cards' names. */
export const SCORING_CARDS: ReadonlyMap<number, number> = (() => {
  const m = new Map<number, number>();
  const slots: Record<string, number> = {
    "Europe Scoring": 0, "Asia Scoring": 1, "Middle East Scoring": 2, "Africa Scoring": 3,
    "Central America Scoring": 4, "South America Scoring": 5, "Southeast Asia Scoring": 6,
  };
  for (const c of CARDS_METADATA) if (c.name in slots) m.set(slots[c.name], c.id);
  return m;
})();

/** What a region's scoring awards: each standing's VP ("wins" where Control ends the game), +1 per
 *  battleground, and whether a country next to the enemy superpower adds 1. */
export interface ScoringValues {
  presence: number;
  domination: number;
  control: number | "wins";
  adjacent: boolean;
}

/** Each scoring slot's values (Southeast Asia's apart: it has no standings), read from the scoring
 *  card's own text -- "Presence: 3; Domination: 7; Control: 9; ... adjacent to enemy superpower".
 *  tests/web/js/play_summary.ts holds them to what the engine awards. */
export const SCORING_VALUES: ReadonlyMap<number, ScoringValues> = (() => {
  const m = new Map<number, ScoringValues>();
  for (const [slot, id] of SCORING_CARDS) {
    const text = CARDS_METADATA.find(c => c.id === id)?.description ?? "";
    const v = /Presence: (\d+); Domination: (\d+); Control: (\d+|Automatic Victory)/.exec(text);
    if (!v) continue;
    m.set(slot, {
      presence: Number(v[1]), domination: Number(v[2]), control: v[3] === "Automatic Victory" ? "wins" : Number(v[3]),
      adjacent: text.includes("adjacent to enemy superpower"),
    });
  }
  return m;
})();

export type CardWhere = "hand" | "discard" | "removed" | "out" | "unseen";

/** Where `card` is as `shown` (a player's view) lets its player know: the player's own hand, the
 *  discard pile, removed, not yet in the game (a later war's), or unseen -- the deck or the other hand. */
export function cardWhere(shown: GameState, card: number, me: Side): CardWhere {
  if ((shown.hands?.[me] || []).includes(card)) return "hand";
  if ((shown.discard_pile || []).includes(card)) return "discard";
  if ((shown.removed_pile || []).includes(card)) return "removed";
  if ((shown.unavailable_cards || []).includes(card)) return "out";
  return "unseen";
}

/** The countries of a region, Southeast Asia's apart from the rest of Asia's. */
export function regionCountries(region: string): Array<{ group: string; ids: number[] }> {
  const cs = MAP_METADATA.countries.filter(c => c.region === region);
  const groups = new Map<string, number[]>();
  for (const c of cs) {
    const g = region === "Asia" && (c.subregions || []).includes(SE_ASIA.name) ? SE_ASIA.name : "";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(c.id);
  }
  const order = (a: number, b: number) => {
    const x = MAP_METADATA.countries.find(c => c.id === a)!, y = MAP_METADATA.countries.find(c => c.id === b)!;
    return Number(y.battleground) - Number(x.battleground) || y.stability - x.stability || x.name.localeCompare(y.name);
  };
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, ids]) => ({ group, ids: ids.sort(order) }));
}

/** The cards `shown` hides from `me` that it did not hide in `before`'s place: a card leaving the
 *  unseen pile (a draw, a peek, the other hand revealed). Such a move cannot be taken back. */
export function revealed(beforeLocations: Record<string, string> | undefined, afterLocations: Record<string, string> | undefined): boolean {
  const a = beforeLocations || {}, b = afterLocations || {};
  return Object.entries(a).some(([id, loc]) => loc === "UNSEEN" && b[id] !== undefined && b[id] !== "UNSEEN");
}

/** A Space Race privilege in force: its box was reached by `side` and not yet by the other side. */
export interface SpaceAbility {
  side: Side;
  box: SpaceBoxMetadata;
}

/** The privileges in force, by the track (tracks_view.ts spaceRaceBoxes: the engine's boxes, their
 *  privileges' words) -- the rule the workbench's Space Race panel shows. */
export function spaceAbilities(space: { US: number; USSR: number }, boxes: SpaceBoxMetadata[]): SpaceAbility[] {
  const out: SpaceAbility[] = [];
  for (const box of boxes) {
    if (!box.privilege) continue;
    if (space.US >= box.box && space.USSR < box.box) out.push({ side: "US", box });
    if (space.USSR >= box.box && space.US < box.box) out.push({ side: "USSR", box });
  }
  return out;
}
