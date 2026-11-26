"""The phone page's history adds up to the game.

play.html tells each play by its upshot -- the regions' battleground and country counts before and
after, the Influence it changed, VP (web/ui/src/play/summary.ts). Chained over a whole game played in
the page's GameSession, those must take the start to the end exactly (tests/web/js/play_summary.ts).
"""
from __future__ import annotations

from pathlib import Path

from tests.web.js_runner import PUBLIC, run_ts


def test_history_adds_up_to_the_game(tmp_path: Path) -> None:
    out = run_ts("play_summary.ts", str(tmp_path), PUBLIC)
    failed = [k for k, ok in out["checks"].items() if not ok]
    assert not failed, f"{failed}: {out}"
