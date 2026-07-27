// Dev Browser — a full-featured web browser pane for the Hermes desktop app.
// Disk plugin (plain ESM, loaded uncompiled). No JSX syntax — uses jsx()/jsxs()
// from react/jsx-runtime. Only imports: @hermes/plugin-sdk, react, react/jsx-runtime.
//
// Features: multi-tab navigation, console panel, network inspector, device mode,
// agent control via events, palette commands,
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
} from '@hermes/plugin-sdk'

// Area constants are not available in the runtime SDK shim (lazy getters
// not enumerated by Object.keys at shim-build time). Use literal values.
const PANES_AREA = 'panes'
const PALETTE_AREA = 'palette'
const KEYBINDS_AREA = 'keybinds'

import { useCallback, useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN_ID = 'hermes-dev-browser'

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

/** Compact a URL for display: show only the host. */
function compactUrl(url) {
  try {
    const u = new URL(url)
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname)
    return u.host
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

// Plugin context captured at register() time so module-level helpers
// (e.g. takeScreenshot) can reach the plugin REST API.
let _pluginCtx = null
// Incognito mode — when ON, new tabs use an ephemeral (non-persisted) partition
const $incognitoMode = atom(false)

// Bookmarks — persisted list of { url, title }
const $bookmarks = atom([])

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

  // Restore persisted tabs (url, title, pinned) — not the id or runtime state
  const savedTabs = _storage.get('savedTabs', [])
  if (Array.isArray(savedTabs) && savedTabs.length > 0) {
    const restored = savedTabs.map(function (st) {
      return createTab(st.url, { pinned: !!st.pinned })
    })
    $tabs.set(restored)
    const savedActive = _storage.get('activeTabIndex', 0)
    $activeTabIndex.set(Math.min(savedActive, restored.length - 1))
  }

  // Restore bookmarks
  const savedBookmarks = _storage.get('bookmarks', [])
  if (Array.isArray(savedBookmarks)) $bookmarks.set(savedBookmarks)
}

function persistHistory() {
  if (!_storage) return
  _storage.set('urlHistory', $urlHistory.get())
}

function persist(key, value) {
  if (!_storage) return
  _storage.set(key, value)
}

function persistTabs() {
  if (!_storage) return
  var tabs = $tabs.get()
  var saved = tabs.map(function (t) {
    return { url: t.url, title: t.title, pinned: !!t.pinned }
  })
  _storage.set('savedTabs', saved)
  _storage.set('activeTabIndex', $activeTabIndex.get())
}

// ── Bookmarks ────────────────────────────────────────────────────────────

function isBookmarked(url) {
  return $bookmarks.get().some(function (b) { return b.url === url })
}

function addBookmark(url, title) {
  if (!url || isBookmarked(url)) return
  var bm = [...$bookmarks.get(), { url: url, title: title || compactUrl(url) }]
  $bookmarks.set(bm)
  persistBookmarks()
}

function removeBookmark(url) {
  var bm = $bookmarks.get().filter(function (b) { return b.url !== url })
  $bookmarks.set(bm)
  persistBookmarks()
}

function toggleBookmark(url, title) {
  if (isBookmarked(url)) {
    removeBookmark(url)
  } else {
    addBookmark(url, title)
  }
}

function persistBookmarks() {
  if (!_storage) return
  _storage.set('bookmarks', $bookmarks.get())
}

function togglePinTab(index) {
  var tabs = $tabs.get()
  var tab = tabs[index]
  if (!tab) return
  tab.pinned = !tab.pinned
  // Move pinned tabs to the front, unpinned to the back
  var pinned = tabs.filter(function (t) { return t.pinned })
  var unpinned = tabs.filter(function (t) { return !t.pinned })
  var reordered = pinned.concat(unpinned)
  // Find the tab that was toggled in the new order
  var newIdx = reordered.indexOf(tab)
  $tabs.set(reordered)
  $activeTabIndex.set(newIdx)
  persistTabs()
}

// ---------------------------------------------------------------------------
// Tab management
// ---------------------------------------------------------------------------

function createTab(url, opts) {
  opts = opts || {}
  const id = nextId()
  const tab = {
    id,
    url: url || $homeUrl.get(),
    title: compactUrl(url || $homeUrl.get()),
    loading: false,
    error: null,
    pinned: !!opts.pinned,
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
  // Stash the partition this tab should use so createWebviewForTab can pick it
  // up when the TabContent component mounts. Incognito tabs get an ephemeral
  // (non-persisted) partition; normal tabs keep the persisted one.
  tab._partition = $incognitoMode.get() ? 'hermes-dev-browser-incognito' : 'persist:hermes-dev-browser'
  persistTabs()
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
  persistTabs()

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
  // Persist when title or url changes (not on loading/error)
  if (updates.title || updates.url) {
    persistTabs()
  }
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

                  // Format and copy to the clipboard
                  const ref = formatElementRef(result)
                  copyToClipboard(ref)

                  host.notify({ kind: 'success', message: `Element picked: ${result.tagName}${result.id ? '#' + result.id : ''} — copied to clipboard.` })
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

/** Capture the active webview and copy the PNG to the system clipboard. */
function takeScreenshot() {
  const tabs = $tabs.get()
  const idx = $activeTabIndex.get()
  const tab = tabs[idx]
  if (!tab) return

  const wv = webviewRefs.get(tab.id)
  if (!wv?.capturePage) {
    host.notify({ kind: 'warning', message: 'Browser not ready for screenshot' })
    return
  }

  Promise.resolve(wv.capturePage())
    .then(async (image) => {
      const dataUrl = image?.toDataURL?.()
      if (!dataUrl) throw new Error('empty capture')

      // navigator.clipboard.write is ALWAYS denied in this renderer — Hermes'
      // permission handler grants only audio capture. Image clipboard writes
      // therefore go through the Python backend (osascript on macOS).
      const res = await _pluginCtx?.rest?.('/copy-image', {
        method: 'POST',
        body: { data_url: dataUrl },
      })
      if (res?.ok) {
        host.notify({ kind: 'success', message: '📸 Screenshot copied to clipboard.' })
      } else {
        throw new Error(res?.error || 'clipboard copy failed')
      }
    })
    .catch((err) => {
      host.notify({ kind: 'warning', message: `Screenshot failed: ${err?.message || err}` })
    })
}

/** Copy text to the system clipboard (with execCommand fallback). */
function copyToClipboard(text) {
  const value = text.trim()
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(value).catch(() => fallbackCopy(value))
  } else {
    fallbackCopy(value)
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try { document.execCommand('copy') } catch {}
  ta.remove()
}

/** Format an element picker result into a reference string for the clipboard. */
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

// ---------------------------------------------------------------------------
// Webview creation and event wiring
// ---------------------------------------------------------------------------

function createWebviewForTab(tabId, url, hostDiv, partition) {
  const webview = document.createElement('webview')

  // Critical attributes.
  // partition MUST be set before the webview is attached to the DOM — Electron
  // only honors the attribute at attach time, and changing it afterwards has no
  // effect. Default to the persisted partition so cookies/sessions survive
  // Hermes restarts; callers may pass an ephemeral partition for incognito.
  webview.setAttribute('allowpopups', '')
  webview.setAttribute('partition', partition || 'persist:hermes-dev-browser')
  // allowRunningInsecureContent is needed for localhost / HTTP sites (e.g. Dran)
  webview.setAttribute(
    'webpreferences',
    'contextIsolation=yes,nodeIntegration=no,sandbox=yes,allowRunningInsecureContent=true'
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

  // Crash recovery — if the webview renderer process crashes, reload it
  const onCrashed = () => {
    appendConsoleEntry(tabId, {
      level: 2,
      message: 'Webview renderer process crashed — reloading tab',
    })
    // Force a reload by re-setting the src attribute
    try {
      const currentUrl = currentUrlMap.get(tabId) || url
      webview.setAttribute('src', currentUrl)
    } catch {}
  }

  const onUnresponsive = () => {
    appendConsoleEntry(tabId, {
      level: 1,
      message: 'Webview became unresponsive',
    })
  }

  const onResponsive = () => {
    appendConsoleEntry(tabId, {
      level: 0,
      message: 'Webview became responsive again',
    })
  }

  // Right-click toggles the element picker
  const onContextMenu = (e) => {
    e.preventDefault()
    if ($pickerActive.get()) {
      stopElementPicker()
    } else {
      startElementPicker()
    }
  }

  webview.addEventListener('crashed', onCrashed)
  webview.addEventListener('unresponsive', onUnresponsive)
  webview.addEventListener('responsive', onResponsive)
  webview.addEventListener('context-menu', onContextMenu)

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
    webview.removeEventListener('crashed', onCrashed)
    webview.removeEventListener('unresponsive', onUnresponsive)
    webview.removeEventListener('responsive', onResponsive)
    webview.removeEventListener('context-menu', onContextMenu)
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

  // Window event listener — lets other plugins emit preview.open via
  // window.dispatchEvent(new CustomEvent('hermes:dev-browser:navigate', { detail: { url } }))
  function onWindowNavigate(e) {
    const url = e?.detail?.url || e?.detail?.payload?.url
    if (!url) return
    const tabs = $tabs.get()
    if (tabs.length === 0) {
      addTab(url)
    } else {
      navigateActiveTab(url)
    }
  }
  window.addEventListener('hermes:dev-browser:navigate', onWindowNavigate)
  window.addEventListener('hermes:preview.open', onWindowNavigate)
  _eventDisposers.push(() => {
    window.removeEventListener('hermes:dev-browser:navigate', onWindowNavigate)
    window.removeEventListener('hermes:preview.open', onWindowNavigate)
  })

  // Window event listener — lets other plugins (e.g. hermes-dran) open a URL in
  // a NEW tab rather than navigating the active one.
  // Usage: window.dispatchEvent(new CustomEvent('hermes:dev-browser:new-tab', { detail: { url } }))
  function onWindowNewTab(e) {
    const url = e?.detail?.url || e?.detail?.payload?.url
    if (!url) return
    addTab(url)
  }
  window.addEventListener('hermes:dev-browser:new-tab', onWindowNewTab)
  _eventDisposers.push(() => {
    window.removeEventListener('hermes:dev-browser:new-tab', onWindowNewTab)
  })

  // dev-browser.navigate
  const d2 = host.onEvent('hermes-dev-browser.navigate', (event) => {
    const url = event?.payload?.url
    if (!url) return
    navigateActiveTab(url)
  })

  // dev-browser.eval
  const d3 = host.onEvent('hermes-dev-browser.eval', (event) => {
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
  const d4 = host.onEvent('hermes-dev-browser.screenshot', (event) => {
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
      const capturePromise = wv.capturePage()
      // capturePage() returns a Promise<NativeImage> in Electron webview
      Promise.resolve(capturePromise)
        .then((image) => {
          const dataUrl = image?.toDataURL?.() || null
          if (requestId) {
            ctx
              .rest('/result', {
                method: 'POST',
                body: { request_id: requestId, result: dataUrl },
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
  const d5 = host.onEvent('hermes-dev-browser.list-tabs', (event) => {
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
  const d6 = host.onEvent('hermes-dev-browser.new-tab', (event) => {
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
  const d7 = host.onEvent('hermes-dev-browser.close-tab', (event) => {
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
  const d8 = host.onEvent('hermes-dev-browser.switch-tab', (event) => {
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
  const d9 = host.onEvent('hermes-dev-browser.get-url', (event) => {
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
  const d10 = host.onEvent('hermes-dev-browser.get-console', (event) => {
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
  const d11 = host.onEvent('hermes-dev-browser.clear-console', (event) => {
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
  const d12 = host.onEvent('hermes-dev-browser.get-network', (event) => {
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
  const d13 = host.onEvent('hermes-dev-browser.set-device-mode', (event) => {
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
  const d14 = host.onEvent('hermes-dev-browser.clear-cache', (event) => {
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
  const d15 = host.onEvent('hermes-dev-browser.clear-cookies', (event) => {
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
  const d16 = host.onEvent('hermes-dev-browser.pick-element', (event) => {
    const requestId = event?.payload?.request_id
    const copyToClip = event?.payload?.copy_to_clipboard // if true, also copy to clipboard
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

                    // If copy_to_clipboard is true, also copy to clipboard
                    if (copyToClip) {
                      const ref = formatElementRef(result)
                      copyToClipboard(ref)
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

  // dev-browser.mouse-move — move mouse cursor to (x, y)
  const d17 = host.onEvent('hermes-dev-browser.mouse-move', (event) => {
    const requestId = event?.payload?.request_id
    const x = event?.payload?.x
    const y = event?.payload?.y
    const tabs = $tabs.get()
    const idx = $activeTabIndex.get()
    const tab = tabs[idx]
    if (!tab) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'no active tab' } }).catch(() => {})
      return
    }
    const wv = webviewRefs.get(tab.id)
    if (!wv) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'webview not ready' } }).catch(() => {})
      return
    }

    const jsFallback = `document.elementFromPoint(${x},${y})?.dispatchEvent(new MouseEvent('mousemove',{clientX:${x},clientY:${y},bubbles:true}))`
    const sendJsFallback = () => {
      if (wv?.executeJavaScript) {
        wv.executeJavaScript(jsFallback)
          .then(() => {
            if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { success: true, x, y, method: 'js' } } }).catch(() => {})
          })
          .catch(() => {
            if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'both methods failed' } }).catch(() => {})
          })
      } else {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'webview not ready' } }).catch(() => {})
      }
    }

    try {
      if (wv?.sendInputEvent) {
        wv.sendInputEvent({ type: 'mouseMove', x, y })
          .then(() => {
            if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { success: true, x, y, method: 'native' } } }).catch(() => {})
          })
          .catch(() => { sendJsFallback() })
      } else {
        sendJsFallback()
      }
    } catch (e) {
      sendJsFallback()
    }
  })

  // dev-browser.click — click at (x, y) with optional button and double-click
  const d18 = host.onEvent('hermes-dev-browser.click', (event) => {
    const requestId = event?.payload?.request_id
    const x = event?.payload?.x
    const y = event?.payload?.y
    const button = event?.payload?.button || 'left'
    const double = event?.payload?.double || false
    const tabs = $tabs.get()
    const idx = $activeTabIndex.get()
    const tab = tabs[idx]
    if (!tab) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'no active tab' } }).catch(() => {})
      return
    }
    const wv = webviewRefs.get(tab.id)
    if (!wv) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'webview not ready' } }).catch(() => {})
      return
    }

    const clickCount = double ? 2 : 1
    const jsFallback = `(function(){
      var el = document.elementFromPoint(${x},${y});
      if (!el) return;
      var opts = {clientX:${x},clientY:${y},bubbles:true,button:${button === 'right' ? 2 : 0}};
      el.dispatchEvent(new MouseEvent('mousedown',opts));
      el.dispatchEvent(new MouseEvent('mouseup',opts));
      if (${button === 'right' ? 1 : 0}) {
        el.dispatchEvent(new MouseEvent('contextmenu',opts));
      } else {
        el.dispatchEvent(new MouseEvent('click',opts));
        if (${double ? 1 : 0}) {
          el.dispatchEvent(new MouseEvent('click',opts));
        }
      }
    })()`
    const sendJsFallback = () => {
      if (wv?.executeJavaScript) {
        wv.executeJavaScript(jsFallback)
          .then(() => {
            if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { success: true, x, y, button, method: 'js' } } }).catch(() => {})
          })
          .catch(() => {
            if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'both methods failed' } }).catch(() => {})
          })
      } else {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'webview not ready' } }).catch(() => {})
      }
    }

    try {
      if (wv?.sendInputEvent) {
        wv.sendInputEvent({ type: 'mouseMove', x, y })
          .then(() => wv.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount }))
          .then(() => wv.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount }))
          .then(() => {
            if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { success: true, x, y, button, method: 'native' } } }).catch(() => {})
          })
          .catch(() => { sendJsFallback() })
      } else {
        sendJsFallback()
      }
    } catch (e) {
      sendJsFallback()
    }
  })

  // dev-browser.type — type text into the focused element
  const d19 = host.onEvent('hermes-dev-browser.type', (event) => {
    const requestId = event?.payload?.request_id
    const text = event?.payload?.text || ''
    const tabs = $tabs.get()
    const idx = $activeTabIndex.get()
    const tab = tabs[idx]
    if (!tab) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'no active tab' } }).catch(() => {})
      return
    }
    const wv = webviewRefs.get(tab.id)
    if (!wv) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'webview not ready' } }).catch(() => {})
      return
    }

    const escapedText = JSON.stringify(text)
    const jsFallback = `(function(){
      var el = document.activeElement;
      if (!el) return;
      var t = ${escapedText};
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.value = el.value + t;
        el.dispatchEvent(new Event('input',{bubbles:true}));
        el.dispatchEvent(new Event('change',{bubbles:true}));
      } else if (el.isContentEditable) {
        document.execCommand('insertText', false, t);
      }
    })()`
    const sendJsFallback = () => {
      if (wv?.executeJavaScript) {
        wv.executeJavaScript(jsFallback)
          .then(() => {
            if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { success: true, text, method: 'js' } } }).catch(() => {})
          })
          .catch(() => {
            if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'both methods failed' } }).catch(() => {})
          })
      } else {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'webview not ready' } }).catch(() => {})
      }
    }

    // Native: send each char sequentially via promise chain
    try {
      if (wv?.sendInputEvent) {
        let chain = Promise.resolve()
        for (const char of text) {
          chain = chain.then(() => wv.sendInputEvent({ type: 'char', keyCode: char }))
        }
        chain
          .then(() => {
            if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { success: true, text, method: 'native' } } }).catch(() => {})
          })
          .catch(() => { sendJsFallback() })
      } else {
        sendJsFallback()
      }
    } catch (e) {
      sendJsFallback()
    }
  })

  // dev-browser.press-key — press a keyboard key
  const d20 = host.onEvent('hermes-dev-browser.press-key', (event) => {
    const requestId = event?.payload?.request_id
    const key = event?.payload?.key || ''
    const tabs = $tabs.get()
    const idx = $activeTabIndex.get()
    const tab = tabs[idx]
    if (!tab) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'no active tab' } }).catch(() => {})
      return
    }
    const wv = webviewRefs.get(tab.id)
    if (!wv) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'webview not ready' } }).catch(() => {})
      return
    }

    const escapedKey = JSON.stringify(key)
    const jsFallback = `(function(){
      var el = document.activeElement;
      if (!el) return;
      var k = ${escapedKey};
      el.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true}));
      el.dispatchEvent(new KeyboardEvent('keyup',{key:k,bubbles:true}));
    })()`
    const sendJsFallback = () => {
      if (wv?.executeJavaScript) {
        wv.executeJavaScript(jsFallback)
          .then(() => {
            if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { success: true, key, method: 'js' } } }).catch(() => {})
          })
          .catch(() => {
            if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'both methods failed' } }).catch(() => {})
          })
      } else {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'webview not ready' } }).catch(() => {})
      }
    }

    try {
      if (wv?.sendInputEvent) {
        wv.sendInputEvent({ type: 'keyDown', keyCode: key })
          .then(() => wv.sendInputEvent({ type: 'keyUp', keyCode: key }))
          .then(() => {
            if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { success: true, key, method: 'native' } } }).catch(() => {})
          })
          .catch(() => { sendJsFallback() })
      } else {
        sendJsFallback()
      }
    } catch (e) {
      sendJsFallback()
    }
  })

  // dev-browser.scroll — scroll at (x, y) in a direction
  const d21 = host.onEvent('hermes-dev-browser.scroll', (event) => {
    const requestId = event?.payload?.request_id
    const x = event?.payload?.x || 0
    const y = event?.payload?.y || 0
    const direction = event?.payload?.direction || 'down'
    const amount = event?.payload?.amount || 300
    const tabs = $tabs.get()
    const idx = $activeTabIndex.get()
    const tab = tabs[idx]
    if (!tab) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'no active tab' } }).catch(() => {})
      return
    }
    const wv = webviewRefs.get(tab.id)
    if (!wv) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'webview not ready' } }).catch(() => {})
      return
    }

    const delta = direction === 'down' ? amount : -amount
    const ticks = direction === 'down' ? 3 : -3
    const jsFallback = `window.scrollBy(0, ${delta})`
    const sendJsFallback = () => {
      if (wv?.executeJavaScript) {
        wv.executeJavaScript(jsFallback)
          .then(() => {
            if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { success: true, direction, amount, method: 'js' } } }).catch(() => {})
          })
          .catch(() => {
            if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'both methods failed' } }).catch(() => {})
          })
      } else {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'webview not ready' } }).catch(() => {})
      }
    }

    try {
      if (wv?.sendInputEvent) {
        wv.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: delta, wheelTicksX: 0, wheelTicksY: ticks })
          .then(() => {
            if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { success: true, direction, amount, method: 'native' } } }).catch(() => {})
          })
          .catch(() => { sendJsFallback() })
      } else {
        sendJsFallback()
      }
    } catch (e) {
      sendJsFallback()
    }
  })

  // dev-browser.drag — drag from (x1,y1) to (x2,y2)
  const d22 = host.onEvent('hermes-dev-browser.drag', (event) => {
    const requestId = event?.payload?.request_id
    const x1 = event?.payload?.x1
    const y1 = event?.payload?.y1
    const x2 = event?.payload?.x2
    const y2 = event?.payload?.y2
    const tabs = $tabs.get()
    const idx = $activeTabIndex.get()
    const tab = tabs[idx]
    if (!tab) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'no active tab' } }).catch(() => {})
      return
    }
    const wv = webviewRefs.get(tab.id)
    if (!wv) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'webview not ready' } }).catch(() => {})
      return
    }

    const jsFallback = `(function(){
      var el = document.elementFromPoint(${x1},${y1});
      if (!el) return;
      var opts1 = {clientX:${x1},clientY:${y1},bubbles:true};
      var opts2 = {clientX:${x2},clientY:${y2},bubbles:true};
      el.dispatchEvent(new DragEvent('dragstart',opts1));
      el.dispatchEvent(new DragEvent('drag',opts2));
      el.dispatchEvent(new DragEvent('dragend',opts2));
    })()`
    const sendJsFallback = () => {
      if (wv?.executeJavaScript) {
        wv.executeJavaScript(jsFallback)
          .then(() => {
            if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { success: true, from: { x: x1, y: y1 }, to: { x: x2, y: y2 }, method: 'js' } } }).catch(() => {})
          })
          .catch(() => {
            if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'both methods failed' } }).catch(() => {})
          })
      } else {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'webview not ready' } }).catch(() => {})
      }
    }

    try {
      if (wv?.sendInputEvent) {
        wv.sendInputEvent({ type: 'mouseMove', x: x1, y: y1 })
          .then(() => wv.sendInputEvent({ type: 'mouseDown', x: x1, y: y1, button: 'left', clickCount: 1 }))
          .then(() => wv.sendInputEvent({ type: 'mouseMove', x: x2, y: y2 }))
          .then(() => wv.sendInputEvent({ type: 'mouseUp', x: x2, y: y2, button: 'left', clickCount: 1 }))
          .then(() => {
            if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { success: true, from: { x: x1, y: y1 }, to: { x: x2, y: y2 }, method: 'native' } } }).catch(() => {})
          })
          .catch(() => { sendJsFallback() })
      } else {
        sendJsFallback()
      }
    } catch (e) {
      sendJsFallback()
    }
  })

  // dev-browser.wait-for-selector — poll until selector exists, with timeout
  const d23 = host.onEvent('hermes-dev-browser.wait-for-selector', (event) => {
    const requestId = event?.payload?.request_id
    const selector = event?.payload?.selector
    const timeout = event?.payload?.timeout || 10000
    const visible = event?.payload?.visible !== false
    if (!selector) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'selector required' } }).catch(() => {})
      return
    }
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
    const checkScript = visible
      ? `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;var r=el.getBoundingClientRect();if(r.width===0||r.height===0)return null;return {tag:el.tagName,id:el.id||undefined,className:el.className||undefined,text:(el.textContent||'').substring(0,200),rect:{x:r.x,y:r.y,width:r.width,height:r.height}}})()`
      : `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;return {tag:el.tagName,id:el.id||undefined,className:el.className||undefined,text:(el.textContent||'').substring(0,200)}})()`
    const deadline = Date.now() + timeout
    const pollSel = setInterval(() => {
      wv.executeJavaScript(checkScript)
        .then((result) => {
          if (result) {
            clearInterval(pollSel)
            if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { found: true, element: result } } }).catch(() => {})
          } else if (Date.now() >= deadline) {
            clearInterval(pollSel)
            if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { found: false } } }).catch(() => {})
          }
        })
        .catch(() => {
          if (Date.now() >= deadline) {
            clearInterval(pollSel)
            if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { found: false } } }).catch(() => {})
          }
        })
    }, 200)
  })

  // dev-browser.get-page-text — extract all visible text from the page
  const d24 = host.onEvent('hermes-dev-browser.get-page-text', (event) => {
    const requestId = event?.payload?.request_id
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
    wv.executeJavaScript('document.body ? document.body.innerText : ""')
      .then((text) => {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { text: text || '', length: (text || '').length } } }).catch(() => {})
      })
      .catch((error) => {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: error instanceof Error ? error.message : String(error) } }).catch(() => {})
      })
  })

  // dev-browser.get-dom-snapshot — return a simplified DOM tree as text
  const d25 = host.onEvent('hermes-dev-browser.get-dom-snapshot', (event) => {
    const requestId = event?.payload?.request_id
    const maxDepth = event?.payload?.max_depth || 5
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
    const script = `(function(){
      function snap(el, depth) {
        if (depth > ${maxDepth}) return null;
        var children = [];
        for (var i = 0; i < el.children.length && i < 50; i++) {
          var c = snap(el.children[i], depth + 1);
          if (c) children.push(c);
        }
        var r = el.getBoundingClientRect ? el.getBoundingClientRect() : {};
        return {
          tag: el.tagName,
          id: el.id || undefined,
          class: el.className && typeof el.className === 'string' ? el.className.substring(0, 100) : undefined,
          text: (el.textContent || '').trim().substring(0, 80),
          rect: r.width > 0 ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : undefined,
          children: children.length ? children : undefined
        };
      }
      return snap(document.body, 0);
    })()`
    wv.executeJavaScript(script)
      .then((result) => {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result } }).catch(() => {})
      })
      .catch((error) => {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: error instanceof Error ? error.message : String(error) } }).catch(() => {})
      })
  })

  // dev-browser.fill-form — fill multiple form fields at once
  const d26 = host.onEvent('hermes-dev-browser.fill-form', (event) => {
    const requestId = event?.payload?.request_id
    const fields = event?.payload?.fields || {}
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
    const fieldsJson = JSON.stringify(fields)
    const script = `(function(){
      var fields = ${fieldsJson};
      var filled = 0, failed = 0;
      for (var sel in fields) {
        var el = document.querySelector(sel);
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
          el.value = fields[sel];
          el.dispatchEvent(new Event('input', {bubbles: true}));
          el.dispatchEvent(new Event('change', {bubbles: true}));
          filled++;
        } else { failed++; }
      }
      return { filled: filled, failed: failed };
    })()`
    wv.executeJavaScript(script)
      .then((result) => {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result } }).catch(() => {})
      })
      .catch((error) => {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: error instanceof Error ? error.message : String(error) } }).catch(() => {})
      })
  })

  // dev-browser.wait-for-navigation — wait for page load to complete
  const d27 = host.onEvent('hermes-dev-browser.wait-for-navigation', (event) => {
    const requestId = event?.payload?.request_id
    const timeout = event?.payload?.timeout || 15000
    const tabs = $tabs.get()
    const idx = $activeTabIndex.get()
    const tab = tabs[idx]
    if (!tab) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'no active tab' } }).catch(() => {})
      return
    }
    const deadline = Date.now() + timeout
    const pollNav = setInterval(() => {
      const t = $tabs.get()[$activeTabIndex.get()]
      if (t && !t.loading) {
        clearInterval(pollNav)
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { navigated: true, url: t.url, title: t.title } } }).catch(() => {})
      } else if (Date.now() >= deadline) {
        clearInterval(pollNav)
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { navigated: false, still_loading: true } } }).catch(() => {})
      }
    }, 200)
  })

  // dev-browser.hover — trigger CSS :hover on an element by selector
  const d28 = host.onEvent('hermes-dev-browser.hover', (event) => {
    const requestId = event?.payload?.request_id
    const selector = event?.payload?.selector
    if (!selector) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'selector required' } }).catch(() => {})
      return
    }
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
    const script = `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return {success:false,error:'not found'};el.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}));el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));el.dispatchEvent(new MouseEvent('mousemove',{bubbles:true}));return {success:true,tag:el.tagName}})()`
    wv.executeJavaScript(script)
      .then((result) => {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result } }).catch(() => {})
      })
      .catch((error) => {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: error instanceof Error ? error.message : String(error) } }).catch(() => {})
      })
  })

  // dev-browser.select-option — set value of a <select> element
  const d29 = host.onEvent('hermes-dev-browser.select-option', (event) => {
    const requestId = event?.payload?.request_id
    const selector = event?.payload?.selector
    const value = event?.payload?.value
    if (!selector) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'selector required' } }).catch(() => {})
      return
    }
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
    const script = `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return {success:false,error:'not found'};if(el.tagName!=='SELECT')return {success:false,error:'not a select element'};el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return {success:true,value:el.value}})()`
    wv.executeJavaScript(script)
      .then((result) => {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result } }).catch(() => {})
      })
      .catch((error) => {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: error instanceof Error ? error.message : String(error) } }).catch(() => {})
      })
  })

  // dev-browser.press-key-combo — press multiple keys simultaneously
  const d30 = host.onEvent('hermes-dev-browser.press-key-combo', (event) => {
    const requestId = event?.payload?.request_id
    const keys = event?.payload?.keys || []
    if (!keys.length) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'keys required' } }).catch(() => {})
      return
    }
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
    const keysJson = JSON.stringify(keys)
    const script = `(function(){
      var keys = ${keysJson};
      var el = document.activeElement || document.body;
      var mods = { ctrl: keys.includes('ctrl') || keys.includes('Cmd'), shift: keys.includes('shift'), alt: keys.includes('alt'), meta: keys.includes('meta') || keys.includes('cmd') };
      var mainKey = keys.find(function(k){ return !['ctrl','shift','alt','meta','cmd','Cmd'].includes(k) });
      if (!mainKey) return { success: false, error: 'no non-modifier key' };
      var opts = { key: mainKey, ctrlKey: mods.ctrl, shiftKey: mods.shift, altKey: mods.alt, metaKey: mods.meta, bubbles: true };
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keypress', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
      return { success: true, keys: keys };
    })()`
    wv.executeJavaScript(script)
      .then((result) => {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result } }).catch(() => {})
      })
      .catch((error) => {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: error instanceof Error ? error.message : String(error) } }).catch(() => {})
      })
  })

  // dev-browser.upload-file — set files on an <input type="file">
  const d31 = host.onEvent('hermes-dev-browser.upload-file', (event) => {
    const requestId = event?.payload?.request_id
    const selector = event?.payload?.selector
    const filePath = event?.payload?.file_path
    if (!selector || !filePath) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'selector and file_path required' } }).catch(() => {})
      return
    }
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
    // Note: Electron webview doesn't allow setting file paths via JS for security.
    // We can only dispatch the click to open the file dialog.
    const script = `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return {success:false,error:'not found'};if(el.tagName!=='INPUT'||el.type!=='file')return {success:false,error:'not a file input'};el.click();return {success:true,note:'file dialog opened — user must select file manually'}})()`
    wv.executeJavaScript(script)
      .then((result) => {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result } }).catch(() => {})
      })
      .catch((error) => {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: error instanceof Error ? error.message : String(error) } }).catch(() => {})
      })
  })

  // dev-browser.handle-dialog — accept or dismiss alert/confirm/prompt
  const d32 = host.onEvent('hermes-dev-browser.handle-dialog', (event) => {
    const requestId = event?.payload?.request_id
    const action = event?.payload?.action || 'accept'
    const promptText = event?.payload?.prompt_text || ''
    const tabs = $tabs.get()
    const idx = $activeTabIndex.get()
    const tab = tabs[idx]
    if (!tab) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'no active tab' } }).catch(() => {})
      return
    }
    const wv = webviewRefs.get(tab.id)
    // Override window.alert/confirm/prompt before they fire
    const script = `(function(){
      window.__hermesDialogResult = null;
      var origAlert = window.alert, origConfirm = window.confirm, origPrompt = window.prompt;
      window.alert = function(m) { window.__hermesDialogResult = { type: 'alert', message: m, action: '${action}' }; };
      window.confirm = function(m) { window.__hermesDialogResult = { type: 'confirm', message: m, action: '${action}', result: '${action}' === 'accept' }; return '${action}' === 'accept'; };
      window.prompt = function(m, d) { window.__hermesDialogResult = { type: 'prompt', message: m, action: '${action}', result: '${action}' === 'accept' ? ${JSON.stringify(promptText)} : null }; return '${action}' === 'accept' ? ${JSON.stringify(promptText)} : null; };
      return { success: true, note: 'dialog handlers installed — next alert/confirm/prompt will be auto-handled' };
    })()`
    if (wv?.executeJavaScript) {
      wv.executeJavaScript(script)
        .then((result) => {
          if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result } }).catch(() => {})
        })
        .catch((error) => {
          if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: error instanceof Error ? error.message : String(error) } }).catch(() => {})
        })
    } else {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'webview not ready' } }).catch(() => {})
    }
  })

  // dev-browser.get-cookies — get cookies for the current page
  const d33 = host.onEvent('hermes-dev-browser.get-cookies', (event) => {
    const requestId = event?.payload?.request_id
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
    wv.executeJavaScript('document.cookie')
      .then((cookieStr) => {
        const cookies = (cookieStr || '').split(';').filter(function (c) { return c.trim() }).map(function (c) {
          var parts = c.trim().split('=')
          return { name: parts[0], value: parts.slice(1).join('=') }
        })
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { cookies, count: cookies.length } } }).catch(() => {})
      })
      .catch((error) => {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: error instanceof Error ? error.message : String(error) } }).catch(() => {})
      })
  })

  // dev-browser.get-local-storage — get all localStorage entries
  const d34 = host.onEvent('hermes-dev-browser.get-local-storage', (event) => {
    const requestId = event?.payload?.request_id
    const key = event?.payload?.key || null
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
    const script = key
      ? `(function(){return { key: ${JSON.stringify(key)}, value: localStorage.getItem(${JSON.stringify(key)}) }})()`
      : `(function(){var items={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);items[k]=localStorage.getItem(k)}return { items: items, count: localStorage.length }})()`
    wv.executeJavaScript(script)
      .then((result) => {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result } }).catch(() => {})
      })
      .catch((error) => {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: error instanceof Error ? error.message : String(error) } }).catch(() => {})
      })
  })

  // dev-browser.get-computed-style — get computed style of an element
  const d35 = host.onEvent('hermes-dev-browser.get-computed-style', (event) => {
    const requestId = event?.payload?.request_id
    const selector = event?.payload?.selector
    const properties = event?.payload?.properties || null
    if (!selector) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'selector required' } }).catch(() => {})
      return
    }
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
    const propsJson = JSON.stringify(properties)
    const script = `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { success: false, error: 'not found' };
      var cs = window.getComputedStyle(el);
      var props = ${propsJson};
      if (props && Array.isArray(props)) {
        var result = {};
        props.forEach(function(p) { result[p] = cs.getPropertyValue(p); });
        return { success: true, styles: result };
      }
      var common = ['display','visibility','opacity','color','backgroundColor','fontSize','fontWeight','margin','padding','border','width','height','position','zIndex','overflow'];
      var result = {};
      common.forEach(function(p) { result[p] = cs.getPropertyValue(p); });
      return { success: true, styles: result };
    })()`
    wv.executeJavaScript(script)
      .then((result) => {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result } }).catch(() => {})
      })
      .catch((error) => {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: error instanceof Error ? error.message : String(error) } }).catch(() => {})
      })
  })

  // dev-browser.intercept-network — wait for a specific network request pattern
  const d36 = host.onEvent('hermes-dev-browser.intercept-network', (event) => {
    const requestId = event?.payload?.request_id
    const urlPattern = event?.payload?.url_pattern || ''
    const method = (event?.payload?.method || '').toUpperCase()
    const timeout = event?.payload?.timeout || 10000
    const tabs = $tabs.get()
    const idx = $activeTabIndex.get()
    const tab = tabs[idx]
    if (!tab) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'no active tab' } }).catch(() => {})
      return
    }
    const entries = networkEntriesMap.get(tab.id) || []
    const startLen = entries.length
    const deadline = Date.now() + timeout
    const pollNet = setInterval(() => {
      const current = networkEntriesMap.get(tab.id) || []
      for (let i = startLen; i < current.length; i++) {
        const e = current[i]
        if (urlPattern && !(e.url || '').includes(urlPattern)) continue
        if (method && (e.method || '').toUpperCase() !== method) continue
        clearInterval(pollNet)
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { found: true, entry: e } } }).catch(() => {})
        return
      }
      if (Date.now() >= deadline) {
        clearInterval(pollNet)
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { found: false } } }).catch(() => {})
      }
    }, 200)
  })

  // dev-browser.screenshot-element — screenshot a single element by selector
  const d37 = host.onEvent('hermes-dev-browser.screenshot-element', (event) => {
    const requestId = event?.payload?.request_id
    const selector = event?.payload?.selector
    if (!selector) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'selector required' } }).catch(() => {})
      return
    }
    const tabs = $tabs.get()
    const idx = $activeTabIndex.get()
    const tab = tabs[idx]
    if (!tab) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'no active tab' } }).catch(() => {})
      return
    }
    const wv = webviewRefs.get(tab.id)
    if (!wv?.executeJavaScript || !wv?.capturePage) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'webview not ready' } }).catch(() => {})
      return
    }
    // Scroll element into view, then capture full page screenshot
    wv.executeJavaScript(`(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;el.scrollIntoView({block:'center'});var r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`)
      .then((rect) => {
        if (!rect) {
          if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'element not found' } }).catch(() => {})
          return
        }
        // Capture page and crop to element rect
        Promise.resolve(wv.capturePage())
          .then((image) => {
            // Electron NativeImage crop
            try {
              const cropped = image.crop({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) })
              const dataUrl = cropped.toDataURL?.()
              if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: dataUrl } }).catch(() => {})
            } catch (e) {
              // Fallback: return full screenshot
              const dataUrl = image.toDataURL?.()
              if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: dataUrl, note: 'crop failed, returned full screenshot' } }).catch(() => {})
            }
          })
          .catch((error) => {
            if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: error instanceof Error ? error.message : String(error) } }).catch(() => {})
          })
      })
      .catch((error) => {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: error instanceof Error ? error.message : String(error) } }).catch(() => {})
      })
  })

  // dev-browser.execute-script — inject and run a multi-line script
  const d38 = host.onEvent('hermes-dev-browser.execute-script', (event) => {
    const requestId = event?.payload?.request_id
    const script = event?.payload?.script
    if (!script) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'script required' } }).catch(() => {})
      return
    }
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
    // Wrap in an async IIFE to support await
    const wrapped = `(async function(){ ${script} })()`
    wv.executeJavaScript(wrapped)
      .then((result) => {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result } }).catch(() => {})
      })
      .catch((error) => {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: error instanceof Error ? error.message : String(error) } }).catch(() => {})
      })
  })

  // dev-browser.pdf-export — print page to PDF
  const d39 = host.onEvent('hermes-dev-browser.pdf-export', (event) => {
    const requestId = event?.payload?.request_id
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
    // Use browser's print dialog
    wv.executeJavaScript('window.print()')
      .then(() => {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { success: true, note: 'print dialog opened' } } }).catch(() => {})
      })
      .catch((error) => {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: error instanceof Error ? error.message : String(error) } }).catch(() => {})
      })
  })

  // dev-browser.bookmark-management — add/remove/list bookmarks
  const d40 = host.onEvent('hermes-dev-browser.bookmark-management', (event) => {
    const requestId = event?.payload?.request_id
    const action = event?.payload?.action // 'add', 'remove', 'list'
    const url = event?.payload?.url
    const title = event?.payload?.title
    if (!action) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'action required (add|remove|list)' } }).catch(() => {})
      return
    }
    if (action === 'add') {
      if (!url) { if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'url required' } }).catch(() => {}); return }
      addBookmark(url, title)
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { success: true, action: 'add', url } } }).catch(() => {})
    } else if (action === 'remove') {
      if (!url) { if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'url required' } }).catch(() => {}); return }
      removeBookmark(url)
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { success: true, action: 'remove', url } } }).catch(() => {})
    } else if (action === 'list') {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { bookmarks: $bookmarks.get(), count: $bookmarks.get().length } } }).catch(() => {})
    } else {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'invalid action' } }).catch(() => {})
    }
  })

  // dev-browser.set-viewport — set a custom viewport size
  const d41 = host.onEvent('hermes-dev-browser.set-viewport', (event) => {
    const requestId = event?.payload?.request_id
    const width = event?.payload?.width
    const height = event?.payload?.height
    if (!width || !height) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'width and height required' } }).catch(() => {})
      return
    }
    const tabs = $tabs.get()
    const idx = $activeTabIndex.get()
    const tab = tabs[idx]
    if (!tab) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'no active tab' } }).catch(() => {})
      return
    }
    const wv = webviewRefs.get(tab.id)
    if (wv) {
      wv.style.width = width + 'px'
      wv.style.height = height + 'px'
    }
    if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: { success: true, width, height } } }).catch(() => {})
  })

  // dev-browser.get-element-info — get detailed info about an element by selector
  const d42 = host.onEvent('hermes-dev-browser.get-element-info', (event) => {
    const requestId = event?.payload?.request_id
    const selector = event?.payload?.selector
    if (!selector) {
      if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: 'selector required' } }).catch(() => {})
      return
    }
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
    const script = `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      var r = el.getBoundingClientRect();
      var attrs = {};
      for (var i = 0; i < el.attributes.length; i++) {
        attrs[el.attributes[i].name] = el.attributes[i].value;
      }
      return {
        tag: el.tagName,
        id: el.id || undefined,
        className: el.className || undefined,
        type: el.type || undefined,
        value: el.value || undefined,
        href: el.href || undefined,
        src: el.src || undefined,
        text: (el.textContent || '').trim().substring(0, 500),
        html: el.outerHTML.substring(0, 1000),
        attrs: attrs,
        rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
        visible: r.width > 0 && r.height > 0,
        disabled: el.disabled || false,
        checked: el.checked || undefined
      };
    })()`
    wv.executeJavaScript(script)
      .then((result) => {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result } }).catch(() => {})
      })
      .catch((error) => {
        if (requestId) ctx.rest('/result', { method: 'POST', body: { request_id: requestId, result: null, error: error instanceof Error ? error.message : String(error) } }).catch(() => {})
      })
  })

  _eventDisposers = [d1, d2, d3, d4, d5, d6, d7, d8, d9, d10, d11, d12, d13, d14, d15, d16, d17, d18, d19, d20, d21, d22, d23, d24, d25, d26, d27, d28, d29, d30, d31, d32, d33, d34, d35, d36, d37, d38, d39, d40, d41, d42]
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
              'group/tab flex items-center rounded-md py-1 text-xs cursor-pointer whitespace-nowrap transition-colors',
              tab.pinned ? 'px-0 gap-0 justify-center w-8 relative' : 'px-2 gap-1',
              tab.pinned
                ? 'border-b-2'
                : 'border-b-2 border-transparent'
            ),
            style: isActive
              ? { backgroundColor: 'rgb(59, 130, 246)', color: '#fff', borderBottomColor: 'rgb(59, 130, 246)' }
              : tab.pinned
                ? { color: 'rgb(150, 150, 150)', borderBottomColor: 'rgb(59, 130, 246)' }
                : { color: 'rgb(150, 150, 150)', borderBottomColor: 'transparent' },
            onMouseEnter: (e) => {
              if (!isActive) {
                e.currentTarget.style.backgroundColor = 'rgb(60, 60, 60)'
                e.currentTarget.style.color = '#fff'
              }
            },
            onMouseLeave: (e) => {
              if (!isActive) {
                e.currentTarget.style.backgroundColor = ''
                e.currentTarget.style.color = 'rgb(150, 150, 150)'
              }
            },
            onClick: () => {
              haptic('tap')
              setActiveTab(index)
            },
            onContextMenu: (e) => {
              e.preventDefault()
              haptic('tap')
              togglePinTab(index)
            },
            title: tab.pinned ? t('unpinTab') : t('pinTab'),
            children: [
              // Favicon (with Globe fallback). Spinner overrides while loading.
              tab.loading
                ? jsx(GlyphSpinner, { className: 'size-3 shrink-0' })
                : (function () {
                    var favUrl
                    try { favUrl = new URL(tab.url).origin + '/favicon.ico' } catch { favUrl = null }
                    return favUrl
                      ? jsx('img', { src: favUrl, className: 'size-3 shrink-0 rounded-sm', onError: function (e) { e.target.style.display = 'none'; var sib = e.target.nextElementSibling; if (sib) sib.style.display = '' } })
                      : null
                  })(),
              // Globe fallback (hidden if favicon loads)
              !tab.loading
                ? jsx(icons.Globe, { className: 'size-3 shrink-0 text-[var(--ui-text-tertiary)]', style: { display: 'none' } })
                : null,
              // Title + close button only for unpinned tabs
              !tab.pinned ? jsx('span', {
                className: 'max-w-[120px] truncate',
                children: tab.title || compactUrl(tab.url),
              }) : null,
              // Close button (only for unpinned tabs)
              !tab.pinned ? jsx('button', {
                    type: 'button',
                    className:
                      'ml-1 inline-flex h-4 w-4 items-center justify-center rounded-sm text-[var(--ui-text-tertiary)] hover:bg-[var(--ui-stroke-secondary)] hover:text-[var(--ui-text-primary)] transition-colors',
                    onClick: (e) => {
                      e.stopPropagation()
                      haptic('tap')
                      closeTab(index)
                    },
                    title: t('closeTab'),
                    'aria-label': t('closeTab'),
                    children: jsx(icons.X, { className: 'size-3' }),
                  }) : null,
              // Unpin button for pinned tabs (visible on hover, absolute so it doesn't shift the favicon)
              // Only responds to right-click (context menu) to avoid accidental unpin on left-click
              tab.pinned ? jsx('button', {
                    type: 'button',
                    className:
                      'absolute top-0 right-0 inline-flex h-4 w-4 items-center justify-center rounded-sm text-[var(--ui-text-tertiary)] hover:bg-[var(--ui-stroke-secondary)] hover:text-[var(--ui-text-primary)] transition-opacity opacity-0 group-hover/tab:opacity-100 pointer-events-none',
                    title: t('unpinTab'),
                    'aria-label': t('unpinTab'),
                    children: jsx(icons.X, { className: 'size-3' }),
                  }) : null,
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
    ],
  })
}

/** Bookmarks dropdown — appears below the bookmark button. */
function BookmarksMenu({ bookmarks, t }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return jsxs('div', {
    ref: ref,
    className: 'relative',
    children: [
      jsx(IconButton, {
        icon: 'Bookmark',
        label: t('bookmarks'),
        onClick: () => setOpen(!open),
        active: open,
      }),
      // Dropdown — below the button, aligned right
      open ? jsxs('div', {
        className: 'absolute top-full right-0 mt-1 w-72 max-h-80 flex flex-col shadow-2xl rounded-lg overflow-hidden',
        style: { backgroundColor: 'rgb(26, 26, 26)', border: '1px solid rgb(60, 60, 60)', zIndex: 9999 },
        children: [
          // Header
          jsxs('div', {
            className: 'flex items-center justify-between px-4 py-2.5',
            style: { borderBottom: '1px solid rgb(60, 60, 60)' },
            children: [
              jsx('span', { className: 'text-sm font-medium', style: { color: '#fff' }, children: t('bookmarks') }),
              jsx('button', {
                type: 'button',
                style: { color: 'rgb(150, 150, 150)' },
                onMouseEnter: function (e) { e.currentTarget.style.color = '#fff' },
                onMouseLeave: function (e) { e.currentTarget.style.color = 'rgb(150, 150, 150)' },
                onClick: () => setOpen(false),
                children: jsx(icons.X, { className: 'size-4' }),
              }),
            ],
          }),
          // List
          jsx('div', {
            className: 'flex-1 overflow-y-auto',
            children: bookmarks.length === 0
              ? jsx('div', { className: 'px-3 py-8 text-xs text-center', style: { color: 'rgb(100, 100, 100)' }, children: t('noBookmarks') })
              : bookmarks.map(function (bm) {
                  var favUrl
                  try { favUrl = new URL(bm.url).origin + '/favicon.ico' } catch { favUrl = null }
                  return jsxs('div', {
                    className: 'group/bm flex items-center gap-2 px-4 py-2 cursor-pointer text-xs transition-colors',
                    style: { color: 'rgb(200, 200, 200)' },
                    onMouseEnter: function (e) { e.currentTarget.style.backgroundColor = 'rgb(45, 45, 45)' },
                    onMouseLeave: function (e) { e.currentTarget.style.backgroundColor = '' },
                    onClick: () => {
                      addTab(bm.url)
                      setOpen(false)
                    },
                    children: [
                      favUrl
                        ? jsx('img', { src: favUrl, className: 'size-3.5 shrink-0 rounded-sm', onError: function (e) { e.target.style.display = 'none' } })
                        : jsx(icons.Globe, { className: 'size-3.5 shrink-0', style: { color: 'rgb(150, 150, 150)' } }),
                      jsx('span', { className: 'flex-1 truncate', children: bm.title || compactUrl(bm.url) }),
                      jsx('button', {
                        className: 'opacity-0 group-hover/bm:opacity-100 transition-opacity',
                        style: { color: 'rgb(100, 100, 100)' },
                        onMouseEnter: function (e) { e.currentTarget.style.color = '#fff' },
                        onClick: (e) => {
                          e.stopPropagation()
                          removeBookmark(bm.url)
                        },
                        children: jsx(icons.X, { className: 'size-3.5' }),
                      }),
                    ]
                  }, bm.url)
                }),
          }),
        ],
      }) : null,
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
  const deviceMode = useValue($deviceMode)
  const pickerActive = useValue($pickerActive)
  const incognitoMode = useValue($incognitoMode)
  const urlBarValue = useValue($urlBarValue)
  const history = useValue($urlHistory)
  const focusSignal = useValue($urlBarFocusSignal)
  const navState = useValue($navState)
  const bookmarks = useValue($bookmarks)

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
      // Bookmark toggle — filled accent when current URL is bookmarked
      jsx(IconButton, {
        icon: isBookmarked(urlBarValue) ? 'BookmarkFilled' : 'Bookmark',
        label: t('bookmark'),
        active: isBookmarked(urlBarValue),
        onClick: () => {
          haptic('tap')
          toggleBookmark(urlBarValue, activeTab ? activeTab.title : undefined)
        },
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
              : (function () {
                  var favUrl
                  try { favUrl = new URL(urlBarValue).origin + '/favicon.ico' } catch { favUrl = null }
                  return favUrl
                    ? jsx('div', {
                        className: 'absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none',
                        children: jsx('img', { src: favUrl, className: 'size-3.5 rounded-sm', onError: function (e) { e.target.style.display = 'none' } }),
                      })
                    : jsx('div', {
                        className:
                          'absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none',
                        children: jsx(icons.Globe, {
                          className: 'size-3.5 text-[var(--ui-text-tertiary)]',
                        }),
                      })
                })(),
          ],
        }),
      }),
      // Bookmarks dropdown — shows saved bookmarks, click to open in new tab
      jsx(BookmarksMenu, { bookmarks: bookmarks, t: t }),
      // Incognito toggle — when ON, new tabs use an ephemeral partition
      jsx(IconButton, {
        icon: incognitoMode ? 'EyeOff' : 'Eye',
        label: t('incognito'),
        active: incognitoMode,
        onClick: () => {
          const next = !$incognitoMode.get()
          $incognitoMode.set(next)
        },
      }),
      jsx(Separator, {
        orientation: 'vertical',
        className: 'h-5 mx-0.5',
      }),
      // Element picker — click to inspect, result copied to clipboard
      jsx(IconButton, {
        icon: 'ZoomIn',
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
      // Screenshot — capture page, copy PNG to clipboard
      jsx(IconButton, {
        icon: 'FileImage',
        label: 'Screenshot to clipboard',
        onClick: takeScreenshot,
      }),
      // Device mode dropdown
      jsx(DeviceModeDropdown, {
        mode: deviceMode,
        onChange: handleDeviceModeChange,
        t,
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
    const webview = createWebviewForTab(tab.id, tab.url, hostDiv, tab._partition)
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
            t,
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
    _pluginCtx = ctx

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
        pinTab: 'Right-click to pin',
        unpinTab: 'Click X to unpin',
        bookmark: 'Bookmark this page',
        bookmarks: 'Bookmarks',
        noBookmarks: 'No bookmarks yet',
        clearHistory: 'Clear History',
        deviceMode: 'Device Mode',
        network: 'Network',
        loading: 'Loading...',
        error: 'Failed to load',
        retry: 'Retry',
        noHistory: 'No history yet',
        incognito: 'Incognito',
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
        pinTab: 'Click derecho para fijar',
        unpinTab: 'Click la X para soltar',
        bookmark: 'Guardar esta página',
        bookmarks: 'Marcadores',
        noBookmarks: 'Sin marcadores aún',
        clearHistory: 'Limpiar historial',
        deviceMode: 'Modo dispositivo',
        network: 'Red',
        loading: 'Cargando...',
        error: 'Error al cargar',
        retry: 'Reintentar',
        noHistory: 'Sin historial',
        incognito: 'Incógnito',
      },
    })

    // Set up agent control events
    setupAgentEvents(ctx)

    // --- Pane registration ---
    ctx.register({
      id: 'pane',
      area: PANES_AREA,
      data: { placement: 'right', width: '480px', title: 'Dev Browser' },
      render: () => jsx(DevBrowserPane, {}),
    })

    // --- Palette commands ---
    ctx.registerMany([
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-dev-browser.open',
          label: 'Open Dev Browser',
          keywords: ['dev', 'browser', 'web', 'preview'],
          run: () => {
            host.navigate('/hermes-dev-browser')
          },
        },
      },
      {
        id: 'close',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-dev-browser.close',
          label: 'Close Dev Browser',
          keywords: ['dev', 'browser', 'close', 'hide'],
          run: () => {
            host.request('plugins.manage', {
              action: 'toggle',
              name: 'hermes-dev-browser',
              enable: false,
            }).catch(() => {})
          },
        },
      },
      {
        id: 'toggle-devtools',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-dev-browser.toggle-devtools',
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
          id: 'hermes-dev-browser.new-tab',
          label: 'Dev Browser: New Tab',
          keywords: ['dev', 'browser', 'tab', 'new'],
          run: () => addTab($homeUrl.get()),
        },
      },
      {
        id: 'clear-history',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-dev-browser.clear-history',
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
          id: 'hermes-dev-browser.pick-element',
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
          id: 'hermes-dev-browser.reload',
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
          id: 'hermes-dev-browser.toggle-devtools',
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
          id: 'hermes-dev-browser.focus-url',
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
