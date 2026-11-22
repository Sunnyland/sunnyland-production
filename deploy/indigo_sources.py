"""Read Prinect final approvals, Indigo queue evidence and exact accepted printIQ routings."""
import csv
import io
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request
from zoneinfo import ZoneInfo

ZONE = ZoneInfo("Australia/Melbourne")
FIRST, CUTOVER = date(2026, 11, 6), date(2026, 11, 20)
STATE = Path("/var/lib/sunnyland-production/smartstream")
FEED = Path("/var/lib/sunnyland-production/indigo-hourly.json")
HISTORY = Path("ICSPortal/HDMDispatcher/History")
IDENTITY = re.compile(r"J?([0-9]{6}(?:-[0-9]+)?)([a-z]?)", re.ASCII | re.I)
RESETS = {"DigitalArtArrived", "PageProofed", "PageProductionRejected", "PageRejected", "JobDeleted", "JobAborted", "JobResubmitted", "Submission"}
# Twenty comparisons passed on the live Jobs endpoint. Each job uses both spellings.
JOBS_PER_LOOKUP = 10

QUEUED = "In the Indigo queue"
# Open jobs due within this many days are read even before approval, for approval reminders.
DUE_WINDOW_DAYS = 14

class SourceHTTPError(RuntimeError):
    def __init__(self, stage, status):
        super().__init__(f"printIQ {stage} returned HTTP {status}")

def checked_read(stage, fetch, *args):
    try:
        return fetch(*args)
    except HTTPError as error:
        error.close()
        raise SourceHTTPError(stage,error.code) from None

class HistoryUnavailable(OSError):
    pass

def jobno(text):
    m = IDENTITY.fullmatch(text.strip()) if isinstance(text,str) else None
    return "J"+m[1] if m else None

def directory_key(value):
    key=jobno(value)
    return key if key and value in (key,key[1:]) else None

def instant(text):
    try:
        value = datetime.fromisoformat(text.replace("Z","+00:00"))
        return value if value.tzinfo else None
    except (TypeError, AttributeError, ValueError):
        return None

def plantday(value):
    return value.astimezone(ZONE).date() if value else None

def journal_source(name):
    configured = os.environ.get("INDIGO_HISTORY_DIR")
    dirs = [Path(configured)] if configured else [Path("/mnt/ppms/PTConfig")/HISTORY, Path("/mnt/PTConfig")/HISTORY, Path("/Volumes/PTConfig")/HISTORY]
    if not configured and Path("/proc/mounts").exists():
        for line in Path("/proc/mounts").read_text().splitlines():
            fields=line.split()
            if len(fields)>=3 and fields[0].rstrip("/").lower().endswith("/ptconfig"):
                dirs.append(Path(fields[1].replace("\\040"," "))/HISTORY)
    for directory in dirs:
        if (directory/name).is_file():
            return (directory/name).read_bytes()
    if configured: raise HistoryUnavailable(f"{name} was not found in the configured history directory.")
    # Use the existing share as read-only. The optional admin-provisioned read account stays on PrintCRM.
    auth=Path("/etc/sunnyland-production/indigo-ppms.smb")
    if auth.exists() and (auth.is_symlink() or auth.stat().st_uid!=0 or auth.stat().st_mode & 0o077):
        raise HistoryUnavailable("Check ownership and permissions of the Prinect share credential on PrintCRM.")
    with tempfile.TemporaryDirectory() as temp:
        dest=Path(temp)/"journal.csv"
        flags=["-A",str(auth)] if auth.exists() else ["-N"]
        cmd=["smbclient","//PPMS/PTConfig",*flags,"-c",'get "ICSPortal/HDMDispatcher/History/'+name+'" "'+str(dest)+'"']
        try:
            result=subprocess.run(cmd,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30,check=False)
        except FileNotFoundError:
            raise HistoryUnavailable("No mounted history file was found and smbclient is unavailable on PrintCRM.") from None
        except subprocess.TimeoutExpired:
            raise HistoryUnavailable(f"The PTConfig share timed out reading {name}.") from None
        if result.returncode or not dest.is_file():
            access="the configured read account" if auth.exists() else "guest access"
            raise HistoryUnavailable(f"Could not read {name} from PTConfig using {access}.")
        return dest.read_bytes()

def approvals(read, now):
    # All observed revisions since the month preceding the pilot. Never project parent approval onto a child.
    months=date(FIRST.year,FIRST.month,1)-timedelta(days=1)
    month=months.replace(day=1)
    source=defaultdict(dict)
    until=plantday(now)
    while month<=until:
        raw=read(month.strftime("History.%y_%m.csv"))
        if not raw or len(raw)>64*1024*1024: raise ValueError("Incomplete Prinect journal")
        lines=raw[:raw.rfind(b"\n")+1].decode("utf-8-sig")
        rows=csv.DictReader(io.StringIO(lines,newline=""),delimiter=";",strict=True)
        if rows.fieldnames!=["date","severity","jobid","event"]:raise ValueError("Unexpected Prinect journal schema")
        for r in rows:
            if None in r or r["event"] is None:raise ValueError("Malformed approval row")
            match=IDENTITY.fullmatch(r["jobid"].strip())
            if not match:continue
            job="J"+match[1]+match[2].upper()
            event=r["event"]
            if event.startswith("Milestone reached: "): kind=event[len("Milestone reached: "):]
            elif event.startswith("Received submit "):kind="Submission"
            else:continue
            if kind not in RESETS|{"PageApproved","ProofSent"}:
                if kind=="PageProductionApproved" or not re.search("proof|reject|approv",kind,re.I):continue
                kind="Other proof change"
            stamp=int(r["date"])
            if stamp<0 or stamp>int(now.timestamp()*1000): continue
            source[job][kind]=max(stamp,source[job].get(kind,0))
        month=(month.replace(day=28)+timedelta(days=4)).replace(day=1)
    components=defaultdict(list)
    for artwork, events in source.items():
        approval=events.get("PageApproved",0)
        valid=approval>max([0]+[v for k,v in events.items() if k!="PageApproved"])
        components[jobno(artwork)].append((valid,approval))
    result={}
    for job, parts in components.items():
        approval=max(stamp for _,stamp in parts)
        result[job]={"approved":all(valid for valid,_ in parts),
                     "approvedAt":datetime.fromtimestamp(approval/1000,timezone.utc).isoformat() if approval else None}
    return result

def press_evidence(entries,snapshot,now):
    results={}
    for job in snapshot["jobs"]:
        for r in job["results"]:
            q=r["sourceExactIDs"]["queueEntryId"]
            if q in results:raise ValueError("Ambiguous press entry")
            results[q]=(job["jobNo"],r)
    history=[]; risks=defaultdict(list); lower=datetime.combine(FIRST,datetime.min.time(),ZONE)
    for q,entry in entries:
        src=results.get(q)
        source_job=src[0] if src else entry.get("nativeJobId")
        job=jobno(source_job)
        run=src[1] if src else {}
        submitted=instant(entry.get("submissionTime")); printed=instant(run.get("printedAt"))
        observed=run.get("state")=="observedPrinted" and printed and (run.get("actualOutput") or 0)>0
        proof=observed and run.get("purpose")=="proof" and (run.get("historical") or run.get("quantityUnitMappingVerified"))
        dates=[t for t in [submitted,printed] if t and lower<=t<=now]
        if dates and any(plantday(t)<CUTOVER for t in dates):
            history.append({"entry":q,"job":job,"sourceJob":source_job,"submitted":submitted.isoformat() if submitted else None,"printed":printed.isoformat() if observed else None,
                "evidence":"confirmed proof" if proof else "physical output" if observed else "queue entry only"})
        if job and not proof:
            # A queue entry can have a prior submission and a later physical end. A missing end is uncertain.
            risks[job].append({"at":max([t.isoformat() for t in (printed,submitted) if t],default=None),
                "reason":"Indigo output needs reconciliation" if observed else QUEUED})
    return history,risks

def load_press(now):
    with sqlite3.connect((STATE/"observations.sqlite3").as_uri()+"?mode=ro",uri=True) as db:
        entries=[(q,json.loads(raw)) for q,raw in db.execute("SELECT queue_id,entry_json FROM entries")]
    snap=json.loads((STATE/"status.json").read_text())
    successful=instant(snap["sourceStatus"].get("lastSuccessfulAt"))
    if snap.get("schemaVersion")!=1 or snap["sourceStatus"]["state"]!="connected" or not successful or not 0<=(now-successful).total_seconds()<600:
        raise ValueError("Fresh Indigo observations unavailable")
    return press_evidence(entries,snap,now)

# A4 two-up HP ratings expressed per printed face of a 450 × 320 mm press sheet.
SIDES_PER_MINUTE = {
    "cmyk": 60, "4 colour process": 60, "four colour process": 60, "4 colour": 60, "four colour": 60,
    "epm": 80, "enhanced productivity mode": 80,
    "monochrome": 120, "mono": 120, "black": 120, "black only": 120, "k": 120,
    "1 colour": 120, "one colour": 120, "2 colour": 120, "two colour": 120,
    "blank": 0, "none": 0, "unprinted": 0, "no print": 0, "no printing": 0,
}
SETUP_MINUTES = 10

def process_name(value):
    return " ".join(str(value or "").casefold().replace("-", " ").replace("color", "colour").split())

def indigo_sheet(short, long):
    # The 7900 prints any sheet from SRA3 (320 × 450) up to its 330 × 482 maximum at the same rated speed,
    # including pre-trim sizes such as 324 × 454.
    return 320 <= short <= 330 and 450 <= long <= 482

def sra3_section(section):
    name = str(section.get("PrintedQStockSizeName") or "").strip().casefold()
    dims = re.match(r"(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:mm)?(?:\s+pre[ -]?trim)?$", name)
    named_sra3 = name == "sra3" or bool(dims and indigo_sheet(*sorted(map(float, dims.groups()))))
    width, depth = (section.get(key) for key in ("PrintedStockSheetWidth", "PrintedStockSheetDepth"))
    if width is None and depth is None:
        return named_sra3
    if not all(isinstance(d, dict) and type(d.get("mm")) in (int, float) for d in (width, depth)):
        return False
    measured = sorted((width["mm"], depth["mm"]))
    # A named size and measured sheet must agree.
    return indigo_sheet(*measured) and (not dims or sorted(map(float, dims.groups())) == measured)

def side_rate(section, side):
    labels = {process_name(section.get("QPrs" + key + side)) for key in ("ShortName", "Description")} - {""}
    # Reject unrecognised or conflicting process descriptions, including extra inks or hits.
    rates = {SIDES_PER_MINUTE.get(label) for label in labels}
    if len(rates) == 1:
        return rates.pop()
    if not labels and side == "Reverse":
        keys = ("Key", "ShortName", "Description", "ExternalCode")
        unspecified = all("QPrs" + key + side in section and section["QPrs" + key + side] in (None, "") for key in keys)
        description = str(section.get("PSPrintDescription") or "")
        if unspecified and re.search(r"\b(?:x\s*1\s+side|single[ -]sided|one[ -]sided)\b", description, re.I):
            return 0
    return None

def press_estimate(section):
    sheets = section.get("PSTotalSheetsToPrint")
    if type(sheets) is not int or sheets <= 0:
        return None, "Check planned press sheet quantity"
    if not sra3_section(section):
        return None, "Check press sheet size for the 450 × 320 mm Indigo rate"
    rates = [side_rate(section, side) for side in ("Front", "Reverse")]
    # A named EPM press option selects the three-ink mode for process-colour faces.
    option = process_name(section.get("QPressOptionName"))
    if option in ("epm", "enhanced productivity mode"):
        rates = [80 if rate == 60 else rate for rate in rates]
    elif option:
        return None, "Check Indigo press option and rated speed"
    if rates[0] in (None, 0) or rates[1] is None:
        return None, "Check Indigo front and reverse print modes"
    # A common denominator retains fractional minutes across both sides before rounding once.
    ticks = sheets * sum(240 // rate for rate in rates if rate)
    return SETUP_MINUTES + (ticks + 239) // 240, None

def project(job,remote,data,approval,risks,cache,now):
    raw,sha=data
    products=raw["AcceptanceDetails"]["Products"]
    matches=[p for p in products if directory_key(p.get("JobNo"))==job]
    if len(matches)!=1:
        raise ValueError("Missing or ambiguous accepted job")
    p=matches[0]
    # The shared extractor expects a J-prefixed label. Its product, section and operation
    # identifiers and the hash of the original acceptance response remain authoritative.
    if p["JobNo"]!=job:
        raw={**raw,"AcceptanceDetails":{**raw["AcceptanceDetails"],"Products":[{**p,"JobNo":job}]}}
    facts=cache.quantity_fields(raw,job,sha,now,"hourly-discovery")
    # The Jobs list's QuotedProductDetailId is the accepted product's QuantityKey (not its ProductKey).
    if facts["acceptanceProductKey"]!=remote["Id"] or p.get("QuantityKey")!=remote["QuotedProductDetailId"]:
        raise ValueError("Exact accepted product changed")
    status=str(p.get("StatusName") or p.get("Status") or "").strip().lower()
    result={"job":job,"printiqId":remote["Id"],"name":remote.get("JobTitle") or job,"due":remote.get("DueDate") or p.get("DueDate"),
            "approvedAt":approval.get("approvedAt"),"rep":remote.get("rep"),"customer":remote.get("customer"),"state":"open","runs":[]}
    if remote.get("CompletedDate") or status in {"complete","completed"}:
        result["state"]="complete";return result
    if status in {"cancelled","canceled"}:result["state"]="cancelled";return result
    if facts["issues"]:result["state"]="Check accepted Printing sections";return result
    indigo=[op for op in facts["printingOperations"] if op["pressKey"]==64]
    if not indigo:result["state"]="other press";return result
    # Runs are worked out for every Indigo job, approved or not, so the agent can judge approval deadlines.
    mid=p["MiddlewareProductDetail"]
    for op in indigo:
        section=next(s for s in mid["Sections"] if s.get("QQDSKey")==op["quotedSectionKey"] and s.get("QPressKey")==64)
        binding="/".join(str(x) for x in [job,facts["acceptanceProductKey"],facts["productKey"],op["acceptedSectionKey"],op["quotedSectionKey"],op["operationKey"],64])
        stock=section.get("QStockCode"); size=section.get("PrintedQStockSizeName")
        finishes=[]
        for o in mid["Operations"]:
            name=o.get("POOperationName") or o.get("QFinishingDescription") or o.get("QFinishingShortName")
            if o.get("QQDSKey") not in [None,op["quotedSectionKey"]] or not name or NOT_FINISHING.search(name):continue
            if name not in finishes:finishes.append(name)
        minutes,issue=press_estimate(section)
        result["runs"].append({"id":str(uuid.uuid5(uuid.NAMESPACE_URL,"sunnyland:indigo:"+binding)),"operation":binding,"operationKey":str(op["operationKey"]),
            "part":section.get("PSSectionDescription") or "Section "+str(op["acceptedSectionKey"]),
            "stock":" ".join(str(s) for s in (stock,size) if s) if stock else "","finishes":", ".join(finishes) or "None",
            "finishOps":[{"name":n} for n in finishes],"minutes":minutes,"estimateIssue":issue})
    # Being in the Indigo queue is expected once a job is approved. Only observed printed output needs a check.
    risks=list(risks or [])
    result["inIndigoQueue"]=any(r["reason"]==QUEUED for r in risks)
    printed=[r for r in risks if r["reason"]!=QUEUED]
    if not approval.get("approved"):result["state"]="Awaiting current artwork approval";return result
    if re.search(r"hold|reject|cancel|awaiting approval|proof required",status):result["state"]="Check printIQ production status";return result
    if approval.get("source")=="printIQ approval status" and status not in APPROVED_NAMES:
        result["state"]="Approval status changed";return result
    if printed:result["state"]=printed[0]["reason"];return result
    return result

# Routing lines that are not finishing work after the press: prepress, stock draws, proofs, charges,
# plates for other presses and dispatch. Everything else on the section or job counts as finishing.
NOT_FINISHING=re.compile(r"^printing$|\b(auto to press|preflight|imposition|stock draw|proof|base charges|invoic|delivery|dispatch|"
    r"cartons?|freight|courier|plate for|concept|design|layout|artwork|die library|no guillo)",re.I)

APPROVED_NAMES={"artwork approved","proof approved","approved for print","approved for printing","approved for production"}
FIELDS="Id,QuotedProductDetailId,JobNo,JobTitle,DueDate,CompletedDate,ProductionStatusId,AccountManagerId"

def read_jobs(opener,key,params,entity="Jobs"):
    req=Request("https://sunnyland.printiq.com/api/v1/odata/"+entity+"?"+urlencode(params),headers={"PrintIQ-Access-Token":key,"Accept":"application/json"})
    with opener.open(req,timeout=25) as resp:
        raw=resp.read(1_000_001)
        if len(raw)>1_000_000:raise ValueError("Jobs reply too large")
        data=json.loads(raw)
    if not isinstance(data.get("value"),list):raise ValueError("Incomplete Jobs reply")
    return data

def status_catalog(reader):
    req=Request("https://sunnyland.printiq.com/api/QuoteProcess/GetProductionStatuses?"+urlencode({"LoginToken":reader.token}),
                data=b'{"ProdStatusForJob":true,"ProdStatusForSection":false,"GetImpositionStatuses":false}',method="POST",
                headers={"Content-Type":"application/json","Accept":"application/json"})
    with reader.opener.open(req,timeout=25) as resp:
        raw=resp.read(1_000_001)
    if len(raw)>1_000_000:raise ValueError("Status catalogue too large")
    data=json.loads(raw)
    if data.get("IsError") is not False or not isinstance(data.get("ProductionStatus"),list):raise ValueError("Missing production statuses")
    approved=set();complete=set()
    for row in data["ProductionStatus"]:
        labels={str(row.get(k) or "").strip().casefold() for k in ["ProdStatusName","ProdStatusDisplayName"]}-{""}
        if not labels or type(row.get("ProdStatusID")) is not int:continue
        if labels<=APPROVED_NAMES:approved.add(row["ProdStatusID"])
        if labels<={"complete","completed"}:complete.add(row["ProdStatusID"])
    return approved,complete

def directory_approved(read,ids):
    jobs={};cursor=0
    if not ids:return jobs
    where=" or ".join("ProductionStatusId eq "+str(i) for i in sorted(ids))
    while True:
        data=read({"$filter":"CompletedDate eq null and Id gt "+str(cursor)+" and ("+where+")","$select":FIELDS,"$orderby":"Id asc","$top":"50"})
        for r in data["value"]:
            if type(r.get("Id")) is not int or r["Id"]<=cursor or r.get("ProductionStatusId") not in ids:
                raise ValueError("Ambiguous approved Jobs page")
            cursor=r["Id"]
            key=directory_key(r["JobNo"])
            if key:jobs[key]=r if key not in jobs else None
        if not data["value"] or (len(data["value"])<50 and not data.get("@odata.nextLink")):break
    return jobs

def directory_due(read,now,days=DUE_WINDOW_DAYS):
    """Open jobs due from a week ago to `days` ahead, whatever their approval status."""
    jobs={};cursor=0
    low=(now-timedelta(days=7)).strftime("%Y-%m-%dT00:00:00Z");high=(now+timedelta(days=days)).strftime("%Y-%m-%dT00:00:00Z")
    while True:
        data=read({"$filter":"CompletedDate eq null and DueDate ge "+low+" and DueDate lt "+high+" and Id gt "+str(cursor),
                   "$select":FIELDS,"$orderby":"Id asc","$top":"50"})
        for r in data["value"]:
            if type(r.get("Id")) is not int or r["Id"]<=cursor:raise ValueError("Ambiguous due-soon Jobs page")
            cursor=r["Id"]
            key=directory_key(r["JobNo"])
            if key:jobs[key]=r if key not in jobs else None
        if not data["value"] or (len(data["value"])<50 and not data.get("@odata.nextLink")):break
    return jobs

GUID=re.compile(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}",re.I)
EMAIL=re.compile(r"[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+")

def account_managers(read_users,ids):
    """printIQ account managers (the job's rep): id -> {name, email}. Unknown ids are left out."""
    found={};ids=sorted({i for i in ids if isinstance(i,str) and GUID.fullmatch(i)})
    for i in range(0,len(ids),JOBS_PER_LOOKUP):
        group=ids[i:i+JOBS_PER_LOOKUP]
        data=read_users({"$filter":" or ".join("Id eq "+g for g in group),"$select":"Id,FirstName,Surname,Email","$top":str(len(group))})
        for u in data["value"]:
            if u.get("Id") in group:
                email=u["Email"] if isinstance(u.get("Email"),str) and EMAIL.fullmatch(u["Email"]) else None
                found[u["Id"]]={"name":" ".join(x for x in (u.get("FirstName"),u.get("Surname")) if x) or None,"email":email}
    return found

def customer_names(read,ids):
    """Client name for each printIQ job Id, for the board: {Id: name}. Best effort: printIQ refusing the field
    (or any error) stops after that one request and the board shows the job title alone."""
    found={};ids=sorted({i for i in ids if type(i) is int and i>0})
    try:
        for i in range(0,len(ids),JOBS_PER_LOOKUP):
            group=ids[i:i+JOBS_PER_LOOKUP]
            data=read({"$filter":" or ".join("Id eq "+str(g) for g in group),"$select":"Id,CustomerName","$top":str(len(group))})
            for row in data["value"]:
                name=row.get("CustomerName")
                if row.get("Id") in group and isinstance(name,str) and name.strip():found[row["Id"]]=name.strip()[:80]
    except Exception:
        pass
    return found

def odata(jobs,read):
    found={}
    jobs=sorted({key for job in jobs if (key:=jobno(job))})
    for i in range(0,len(jobs),JOBS_PER_LOOKUP):
        group=jobs[i:i+JOBS_PER_LOOKUP]
        r=read({"$filter":" or ".join("JobNo eq '"+v+"'" for j in group for v in (j,j[1:])),"$select":FIELDS,"$top":str(len(group)*2+1)})
        if r.get("@odata.nextLink"):raise ValueError("Incomplete exact Jobs lookup")
        for row in r["value"]:
            key=directory_key(row["JobNo"])
            if key not in group or type(row.get("Id")) is not int or row["Id"]<=0:raise ValueError("Unexpected exact Jobs reply")
            found[key]=row if key not in found else None
    return found

def collect(now):
    sys.path.insert(0,"/opt/sunnyland-printiq-requirements")
    import requirements_cache as cache
    history,risks=load_press(now)
    approval_error=None
    try: approved=approvals(journal_source,now)
    except HistoryUnavailable as exc:
        approved={};approval_error="Prinect history unavailable. "+str(exc)
    except (OSError,ValueError,csv.Error,subprocess.SubprocessError):
        approved={};approval_error="Prinect history unavailable. Check the read-only PTConfig share."
    numbers={r["job"] for r in history if r["job"]} | {j for j,a in approved.items() if a["approvedAt"] and plantday(instant(a["approvedAt"]))>=FIRST}
    reader=cache.AcceptanceReader(cache.load_configuration())
    try: reader.login()
    except cache.CacheError as exc:
        status=re.fullmatch(r"http_([0-9]{3})",str(exc))
        if status:raise SourceHTTPError("application login",int(status[1])) from None
        raise
    credential=json.loads(Path("/etc/sunnyland-production/printiq-jobs.json").read_text())
    if credential.get("type")!="odata":raise ValueError("Existing OData Jobs credential required")
    def read(params):return read_jobs(reader.opener,credential["apiKey"],params)
    directory_error=None;approved_ids=set();complete_ids=set();directory={}
    try:
        approved_ids,complete_ids=checked_read("production status catalogue",status_catalog,reader)
        directory=checked_read("approved jobs list",directory_approved,read,approved_ids)
    except SourceHTTPError as exc:
        directory_error=str(exc)+"."
    except (OSError,ValueError,KeyError):
        directory_error="printIQ approval-status discovery unavailable."
    due_soon={}
    try: due_soon=checked_read("due-soon jobs list",directory_due,read,now)
    except (SourceHTTPError,OSError,ValueError,KeyError):due_soon={}
    jobs=sorted(numbers|set(directory)|{j for j,r in due_soon.items() if r})
    mis=checked_read("planning job-number lookup",odata,jobs,read)
    try:
        reps=account_managers(lambda params:read_jobs(reader.opener,credential["apiKey"],params,"Users"),
                              [r.get("AccountManagerId") for r in mis.values() if r])
    except (SourceHTTPError,OSError,ValueError,KeyError):reps={}
    for r in mis.values():
        if r and r.get("AccountManagerId") in reps:r["rep"]=reps[r["AccountManagerId"]]
    clients=customer_names(read,[r.get("Id") for r in mis.values() if r])
    for r in mis.values():
        if r and r.get("Id") in clients:r["customer"]=clients[r["Id"]]
    # Carry every local job that can appear in Samples, on a board, or in a staff picker.
    # These need only a bounded Jobs lookup, never an acceptance fetch for scheduling.
    with sqlite3.connect((STATE.parent/"production.sqlite").as_uri()+"?mode=ro",uri=True) as db:
        refs={jobno(r[0]) for r in db.execute("""SELECT DISTINCT CASE WHEN kind='job' THEN id ELSE json_extract(doc,'$.job') END
            FROM records WHERE kind IN ('job','sample','jobVideo','printPlanRun','operation','hold','issue','indigoReadyRun','checkedPrintFinish')""") if jobno(r[0])}
    refs.update(jobno(j["jobNo"]) for j in json.loads((STATE/"status.json").read_text())["jobs"] if jobno(j["jobNo"]))
    undated_complete=checked_read("completed jobs list",directory_approved,read,complete_ids) if complete_ids else {}
    watched={**mis,**checked_read("job visibility lookup",odata,sorted(refs-set(mis)),read)}
    visibility=[{"job":j,"printiqId":r["Id"],"completedAt":r.get("CompletedDate"),
                 "complete":True if r.get("CompletedDate") or r.get("ProductionStatusId") in complete_ids else False if complete_ids else None}
                for j,r in watched.items() if r]
    rows=[]
    for job in jobs:
        remote=mis.get(job);approval=approved.get(job,{})
        if remote and directory.get(job) and remote["Id"]==directory[job]["Id"] and remote.get("ProductionStatusId") in approved_ids and job not in approved and not approval_error:
            approval={"approved":True,"source":"printIQ approval status"}
        elif job in directory and job in approved and not approval.get("approved"):
            approval={"approved":False}
        if not remote:
            rows.append({"job":job,"state":"Ambiguous printIQ job number" if job in mis else "Exact printIQ job unavailable","runs":[]});continue
        if remote.get("CompletedDate") or remote.get("ProductionStatusId") in complete_ids:
            rows.append({"job":job,"printiqId":remote["Id"],"state":"complete","runs":[]});continue
        try:
            data=read_acceptance(reader,job,remote["JobNo"])
            rows.append(project(job,remote,data,approval,risks.get(job),cache,now))
        except cache.CacheError as exc:
            if str(exc) in {"http_401","http_403"}:
                raise SourceHTTPError("accepted job lookup",int(str(exc)[-3:])) from None
            rows.append({"job":job,"state":"Accepted routing unavailable","runs":[]})
        except (ValueError,KeyError,StopIteration):rows.append({"job":job,"state":"Accepted routing unavailable","runs":[]})
    issued=datetime.now(timezone.utc)
    if (issued-now).total_seconds()>2700:raise ValueError("Source scan exceeded freshness window")
    return {"schema":3,"asOf":now.isoformat(),"generatedAt":issued.isoformat(),"historyStart":str(FIRST),"historyEndExclusive":str(CUTOVER),
            "undatedComplete":[[j,r["Id"]] for j,r in undated_complete.items() if r and j not in watched],"visibility":visibility,"completeStatusIds":sorted(complete_ids),"approvalError":approval_error,"directoryError":directory_error,"history":history,"jobs":rows}

def read_acceptance(reader,key,native):
    if directory_key(native)!=key:raise ValueError("Unverified printIQ job number")
    if native==key:return reader.acceptance(key)
    return reader._read("/api/QuoteProcess/GetAcceptanceDetails",{"LoginToken":reader.token},{"JobNo":native})

def main():
    sys.path.insert(0,"/opt/sunnyland-printiq-requirements")
    import requirements_cache as cache
    feed=collect(datetime.now(timezone.utc))
    payload=json.dumps(feed,separators=(",",":"),allow_nan=False).encode()
    if len(payload)>32*1024*1024:raise ValueError("Hourly snapshot exceeds bounds")
    with tempfile.NamedTemporaryFile(dir=FEED.parent,prefix=".indigo-",delete=False) as out:
        temp=Path(out.name)
        try:
            os.fchown(out.fileno(),0,cache.runtime_read_group());os.fchmod(out.fileno(),0o640)
            out.write(payload);out.flush();os.fsync(out.fileno());os.replace(temp,FEED)
        finally:
            temp.unlink(missing_ok=True)
    print("Indigo hourly source scan:",len(feed["history"]),"historical entries,",len(feed["jobs"]),"jobs.",feed["approvalError"] or "Prinect journal checked.")
if __name__=="__main__":
    try: main()
    except Exception as error:
        reason=str(error) if isinstance(error,SourceHTTPError) else type(error).__name__
        print("Indigo hourly source scan failed ("+reason+"). Previous snapshot retained.",file=sys.stderr)
        sys.exit(1)
