"""Every 10 minutes: what the Indigo actually printed, joined to Prinect Cockpit's imposition and printIQ's routing.

For each Indigo queue entry that HP Production Pro reports as Completed in the last few weeks:
  - Production Center press ticket (returnJDFTicket): the sheets that went through the press, per paper,
    and the count per colour separation (a cross-check on the number of printed sides).
  - Prinect Cockpit job folder on PPMS (PTJobs/Jobs/<day>/<job>/RendererReports/*/D7_<queue ID>_in.jdf):
    the imposition Cockpit sent - copies of each page per sheet (number-up), sheets per set, sides, paper.
    Cockpit usually asks for 1 copy; the operator sets the real run at the press, so copies asked are not used.
  - printIQ accepted routing: product quantity, and every Printing section with its press and operation key.

Read-only on every source. The production service decides proof / part printed / printed / needs confirming,
and is the only part that can write to printIQ (see indigo-printed.mjs)."""
import json
import math
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.request import ProxyHandler, Request, build_opener

sys.path.insert(0, str(Path(__file__).resolve().parent))
import indigo_sources as src

OUT = Path("/var/lib/sunnyland-production/indigo-printed.json")
CACHE = Path("/var/lib/sunnyland-production/indigo-printed-cache.json")
CENTER = os.environ.get("INDIGO_PRODUCTION_CENTER", "http://192.168.0.12:8080").rstrip("/")
SHARE = os.environ.get("INDIGO_PTJOBS_SHARE", "//PPMS/PTJobs")
AUTH = Path("/etc/sunnyland-production/indigo-ppms.smb")
LOOKBACK_DAYS = 10
# Cockpit files a job under the day it was created; look this far back from the press submission.
FOLDER_DAYS = 45
# A missing imposition is looked for again after this long, and given up after GIVE_UP_DAYS.
RETRY_HOURS = 2
GIVE_UP_DAYS = 3
ACCEPTANCE_MINUTES = 30
# Each run stops starting new press-ticket and Prinect reads after this long; the rest wait for the next run.
BUDGET_SECONDS = int(os.environ.get("INDIGO_PRINTED_BUDGET", "240"))
QID = re.compile(r"[0-9a-f]{32}")
MAX_TICKET = 8 * 1024 * 1024


def local(tag):
    return tag.rsplit("}", 1)[-1]


def attr(element, name):
    """Attribute by local name (Heidelberg writes some with an HDM: prefix)."""
    for key, value in element.attrib.items():
        if local(key) == name:
            return value
    return None


def whole(text):
    try:
        value = float(text)
    except (TypeError, ValueError):
        return None
    return int(value) if value >= 0 and value == int(value) else None


# --- Production Center press ticket -------------------------------------------------------------

def parse_ticket(raw):
    """Sheets through the press (per paper) and counts per colour separation, from a returned JDF ticket."""
    root = ET.fromstring(raw)
    sheets, waste, separations = {}, {}, {}
    for amount in root.iter():
        if local(amount.tag) != "PartAmount":
            continue
        actual = whole(attr(amount, "ActualAmount"))
        if actual is None:
            continue
        for part in (c for c in amount if local(c.tag) == "Part"):
            separation, paper = attr(part, "Separation"), attr(part, "SheetName")
            condition = (attr(part, "Condition") or "").lower()
            if separation:
                separations[separation] = separations.get(separation, 0) + actual
            elif paper and not attr(part, "Side"):
                target = waste if condition == "waste" else sheets
                target[paper] = target.get(paper, 0) + actual
    requested = None
    for link in root.iter():
        if local(link.tag) == "ComponentLink" and attr(link, "Usage") in (None, "Output"):
            requested = whole(attr(link, "Amount")) if requested is None else requested
    return {"sheets": sheets, "waste": waste, "separations": separations, "requested": requested,
            "status": attr(root, "Status")}


def fetch_ticket(qid, opener=None):
    if not QID.fullmatch(qid):
        raise ValueError("Invalid queue entry ID")
    opener = opener or build_opener(ProxyHandler({}))
    req = Request(CENTER + "/prodflow/jdf/returnJDFTicket?QueueEntryID=" + qid, headers={"Accept": "application/xml"})
    with opener.open(req, timeout=20) as resp:
        raw = resp.read(MAX_TICKET + 1)
    if len(raw) > MAX_TICKET:
        raise ValueError("Press ticket too large")
    return parse_ticket(raw)


# --- Prinect Cockpit imposition ------------------------------------------------------------------

def parse_imposition(raw):
    """Number-up, sheets per set, sides and paper from the JDF Cockpit sent to the Indigo."""
    root = ET.fromstring(raw)
    pages, sheet_names, sides = {}, set(), set()

    def walk(element, sheet=None, side=None):
        sheet = attr(element, "SheetName") or sheet
        side = attr(element, "Side") or side
        if local(element.tag) == "ContentObject":
            name = attr(element, "DescriptiveName") or attr(element, "Ord") or "?"
            pages[name] = pages.get(name, 0) + 1
            if sheet: sheet_names.add(sheet)
            sides.add(side or "Front")
        for child in element:
            walk(child, sheet, side)

    layouts = [e for e in root.iter() if local(e.tag) == "Layout" and attr(e, "Class") == "Parameter"]
    for layout in layouts:
        walk(layout)
    media, layout_name, surfaces, template = None, None, None, None
    for e in root.iter():
        tag = local(e.tag)
        if tag == "DigitalPrintingParams":
            media = media or attr(e, "MediaName") if attr(e, "Side") else media
            layout_name = layout_name or attr(e, "SubmittedElements")
            surfaces = surfaces or whole(attr(e, "NumSurfaces"))
        elif tag == "SignaJobPart":
            template = template or attr(e, "Name")
        elif tag == "RunList" and attr(e, "Sides"):
            surfaces = surfaces or (2 if attr(e, "Sides").startswith("TwoSided") else 1)
    counts = set(pages.values())
    # Each page repeated the same number of times = copies of the product on each sheet.
    # A mixed layout (some pages more often than others) is not a simple number-up.
    up = counts.pop() if len(counts) == 1 else None
    return {"up": up, "sheetsPerSet": len(sheet_names) or (1 if pages else None),
            "sides": 2 if "Back" in sides else (surfaces or (1 if pages else None)),
            "imposed": bool(pages), "layout": layout_name, "media": media, "template": template,
            "pages": len(pages)}


class Share:
    """PTJobs on PPMS: a read-only mount if PrintCRM has one, otherwise smbclient (as for PTConfig)."""

    def __init__(self, root=None):
        configured = root or os.environ.get("INDIGO_PTJOBS_DIR")
        candidates = [Path(configured)] if configured else [Path("/mnt/ppms/PTJobs"), Path("/mnt/PTJobs")]
        self.root = next((p for p in candidates if (p / "Jobs").is_dir()), None)
        if configured and not self.root:
            raise OSError("The configured PTJobs folder was not found.")
        if not self.root and AUTH.exists() and (AUTH.is_symlink() or AUTH.stat().st_uid != 0 or AUTH.stat().st_mode & 0o077):
            raise OSError("Check ownership and permissions of the Prinect share credential on PrintCRM.")

    def _smb(self, commands, timeout=30):
        flags = ["-A", str(AUTH)] if AUTH.exists() else ["-N"]
        try:
            result = subprocess.run(["smbclient", SHARE, *flags, "-c", commands], capture_output=True, timeout=timeout, check=False)
        except FileNotFoundError:
            raise OSError("smbclient is not installed on PrintCRM.") from None
        except subprocess.TimeoutExpired:
            raise OSError("The PTJobs share timed out.") from None
        out = result.stdout.decode("utf-8", "replace")
        if result.returncode and "NT_STATUS_NO_SUCH_FILE" not in out and "NT_STATUS_OBJECT_NAME_NOT_FOUND" not in out:
            raise OSError("Could not read the PTJobs share.")
        return out

    LINE = re.compile(r"^  (.+?)\s+([DAHSRN]*)\s+\d+\s+\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4}$")

    def folders(self, rel):
        """Sub-folder names of a folder ([] when it does not exist)."""
        if self.root:
            base = self.root / rel
            return sorted(p.name for p in base.iterdir() if p.is_dir()) if base.is_dir() else []
        names = []
        for line in self._smb('ls "' + rel.replace("/", "\\") + '\\*"').splitlines():
            m = self.LINE.match(line)
            if m and "D" in m[2] and m[1] not in (".", ".."):
                names.append(m[1])
        return sorted(names)

    def cockpit_files(self, rel):
        """Every D7_<queue ID>_in.jdf under `rel` (one level of sub-folders): {file name: relative path}."""
        found = {}
        if self.root:
            base = self.root / rel
            for path in (base.glob("*/D7_*_in.jdf") if base.is_dir() else []):
                found.setdefault(path.name, str(path.relative_to(self.root)))
            return found
        # One connection per job folder: a recursive listing prints each sub-folder as a \path line, then its files.
        out = self._smb('recurse ON; prompt OFF; cd "' + rel.replace("/", "\\") + '"; ls D7_*_in.jdf', timeout=60)
        folder = None
        for line in out.splitlines():
            if line.startswith("\\"):
                folder = line.strip().strip("\\").replace("\\", "/")
                continue
            m = self.LINE.match(line)
            if m and folder and m[1].startswith("D7_") and m[1].endswith("_in.jdf"):
                found.setdefault(m[1], folder + "/" + m[1])
        if not found:
            # Fallback if this smbclient prints recursive listings differently: one listing per sub-folder.
            for sub in self.folders(rel):
                for line in self._smb('ls "' + (rel + "/" + sub).replace("/", "\\") + '\\D7_*_in.jdf"').splitlines():
                    m = self.LINE.match(line)
                    if m and m[1].startswith("D7_") and m[1].endswith("_in.jdf"):
                        found.setdefault(m[1], rel + "/" + sub + "/" + m[1])
        return found

    def read(self, rel):
        if self.root:
            return (self.root / rel).read_bytes()
        with tempfile.TemporaryDirectory() as temp:
            dest = Path(temp) / "data.jdf"
            self._smb('get "' + rel.replace("/", "\\") + '" "' + str(dest) + '"')
            if not dest.is_file():
                raise OSError("Could not copy the Cockpit JDF from PTJobs.")
            data = dest.read_bytes()
        if len(data) > MAX_TICKET:
            raise ValueError("Cockpit JDF too large")
        return data


def job_folders(share, job, submitted, listing):
    """Cockpit folders for this job number, newest day first, within FOLDER_DAYS of the press submission."""
    digits = job[1:].split("-")[0]
    day = src.plantday(submitted)
    for back in range(-1, FOLDER_DAYS):
        name = (day - timedelta(days=back)).isoformat()
        if name not in listing:
            listing[name] = share.folders("Jobs/" + name)
        for folder in listing[name]:
            first = folder.split()[0]
            if re.fullmatch(r"J?" + digits + r"(?:[a-z]|-\d+[a-z]?)?", first, re.I):
                yield "Jobs/" + name + "/" + folder


def read_imposition(share, job, qid, submitted, listing, files=None):
    files = files if files is not None else {}
    for folder in job_folders(share, job, submitted, listing):
        if folder not in files:
            files[folder] = share.cockpit_files(folder + "/RendererReports")
        found = files[folder].get("D7_" + qid + "_in.jdf")
        if found:
            result = parse_imposition(share.read(found))
            result["output"] = found.split("/")[-2]
            return result
    return None


# --- printIQ ------------------------------------------------------------------------------------

def acceptance(reader, cache, job, now):
    """Product quantity and every Printing section (press + operation key) for an exact accepted job."""
    raw, sha = None, None
    for number in (job, job[1:]):
        try:
            raw, sha = (reader.acceptance(job) if number == job else
                        reader._read("/api/QuoteProcess/GetAcceptanceDetails", {"LoginToken": reader.token}, {"JobNo": number}))
        except cache.CacheError as exc:
            if str(exc) in {"http_401", "http_403"}:
                raise
            continue
        if any(src.directory_key(p.get("JobNo")) == job for p in raw["AcceptanceDetails"]["Products"]):
            break
        raw = None
    if raw is None:
        raise ValueError("Exact printIQ job unavailable")
    products = [p for p in raw["AcceptanceDetails"]["Products"] if src.directory_key(p.get("JobNo")) == job]
    if len(products) != 1:
        raise ValueError("Missing or ambiguous accepted job")
    p = products[0]
    native = p["JobNo"]
    if native != job:
        raw = {**raw, "AcceptanceDetails": {**raw["AcceptanceDetails"], "Products": [{**p, "JobNo": job}]}}
    facts = cache.quantity_fields(raw, job, sha, now, "printed-check")
    sections = []
    mid = p["MiddlewareProductDetail"]
    for op in facts["printingOperations"]:
        quoted = next((s for s in mid["Sections"] if s.get("QQDSKey") == op["quotedSectionKey"]), {})
        sections.append({"sectionKey": op["acceptedSectionKey"], "quotedSectionKey": op["quotedSectionKey"],
                         "operationKey": op["operationKey"], "pressKey": op["pressKey"],
                         "press": op.get("pressName") or quoted.get("QPressName"),
                         "name": " ".join(str(quoted.get("PSSectionDescription") or "").split())[:120] or None,
                         "printIQUp": quoted.get("PSNUp"), "front": quoted.get("QPrsShortNameFront"),
                         "reverse": quoted.get("QPrsShortNameReverse")})
    status = str(p.get("StatusName") or p.get("Status") or "").strip()
    return {"printiqJobNo": native, "quantity": whole(p.get("Quantity")), "status": status,
            "issues": list(facts["issues"]), "sections": sections, "readAt": now.isoformat()}


# --- Collect ------------------------------------------------------------------------------------

def job_links(state):
    """Managers' links: a job number sent to the press by mistake -> the job it belongs to (read-only)."""
    try:
        with sqlite3.connect((state.parent / "production.sqlite").as_uri() + "?mode=ro", uri=True) as db:
            rows = db.execute("SELECT id, json_extract(doc,'$.job') FROM records WHERE kind='pressJobLink' AND json_extract(doc,'$.removed') IS NULL").fetchall()
    except sqlite3.Error:
        return {}
    return {src.jobno(a): src.jobno(b) for a, b in rows if src.jobno(a) and src.jobno(b)}


def recent_entries(state, now):
    with sqlite3.connect((state / "observations.sqlite3").as_uri() + "?mode=ro", uri=True) as db:
        rows = [(q, json.loads(raw)) for q, raw in db.execute("SELECT queue_id,entry_json FROM entries")]
    found = []
    for q, entry in rows:
        submitted = src.instant(entry.get("submissionTime"))
        if entry.get("status") != "Completed" or not submitted or not QID.fullmatch(entry.get("queueEntryId") or q or ""):
            continue
        if not timedelta(0) <= now - submitted <= timedelta(days=LOOKBACK_DAYS):
            continue
        native = entry.get("nativeJobId") or ""
        named = (entry.get("nameRunIndex") or {}).get("jobNo") if isinstance(entry.get("nameRunIndex"), dict) else None
        job = src.jobno(native) if native not in ("000000", "J000000") else None
        found.append({"queueEntryId": entry.get("queueEntryId") or q, "job": job or src.jobno(named or ""),
                      "fromCockpit": bool(job), "part": entry.get("jobPartId"), "submitted": submitted})
    links = job_links(state)
    for e in found:
        if e["job"] in links:
            e["sentAs"], e["job"] = e["job"], links[e["job"]]
    return [e for e in found if e["job"]]


def closed_jobs(feed=src.FEED):
    """Jobs the hourly scan found Complete (or Cancelled) in printIQ: nothing left to print, so never read again."""
    try:
        data = json.loads(Path(feed).read_text())
    except (OSError, ValueError):
        return set()
    closed = {v["job"] for v in data.get("visibility", []) if isinstance(v, dict) and v.get("complete") is True and v.get("job")}
    closed |= {j.get("job") for j in data.get("jobs", []) if isinstance(j, dict) and j.get("state") in ("complete", "cancelled")}
    return {src.jobno(j) for j in closed if src.jobno(j)}


def load_cache(path):
    try:
        data = json.loads(path.read_text())
        return data if data.get("schema") == 1 else {"schema": 1, "tickets": {}, "impositions": {}, "jobs": {}}
    except (OSError, ValueError):
        return {"schema": 1, "tickets": {}, "impositions": {}, "jobs": {}}


def collect(now, state=src.STATE, share=None, ticket=fetch_ticket, reader=None, cache=None, memo=None, closed=None):
    memo = memo if memo is not None else {"schema": 1, "tickets": {}, "impositions": {}, "jobs": {}}
    health = {"center": {"ok": True, "reason": None}, "cockpit": {"ok": True, "reason": None}, "printiq": {"ok": True, "reason": None}}
    closed = closed_jobs() if closed is None else closed
    entries = [e for e in recent_entries(state, now) if e["job"] not in closed]
    listing, files = {}, {}
    started = datetime.now(timezone.utc)
    over = lambda: (datetime.now(timezone.utc) - started).total_seconds() > BUDGET_SECONDS
    # Newest first, so today's work is read before the backlog.
    entries.sort(key=lambda e: e["submitted"], reverse=True)
    try:
        share = share or Share()
    except OSError as error:
        share, health["cockpit"] = None, {"ok": False, "reason": str(error)}
    for e in entries:
        q = e["queueEntryId"]
        if over():
            break
        if q not in memo["tickets"]:
            try:
                memo["tickets"][q] = ticket(q)
            except (OSError, ValueError, ET.ParseError, TypeError, AttributeError) as error:
                health["center"] = {"ok": False, "reason": "Production Center press tickets could not be read (" + type(error).__name__ + ")."}
        known = memo["impositions"].get(q)
        retry = known and known.get("missingSince") and now - datetime.fromisoformat(known["checkedAt"]) >= timedelta(hours=RETRY_HOURS) \
            and now - datetime.fromisoformat(known["missingSince"]) <= timedelta(days=GIVE_UP_DAYS)
        if e["fromCockpit"] and share and (known is None or retry):
            try:
                found = read_imposition(share, e["job"], q, e["submitted"], listing, files)
                memo["impositions"][q] = {"found": found, "checkedAt": now.isoformat(),
                                          "missingSince": None if found else (known or {}).get("missingSince") or now.isoformat()}
            except (OSError, ValueError, ET.ParseError, TypeError, AttributeError, KeyError) as error:
                if isinstance(error, OSError):
                    health["cockpit"] = {"ok": False, "reason": str(error)}
                else:
                    # One unreadable JDF: record it for this entry and carry on.
                    memo["impositions"][q] = {"found": None, "checkedAt": now.isoformat(), "missingSince": now.isoformat(), "error": type(error).__name__}
    jobs = sorted({e["job"] for e in entries})
    if jobs and reader is None:
        sys.path.insert(0, "/opt/sunnyland-printiq-requirements")
        import requirements_cache as cache
        reader = cache.AcceptanceReader(cache.load_configuration())
        try:
            reader.login()
        except cache.CacheError:
            reader, health["printiq"] = None, {"ok": False, "reason": "printIQ sign-in failed."}
    for job in jobs:
        if over():
            break
        held = memo["jobs"].get(job)
        if held and now - datetime.fromisoformat(held["readAt"]) < timedelta(minutes=ACCEPTANCE_MINUTES):
            continue
        if not reader:
            continue
        try:
            memo["jobs"][job] = acceptance(reader, cache, job, now)
        except (ValueError, KeyError, StopIteration, TypeError, AttributeError, IndexError) as error:
            memo["jobs"][job] = {"error": str(error) if type(error) is ValueError else "Accepted routing unavailable (" + type(error).__name__ + ")",
                                 "readAt": now.isoformat(), "sections": []}
        except Exception as error:  # noqa: BLE001 - printIQ outage: keep the last answer
            if cache and isinstance(error, cache.CacheError):
                health["printiq"] = {"ok": False, "reason": "printIQ accepted job lookups failed."}
            else:
                raise
    out = []
    for job in jobs:
        rows = []
        for e in (x for x in entries if x["job"] == job):
            q = e["queueEntryId"]
            t = memo["tickets"].get(q)
            imp = memo["impositions"].get(q)
            if not e["fromCockpit"]: state_ = "notCockpit"
            elif imp and imp.get("found"): state_ = "found"
            elif imp and now - datetime.fromisoformat(imp["missingSince"]) > timedelta(days=GIVE_UP_DAYS): state_ = "missing"
            else: state_ = "looking"
            rows.append({"queueEntryId": q, "part": e["part"], "submitted": e["submitted"].isoformat(), "fromCockpit": e["fromCockpit"],
                         "ticket": t, "imposition": (imp or {}).get("found"), "impositionState": state_})
        out.append({"job": job, "printiq": memo["jobs"].get(job), "entries": sorted(rows, key=lambda r: r["submitted"])})
    keep = {e["queueEntryId"] for e in entries}
    memo["tickets"] = {k: v for k, v in memo["tickets"].items() if k in keep}
    memo["impositions"] = {k: v for k, v in memo["impositions"].items() if k in keep}
    memo["jobs"] = {k: v for k, v in memo["jobs"].items() if k in jobs}
    return {"schema": 1, "asOf": now.isoformat(), "generatedAt": datetime.now(timezone.utc).isoformat(), "health": health, "jobs": out}, memo


def write_private(path, data, group):
    payload = json.dumps(data, separators=(",", ":"), allow_nan=False, default=str).encode()
    if len(payload) > 16 * 1024 * 1024:
        raise ValueError("Printed snapshot exceeds bounds")
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".indigo-printed-", delete=False) as out:
        temp = Path(out.name)
        try:
            os.fchown(out.fileno(), 0, group); os.fchmod(out.fileno(), 0o640)
            out.write(payload); out.flush(); os.fsync(out.fileno()); os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)


def show(qid):
    """`indigo_printed.py --check QUEUE_ID`: print what the agent reads for one queue entry. Read-only."""
    now = datetime.now(timezone.utc)
    entry = next((e for e in recent_entries(src.STATE, now) if e["queueEntryId"] == qid), None)
    print("Queue entry:", entry and {k: str(v) for k, v in entry.items()})
    print("Press ticket:", json.dumps(fetch_ticket(qid)))
    if entry and entry["fromCockpit"]:
        print("Cockpit imposition:", json.dumps(read_imposition(Share(), entry["job"], qid, entry["submitted"], {})))


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--check":
        return show(sys.argv[2])
    sys.path.insert(0, "/opt/sunnyland-printiq-requirements")
    import requirements_cache as cache
    snapshot, memo = collect(datetime.now(timezone.utc), memo=load_cache(CACHE))
    write_private(CACHE, memo, cache.runtime_read_group())
    write_private(OUT, snapshot, cache.runtime_read_group())
    entries = sum(len(j["entries"]) for j in snapshot["jobs"])
    problems = [h["reason"] for h in snapshot["health"].values() if not h["ok"]]
    print("Indigo printed check:", len(snapshot["jobs"]), "jobs,", entries, "completed press entries.", " ".join(problems) or "All sources read.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001
        import traceback
        frame = traceback.extract_tb(error.__traceback__)[-1]
        print("Indigo printed check failed (" + type(error).__name__ + " at " + Path(frame.filename).name + " line " + str(frame.lineno) +
              "). Previous snapshot retained.", file=sys.stderr)
        sys.exit(1)
