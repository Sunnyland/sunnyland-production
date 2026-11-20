"""Create a new private migration snapshot without changing the source ledger.

The snapshot contains password hashes. Transfer it directly to the app server;
never include it in the source ZIP or upload it with the deployment documents.
"""
import argparse
import hashlib
import json
import re
import shutil
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path


def backup_state(source, destination):
    source = Path(source).resolve(strict=True)
    destination = Path(destination).resolve()
    if destination.exists():
        raise ValueError("Destination already exists; choose a new snapshot directory.")
    if source == destination or source in destination.parents:
        raise ValueError("Keep the snapshot outside the live data directory.")
    db_path = source / "production.sqlite"
    if not db_path.is_file():
        raise ValueError("Source database is missing.")
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    target_path = destination / "production.sqlite"
    with closing(sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True)) as original:
        with closing(sqlite3.connect(target_path)) as target:
            original.backup(target)
            target.execute("PRAGMA journal_mode=DELETE")
            if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("Snapshot integrity check failed.")
            records = dict(target.execute("SELECT kind, count(*) FROM records GROUP BY kind"))
            media = [json.loads(row[0]) for row in target.execute("SELECT doc FROM records WHERE kind='media'")]
            outbox = target.execute("SELECT count(*) FROM outbox").fetchone()[0]
            users = [json.loads(row[0]) for row in target.execute("SELECT doc FROM records WHERE kind='user'")]
            if not any(u.get("enabled") and u.get("role") == "manager" for u in users):
                raise ValueError("Snapshot has no enabled manager; do not deploy it.")
    target_path.chmod(0o600)
    media_dir = destination / "media"
    media_dir.mkdir(mode=0o700)
    hashes = {}
    for item in media:
        media_id = item["id"]
        if not re.fullmatch(r"[0-9a-fA-F-]{36}", media_id):
            raise ValueError("Unexpected media identity; stop and inspect the source.")
        source_file = source / "media" / media_id
        if source_file.is_symlink():
            raise ValueError("Media symlinks are not supported.")
        target_file = media_dir / media_id
        shutil.copyfile(source_file, target_file)
        target_file.chmod(0o600)
        digest = hashlib.sha256(target_file.read_bytes()).hexdigest()
        if digest != item["sha256"] or target_file.stat().st_size != item["bytes"]:
            raise ValueError("Media snapshot did not match its stored digest.")
        hashes["media/" + media_id] = digest
    hashes["production.sqlite"] = hashlib.sha256(target_path.read_bytes()).hexdigest()
    manifest = {
        "format": "sunnyland-state-snapshot-v1",
        "createdUtc": datetime.now(timezone.utc).isoformat(),
        "records": records,
        "outboxCount": outbox,
        "files": hashes,
        "containsPasswordHashes": True,
        "sourceWasStopped": False,
        "cutoverNote": "Pause all source writes and take a fresh snapshot immediately before cutover. Never run two writable ledgers.",
    }
    manifest_path = destination / "snapshot.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    manifest_path.chmod(0o600)
    return {"path": str(destination), "records": records, "outboxCount": outbox, "mediaFiles": len(media), "integrity": "ok"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_data")
    parser.add_argument("destination")
    args = parser.parse_args()
    print(json.dumps(backup_state(args.source_data, args.destination)))
