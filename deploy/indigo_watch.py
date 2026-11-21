"""Every few minutes: which Indigo jobs are approved in Prinect Cockpit, which have reached the
Indigo queue (HP Production Pro, via the existing press observations), and whether both sources
are still answering. Reads local sources only (no printIQ calls). The production service turns
this into reminders and alerts."""
import json
import os
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import indigo_sources as src

WATCH = Path("/var/lib/sunnyland-production/indigo-watch.json")
# Approvals older than this are not reported; they have long since been planned or printed.
APPROVAL_DAYS = 21
# Queue entries without a usable job number are reported for this long.
UNMATCHED_HOURS = 24
# The press observation feed counts as down when its last success is older than this.
INDIGO_STALE_MINUTES = 10


def queue_state(entries, now):
    """Indigo queue by job number, plus recent entries that carry no usable job number."""
    queue, unmatched = {}, []
    for q, entry in entries:
        submitted = src.instant(entry.get("submissionTime"))
        job = src.jobno(entry.get("nativeJobId") or "")
        if job and entry.get("nativeJobId") not in ("000000", "J000000"):
            row = queue.setdefault(job, {"first": None, "last": None, "status": None, "entries": 0})
            row["entries"] += 1
            stamp = submitted.isoformat() if submitted else None
            if stamp and (row["first"] is None or stamp < row["first"]): row["first"] = stamp
            if stamp and (row["last"] is None or stamp >= row["last"]):
                row["last"] = stamp; row["status"] = entry.get("status")
        elif submitted and timedelta(0) <= now - submitted <= timedelta(hours=UNMATCHED_HOURS):
            unmatched.append({"queueEntryId": q, "submitted": submitted.isoformat(), "jobPartId": entry.get("jobPartId"),
                              "nativeJobId": entry.get("nativeJobId"), "status": entry.get("status")})
    return queue, unmatched


def indigo_health(snapshot, now):
    status = (snapshot or {}).get("sourceStatus") or {}
    last = src.instant(status.get("lastSuccessfulAt"))
    if status.get("state") != "connected":
        return {"ok": False, "lastSuccessfulAt": last.isoformat() if last else None, "reason": "The Indigo (HP Production Pro) connection is not connected."}
    if not last or now - last > timedelta(minutes=INDIGO_STALE_MINUTES):
        return {"ok": False, "lastSuccessfulAt": last.isoformat() if last else None, "reason": "The Indigo has not reported for over 10 minutes."}
    return {"ok": True, "lastSuccessfulAt": last.isoformat(), "reason": None}


def collect(now, read_journal=src.journal_source, state=src.STATE):
    try:
        approvals = src.approvals(read_journal, now)
        cockpit = {"ok": True, "reason": None}
    except (src.HistoryUnavailable, OSError, ValueError) as error:
        approvals = {}
        cockpit = {"ok": False, "reason": "Prinect Cockpit approvals could not be read. " + (str(error) if isinstance(error, src.HistoryUnavailable) else "")}
    recent = now - timedelta(days=APPROVAL_DAYS)
    approvals = {job: a for job, a in approvals.items()
                 if a.get("approvedAt") and src.instant(a["approvedAt"]) and src.instant(a["approvedAt"]) >= recent}
    try:
        with sqlite3.connect((state / "observations.sqlite3").as_uri() + "?mode=ro", uri=True) as db:
            entries = [(q, json.loads(raw)) for q, raw in db.execute("SELECT queue_id,entry_json FROM entries")]
        snapshot = json.loads((state / "status.json").read_text())
        queue, unmatched = queue_state(entries, now)
        indigo = indigo_health(snapshot, now)
    except (OSError, ValueError, sqlite3.Error):
        queue, unmatched = {}, []
        indigo = {"ok": False, "lastSuccessfulAt": None, "reason": "The Indigo queue observations could not be read on PrintCRM."}
    return {"schema": 1, "asOf": now.isoformat(), "generatedAt": datetime.now(timezone.utc).isoformat(),
            "approvals": approvals, "queue": queue, "unmatched": unmatched, "health": {"cockpit": cockpit, "indigo": indigo}}


def main():
    sys.path.insert(0, "/opt/sunnyland-printiq-requirements")
    import requirements_cache as cache
    watch = collect(datetime.now(timezone.utc))
    payload = json.dumps(watch, separators=(",", ":"), allow_nan=False).encode()
    if len(payload) > 8 * 1024 * 1024: raise ValueError("Watch snapshot exceeds bounds")
    with tempfile.NamedTemporaryFile(dir=WATCH.parent, prefix=".indigo-watch-", delete=False) as out:
        temp = Path(out.name)
        try:
            os.fchown(out.fileno(), 0, cache.runtime_read_group()); os.fchmod(out.fileno(), 0o640)
            out.write(payload); out.flush(); os.fsync(out.fileno()); os.replace(temp, WATCH)
        finally:
            temp.unlink(missing_ok=True)
    health = watch["health"]
    print("Indigo watch:", len(watch["approvals"]), "recent approvals,", len(watch["queue"]), "jobs in the Indigo queue,",
          len(watch["unmatched"]), "unnumbered entries.", "Cockpit OK." if health["cockpit"]["ok"] else health["cockpit"]["reason"],
          "Indigo OK." if health["indigo"]["ok"] else health["indigo"]["reason"])


if __name__ == "__main__":
    try: main()
    except Exception as error:
        print("Indigo watch failed (" + type(error).__name__ + "). Previous snapshot retained.", file=sys.stderr)
        sys.exit(1)
