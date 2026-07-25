"""hermes-dev-browser plugin — 41 agent-controlled browser automation tools.

Tools are registered into the ``terminal`` toolset so they're available
wherever the desktop app runs. Each tool is gated on HERMES_DESKTOP
via check_fn — they only appear when the desktop GUI is active.

Tool implementations live in ``tools.py``. Imports use relative paths
(``from .tools import ...``) so the module loads correctly under the
``hermes_plugins.<slug>`` namespace that Hermes' plugin loader creates.
"""

from __future__ import annotations

from .tools import (
    # Original 21 tools
    dev_browser_navigate,
    dev_browser_eval,
    dev_browser_screenshot,
    dev_browser_list_tabs,
    dev_browser_new_tab,
    dev_browser_close_tab,
    dev_browser_switch_tab,
    dev_browser_get_url,
    dev_browser_get_console,
    dev_browser_clear_console,
    dev_browser_get_network,
    dev_browser_set_device_mode,
    dev_browser_clear_cache,
    dev_browser_clear_cookies,
    dev_browser_pick_element,
    dev_browser_mouse_move,
    dev_browser_click,
    dev_browser_type,
    dev_browser_press_key,
    dev_browser_scroll,
    dev_browser_drag,
    # 20 new automation tools
    dev_browser_wait_for_selector,
    dev_browser_get_page_text,
    dev_browser_get_dom_snapshot,
    dev_browser_fill_form,
    dev_browser_wait_for_navigation,
    dev_browser_hover,
    dev_browser_select_option,
    dev_browser_press_key_combo,
    dev_browser_upload_file,
    dev_browser_handle_dialog,
    dev_browser_get_cookies,
    dev_browser_get_local_storage,
    dev_browser_get_computed_style,
    dev_browser_intercept_network,
    dev_browser_screenshot_element,
    dev_browser_execute_script,
    dev_browser_pdf_export,
    dev_browser_bookmark_management,
    dev_browser_set_viewport,
    dev_browser_get_element_info,
    # Schemas
    NAVIGATE_SCHEMA, EVAL_SCHEMA, SCREENSHOT_SCHEMA,
    LIST_TABS_SCHEMA, NEW_TAB_SCHEMA, CLOSE_TAB_SCHEMA,
    SWITCH_TAB_SCHEMA, GET_URL_SCHEMA, GET_CONSOLE_SCHEMA,
    CLEAR_CONSOLE_SCHEMA, GET_NETWORK_SCHEMA, SET_DEVICE_MODE_SCHEMA,
    CLEAR_CACHE_SCHEMA, CLEAR_COOKIES_SCHEMA, PICK_ELEMENT_SCHEMA,
    MOUSE_MOVE_SCHEMA, CLICK_SCHEMA, TYPE_SCHEMA,
    PRESS_KEY_SCHEMA, SCROLL_SCHEMA, DRAG_SCHEMA,
    WAIT_FOR_SELECTOR_SCHEMA, GET_PAGE_TEXT_SCHEMA, GET_DOM_SNAPSHOT_SCHEMA,
    FILL_FORM_SCHEMA, WAIT_FOR_NAVIGATION_SCHEMA, HOVER_SCHEMA,
    SELECT_OPTION_SCHEMA, PRESS_KEY_COMBO_SCHEMA, UPLOAD_FILE_SCHEMA,
    HANDLE_DIALOG_SCHEMA, GET_COOKIES_SCHEMA, GET_LOCAL_STORAGE_SCHEMA,
    GET_COMPUTED_STYLE_SCHEMA, INTERCEPT_NETWORK_SCHEMA, SCREENSHOT_ELEMENT_SCHEMA,
    EXECUTE_SCRIPT_SCHEMA, PDF_EXPORT_SCHEMA, BOOKMARK_MANAGEMENT_SCHEMA,
    SET_VIEWPORT_SCHEMA, GET_ELEMENT_INFO_SCHEMA,
    # Requirements check
    check_dev_browser_requirements,
)

_TOOLS = (
    # Original 21 tools
    ("dev_browser_navigate",       NAVIGATE_SCHEMA,       dev_browser_navigate,       "🌐"),
    ("dev_browser_eval",           EVAL_SCHEMA,           dev_browser_eval,           "⚡"),
    ("dev_browser_screenshot",     SCREENSHOT_SCHEMA,     dev_browser_screenshot,     "📸"),
    ("dev_browser_list_tabs",      LIST_TABS_SCHEMA,      dev_browser_list_tabs,      "📋"),
    ("dev_browser_new_tab",        NEW_TAB_SCHEMA,        dev_browser_new_tab,        "🗂️"),
    ("dev_browser_close_tab",      CLOSE_TAB_SCHEMA,      dev_browser_close_tab,      "❌"),
    ("dev_browser_switch_tab",     SWITCH_TAB_SCHEMA,     dev_browser_switch_tab,     "🔄"),
    ("dev_browser_get_url",        GET_URL_SCHEMA,        dev_browser_get_url,        "🔗"),
    ("dev_browser_get_console",    GET_CONSOLE_SCHEMA,    dev_browser_get_console,    "📟"),
    ("dev_browser_clear_console",  CLEAR_CONSOLE_SCHEMA,  dev_browser_clear_console,  "🧹"),
    ("dev_browser_get_network",    GET_NETWORK_SCHEMA,    dev_browser_get_network,    "📡"),
    ("dev_browser_set_device_mode", SET_DEVICE_MODE_SCHEMA, dev_browser_set_device_mode, "📱"),
    ("dev_browser_clear_cache",    CLEAR_CACHE_SCHEMA,    dev_browser_clear_cache,    "🗑️"),
    ("dev_browser_clear_cookies",  CLEAR_COOKIES_SCHEMA,  dev_browser_clear_cookies,  "🍪"),
    ("dev_browser_pick_element",   PICK_ELEMENT_SCHEMA,   dev_browser_pick_element,   "🎯"),
    ("dev_browser_mouse_move",     MOUSE_MOVE_SCHEMA,     dev_browser_mouse_move,     "🖱️"),
    ("dev_browser_click",          CLICK_SCHEMA,          dev_browser_click,          "👆"),
    ("dev_browser_type",           TYPE_SCHEMA,           dev_browser_type,           "⌨️"),
    ("dev_browser_press_key",      PRESS_KEY_SCHEMA,      dev_browser_press_key,      "🔑"),
    ("dev_browser_scroll",         SCROLL_SCHEMA,         dev_browser_scroll,         "📜"),
    ("dev_browser_drag",           DRAG_SCHEMA,           dev_browser_drag,           "✋"),
    # 20 new automation tools
    ("dev_browser_wait_for_selector",  WAIT_FOR_SELECTOR_SCHEMA,  dev_browser_wait_for_selector,  "⏳"),
    ("dev_browser_get_page_text",     GET_PAGE_TEXT_SCHEMA,      dev_browser_get_page_text,     "📄"),
    ("dev_browser_get_dom_snapshot",  GET_DOM_SNAPSHOT_SCHEMA,    dev_browser_get_dom_snapshot,  "🌳"),
    ("dev_browser_fill_form",         FILL_FORM_SCHEMA,           dev_browser_fill_form,         "📝"),
    ("dev_browser_wait_for_navigation", WAIT_FOR_NAVIGATION_SCHEMA, dev_browser_wait_for_navigation, "⏱️"),
    ("dev_browser_hover",             HOVER_SCHEMA,               dev_browser_hover,             "🖱️"),
    ("dev_browser_select_option",     SELECT_OPTION_SCHEMA,       dev_browser_select_option,     "📋"),
    ("dev_browser_press_key_combo",   PRESS_KEY_COMBO_SCHEMA,     dev_browser_press_key_combo,   "⌨️"),
    ("dev_browser_upload_file",       UPLOAD_FILE_SCHEMA,         dev_browser_upload_file,       "📎"),
    ("dev_browser_handle_dialog",     HANDLE_DIALOG_SCHEMA,       dev_browser_handle_dialog,     "💬"),
    ("dev_browser_get_cookies",       GET_COOKIES_SCHEMA,         dev_browser_get_cookies,       "🍪"),
    ("dev_browser_get_local_storage", GET_LOCAL_STORAGE_SCHEMA,   dev_browser_get_local_storage, "💾"),
    ("dev_browser_get_computed_style", GET_COMPUTED_STYLE_SCHEMA, dev_browser_get_computed_style, "🎨"),
    ("dev_browser_intercept_network", INTERCEPT_NETWORK_SCHEMA,   dev_browser_intercept_network, "📡"),
    ("dev_browser_screenshot_element", SCREENSHOT_ELEMENT_SCHEMA,  dev_browser_screenshot_element, "📸"),
    ("dev_browser_execute_script",    EXECUTE_SCRIPT_SCHEMA,      dev_browser_execute_script,    "📜"),
    ("dev_browser_pdf_export",         PDF_EXPORT_SCHEMA,          dev_browser_pdf_export,        "📄"),
    ("dev_browser_bookmark_management", BOOKMARK_MANAGEMENT_SCHEMA, dev_browser_bookmark_management, "🔖"),
    ("dev_browser_set_viewport",       SET_VIEWPORT_SCHEMA,        dev_browser_set_viewport,      "📐"),
    ("dev_browser_get_element_info",   GET_ELEMENT_INFO_SCHEMA,    dev_browser_get_element_info,  "🔍"),
)


def register(ctx) -> None:
    """Register all Dev Browser tools. Called once by the plugin loader."""
    for name, schema, handler, emoji in _TOOLS:
        ctx.register_tool(
            name=name,
            toolset="terminal",
            schema=schema,
            handler=handler,
            check_fn=check_dev_browser_requirements,
            emoji=emoji,
        )
