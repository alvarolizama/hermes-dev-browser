// Dev Browser — a full-featured web browser pane for the Hermes desktop app.
// Disk plugin (plain ESM, loaded uncompiled). No JSX syntax — uses jsx()/jsxs()
// from react/jsx-runtime. Only imports: @hermes/plugin-sdk, react, react/jsx-runtime.
//
// Features: multi-tab navigation, console panel, network inspector, device mode,
// autorefresh with file watching, agent control via events, palette commands,
// keybinds, and persistent storage.

import {
  host,
  haptic,
  cn,
  atom,
  useValue,
  usePluginI18n,
  Button,
  Input,
  Tip,
  Separator,
  GlyphSpinner,
  icons,
  PANES_AREA,
  PALETTE_AREA,
  KEYBINDS_AREA
} from '@hermes/plugin-sdk'

import { useCallback, useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN_ID = 'dev-browser'

// Real Chrome 131 UA (NOT Electron). Google blocks login from Electron
// webviews by detecting Electron in the UA string.
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

const TABLET_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

const DEFAULT_HOME_URL = 'https://www.google.com'

const FILE_RELOAD_DEBOUNCE_MS = 200
const MAX_HISTORY = 20
const MAX_CONSOLE_ENTRIES = 500
const MAX_NETWORK_ENTRIES = 300
const CONSOLE_MIN_HEIGHT = 32
const CONSOLE_MAX_HEIGHT_RATIO = 0.85
const NETWORK_MIN_HEIGHT = 32

// OAuth popup patterns — these URLs are expected to open as popups
const OAUTH_PATTERNS = [
  /accounts\.google\.com/i,
  /login\.microsoftonline\.com/i,
  /github\.com\/login/i,
  /gitlab\.com\/.*oauth/i,
  /auth\.notion\.so/i,
  /api\.figma\.com\/v1\/oauth/i,
  /login\.linear\.me/i,
  /auth\.openai\.com/i,
  /login\.anthropic\.com/i,
  /auth\.supabase\.io/i,
  /secure\.auth0\.com/i,
]

// Device mode presets — icon names must match the app's icon set
const DEVICE_PRESETS = {
  desktop: { label: 'Desktop', width: null, ua: CHROME_UA, icon: 'Monitor' },
  mobile: { label: 'Mobile (375px)', width: '375px', ua: MOBILE_UA, icon: 'Square' },
  tablet: { label: 'Tablet (768px)', width: '768px', ua: TABLET_UA, icon: 'Maximize' },
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/** Normalize a URL string entered in the address bar.
 *  - Bare domains like "miapp.com" -> https://miapp.com
 *  - localhost:PORT -> http://localhost:PORT
 *  - Already has a scheme -> pass through
 *  - Looks like a search term -> Google search
 */
function normalizeUrl(input) {
  const trimmed = (input || '').trim()
  if (!trimmed) return DEFAULT_HOME_URL

  // Already has a protocol
  if (/^https?:\/\//i.test(trimmed) || /^file:\/\//i.test(trimmed)) {
    return trimmed
  }

  // localhost or 127.0.0.1 — use http
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(trimmed)) {
    return `http://${trimmed}`
  }

  // Looks like a domain (has a dot, no spaces)
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(trimmed)) {
    return `https://${trimmed}`
  }

  // Otherwise treat as a search query
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}

/** Compact a URL for display: strip protocol, show host+path. */
function compactUrl(url) {
  try {
    const u = new URL(url)
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname)
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}${u.search}`
  } catch {
    return url
  }
}

/** Check if a URL looks like an OAuth popup that should be allowed. */
function isOAuthPopupUrl(url) {
  if (!url) return false
  return OAUTH_PATTERNS.some((pattern) => pattern.test(url))
}

// ---------------------------------------------------------------------------
// Plugin-local state atoms (shared across the pane component tree)
// ---------------------------------------------------------------------------

// Tab state: array of tab objects
const $tabs = atom([])
// Active tab index
const $activeTabIndex = atom(0)
// Console panel open/closed
const $consoleOpen = atom(false)
// Console panel height in px
const $consoleHeight = atom(200)
// Network panel open/closed
const $networkOpen = atom(false)
// Network panel height in px
const $networkHeight = atom(160)
// DevTools open state per tab (by tab id)
const $devtoolsOpen = atom({})
// Device mode: 'desktop' | 'mobile' | 'tablet'
const $deviceMode = atom('desktop')
// Autorefresh on/off
const $autorefreshOn = atom(false)
// URL history (last 20 visited URLs)
const $urlHistory = atom([])
// Home URL (persisted)
const $homeUrl = atom(DEFAULT_HOME_URL)
// URL bar focus signal — incremented to trigger focus
const $urlBarFocusSignal = atom(0)
// Active tab's current URL (for the URL bar display)
const $urlBarValue = atom('')
// Version atoms to trigger re-renders when console/network entries change
const $consoleVersion = atom(0)
const $networkVersion = atom(0)
// Can-go-back / can-go-forward signals (updated on navigation events)
const $navState = atom({ back: false, forward: false })
// Element picker active state
const $pickerActive = atom(false)

// Ref map: tab id -> webview element. Kept in module-level Maps so handlers
// can access webviews imperatively without React closures.
const webviewRefs = new Map()
const hostRefs = new Map()
const consoleEntriesMap = new Map()
const networkEntriesMap = new Map()
const loadingMap = new Map()
const errorMap = new Map()
const currentUrlMap = new Map()

// Mutable counter for unique IDs
let _idCounter = 1
function nextId() {
  return _idCounter++
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

let _storage = null

function initStorage(ctx) {
  _storage = ctx.storage
  const history = _storage.get('urlHistory', [])
  if (Array.isArray(history) && history.length) $urlHistory.set(history)

  const home = _storage.get('homeUrl', DEFAULT_HOME_URL)
  $homeUrl.set(home)

  const consoleOpenStored = _storage.get('consoleOpen', false)
  $consoleOpen.set(consoleOpenStored)

  const consoleHeightStored = _storage.get('consoleHeight', 200)
  $consoleHeight.set(consoleHeightStored)

  const networkOpenStored = _storage.get('networkOpen', false)
  $networkOpen.set(networkOpenStored)

  const networkHeightStored = _storage.get('networkHeight', 160)
  $networkHeight.set(networkHeightStored)

  const deviceModeStored = _storage.get('deviceMode', 'desktop')
  $deviceMode.set(deviceModeStored)
}

function persistHistory() {
  if (!_storage) return
  _storage.set('urlHistory', $urlHistory.get())
}

function persist(key, value) {
  if (!_storage) return
  _storage.set(key, value)
}

// ---------------------------------------------------------------------------
// Tab management
// ---------------------------------------------------------------------------

function createTab(url) {
  const id = nextId()
  const tab = {
    id,
    url: url || $homeUrl.get(),
    title: compactUrl(url || $homeUrl.get()),
    loading: false,
    error: null,
  }
  consoleEntriesMap.set(id, [])
  networkEntriesMap.set(id, [])
  loadingMap.set(id, false)
  errorMap.set(id, null)
  currentUrlMap.set(id, tab.url)
  return tab
}

function addTab(url) {
  const tab = createTab(url)
  const tabs = [...$tabs.get(), tab]
  $tabs.set(tabs)
  $activeTabIndex.set(tabs.length - 1)
  persist('activeTabIndex', tabs.length - 1)
  // Update URL bar to the new tab's URL
  $urlBarValue.set(tab.url)
  // Reset nav state for the new tab
  $navState.set({ back: false, forward: false })
}

function closeTab(index) {
  const tabs = $tabs.get()
  if (tabs.length <= 1) return

  const tab = tabs[index]
  if (!tab) return

  // Clean up webview
  const wv = webviewRefs.get(tab.id)
  if (wv) {
    try {
      wv._cleanup?.()
      wv.remove()
    } catch {}
    webviewRefs.delete(tab.id)
  }
  hostRefs.delete(tab.id)
  consoleEntriesMap.delete(tab.id)
  networkEntriesMap.delete(tab.id)
  loadingMap.delete(tab.id)
  errorMap.delete(tab.id)
  currentUrlMap.delete(tab.id)

  const newTabs = tabs.filter((_, i) => i !== index)
  $tabs.set(newTabs)

  // Adjust active index
  let newIndex = $activeTabIndex.get()
  if (index === newIndex) {
    newIndex = Math.max(0, index - 1)
  } else if (index < newIndex) {
    newIndex = newIndex - 1
  }
  $activeTabIndex.set(newIndex)
  persist('activeTabIndex', newIndex)

  // Update URL bar to the new active tab
  const newActive = newTabs[newIndex]
  if (newActive) {
    $urlBarValue.set(currentUrlMap.get(newActive.id) || newActive.url)
    updateNavState(newActive.id)
  }
}

function setActiveTab(index) {
  $activeTabIndex.set(index)
  persist('activeTabIndex', index)
  const tabs = $tabs.get()
  const tab = tabs[index]
  if (tab) {
    $urlBarValue.set(currentUrlMap.get(tab.id) || tab.url)
    updateNavState(tab.id)
  }
}

function updateTab(id, updates) {
  const tabs = $tabs.get()
  const idx = tabs.findIndex((t) => t.id === id)
  if (idx === -1) return
  const newTabs = [...tabs]
  newTabs[idx] = { ...newTabs[idx], ...updates }
  $tabs.set(newTabs)
}

function updateNavState(tabId) {
  const wv = webviewRefs.get(tabId)
  try {
    $navState.set({
      back: wv?.canGoBack?.() ?? false,
      forward: wv?.canGoForward?.() ?? false,
    })
  } catch {
    // Webview not dom-ready yet — leave nav state as-is
  }
}

// ---------------------------------------------------------------------------
// Console & network entry helpers
// ---------------------------------------------------------------------------

function appendConsoleEntry(tabId, entry) {
  const entries = consoleEntriesMap.get(tabId)
  if (!entries) return
  entries.push({ id: nextId(), timestamp: Date.now(), ...entry })
  if (entries.length > MAX_CONSOLE_ENTRIES) {
    entries.splice(0, entries.length - MAX_CONSOLE_ENTRIES)
  }
  $consoleVersion.set($consoleVersion.get() + 1)
}

function clearConsole(tabId) {
  const entries = consoleEntriesMap.get(tabId)
  if (entries) entries.length = 0
  $consoleVersion.set($consoleVersion.get() + 1)
}

function appendNetworkEntry(tabId, entry) {
  const entries = networkEntriesMap.get(tabId)
  if (!entries) return
  entries.push({ id: nextId(), timestamp: Date.now(), ...entry })
  if (entries.length > MAX_NETWORK_ENTRIES) {
    entries.splice(0, entries.length - MAX_NETWORK_ENTRIES)
  }
  $networkVersion.set($networkVersion.get() + 1)
}

function clearNetwork(tabId) {
  const entries = networkEntriesMap.get(tabId)
  if (entries) entries.length = 0
  $networkVersion.set($networkVersion.get() + 1)
}

// ---------------------------------------------------------------------------
// URL history
// ---------------------------------------------------------------------------

function addToHistory(url) {
  if (!url || url === 'about:blank') return
  let history = $urlHistory.get()
  history = history.filter((u) => u !== url)
  history.unshift(url)
  if (history.length > MAX_HISTORY) {
    history = history.slice(0, MAX_HISTORY)
  }
  $urlHistory.set(history)
  persistHistory()
}

function clearHistory() {
  $urlHistory.set([])
  persistHistory()
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

function navigateActiveTab(url) {
  const tabs = $tabs.get()
  const idx = $activeTabIndex.get()
  const tab = tabs[idx]
  if (!tab) return

  const normalized = normalizeUrl(url)
  const wv = webviewRefs.get(tab.id)
  if (!wv) return

  // Update user agent via attribute (safe before dom-ready)
  const deviceMode = $deviceMode.get()
  const ua = DEVICE_PRESETS[deviceMode]?.ua || CHROME_UA
  wv.setAttribute('useragent', ua)

  wv.setAttribute('src', normalized)
  currentUrlMap.set(tab.id, normalized)
  updateTab(tab.id, { url: normalized, error: null, loading: true })
  $urlBarValue.set(normalized)
  addToHistory(normalized)
}

function reloadActiveTab() {
  const tabs = $tabs.get()
  const idx = $activeTabIndex.get()
  const tab = tabs[idx]
  if (!tab) return
  const wv = webviewRefs.get(tab.id)
  if (!wv) return
  try {
    if (wv.reloadIgnoringCache) {
      wv.reloadIgnoringCache()
    } else {
      wv.reload?.()
    }
  } catch {}
}

function goBack(tabId) {
  const wv = webviewRefs.get(tabId)
  try {
    if (!wv?.canGoBack?.()) return
    wv.goBack?.()
  } catch {}
}

function goForward(tabId) {
  const wv = webviewRefs.get(tabId)
  try {
    if (!wv?.canGoForward?.()) return
    wv.goForward?.()
  } catch {}
}

function toggleDevTools(tabId) {
  const wv = webviewRefs.get(tabId)
  if (!wv?.openDevTools) return
  try {
    if (wv.isDevToolsOpened?.()) {
      wv.closeDevTools?.()
      const map = { ...$devtoolsOpen.get() }
      delete map[tabId]
      $devtoolsOpen.set(map)
    } else {
      wv.openDevTools()
      $devtoolsOpen.set({ ...$devtoolsOpen.get(), [tabId]: true })
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Element picker — injects an inspect mode into the webview
// ---------------------------------------------------------------------------

const PICKER_SCRIPT = `
(function() {
  if (window.__hermesPickerActive) return;
  window.__hermesPickerActive = true;

  var overlay = document.createElement('div');
  overlay.id = '__hermes-picker-overlay';
  overlay.style.cssText = 'position:fixed;z-index:999999;pointer-events:none;border:2px solid #6366f1;background:rgba(99,102,241,0.12);transition:all 80ms ease;';
  overlay.style.display = 'none';
  document.body.appendChild(overlay);

  var tooltip = document.createElement('div');
  tooltip.id = '__hermes-picker-tooltip';
  tooltip.style.cssText = 'position:fixed;z-index:1000000;pointer-events:none;background:#1e1b2e;color:#a5b4fc;font:11px/1.4 monospace;padding:3px 6px;border-radius:3px;max-width:400px;word-break:break-all;';
  tooltip.style.display = 'none';
  document.body.appendChild(tooltip);

  function getSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      var part = el.tagName.toLowerCase();
      if (el.id) { part += '#' + el.id; parts.unshift(part); break; }
      if (el.className && typeof el.className === 'string') {
        var cls = el.className.trim().split(/\\s+/).slice(0, 2).join('.');
        if (cls) part += '.' + cls;
      }
      var parent = el.parentElement;
      if (parent) {
        var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === el.tagName; });
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')';
      }
      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  function getAttributes(el) {
    var attrs = {};
    for (var i = 0; i < el.attributes.length && i < 20; i++) {
      attrs[el.attributes[i].name] = el.attributes[i].value;
    }
    return attrs;
  }

  var lastEl = null;

  function onMove(e) {
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay || el === tooltip) return;
    lastEl = el;
    var rect = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = rect.left + 'px';
    overlay.style.top = rect.top + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
    tooltip.style.display = 'block';
    tooltip.style.left = (rect.left) + 'px';
    tooltip.style.top = Math.max(0, rect.top - 22) + 'px';
    var sel = getSelector(el);
    tooltip.textContent = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' (' + Math.round(rect.width) + 'x' + Math.round(rect.height) + ')';
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    var el = lastEl || document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    var data = {
      tagName: el.tagName.toLowerCase(),
      id: el.id || '',
      className: (typeof el.className === 'string') ? el.className : '',
      selector: getSelector(el),
      text: (el.textContent || '').trim().slice(0, 500),
      html: el.outerHTML.slice(0, 1000),
      attributes: getAttributes(el),
      rect: el.getBoundingClientRect().toJSON(),
      url: window.location.href,
      title: document.title,
    };
    window.__hermesPickerResult = data;
    cleanup();
    // Signal back to the webview host
    window.dispatchEvent(new CustomEvent('hermes-element-picked', { detail: data }));
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      cleanup();
    }
  }

  function cleanup() {
    window.__hermesPickerActive = false;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    if (overlay) overlay.remove();
    if (tooltip) tooltip.remove();
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
})();
`

function startElementPicker() {
  const tabs = $tabs.get()
  const idx = $activeTabIndex.get()
  const tab = tabs[idx]
  if (!tab) return

  const wv = webviewRefs.get(tab.id)
  if (!wv?.executeJavaScript) {
    host.notify({ kind: 'warning', message: 'Browser not ready for element picking' })
    return
  }

  $pickerActive.set(true)

  try {
    wv.executeJavaScript(PICKER_SCRIPT)
      .then(() => {
        host.notify({ kind: 'info', message: '🎯 Element picker active — click an element in the browser. Esc to cancel.' })

        // Poll for the result — the picker sets window.__hermesPickerResult on click
        let attempts = 0
        const maxAttempts = 100 // 50 seconds at 500ms
        const poll = setInterval(() => {
          attempts++
          if (attempts > maxAttempts) {
            clearInterval(poll)
            $pickerActive.set(false)
            host.notify({ kind: 'info', message: 'Element picker cancelled (timeout).' })
            return
          }

          // Check if picker was dismissed (Esc) without picking
          try {
            wv.executeJavaScript('window.__hermesPickerActive === true')
              .then((stillActive) => {
                if (!stillActive && !window.__hermesPickerResult) {
                  // Picker was dismissed without picking
                  clearInterval(poll)
                  $pickerActive.set(false)
                  return
                }
              })
              .catch(() => {})
          } catch {}

          // Check for a picked result
          try {
            wv.executeJavaScript('window.__hermesPickerResult || null')
              .then((result) => {
                if (result) {
                  clearInterval(poll)
                  $pickerActive.set(false)

                  // Clear the result from the webview
                  try { wv.executeJavaScript('delete window.__hermesPickerResult') } catch {}

                  // Format and insert into the chat composer
                  const ref = formatElementRef(result)
                  insertIntoComposer(ref)

                  host.notify({ kind: 'success', message: `Element picked: ${result.tagName}${result.id ? '#' + result.id : ''} — inserted into chat.` })
                }
              })
              .catch(() => {})
          } catch {}
        }, 500)
      })
      .catch(() => {
        $pickerActive.set(false)
        host.notify({ kind: 'warning', message: 'Failed to start element picker' })
      })
  } catch {
    $pickerActive.set(false)
  }
}

function stopElementPicker() {
  const tabs = $tabs.get()
  const idx = $activeTabIndex.get()
  const tab = tabs[idx]
  if (!tab) return

  const wv = webviewRefs.get(tab.id)
  if (wv?.executeJavaScript) {
    try {
      wv.executeJavaScript('if (window.__hermesPickerActive) { document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"})); }')
        .catch(() => {})
    } catch {}
  }
  $pickerActive.set(false)
}

/** Insert text into the Hermes chat composer via CustomEvent. */
function insertIntoComposer(text) {
  // The composer listens for 'hermes:composer-insert' CustomEvents
  // with { text, mode, target } — same API as requestComposerInsert()
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent('hermes:composer-insert', {
      detail: { text: text.trim(), mode: 'block', target: 'main' }
    }))
  }, 0)
}

/** Format an element picker result into a reference string for the composer. */
function formatElementRef(el) {
  const parts = [
    `🔍 Element picked from ${el.url}`,
    '',
    `Tag: ${el.tagName}${el.id ? `#${el.id}` : ''}${el.className ? `.${el.className.split(/\s+/).slice(0, 3).join('.')}` : ''}`,
    `Selector: ${el.selector}`,
    `Size: ${Math.round(el.rect.width)}x${Math.round(el.rect.height)}`,
    `Position: ${Math.round(el.rect.left)},${Math.round(el.rect.top)}`,
  ]
  if (el.text) {
    parts.push(`Text: "${el.text.slice(0, 200)}${el.text.length > 200 ? '...' : ''}"`)
  }
  if (el.html) {
    parts.push('', '```html', el.html.slice(0, 800), '```')
  }
  return parts.join('\n')
}

let _watchId = null
let _unsubFileChanged = null
let _reloadTimer = null

function startAutorefresh() {
  if ($autorefreshOn.get()) return

  const cwd = host.state.cwd?.get?.() || '.'
  const hermesDesktop = window.hermesDesktop

  if (!hermesDesktop?.watchPreviewFile || !hermesDesktop?.onPreviewFileChanged) {
    host.notify({
      kind: 'warning',
      message: 'File watching is not available in this environment.',
    })
    return
  }

  _unsubFileChanged = hermesDesktop.onPreviewFileChanged((payload) => {
    if (_watchId && payload.id !== _watchId) return

    if (_reloadTimer) clearTimeout(_reloadTimer)
    _reloadTimer = setTimeout(() => {
      _reloadTimer = null
      reloadActiveTab()
    }, FILE_RELOAD_DEBOUNCE_MS)
  })

  hermesDesktop
    .watchPreviewFile(cwd)
    .then((watch) => {
      _watchId = watch.id
      $autorefreshOn.set(true)
    })
    .catch((error) => {
      host.notifyError(error, 'Failed to start file watching')
      _unsubFileChanged?.()
      _unsubFileChanged = null
    })
}

function stopAutorefresh() {
  if (_reloadTimer) {
    clearTimeout(_reloadTimer)
    _reloadTimer = null
  }
  if (_watchId) {
    try {
      window.hermesDesktop?.stopPreviewFileWatch?.(_watchId)
    } catch {}
    _watchId = null
  }
  _unsubFileChanged?.()
  _unsubFileChanged = null
  $autorefreshOn.set(false)
}

// ---------------------------------------------------------------------------
// Webview creation and event wiring
// ---------------------------------------------------------------------------

function createWebviewForTab(tabId, url, hostDiv) {
  const webview = document.createElement('webview')

  // Critical attributes
  webview.setAttribute('allowpopups', '')
  webview.setAttribute('partition', 'persist:hermes-dev-browser')
  webview.setAttribute(
    'webpreferences',
    'contextIsolation=yes,nodeIntegration=no,sandbox=yes'
  )
  // Set user agent via attribute — works BEFORE dom-ready (method call doesn't)
  webview.setAttribute('useragent', CHROME_UA)
  webview.className = 'flex h-full w-full flex-1 bg-transparent'

  // --- Event listeners ---

  const onConsole = (event) => {
    const detail = event
    const level = detail.level ?? 0
    const message = detail.message || ''
    if (!message) return
    appendConsoleEntry(tabId, {
      level: level >= 2 ? 2 : level,
      message,
      source: detail.sourceId,
      line: detail.line,
    })
  }

  const onNavigate = (event) => {
    const detail = event
    if (detail.url) {
      currentUrlMap.set(tabId, detail.url)
      updateTab(tabId, {
        url: detail.url,
        error: null,
        title: compactUrl(detail.url),
      })
      const tabs = $tabs.get()
      const idx = $activeTabIndex.get()
      if (tabs[idx]?.id === tabId) {
        $urlBarValue.set(detail.url)
      }
      addToHistory(detail.url)
      updateNavState(tabId)
    }
  }

  const onFail = (event) => {
    const detail = event
    const errorCode = detail.errorCode
    if (errorCode === -3) return // internal abort

    appendConsoleEntry(tabId, {
      level: 2,
      message: `Load failed (${errorCode}): ${detail.errorDescription || detail.validatedURL || 'Unknown error'}`,
    })

    errorMap.set(tabId, {
      code: errorCode,
      description: detail.errorDescription || 'Failed to load page',
      url: detail.validatedURL || currentUrlMap.get(tabId) || url,
    })
    updateTab(tabId, { error: errorMap.get(tabId), loading: false })
    loadingMap.set(tabId, false)
  }

  const onStart = () => {
    loadingMap.set(tabId, true)
    updateTab(tabId, { loading: true })
  }

  const onStop = () => {
    loadingMap.set(tabId, false)
    updateTab(tabId, { loading: false })
    updateNavState(tabId)
  }

  // Network-related events (basic — Electron webview exposes some)
  const onResponse = (event) => {
    const detail = event
    appendNetworkEntry(tabId, {
      method: detail.method || 'GET',
      url: detail.url || '',
      status: detail.statusCode,
      statusText: detail.statusLine || '',
      type: 'response',
    })
  }

  // New-window / popup handling
  const onNewWindow = (event) => {
    const targetUrl = event.url || ''
    if (isOAuthPopupUrl(targetUrl)) {
      // Allow OAuth popups to proceed normally
      return
    }
    event.preventDefault?.()
    if (targetUrl) {
      window.hermesDesktop?.openExternal?.(targetUrl)
    }
  }

  webview.addEventListener('console-message', onConsole)
  webview.addEventListener('did-fail-load', onFail)
  webview.addEventListener('did-navigate', onNavigate)
  webview.addEventListener('did-navigate-in-page', onNavigate)
  webview.addEventListener('did-start-loading', onStart)
  webview.addEventListener('did-stop-loading', onStop)
  webview.addEventListener('did-get-response-details', onResponse)
  webview.addEventListener('did-get-redirect-request', onResponse)
  webview.addEventListener('new-window', onNewWindow)

  // Attach to DOM
  hostDiv.appendChild(webview)

  // User agent is already set via the 'useragent' attribute (works pre-dom-ready).
  // Now navigate.
  webview.setAttribute('src', url)

  // Store cleanup function on the webview for later removal
  webview._cleanup = () => {
    webview.removeEventListener('console-message', onConsole)
    webview.removeEventListener('did-fail-load', onFail)
    webview.removeEventListener('did-navigate', onNavigate)
    webview.removeEventListener('did-navigate-in-page', onNavigate)
    webview.removeEventListener('did-start-loading', onStart)
    webview.removeEventListener('did-stop-loading', onStop)
    webview.removeEventListener('did-get-response-details', onResponse)
    webview.removeEventListener('did-get-redirect-request', onResponse)
    webview.removeEventListener('new-window', onNewWindow)
  }

  return webview
}

// ---------------------------------------------------------------------------
// Agent control via host.onEvent
// ---------------------------------------------------------------------------

let _eventDisposers = []

function setupAgentEvents(ctx) {
  // preview.open — agent called open_preview("url")
  const d1 = host.onEvent('preview.open', (event) => {
    const url = event?.payload?.url
    if (!url) return
    const tabs = $tabs.get()
    if (tabs.length === 0) {
      addTab(url)
    } else {
      navigateActiveTab(url)
    }
  })

  // dev-browser.navigate
  const d2 = host.onEvent('dev-browser.navigate', (event) => {
    const url = event?.payload?.url
    if (!url) return
    navigateActiveTab(url)
  })

  // dev-browser.eval
  const d3 = host.onEvent('dev-browser.eval', (event) => {
    const script = event?.payload?.script
    const requestId = event?.payload?.request_id
    if (!script) return

    const tabs = $tabs.get()
    const idx = $activeTabIndex.get()
    const tab = tabs[idx]
    if (!tab) return

    const wv = webviewRefs.get(tab.id)
    if (!wv?.executeJavaScript) {
      if (requestId) {
        ctx
          .rest('/result', {
            method: 'POST',
            body: {
              request_id: requestId,
              result: null,
              error: 'executeJavaScript not available',
            },
          })
          .catch(() => {})
      }
      return
    }

    wv.executeJavaScript(script)
      .then((result) => {
        if (requestId) {
          ctx
            .rest('/result', {
              method: 'POST',
              body: { request_id: requestId, result },
            })
            .catch(() => {})
        }
      })
      .catch((error) => {
        if (requestId) {
          ctx
            .rest('/result', {
              method: 'POST',
              body: {
                request_id: requestId,
                result: null,
                error: error instanceof Error ? error.message : String(error),
              },
            })
            .catch(() => {})
        }
      })
  })

  // dev-browser.screenshot
  const d4 = host.onEvent('dev-browser.screenshot', (event) => {
    const requestId = event?.payload?.request_id
    const tabs = $tabs.get()
    const idx = $activeTabIndex.get()
    const tab = tabs[idx]
    if (!tab) return

    const wv = webviewRefs.get(tab.id)
    if (!wv?.capturePage) {
      if (requestId) {
        ctx
          .rest('/result', {
            method: 'POST',
            body: {
              request_id: requestId,
              result: null,
              error: 'capturePage not available',
            },
          })
          .catch(() => {})
      }
      return
    }

    try {
      const image = wv.capturePage()
      const dataUrl = image?.toDataURL?.() || null
      if (requestId) {
        ctx
          .rest('/result', {
            method: 'POST',
            body: { request_id: requestId, result: dataUrl },
          })
          .catch(() => {})
      }
    } catch (error) {
      if (requestId) {
        ctx
          .rest('/result', {
            method: 'POST',
            body: {
              request_id: requestId,
              result: null,
              error: error instanceof Error ? error.message : String(error),
            },
          })
          .catch(() => {})
      }
    }
  })

  // dev-browser.list-tabs
  const d5 = host.onEvent('dev-browser.list-tabs', (event) => {
    const requestId = event?.payload?.request_id
    const tabs = $tabs.get()
    const idx = $activeTabIndex.get()
    const result = tabs.map((tab, i) => ({
      id: tab.id,
      url: tab.url,
      title: tab.title || '',
      active: i === idx,
      loading: tab.loading || false,
    }))
    if (requestId) {
      ctx.rest('/result', {
        method: 'POST',
        body: { request_id: requestId, result },
      }).catch(() => {})
    }
  })

  // dev-browser.new-tab
  const d6 = host.onEvent('dev-browser.new-tab', (event) => {
    const url = event?.payload?.url
    const requestId = event?.payload?.request_id
    if (!url) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'url required' } }).catch(() => {})
      return
    }
    addTab(url)
    if (requestId) {
      const tabs = $tabs.get()
      ctx.rest('/result', {
        method: 'POST',
        body: { request_id: requestId, result: { tab_count: tabs.length, active_index: $activeTabIndex.get() } },
      }).catch(() => {})
    }
  })

  // dev-browser.close-tab
  const d7 = host.onEvent('dev-browser.close-tab', (event) => {
    const requestId = event?.payload?.request_id
    const tabIndex = event?.payload?.index
    const tabId = event?.payload?.tab_id
    const tabs = $tabs.get()

    let idx = tabIndex
    if (typeof idx !== 'number' && tabId) {
      idx = tabs.findIndex((t) => t.id === tabId)
    }
    if (typeof idx !== 'number' || idx < 0 || idx >= tabs.length) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'invalid tab index' } }).catch(() => {})
      return
    }
    closeTab(idx)
    if (requestId) {
      ctx.rest('/result', {
        method: 'POST',
        body: { request_id: requestId, result: { closed: true, remaining: $tabs.get().length } },
      }).catch(() => {})
    }
  })

  // dev-browser.switch-tab
  const d8 = host.onEvent('dev-browser.switch-tab', (event) => {
    const requestId = event?.payload?.request_id
    const index = event?.payload?.index
    const tabs = $tabs.get()
    if (typeof index !== 'number' || index < 0 || index >= tabs.length) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'invalid tab index' } }).catch(() => {})
      return
    }
    setActiveTab(index)
    if (requestId) {
      ctx.rest('/result', {
        method: 'POST',
        body: { request_id: requestId, result: { active_index: index, url: tabs[index].url } },
      }).catch(() => {})
    }
  })

  // dev-browser.get-url
  const d9 = host.onEvent('dev-browser.get-url', (event) => {
    const requestId = event?.payload?.request_id
    const tabs = $tabs.get()
    const idx = $activeTabIndex.get()
    const tab = tabs[idx]
    if (!tab) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'no active tab' } }).catch(() => {})
      return
    }
    const wv = webviewRefs.get(tab.id)
    let url = tab.url
    try { url = wv?.getURL?.() || tab.url } catch {}
    if (requestId) {
      ctx.rest('/result', {
        method: 'POST',
        body: { request_id: requestId, result: { url, title: tab.title || '' } },
      }).catch(() => {})
    }
  })

  // dev-browser.get-console
  const d10 = host.onEvent('dev-browser.get-console', (event) => {
    const requestId = event?.payload?.request_id
    const tabs = $tabs.get()
    const idx = $activeTabIndex.get()
    const tab = tabs[idx]
    if (!tab) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'no active tab' } }).catch(() => {})
      return
    }
    const entries = consoleEntriesMap.get(tab.id) || []
    const level = event?.payload?.level // optional filter: 'error', 'warn', 'log'
    const filtered = level
      ? entries.filter((e) => {
          if (level === 'error') return e.level >= 2
          if (level === 'warn') return e.level === 1
          return e.level === 0
        })
      : entries
    // Return last 50 entries
    const recent = filtered.slice(-50)
    if (requestId) {
      ctx.rest('/result', {
        method: 'POST',
        body: { request_id: requestId, result: recent },
      }).catch(() => {})
    }
  })

  // dev-browser.clear-console
  const d11 = host.onEvent('dev-browser.clear-console', (event) => {
    const requestId = event?.payload?.request_id
    const tabs = $tabs.get()
    const idx = $activeTabIndex.get()
    const tab = tabs[idx]
    if (tab) clearConsole(tab.id)
    if (requestId) {
      ctx.rest('/result', {
        method: 'POST',
        body: { request_id: requestId, result: { cleared: true } },
      }).catch(() => {})
    }
  })

  // dev-browser.get-network
  const d12 = host.onEvent('dev-browser.get-network', (event) => {
    const requestId = event?.payload?.request_id
    const tabs = $tabs.get()
    const idx = $activeTabIndex.get()
    const tab = tabs[idx]
    if (!tab) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'no active tab' } }).catch(() => {})
      return
    }
    const entries = networkEntriesMap.get(tab.id) || []
    const recent = entries.slice(-50)
    if (requestId) {
      ctx.rest('/result', {
        method: 'POST',
        body: { request_id: requestId, result: recent },
      }).catch(() => {})
    }
  })

  // dev-browser.set-device-mode
  const d13 = host.onEvent('dev-browser.set-device-mode', (event) => {
    const requestId = event?.payload?.request_id
    const mode = event?.payload?.mode // 'desktop', 'mobile', 'tablet'
    if (!mode || !DEVICE_PRESETS[mode]) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'invalid mode, must be desktop|mobile|tablet' } }).catch(() => {})
      return
    }
    $deviceMode.set(mode)
    persist('deviceMode', mode)
    const tabs = $tabs.get()
    const idx = $activeTabIndex.get()
    const tab = tabs[idx]
    if (tab) {
      const w = webviewRefs.get(tab.id)
      if (w) {
        w.setAttribute('useragent', DEVICE_PRESETS[mode]?.ua || CHROME_UA)
      }
    }
    reloadActiveTab()
    if (requestId) {
      ctx.rest('/result', {
        method: 'POST',
        body: { request_id: requestId, result: { mode } },
      }).catch(() => {})
    }
  })

  // dev-browser.clear-cache
  const d14 = host.onEvent('dev-browser.clear-cache', (event) => {
    const requestId = event?.payload?.request_id
    const tabs = $tabs.get()
    const idx = $activeTabIndex.get()
    const tab = tabs[idx]
    if (!tab) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'no active tab' } }).catch(() => {})
      return
    }
    // Clear cache by reloading with cache bypass
    const wv = webviewRefs.get(tab.id)
    try {
      if (wv?.reloadIgnoringCache) wv.reloadIgnoringCache()
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { cleared: true } } }).catch(() => {})
    } catch (e) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: String(e) } }).catch(() => {})
    }
  })

  // dev-browser.clear-cookies
  const d15 = host.onEvent('dev-browser.clear-cookies', (event) => {
    const requestId = event?.payload?.request_id
    // Webview cookies are managed by the partition session.
    // We can clear them via the webview's session API.
    // Since we can't access session directly from renderer,
    // we reload the webview which clears session storage.
    // For a real cookie clear, we'd need a backend handler.
    // Best effort: clear local/session storage via eval
    const tabs = $tabs.get()
    const idx = $activeTabIndex.get()
    const tab = tabs[idx]
    if (tab) {
      const wv = webviewRefs.get(tab.id)
      if (wv?.executeJavaScript) {
        wv.executeJavaScript('localStorage.clear(); sessionStorage.clear();')
          .then(() => {
            if (wv?.reloadIgnoringCache) wv.reloadIgnoringCache()
            if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { cleared: true } } }).catch(() => {})
          })
          .catch(() => {
            if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'failed to clear storage' } }).catch(() => {})
          })
      } else {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'webview not ready' } }).catch(() => {})
      }
    } else {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'no active tab' } }).catch(() => {})
    }
  })

  // dev-browser.pick-element — start element picker, return result to agent
  const d16 = host.onEvent('dev-browser.pick-element', (event) => {
    const requestId = event?.payload?.request_id
    const insert = event?.payload?.insert_to_composer // if true, also insert into chat
    const tabs = $tabs.get()
    const idx = $activeTabIndex.get()
    const tab = tabs[idx]
    if (!tab) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'no active tab' } }).catch(() => {})
      return
    }
    const wv = webviewRefs.get(tab.id)
    if (!wv?.executeJavaScript) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'webview not ready' } }).catch(() => {})
      return
    }

    // Inject the picker script
    try {
      wv.executeJavaScript(PICKER_SCRIPT)
        .then(() => {
          host.notify({ kind: 'info', message: 'Element picker active — click an element. Esc to cancel.' })
          $pickerActive.set(true)

          // Poll for the result (the picker sets window.__hermesPickerResult on click)
          let attempts = 0
          const maxAttempts = 100 // 50 seconds at 500ms
          const poll = setInterval(() => {
            attempts++
            if (attempts > maxAttempts) {
              clearInterval(poll)
              $pickerActive.set(false)
              if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'picker timeout — no element selected' } }).catch(() => {})
              return
            }
            try {
              wv.executeJavaScript('window.__hermesPickerResult || null')
                .then((result) => {
                  if (result) {
                    clearInterval(poll)
                    $pickerActive.set(false)
                    // Clear the result
                    try { wv.executeJavaScript('delete window.__hermesPickerResult') } catch {}

                    if (requestId) {
                      ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result } }).catch(() => {})
                    }

                    // If insert_to_composer is true, also insert into chat
                    if (insert) {
                      const ref = formatElementRef(result)
                      insertIntoComposer(ref)
                    }
                  }
                })
                .catch(() => {})
            } catch {}
          }, 500)
        })
        .catch(() => {
          $pickerActive.set(false)
          if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'failed to start picker' } }).catch(() => {})
        })
    } catch (e) {
      $pickerActive.set(false)
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: String(e) } }).catch(() => {})
    }
  })

  _eventDisposers = [d1, d2, d3, d4, d5, d6, d7, d8, d9, d10, d11, d12, d13, d14, d15, d16]
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** IconButton — a small square button with an icon. Uses the app's icon set. */
function IconButton({ icon, label, onClick, disabled, active, children }) {
  const IconComp = icon ? icons[icon] : null
  return jsx(Tip, {
    label,
    children: jsx(Button, {
      variant: active ? 'secondary' : 'ghost',
      size: 'icon',
      className: cn(
        'h-7 w-7 shrink-0',
        active && 'bg-accent/40 text-accent-foreground'
      ),
      disabled,
      onClick: () => {
        haptic('tap')
        onClick?.()
      },
      title: label,
      'aria-label': label,
      children: IconComp
        ? jsx(IconComp, { className: 'size-3.5' })
        : children || null,
    }),
  })
}

/** Tab bar with + button and close buttons. */
function TabBar() {
  const tabs = useValue($tabs)
  const activeIndex = useValue($activeTabIndex)
  const t = usePluginI18n(PLUGIN_ID)

  return jsxs('div', {
    className:
      'flex items-center gap-0.5 border-b border-[var(--ui-stroke-secondary)] px-1 py-1 overflow-x-auto',
    style: { minHeight: '36px' },
    children: [
      ...tabs.map((tab, index) => {
        const isActive = index === activeIndex
        return jsxs(
          'div',
          {
            role: 'tab',
            tabIndex: 0,
            className: cn(
              'group/tab flex items-center gap-1 rounded-md px-2 py-1 text-xs cursor-pointer whitespace-nowrap transition-colors',
              isActive
                ? 'bg-accent/20 text-[var(--ui-text-primary)]'
                : 'text-[var(--ui-text-tertiary)] hover:bg-accent/10 hover:text-[var(--ui-text-secondary)]'
            ),
            onClick: () => {
              haptic('tap')
              setActiveTab(index)
            },
            children: [
              tab.loading
                ? jsx(GlyphSpinner, { className: 'size-3 shrink-0' })
                : null,
              jsx('span', {
                className: cn(
                  'max-w-[120px] truncate',
                  !tab.loading && 'pl-0'
                ),
                children: tab.title || compactUrl(tab.url),
              }),
              tabs.length > 1
                ? jsx('button', {
                    type: 'button',
                    className:
                      'ml-1 inline-flex h-4 w-4 items-center justify-center rounded-sm opacity-0 group-hover/tab:opacity-100 transition-opacity hover:bg-[var(--ui-stroke-secondary)]',
                    onClick: (e) => {
                      e.stopPropagation()
                      haptic('tap')
                      closeTab(index)
                    },
                    title: t('closeTab'),
                    'aria-label': t('closeTab'),
                    children: jsx(icons.X, { className: 'size-3' }),
                  })
                : null,
            ],
          },
          `tab-${tab.id}`
        )
      }),
      // New tab button
      jsx(IconButton, {
        icon: 'Plus',
        label: t('newTab'),
        onClick: () => addTab($homeUrl.get()),
      }),
      // Spacer
      jsx('div', { className: 'flex-1' }),
      // Close pane button
      jsx(IconButton, {
        icon: 'X',
        label: 'Close',
        onClick: () => {
          haptic('tap')
          host.navigate('/')
        },
      }),
    ],
  })
}

/** Navigation toolbar: back, forward, reload, home, URL bar, devtools, etc. */
function NavToolbar({ urlInputRef }) {
  const t = usePluginI18n(PLUGIN_ID)
  const activeIndex = useValue($activeTabIndex)
  const tabs = useValue($tabs)
  const devtoolsMap = useValue($devtoolsOpen)
  const consoleOpen = useValue($consoleOpen)
  const networkOpen = useValue($networkOpen)
  const autorefresh = useValue($autorefreshOn)
  const deviceMode = useValue($deviceMode)
  const pickerActive = useValue($pickerActive)
  const urlBarValue = useValue($urlBarValue)
  const history = useValue($urlHistory)
  const focusSignal = useValue($urlBarFocusSignal)
  const navState = useValue($navState)

  const [inputValue, setInputValue] = useState(urlBarValue)
  const activeTab = tabs[activeIndex]

  // Sync input when URL bar value changes (navigation events)
  useEffect(() => {
    setInputValue(urlBarValue)
  }, [urlBarValue])

  // Focus URL bar when the focus signal fires (Cmd+L keybind)
  useEffect(() => {
    if (focusSignal > 0 && urlInputRef.current) {
      urlInputRef.current.focus()
      urlInputRef.current.select?.()
    }
  }, [focusSignal, urlInputRef])

  const devtoolsOpen = activeTab ? devtoolsMap[activeTab.id] : false

  const handleSubmit = (e) => {
    e?.preventDefault?.()
    navigateActiveTab(inputValue)
    urlInputRef.current?.blur?.()
  }

  const handleDeviceModeChange = (mode) => {
    $deviceMode.set(mode)
    persist('deviceMode', mode)

    if (activeTab) {
      const w = webviewRefs.get(activeTab.id)
      if (w) {
        w.setAttribute('useragent', DEVICE_PRESETS[mode]?.ua || CHROME_UA)
      }
    }
    reloadActiveTab()
  }

  return jsxs('div', {
    className:
      'flex items-center gap-1 border-b border-[var(--ui-stroke-secondary)] px-1.5 py-1.5',
    children: [
      jsx(IconButton, {
        icon: 'ChevronLeft',
        label: t('back'),
        disabled: !navState.back,
        onClick: () => activeTab && goBack(activeTab.id),
      }),
      jsx(IconButton, {
        icon: 'ChevronRight',
        label: t('forward'),
        disabled: !navState.forward,
        onClick: () => activeTab && goForward(activeTab.id),
      }),
      jsx(IconButton, {
        icon: 'RefreshCw',
        label: t('reload'),
        onClick: () => reloadActiveTab(),
      }),
      jsx(IconButton, {
        icon: 'Globe',
        label: t('home'),
        onClick: () => navigateActiveTab($homeUrl.get()),
      }),
      // URL bar
      jsx('form', {
        onSubmit: handleSubmit,
        className: 'flex-1 min-w-0',
        children: jsxs('div', {
          className: 'relative flex items-center',
          children: [
            jsx(Input, {
              ref: urlInputRef,
              value: inputValue,
              onChange: (e) => setInputValue(e.target.value),
              placeholder: t('urlPlaceholder'),
              className:
                'h-7 w-full text-xs font-mono pr-7 bg-[var(--ui-bg-elevated)]',
              spellCheck: false,
              autoComplete: 'off',
            }),
            activeTab?.loading
              ? jsx('div', {
                  className:
                    'absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none',
                  children: jsx(GlyphSpinner, { className: 'size-3.5' }),
                })
              : jsx('div', {
                  className:
                    'absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none',
                  children: jsx(icons.Globe, {
                    className: 'size-3.5 text-[var(--ui-text-tertiary)]',
                  }),
                }),
          ],
        }),
      }),
      // Device mode dropdown
      jsx(DeviceModeDropdown, {
        mode: deviceMode,
        onChange: handleDeviceModeChange,
        t,
      }),
      jsx(Separator, {
        orientation: 'vertical',
        className: 'h-5 mx-0.5',
      }),
      // Autorefresh toggle
      jsx(IconButton, {
        icon: 'RefreshCw',
        label: t('autorefresh'),
        active: autorefresh,
        onClick: () => {
          if (autorefresh) {
            stopAutorefresh()
          } else {
            startAutorefresh()
          }
        },
      }),
      // Console toggle
      jsx(IconButton, {
        icon: 'PanelBottom',
        label: t('console'),
        active: consoleOpen,
        onClick: () => {
          const open = !$consoleOpen.get()
          $consoleOpen.set(open)
          persist('consoleOpen', open)
        },
      }),
      // Network toggle
      jsx(IconButton, {
        icon: 'Activity',
        label: t('network'),
        active: networkOpen,
        onClick: () => {
          const open = !$networkOpen.get()
          $networkOpen.set(open)
          persist('networkOpen', open)
        },
      }),
      // DevTools toggle
      jsx(IconButton, {
        icon: 'Bug',
        label: t('devtools'),
        active: devtoolsOpen,
        onClick: () => activeTab && toggleDevTools(activeTab.id),
      }),
      jsx(Separator, {
        orientation: 'vertical',
        className: 'h-5 mx-0.5',
      }),
      // Element picker — click to inspect, result goes to chat composer
      jsx(IconButton, {
        icon: 'Eye',
        label: 'Pick element',
        active: pickerActive,
        onClick: () => {
          if (pickerActive) {
            stopElementPicker()
          } else {
            startElementPicker()
          }
        },
      }),
    ],
  })
}

/** Device mode dropdown. */
function DeviceModeDropdown({ mode, onChange, t }) {
  const [open, setOpen] = useState(false)

  return jsxs('div', {
    className: 'relative',
    children: [
      jsx(IconButton, {
        icon: 'Monitor',
        label: t('deviceMode'),
        active: mode !== 'desktop',
        onClick: () => setOpen((v) => !v),
      }),
      open
        ? jsxs('div', {
            className:
              'absolute right-0 top-8 z-50 rounded-md border border-[var(--ui-stroke-secondary)] bg-[var(--ui-bg-elevated)] shadow-lg py-1 min-w-[160px]',
            children: [
              ...Object.entries(DEVICE_PRESETS).map(([key, preset]) => {
                const IconComp = icons[preset.icon]
                return jsxs(
                  'button',
                  {
                    type: 'button',
                    className: cn(
                      'flex w-full items-center gap-2 px-2 py-1.5 text-xs text-left hover:bg-accent/20 transition-colors',
                      mode === key
                        ? 'text-[var(--ui-accent)]'
                        : 'text-[var(--ui-text-secondary)]'
                    ),
                    onClick: () => {
                      onChange(key)
                      setOpen(false)
                    },
                    children: [
                      IconComp ? jsx(IconComp, { className: 'size-3.5' }) : null,
                      preset.label,
                    ],
                  },
                  `device-${key}`
                )
              }),
            ],
          })
        : null,
      open
        ? jsx('div', {
            className: 'fixed inset-0 z-40',
            onClick: () => setOpen(false),
          })
        : null,
    ],
  })
}

/** Console panel — collapsible, resizable, shows console entries. */
function ConsolePanel({ tabId, height, onResizeStart }) {
  const t = usePluginI18n(PLUGIN_ID)
  const consoleVersion = useValue($consoleVersion)
  const scrollRef = useRef(null)
  const stickRef = useRef(true)
  const entries = consoleEntriesMap.get(tabId) || []

  // Auto-scroll to bottom when entries change (stick-to-bottom)
  useEffect(() => {
    if (!stickRef.current) return
    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [consoleVersion, tabId])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= 24
  }

  const levelColors = {
    0: 'var(--ui-text-tertiary)',
    1: 'var(--ui-text-secondary)',
    2: 'var(--ui-warn, #f59e0b)',
    3: 'var(--ui-error, #ef4444)',
  }

  const levelLabels = { 0: 'log', 1: 'info', 2: 'warn', 3: 'error' }

  return jsxs('div', {
    className:
      'flex flex-col border-t border-[var(--ui-stroke-secondary)] bg-[var(--ui-bg-elevated)] overflow-hidden',
    style: { height: `${height}px` },
    children: [
      // Drag handle / sash
      jsx('div', {
        className:
          'h-1 cursor-row-resize bg-[var(--ui-stroke-secondary)] hover:bg-[var(--ui-accent)] transition-colors shrink-0',
        onPointerDown: onResizeStart,
      }),
      // Header
      jsxs('div', {
        className:
          'flex items-center justify-between px-2 py-1 border-b border-[var(--ui-stroke-secondary)] shrink-0',
        children: [
          jsx('span', {
            className:
              'text-[0.6875rem] font-medium uppercase tracking-wide text-[var(--ui-text-tertiary)]',
            children: t('console'),
          }),
          jsxs('div', {
            className: 'flex items-center gap-1',
            children: [
              jsx('span', {
                className: 'text-[0.625rem] text-[var(--ui-text-quaternary)]',
                children: `${entries.length}`,
              }),
              jsx(IconButton, {
                icon: 'Trash2',
                label: 'Clear console',
                onClick: () => clearConsole(tabId),
              }),
            ],
          }),
        ],
      }),
      // Entries
      jsx('div', {
        ref: scrollRef,
        onScroll: handleScroll,
        className: 'flex-1 overflow-auto min-h-0',
        children:
          entries.length === 0
            ? jsx('div', {
                className:
                  'flex h-full items-center justify-center text-[0.6875rem] text-[var(--ui-text-quaternary)]',
                children: 'No console output',
              })
            : entries.map((entry) =>
                jsxs(
                  'div',
                  {
                    className:
                      'grid grid-cols-[3rem_1fr] gap-1 px-1.5 py-0.5 text-[0.6875rem] font-mono hover:bg-accent/10',
                    children: [
                      jsx('span', {
                        className: 'uppercase opacity-60',
                        style: {
                          color: levelColors[entry.level] || levelColors[0],
                        },
                        children: levelLabels[entry.level] || 'log',
                      }),
                      jsxs('span', {
                        className: 'min-w-0 break-words',
                        style: {
                          color: levelColors[entry.level] || levelColors[0],
                        },
                        children: [
                          entry.message,
                          entry.source
                            ? jsxs('span', {
                                className: 'opacity-50 ml-1',
                                children: [
                                  ' (',
                                  compactUrl(entry.source),
                                  entry.line ? `:${entry.line}` : '',
                                  ')',
                                ],
                              })
                            : null,
                        ],
                      }),
                    ],
                  },
                  `console-${entry.id}`
                )
              ),
      }),
    ],
  })
}

/** Network panel — shows basic network requests. */
function NetworkPanel({ tabId, height, onResizeStart }) {
  const t = usePluginI18n(PLUGIN_ID)
  const networkVersion = useValue($networkVersion)
  const scrollRef = useRef(null)
  const stickRef = useRef(true)
  const entries = networkEntriesMap.get(tabId) || []

  useEffect(() => {
    if (!stickRef.current) return
    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [networkVersion, tabId])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= 24
  }

  const statusColor = (status) => {
    if (!status) return 'var(--ui-text-tertiary)'
    if (status >= 200 && status < 300) return 'var(--ui-success, #22c55e)'
    if (status >= 300 && status < 400) return 'var(--ui-accent)'
    if (status >= 400 && status < 500) return 'var(--ui-warn, #f59e0b)'
    if (status >= 500) return 'var(--ui-error, #ef4444)'
    return 'var(--ui-text-tertiary)'
  }

  return jsxs('div', {
    className:
      'flex flex-col border-t border-[var(--ui-stroke-secondary)] bg-[var(--ui-bg-elevated)] overflow-hidden',
    style: { height: `${height}px` },
    children: [
      jsx('div', {
        className:
          'h-1 cursor-row-resize bg-[var(--ui-stroke-secondary)] hover:bg-[var(--ui-accent)] transition-colors shrink-0',
        onPointerDown: onResizeStart,
      }),
      jsxs('div', {
        className:
          'flex items-center justify-between px-2 py-1 border-b border-[var(--ui-stroke-secondary)] shrink-0',
        children: [
          jsx('span', {
            className:
              'text-[0.6875rem] font-medium uppercase tracking-wide text-[var(--ui-text-tertiary)]',
            children: t('network'),
          }),
          jsxs('div', {
            className: 'flex items-center gap-1',
            children: [
              jsx('span', {
                className: 'text-[0.625rem] text-[var(--ui-text-quaternary)]',
                children: `${entries.length}`,
              }),
              jsx(IconButton, {
                icon: 'Trash2',
                label: 'Clear network',
                onClick: () => clearNetwork(tabId),
              }),
            ],
          }),
        ],
      }),
      jsx('div', {
        ref: scrollRef,
        onScroll: handleScroll,
        className: 'flex-1 overflow-auto min-h-0',
        children:
          entries.length === 0
            ? jsx('div', {
                className:
                  'flex h-full items-center justify-center text-[0.6875rem] text-[var(--ui-text-quaternary)]',
                children: 'No network activity',
              })
            : entries.map((entry) =>
                jsxs(
                  'div',
                  {
                    className:
                      'grid grid-cols-[3rem_2rem_1fr_3rem] items-center gap-1 px-1.5 py-0.5 text-[0.625rem] font-mono hover:bg-accent/10',
                    children: [
                      jsx('span', {
                        className: 'text-[var(--ui-text-quaternary)]',
                        children: entry.method || 'GET',
                      }),
                      jsx('span', {
                        className: 'font-medium',
                        style: { color: statusColor(entry.status) },
                        children: entry.status || '—',
                      }),
                      jsx('span', {
                        className:
                          'min-w-0 truncate text-[var(--ui-text-secondary)]',
                        title: entry.url,
                        children: entry.url,
                      }),
                      jsx('span', {
                        className:
                          'text-right text-[var(--ui-text-quaternary)]',
                        children: entry.timestamp
                          ? new Date(entry.timestamp).toLocaleTimeString()
                          : '',
                      }),
                    ],
                  },
                  `net-${entry.id}`
                )
              ),
      }),
    ],
  })
}

/** Error state overlay with retry button. */
function ErrorOverlay({ error, onRetry, t }) {
  if (!error) return null
  return jsxs('div', {
    className:
      'absolute inset-0 flex items-center justify-center bg-[var(--ui-bg-base)] z-10',
    children: [
      jsxs('div', {
        className: 'flex flex-col items-center gap-3 p-6 text-center max-w-sm',
        children: [
          jsx(icons.AlertCircle, {
            className: 'size-8 text-[var(--ui-error, #ef4444)]',
          }),
          jsx('div', {
            className: 'text-sm font-medium text-[var(--ui-text-primary)]',
            children: t('error'),
          }),
          jsx('div', {
            className:
              'text-xs text-[var(--ui-text-tertiary)] font-mono break-all',
            children: error.description,
          }),
          error.url
            ? jsx('a', {
                className:
                  'text-[0.6875rem] font-mono text-[var(--ui-accent)] underline underline-offset-2 cursor-pointer',
                href: error.url,
                onClick: (e) => {
                  e.preventDefault()
                  window.hermesDesktop?.openExternal?.(error.url)
                },
                children: compactUrl(error.url),
              })
            : null,
          jsx(Button, {
            variant: 'outline',
            size: 'sm',
            onClick: onRetry,
            children: t('retry'),
          }),
        ],
      }),
    ],
  })
}

/** A single webview host — manages the lifecycle of one webview element. */
function WebviewHost({ tab }) {
  const t = usePluginI18n(PLUGIN_ID)
  const hostRef = useRef(null)
  const deviceMode = useValue($deviceMode)
  const activeIndex = useValue($activeTabIndex)
  const tabs = useValue($tabs)
  const isActive = tabs[activeIndex]?.id === tab.id

  useEffect(() => {
    const hostDiv = hostRef.current
    if (!hostDiv) return

    // Clean up any existing webview
    hostDiv.replaceChildren()
    hostRefs.set(tab.id, hostDiv)

    // Create and attach the webview
    const webview = createWebviewForTab(tab.id, tab.url, hostDiv)
    webviewRefs.set(tab.id, webview)

    // Set device mode UA if not desktop (via attribute, safe pre-dom-ready)
    if (deviceMode !== 'desktop' && DEVICE_PRESETS[deviceMode]) {
      webview.setAttribute('useragent', DEVICE_PRESETS[deviceMode].ua)
    }

    // Update URL bar to this tab's URL when it becomes active
    currentUrlMap.set(tab.id, tab.url)
    if (isActive) {
      $urlBarValue.set(tab.url)
      updateNavState(tab.id)
    }

    return () => {
      try {
        webview._cleanup?.()
        webview.remove()
      } catch {}
      webviewRefs.delete(tab.id)
      hostRefs.delete(tab.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id])

  const deviceWidth = DEVICE_PRESETS[deviceMode]?.width

  return jsxs('div', {
    className: cn(
      'relative flex-1 min-h-0 overflow-hidden',
      !isActive && 'hidden'
    ),
    children: [
      jsx('div', {
        className: 'flex h-full w-full justify-center',
        children: jsx('div', {
          ref: hostRef,
          className: cn(
            'flex bg-transparent',
            deviceWidth ? '' : 'w-full h-full'
          ),
          style: deviceWidth
            ? { width: deviceWidth, height: '100%' }
            : undefined,
        }),
      }),
      tab.error && isActive
        ? jsx(ErrorOverlay, {
            error: tab.error,
            onRetry: () => {
              errorMap.set(tab.id, null)
              updateTab(tab.id, { error: null })
              reloadActiveTab()
            },
            t: usePluginI18n(PLUGIN_ID),
          })
        : null,
    ],
  })
}

/** Resizable panel sash logic — shared by console and network panels. */
function useResizablePanel($height, minPx, storageKey) {
  const height = useValue($height)

  const startResize = useCallback(
    (event) => {
      event.preventDefault()
      const pointerId = event.pointerId
      const startY = event.clientY
      const startHeight = $height.get()
      const containerEl = event.currentTarget.parentElement
      const containerHeight =
        containerEl?.parentElement?.clientHeight || window.innerHeight
      const maxHeight = Math.floor(
        containerHeight * CONSOLE_MAX_HEIGHT_RATIO
      )

      let active = true
      const prevCursor = document.body.style.cursor
      const prevUserSelect = document.body.style.userSelect

      event.currentTarget.setPointerCapture?.(pointerId)
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'

      // Use requestAnimationFrame coalescing for smooth resize
      let rafId = null
      let pendingHeight = startHeight

      const applyHeight = () => {
        rafId = null
        const clamped = Math.max(minPx, Math.min(maxHeight, pendingHeight))
        $height.set(clamped)
      }

      const handleMove = (moveEvent) => {
        if (!active) return
        pendingHeight = startHeight + (startY - moveEvent.clientY)
        if (rafId === null) {
          rafId = requestAnimationFrame(applyHeight)
        }
      }

      const cleanup = () => {
        if (!active) return
        active = false
        if (rafId !== null) cancelAnimationFrame(rafId)
        document.body.style.cursor = prevCursor
        document.body.style.userSelect = prevUserSelect
        event.currentTarget.releasePointerCapture?.(pointerId)
        window.removeEventListener('pointermove', handleMove, true)
        window.removeEventListener('pointerup', cleanup, true)
        window.removeEventListener('pointercancel', cleanup, true)
        // Persist the final height
        persist(storageKey, $height.get())
      }

      window.addEventListener('pointermove', handleMove, true)
      window.addEventListener('pointerup', cleanup, true)
      window.addEventListener('pointercancel', cleanup, true)
    },
    [$height, minPx, storageKey]
  )

  return { height, startResize }
}

// ---------------------------------------------------------------------------
// Main DevBrowserPane component
// ---------------------------------------------------------------------------

function DevBrowserPane() {
  const t = usePluginI18n(PLUGIN_ID)
  const tabs = useValue($tabs)
  const activeIndex = useValue($activeTabIndex)
  const consoleOpen = useValue($consoleOpen)
  const networkOpen = useValue($networkOpen)
  const urlInputRef = useRef(null)

  const consolePanel = useResizablePanel(
    $consoleHeight,
    CONSOLE_MIN_HEIGHT,
    'consoleHeight'
  )
  const networkPanel = useResizablePanel(
    $networkHeight,
    NETWORK_MIN_HEIGHT,
    'networkHeight'
  )

  // Initialize tabs on first mount
  const initializedRef = useRef(false)
  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true

    if ($tabs.get().length === 0) {
      addTab($homeUrl.get())
    }
  }, [])

  // Persist console/network open state on toggle
  useEffect(() => {
    persist('consoleOpen', consoleOpen)
  }, [consoleOpen])

  useEffect(() => {
    persist('networkOpen', networkOpen)
  }, [networkOpen])

  const activeTab = tabs[activeIndex]

  return jsxs('div', {
    className:
      'flex h-full w-full flex-col overflow-hidden bg-transparent text-[var(--ui-text-primary)]',
    children: [
      // Tab bar
      jsx(TabBar, {}),
      // Navigation toolbar
      jsx(NavToolbar, { urlInputRef }),
      // Webview area (all tabs rendered, only active visible)
      jsxs('div', {
        className:
          'relative flex-1 min-h-0 flex flex-col overflow-hidden',
        children: [
          jsx('div', {
            className: 'flex-1 min-h-0 flex flex-col overflow-hidden',
            children: tabs.map((tab) =>
              jsx(WebviewHost, { tab }, `wvhost-${tab.id}`)
            ),
          }),
          // Network panel (above console if both open)
          networkOpen && activeTab
            ? jsx(NetworkPanel, {
                tabId: activeTab.id,
                height: networkPanel.height,
                onResizeStart: networkPanel.startResize,
              })
            : null,
          // Console panel
          consoleOpen && activeTab
            ? jsx(ConsolePanel, {
                tabId: activeTab.id,
                height: consolePanel.height,
                onResizeStart: consolePanel.startResize,
              })
            : null,
        ],
      }),
    ],
  })
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export default {
  id: PLUGIN_ID,
  name: 'Dev Browser',

  register(ctx) {
    // Initialize storage and load persisted state
    initStorage(ctx)

    // i18n locale bundles
    ctx.i18n.register({
      en: {
        title: 'Dev Browser',
        urlPlaceholder: 'Enter URL or search...',
        back: 'Back',
        forward: 'Forward',
        reload: 'Reload',
        home: 'Home',
        devtools: 'Toggle DevTools',
        newTab: 'New Tab',
        closeTab: 'Close Tab',
        console: 'Console',
        clearHistory: 'Clear History',
        autorefresh: 'Toggle Auto-refresh',
        deviceMode: 'Device Mode',
        network: 'Network',
        loading: 'Loading...',
        error: 'Failed to load',
        retry: 'Retry',
        noHistory: 'No history yet',
      },
      es: {
        title: 'Dev Browser',
        urlPlaceholder: 'Escribe una URL o busca...',
        back: 'Atrás',
        forward: 'Adelante',
        reload: 'Recargar',
        home: 'Inicio',
        devtools: 'DevTools',
        newTab: 'Nueva pestaña',
        closeTab: 'Cerrar pestaña',
        console: 'Consola',
        clearHistory: 'Limpiar historial',
        autorefresh: 'Auto-recarga',
        deviceMode: 'Modo dispositivo',
        network: 'Red',
        loading: 'Cargando...',
        error: 'Error al cargar',
        retry: 'Reintentar',
        noHistory: 'Sin historial',
      },
    })

    // Set up agent control events
    setupAgentEvents(ctx)

    // --- Pane registration ---
    ctx.register({
      id: 'pane',
      area: PANES_AREA,
      title: 'Dev Browser',
      data: { placement: 'right', width: '480px' },
      render: () => jsx(DevBrowserPane, {}),
    })

    // --- Palette commands ---
    ctx.registerMany([
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'dev-browser.open',
          label: 'Open Dev Browser',
          keywords: ['dev', 'browser', 'web', 'preview'],
          run: () => {
            host.navigate('/dev-browser')
          },
        },
      },
      {
        id: 'close',
        area: PALETTE_AREA,
        data: {
          id: 'dev-browser.close',
          label: 'Close Dev Browser',
          keywords: ['dev', 'browser', 'close', 'hide'],
          run: () => {
            host.navigate('/')
          },
        },
      },
      {
        id: 'toggle-devtools',
        area: PALETTE_AREA,
        data: {
          id: 'dev-browser.toggle-devtools',
          label: 'Dev Browser: Toggle DevTools',
          keywords: ['dev', 'browser', 'devtools', 'inspect'],
          run: () => {
            const tabs = $tabs.get()
            const idx = $activeTabIndex.get()
            const tab = tabs[idx]
            if (tab) toggleDevTools(tab.id)
          },
        },
      },
      {
        id: 'new-tab',
        area: PALETTE_AREA,
        data: {
          id: 'dev-browser.new-tab',
          label: 'Dev Browser: New Tab',
          keywords: ['dev', 'browser', 'tab', 'new'],
          run: () => addTab($homeUrl.get()),
        },
      },
      {
        id: 'clear-history',
        area: PALETTE_AREA,
        data: {
          id: 'dev-browser.clear-history',
          label: 'Dev Browser: Clear History',
          keywords: ['dev', 'browser', 'history', 'clear'],
          run: () => {
            clearHistory()
            host.notify({ kind: 'info', message: 'URL history cleared.' })
          },
        },
      },
      {
        id: 'pick-element',
        area: PALETTE_AREA,
        data: {
          id: 'dev-browser.pick-element',
          label: 'Dev Browser: Pick Element',
          keywords: ['dev', 'browser', 'pick', 'element', 'inspect', 'selector'],
          run: () => startElementPicker(),
        },
      },
    ])

    // --- Keybinds ---
    ctx.registerMany([
      {
        id: 'reload',
        area: KEYBINDS_AREA,
        data: {
          id: 'dev-browser.reload',
          label: 'Dev Browser: Reload',
          category: 'view',
          defaults: ['mod+r'],
          run: () => reloadActiveTab(),
        },
      },
      {
        id: 'toggle-devtools-kb',
        area: KEYBINDS_AREA,
        data: {
          id: 'dev-browser.toggle-devtools',
          label: 'Dev Browser: Toggle DevTools',
          category: 'view',
          defaults: ['mod+alt+i'],
          run: () => {
            const tabs = $tabs.get()
            const idx = $activeTabIndex.get()
            const tab = tabs[idx]
            if (tab) toggleDevTools(tab.id)
          },
        },
      },
      {
        id: 'focus-url',
        area: KEYBINDS_AREA,
        data: {
          id: 'dev-browser.focus-url',
          label: 'Dev Browser: Focus URL Bar',
          category: 'view',
          defaults: ['mod+l'],
          run: () => {
            $urlBarFocusSignal.set($urlBarFocusSignal.get() + 1)
          },
        },
      },
    ])
  },
}
