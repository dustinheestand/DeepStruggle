/**
 * The online game (game/online.ts) on a GameSession: its steps on the wire, a fresh deal from the
 * room's seed, and the relay's steps played. Shared by the page (main.ts) and its test
 * (tests/web/js/online_play.ts), so the test plays exactly what the page plays.
 */
import { GameSession } from "./session";
import { WireStep } from "./online_protocol";
import { SEATS } from "./seats";

export function sessionSteps(s: GameSession): WireStep[] {
  return s.steps.map(x => [x.action.decision_type, x.action.primary_id, x.action.secondary_id ?? 0, x.action.flags ?? 0]);
}

/** A fresh deal from the room's seed, both sides seated as people: the current rules. */
export function startOnlineGame(s: GameSession, seed: number): void {
  s.newGame(seed);
  for (const [, player] of SEATS) s.engine.seat(player, s.engine.currentRules);
}

/** Play the relay's steps: never a forced die, the engine rolls from the seed. */
export function applyWireSteps(s: GameSession, steps: readonly WireStep[]): string | null {
  for (const [decision_type, primary_id, secondary_id, flags] of steps) {
    const why = s.apply({ decision_type, primary_id, secondary_id, flags }, 0, { source: "human", analysis: false });
    if (why) return why;
  }
  return null;
}
