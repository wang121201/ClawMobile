"""Retired unsafe live-all entry point.

Real-device batches must use ``scripts/run_task_set.py`` so task selection is
explicit, the full execution plan is frozen before device access, and recovery
or infrastructure failures stop the batch.
"""

from __future__ import annotations

import sys


def main() -> None:
    print(
        "scripts/run_all.py is disabled for real-device execution; use "
        "scripts/run_task_set.py with an explicit --task-case, --task-id, or "
        "--layers selector",
        file=sys.stderr,
    )
    raise SystemExit(2)

if __name__ == "__main__":
    main()
