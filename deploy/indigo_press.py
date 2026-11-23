#!/usr/bin/env python3
"""Every minute: what the HP Indigo 7900 is really doing, from Production Pro's press screen data.

  GET {PRESS}/prodflow/rest/devices/2                  -> the press status ("Printing" while it runs)
  GET {PRESS}/prodflow/rest/devices/2/jobs?list=pq     -> the press print queue; the "printing" job is on the press now

Writes /var/lib/sunnyland-production/indigo-press.json (root, group sunnyland-production, 0640): the printing job, the
next jobs loaded on the press, today's printing and stopped minutes, and a history of runs (start, end, copies, sheets,
paper) for real run times. Read-only towards Production Pro: GET requests only, nothing is ever changed there.
"""
import grp
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.request import ProxyHandler, Request, build_opener
from zoneinfo import ZoneInfo

PRESS = os.environ.get("INDIGO_PRODUCTION_CENTER", "http://192.168.0.12:8080").rstrip("/")
DEVICE = os.environ.get("INDIGO_PRESS_DEVICE", "2")
OUT = Path("/var/lib/sunnyland-production/indigo-press.json")
MEL = ZoneInfo("Australia/Melbourne")
MAX_REPLY = 4_000_000
HISTORY = 400
JOB = re.compile(r"^\s*J?(\d{6})(?:-(\d{1,2}))?([a-z])?(?=[\s_.\-]|$)", re.I)


def job_number(name):
    """'064248b VK The Mallee…' -> J064248 · 'J064489-01 …' -> J064489-01 · anything else -> None."""
    m = JOB.match(str(name or ""))
    if not m:
        return None
    return "J" + m[1] + ("-" + m[2].zfill(2) if m[2] else "")


def read_json(url, opener):
    with opener.open(Request(url, headers={"Accept": "application/json"}), timeout=15) as resp:
        raw = resp.read(MAX_REPLY + 1)
    if len(raw) > MAX_REPLY:
        raise ValueError("Press reply too large")
    return json.loads(raw)


def whole(value):
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def queue_rows(data):
    rows = []
    for j in data.get("Jobs") or []:
        p = j.get("properties") or {}
        rows.append({"position": whole(p.get("position")), "status": str(p.get("Job_StatusEN") or p.get("Job_Status") or "").lower(),
                     "name": str(p.get("Name") or "").strip()[:140], "job": job_number(p.get("Name")), "jobId": str(p.get("Job_Id") or ""),
                     "copies": whole(p.get("Copy_Range")), "sheets": whole(p.get("Sheets")),
                     "substrate": str(p.get("Substrate_Name") or "").split('"')[1] if '"' in str(p.get("Substrate_Name") or "") else str(p.get("Substrate_Name") or "")[:60],
                     "duplex": p.get("Duplex") == "Yes", "priority": p.get("Priority"), "received": p.get("Received_TimeEN")})
    rows.sort(key=lambda r: (r["position"] is None, r["position"] or 0))
    return rows


def advance(prev, status, queue, now):
    """New state from the previous one and this minute's reading: runs start/end, printing/stopped minutes add up."""
    day = now.astimezone(MEL).strftime("%Y-%m-%d")
    state = {"schema": 1, "generatedAt": now.isoformat(), "device": DEVICE, "ok": True, "reason": None,
             "press": {"status": status, "since": now.isoformat()}, "printing": None, "loaded": [],
             "today": {"day": day, "printingMinutes": 0, "stoppedMinutes": 0}, "history": list((prev or {}).get("history") or [])[-HISTORY:]}
    if prev and prev.get("press", {}).get("status") == status:
        state["press"]["since"] = prev["press"]["since"]
    if prev and prev.get("today", {}).get("day") == day:
        state["today"] = dict(prev["today"])
    # Minutes since the last reading go to "printing" or "stopped" (gaps over 5 minutes are not counted).
    if prev and prev.get("generatedAt"):
        gap = (now - datetime.fromisoformat(prev["generatedAt"])).total_seconds() / 60
        if 0 < gap <= 5 and prev.get("today", {}).get("day") == day:
            key = "printingMinutes" if prev.get("press", {}).get("status", "").lower() == "printing" else "stoppedMinutes"
            state["today"][key] = round(state["today"][key] + gap, 1)
    printing = next((r for r in queue if r["status"] == "printing"), None)
    was = (prev or {}).get("printing")
    if printing:
        same = was and was.get("jobId") == printing["jobId"]
        state["printing"] = {**printing, "since": was["since"] if same else now.isoformat()}
    if was and (not printing or was.get("jobId") != printing["jobId"]):
        start = datetime.fromisoformat(was["since"])
        state["history"].append({**{k: was.get(k) for k in ("jobId", "job", "name", "copies", "sheets", "substrate", "duplex")},
                                 "startedAt": was["since"], "endedAt": now.isoformat(), "minutes": round((now - start).total_seconds() / 60, 1)})
        state["history"] = state["history"][-HISTORY:]
    state["loaded"] = [r for r in queue if r["status"] != "printing"][:15]
    return state


def write(state):
    payload = json.dumps(state, separators=(",", ":"), allow_nan=False).encode()
    with tempfile.NamedTemporaryFile(dir=OUT.parent, prefix=".indigo-press-", delete=False) as out:
        temp = Path(out.name)
        try:
            os.fchown(out.fileno(), 0, grp.getgrnam("sunnyland-production").gr_gid); os.fchmod(out.fileno(), 0o640)
            out.write(payload); out.flush(); os.fsync(out.fileno()); os.replace(temp, OUT)
        finally:
            temp.unlink(missing_ok=True)


def main():
    now = datetime.now(timezone.utc)
    try:
        prev = json.loads(OUT.read_text())
    except (OSError, ValueError):
        prev = None
    opener = build_opener(ProxyHandler({}))
    try:
        device = read_json(f"{PRESS}/prodflow/rest/devices/{DEVICE}", opener)
        queue = queue_rows(read_json(f"{PRESS}/prodflow/rest/devices/{DEVICE}/jobs?list=pq", opener))
        status = str((device.get("properties") or {}).get("status") or "Unknown")
    except (OSError, ValueError) as error:
        if prev:
            prev.update(ok=False, reason="Production Pro press data could not be read (" + type(error).__name__ + ").", checkedAt=now.isoformat())
            write(prev)
        print("Indigo press: could not read Production Pro (" + type(error).__name__ + "). Previous reading kept.", file=sys.stderr)
        sys.exit(1)
    state = advance(prev, status, queue, now)
    write(state)
    p = state["printing"]
    print("Indigo press:", status, "·", f"printing {p['job'] or p['name'][:40]}" if p else "nothing printing", "·", len(queue), "in the press queue")


if __name__ == "__main__":
    main()
