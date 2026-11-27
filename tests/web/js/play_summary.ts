// Bundled by tests/web/test_play_summary.py: the phone page's history (web/ui/src/play/summary.ts)
// adds up to the game, under node.
//   node play_summary.mjs <public dir>
// A random game in the page's GameSession; its history as the US player reads it. The upshots
// chained must take the start's region counts and Influence to the end's, entry by entry, and each
// play's dice must be among the lines shown without opening it (notableLines).
import { pathToFileURL } from "node:url";
import { WasmEngine } from "../../../web/ui/src/engine/wasm_engine";
import { MAP_METADATA } from "../../../web/ui/src/metadata";
import { GameSession } from "../../../web/ui/src/game/session";
import { redactState } from "../../../web/ui/src/game/view";
import { startOnlineGame } from "../../../web/ui/src/game/online_session";
import { REGIONS, SCORING_VALUES, countriesById, history, notableLines, regionCounts, revealed } from "../../../web/ui/src/play/summary";

const engine = await WasmEngine.load(pathToFileURL(process.argv[2]).href);
const s = new GameSession(engine);
let x = 99;
const rand = (n: number) => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return (x >>> 8) % n; };
startOnlineGame(s, 31337);
let reveals = 0;
for (let n = 0; n < 5000 && !engine.isTerminal(); n++) {
  const legal: number[] = [];
  engine.mask(false).forEach((v, i) => { if (v) legal.push(i); });
  const before = redactState(s.state(), "US").card_locations;
  const why = s.applyFlat(legal[rand(legal.length)], false, 0, { source: "human", analysis: false });
  if (why) throw new Error(why);
  if (revealed(before, redactState(s.state(), "US").card_locations)) reveals++;
  // Random play ends most games early on DEFCON: take that back while another move exists.
  if (engine.isTerminal() && engine.display().turn < 7 && legal.length > 1) s.undo(false);
}
// The values the region page reads from the scoring cards' text are what the engine awards: on a
// board where the US alone holds Presence, then Domination, then Control of each region, the
// standing is worth its card's VP (Control of Europe wins instead).
const scoringValuesOk = (() => {
  if (SCORING_VALUES.size !== 6) return false;
  const board = (us: Set<number>) => {
    const countries = structuredClone(s.start!.countries);
    for (const c of Object.values(countries)) {
      const meta = MAP_METADATA.countries.find(m => m.id === c.id)!;
      c.us_influence = us.has(c.id) ? meta.stability : 0;
      c.ussr_influence = 0;
      c.controlled_by = us.has(c.id) ? "US" : "NONE";
    }
    return { countries, flags: [] };
  };
  for (const r of REGIONS) {
    const v = SCORING_VALUES.get(r.slot)!;
    const cs = MAP_METADATA.countries.filter(c => c.region === r.name);
    const bgs = cs.filter(c => c.battleground).map(c => c.id), other = cs.filter(c => !c.battleground).map(c => c.id);
    const cases: Array<[string, number[], number | "wins"]> = [
      ["PRESENCE", [other[0]], v.presence],
      ["DOMINATION", [bgs[0], other[0]], v.domination],
      ["CONTROL", [...bgs, other[0]], v.control],
    ];
    for (const [status, ids, want] of cases) {
      const got = engine.regionScores(board(new Set(ids))).regions.find(x => x.slot === r.slot)!;
      if (got.us.status !== status) return false;
      if (want === "wins" ? got.wins !== "US" : got.us.base_vp !== want) return false;
    }
  }
  return true;
})();
const full = s.state();
const shown = redactState(full, "US");
const h = history(engine, s.start!, s.steps, shown.action_logs || []);

const key = (m: Map<number, { us: { bg: number; total: number }; ussr: { bg: number; total: number } }>) =>
  JSON.stringify([...m.entries()].filter(([k]) => k < 6));
let counts = regionCounts(engine.regionScores(s.start!));
const influence = new Map([...countriesById(s.start!).values()].map(c => [c.id, [c.us_influence, c.ussr_influence]]));
let chainOk = true;
for (const e of h) {
  for (const r of e.upshot.regions) {
    const cur = counts.get(r.slot)!;
    if (JSON.stringify(cur) !== JSON.stringify(r.before)) chainOk = false;
    counts.set(r.slot, r.after);
  }
  for (const c of e.upshot.countries) {
    const v = influence.get(c.id)!;
    influence.set(c.id, [v[0] + c.us, v[1] + c.ussr]);
  }
}
const end = countriesById(full);
const checks = {
  entries: h.length > 20,
  regions_told: h.some(e => e.upshot.regions.length > 0),
  setup_told: h.some(e => e.entry.phase === "SETUP" && e.upshot.regions.some(r => r.name === "Europe")),
  chain: chainOk,
  counts_end: key(counts) === key(regionCounts(engine.regionScores(full))),
  influence_end: [...end.values()].every(c => JSON.stringify(influence.get(c.id)) === JSON.stringify([c.us_influence, c.ussr_influence])),
  vp_end: h.reduce((a, e) => a + e.upshot.vp, 0) === full.victory_points,
  reveals: reveals > 0,
  scoring_values: scoringValuesOk,
  // Every die of a play is shown without opening it, and only lines a play's upshot does not tell.
  facts_dice: h.every(e => e.entry.lines.filter(l => l.mark === "🎲").length === notableLines(e.entry).filter(l => l.mark === "🎲").length),
  facts_told: h.some(e => notableLines(e.entry).length > 0),
  facts_no_influence: h.every(e => notableLines(e.entry).every(l => !l.msg.key.startsWith("log:change."))),
};
console.log(JSON.stringify({ checks, entries: h.length, turn: full.turn, reveals }));
