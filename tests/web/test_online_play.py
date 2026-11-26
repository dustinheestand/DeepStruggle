"""Two people's game through the play relay stays one game.

Two pages -- each its own WebAssembly engine and GameSession -- play a random game through an
in-memory relay that runs the play Worker's room rules (web/play_worker/src/room.ts), with each side
dropping off, moving while the other is away or while its own messages are lost, and one page's
list corrupted (tests/web/js/online_play.ts). Both pages must end on the same position as a third
that plays the relay's list from the seed alone.
"""
from __future__ import annotations

from pathlib import Path

from tests.web.js_runner import PUBLIC, run_ts


def test_two_pages_play_one_game(tmp_path: Path) -> None:
    out = run_ts("online_play.ts", str(tmp_path), PUBLIC)
    failed = [k for k, ok in out["checks"].items() if not ok]
    assert not failed, f"{failed}: {out}"
    assert out["steps"] > 100, out
