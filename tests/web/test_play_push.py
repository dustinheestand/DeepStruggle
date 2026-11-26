"""The play relay's Web Push is the standard's.

The relay encrypts a push for the browser's subscription and signs a VAPID token for the push
service (web/play_worker/src/push.ts). tests/web/js/play_push.ts checks the encryption against
RFC 8291 Appendix A byte for byte, the token's signature and claims, and that only push services are
accepted as endpoints (the relay sends to nowhere else).
"""
from __future__ import annotations

from pathlib import Path

from tests.web.js_runner import PUBLIC, run_ts


def test_push_matches_the_rfc(tmp_path: Path) -> None:
    out = run_ts("play_push.ts", str(tmp_path), PUBLIC)
    failed = [k for k, ok in out["checks"].items() if not ok]
    assert not failed, f"{failed}: {out}"
