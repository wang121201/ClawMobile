"""Disabled legacy timeout-interruption API.

The formal ClawBench capability runner waits for the phone-side run to reach a
real terminal state.  It never sends synthetic cancellation requests and it
never force-stops Termux.  This compatibility function remains only so an old
external import fails safe instead of restoring the retired destructive path.
"""

from __future__ import annotations


def interrupt_run_after_timeout(run_id: str, device, timeout_s: float = 5.0) -> dict:
    """Return a permanent disabled result without touching HTTP or the device."""

    del device, timeout_s
    return {
        "enabled": False,
        "run_id": run_id,
        "reason": "timeout interruption is permanently disabled",
    }
