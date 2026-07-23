---
name: hermes-dev-browser
description: "Control the Dev Browser pane in Hermes Desktop — navigate, inspect, pick elements, manage tabs, read console, and more."
version: 1.0.0
license: MIT
---

# Hermes Dev Browser — Agent Skill

Control the Dev Browser webview pane from within a Hermes chat session. The browser lives beside the chat in the Hermes desktop app, and you (the agent) can drive it with 15 tools.

## When to Use

- The user asks you to open a web page, dev server, or localhost app
- The user wants you to inspect a page (read DOM, run JS, take screenshots)
- The user wants to debug a web app (read console errors, check network requests)
- The user asks you to pick an element from the browser and work with its reference
- The user wants to test login flows, clear cookies, or switch device modes

## Prerequisites

- The Hermes desktop app must be running (tools are gated on `HERMES_DESKTOP`)
- The Dev Browser plugin must be installed and loaded
- If tools don't appear, the user needs to `/reset` or restart the desktop app

## Tools Reference

### Navigation

| Tool | Params | Returns | Notes |
|------|--------|---------|-------|
| `dev_browser_navigate` | `url` (required), `label` (optional) | `{success, url}` | Navigates the active tab. Bare domains auto-normalize. |
| `dev_browser_get_url` | none | `{success, url, title}` | Gets current URL and page title of active tab. |

### JavaScript Execution

| Tool | Params | Returns | Notes |
|------|--------|---------|-------|
| `dev_browser_eval` | `script` (required) | `{success, result}` | Executes JS in the page context. Returns any JSON-serializable value. |
| `dev_browser_screenshot` | none | `{success, image_data_url}` | Returns a `data:image/png;base64,...` URL. Use `vision_analyze` to inspect it. |

### Tab Management

| Tool | Params | Returns | Notes |
|------|--------|---------|-------|
| `dev_browser_list_tabs` | none | `{success, tabs: [{id, url, title, active, loading}]}` | Lists all open tabs. |
| `dev_browser_new_tab` | `url` (required), `label` (optional) | `{success, url, tab_count, active_index}` | Opens a new tab. |
| `dev_browser_close_tab` | `index` (optional, default -1 = active) | `{success, closed, remaining}` | Closes a tab by index. |
| `dev_browser_switch_tab` | `index` (required) | `{success, active_index, url}` | Switches to a tab by index. |

### Console & Network

| Tool | Params | Returns | Notes |
|------|--------|---------|-------|
| `dev_browser_get_console` | `level` (optional: "error", "warn", "log") | `{success, entries, count}` | Returns last 50 console entries. Filter by level. |
| `dev_browser_clear_console` | none | `{success, cleared}` | Clears console for active tab. |
| `dev_browser_get_network` | none | `{success, entries, count}` | Returns last 50 network requests. |

### Device & Storage

| Tool | Params | Returns | Notes |
|------|--------|---------|-------|
| `dev_browser_set_device_mode` | `mode` (required: "desktop", "mobile", "tablet") | `{success, mode}` | Changes viewport size and user-agent. |
| `dev_browser_clear_cache` | none | `{success, cleared}` | Hard reload bypassing cache. |
| `dev_browser_clear_cookies` | none | `{success, cleared}` | Clears localStorage, sessionStorage, and reloads. |

### Element Picker

| Tool | Params | Returns | Notes |
|------|--------|---------|-------|
| `dev_browser_pick_element` | `insert_to_composer` (optional, default true) | `{success, element, inserted_to_composer}` | Starts an interactive element picker. The user clicks an element in the browser. Returns the element's tag, ID, class, CSS selector, HTML, text, attributes, position, and size. When `insert_to_composer=true`, the reference is also inserted into the chat composer. |

**Element picker result shape:**
```json
{
  "tagName": "input",
  "id": "email",
  "className": "form-input",
  "selector": "form > input#email",
  "text": "",
  "html": "<input id=\"email\" type=\"text\" ...>",
  "attributes": { "id": "email", "type": "text", "class": "form-input" },
  "rect": { "x": 120, "y": 240, "width": 280, "height": 36 },
  "url": "http://localhost:4000/login",
  "title": "Login"
}
```

## Common Workflows

### Open a dev server and inspect it

```
1. dev_browser_navigate(url="localhost:4000")
2. dev_browser_screenshot()
   → vision_analyze the screenshot to see the page
3. dev_browser_get_console(level="error")
   → check for JS errors
```

### Pick an element and work with it

```
1. dev_browser_pick_element(insert_to_composer=true)
   → user clicks an element in the browser
   → reference appears in chat composer
   → also returns the element data to you
2. Use the selector from the result to run dev_browser_eval:
   dev_browser_eval(script="document.querySelector('form > input#email').value")
```

### Debug a login flow

```
1. dev_browser_navigate(url="localhost:4000/login")
2. dev_browser_eval(script="document.querySelector('form').submit()")
3. dev_browser_get_console(level="error")
4. dev_browser_get_network()
   → check for failed requests
5. dev_browser_screenshot()
   → see where the user ended up
```

### Multi-tab workflow

```
1. dev_browser_new_tab(url="localhost:4000")
2. dev_browser_new_tab(url="localhost:4001")
3. dev_browser_list_tabs()
4. dev_browser_switch_tab(index=0)
5. dev_browser_eval(script="document.title")
6. dev_browser_switch_tab(index=1)
7. dev_browser_screenshot()
```

## Pitfalls

- **Tools only work in the desktop app.** If `HERMES_DESKTOP` is not set, all tools return an error. The `check_fn` prevents them from appearing outside the desktop.
- **Webview must be dom-ready.** Methods like `canGoBack()`, `getURL()` throw before `dom-ready`. All calls are wrapped in try/catch, but results may be empty if the page hasn't loaded yet.
- **Screenshot returns a data URL.** It can be large. Use `vision_analyze` to inspect it visually.
- **Element picker is interactive.** `dev_browser_pick_element` blocks for up to 50 seconds waiting for the user to click. If they don't click, it times out.
- **Console/network entries are capped at 50.** If you need more, clear and reproduce.
- **`dev_browser_clear_cookies` clears localStorage and sessionStorage** via eval, then reloads. It does NOT clear HTTP-only cookies (those require session API access from the main process).
- **User-agent is spoofed to Chrome 131.** Google login works. Some services that check for specific Chrome features (beyond UA) may still detect the webview.

## Architecture (for context, not for action)

The communication flow is:

```
Agent → dev_browser_eval("script")
  → desktop_ui.emit("dev-browser.eval", {script, request_id})
  → Plugin JS receives via host.onEvent("dev-browser.eval")
  → webview.executeJavaScript("script")
  → result → ctx.rest('/result', {POST, {request_id, result}})
  → Python tool polls mailbox → returns to agent
```

The mailbox (`plugin_api.py`) is thread-safe with `threading.Lock`. Two retrieval paths: in-process import (fast) and HTTP polling (fallback).
