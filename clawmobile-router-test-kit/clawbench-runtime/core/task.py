"""Benchmark task interface."""

from __future__ import annotations

from abc import ABC, abstractmethod
from enum import IntEnum

from core.results import CheckResult


class ExecutionMode(IntEnum):
    """How the agent is expected to execute the task."""

    SETTINGS_CALL = 1
    SYSTEM_QUERY = 2
    APP_UI = 3
    SHELL = 4
    VISION = 5
    MULTI_APP = 6


class TaskLength(IntEnum):
    """Approximate number of steps needed to complete the task."""

    SHORT = 1
    MEDIUM = 2
    LONG = 3


class RiskLevel(IntEnum):
    """Risk level of the task side effects."""

    READ_ONLY = 0
    LOCAL_REVERSIBLE = 1
    LOCAL_DESTRUCTIVE = 2
    EXTERNAL_EFFECT = 3


class InteractionMode(IntEnum):
    """Whether the task can be completed from one instruction."""

    SINGLE_TURN = 1
    MULTI_TURN = 2


class Task(ABC):
    """Base class for benchmark tasks discovered from the tasks package."""

    task_id: str = ""
    layer: str = ""
    M: ExecutionMode | None = None
    T: TaskLength | None = None
    R: RiskLevel | None = None
    I: InteractionMode = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        """Return parameter variants for this task.

        The runner executes one run for each dict. The default is one run with
        no parameters.
        """

        return [{}]

    def preflight(self, device, params: dict) -> None:
        """Verify task-specific environment prerequisites before setup.

        Preflight must be read-only or best-effort diagnostic work. It should not
        create task fixtures or perform the agent's target action. Raise
        PreflightCheckError from core.preflight when the environment is not ready.
        """

    @abstractmethod
    def get_instruction(self, params: dict) -> str:
        """Return the natural-language instruction sent to the agent.

        This is the only task-authored text that the runner passes through the
        trigger stub to the agent.
        """

    @abstractmethod
    def setup(self, device, params: dict) -> None:
        """Put the device into a known initial state before the agent acts.

        This method is called by the runner before trigger. It must use the
        device directly and must be deterministic. Do not route setup through
        the agent or any LLM.
        """

    @abstractmethod
    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        """Read device state directly and return deterministic pass/fail checks.

        This method is called by the runner after completion. It must use the
        device directly and must never ask the agent or an LLM to judge success.
        Tasks that verify the final assistant response can inspect
        completed_run["replyText"].
        """

    @abstractmethod
    def teardown(self, device, params: dict) -> None:
        """Clean up device state after a run.

        The runner calls this in a finally block, even when setup, trigger,
        completion, or check fails.
        """
