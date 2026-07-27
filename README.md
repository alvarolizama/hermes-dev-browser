# Hermes Dev Browser

A full-featured web browser pane for the [Hermes Agent](https://hermes-agent.nousresearch.com) desktop app. Browse, debug, inspect, and automate web apps directly beside your AI chat — with DevTools, console capture, network monitoring, multi-tab support, OAuth login, bookmarks, incognito mode, element picker, and 41 agent-controlled automation tools.

## What it is

Dev Browser is a desktop plugin that adds a Chromium `<webview>` pane beside the chat in the Hermes desktop app. It's not a separate browser — it lives inside the app window, side by side with your AI agent session, so you can browse, debug, and automate while the agent helps you code.

### Features

- **🌐 Full navigation** — URL bar, back/forward/reload, multi-tab support
- **📌 Pinned tabs** — Right-click any tab to pin/unpin; pinned tabs show only the favicon (centered, compact) and sort to the left, with an unpin button on hover
- **🔖 Bookmarks** — Save pages with a bookmark toggle button (filled accent when saved); bookmarks dropdown shows favicons and titles, click to open in new tab
- **🖼️ Favicons everywhere** — Favicons displayed in tabs, URL bar, and bookmarks dropdown with Globe fallback
- **🔐 Incognito mode** — Toggle incognito with Eye/EyeOff icon; new tabs use an ephemeral partition (no cookies, localStorage, or history persisted)
- **🔐 OAuth & Google login** — User-agent spoofing bypasses Google's Electron webview block; `allowpopups` enables OAuth flows
- **🍪 Persistent sessions** — Cookies, localStorage, and IndexedDB survive app restarts via `persist:hermes-dev-browser` partition
- **🐛 DevTools** — Toggle Chromium DevTools with one click
- **📟 Console panel** — Captures `console.log/warn/error` from the webview, collapsible with drag-resize
- **📡 Network inspector** — Basic request tracking with status code colors
- **📱 Device mode** — Switch between desktop, mobile (375px), and tablet (768px) viewports
- **🔍 Element picker** — Click the ZoomIn icon or right-click anywhere on the page to toggle the element picker; captures CSS selector, HTML, attributes, and text — automatically copied to the clipboard as a reference for the agent
- **📸 Screenshot button** — Click the image icon to capture the current page; the PNG is copied straight to your clipboard as a real image (via the plugin backend — the renderer's image-clipboard permission is denied by Hermes)
- **🖱️ Mouse & keyboard simulation** — Move cursor, click, type, press keys, scroll, and drag — using native Electron `sendInputEvent` with JS fallback. Enables agent-driven automated testing.
- **🤖 Agent-controlled** — 41 tools the AI agent can call to navigate, inspect DOM, fill forms, wait for elements, intercept network requests, take screenshots, manage tabs, simulate input, and more
- **⌨️ Keyboard shortcuts** — `Cmd+R` reload, `Cmd+Option+I` DevTools, `Cmd+L` focus URL bar
- **🎨 Theme-aware** — Uses the app's CSS variables, adapts to any theme automatically
- **↔️ Resizable** — Drag the pane sash to any width, no maximum

## Repo Structure

```
hermes-dev-browser/
├── desktop/
│   └── plugin.js              # Browser pane UI (React, 41 tool event handlers)
├── python/
│   ├── __init__.py             # Tool registration via ctx.register_tool() ×41
│   ├── plugin.yaml             # Plugin manifest (name, version, provides_tools)
│   ├── tools.py                # 41 tool functions + 41 JSON schemas
│   └── dashboard/
│       ├── manifest.json       # Dashboard plugin manifest
│       └── plugin_api.py       # REST mailbox + /copy-image clipboard route (FastAPI)
├── README.md
├── SKILL.md
└── LICENSE
```

## Quickstart (for agents)

> Run these steps as-is. Everything is relative to the clone location (`$REPO`) and `~/.hermes/` — no machine-specific paths.

```bash
# 1. Clone
git clone https://github.com/alvarolizama/hermes-dev-browser.git
cd hermes-dev-browser && export REPO="$PWD"

# 2. Python plugin (41 agent tools + REST backend)
ln -sfn "$REPO/python" ~/.hermes/plugins/hermes-dev-browser

# 3. Desktop plugin (browser pane UI)
ln -sfn "$REPO/desktop" ~/.hermes/desktop-plugins/hermes-dev-browser

# 4. Skill (agent operating manual — symlink the whole repo, SKILL.md must be at the root)
ln -sfn "$REPO" ~/.hermes/skills/software-development/hermes-dev-browser
```

Enable the plugin in `~/.hermes/config.yaml`:

```yaml
plugins:
  enabled:
    - hermes-dev-browser
```

**Dependencies:** none beyond Hermes itself. Restart the Hermes desktop app (or `/reset`) after installing.

## Installation

### Option A: Symlinks (recommended for development)

Clone the repo and symlink the `desktop/` and `python/` directories into Hermes:

```bash
git clone https://github.com/alvarolizama/hermes-dev-browser.git ~/Workspace/Repos/hermes-dev-browser

# Desktop plugin (browser UI) → desktop/
ln -s ~/Workspace/Repos/hermes-dev-browser/desktop ~/.hermes/desktop-plugins/hermes-dev-browser

# Python plugin (agent tools + dashboard) → python/
ln -s ~/Workspace/Repos/hermes-dev-browser/python ~/.hermes/plugins/hermes-dev-browser
```

Edit in `~/Workspace/Repos/hermes-dev-browser/`, git push from there, and Hermes reads changes in real-time via the symlinks. No copy scripts needed.

### Option B: Manual install (for non-dev setups)

```bash
# Desktop plugin (browser UI)
mkdir -p ~/.hermes/desktop-plugins/hermes-dev-browser
curl -o ~/.hermes/desktop-plugins/hermes-dev-browser/plugin.js \
  https://raw.githubusercontent.com/alvarolizama/hermes-dev-browser/main/desktop/plugin.js

# Python plugin (agent tools + dashboard)
mkdir -p ~/.hermes/plugins/hermes-dev-browser/dashboard
curl -o ~/.hermes/plugins/hermes-dev-browser/__init__.py \
  https://raw.githubusercontent.com/alvarolizama/hermes-dev-browser/main/python/__init__.py
curl -o ~/.hermes/plugins/hermes-dev-browser/tools.py \
  https://raw.githubusercontent.com/alvarolizama/hermes-dev-browser/main/python/tools.py
curl -o ~/.hermes/plugins/hermes-dev-browser/plugin.yaml \
  https://raw.githubusercontent.com/alvarolizama/hermes-dev-browser/main/python/plugin.yaml
curl -o ~/.hermes/plugins/hermes-dev-browser/dashboard/manifest.json \
  https://raw.githubusercontent.com/alvarolizama/hermes-dev-browser/main/python/dashboard/manifest.json
curl -o ~/.hermes/plugins/hermes-dev-browser/dashboard/plugin_api.py \
  https://raw.githubusercontent.com/alvarolizama/hermes-dev-browser/main/python/dashboard/plugin_api.py
```

### Enable the plugin in config.yaml

Add `hermes-dev-browser` to `plugins.enabled` in `~/.hermes/config.yaml`:

```yaml
plugins:
  enabled:
    - hermes-dev-browser
```

### Reload

- **⌘K** → **"Reload desktop plugins"** in the Hermes desktop app
- Start a new session (`/reset`) so the new tools load

> **Python backend changes need a dashboard restart.** The dashboard runs as a
> launchd service (`com.hermes.dashboard`) that survives app restarts, so edits
> under `python/dashboard/` don't take effect until you restart it:
>
> ```bash
> launchctl kickstart -k gui/$(id -u)/com.hermes.dashboard
> ```
>
> Without this, new REST routes return `405 Method Not Allowed` (the request
> falls through to the SPA catch-all, which only allows GET).

> **Note:** No need to edit `toolsets.py` or `hermes-agent/tools/`. The Python plugin registers all 41 tools dynamically via `ctx.register_tool()`, so it survives Hermes updates without modification.

## Usage

### Manual browsing

1. **⌘K** → **"Open Dev Browser"** to open the pane
2. Type a URL in the address bar and press Enter
3. Use back/forward/reload buttons for navigation
4. Click the **ZoomIn** 🔍 icon (or right-click the page) to toggle the element picker
5. Click any element in the browser → its reference is copied to your clipboard
6. Click the **image** 📸 icon to capture the page → the PNG lands in your clipboard
7. Click the **bookmark** 🔖 icon to save the current page
8. Click the **Eye/EyeOff** icon to toggle incognito mode

### Agent-controlled browsing

The agent can control the browser using 41 tools. Ask it to:

- "Open localhost:4000 in the dev browser"
- "Take a screenshot of the current page"
- "Run `document.title` in the browser"
- "Wait for the `#submit-button` selector to appear"
- "Get the page text content"
- "Fill the login form with email and password"
- "Get the DOM snapshot of the page"
- "Hover over the dropdown menu"
- "Select the second option in the country dropdown"
- "Press Ctrl+Enter to submit the form"
- "Wait for the API call to `/api/login` to complete"
- "Get the computed style of the header element"
- "Take a screenshot of just the navigation bar"
- "Get all cookies for the current page"
- "Execute a multi-line script that fetches data from the API"

### Element picker

Click the 🔍 icon in the toolbar (or right-click anywhere on the page, or ⌘K → "Dev Browser: Pick Element"), then click any element in the browser. The element's selector, HTML, attributes, and text are formatted and copied to your clipboard — paste them wherever you need:

```
🔍 Element picked from http://localhost:4000/login

Tag: input#email.form-input
Selector: form > input#email
Size: 280x36
Position: 120,240
Text: ""

​```html
<input id="email" type="text" class="form-input" placeholder="admin" required="">
​```
```

### Screenshot button

Click the 📸 image icon in the toolbar to capture the visible page. The PNG lands in your clipboard as a **real image** (not a data URL) — paste it straight into the chat, Slack, Preview, anywhere.

Image clipboard writes go through the plugin's Python backend (`POST /api/plugins/hermes-dev-browser/copy-image` → macOS `osascript`), because Hermes' permission handler denies `navigator.clipboard.write` in the renderer. The button shows a warning toast if the backend route isn't reachable (see [Reload](#reload)).

### Mouse & keyboard simulation

The agent can simulate real mouse movement, clicks, typing, key presses, scrolling, and drag-and-drop. Each tool tries native Electron `sendInputEvent` first (real Chromium input events), then falls back to synthetic JS events if that fails.

```python
# Move mouse
dev_browser_mouse_move(x=200, y=300)

# Click
dev_browser_click(x=200, y=300, button="left", double=False)

# Type text
dev_browser_type(text="hello@example.com")

# Press key
dev_browser_press_key(key="Enter")

# Scroll
dev_browser_scroll(x=0, y=0, direction="down", amount=500)

# Drag
dev_browser_drag(x1=100, y1=100, x2=300, y2=300)

# Press key combo (Ctrl+Enter, Shift+Tab, etc)
dev_browser_press_key_combo(keys=["ctrl", "Enter"])

# Hover over an element by selector
dev_browser_hover(selector="#dropdown-menu")

# Select an option in a <select> dropdown
dev_browser_select_option(selector="#country", value="MX")
```

### DOM inspection & automation

```python
# Wait for an element to appear (with timeout)
dev_browser_wait_for_selector(selector="#results", timeout=10000, visible=True)

# Get all visible text from the page
dev_browser_get_page_text()

# Get a simplified DOM tree as JSON
dev_browser_get_dom_snapshot(max_depth=5)

# Fill multiple form fields at once
dev_browser_fill_form(fields={
    "#email": "admin@example.com",
    "#password": "secret123"
})

# Wait for page navigation to complete
dev_browser_wait_for_navigation(timeout=15000)

# Get detailed info about an element by selector
dev_browser_get_element_info(selector="#submit-btn")
```

### Data & debugging

```python
# Get cookies
dev_browser_get_cookies()

# Get localStorage (all or by key)
dev_browser_get_local_storage(key="auth_token")

# Get computed CSS styles
dev_browser_get_computed_style(selector="header", properties=["display", "position"])

# Intercept a specific network request
dev_browser_intercept_network(url_pattern="/api/login", method="POST", timeout=10000)

# Take a screenshot of a single element
dev_browser_screenshot_element(selector="#chart")

# Execute multi-line async JS
dev_browser_execute_script(script="""
const res = await fetch('/api/data');
const data = await res.json();
return data;
""")

# Handle alert/confirm/prompt dialogs
dev_browser_handle_dialog(action="accept", prompt_text="Hello")

# Upload a file (opens file dialog)
dev_browser_upload_file(selector="input[type=file]", file_path="/path/to/file.pdf")

# Export page as PDF (opens print dialog)
dev_browser_pdf_export()

# Set custom viewport size
dev_browser_set_viewport(width=1024, height=768)
```

## Agent Tools (41 total)

### Navigation & Inspection (5)

| Tool | Emoji | Description |
|------|-------|-------------|
| `dev_browser_navigate` | 🌐 | Navigate to a URL |
| `dev_browser_eval` | ⚡ | Execute JavaScript, return result |
| `dev_browser_screenshot` | 📸 | Capture screenshot as data URL |
| `dev_browser_get_url` | 🔗 | Get current URL and title |
| `dev_browser_pick_element` | 🎯 | Start element picker, capture element ref (copies to clipboard) |

### Tab Management (4)

| Tool | Emoji | Description |
|------|-------|-------------|
| `dev_browser_list_tabs` | 📋 | List all open tabs |
| `dev_browser_new_tab` | 🗂️ | Open a new tab with a URL |
| `dev_browser_close_tab` | ❌ | Close a tab by index |
| `dev_browser_switch_tab` | 🔄 | Switch active tab by index |

### Console & Network (3)

| Tool | Emoji | Description |
|------|-------|-------------|
| `dev_browser_get_console` | 📟 | Get console entries (with level filter) |
| `dev_browser_clear_console` | 🧹 | Clear console entries |
| `dev_browser_get_network` | 📡 | Get network request entries |

### Device & Storage (3)

| Tool | Emoji | Description |
|------|-------|-------------|
| `dev_browser_set_device_mode` | 📱 | Set device mode (desktop/mobile/tablet) |
| `dev_browser_clear_cache` | 🗑️ | Clear cache and reload |
| `dev_browser_clear_cookies` | 🍪 | Clear cookies and storage |

### Mouse & Keyboard Simulation (6)

| Tool | Emoji | Description |
|------|-------|-------------|
| `dev_browser_mouse_move` | 🖱️ | Move cursor to (x, y) |
| `dev_browser_click` | 👆 | Click at (x, y) — left/right/double |
| `dev_browser_type` | ⌨️ | Type text into focused element |
| `dev_browser_press_key` | 🔑 | Press keyboard key (Enter, Tab, etc) |
| `dev_browser_scroll` | 📜 | Scroll at (x, y) up/down |
| `dev_browser_drag` | ✋ | Drag from (x1,y1) to (x2,y2) |

### DOM Inspection & Automation (9)

| Tool | Emoji | Description |
|------|-------|-------------|
| `dev_browser_wait_for_selector` | ⏳ | Poll until element exists (with timeout) |
| `dev_browser_get_page_text` | 📄 | Extract all visible text from page |
| `dev_browser_get_dom_snapshot` | 🌳 | Simplified DOM tree as JSON |
| `dev_browser_fill_form` | 📝 | Fill multiple form fields at once |
| `dev_browser_wait_for_navigation` | ⏱️ | Wait for page load to complete |
| `dev_browser_hover` | 🖱️ | Trigger CSS :hover on element by selector |
| `dev_browser_select_option` | 📋 | Set value of a `<select>` element |
| `dev_browser_press_key_combo` | ⌨️ | Press key combos (Ctrl+Enter, Shift+Tab) |
| `dev_browser_get_element_info` | 🔍 | Detailed element info by selector |

### Data & Debugging (9)

| Tool | Emoji | Description |
|------|-------|-------------|
| `dev_browser_get_cookies` | 🍪 | Read cookies for current page |
| `dev_browser_get_local_storage` | 💾 | Get all or specific localStorage entries |
| `dev_browser_get_computed_style` | 🎨 | Get computed CSS of element |
| `dev_browser_intercept_network` | 📡 | Wait for specific network request pattern |
| `dev_browser_screenshot_element` | 📸 | Screenshot a single element by selector |
| `dev_browser_execute_script` | 📜 | Run multi-line async JS in page context |
| `dev_browser_handle_dialog` | 💬 | Accept/dismiss alert/confirm/prompt |
| `dev_browser_upload_file` | 📎 | Trigger file input dialog |
| `dev_browser_pdf_export` | 📄 | Trigger print dialog |

### Utilities (2)

| Tool | Emoji | Description |
|------|-------|-------------|
| `dev_browser_bookmark_management` | 🔖 | Add/remove/list bookmarks from agent |
| `dev_browser_set_viewport` | 📐 | Set custom viewport dimensions |

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Hermes Desktop (Electron 40 / Chromium 144)                  │
│                                                                │
│  ┌───────────────┐  ┌────────────────────────────────────────┐ │
│  │   Chat        │  │  Dev Browser Pane (plugin.js)           │ │
│  │               │  │ ┌──────────────────────────────────────┐ │ │
│  │  Agent calls  │  │ │ ◀ ▶ ⟳ 🔖 │ localhost:4000  │ 🔖 👁  │ │ │
│  │  dev_browser_*│◄─┤ ├──────────────────────────────────────┤ │ │
│  │  tools        │  │ │  <webview> (Electron)                │ │ │
│  │  (41 tools)   │  │ │  - UA: Chrome 131 (spoofed)          │ │ │
│  │               │  │ │  - allowpopups (OAuth)               │ │ │
│  │               │  │ │  - persist:hermes-dev-browser         │ │ │
│  │               │  │ │  - DevTools toggle 🐛                │ │ │
│  │               │  │ │  - sendInputEvent (mouse/keyboard)   │ │ │
│  │               │  │ ├──────────────────────────────────────┤ │ │
│  │               │  │ │ Console / Network (collapsible)      │ │ │
│  │               │  │ └──────────────────────────────────────┘ │ │
│  └───────────────┘  └────────────────────────────────────────┘ │
│                                                                │
│  Python Plugin (~/.hermes/plugins/hermes-dev-browser/)          │
│  ├── __init__.py  → register(ctx) — ctx.register_tool() ×41    │
│  ├── tools.py     → 41 tool functions + 41 schemas              │
│  ├── plugin.yaml  → manifest with provides_tools               │
│  └── dashboard/   → plugin_api.py (REST mailbox)               │
│                                                                │
│  No hermes-agent core files modified — survives updates.       │
└──────────────────────────────────────────────────────────────┘
```

### Mouse/keyboard simulation — dual-path architecture

Each input tool tries two methods:

1. **Native** (`webview.sendInputEvent()`) — Real Chromium input events. Moves the actual cursor, triggers `:hover`, `:focus`, `:active` CSS states. Works with canvas, video, drag-drop. Requires the window to be focused.

2. **JS fallback** (`webview.executeJavaScript()`) — Synthetic DOM events dispatched via `dispatchEvent()`. Doesn't move the cursor visually but triggers all JS event listeners. Used when `sendInputEvent` fails (pre-dom-ready, iframes, etc).

The result includes `method: 'native'` or `method: 'js'` so the agent knows which path was used.

### Tool registration — plugin system (survives Hermes updates)

Tools are registered via the Hermes plugin system, not by editing core files:

1. **`__init__.py`** has a `register(ctx)` function called by the plugin loader
2. It calls `ctx.register_tool()` for each of the 41 tools, registering them in the `terminal` toolset
3. Each handler is wrapped with `_wrap_handler(fn)` — an adapter that bridges the gap between the registry's dispatch convention (`handler(args_dict, task_id=..., session_id=...)`) and the plugin functions' named parameters (`url`, `x`, `selector`…). Without this wrapper, all tool calls fail with `TypeError: got an unexpected keyword argument 'task_id'`
4. All tools are gated on `HERMES_DESKTOP` via `check_fn` — they only appear when the desktop app is running
5. **Relative imports** (`from .tools import ...`) ensure the plugin loads correctly under the `hermes_plugins.<slug>` namespace that Hermes' plugin loader creates — no need to edit `toolsets.py` or `hermes-agent/tools/`

## How it works

- **Plugin JS** (`desktop/plugin.js`) — A disk plugin loaded by the Hermes desktop app. Registers a pane with a `<webview>` element, toolbar, tabs, bookmarks, incognito mode, console, network, element picker, and input simulation. Listens for events from the agent via `host.onEvent`.

- **Python Plugin** (`python/__init__.py` + `python/tools.py`) — Registers 41 agent tools via `ctx.register_tool()`. Each tool emits an event to the plugin JS via `desktop_ui.emit()`, then polls the REST mailbox (or uses in-process import) for results.

- **Backend** (`python/dashboard/plugin_api.py`) — A FastAPI router mounted at `/api/plugins/hermes-dev-browser/`. Acts as a thread-safe in-memory result mailbox: the plugin JS POSTs results here after executing agent commands (eval, screenshot, click), and the Python tools poll for them.

## Requirements

- [Hermes Agent](https://hermes-agent.nousresearch.com) desktop app (Electron 40+)
- The desktop app must be running (tools are gated on `HERMES_DESKTOP`)

## License

MIT
