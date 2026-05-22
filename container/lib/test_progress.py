"""Tests for container/lib/progress.py.

Run from the host with pytest available (e.g. via uv):

    cd container/lib && uv run --with pytest python -m pytest test_progress.py -v

The helper is stdlib-only; the test file uses pytest's tmp_path + monkeypatch
fixtures and bare assert statements.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest

from progress import _PROGRESS_DIR, progress


class FakeClock:
    """Deterministic monotonic clock for throttle / elapsed assertions."""

    def __init__(self) -> None:
        self.now = 0.0

    def advance(self, seconds: float) -> None:
        self.now += seconds

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def ipc_root(tmp_path: Path) -> Path:
    return tmp_path / "ipc"


@pytest.fixture
def progress_file(ipc_root: Path) -> Path:
    return ipc_root / _PROGRESS_DIR / "req-1.json"


def _read_event(path: Path) -> dict:
    return json.loads(path.read_text())


# --- happy path / lifecycle ---


def test_started_event_fires_on_enter(ipc_root: Path, progress_file: Path) -> None:
    clock = FakeClock()
    with progress(
        "veo",
        "req-1",
        chat_jid="slack:C1",
        ipc_root=ipc_root,
        _clock=clock,
    ):
        pass  # graceful exit, no terminal — context manager exit fires no event
    # __enter__ wrote the 'started' event.
    # __exit__ with no exception and no terminal leaves the file as-is.
    event = _read_event(progress_file)
    # The file's final state is the most-recent emit, which is 'started'.
    assert event["kind"] == "started"
    assert event["stage"] == "queued"
    assert event["chat_jid"] == "slack:C1"
    assert event["request_id"] == "req-1"
    assert event["elapsed_sec"] == 0.0


def test_done_emits_terminal_with_media_path(
    ipc_root: Path, progress_file: Path
) -> None:
    clock = FakeClock()
    with progress(
        "veo", "req-1", chat_jid="slack:C1", ipc_root=ipc_root, _clock=clock
    ) as p:
        clock.advance(10.0)
        p.update("rendering", elapsed_sec=10.0)
        clock.advance(5.0)
        p.done("/workspace/group/outbox/out.mp4")

    event = _read_event(progress_file)
    assert event["kind"] == "done"
    assert event["media_path"] == "/workspace/group/outbox/out.mp4"
    assert event["stage"] == "rendering"  # last known stage carries through


def test_fail_emits_terminal_with_reason_and_last_stage(
    ipc_root: Path, progress_file: Path
) -> None:
    clock = FakeClock()
    with progress(
        "veo", "req-1", chat_jid="slack:C1", ipc_root=ipc_root, _clock=clock
    ) as p:
        clock.advance(20.0)
        p.fail("quota exhausted", last_stage="rendering")

    event = _read_event(progress_file)
    assert event["kind"] == "failed"
    assert event["reason"] == "quota exhausted"
    assert event["stage"] == "rendering"


def test_model_id_included_when_provided(
    ipc_root: Path, progress_file: Path
) -> None:
    clock = FakeClock()
    with progress(
        "veo",
        "req-1",
        chat_jid="slack:C1",
        ipc_root=ipc_root,
        model_id="veo-3.1",
        _clock=clock,
    ):
        pass

    event = _read_event(progress_file)
    assert event["model_id"] == "veo-3.1"


def test_optional_fields_omitted_when_none(
    ipc_root: Path, progress_file: Path
) -> None:
    clock = FakeClock()
    with progress(
        "veo", "req-1", chat_jid="slack:C1", ipc_root=ipc_root, _clock=clock
    ) as p:
        clock.advance(5.0)
        p.update("rendering", elapsed_sec=5.0)

    event = _read_event(progress_file)
    # eta_sec, percent, next_stage were not supplied — must not appear.
    assert "eta_sec" not in event
    assert "percent" not in event
    assert "next_stage" not in event


def test_emitted_at_present_on_every_event(
    ipc_root: Path, progress_file: Path
) -> None:
    clock = FakeClock()
    with progress(
        "veo", "req-1", chat_jid="slack:C1", ipc_root=ipc_root, _clock=clock
    ) as p:
        clock.advance(10.0)
        p.update("rendering", elapsed_sec=10.0)

    event = _read_event(progress_file)
    assert "emitted_at" in event
    assert event["emitted_at"].endswith("+00:00") or event["emitted_at"].endswith("Z")


# --- throttling ---


def test_rapid_ticks_within_min_interval_are_suppressed(
    ipc_root: Path, progress_file: Path
) -> None:
    clock = FakeClock()
    with progress(
        "veo",
        "req-1",
        chat_jid="slack:C1",
        ipc_root=ipc_root,
        min_interval_sec=3.0,
        _clock=clock,
    ) as p:
        # started fires at t=0 (bypasses throttle)
        for elapsed in [0.1, 0.2, 0.5, 1.0, 1.5, 2.0, 2.5]:
            clock.advance(0.0)  # no real advance; ticks coalesce
            clock.now = elapsed
            p.update("rendering", elapsed_sec=elapsed)
    # File still reflects the started event — no tick made it through.
    event = _read_event(progress_file)
    assert event["kind"] == "started"


def test_tick_emitted_once_throttle_window_expires(
    ipc_root: Path, progress_file: Path
) -> None:
    clock = FakeClock()
    with progress(
        "veo",
        "req-1",
        chat_jid="slack:C1",
        ipc_root=ipc_root,
        min_interval_sec=3.0,
        _clock=clock,
    ) as p:
        clock.now = 4.0
        p.update("rendering", elapsed_sec=4.0)

    event = _read_event(progress_file)
    assert event["kind"] == "stage"  # first emit after 'queued' is a stage change
    assert event["stage"] == "rendering"
    assert event["elapsed_sec"] == 4.0


def test_stage_changes_also_throttled_collapse_to_last_wins(
    ipc_root: Path, progress_file: Path
) -> None:
    # P1 doc-review gap: stage transitions must not bypass the throttle.
    # queued→rendering→finalizing→uploading within 1s should NOT produce four
    # IPC files; the helper collapses to last-stage-wins on the next flush.
    clock = FakeClock()
    with progress(
        "veo",
        "req-1",
        chat_jid="slack:C1",
        ipc_root=ipc_root,
        min_interval_sec=3.0,
        _clock=clock,
    ) as p:
        clock.now = 0.1
        p.update("rendering", elapsed_sec=0.1)
        clock.now = 0.2
        p.update("finalizing", elapsed_sec=0.2)
        clock.now = 0.3
        p.update("uploading", elapsed_sec=0.3)
        # All three updates are within the 3s throttle window of the 'started'
        # event. The file still shows 'started'. No new event emitted yet.
    event = _read_event(progress_file)
    assert event["kind"] == "started"
    assert event["stage"] == "queued"


def test_late_update_after_throttle_emits_latest_pending_stage(
    ipc_root: Path, progress_file: Path
) -> None:
    # Update calls inside the throttle window remember the latest stage; the
    # next call past the window flushes that latest stage (not a stale one).
    clock = FakeClock()
    with progress(
        "veo",
        "req-1",
        chat_jid="slack:C1",
        ipc_root=ipc_root,
        min_interval_sec=3.0,
        _clock=clock,
    ) as p:
        clock.now = 0.1
        p.update("rendering", elapsed_sec=0.1)
        clock.now = 0.2
        p.update("finalizing", elapsed_sec=0.2)
        # First call past the throttle window — should emit with the LATEST
        # stage from this call (uploading), not a stale earlier one.
        clock.now = 5.0
        p.update("uploading", elapsed_sec=5.0)

    event = _read_event(progress_file)
    assert event["kind"] == "stage"
    assert event["stage"] == "uploading"
    assert event["elapsed_sec"] == 5.0


# --- atomic write ---


def test_atomic_write_no_partial_reads(
    ipc_root: Path, progress_file: Path
) -> None:
    # Spin a reader thread that aggressively reopens the file while the writer
    # emits many events. The reader must never observe a JSONDecodeError or
    # a half-written file.
    clock = FakeClock()
    stop = threading.Event()
    decode_errors: list[Exception] = []

    def reader() -> None:
        while not stop.is_set():
            try:
                if progress_file.exists():
                    json.loads(progress_file.read_text())
            except json.JSONDecodeError as exc:
                decode_errors.append(exc)

    t = threading.Thread(target=reader)
    t.start()
    try:
        with progress(
            "veo",
            "req-1",
            chat_jid="slack:C1",
            ipc_root=ipc_root,
            min_interval_sec=0.0,
            _clock=clock,
        ) as p:
            for i in range(50):
                clock.now = i * 1.0
                p.update("rendering", elapsed_sec=float(i))
    finally:
        stop.set()
        t.join(timeout=2.0)

    assert decode_errors == []


# --- terminal idempotency (P1 doc-review gap) ---


def test_update_after_done_is_noop(
    ipc_root: Path, progress_file: Path
) -> None:
    clock = FakeClock()
    with progress(
        "veo",
        "req-1",
        chat_jid="slack:C1",
        ipc_root=ipc_root,
        min_interval_sec=0.0,
        _clock=clock,
    ) as p:
        p.done("/workspace/group/outbox/out.mp4")
        # File now reflects kind='done'.
        # Subsequent update() must NOT overwrite the terminal state.
        clock.now = 100.0
        p.update("rendering", elapsed_sec=100.0)

    event = _read_event(progress_file)
    assert event["kind"] == "done"
    assert event["media_path"] == "/workspace/group/outbox/out.mp4"


def test_done_after_fail_is_noop(ipc_root: Path, progress_file: Path) -> None:
    clock = FakeClock()
    with progress(
        "veo",
        "req-1",
        chat_jid="slack:C1",
        ipc_root=ipc_root,
        min_interval_sec=0.0,
        _clock=clock,
    ) as p:
        p.fail("quota exhausted")
        p.done("/some/path.mp4")  # must not overwrite the failure

    event = _read_event(progress_file)
    assert event["kind"] == "failed"
    assert event["reason"] == "quota exhausted"


def test_double_done_is_noop(ipc_root: Path, progress_file: Path) -> None:
    clock = FakeClock()
    with progress(
        "veo",
        "req-1",
        chat_jid="slack:C1",
        ipc_root=ipc_root,
        min_interval_sec=0.0,
        _clock=clock,
    ) as p:
        p.done("/first.mp4")
        p.done("/second.mp4")  # no-op

    event = _read_event(progress_file)
    assert event["media_path"] == "/first.mp4"


# --- exception → failed (P1 doc-review gap) ---


def test_exception_emits_failed_when_no_terminal_yet(
    ipc_root: Path, progress_file: Path
) -> None:
    clock = FakeClock()
    with pytest.raises(RuntimeError, match="boom"):
        with progress(
            "veo",
            "req-1",
            chat_jid="slack:C1",
            ipc_root=ipc_root,
            min_interval_sec=0.0,
            _clock=clock,
        ) as p:
            clock.now = 5.0
            p.update("rendering", elapsed_sec=5.0)
            raise RuntimeError("boom")

    event = _read_event(progress_file)
    assert event["kind"] == "failed"
    assert "RuntimeError" in event["reason"]
    assert "boom" in event["reason"]


def test_exception_does_not_overwrite_prior_terminal(
    ipc_root: Path, progress_file: Path
) -> None:
    # If an explicit p.done() / p.fail() fired before an exception propagates,
    # __exit__ must NOT clobber the terminal state with a synthetic 'failed'.
    clock = FakeClock()
    with pytest.raises(RuntimeError, match="late boom"):
        with progress(
            "veo",
            "req-1",
            chat_jid="slack:C1",
            ipc_root=ipc_root,
            min_interval_sec=0.0,
            _clock=clock,
        ) as p:
            p.done("/workspace/group/outbox/out.mp4")
            raise RuntimeError("late boom")

    event = _read_event(progress_file)
    assert event["kind"] == "done"
    assert event["media_path"] == "/workspace/group/outbox/out.mp4"


def test_clean_exit_with_no_terminal_emits_no_failed(
    ipc_root: Path, progress_file: Path
) -> None:
    clock = FakeClock()
    with progress(
        "veo",
        "req-1",
        chat_jid="slack:C1",
        ipc_root=ipc_root,
        min_interval_sec=0.0,
        _clock=clock,
    ) as p:
        clock.now = 5.0
        p.update("rendering", elapsed_sec=5.0)
        # Clean exit, no done/fail/exception — leaves the latest emit on disk.

    event = _read_event(progress_file)
    assert event["kind"] in ("stage", "started")  # whichever the throttle let through


# --- env / args ---


def test_chat_jid_falls_back_to_env(
    ipc_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("NANOCLAW_CHAT_JID", "slack:CENV")
    clock = FakeClock()
    with progress(
        "veo", "req-1", ipc_root=ipc_root, _clock=clock
    ):  # no chat_jid kwarg
        pass

    event = _read_event(ipc_root / _PROGRESS_DIR / "req-1.json")
    assert event["chat_jid"] == "slack:CENV"


def test_missing_chat_jid_raises(
    ipc_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("NANOCLAW_CHAT_JID", raising=False)
    clock = FakeClock()
    with pytest.raises(RuntimeError, match="NANOCLAW_CHAT_JID"):
        with progress("veo", "req-1", ipc_root=ipc_root, _clock=clock):
            pass


def test_invalid_request_id_rejected(ipc_root: Path) -> None:
    clock = FakeClock()
    # Path-traversal request_ids must be rejected so the helper can't write
    # outside its progress/ subdirectory.
    for bad in ["../escape", "a/b", "..", "with space", "a\x00b"]:
        with pytest.raises(ValueError, match="request_id"):
            progress(
                "veo",
                bad,
                chat_jid="slack:C1",
                ipc_root=ipc_root,
                _clock=clock,
            )


def test_ipc_root_directory_created_on_first_emit(
    ipc_root: Path, progress_file: Path
) -> None:
    # ipc_root may not exist when the producer starts; the helper must mkdir.
    assert not ipc_root.exists()
    clock = FakeClock()
    with progress(
        "veo", "req-1", chat_jid="slack:C1", ipc_root=ipc_root, _clock=clock
    ):
        pass
    assert progress_file.exists()
