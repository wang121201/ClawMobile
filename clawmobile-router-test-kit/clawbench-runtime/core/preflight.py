"""Preflight checks for task-specific environment requirements."""

from __future__ import annotations


class PreflightCheckError(RuntimeError):
    """Raised when a task cannot run because the device environment is not ready."""


def require_preflight(condition: bool, reason: str) -> None:
    """Fail the preflight phase with a clear reason when a condition is not met."""

    if not condition:
        raise PreflightCheckError(reason)
