#!/usr/bin/env python3
"""Dev Browser tools — agent-controlled webview operations.

Gated on ``HERMES_DESKTOP`` (like ``open_preview``, ``focus_pane``). Emits
events through the ``desktop_ui`` bridge; the dev-browser plugin (running
in the renderer) listens and executes. Results come back through the
plugin's REST backend mailbox (``plugin_api.py``).

Two result-retrieval paths:
  1. **Direct in-process** — when the tool runs inside the gateway process
     (the common case in the desktop app), we import the plugin's
     ``_results`` dict directly. No HTTP overhead.
  2. **HTTP fallback** — if the direct import fails (plugin module not on
     ``sys.path`` yet, or running in a subprocess), we poll the REST
     endpoint on the loopback dashboard API.

Tools:
- ``dev_browser_navigate``: Navigate the browser to a URL
- ``dev_browser_eval``: Execute JavaScript in the browser, return result
- ``dev_browser_screenshot``: Capture a screenshot of the browser
"""

import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
import uuid

from tools import desktop_ui
from tools.registry import tool_error
from utils import env_var_enabled


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

_POLL_TIMEOUT_S = 15.0
_POLL_INTERVAL_S = 0.3

# Dashboard API base — the port is configurable via env var.
_DEFAULT_DASHBOARD_PORT = "9119"


def _dashboard_port() -> str:
    """Return the dashboard API port from the environment or the default."""
    return os.environ.get("HERMES_DASHBOARD_PORT", _DEFAULT_DASHBOARD_PORT)


def _api_base() -> str:
    """Build the REST base URL for the dev-browser plugin mailbox."""
    return f"http://127.0.0.1:{_dashboard_port()}/api/plugins/hermes-dev-browser"


# ---------------------------------------------------------------------------
# In-process result mailbox (fast path)
# ---------------------------------------------------------------------------
# When the gateway loads the plugin, ``plugin_api._results`` lives in the
# same process. We cache a reference to it so we don't re-import on every
# poll iteration. ``_mailbox_lock`` is the lock object from the plugin
# module; if it's ``None`` we fall back to HTTP polling.

_mailbox = None  # type: ignore[assignment]  # set lazily by _try_load_in_process_mailbox
_mailbox_lock = None  # type: ignore[assignment]  # set lazily by _try_load_in_process_mailbox
_mailbox_checked = False


def _try_load_in_process_mailbox() -> bool:
    """Attempt to import the plugin's result dict directly.

    Returns True if the in-process mailbox is available (subsequent
    ``_get_result_in_process`` calls will work). Idempotent — only
    performs the import once per process lifetime.
    """
    global _mailbox, _mailbox_lock, _mailbox_checked
    if _mailbox_checked:
        return _mailbox is not None
    _mailbox_checked = True

    # The dashboard loads the plugin module under a dynamic name
    # (hermes_dashboard_plugin_hermes-dev-browser) via importlib. Try that
    # first by scanning sys.modules, then fall back to the old path.
    import sys
    for mod_name, mod in list(sys.modules.items()):
        if "hermes" in mod_name and ("dev_browser" in mod_name or "dev-browser" in mod_name) and "plugin" in mod_name:
            results = getattr(mod, "_results", None)
            lock = getattr(mod, "_results_lock", None)
            if results is not None and lock is not None:
                _mailbox = results
                _mailbox_lock = lock
                return True

    try:
        from plugins.hermes_dev_browser.dashboard.plugin_api import (
            _results as results_dict,
            _results_lock as lock,
        )
        _mailbox = results_dict
        _mailbox_lock = lock
        return True
    except Exception:
        return False


def _get_result_in_process(request_id: str, timeout: float) -> dict | None:
    """Poll the in-process mailbox. Returns the result dict or None on timeout."""
    if _mailbox is None or _mailbox_lock is None:
        return None

    deadline = time.time() + timeout
    while time.time() < deadline:
        with _mailbox_lock:
            entry = _mailbox.get(request_id)
            if entry is not None:
                _mailbox.pop(request_id, None)
                return {"ready": True, "result": entry.get("result")}
        time.sleep(_POLL_INTERVAL_S)
    return None


# ---------------------------------------------------------------------------
# HTTP result polling (fallback path)
# ---------------------------------------------------------------------------

def _get_result_http(request_id: str, timeout: float) -> dict:
    """Poll the REST mailbox for a result. Returns the result dict or error."""
    deadline = time.time() + timeout
    url = f"{_api_base()}/result/{request_id}"

    # In loopback mode, the dashboard gates on _SESSION_TOKEN. Attach it
    # so the HTTP fallback works without a browser cookie.
    session_token = os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN", "")

    while time.time() < deadline:
        try:
            req = urllib.request.Request(url, method="GET")
            if session_token:
                req.add_header("X-Hermes-Session-Token", session_token)
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode())
                if data.get("ready"):
                    return data
        except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, OSError):
            pass
        time.sleep(_POLL_INTERVAL_S)

    return {"error": "timeout waiting for browser response"}


# ---------------------------------------------------------------------------
# Unified poll (tries in-process first, then HTTP)
# ---------------------------------------------------------------------------

def _poll_result(request_id: str, timeout: float = _POLL_TIMEOUT_S) -> dict:
    """Poll for a result. Tries the in-process mailbox first (fast path),
    then falls back to HTTP polling.

    Returns a dict with either ``{"ready": True, "result": ...}`` on success
    or ``{"error": "..."}`` on timeout.
    """
    # Fast path: in-process
    if _try_load_in_process_mailbox():
        result = _get_result_in_process(request_id, timeout)
        if result is not None:
            return result
        return {"error": "timeout waiting for browser response"}

    # Fallback: HTTP polling
    return _get_result_http(request_id, timeout)


# ---------------------------------------------------------------------------
# URL normalization (mirrors open_preview_tool._normalize_target)
# ---------------------------------------------------------------------------

def _normalize_url(raw: str) -> str:
    """Coax a bare host/domain into a fetchable URL; leave paths + schemes alone.

    ``www.cnn.com`` -> ``https://www.cnn.com``; ``localhost:3000`` ->
    ``http://localhost:3000``. File paths and explicit schemes pass through.
    """
    v = raw.strip().strip("`").strip()
    if not v or "://" in v or v.startswith(("/", "./", "../", "~", "file:")):
        return v
    if re.match(r"^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(/|$)", v, re.I):
        return "http://" + v
    if re.match(r"^[\w.-]+\.[a-z]{2,}(:\d+)?(/.*)?$", v, re.I):
        return "https://" + v
    return v


# ---------------------------------------------------------------------------
# Tool: dev_browser_navigate
# ---------------------------------------------------------------------------

def dev_browser_navigate(url: str, label: str = "") -> str:
    """Navigate the dev browser to a URL."""
    target = _normalize_url(url or "")
    if not target:
        return tool_error(
            "url is required — a web URL (https://…), a localhost dev server, "
            "or a bare domain to navigate the Dev Browser to."
        )

    label = (label or "").strip()
    try:
        ok = desktop_ui.emit("hermes-dev-browser.navigate", {"url": target, "label": label})
    except Exception as exc:
        return tool_error(f"Failed to navigate the Dev Browser: {exc}")
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")

    return json.dumps({"success": True, "url": target, "label": label}, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tool: dev_browser_eval
# ---------------------------------------------------------------------------

def dev_browser_eval(script: str) -> str:
    """Execute JavaScript in the dev browser and return the result."""
    if not script or not script.strip():
        return tool_error(
            "script is required — JavaScript to execute in the browser page context."
        )

    request_id = str(uuid.uuid4())

    try:
        ok = desktop_ui.emit("hermes-dev-browser.eval", {
            "script": script,
            "request_id": request_id,
        })
    except Exception as exc:
        return tool_error(f"Failed to send eval request to Dev Browser: {exc}")
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")

    result = _poll_result(request_id)

    if "error" in result:
        return json.dumps(result, ensure_ascii=False)

    return json.dumps({
        "success": True,
        "result": result.get("result"),
        "request_id": request_id,
    }, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tool: dev_browser_screenshot
# ---------------------------------------------------------------------------

def dev_browser_screenshot() -> str:
    """Capture a screenshot of the dev browser."""
    request_id = str(uuid.uuid4())

    try:
        ok = desktop_ui.emit("hermes-dev-browser.screenshot", {
            "request_id": request_id,
        })
    except Exception as exc:
        return tool_error(f"Failed to send screenshot request to Dev Browser: {exc}")
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")

    result = _poll_result(request_id)

    if "error" in result:
        return json.dumps(result, ensure_ascii=False)

    return json.dumps({
        "success": True,
        "image_data_url": result.get("result"),
        "request_id": request_id,
    }, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tool: dev_browser_list_tabs
# ---------------------------------------------------------------------------

def dev_browser_list_tabs() -> str:
    """List all open tabs in the Dev Browser."""
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.list-tabs", {"request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=5.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, "tabs": result.get("result", [])}, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tool: dev_browser_new_tab
# ---------------------------------------------------------------------------

def dev_browser_new_tab(url: str, label: str = "") -> str:
    """Open a new browser tab with the given URL."""
    target = _normalize_url(url or "")
    if not target:
        return tool_error("url is required")
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.new-tab", {"url": target, "label": label.strip(), "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=5.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, "url": target, **result.get("result", {})}, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tool: dev_browser_close_tab
# ---------------------------------------------------------------------------

def dev_browser_close_tab(index: int = -1) -> str:
    """Close a browser tab by index (0-based). Default: active tab."""
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.close-tab", {"index": index, "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=5.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tool: dev_browser_switch_tab
# ---------------------------------------------------------------------------

def dev_browser_switch_tab(index: int) -> str:
    """Switch to a browser tab by index (0-based)."""
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.switch-tab", {"index": index, "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=5.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tool: dev_browser_get_url
# ---------------------------------------------------------------------------

def dev_browser_get_url() -> str:
    """Get the current URL and title of the active browser tab."""
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.get-url", {"request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=5.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tool: dev_browser_get_console
# ---------------------------------------------------------------------------

def dev_browser_get_console(level: str = "") -> str:
    """Get console entries from the active browser tab.

    Args:
        level: Optional filter — 'error', 'warn', or 'log'. Empty = all.
    """
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.get-console", {"level": level.strip(), "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=5.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    entries = result.get("result", [])
    return json.dumps({"success": True, "entries": entries, "count": len(entries) if isinstance(entries, list) else 0}, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tool: dev_browser_clear_console
# ---------------------------------------------------------------------------

def dev_browser_clear_console() -> str:
    """Clear console entries for the active browser tab."""
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.clear-console", {"request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=5.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tool: dev_browser_get_network
# ---------------------------------------------------------------------------

def dev_browser_get_network() -> str:
    """Get recent network requests from the active browser tab."""
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.get-network", {"request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=5.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    entries = result.get("result", [])
    return json.dumps({"success": True, "entries": entries, "count": len(entries) if isinstance(entries, list) else 0}, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tool: dev_browser_set_device_mode
# ---------------------------------------------------------------------------

def dev_browser_set_device_mode(mode: str = "desktop") -> str:
    """Set the browser device emulation mode.

    Args:
        mode: 'desktop', 'mobile', or 'tablet'
    """
    if mode not in ("desktop", "mobile", "tablet"):
        return tool_error("mode must be 'desktop', 'mobile', or 'tablet'")
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.set-device-mode", {"mode": mode, "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=5.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tool: dev_browser_clear_cache
# ---------------------------------------------------------------------------

def dev_browser_clear_cache() -> str:
    """Clear the browser cache and reload the active tab."""
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.clear-cache", {"request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=10.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tool: dev_browser_clear_cookies
# ---------------------------------------------------------------------------

def dev_browser_clear_cookies() -> str:
    """Clear cookies, localStorage, and sessionStorage for the active tab."""
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.clear-cookies", {"request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=10.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Requirements check
# ---------------------------------------------------------------------------

def check_dev_browser_requirements() -> bool:
    """Desktop GUI only — HERMES_DESKTOP is set on the gateway the app spawns."""
    return env_var_enabled("HERMES_DESKTOP")


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

NAVIGATE_SCHEMA = {
    "name": "dev_browser_navigate",
    "description": (
        "Navigate the Dev Browser pane to a URL. The browser pane must be open "
        "in the Hermes desktop app. Accepts web URLs, localhost dev servers, "
        "or bare domains (e.g. example.com, localhost:3000, https://docs.example.com)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": (
                    "URL to navigate to (https://…, http://localhost:3000, "
                    "or a bare domain like example.com)."
                ),
            },
            "label": {
                "type": "string",
                "description": "Optional tab label for the browser pane.",
            },
        },
        "required": ["url"],
    },
}

EVAL_SCHEMA = {
    "name": "dev_browser_eval",
    "description": (
        "Execute JavaScript in the Dev Browser pane and return the result. "
        "Use for DOM inspection, extracting page content, testing interactions, "
        "or debugging. The script runs in the page's context. The result is "
        "returned as a JSON-serializable value."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "script": {
                "type": "string",
                "description": "JavaScript to execute in the browser page context.",
            },
        },
        "required": ["script"],
    },
}

SCREENSHOT_SCHEMA = {
    "name": "dev_browser_screenshot",
    "description": (
        "Capture a screenshot of the Dev Browser pane. Returns a data URL "
        "(image/png) that can be used to view the current page state."
    ),
    "parameters": {
        "type": "object",
        "properties": {},
    },
}

LIST_TABS_SCHEMA = {
    "name": "dev_browser_list_tabs",
    "description": (
        "List all open tabs in the Dev Browser. Returns an array of tab "
        "objects with id, url, title, active, and loading fields."
    ),
    "parameters": {
        "type": "object",
        "properties": {},
    },
}

NEW_TAB_SCHEMA = {
    "name": "dev_browser_new_tab",
    "description": (
        "Open a new browser tab with the given URL. Accepts web URLs, "
        "localhost dev servers, or bare domains."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "URL to open in the new tab.",
            },
            "label": {
                "type": "string",
                "description": "Optional label for the new tab.",
            },
        },
        "required": ["url"],
    },
}

CLOSE_TAB_SCHEMA = {
    "name": "dev_browser_close_tab",
    "description": (
        "Close a browser tab by index (0-based). Defaults to the active "
        "tab when index is -1 or omitted."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "index": {
                "type": "integer",
                "description": "0-based tab index to close. -1 (default) closes the active tab.",
                "default": -1,
            },
        },
    },
}

SWITCH_TAB_SCHEMA = {
    "name": "dev_browser_switch_tab",
    "description": "Switch to a browser tab by index (0-based).",
    "parameters": {
        "type": "object",
        "properties": {
            "index": {
                "type": "integer",
                "description": "0-based tab index to switch to.",
            },
        },
        "required": ["index"],
    },
}

GET_URL_SCHEMA = {
    "name": "dev_browser_get_url",
    "description": (
        "Get the current URL and title of the active browser tab."
    ),
    "parameters": {
        "type": "object",
        "properties": {},
    },
}

GET_CONSOLE_SCHEMA = {
    "name": "dev_browser_get_console",
    "description": (
        "Get console entries from the active browser tab. Optionally "
        "filter by level (error, warn, or log)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "level": {
                "type": "string",
                "enum": ["error", "warn", "log", ""],
                "description": "Optional filter — 'error', 'warn', or 'log'. Empty = all levels.",
                "default": "",
            },
        },
    },
}

CLEAR_CONSOLE_SCHEMA = {
    "name": "dev_browser_clear_console",
    "description": "Clear console entries for the active browser tab.",
    "parameters": {
        "type": "object",
        "properties": {},
    },
}

GET_NETWORK_SCHEMA = {
    "name": "dev_browser_get_network",
    "description": (
        "Get recent network requests from the active browser tab."
    ),
    "parameters": {
        "type": "object",
        "properties": {},
    },
}

SET_DEVICE_MODE_SCHEMA = {
    "name": "dev_browser_set_device_mode",
    "description": (
        "Set the browser device emulation mode. Use 'desktop', 'mobile', "
        "or 'tablet' to emulate different devices."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "mode": {
                "type": "string",
                "enum": ["desktop", "mobile", "tablet"],
                "description": "Device emulation mode.",
                "default": "desktop",
            },
        },
    },
}

CLEAR_CACHE_SCHEMA = {
    "name": "dev_browser_clear_cache",
    "description": "Clear the browser cache and reload the active tab.",
    "parameters": {
        "type": "object",
        "properties": {},
    },
}

CLEAR_COOKIES_SCHEMA = {
    "name": "dev_browser_clear_cookies",
    "description": (
        "Clear cookies, localStorage, and sessionStorage for the active tab."
    ),
    "parameters": {
        "type": "object",
        "properties": {},
    },
}


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

# --- Tool: dev_browser_pick_element ---

def dev_browser_pick_element(copy_to_clipboard: bool = True) -> str:
    """Start an element picker in the Dev Browser. The user clicks an element
    in the webview, and its reference (selector, HTML, text, attributes) is
    captured and optionally copied to the clipboard.

    Args:
        copy_to_clipboard: If True, copy the element reference to the system
            clipboard so the user can paste it anywhere. If False, the result
            is returned to the calling agent only.
    """
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.pick-element", {
        "request_id": request_id,
        "copy_to_clipboard": copy_to_clipboard,
    })
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")

    # The picker waits for user interaction (up to 50s), so use a longer timeout
    result = _poll_result(request_id, timeout=55.0)

    if "error" in result:
        return json.dumps(result, ensure_ascii=False)

    el = result.get("result")
    if not el:
        return json.dumps({"success": False, "error": "no element picked"}, ensure_ascii=False)

    return json.dumps({
        "success": True,
        "element": el,
        "copied_to_clipboard": copy_to_clipboard,
    }, ensure_ascii=False)


PICK_ELEMENT_SCHEMA = {
    "name": "dev_browser_pick_element",
    "description": (
        "Start an element picker in the Dev Browser. The user clicks an element "
        "in the browser, and its reference (CSS selector, HTML, text content, "
        "attributes, position, size) is captured. When copy_to_clipboard is True "
        "(default), the reference is also copied to the system clipboard so the "
        "user can paste it into the chat or anywhere else."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "copy_to_clipboard": {
                "type": "boolean",
                "description": "If true, copy the picked element reference to the system clipboard. Default: true.",
                "default": True,
            },
        },
        "required": [],
    },
}

# ---------------------------------------------------------------------------
# Tool: dev_browser_mouse_move
# ---------------------------------------------------------------------------

def dev_browser_mouse_move(x: int, y: int) -> str:
    """Move the mouse cursor to (x, y) coordinates in the browser."""
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.mouse-move", {"x": x, "y": y, "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=5.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tool: dev_browser_click
# ---------------------------------------------------------------------------

def dev_browser_click(x: int, y: int, button: str = "left", double: bool = False) -> str:
    """Click at (x, y) in the browser. button: 'left' or 'right'. double: True for double-click."""
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.click", {"x": x, "y": y, "button": button, "double": double, "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=5.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tool: dev_browser_type
# ---------------------------------------------------------------------------

def dev_browser_type(text: str) -> str:
    """Type text into the currently focused element in the browser."""
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.type", {"text": text, "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=10.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tool: dev_browser_press_key
# ---------------------------------------------------------------------------

def dev_browser_press_key(key: str) -> str:
    """Press a keyboard key in the browser. Examples: 'Enter', 'Tab', 'Escape', 'ArrowDown', 'a'."""
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.press-key", {"key": key, "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=5.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tool: dev_browser_scroll
# ---------------------------------------------------------------------------

def dev_browser_scroll(x: int = 0, y: int = 0, direction: str = "down", amount: int = 300) -> str:
    """Scroll at (x, y) in the browser. direction: 'up' or 'down'. amount: pixels."""
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.scroll", {"x": x, "y": y, "direction": direction, "amount": amount, "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=5.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Tool: dev_browser_drag
# ---------------------------------------------------------------------------

def dev_browser_drag(x1: int, y1: int, x2: int, y2: int) -> str:
    """Drag from (x1, y1) to (x2, y2) in the browser."""
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.drag", {"x1": x1, "y1": y1, "x2": x2, "y2": y2, "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=10.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Schemas for mouse/keyboard tools
# ---------------------------------------------------------------------------

MOUSE_MOVE_SCHEMA = {
    "name": "dev_browser_mouse_move",
    "description": (
        "Move the mouse cursor to (x, y) coordinates in the Dev Browser pane. "
        "Coordinates are relative to the webview."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "x": {"type": "integer", "description": "X coordinate (pixels) relative to the webview."},
            "y": {"type": "integer", "description": "Y coordinate (pixels) relative to the webview."},
        },
        "required": ["x", "y"],
    },
}

CLICK_SCHEMA = {
    "name": "dev_browser_click",
    "description": (
        "Click at (x, y) coordinates in the Dev Browser pane. Supports left/right "
        "click and double-click."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "x": {"type": "integer", "description": "X coordinate (pixels) relative to the webview."},
            "y": {"type": "integer", "description": "Y coordinate (pixels) relative to the webview."},
            "button": {
                "type": "string",
                "enum": ["left", "right"],
                "description": "Mouse button: 'left' or 'right'.",
                "default": "left",
            },
            "double": {
                "type": "boolean",
                "description": "If true, perform a double-click.",
                "default": False,
            },
        },
        "required": ["x", "y"],
    },
}

TYPE_SCHEMA = {
    "name": "dev_browser_type",
    "description": (
        "Type text into the currently focused element in the Dev Browser. "
        "Use after clicking into an input field or contenteditable element."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "text": {"type": "string", "description": "Text to type into the focused element."},
        },
        "required": ["text"],
    },
}

PRESS_KEY_SCHEMA = {
    "name": "dev_browser_press_key",
    "description": (
        "Press a keyboard key in the Dev Browser. Examples: 'Enter', 'Tab', "
        "'Escape', 'ArrowDown', 'a', 'Backspace'. Use for form submission, "
        "navigation, or keyboard shortcuts."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "key": {"type": "string", "description": "Key to press (e.g. 'Enter', 'Tab', 'Escape', 'ArrowDown', 'a')."},
        },
        "required": ["key"],
    },
}

SCROLL_SCHEMA = {
    "name": "dev_browser_scroll",
    "description": (
        "Scroll the page at (x, y) in the Dev Browser. Direction: 'up' or 'down'. "
        "Amount: pixels to scroll."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "x": {"type": "integer", "description": "X coordinate (pixels) relative to the webview. Default: 0.", "default": 0},
            "y": {"type": "integer", "description": "Y coordinate (pixels) relative to the webview. Default: 0.", "default": 0},
            "direction": {
                "type": "string",
                "enum": ["up", "down"],
                "description": "Scroll direction: 'up' or 'down'.",
                "default": "down",
            },
            "amount": {
                "type": "integer",
                "description": "Number of pixels to scroll.",
                "default": 300,
            },
        },
    },
}

DRAG_SCHEMA = {
    "name": "dev_browser_drag",
    "description": (
        "Drag from (x1, y1) to (x2, y2) in the Dev Browser. Useful for sliders, "
        "drag-and-drop, and reordering elements."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "x1": {"type": "integer", "description": "Start X coordinate (pixels)."},
            "y1": {"type": "integer", "description": "Start Y coordinate (pixels)."},
            "x2": {"type": "integer", "description": "End X coordinate (pixels)."},
            "y2": {"type": "integer", "description": "End Y coordinate (pixels)."},
        },
        "required": ["x1", "y1", "x2", "y2"],
    },
}

# ===========================================================================
# Extended Dev Browser tools
# ===========================================================================

# ---------------------------------------------------------------------------
# Functions
# ---------------------------------------------------------------------------

def dev_browser_wait_for_selector(selector: str, timeout: int = 10000, visible: bool = True) -> str:
    """Wait for an element matching the CSS selector to appear in the page.

    Args:
        selector: CSS selector to wait for.
        timeout: Maximum wait time in milliseconds.
        visible: If True, wait for the element to be visible.
    """
    if not selector or not selector.strip():
        return tool_error("selector is required — a CSS selector to wait for.")
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.wait-for-selector", {
        "selector": selector.strip(),
        "timeout": timeout,
        "visible": visible,
        "request_id": request_id,
    })
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=timeout / 1000.0 + 2.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


def dev_browser_get_page_text() -> str:
    """Get the full text content of the current page."""
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.get-page-text", {"request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=10.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    text = result.get("result", "")
    if not isinstance(text, str):
        text = str(text) if text is not None else ""
    return json.dumps({"success": True, "text": text, "length": len(text)}, ensure_ascii=False)


def dev_browser_get_dom_snapshot(max_depth: int = 5) -> str:
    """Get a snapshot of the DOM tree up to the specified depth.

    Args:
        max_depth: Maximum depth of the DOM tree to traverse.
    """
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.get-dom-snapshot", {"max_depth": max_depth, "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=10.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, "snapshot": result.get("result", {})}, ensure_ascii=False)


def dev_browser_fill_form(fields: dict) -> str:
    """Fill form fields with values.

    Args:
        fields: A dictionary mapping CSS selectors to values.
    """
    if not fields or not isinstance(fields, dict):
        return tool_error("fields is required — a dict of selector→value pairs.")
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.fill-form", {"fields": fields, "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=15.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


def dev_browser_wait_for_navigation(timeout: int = 15000) -> str:
    """Wait for page navigation to complete.

    Args:
        timeout: Maximum wait time in milliseconds.
    """
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.wait-for-navigation", {"timeout": timeout, "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=timeout / 1000.0 + 2.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


def dev_browser_hover(selector: str) -> str:
    """Hover over an element matching the CSS selector.

    Args:
        selector: CSS selector of the element to hover over.
    """
    if not selector or not selector.strip():
        return tool_error("selector is required — a CSS selector of the element to hover over.")
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.hover", {"selector": selector.strip(), "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=5.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


def dev_browser_select_option(selector: str, value: str) -> str:
    """Select an option in a <select> element.

    Args:
        selector: CSS selector of the select element.
        value: Value of the option to select.
    """
    if not selector or not selector.strip():
        return tool_error("selector is required — a CSS selector of the select element.")
    if not value:
        return tool_error("value is required — the value of the option to select.")
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.select-option", {"selector": selector.strip(), "value": value, "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=5.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


def dev_browser_press_key_combo(keys: list) -> str:
    """Press a keyboard key combination.

    Args:
        keys: A list of keys to press simultaneously, e.g. ["ctrl", "Enter"].
    """
    if not keys or not isinstance(keys, list):
        return tool_error("keys is required — a list of keys to press simultaneously.")
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.press-key-combo", {"keys": keys, "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=5.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


def dev_browser_upload_file(selector: str, file_path: str) -> str:
    """Upload a file to a file input element.

    Args:
        selector: CSS selector of the file input element.
        file_path: Path to the file to upload.
    """
    if not selector or not selector.strip():
        return tool_error("selector is required — a CSS selector of the file input element.")
    if not file_path or not file_path.strip():
        return tool_error("file_path is required — the path to the file to upload.")
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.upload-file", {"selector": selector.strip(), "file_path": file_path.strip(), "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=15.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


def dev_browser_handle_dialog(action: str = "accept", prompt_text: str = "") -> str:
    """Handle a browser dialog (alert, confirm, prompt).

    Args:
        action: 'accept' or 'dismiss'.
        prompt_text: Text to enter in a prompt dialog (only used if action is 'accept').
    """
    if action not in ("accept", "dismiss"):
        return tool_error("action must be 'accept' or 'dismiss'")
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.handle-dialog", {"action": action, "prompt_text": prompt_text, "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=5.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


def dev_browser_get_cookies() -> str:
    """Get all cookies for the current page."""
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.get-cookies", {"request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=5.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    cookies = result.get("result", [])
    return json.dumps({"success": True, "cookies": cookies, "count": len(cookies) if isinstance(cookies, list) else 0}, ensure_ascii=False)


def dev_browser_get_local_storage(key: str = "") -> str:
    """Get localStorage entries for the current page.

    Args:
        key: Optional specific key to retrieve. If empty, returns all entries.
    """
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.get-local-storage", {"key": key, "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=5.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


def dev_browser_get_computed_style(selector: str, properties: list = None) -> str:
    """Get computed CSS style for an element.

    Args:
        selector: CSS selector of the element.
        properties: Optional list of CSS property names to retrieve. If empty, returns all.
    """
    if not selector or not selector.strip():
        return tool_error("selector is required — a CSS selector of the element.")
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.get-computed-style", {"selector": selector.strip(), "properties": properties or [], "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=5.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


def dev_browser_intercept_network(url_pattern: str = "", method: str = "", timeout: int = 10000) -> str:
    """Intercept network requests matching a URL pattern.

    Args:
        url_pattern: URL pattern to match (empty = match all).
        method: HTTP method to match (empty = match all).
        timeout: Maximum wait time in milliseconds.
    """
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.intercept-network", {"url_pattern": url_pattern, "method": method, "timeout": timeout, "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=timeout / 1000.0 + 2.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


def dev_browser_screenshot_element(selector: str) -> str:
    """Capture a screenshot of a specific element.

    Args:
        selector: CSS selector of the element to screenshot.
    """
    if not selector or not selector.strip():
        return tool_error("selector is required — a CSS selector of the element to screenshot.")
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.screenshot-element", {"selector": selector.strip(), "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=10.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, "image_data_url": result.get("result", "")}, ensure_ascii=False)


def dev_browser_execute_script(script: str) -> str:
    """Execute a multi-line JavaScript script in the browser and return the result.

    Args:
        script: JavaScript code to execute in the browser page context.
    """
    if not script or not script.strip():
        return tool_error("script is required — JavaScript to execute in the browser.")
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.execute-script", {"script": script, "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=30.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, "result": result.get("result"), "request_id": request_id}, ensure_ascii=False)


def dev_browser_pdf_export() -> str:
    """Export the current page as a PDF."""
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.pdf-export", {"request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=30.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


def dev_browser_bookmark_management(action: str, url: str = "", title: str = "") -> str:
    """Add, remove, or list bookmarks.

    Args:
        action: 'add', 'remove', or 'list'.
        url: URL of the bookmark (required for 'add' and 'remove').
        title: Title for the bookmark (optional, used with 'add').
    """
    if action not in ("add", "remove", "list"):
        return tool_error("action must be 'add', 'remove', or 'list'")
    if action in ("add", "remove") and (not url or not url.strip()):
        return tool_error(f"url is required for action '{action}'")
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.bookmark-management", {"action": action, "url": url.strip(), "title": title.strip(), "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=10.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


def dev_browser_set_viewport(width: int, height: int) -> str:
    """Set the browser viewport size.

    Args:
        width: Viewport width in pixels.
        height: Viewport height in pixels.
    """
    if not isinstance(width, int) or width <= 0:
        return tool_error("width must be a positive integer (pixels).")
    if not isinstance(height, int) or height <= 0:
        return tool_error("height must be a positive integer (pixels).")
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.set-viewport", {"width": width, "height": height, "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=5.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


def dev_browser_get_element_info(selector: str) -> str:
    """Get detailed information about an element.

    Args:
        selector: CSS selector of the element.
    """
    if not selector or not selector.strip():
        return tool_error("selector is required — a CSS selector of the element.")
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("hermes-dev-browser.get-element-info", {"selector": selector.strip(), "request_id": request_id})
    if not ok:
        return tool_error("Dev Browser is only available in the Hermes desktop app.")
    result = _poll_result(request_id, timeout=5.0)
    if "error" in result:
        return json.dumps(result, ensure_ascii=False)
    return json.dumps({"success": True, **result.get("result", {})}, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Schemas for extended tools
# ---------------------------------------------------------------------------

WAIT_FOR_SELECTOR_SCHEMA = {
    "name": "dev_browser_wait_for_selector",
    "description": (
        "Wait for an element matching a CSS selector to appear in the Dev Browser. "
        "Useful for waiting for dynamic content to load before interacting with it."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "selector": {"type": "string", "description": "CSS selector to wait for."},
            "timeout": {"type": "integer", "description": "Maximum wait time in milliseconds.", "default": 10000},
            "visible": {"type": "boolean", "description": "If true, wait for the element to be visible.", "default": True},
        },
        "required": ["selector"],
    },
}

GET_PAGE_TEXT_SCHEMA = {
    "name": "dev_browser_get_page_text",
    "description": "Get the full text content of the current page in the Dev Browser. Returns text and its length.",
    "parameters": {
        "type": "object",
        "properties": {},
    },
}

GET_DOM_SNAPSHOT_SCHEMA = {
    "name": "dev_browser_get_dom_snapshot",
    "description": (
        "Get a snapshot of the DOM tree in the Dev Browser, up to a specified depth. "
        "Useful for understanding page structure."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "max_depth": {"type": "integer", "description": "Maximum depth of the DOM tree to traverse.", "default": 5},
        },
    },
}

FILL_FORM_SCHEMA = {
    "name": "dev_browser_fill_form",
    "description": (
        "Fill multiple form fields at once in the Dev Browser. Pass a dictionary "
        "mapping CSS selectors to the values to fill in each field."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "fields": {
                "type": "object",
                "description": "A dictionary mapping CSS selectors to values to fill in each field.",
            },
        },
        "required": ["fields"],
    },
}

WAIT_FOR_NAVIGATION_SCHEMA = {
    "name": "dev_browser_wait_for_navigation",
    "description": "Wait for page navigation to complete in the Dev Browser. Useful after clicking a link or submitting a form.",
    "parameters": {
        "type": "object",
        "properties": {
            "timeout": {"type": "integer", "description": "Maximum wait time in milliseconds.", "default": 15000},
        },
    },
}

HOVER_SCHEMA = {
    "name": "dev_browser_hover",
    "description": "Hover over an element in the Dev Browser, identified by CSS selector. Triggers hover events and CSS :hover states.",
    "parameters": {
        "type": "object",
        "properties": {
            "selector": {"type": "string", "description": "CSS selector of the element to hover over."},
        },
        "required": ["selector"],
    },
}

SELECT_OPTION_SCHEMA = {
    "name": "dev_browser_select_option",
    "description": "Select an option in a <select> dropdown element in the Dev Browser.",
    "parameters": {
        "type": "object",
        "properties": {
            "selector": {"type": "string", "description": "CSS selector of the select element."},
            "value": {"type": "string", "description": "Value of the option to select."},
        },
        "required": ["selector", "value"],
    },
}

PRESS_KEY_COMBO_SCHEMA = {
    "name": "dev_browser_press_key_combo",
    "description": (
        "Press a keyboard key combination in the Dev Browser. Pass a list of keys "
        "to press simultaneously, e.g. [\"ctrl\", \"Enter\"] or [\"shift\", \"Tab\"]."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "keys": {
                "type": "array",
                "items": {"type": "string"},
                "description": "A list of keys to press simultaneously, e.g. [\"ctrl\", \"Enter\"].",
            },
        },
        "required": ["keys"],
    },
}

UPLOAD_FILE_SCHEMA = {
    "name": "dev_browser_upload_file",
    "description": "Upload a file to a file input element in the Dev Browser.",
    "parameters": {
        "type": "object",
        "properties": {
            "selector": {"type": "string", "description": "CSS selector of the file input element."},
            "file_path": {"type": "string", "description": "Path to the file to upload."},
        },
        "required": ["selector", "file_path"],
    },
}

HANDLE_DIALOG_SCHEMA = {
    "name": "dev_browser_handle_dialog",
    "description": (
        "Handle a browser dialog (alert, confirm, prompt) in the Dev Browser. "
        "Choose to accept or dismiss, and optionally provide text for prompt dialogs."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["accept", "dismiss"],
                "description": "Whether to accept or dismiss the dialog.",
                "default": "accept",
            },
            "prompt_text": {
                "type": "string",
                "description": "Text to enter in a prompt dialog (only used when action is 'accept').",
                "default": "",
            },
        },
    },
}

GET_COOKIES_SCHEMA = {
    "name": "dev_browser_get_cookies",
    "description": "Get all cookies for the current page in the Dev Browser. Returns cookies array and count.",
    "parameters": {
        "type": "object",
        "properties": {},
    },
}

GET_LOCAL_STORAGE_SCHEMA = {
    "name": "dev_browser_get_local_storage",
    "description": (
        "Get localStorage entries for the current page in the Dev Browser. "
        "Pass a key to retrieve a specific entry, or omit to get all entries."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "key": {"type": "string", "description": "Optional specific key to retrieve. If empty, returns all entries."},
        },
    },
}

GET_COMPUTED_STYLE_SCHEMA = {
    "name": "dev_browser_get_computed_style",
    "description": (
        "Get computed CSS style for an element in the Dev Browser. "
        "Optionally filter to specific properties."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "selector": {"type": "string", "description": "CSS selector of the element."},
            "properties": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional list of CSS property names to retrieve. If empty, returns all.",
            },
        },
        "required": ["selector"],
    },
}

INTERCEPT_NETWORK_SCHEMA = {
    "name": "dev_browser_intercept_network",
    "description": (
        "Intercept network requests matching a URL pattern in the Dev Browser. "
        "Useful for capturing API calls and responses."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "url_pattern": {"type": "string", "description": "URL pattern to match (empty = match all).", "default": ""},
            "method": {"type": "string", "description": "HTTP method to match (empty = match all).", "default": ""},
            "timeout": {"type": "integer", "description": "Maximum wait time in milliseconds.", "default": 10000},
        },
    },
}

SCREENSHOT_ELEMENT_SCHEMA = {
    "name": "dev_browser_screenshot_element",
    "description": "Capture a screenshot of a specific element in the Dev Browser, identified by CSS selector. Returns image data URL.",
    "parameters": {
        "type": "object",
        "properties": {
            "selector": {"type": "string", "description": "CSS selector of the element to screenshot."},
        },
        "required": ["selector"],
    },
}

EXECUTE_SCRIPT_SCHEMA = {
    "name": "dev_browser_execute_script",
    "description": (
        "Execute a multi-line JavaScript script in the Dev Browser and return the result. "
        "The script runs in the page's context. Useful for complex DOM manipulation or "
        "data extraction that requires multiple statements."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "script": {"type": "string", "description": "Multi-line JavaScript to execute in the browser page context."},
        },
        "required": ["script"],
    },
}

PDF_EXPORT_SCHEMA = {
    "name": "dev_browser_pdf_export",
    "description": "Export the current page in the Dev Browser as a PDF.",
    "parameters": {
        "type": "object",
        "properties": {},
    },
}

BOOKMARK_MANAGEMENT_SCHEMA = {
    "name": "dev_browser_bookmark_management",
    "description": (
        "Manage bookmarks in the Dev Browser. Add a new bookmark, remove an existing one, "
        "or list all bookmarks."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["add", "remove", "list"],
                "description": "Bookmark action: 'add', 'remove', or 'list'.",
            },
            "url": {"type": "string", "description": "URL of the bookmark (required for 'add' and 'remove')."},
            "title": {"type": "string", "description": "Title for the bookmark (optional, used with 'add')."},
        },
        "required": ["action"],
    },
}

SET_VIEWPORT_SCHEMA = {
    "name": "dev_browser_set_viewport",
    "description": "Set the viewport size of the Dev Browser in pixels.",
    "parameters": {
        "type": "object",
        "properties": {
            "width": {"type": "integer", "description": "Viewport width in pixels."},
            "height": {"type": "integer", "description": "Viewport height in pixels."},
        },
        "required": ["width", "height"],
    },
}

GET_ELEMENT_INFO_SCHEMA = {
    "name": "dev_browser_get_element_info",
    "description": (
        "Get detailed information about an element in the Dev Browser, including "
        "tag name, attributes, position, size, and text content."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "selector": {"type": "string", "description": "CSS selector of the element."},
        },
        "required": ["selector"],
    },
}


# ---------------------------------------------------------------------------
# Registration for extended tools
# ---------------------------------------------------------------------------
