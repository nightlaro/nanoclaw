"""Producer-side progress emission for NanoClaw's video-progress layer.

A video-generation script adopts the layer in two lines:

    from progress import progress

    with progress("veo", request_id, model_id="veo-3.1") as p:
        # ... poll loop ...
        p.update("rendering", elapsed_sec=elapsed)
        # ...
        p.done(output_path)

The helper writes one JSON event per emission to
`<ipc_root>/progress/<request_id>.json`, atomically (temp + rename).
The orchestrator polls that directory at 1Hz and routes the events to
the channel (Slack chat.update, Telegram editMessageText, etc.) — see
`src/router.ts::routeProgressNotice` and `src/ipc.ts::processProgressIpcFile`.

Design notes
- Latest-wins: each emission overwrites the same file. The orchestrator
  reads the latest state; older events are not retained on disk.
- Throttle: `min_interval_sec` (default 3.0 — Slack chat.update's per-message
  floor). The throttle applies uniformly, including across stage transitions:
  a fast queued→rendering→finalizing→uploading burst collapses to the most
  recent stage on the next allowed flush.
- Idempotent terminal: after p.done() or p.fail(), subsequent update/done/fail
  calls are no-ops. __exit__ emits 'failed' only when an exception propagated
  AND no terminal already fired.
- chat_jid: defaults to os.environ["NANOCLAW_CHAT_JID"] (mirrors the agent
  runner's MCP env). Tests can pass chat_jid= explicitly.
- Atomic write: write to `<file>.tmp` then `os.replace(tmp, final)` (POSIX rename).
- Stdlib only. The helper must be trivially importable from any producer
  script without resolving a uv dependency graph for it.
"""

from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from types import TracebackType
from typing import Any, Callable, Optional

_DEFAULT_IPC_ROOT = Path("/workspace/ipc")
_DEFAULT_MIN_INTERVAL_SEC = 3.0
_PROGRESS_DIR = "progress"

# request_id must be a safe path component (no /, .., spaces, NULs, etc.) so
# the helper cannot write outside <ipc_root>/progress/ by construction.
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_\-]+$")


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class _ProgressContext:
    """The object returned by `progress(...)`. Use as a context manager."""

    def __init__(
        self,
        *,
        producer: str,
        request_id: str,
        chat_jid: str,
        ipc_root: Path,
        model_id: Optional[str],
        min_interval_sec: float,
        total_seconds_estimate: Optional[float],
        clock: Callable[[], float],
    ) -> None:
        self._producer = producer
        self._request_id = request_id
        self._chat_jid = chat_jid
        self._ipc_root = Path(ipc_root)
        self._model_id = model_id
        self._min_interval_sec = float(min_interval_sec)
        self._total_seconds_estimate = total_seconds_estimate
        self._clock = clock

        self._dir = self._ipc_root / _PROGRESS_DIR
        self._path = self._dir / f"{request_id}.json"

        self._last_emit_at: float = float("-inf")
        self._last_emitted_stage: Optional[str] = None
        self._started_at: float = 0.0
        self._terminal: bool = False

        # Pending state from rapid update() calls within the throttle window.
        self._pending_stage: Optional[str] = None
        self._pending_kwargs: dict[str, Any] = {}

    # --- public API ---

    def update(
        self,
        stage: str,
        *,
        elapsed_sec: Optional[float] = None,
        eta_sec: Optional[float] = None,
        percent: Optional[float] = None,
        next_stage: Optional[str] = None,
    ) -> None:
        if self._terminal:
            # Post-terminal updates are explicit no-ops so a producer that
            # keeps looping after p.done() / p.fail() cannot corrupt the
            # terminal state already observed by the orchestrator.
            return

        now = self._clock()

        # Always update pending state — the latest call's stage and kwargs
        # win on the next allowed flush.
        self._pending_stage = stage
        self._pending_kwargs = {
            "elapsed_sec": elapsed_sec,
            "eta_sec": eta_sec,
            "percent": percent,
            "next_stage": next_stage,
        }

        if now - self._last_emit_at >= self._min_interval_sec:
            self._flush_pending(now)

    def done(self, media_path: str) -> None:
        if self._terminal:
            return
        elapsed = self._clock() - self._started_at
        stage = (
            self._pending_stage
            or self._last_emitted_stage
            or "uploading"
        )
        self._emit(
            kind="done",
            stage=stage,
            elapsed_sec=elapsed,
            media_path=str(media_path),
        )
        self._terminal = True

    def fail(self, reason: str, last_stage: Optional[str] = None) -> None:
        if self._terminal:
            return
        elapsed = self._clock() - self._started_at
        stage = (
            last_stage
            or self._pending_stage
            or self._last_emitted_stage
            or "unknown"
        )
        self._emit(
            kind="failed",
            stage=stage,
            elapsed_sec=elapsed,
            reason=reason,
        )
        self._terminal = True

    # --- context-manager protocol ---

    def __enter__(self) -> "_ProgressContext":
        self._started_at = self._clock()
        # 'started' event bypasses throttle so the orchestrator sees the
        # initial anchor render as soon as the producer begins work.
        self._emit(kind="started", stage="queued", elapsed_sec=0.0)
        self._last_emitted_stage = "queued"
        self._last_emit_at = self._clock()
        return self

    def __exit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc: Optional[BaseException],
        tb: Optional[TracebackType],
    ) -> bool:
        # Synthetic 'failed' only when an exception propagated AND no
        # terminal already fired. A prior explicit p.done() or p.fail()
        # wins; __exit__ must not clobber it.
        if exc_type is not None and not self._terminal:
            elapsed = self._clock() - self._started_at
            if exc is not None:
                reason = f"{exc_type.__name__}: {exc}"
            else:
                reason = exc_type.__name__
            self._emit(
                kind="failed",
                stage=self._last_emitted_stage or "unknown",
                elapsed_sec=elapsed,
                reason=reason,
            )
            self._terminal = True
        return False  # never swallow exceptions

    # --- internals ---

    def _flush_pending(self, now: float) -> None:
        if self._pending_stage is None:
            return
        kind = (
            "stage"
            if self._pending_stage != self._last_emitted_stage
            else "tick"
        )
        fields: dict[str, Any] = {
            k: v for k, v in self._pending_kwargs.items() if v is not None
        }
        self._emit(kind=kind, stage=self._pending_stage, **fields)
        self._last_emitted_stage = self._pending_stage
        self._last_emit_at = now
        self._pending_stage = None
        self._pending_kwargs = {}

    def _emit(self, *, kind: str, stage: str, **fields: Any) -> None:
        event: dict[str, Any] = {
            "request_id": self._request_id,
            "chat_jid": self._chat_jid,
            "kind": kind,
            "stage": stage,
            "emitted_at": _utcnow_iso(),
        }
        if self._model_id:
            event["model_id"] = self._model_id
        for k, v in fields.items():
            if v is not None:
                event[k] = v

        self._dir.mkdir(parents=True, exist_ok=True)
        tmp_path = self._path.with_name(self._path.name + ".tmp")
        tmp_path.write_text(json.dumps(event))
        # os.replace is POSIX-atomic on Linux (the container OS); the
        # orchestrator's poll-based reader sees either the old or the new
        # content, never a half-written file.
        os.replace(tmp_path, self._path)


def progress(
    producer: str,
    request_id: str,
    *,
    chat_jid: Optional[str] = None,
    ipc_root: Optional[Path] = None,
    model_id: Optional[str] = None,
    min_interval_sec: float = _DEFAULT_MIN_INTERVAL_SEC,
    total_seconds_estimate: Optional[float] = None,
    _clock: Optional[Callable[[], float]] = None,
) -> _ProgressContext:
    """Create a progress context for one video-generation request.

    Args:
        producer: Short name of the producer (e.g. "veo", "omni"). Carried in
            the event for operator observability; the orchestrator does not
            branch on it.
        request_id: A stable, per-invocation identifier. Veo generates a
            uuid4 when none is passed via --request-id. Must match
            ``^[A-Za-z0-9_-]+$`` so it can be used as a path component.
        chat_jid: The chat the producer is rendering for. Falls back to
            ``os.environ["NANOCLAW_CHAT_JID"]``; raises if both are missing.
        ipc_root: Override for the IPC mount. Defaults to ``/workspace/ipc``.
        model_id: Optional model tag (e.g. "veo-3.1") carried in events.
        min_interval_sec: Throttle floor between emissions for a single
            request. Default 3.0s matches Slack's per-message chat.update
            floor. Applies uniformly across ticks and stage transitions.
        total_seconds_estimate: Optional hint for the orchestrator's
            renderer; not load-bearing.
        _clock: Test-only injection point for a deterministic monotonic
            clock. Production code uses ``time.monotonic``.
    """
    if not _REQUEST_ID_RE.match(request_id):
        raise ValueError(
            f"Invalid request_id {request_id!r}: must match {_REQUEST_ID_RE.pattern}"
        )

    if chat_jid is None:
        env_jid = os.environ.get("NANOCLAW_CHAT_JID")
        if not env_jid:
            raise RuntimeError(
                "NANOCLAW_CHAT_JID environment variable is not set; "
                "pass chat_jid= explicitly or run inside an agent container."
            )
        chat_jid = env_jid

    resolved_ipc_root = Path(ipc_root) if ipc_root is not None else _DEFAULT_IPC_ROOT
    clock = _clock if _clock is not None else time.monotonic

    return _ProgressContext(
        producer=producer,
        request_id=request_id,
        chat_jid=chat_jid,
        ipc_root=resolved_ipc_root,
        model_id=model_id,
        min_interval_sec=min_interval_sec,
        total_seconds_estimate=total_seconds_estimate,
        clock=clock,
    )


__all__ = ["progress", "_PROGRESS_DIR"]
