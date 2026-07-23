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
from tools.registry import registry, tool_error
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
    return f"http://127.0.0.1:{_dashboard_port()}/api/plugins/dev-browser"


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

    try:
        from plugins.dev_browser.dashboard.plugin_api import (
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

    while time.time() < deadline:
        try:
            req = urllib.request.Request(url, method="GET")
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
        ok = desktop_ui.emit("dev-browser.navigate", {"url": target, "label": label})
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
        ok = desktop_ui.emit("dev-browser.eval", {
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
        ok = desktop_ui.emit("dev-browser.screenshot", {
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
    ok = desktop_ui.emit("dev-browser.list-tabs", {"request_id": request_id})
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
    ok = desktop_ui.emit("dev-browser.new-tab", {"url": target, "label": label.strip(), "request_id": request_id})
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
    ok = desktop_ui.emit("dev-browser.close-tab", {"index": index, "request_id": request_id})
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
    ok = desktop_ui.emit("dev-browser.switch-tab", {"index": index, "request_id": request_id})
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
    ok = desktop_ui.emit("dev-browser.get-url", {"request_id": request_id})
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
    ok = desktop_ui.emit("dev-browser.get-console", {"level": level.strip(), "request_id": request_id})
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
    ok = desktop_ui.emit("dev-browser.clear-console", {"request_id": request_id})
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
    ok = desktop_ui.emit("dev-browser.get-network", {"request_id": request_id})
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
    ok = desktop_ui.emit("dev-browser.set-device-mode", {"mode": mode, "request_id": request_id})
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
    ok = desktop_ui.emit("dev-browser.clear-cache", {"request_id": request_id})
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
    ok = desktop_ui.emit("dev-browser.clear-cookies", {"request_id": request_id})
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

registry.register(
    name="dev_browser_navigate",
    toolset="terminal",
    schema=NAVIGATE_SCHEMA,
    handler=lambda args, **kw: dev_browser_navigate(
        url=args.get("url", ""),
        label=args.get("label", ""),
    ),
    check_fn=check_dev_browser_requirements,
    emoji="🌐",
)

registry.register(
    name="dev_browser_eval",
    toolset="terminal",
    schema=EVAL_SCHEMA,
    handler=lambda args, **kw: dev_browser_eval(
        script=args.get("script", ""),
    ),
    check_fn=check_dev_browser_requirements,
    emoji="⚡",
)

registry.register(
    name="dev_browser_screenshot",
    toolset="terminal",
    schema=SCREENSHOT_SCHEMA,
    handler=lambda args, **kw: dev_browser_screenshot(),
    check_fn=check_dev_browser_requirements,
    emoji="📸",
)

registry.register(name="dev_browser_list_tabs", toolset="terminal", schema=LIST_TABS_SCHEMA, handler=lambda args, **kw: dev_browser_list_tabs(), check_fn=check_dev_browser_requirements, emoji="📋")
registry.register(name="dev_browser_new_tab", toolset="terminal", schema=NEW_TAB_SCHEMA, handler=lambda args, **kw: dev_browser_new_tab(url=args.get("url",""), label=args.get("label","")), check_fn=check_dev_browser_requirements, emoji="🗂️")
registry.register(name="dev_browser_close_tab", toolset="terminal", schema=CLOSE_TAB_SCHEMA, handler=lambda args, **kw: dev_browser_close_tab(index=args.get("index",-1)), check_fn=check_dev_browser_requirements, emoji="❌")
registry.register(name="dev_browser_switch_tab", toolset="terminal", schema=SWITCH_TAB_SCHEMA, handler=lambda args, **kw: dev_browser_switch_tab(index=args.get("index",0)), check_fn=check_dev_browser_requirements, emoji="🔄")
registry.register(name="dev_browser_get_url", toolset="terminal", schema=GET_URL_SCHEMA, handler=lambda args, **kw: dev_browser_get_url(), check_fn=check_dev_browser_requirements, emoji="🔗")
registry.register(name="dev_browser_get_console", toolset="terminal", schema=GET_CONSOLE_SCHEMA, handler=lambda args, **kw: dev_browser_get_console(level=args.get("level","")), check_fn=check_dev_browser_requirements, emoji="📟")
registry.register(name="dev_browser_clear_console", toolset="terminal", schema=CLEAR_CONSOLE_SCHEMA, handler=lambda args, **kw: dev_browser_clear_console(), check_fn=check_dev_browser_requirements, emoji="🧹")
registry.register(name="dev_browser_get_network", toolset="terminal", schema=GET_NETWORK_SCHEMA, handler=lambda args, **kw: dev_browser_get_network(), check_fn=check_dev_browser_requirements, emoji="📡")
registry.register(name="dev_browser_set_device_mode", toolset="terminal", schema=SET_DEVICE_MODE_SCHEMA, handler=lambda args, **kw: dev_browser_set_device_mode(mode=args.get("mode","desktop")), check_fn=check_dev_browser_requirements, emoji="📱")
registry.register(name="dev_browser_clear_cache", toolset="terminal", schema=CLEAR_CACHE_SCHEMA, handler=lambda args, **kw: dev_browser_clear_cache(), check_fn=check_dev_browser_requirements, emoji="🗑️")
registry.register(name="dev_browser_clear_cookies", toolset="terminal", schema=CLEAR_COOKIES_SCHEMA, handler=lambda args, **kw: dev_browser_clear_cookies(), check_fn=check_dev_browser_requirements, emoji="🍪")

# --- Tool: dev_browser_pick_element ---

def dev_browser_pick_element(insert_to_composer: bool = True) -> str:
    """Start an element picker in the Dev Browser. The user clicks an element
    in the webview, and its reference (selector, HTML, text, attributes) is
    captured and optionally inserted into the chat composer.

    Args:
        insert_to_composer: If True, insert the element reference into the chat
            composer so the user can send it to the agent. If False, the result
            is returned to the calling agent only.
    """
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("dev-browser.pick-element", {
        "request_id": request_id,
        "insert_to_composer": insert_to_composer,
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
        "inserted_to_composer": insert_to_composer,
    }, ensure_ascii=False)


PICK_ELEMENT_SCHEMA = {
    "name": "dev_browser_pick_element",
    "description": (
        "Start an element picker in the Dev Browser. The user clicks an element "
        "in the browser, and its reference (CSS selector, HTML, text content, "
        "attributes, position, size) is captured. When insert_to_composer is True "
        "(default), the reference is also inserted into the chat composer so the "
        "user can send it to the agent for further work."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "insert_to_composer": {
                "type": "boolean",
                "description": "If true, insert the picked element reference into the chat composer. Default: true.",
                "default": True,
            },
        },
        "required": [],
    },
}

registry.register(
    name="dev_browser_pick_element",
    toolset="terminal",
    schema=PICK_ELEMENT_SCHEMA,
    handler=lambda args, **kw: dev_browser_pick_element(
        insert_to_composer=args.get("insert_to_composer", True),
    ),
    check_fn=check_dev_browser_requirements,
    emoji="🎯",
)

# ---------------------------------------------------------------------------
# Tool: dev_browser_mouse_move
# ---------------------------------------------------------------------------

def dev_browser_mouse_move(x: int, y: int) -> str:
    """Move the mouse cursor to (x, y) coordinates in the browser."""
    request_id = str(uuid.uuid4())
    ok = desktop_ui.emit("dev-browser.mouse-move", {"x": x, "y": y, "request_id": request_id})
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
    ok = desktop_ui.emit("dev-browser.click", {"x": x, "y": y, "button": button, "double": double, "request_id": request_id})
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
    ok = desktop_ui.emit("dev-browser.type", {"text": text, "request_id": request_id})
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
    ok = desktop_ui.emit("dev-browser.press-key", {"key": key, "request_id": request_id})
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
    ok = desktop_ui.emit("dev-browser.scroll", {"x": x, "y": y, "direction": direction, "amount": amount, "request_id": request_id})
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
    ok = desktop_ui.emit("dev-browser.drag", {"x1": x1, "y1": y1, "x2": x2, "y2": y2, "request_id": request_id})
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

registry.register(name="dev_browser_mouse_move", toolset="terminal", schema=MOUSE_MOVE_SCHEMA, handler=lambda args, **kw: dev_browser_mouse_move(x=args.get("x",0), y=args.get("y",0)), check_fn=check_dev_browser_requirements, emoji="🖱️")
registry.register(name="dev_browser_click", toolset="terminal", schema=CLICK_SCHEMA, handler=lambda args, **kw: dev_browser_click(x=args.get("x",0), y=args.get("y",0), button=args.get("button","left"), double=args.get("double",False)), check_fn=check_dev_browser_requirements, emoji="👆")
registry.register(name="dev_browser_type", toolset="terminal", schema=TYPE_SCHEMA, handler=lambda args, **kw: dev_browser_type(text=args.get("text","")), check_fn=check_dev_browser_requirements, emoji="⌨️")
registry.register(name="dev_browser_press_key", toolset="terminal", schema=PRESS_KEY_SCHEMA, handler=lambda args, **kw: dev_browser_press_key(key=args.get("key","")), check_fn=check_dev_browser_requirements, emoji="🔑")
registry.register(name="dev_browser_scroll", toolset="terminal", schema=SCROLL_SCHEMA, handler=lambda args, **kw: dev_browser_scroll(x=args.get("x",0), y=args.get("y",0), direction=args.get("direction","down"), amount=args.get("amount",300)), check_fn=check_dev_browser_requirements, emoji="📜")
registry.register(name="dev_browser_drag", toolset="terminal", schema=DRAG_SCHEMA, handler=lambda args, **kw: dev_browser_drag(x1=args.get("x1",0), y1=args.get("y1",0), x2=args.get("x2",0), y2=args.get("y2",0)), check_fn=check_dev_browser_requirements, emoji="✋")
