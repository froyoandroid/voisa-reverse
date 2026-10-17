"""voisa.log: one line per event, tagged by client session, trimmed to a day."""
import os, threading, time

from voisa_server.config import LOG_FILE, LOG_MAX_AGE_S

_log_lock = threading.Lock()


_log_trimmed = 0.0


def logfile(msg: str, level: str = "sys", cid: str = "") -> None:
    """Append one line to voisa.log. Never raises — logging must not break a call.

    `cid` identifies the client session. Several tabs (or a second browser) can
    be connected at once and each mirrors its own view of events, so without the
    tag the file looks like everything happened twice.
    """
    try:
        tag = f"({cid})" if cid else "(--)"
        with _log_lock:
            _trim_log()
            with open(LOG_FILE, "a", encoding="utf-8") as f:
                f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {tag} [{level}] {msg}\n")
    except Exception:
        pass


def _trim_log() -> None:
    """Drop lines older than LOG_MAX_AGE_S. Caller holds _log_lock.

    Checked at most once a minute, so the read is amortised across writes rather
    than done per line. The file is rewritten only when something is actually
    dropped, and the rewrite is atomic so a crash cannot lose the whole log.
    """
    global _log_trimmed
    now = time.time()
    if now - _log_trimmed < 60:
        return
    _log_trimmed = now
    try:
        cutoff = now - LOG_MAX_AGE_S
        with open(LOG_FILE, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        keep = []
        for ln in lines:
            # "2026-10-13 21:16:35 (ab12) [sys] ..."
            try:
                ts = time.mktime(time.strptime(ln[:19], "%Y-%m-%d %H:%M:%S"))
            except Exception:
                keep.append(ln)      # unparseable: keep rather than discard
                continue
            if ts >= cutoff:
                keep.append(ln)
        if len(keep) != len(lines):
            tmp = LOG_FILE + ".trim"
            with open(tmp, "w", encoding="utf-8") as f:
                f.writelines(keep)
            os.replace(tmp, LOG_FILE)
    except FileNotFoundError:
        pass
    except Exception:
        pass
