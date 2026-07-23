"""Dev Browser plugin — REST result mailbox.

The plugin JS (running in the renderer) POSTs results here after executing
browser operations (eval, screenshot). The Python tools read them from the
filesystem to avoid cross-process auth issues with the dashboard.

Mounted at ``/api/plugins/dev-browser/`` when the plugin is in
``plugins.enabled`` in config.yaml.
"""

from fastapi import APIRouter
from typing import Dict
import json
import os
import tempfile
import time

router = APIRouter()

# File-based mailbox: each result is written to a temp file so the agent
# tool (running in a different process) can read it without HTTP auth.
_MAILBOX_DIR = os.path.join(tempfile.gettempdir(), "dev-browser-mailbox")
os.makedirs(_MAILBOX_DIR, exist_ok=True)

# In-memory mirror (still works if tool runs in the same process)
_results: Dict[str, dict] = {}

# Result TTL in seconds (clean up stale entries)
_TTL_S = 120


def _mailbox_path(request_id: str) -> str:
    """Return the file path for a result."""
    return os.path.join(_MAILBOX_DIR, f"{request_id}.json")


def _cleanup_stale():
    """Remove result files older than TTL."""
    now = time.time()
    try:
        for fname in os.listdir(_MAILBOX_DIR):
            if not fname.endswith(".json"):
                continue
            fpath = os.path.join(_MAILBOX_DIR, fname)
            if os.path.getmtime(fpath) < now - _TTL_S:
                os.unlink(fpath)
    except OSError:
        pass


@router.post("/result")
async def set_result(body: dict):
    """Store a result from the plugin renderer (eval, screenshot, etc.).

    Writes to both the in-memory dict (fast path) and a file (cross-process).
    """
    request_id = body.get("request_id", "")
    if not request_id:
        return {"error": "request_id required"}
    entry = {
        "result": body.get("result"),
        "timestamp": time.time(),
    }
    # In-memory (same-process fast path)
    _results[request_id] = entry
    # File-based (cross-process path)
    try:
        with open(_mailbox_path(request_id), "w") as f:
            json.dump({"ready": True, "result": entry["result"]}, f)
    except OSError:
        pass
    # Opportunistic cleanup
    _cleanup_stale()
    return {"ok": True}


@router.get("/result/{request_id}")
async def get_result(request_id: str):
    """Poll for a result. Returns ``{ready: false}`` if not ready yet.

    On success the entry is consumed (file deleted) so the mailbox stays clean.
    """
    # Try in-memory first (same process)
    entry = _results.get(request_id)
    if entry is not None:
        _results.pop(request_id, None)
        return {"ready": True, "result": entry["result"]}
    # Try file-based (cross-process)
    fpath = _mailbox_path(request_id)
    try:
        with open(fpath, "r") as f:
            data = json.load(f)
        os.unlink(fpath)  # Consume
        return data
    except (OSError, json.JSONDecodeError):
        return {"ready": False}


@router.get("/health")
async def health():
    """Health check — also useful for the tool to verify the mailbox is up."""
    return {"status": "ok", "results_pending": len(_results)}
