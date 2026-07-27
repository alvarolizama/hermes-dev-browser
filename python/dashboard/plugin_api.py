"""Dev Browser plugin — REST result mailbox.

The plugin JS (running in the renderer) POSTs results here after executing
browser operations (eval, screenshot). The Python tools poll for them either
via direct in-process import or HTTP GET against this router.

Mounted at ``/api/plugins/hermes-dev-browser/`` when the plugin is in
``plugins.enabled`` in config.yaml.
"""

from fastapi import APIRouter
from typing import Dict
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import threading

router = APIRouter()

# In-memory result mailbox: request_id -> {result, timestamp}
# Thread-safe so the tool's polling thread and FastAPI's async handlers
# can both touch it without races.
_results: Dict[str, dict] = {}
_results_lock = threading.Lock()


@router.post("/result")
async def set_result(body: dict):
    """Store a result from the plugin renderer (eval, screenshot, etc.)."""
    request_id = body.get("request_id", "")
    if not request_id:
        return {"error": "request_id required"}
    with _results_lock:
        _results[request_id] = {
            "result": body.get("result"),
            "timestamp": time.time(),
        }
    return {"ok": True}


@router.get("/result/{request_id}")
async def get_result(request_id: str):
    """Poll for a result. Returns ``{ready: false}`` if not ready yet.

    On success the entry is consumed (popped) so the mailbox stays clean.
    """
    with _results_lock:
        entry = _results.get(request_id)
        if entry is None:
            return {"ready": False}
        # Clean up — result is consumed on first read.
        _results.pop(request_id, None)
    return {"ready": True, "result": entry["result"]}


@router.get("/health")
async def health():
    """Health check — also useful for the tool to verify the mailbox is up."""
    with _results_lock:
        count = len(_results)
    return {"status": "ok", "results_pending": count}


@router.post("/copy-image")
async def copy_image(body: dict):
    """Write a PNG data URL to the system clipboard as a real image.

    The renderer's ``navigator.clipboard.write`` is always denied by Hermes'
    permission handler (only audio capture is granted), so image clipboard
    writes must happen outside the renderer. macOS: osascript «class PNGf».
    """
    data_url = body.get("data_url", "")
    prefix = "data:image/png;base64,"
    if not data_url.startswith(prefix):
        return {"ok": False, "error": "expected a PNG data URL"}

    try:
        png = base64.b64decode(data_url[len(prefix):], validate=True)
    except Exception:
        return {"ok": False, "error": "invalid base64 payload"}

    fd, path = tempfile.mkstemp(suffix=".png", prefix="hermes-dev-browser-")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(png)

        if sys.platform == "darwin":
            script = (
                "set the clipboard to (read (POSIX file %s) as «class PNGf»)"
                % json.dumps(path)
            )
            proc = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if proc.returncode != 0:
                return {"ok": False, "error": (proc.stderr or "osascript failed").strip()}
        else:
            return {"ok": False, "error": f"image clipboard copy not supported on {sys.platform}"}
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass

    return {"ok": True}
