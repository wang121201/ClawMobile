"""Deterministic task verification result types."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class SubcheckResult:
    """Result for one deterministic pass/fail condition."""

    name: str
    passed: bool
    mechanism: str
    is_negative: bool = False
    detail: str = ""


class CheckResult:
    """Container for deterministic task subchecks."""

    def __init__(self, subchecks: list[SubcheckResult] | None = None) -> None:
        self.subchecks = list(subchecks or [])

    def add(
        self,
        name: str,
        passed: bool,
        mechanism: str,
        is_negative: bool = False,
        detail: str = "",
    ) -> None:
        """Add one deterministic subcheck result."""

        self.subchecks.append(
            SubcheckResult(
                name=name,
                passed=passed,
                mechanism=mechanism,
                is_negative=is_negative,
                detail=detail,
            )
        )

    @property
    def passed(self) -> bool:
        """Return True only when every subcheck passed."""

        return all(subcheck.passed for subcheck in self.subchecks)
