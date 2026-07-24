"""Dev Browser plugin — REST result mailbox.

The plugin JS (running in the renderer) POSTs results here after executing
browser operations (eval, screenshot). The Python tools poll for them either
via direct in-process import or HTTP GET against this router.

Mounted at ``/api/plugins/hermes-dev-browser/`` when the plugin is in
``plugins.enabled`` in config.yaml.
"""

from fastapi import APIRouter
from typing import Dict
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
