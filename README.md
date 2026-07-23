# Hermes Dev Browser

A full-featured web browser pane for the [Hermes Agent](https://hermes-agent.nousresearch.com) desktop app. Browse, debug, inspect, and automate web apps directly beside your AI chat — with DevTools, console capture, network monitoring, multi-tab support, OAuth login, element picker, and mouse/keyboard simulation for automated testing.

## What it is

Dev Browser is a desktop plugin that adds a Chromium `<webview>` pane beside the chat in the Hermes desktop app. It's not a separate browser — it lives inside the app window, side by side with your AI agent session, so you can browse, debug, and automate while the agent helps you code.

### Features

- **🌐 Full navigation** — URL bar, back/forward/reload/home, multi-tab support
- **🔐 OAuth & Google login** — User-agent spoofing bypasses Google's Electron webview block; `allowpopups` enables OAuth flows
- **🍪 Persistent sessions** — Cookies, localStorage, and IndexedDB survive app restarts via `persist:hermes-dev-browser` partition
- **🐛 DevTools** — Toggle Chromium DevTools with one click
- **📟 Console panel** — Captures `console.log/warn/error` from the webview, collapsible with drag-resize
- **📡 Network inspector** — Basic request tracking with status code colors
- **📱 Device mode** — Switch between desktop, mobile (375px), and tablet (768px) viewports
- **🔄 Auto-refresh** — File watching with debounced reload on changes
- **🎯 Element picker** — Click any element in the browser to capture its CSS selector, HTML, attributes, and text — automatically inserted into the chat composer as a reference for the agent
- **🖱️ Mouse & keyboard simulation** — Move cursor, click, type, press keys, scroll, and drag — using native Electron `sendInputEvent` with JS fallback. Enables agent-driven automated testing.
- **🤖 Agent-controlled** — 21 tools the AI agent can call to navigate, eval JS, take screenshots, manage tabs, read console, clear cookies, simulate input, and more
- **⌨️ Keyboard shortcuts** — `Cmd+R` reload, `Cmd+Option+I` DevTools, `Cmd+L` focus URL bar
- **🎨 Theme-aware** — Uses the app's CSS variables, adapts to any theme automatically
- **↔️ Resizable** — Drag the pane sash to any width, no maximum

## Installation

### 1. Install the plugin files

```bash
# Desktop plugin (the browser pane UI)
mkdir -p ~/.hermes/desktop-plugins/dev-browser
curl -o ~/.hermes/desktop-plugins/dev-browser/plugin.js \
  https://raw.githubusercontent.com/alvarolizama/hermes-dev-browser/main/plugin/plugin.js

# Backend (REST mailbox for agent tool results)
mkdir -p ~/.hermes/plugins/dev-browser/dashboard
curl -o ~/.hermes/plugins/dev-browser/dashboard/manifest.json \
  https://raw.githubusercontent.com/alvarolizama/hermes-dev-browser/main/backend/manifest.json
curl -o ~/.hermes/plugins/dev-browser/dashboard/plugin_api.py \
  https://raw.githubusercontent.com/alvarolizama/hermes-dev-browser/main/backend/plugin_api.py

# Agent tools (Python tools the AI uses to control the browser)
curl -o ~/.hermes/hermes-agent/tools/dev_browser_tool.py \
  https://raw.githubusercontent.com/alvarolizama/hermes-dev-browser/main/tools/dev_browser_tool.py
```

### 2. Register the tools in toolsets.py

Add the dev_browser tool names to `_HERMES_CORE_TOOLS` in `~/.hermes/hermes-agent/toolsets.py`:

```python
# Dev Browser — agent-controlled webview pane (desktop-gated via check_fn)
"dev_browser_navigate", "dev_browser_eval", "dev_browser_screenshot",
"dev_browser_list_tabs", "dev_browser_new_tab", "dev_browser_close_tab",
"dev_browser_switch_tab", "dev_browser_get_url", "dev_browser_get_console",
"dev_browser_clear_console", "dev_browser_get_network",
"dev_browser_set_device_mode", "dev_browser_clear_cache", "dev_browser_clear_cookies",
"dev_browser_pick_element",
"dev_browser_mouse_move", "dev_browser_click", "dev_browser_type",
"dev_browser_press_key", "dev_browser_scroll", "dev_browser_drag",
```

### 3. Enable the Python backend

Add `dev-browser` to `plugins.enabled` in `~/.hermes/config.yaml`:

```yaml
plugins:
  enabled:
    - dev-browser
```

### 4. Reload

- **⌘K** → **"Reload desktop plugins"** in the Hermes desktop app
- Start a new session (`/reset`) so the new tools load

## Usage

### Manual browsing

1. **⌘K** → **"Open Dev Browser"** to open the pane
2. Type a URL in the address bar and press Enter
3. Use back/forward/reload buttons for navigation
4. Click the **Eye** 👁️ icon to start the element picker
5. Click any element in the browser → its reference appears in your chat composer

### Agent-controlled browsing

The agent can control the browser using 21 tools. Ask it to:

- "Open localhost:4000 in the dev browser"
- "Take a screenshot of the current page"
- "Run `document.title` in the browser"
- "List all open tabs"
- "Clear cookies and reload"
- "Switch to mobile mode"
- "Pick an element from the page"
- "Click the submit button at (200, 300)"
- "Type 'hello world' into the focused input"
- "Press Enter"
- "Scroll down 500px"
- "Drag from (100,100) to (300,300)"

### Element picker

Click the 👁️ icon in the toolbar (or ⌘K → "Dev Browser: Pick Element"), then click any element in the browser. The element's selector, HTML, attributes, and text are formatted and inserted into your chat composer:

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
```

## Agent Tools

### Navigation & Inspection

| Tool | Emoji | Description |
|------|-------|-------------|
| `dev_browser_navigate` | 🌐 | Navigate to a URL |
| `dev_browser_eval` | ⚡ | Execute JavaScript, return result |
| `dev_browser_screenshot` | 📸 | Capture screenshot as data URL |
| `dev_browser_get_url` | 🔗 | Get current URL and title |
| `dev_browser_pick_element` | 🎯 | Start element picker, capture element ref |

### Tab Management

| Tool | Emoji | Description |
|------|-------|-------------|
| `dev_browser_list_tabs` | 📋 | List all open tabs |
| `dev_browser_new_tab` | 🗂️ | Open a new tab with a URL |
| `dev_browser_close_tab` | ❌ | Close a tab by index |
| `dev_browser_switch_tab` | 🔄 | Switch active tab by index |

### Console & Network

| Tool | Emoji | Description |
|------|-------|-------------|
| `dev_browser_get_console` | 📟 | Get console entries (with level filter) |
| `dev_browser_clear_console` | 🧹 | Clear console entries |
| `dev_browser_get_network` | 📡 | Get network request entries |

### Device & Storage

| Tool | Emoji | Description |
|------|-------|-------------|
| `dev_browser_set_device_mode` | 📱 | Set device mode (desktop/mobile/tablet) |
| `dev_browser_clear_cache` | 🗑️ | Clear cache and reload |
| `dev_browser_clear_cookies` | 🍪 | Clear cookies and storage |

### Mouse & Keyboard Simulation

| Tool | Emoji | Description |
|------|-------|-------------|
| `dev_browser_mouse_move` | 🖱️ | Move cursor to (x, y) |
| `dev_browser_click` | 👆 | Click at (x, y) — left/right/double |
| `dev_browser_type` | ⌨️ | Type text into focused element |
| `dev_browser_press_key` | 🔑 | Press keyboard key (Enter, Tab, etc) |
| `dev_browser_scroll` | 📜 | Scroll at (x, y) up/down |
| `dev_browser_drag` | ✋ | Drag from (x1,y1) to (x2,y2) |

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Hermes Desktop (Electron 40 / Chromium 144)                  │
│                                                                │
│  ┌───────────────┐  ┌────────────────────────────────────────┐ │
│  │   Chat        │  │  Dev Browser Pane (plugin.js)           │ │
│  │               │  │ ┌──────────────────────────────────────┐ │ │
│  │  Agent calls  │  │ │ ◀ ▶ ⟳ 👁 │ localhost:4000  │ ⋯     │ │ │
│  │  dev_browser_*│◄─┤ ├──────────────────────────────────────┤ │ │
│  │  tools        │  │ │  <webview> (Electron)                │ │ │
│  │               │  │ │  - UA: Chrome 131 (spoofed)          │ │ │
│  │               │  │ │  - allowpopups (OAuth)               │ │ │
│  │               │  │ │  - persist:hermes-dev-browser         │ │ │
│  │               │  │ │  - DevTools toggle 🐛                │ │ │
│  │               │  │ │  - sendInputEvent (mouse/keyboard)   │ │ │
│  │               │  │ ├──────────────────────────────────────┤ │ │
│  │               │  │ │ Console / Network (collapsible)      │ │ │
│  │               │  │ └──────────────────────────────────────┘ │ │
│  └───────────────┘  └────────────────────────────────────────┘ │
│                                                                │
│  Backend: plugin_api.py (REST mailbox at /api/plugins/)        │
│  Tools: dev_browser_tool.py (21 agent tools)                   │
└──────────────────────────────────────────────────────────────┘
```

### Mouse/keyboard simulation — dual-path architecture

Each input tool tries two methods:

1. **Native** (`webview.sendInputEvent()`) — Real Chromium input events. Moves the actual cursor, triggers `:hover`, `:focus`, `:active` CSS states. Works with canvas, video, drag-drop. Requires the window to be focused.

2. **JS fallback** (`webview.executeJavaScript()`) — Synthetic DOM events dispatched via `dispatchEvent()`. Doesn't move the cursor visually but triggers all JS event listeners. Used when `sendInputEvent` fails (pre-dom-ready, iframes, etc).

The result includes `method: 'native'` or `method: 'js'` so the agent knows which path was used.

## How it works

- **Plugin JS** (`plugin/plugin.js`) — A disk plugin loaded by the Hermes desktop app. Registers a pane with a `<webview>` element, toolbar, tabs, console, network, element picker, and input simulation. Listens for events from the agent via `host.onEvent`.

- **Backend** (`backend/plugin_api.py`) — A FastAPI router mounted at `/api/plugins/dev-browser/`. Acts as a thread-safe in-memory result mailbox: the plugin JS POSTs results here after executing agent commands (eval, screenshot, click), and the Python tools poll for them.

- **Agent tools** (`tools/dev_browser_tool.py`) — 21 Python tools registered in the `terminal` toolset, gated on `HERMES_DESKTOP`. They emit events to the plugin via `desktop_ui.emit()`, then poll the REST mailbox (or use in-process import) for results.

## Requirements

- [Hermes Agent](https://hermes-agent.nousresearch.com) desktop app (Electron 40+)
- The desktop app must be running (tools are gated on `HERMES_DESKTOP`)

## License

MIT
