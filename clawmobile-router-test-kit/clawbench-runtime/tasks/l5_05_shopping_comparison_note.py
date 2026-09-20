from __future__ import annotations

from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._file_helpers import require_downloads_access
from tasks._note_helpers import (
    add_keyword_group_text_checks,
    add_note_exists_check,
    add_price_count_check,
    add_word_count_check,
    delete_note,
    note_text,
)


COMPARISON_FILENAME = "shopping_comparison.txt"
ITEM_KEYWORD_GROUPS = {
    "USB-C charger": (
        ("USB-C", "USB C", "Type-C", "Type C"),
        ("charger", "adapter", "power brick"),
    ),
    "wireless earbuds": (
        ("wireless",),
        ("earbuds", "earphones", "headphones"),
    ),
}
COMPARISON_SIGNALS = (
    ("cheaper", "lowest", "less expensive", "better price", "recommend"),
    ("option", "store", "seller", "price"),
)


class L5_05_ShoppingComparisonNote(Task):
    task_id = "L5-05"
    layer = "L5"
    M = ExecutionMode.MULTI_APP
    T = TaskLength.LONG
    R = RiskLevel.EXTERNAL_EFFECT
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [
            {"item": "USB-C charger", "filename": COMPARISON_FILENAME},
            {"item": "wireless earbuds", "filename": COMPARISON_FILENAME},
        ]

    def get_instruction(self, params: dict) -> str:
        return (
            f"Compare prices for {params['item']} in two shopping apps or "
            f"websites and save the cheaper option in a note named "
            f"{params['filename']} in Downloads. Do not buy anything."
        )

    def preflight(self, device, params: dict) -> None:
        require_downloads_access(device)

    def setup(self, device, params: dict) -> None:
        delete_note(device, params["filename"])

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        text = note_text(device, params["filename"])
        add_note_exists_check(result, device, params["filename"])
        add_keyword_group_text_checks(
            result,
            text,
            ITEM_KEYWORD_GROUPS[params["item"]],
            "item_keywords_present",
        )
        add_keyword_group_text_checks(
            result,
            text,
            COMPARISON_SIGNALS,
            "comparison_signals_present",
        )
        add_price_count_check(result, text, minimum=2)
        add_word_count_check(result, text, minimum=12, maximum=120)
        return result

    def teardown(self, device, params: dict) -> None:
        delete_note(device, params["filename"])
