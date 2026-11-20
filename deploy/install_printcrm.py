"""First installation on PrintCRM (Debian 13, x86_64). Does not modify HAProxy.

Run as root: python3 deploy/install_printcrm.py --snapshot /root/PRIVATE_SNAPSHOT
The application source is the parent of this deploy directory.
"""
import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import closing
from pathlib import Path, PurePosixPath

VERSION = "24.22.3"
ARCHIVE = f"node-v{VERSION}-linux-x64.tar.xz"
NODE_URL = f"https://nodejs.org/dist/v{VERSION}/"
# Published on https://nodejs.org/en/blog/release/v24.22.3
NODE_SHA256 = "4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb"
BASE = Path("/opt/sunnyland-production")
STATE = Path("/var/lib/sunnyland-production")
CONFIG = Path("/etc/sunnyland-production")
UNIT = Path("/etc/systemd/system/sunnyland-production.service")
ACCOUNT = "sunnyland-production"
HOST = "192.168.0.35"
PORT = 5180


def digest(path):
    with open(path, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def checked_file(root, name):
    relative = PurePosixPath(name)
    if not name or relative.is_absolute() or ".." in relative.parts or "\\" in name:
        raise ValueError("Unsafe manifest path.")
    path = root.joinpath(*relative.parts)
    if any(root.joinpath(*relative.parts[:i]).is_symlink() for i in range(1, len(relative.parts) + 1)):
        raise ValueError("Manifest paths must not contain symlinks.")
    if not path.is_file() or not path.resolve().is_relative_to(root):
        raise ValueError(f"Missing or unsafe file: {name}")
    return path


def validate_source(source):
    manifest = json.loads(checked_file(source, "MANIFEST.json").read_text(encoding="utf-8"))
    required = {"server.mjs", "network.mjs", "core.mjs", "inventory.mjs", "printiq.mjs", "package.json", "deploy/install_printcrm.py", "deploy/sunnyland-production.service"}
    if not isinstance(manifest, dict) or not required.issubset(manifest):
        raise ValueError("Source package is incomplete. Use the newly prepared ZIP.")
    for name, item in manifest.items():
        path = checked_file(source, name)
        if "data" in PurePosixPath(name).parts or name.endswith((".sqlite", ".env")):
            raise ValueError("Live state must not be mixed into the source package.")
        if path.stat().st_size != item["bytes"] or digest(path) != item["sha256"]:
            raise ValueError(f"Source checksum failed: {name}")
    return manifest


def validate_snapshot(snapshot):
    manifest = json.loads(checked_file(snapshot, "snapshot.json").read_text(encoding="utf-8"))
    if manifest.get("format") != "sunnyland-state-snapshot-v1" or "production.sqlite" not in manifest.get("files", {}):
        raise ValueError("Snapshot is incomplete or has the wrong format.")
    for name, expected in manifest["files"].items():
        if digest(checked_file(snapshot, name)) != expected:
            raise ValueError(f"Snapshot checksum failed: {name}")
    db_path = snapshot / "production.sqlite"
    with closing(sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True)) as db:
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("Snapshot database integrity check failed.")
        counts = dict(db.execute("SELECT kind,count(*) FROM records GROUP BY kind"))
        if counts != manifest["records"] or db.execute("SELECT count(*) FROM outbox").fetchone()[0] != manifest["outboxCount"]:
            raise ValueError("Snapshot record counts changed.")
        users = [json.loads(row[0]) for row in db.execute("SELECT doc FROM records WHERE kind='user'")]
        if not any(user.get("enabled") and user.get("role") == "manager" for user in users):
            raise ValueError("Snapshot has no enabled manager.")
        expected_files = {"production.sqlite"}
        for row in db.execute("SELECT doc FROM records WHERE kind='media'"):
            media = json.loads(row[0])
            name = "media/" + media["id"]
            path = checked_file(snapshot, name)
            if path.stat().st_size != media["bytes"] or manifest["files"].get(name) != media["sha256"]:
                raise ValueError("Media does not match the database.")
            expected_files.add(name)
        if expected_files != set(manifest["files"]):
            raise ValueError("Snapshot contains unexpected files.")
    return manifest


def command(args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def download(url, destination, limit):
    request = urllib.request.Request(url, headers={"User-Agent": "Sunnyland-Production-Installer/0.1"})
    with urllib.request.urlopen(request, timeout=45) as response:
        final = urllib.parse.urlsplit(response.url)
        if final.scheme != "https" or final.hostname != "nodejs.org":
            raise ValueError("Runtime download redirected away from the official HTTPS host.")
        total = 0
        with open(destination, "xb") as output:
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > limit:
                    raise ValueError("Runtime download exceeded the expected size limit.")
                output.write(chunk)


def prepare_runtime(stage):
    print(f"Downloading dedicated Node {VERSION} from nodejs.org...", flush=True)
    sums = stage / "SHASUMS256.txt"
    archive = stage / ARCHIVE
    download(NODE_URL + "SHASUMS256.txt", sums, 1024 * 1024)
    matches = [line.split()[0] for line in sums.read_text(encoding="utf-8").splitlines() if len(line.split()) == 2 and line.split()[1] == ARCHIVE]
    if len(matches) != 1 or not re.fullmatch(r"[0-9a-f]{64}", matches[0]):
        raise ValueError("Official checksum for the selected runtime was not found.")
    if matches[0] != NODE_SHA256:
        raise ValueError("Runtime checksum differs from the pinned official release checksum.")
    download(NODE_URL + ARCHIVE, archive, 256 * 1024 * 1024)
    if digest(archive) != matches[0]:
        raise ValueError("Node archive checksum failed.")
    unpacked = stage / "unpacked"
    unpacked.mkdir()
    prefix = f"node-v{VERSION}-linux-x64"
    with tarfile.open(archive, "r:xz") as package:
        members = package.getmembers()
        if any(not PurePosixPath(item.name).parts or PurePosixPath(item.name).parts[0] != prefix for item in members):
            raise ValueError("Unexpected runtime archive layout.")
        package.extractall(unpacked, filter="data")
    runtime = unpacked / prefix
    detected = command([runtime / "bin/node", "--version"], capture_output=True, text=True).stdout.strip()
    if detected != "v" + VERSION:
        raise ValueError("Downloaded Node version was not the selected version.")
    command([runtime / "bin/node", "--input-type=module", "-e", "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(':memory:'); db.close();"])
    return runtime, matches[0]


def preflight(source, snapshot):
    if platform.system() != "Linux" or os.geteuid() != 0:
        raise ValueError("Run this installer as root on the PrintCRM Linux server.")
    if platform.machine() not in {"x86_64", "amd64"}:
        raise ValueError("This installer is for the verified x86_64 server.")
    if sys.version_info < (3, 12):
        raise ValueError("Python 3.12 or later is required for safe archive extraction.")
    release = dict(line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines() if "=" in line)
    if release.get("ID", "").strip('"') != "debian" or release.get("VERSION_ID", "").strip('"') != "13":
        raise ValueError("This deployment was prepared for Debian 13.")
    for path in (BASE, STATE, CONFIG, UNIT):
        if path.exists() or path.is_symlink():
            raise ValueError(f"Existing installation path found; nothing overwritten: {path}")
    import pwd
    import grp
    for lookup in (pwd.getpwnam, grp.getgrnam):
        try:
            lookup(ACCOUNT)
        except KeyError:
            pass
        else:
            raise ValueError("The service account/group already exists; inspect before installing.")
    for executable in ("systemctl", "systemd-analyze", "useradd", "groupadd"):
        if not shutil.which(executable):
            raise ValueError(f"Required system command is missing: {executable}")
    if not Path("/run/systemd/system").is_dir() or not Path("/usr/sbin/nologin").is_file():
        raise ValueError("Expected systemd/non-login account support was not found.")
    for address in (HOST, "0.0.0.0"):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind((address, PORT))
    source_manifest = validate_source(source)
    snapshot_manifest = validate_snapshot(snapshot)
    needed = sum(checked_file(snapshot, name).stat().st_size for name in snapshot_manifest["files"])
    if shutil.disk_usage("/opt").free < 700 * 1024 * 1024 or shutil.disk_usage("/var/lib").free < needed + 256 * 1024 * 1024:
        raise ValueError("Insufficient free space for the runtime and migrated state.")
    return source_manifest, snapshot_manifest


def wait_for_health():
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        try:
            with client.open(f"http://{HOST}:{PORT}/health", timeout=2) as response:
                if response.status == 200 and json.load(response) == {"ok": True, "version": "0.1.0"}:
                    break
        except (OSError, ValueError):
            pass
        time.sleep(1)
    else:
        raise ValueError("New service did not become healthy within 25 seconds.")
    try:
        client.open(f"http://{HOST}:{PORT}/api/state", timeout=3)
    except urllib.error.HTTPError as error:
        if error.code == 401:
            return
        raise ValueError(f"Unexpected unauthenticated response: {error.code}") from error
    raise ValueError("Unauthenticated application data was not rejected.")


def verify_installed_state(snapshot):
    with closing(sqlite3.connect((snapshot / "production.sqlite").as_uri() + "?mode=ro", uri=True)) as original:
        with closing(sqlite3.connect((STATE / "production.sqlite").as_uri() + "?mode=ro", uri=True)) as installed:
            if installed.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("Installed database integrity check failed.")
            for table in ("records", "requests", "audit", "outbox", "sessions", "failures"):
                query = f"SELECT * FROM {table} ORDER BY rowid"
                if original.execute(query).fetchall() != installed.execute(query).fetchall():
                    raise ValueError(f"Installed state changed during migration: {table}. Stop and reconcile.")


def install(source, snapshot):
    os.umask(0o077)
    source_manifest, snapshot_manifest = preflight(source, snapshot)
    print("Source and private snapshot verified. Existing application processes will not be restarted.", flush=True)
    with tempfile.TemporaryDirectory(prefix="sunnyland-install-", dir="/var/tmp") as temp:
        stage = Path(temp)
        runtime, runtime_hash = prepare_runtime(stage)
        tests = sorted(str(checked_file(source, name)) for name in source_manifest if name.startswith("test/") and name.endswith(".test.mjs"))
        if not tests:
            raise ValueError("Source package is missing its test suite.")
        clean_environment = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": str(stage), "TMPDIR": str(stage)}
        command([runtime / "bin/node", "--test", *tests], cwd=source, env=clean_environment)
        # Recheck after download/testing, before making persistent changes.
        preflight(source, snapshot)
        import pwd
        command(["groupadd", "--system", ACCOUNT])
        command(["useradd", "--system", "--gid", ACCOUNT, "--home-dir", STATE, "--no-create-home", "--shell", "/usr/sbin/nologin", ACCOUNT])
        account = pwd.getpwnam(ACCOUNT)
        BASE.mkdir(mode=0o755)
        BASE.chmod(0o755)
        app = BASE / "app"
        app.mkdir(mode=0o755)
        app.chmod(0o755)
        for name in source_manifest:
            destination = app.joinpath(*PurePosixPath(name).parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(checked_file(source, name), destination)
            destination.chmod(0o644)
        shutil.copyfile(source / "MANIFEST.json", app / "MANIFEST.json")
        (app / "MANIFEST.json").chmod(0o644)
        for directory in app.rglob("*"):
            if directory.is_dir():
                directory.chmod(0o755)
        shutil.copytree(runtime, BASE / "node", symlinks=True)
        (BASE / "node").chmod(0o755)
        # Preserve official executable/read bits after restrictive staging umask.
        for path in (BASE / "node").rglob("*"):
            if path.is_symlink():
                continue
            path.chmod(0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644)
        STATE.mkdir(mode=0o700)
        (STATE / "media").mkdir(mode=0o700)
        for name in snapshot_manifest["files"]:
            destination = STATE.joinpath(*PurePosixPath(name).parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(checked_file(snapshot, name), destination)
            destination.chmod(0o600)
            if digest(destination) != snapshot_manifest["files"][name]:
                raise ValueError("Installed state did not match its verified snapshot.")
        for path in [STATE, *STATE.rglob("*")]:
            os.chown(path, account.pw_uid, account.pw_gid)
            path.chmod(0o700 if path.is_dir() else 0o600)
        CONFIG.mkdir(mode=0o700)
        with open(CONFIG / "private.env", "x", encoding="utf-8") as environment:
            environment.write("# Reserved for verified Sunnyland integration settings. No mail worker is installed.\n")
        shutil.copyfile(app / "deploy/sunnyland-production.service", UNIT)
        UNIT.chmod(0o644)
        activated = False
        try:
            command(["systemd-analyze", "verify", UNIT])
            command(["systemctl", "daemon-reload"])
            command(["systemctl", "start", UNIT.name])
            wait_for_health()
            command(["systemctl", "restart", UNIT.name])
            wait_for_health()
            verify_installed_state(snapshot)
            command(["systemctl", "enable", UNIT.name])
            activated = True
        finally:
            if not activated:
                subprocess.run(["systemctl", "stop", UNIT.name], check=False)
                subprocess.run(["systemctl", "disable", UNIT.name], check=False)
                print("Installation stopped. Its state is retained; do not rerun over it or reset the account.", file=sys.stderr)
        receipt = {"service": UNIT.name, "host": HOST, "port": PORT, "runtime": VERSION, "runtimeArchiveSha256": runtime_hash, "snapshotDatabaseSha256": snapshot_manifest["files"]["production.sqlite"], "records": snapshot_manifest["records"], "health": "ok", "unauthenticatedState": 401, "restartVerified": True, "accountAndLedgerVerified": True, "enabledAtBoot": True, "proxyChanged": False, "workerInstalled": False}
        (BASE / "INSTALLATION.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True)
    options = parser.parse_args()
    try:
        install(Path(__file__).resolve().parents[1], Path(options.snapshot).resolve(strict=True))
    except Exception as error:
        print(f"INSTALLATION STOPPED: {error}", file=sys.stderr)
        sys.exit(1)
