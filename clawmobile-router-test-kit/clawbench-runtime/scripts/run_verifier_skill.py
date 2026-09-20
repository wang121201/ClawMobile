from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET


AMAZON_PACKAGE = "com.amazon.mShop.android.shopping"
SERIAL = os.environ.get("CLAWBENCH_DEVICE_SERIAL", "127.0.0.1:5555")


def _adb(*args: str, timeout: int = 30, check: bool = True) -> str:
    completed = subprocess.run(
        ["adb", "-s", SERIAL, *args],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    if check and completed.returncode != 0:
        raise RuntimeError(
            f"adb {' '.join(args)} failed ({completed.returncode}): "
            f"{completed.stderr.strip()}"
        )
    return completed.stdout


def _shell(*args: str, timeout: int = 30) -> str:
    return _adb("shell", *args, timeout=timeout)


def _dump() -> str:
    path = "/sdcard/clawbench-amazon-verifier.xml"
    _shell("uiautomator", "dump", path, timeout=20)
    return _shell("cat", path, timeout=10)


def _bounds(node: ET.Element) -> tuple[int, int, int, int] | None:
    match = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.attrib.get("bounds", ""))
    if not match:
        return None
    return tuple(int(value) for value in match.groups())


def _tap(node: ET.Element) -> None:
    bounds = _bounds(node)
    if bounds is None:
        raise RuntimeError("Amazon control has no valid bounds")
    left, top, right, bottom = bounds
    _shell("input", "tap", str((left + right) // 2), str((top + bottom) // 2))


def _nodes(xml_text: str) -> list[ET.Element]:
    try:
        return list(ET.fromstring(xml_text).iter("node"))
    except ET.ParseError as exc:
        raise RuntimeError(f"Cannot parse Amazon UI hierarchy: {exc}") from exc


def _label(node: ET.Element) -> str:
    return " ".join(
        value for value in (node.attrib.get("text", ""), node.attrib.get("content-desc", "")) if value
    ).strip()


def _find(nodes: list[ET.Element], *, resource_suffix: str = "", text: str = "", desc_prefix: str = "") -> ET.Element | None:
    for node in nodes:
        if resource_suffix and node.attrib.get("resource-id", "").endswith(resource_suffix):
            return node
        if text and node.attrib.get("text", "").casefold() == text.casefold():
            return node
        if desc_prefix and node.attrib.get("content-desc", "").casefold().startswith(desc_prefix.casefold()):
            return node
    return None


def _open_amazon() -> str:
    _shell("monkey", "-p", AMAZON_PACKAGE, "-c", "android.intent.category.LAUNCHER", "1")
    for _ in range(10):
        time.sleep(1)
        xml_text = _dump()
        nodes = _nodes(xml_text)
        permission = _find(nodes, resource_suffix="permission_allow_button", text="Allow")
        if permission is not None:
            _tap(permission)
            continue
        skip = _find(nodes, resource_suffix="skip_sign_in_button", text="Skip sign in")
        if skip is not None:
            _tap(skip)
            continue
        if any(node.attrib.get("package") == AMAZON_PACKAGE for node in nodes):
            return xml_text
    raise RuntimeError("Amazon did not reach an interactive app screen")


def _open_cart() -> dict:
    xml_text = _open_amazon()
    for _ in range(8):
        nodes = _nodes(xml_text)
        cart = _find(nodes, desc_prefix="Cart ")
        if cart is None:
            cart = _find(nodes, text="Cart")
        if cart is not None:
            _tap(cart)
            time.sleep(2)
            xml_text = _dump()
        normalized = " ".join(_label(node) for node in _nodes(xml_text)).casefold()
        if any(signal in normalized for signal in ("cart", "basket", "subtotal", "proceed to checkout")):
            return {"ok": True, "skill": "amazon_open_cart", "verification": "cart_ui_visible"}
        time.sleep(1)
        xml_text = _dump()
    raise RuntimeError("Amazon cart UI was not observable after tapping the Cart tab")


def _open_search(xml_text: str) -> str:
    for _ in range(6):
        nodes = _nodes(xml_text)
        search_input = _find(nodes, resource_suffix="rs_search_src_text")
        if search_input is not None:
            return xml_text
        search = _find(nodes, resource_suffix="chrome_search_box")
        if search is None:
            search = _find(nodes, desc_prefix="Search")
        if search is not None:
            _tap(search)
            time.sleep(1)
        else:
            _shell("input", "keyevent", "4")
            time.sleep(1)
        xml_text = _dump()
    raise RuntimeError("Amazon search UI could not be opened")


def _clear_search_history() -> dict:
    xml_text = _open_search(_open_amazon())
    removed = 0
    for _ in range(12):
        nodes = _nodes(xml_text)
        delete_node = None
        history_visible = any(
            token in _label(node).casefold()
            for node in nodes
            for token in ("recent search", "search history", "clear history")
        )
        for node in nodes:
            label = _label(node).casefold()
            resource = node.attrib.get("resource-id", "").casefold()
            if node.attrib.get("clickable") != "true":
                continue
            if any(token in label or token in resource for token in ("delete", "remove", "clear history")):
                delete_node = node
                break
        if delete_node is None and history_visible:
            candidates = []
            for node in nodes:
                bounds = _bounds(node)
                if bounds is None or node.attrib.get("clickable") != "true":
                    continue
                left, top, right, bottom = bounds
                if left >= 850 and 280 <= top <= 1400 and node.attrib.get("class", "").endswith(("ImageView", "Button")):
                    candidates.append(node)
            if candidates:
                delete_node = candidates[0]
        if delete_node is None:
            break
        _tap(delete_node)
        removed += 1
        time.sleep(1)
        xml_text = _dump()
    _shell("input", "keyevent", "4")
    return {
        "ok": True,
        "skill": "amazon_clear_search_history",
        "removed_visible_entries": removed,
        "verification": "no_visible_history_delete_control",
    }


def main() -> int:
    if len(sys.argv) != 2:
        raise RuntimeError("Expected exactly one JSON payload argument")
    payload = json.loads(sys.argv[1])
    skill_name = payload.get("skill_name")
    if skill_name == "amazon_open_cart":
        result = _open_cart()
    elif skill_name == "amazon_clear_search_history":
        result = _clear_search_history()
    else:
        raise RuntimeError(f"Unsupported verifier skill: {skill_name!r}")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
