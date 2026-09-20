from __future__ import annotations

import re
import xml.etree.ElementTree as ET

from core.results import CheckResult
from core.task import ExecutionMode, InteractionMode, RiskLevel, Task, TaskLength
from tasks._ui_helpers import (
    AMAZON_CLEAR_SEARCH_HISTORY_SKILL,
    AMAZON_OPEN_CART_SKILL,
    AMAZON_PACKAGE_CANDIDATES,
    add_foreground_package_in_check,
    add_keyword_group_checks,
    add_ui_contains_any_check,
    add_ui_omits_any_check,
    dump_ui_for_check,
    force_stop_packages_if_supported,
    normalize_ui_text,
    require_any_app_ui_access,
    require_shell_access,
    require_skill_access,
    run_tool_skill,
)


CART_PAGE_SIGNALS = (
    "Cart",
    "Basket",
    "Shopping Cart",
    "Subtotal",
    "Proceed to Checkout",
)
ITEM_KEYWORD_GROUPS = {
    "USB-C cable": (
        ("USB-C", "USB C", "Type-C", "Type C"),
        ("cable",),
    ),
    "wireless mouse": (
        ("wireless",),
        ("mouse",),
    ),
}
PURCHASE_OR_CHECKOUT_COMPLETION_SIGNALS = (
    "Order placed",
    "Thank you for your order",
    "Place your order",
    "Review your order",
    "Payment method",
    "Buy now",
)
EMPTY_CART_SIGNALS = (
    "Your Amazon Cart is empty",
    "Your Shopping Cart is empty",
    "Your cart is empty",
    "Your basket is empty",
    "Cart is empty",
    "Basket is empty",
)
REMOVE_CART_ITEM_SIGNALS = (
    "Delete",
    "Remove",
    "Remove from cart",
    "Remove from Cart",
    "Remove item",
)
MAX_CART_CLEAR_ATTEMPTS = 8
MAX_CART_LOAD_ATTEMPTS = 8


class L4_03_AddAmazonCartItem(Task):
    task_id = "L4-03"
    layer = "L4"
    M = ExecutionMode.APP_UI
    T = TaskLength.LONG
    R = RiskLevel.EXTERNAL_EFFECT
    I = InteractionMode.SINGLE_TURN

    def param_pool(self) -> list[dict]:
        return [
            {"item": "USB-C cable"},
            {"item": "wireless mouse"},
        ]

    def get_instruction(self, params: dict) -> str:
        return (
            f"Search Amazon for {params['item']} and add one suitable result to "
            "the cart. Do not proceed to checkout or buy anything."
        )

    def preflight(self, device, params: dict) -> None:
        require_any_app_ui_access(device, AMAZON_PACKAGE_CANDIDATES, "Amazon Shopping")
        require_skill_access(device, AMAZON_CLEAR_SEARCH_HISTORY_SKILL)
        require_skill_access(device, AMAZON_OPEN_CART_SKILL)
        require_shell_access(device, "Amazon cart setup")

    def setup(self, device, params: dict) -> None:
        force_stop_packages_if_supported(device, AMAZON_PACKAGE_CANDIDATES)
        try:
            _clear_amazon_search_history(device)
            force_stop_packages_if_supported(device, AMAZON_PACKAGE_CANDIDATES)
            _clear_amazon_cart(device)
        finally:
            force_stop_packages_if_supported(device, AMAZON_PACKAGE_CANDIDATES)

    def check(
        self,
        device,
        params: dict,
        completed_run: dict | None = None,
    ) -> CheckResult:
        result = CheckResult()
        _run_open_cart_skill_check(result, device)
        add_foreground_package_in_check(
            result,
            device,
            AMAZON_PACKAGE_CANDIDATES,
            "Amazon Shopping",
        )
        xml = dump_ui_for_check(result, device)
        add_ui_contains_any_check(result, "cart_page_visible", xml, CART_PAGE_SIGNALS)
        _add_cart_count_nonzero_check(result, xml)
        add_keyword_group_checks(
            result,
            xml,
            ITEM_KEYWORD_GROUPS[params["item"]],
            "cart_item_keywords_visible",
        )
        add_ui_omits_any_check(
            result,
            "checkout_or_purchase_not_detected",
            xml,
            PURCHASE_OR_CHECKOUT_COMPLETION_SIGNALS,
        )
        return result

    def teardown(self, device, params: dict) -> None:
        force_stop_packages_if_supported(device, AMAZON_PACKAGE_CANDIDATES)


def _run_open_cart_skill_check(result: CheckResult, device) -> None:
    try:
        skill_result = run_tool_skill(device, AMAZON_OPEN_CART_SKILL)
    except Exception as exc:
        result.add(
            "open_cart_skill_completed",
            False,
            "skill",
            detail=f"skill={AMAZON_OPEN_CART_SKILL!r}, error={exc}",
        )
        return

    ok = skill_result.get("ok", True) is True
    result.add(
        "open_cart_skill_completed",
        ok,
        "skill",
        detail=f"skill={AMAZON_OPEN_CART_SKILL!r}, result={skill_result!r}",
    )


def _clear_amazon_cart(device) -> None:
    try:
        skill_result = run_tool_skill(device, AMAZON_OPEN_CART_SKILL)
    except Exception as exc:
        raise RuntimeError(
            f"Cannot open Amazon cart during setup with {AMAZON_OPEN_CART_SKILL!r}: {exc}"
        ) from exc
    if skill_result.get("ok", True) is not True:
        raise RuntimeError(
            f"Amazon cart setup skill returned non-ok result: {skill_result!r}"
        )

    removal_attempts = 0
    load_attempts = 0
    while removal_attempts < MAX_CART_CLEAR_ATTEMPTS:
        xml = device.ui_dump_xml()
        if not xml.strip():
            raise RuntimeError("Cannot verify Amazon cart state: empty UI XML")
        if _cart_is_empty(xml):
            return

        remove_bounds = _first_remove_cart_item_bounds(xml)
        if remove_bounds is None and load_attempts < MAX_CART_LOAD_ATTEMPTS:
            load_attempts += 1
            device.shell("sleep 1")
            continue
        if remove_bounds is None:
            count = _extract_cart_item_count(xml)
            raise RuntimeError(
                "Amazon cart is not empty, but no Delete/Remove control was found "
                f"after waiting for cart content (count={count!r})"
            )
        removal_attempts += 1
        _tap_bounds_center(device, remove_bounds)
        device.shell("sleep 1")

    xml = device.ui_dump_xml()
    if _cart_is_empty(xml):
        return
    raise RuntimeError(
        f"Amazon cart was not empty after {MAX_CART_CLEAR_ATTEMPTS} removal attempts"
    )


def _clear_amazon_search_history(device) -> None:
    try:
        skill_result = run_tool_skill(device, AMAZON_CLEAR_SEARCH_HISTORY_SKILL)
    except Exception as exc:
        raise RuntimeError(
            "Cannot clear Amazon search history during setup with "
            f"{AMAZON_CLEAR_SEARCH_HISTORY_SKILL!r}: {exc}"
        ) from exc
    if skill_result.get("ok", True) is not True:
        raise RuntimeError(
            "Amazon search-history setup skill returned non-ok result: "
            f"{skill_result!r}"
        )


def _cart_is_empty(xml: str) -> bool:
    count = _extract_cart_item_count(xml)
    if count == 0:
        return True
    text = normalize_ui_text(xml)
    return any(normalize_ui_text(signal) in text for signal in EMPTY_CART_SIGNALS)


def _first_remove_cart_item_bounds(xml: str) -> tuple[int, int, int, int] | None:
    for node in _iter_ui_nodes(xml):
        node_text = _node_label(node)
        if not node_text:
            continue
        if not any(
            normalize_ui_text(signal) in node_text
            for signal in REMOVE_CART_ITEM_SIGNALS
        ):
            continue
        bounds = _parse_bounds(str(node.attrib.get("bounds", "")))
        if bounds is not None:
            return bounds
    return None


def _iter_ui_nodes(xml: str):
    for candidate in (xml, f"<hierarchy>{xml}</hierarchy>"):
        try:
            root = ET.fromstring(candidate)
        except ET.ParseError:
            continue
        yield from root.iter("node")
        return


def _parse_bounds(value: str) -> tuple[int, int, int, int] | None:
    match = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", value.strip())
    if not match:
        return None
    return tuple(int(group) for group in match.groups())


def _node_label(node) -> str:
    return normalize_ui_text(
        " ".join(
            str(node.attrib.get(attribute, ""))
            for attribute in ("text", "content-desc")
        )
    )


def _tap_bounds_center(device, bounds: tuple[int, int, int, int]) -> None:
    left, top, right, bottom = bounds
    x = round((left + right) / 2)
    y = round((top + bottom) / 2)
    device.shell(f"input tap {x} {y}")


def _add_cart_count_nonzero_check(result: CheckResult, xml: str) -> None:
    count = _extract_cart_item_count(xml)
    result.add(
        "cart_count_nonzero_if_visible",
        count is None or count > 0,
        "a11y_tree",
        detail=f"count={count!r}",
    )


def _extract_cart_item_count(xml: str) -> int | None:
    text = normalize_ui_text(xml)
    patterns = (
        r"\bsubtotal\s*\(?\s*(\d+)\s+items?\b",
        r"\b(?:cart|basket)\s+(?:has\s+|contains\s+)?(\d+)\s+items?\b",
        r"\b(?:cart|basket)\s+count\s+(\d+)\b",
        r"\b(\d+)\s+items?\s+in\s+(?:cart|basket)\b",
    )
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return int(match.group(1))
    has_cart_context = any(marker in text for marker in ("cart", "basket", "subtotal"))
    if "1 item" in text and has_cart_context:
        return 1
    return None
