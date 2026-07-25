---
name: hermes-dev-browser
description: "Control the Dev Browser pane in Hermes Desktop — 41 tools for navigation, DOM inspection, form automation, mouse/keyboard simulation, network interception, screenshots, tab management, and more."
version: 2.1.0
license: MIT
---

# Hermes Dev Browser — Agent Skill

Control the Dev Browser webview pane from within a Hermes chat session. The browser lives beside the chat in the Hermes desktop app, and you (the agent) can drive it with **41 tools**.

## When to Use

- The user asks you to open a web page, dev server, or localhost app
- The user wants you to inspect a page (read DOM, run JS, take screenshots)
- The user wants to debug a web app (read console errors, check network requests)
- The user asks you to pick an element from the browser and work with its reference
- The user wants to automate a web flow (click buttons, fill forms, type text)
- The user wants to test login flows, clear cookies, or switch device modes
- The user wants to wait for elements, intercept network calls, or export PDFs

## Prerequisites

- The Hermes desktop app must be running (tools are gated on `HERMES_DESKTOP`)
- The Dev Browser plugin must be installed and loaded
- If tools don't appear, the user needs to `/reset` or restart the desktop app

## Tools Reference (41 tools)

### Navigation & Inspection (5)

| Tool | Params | Returns | Notes |
|------|--------|---------|-------|
| `dev_browser_navigate` | `url` (required), `label` (optional) | `{success, url}` | Navigates the active tab. Bare domains auto-normalize. |
| `dev_browser_get_url` | none | `{success, url, title}` | Gets current URL and page title of active tab. |
| `dev_browser_eval` | `script` (required) | `{success, result}` | Executes JS in the page context. Returns any JSON-serializable value. |
| `dev_browser_screenshot` | none | `{success, image_data_url}` | Returns a `data:image/png;base64,...` URL. Use `vision_analyze` to inspect it. |
| `dev_browser_pick_element` | `insert_to_composer` (optional, default true) | `{success, element, inserted_to_composer}` | Starts an interactive element picker. The user clicks an element in the browser. Returns the element's tag, ID, class, CSS selector, HTML, text, attributes, position, and size. When `insert_to_composer=true`, the reference is also inserted into the chat composer. |

### Tab Management (4)

| Tool | Params | Returns | Notes |
|------|--------|---------|-------|
| `dev_browser_list_tabs` | none | `{success, tabs: [{id, url, title, active, loading}]}` | Lists all open tabs. |
| `dev_browser_new_tab` | `url` (required), `label` (optional) | `{success, url, tab_count, active_index}` | Opens a new tab. |
| `dev_browser_close_tab` | `index` (optional, default -1 = active) | `{success, closed, remaining}` | Closes a tab by index. |
| `dev_browser_switch_tab` | `index` (required) | `{success, active_index, url}` | Switches to a tab by index. |

### Console & Network (3)

| Tool | Params | Returns | Notes |
|------|--------|---------|-------|
| `dev_browser_get_console` | `level` (optional: "error", "warn", "log") | `{success, entries, count}` | Returns last 50 console entries. Filter by level. |
| `dev_browser_clear_console` | none | `{success, cleared}` | Clears console for active tab. |
| `dev_browser_get_network` | none | `{success, entries, count}` | Returns last 50 network requests. |

### Device & Storage (3)

| Tool | Params | Returns | Notes |
|------|--------|---------|-------|
| `dev_browser_set_device_mode` | `mode` (required: "desktop", "mobile", "tablet") | `{success, mode}` | Changes viewport size and user-agent. |
| `dev_browser_clear_cache` | none | `{success, cleared}` | Hard reload bypassing cache. |
| `dev_browser_clear_cookies` | none | `{success, cleared}` | Clears localStorage, sessionStorage, and reloads. |

### Mouse & Keyboard Simulation (6)

| Tool | Params | Returns | Notes |
|------|--------|---------|-------|
| `dev_browser_mouse_move` | `x` (int, required), `y` (int, required) | `{success, x, y, method}` | Moves cursor to (x, y) relative to the webview. `method` is 'native' or 'js'. |
| `dev_browser_click` | `x` (int), `y` (int), `button` ("left"\|"right", default "left"), `double` (bool, default false) | `{success, x, y, button, method}` | Clicks at coordinates. Uses native `sendInputEvent` first, JS fallback. |
| `dev_browser_type` | `text` (str, required) | `{success, text, method}` | Types text into the focused element. For native: sends `char` events per character. For JS: sets `el.value` and dispatches `input`/`change` events. |
| `dev_browser_press_key` | `key` (str, required) | `{success, key, method}` | Presses a keyboard key. Examples: 'Enter', 'Tab', 'Escape', 'ArrowDown', 'a', 'Backspace'. |
| `dev_browser_scroll` | `x` (int, default 0), `y` (int, default 0), `direction` ("up"\|"down", default "down"), `amount` (int, default 300) | `{success, direction, amount, method}` | Scrolls at coordinates. Native: `mouseWheel` event. JS: `window.scrollBy()`. |
| `dev_browser_drag` | `x1` (int), `y1` (int), `x2` (int), `y2` (int) | `{success, from, to, method}` | Drags from (x1,y1) to (x2,y2). Native: move+down+move+up sequence. JS: dragstart+drag+dragend events. |

### DOM Inspection & Automation (9)

| Tool | Params | Returns | Notes |
|------|--------|---------|-------|
| `dev_browser_wait_for_selector` | `selector` (str, required), `timeout` (int, default 10000), `visible` (bool, default true) | `{success, selector, found}` | Polls until element exists in DOM. Timeout in ms. |
| `dev_browser_get_page_text` | none | `{success, text}` | Extracts all visible text content from the page. |
| `dev_browser_get_dom_snapshot` | `max_depth` (int, default 5) | `{success, snapshot}` | Returns a simplified DOM tree as JSON. |
| `dev_browser_fill_form` | `fields` (dict, required) | `{success, filled}` | Fills multiple form fields at once. Keys are CSS selectors, values are the text. |
| `dev_browser_wait_for_navigation` | `timeout` (int, default 15000) | `{success, navigated}` | Waits for page navigation to complete. |
| `dev_browser_hover` | `selector` (str, required) | `{success, selector}` | Triggers CSS `:hover` on element by selector. |
| `dev_browser_select_option` | `selector` (str, required), `value` (str, required) | `{success, selector, value}` | Sets value of a `<select>` element. |
| `dev_browser_press_key_combo` | `keys` (list, required) | `{success, keys}` | Presses key combos like ["ctrl", "Enter"]. |
| `dev_browser_get_element_info` | `selector` (str, required) | `{success, element}` | Gets detailed element info: tag, id, classes, attributes, position, size, text. |

### Data & Debugging (9)

| Tool | Params | Returns | Notes |
|------|--------|---------|-------|
| `dev_browser_get_cookies` | none | `{success, cookies}` | Reads cookies for the current page. |
| `dev_browser_get_local_storage` | `key` (str, optional) | `{success, data}` | Gets all localStorage or a specific key. |
| `dev_browser_get_computed_style` | `selector` (str, required), `properties` (list, optional) | `{success, styles}` | Gets computed CSS of an element. |
| `dev_browser_intercept_network` | `url_pattern` (str, optional), `method` (str, optional), `timeout` (int, default 10000) | `{success, request}` | Waits for a specific network request matching the pattern. |
| `dev_browser_screenshot_element` | `selector` (str, required) | `{success, image_data_url}` | Screenshots a single element by selector. |
| `dev_browser_execute_script` | `script` (str, required) | `{success, result}` | Runs multi-line async JS in page context. Supports `await`. |
| `dev_browser_handle_dialog` | `action` (str, default "accept"), `prompt_text` (str, optional) | `{success, action}` | Accept/dismiss alert/confirm/prompt dialogs. |
| `dev_browser_upload_file` | `selector` (str, required), `file_path` (str, required) | `{success, selector}` | Triggers file input dialog and uploads a file. |
| `dev_browser_pdf_export` | none | `{success}` | Triggers the browser print dialog for PDF export. |

### Utilities (2)

| Tool | Params | Returns | Notes |
|------|--------|---------|-------|
| `dev_browser_bookmark_management` | `action` (str: "add", "remove", "list"), `url` (str, optional), `title` (str, optional) | `{success, action}` | Manages bookmarks from the agent. |
| `dev_browser_set_viewport` | `width` (int, required), `height` (int, required) | `{success, width, height}` | Sets custom viewport dimensions. |

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

### Automate a login flow (with wait_for_selector)

```
1. dev_browser_navigate(url="localhost:4000/login")
2. dev_browser_wait_for_selector(selector="#email", timeout=5000)
3. dev_browser_fill_form(fields={"#email": "admin@example.com", "#password": "secret123"})
4. dev_browser_click(x=200, y=350)  → click submit
5. dev_browser_wait_for_navigation(timeout=10000)
6. dev_browser_screenshot()
   → check if login succeeded
7. dev_browser_get_console(level="error")
   → check for errors
```

### Fill and submit a form (with fill_form)

```
1. dev_browser_navigate(url="localhost:4000/register")
2. dev_browser_wait_for_selector(selector="form", timeout=5000)
3. dev_browser_fill_form(fields={
       "#name": "John Doe",
       "#email": "john@example.com",
       "#password": "securepass123"
   })
4. dev_browser_press_key_combo(keys=["ctrl", "Enter"])
5. dev_browser_wait_for_navigation(timeout=15000)
6. dev_browser_screenshot()
```

### Debug a page with console and network

```
1. dev_browser_navigate(url="localhost:4000")
2. dev_browser_get_console(level="error")
3. dev_browser_get_network()
4. dev_browser_eval(script="document.title")
5. dev_browser_screenshot()
```

### Intercept an API call

```
1. dev_browser_navigate(url="localhost:4000/dashboard")
2. dev_browser_intercept_network(url_pattern="/api/data", method="GET", timeout=10000)
   → returns the request details when it matches
3. dev_browser_get_console(level="error")
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

## Mouse/Keyboard Simulation — How It Works

Each input tool uses a **dual-path strategy**:

1. **Native** (`webview.sendInputEvent()`) — Real Chromium input events at the OS level. Moves the actual cursor, triggers CSS `:hover`, `:focus`, `:active` states. Works with canvas, video, drag-drop. Requires the window to be focused.

2. **JS fallback** (`webview.executeJavaScript()`) — Synthetic DOM events via `dispatchEvent()`. Doesn't move the cursor visually but triggers all JS event listeners. Used when native fails (pre-dom-ready, iframes, window not focused).

The result includes `method: 'native'` or `method: 'js'` so you know which path was used.

### Coordinate system

All x/y coordinates are **relative to the webview's top-left corner**, not the screen. Use `dev_browser_screenshot()` + `vision_analyze` to find element positions visually before clicking.

## Pitfalls

- **Tools only work in the desktop app.** If `HERMES_DESKTOP` is not set, all tools return an error. The `check_fn` prevents them from appearing outside the desktop.
- **Webview must be dom-ready.** Methods like `canGoBack()`, `getURL()`, `sendInputEvent()` throw before `dom-ready`. All calls are wrapped in try/catch, but results may be empty if the page hasn't loaded yet.
- **Screenshot returns a data URL.** It can be large. Use `vision_analyze` to inspect it visually.
- **Element picker is interactive.** `dev_browser_pick_element` blocks for up to 50 seconds waiting for the user to click. If they don't click, it times out.
- **Console/network entries are capped at 50.** If you need more, clear and reproduce.
- **`dev_browser_clear_cookies` clears localStorage and sessionStorage** via eval, then reloads. It does NOT clear HTTP-only cookies (those require session API access from the main process).
- **User-agent is spoofed to Chrome 131.** Google login works. Some services that check for specific Chrome features (beyond UA) may still detect the webview.
- **Mouse simulation may not work with iframes.** Electron has a known bug (#20333) where `sendInputEvent` doesn't route to nested iframes. The JS fallback handles most cases.
- **`sendInputEvent` requires window focus.** If the Hermes window isn't focused, native input events may not work. The JS fallback doesn't have this requirement.
- **`dev_browser_eval` vs `dev_browser_execute_script`**: Use `eval` for single-line synchronous expressions. Use `execute_script` for multi-line async code with `await`.
- **`dev_browser_fill_form` requires CSS selectors as keys**, not element references. The form fields must exist in the DOM before calling.
- **Handler wrapper required for plugin tools.** The Hermes registry calls handlers as `handler(args_dict, task_id=..., session_id=...)` — a positional dict plus injected kwargs. Plugin tool functions are defined with named parameters (`url`, `x`, `selector`…) and don't accept either. The `_wrap_handler(fn)` function in `__init__.py` uses `inspect.signature` to extract the right keys from the dict and swallows the injected kwargs. Without this wrapper, every tool call fails with `TypeError: got an unexpected keyword argument 'task_id'`. This is the same pattern built-in Hermes tools use (lambda wrappers like `lambda a, **kw: ...`).

## Architecture (for context, not for action)

The communication flow is:

```
Agent → dev_browser_click(x=200, y=300)
  → desktop_ui.emit("hermes-dev-browser.click", {x, y, request_id})
  → Plugin JS receives via host.onEvent("hermes-dev-browser.click")
  → webview.sendInputEvent({type:'mouseDown', x:200, y:300, button:'left'})
    ↳ (fails?) → webview.executeJavaScript("element.dispatchEvent(new MouseEvent(...))")
  → result → ctx.rest('/result', {POST, {request_id, result:{success, method}}})
  → Python tool polls mailbox → returns to agent
```

The mailbox (`plugin_api.py`) is thread-safe with `threading.Lock`. Two retrieval paths: in-process import (fast) and HTTP polling (fallback).
