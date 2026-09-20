"""Task auto-discovery for files in the tasks package."""

from __future__ import annotations

import importlib
import inspect
import pkgutil

from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength


TASK_REGISTRY: dict[str, type[Task]] = {}
_METADATA_FIELDS = {
    "M": ExecutionMode,
    "T": TaskLength,
    "R": RiskLevel,
    "I": InteractionMode,
}


def discover_tasks(package: str = "tasks") -> dict[str, type[Task]]:
    """Import task modules and register Task subclasses by task_id."""

    TASK_REGISTRY.clear()
    package_module = importlib.import_module(package)

    for module_info in pkgutil.iter_modules(
        package_module.__path__, f"{package_module.__name__}."
    ):
        module = importlib.import_module(module_info.name)
        for _, obj in inspect.getmembers(module, inspect.isclass):
            if obj is Task or not issubclass(obj, Task):
                continue
            if obj.__module__ != module.__name__:
                continue
            task_id = getattr(obj, "task_id", "")
            if not task_id:
                continue
            if task_id in TASK_REGISTRY:
                raise ValueError(f"duplicate task_id discovered: {task_id}")
            _validate_task_metadata(obj)
            TASK_REGISTRY[task_id] = obj

    return TASK_REGISTRY


def _validate_task_metadata(task_cls: type[Task]) -> None:
    for field_name, enum_cls in _METADATA_FIELDS.items():
        value = getattr(task_cls, field_name)
        if not isinstance(value, enum_cls):
            raise TypeError(
                f"{task_cls.__name__}.{field_name} must be a {enum_cls.__name__} value"
            )
