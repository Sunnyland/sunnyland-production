import hashlib
import importlib.util
import json
import sqlite3
import shutil
import tempfile
import unittest
from contextlib import closing
from unittest.mock import patch
from pathlib import Path

module_path = Path(__file__).resolve().parents[1] / "deploy" / "backup_state.py"
spec = importlib.util.spec_from_file_location("sunnyland_backup_state", module_path)
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)
installer_path = module_path.with_name("install_printcrm.py")
installer_spec = importlib.util.spec_from_file_location("sunnyland_installer", installer_path)
installer = importlib.util.module_from_spec(installer_spec)
installer_spec.loader.exec_module(installer)


class BackupStateTests(unittest.TestCase):
    def make_source(self, root):
        source = root / "live"
        source.mkdir()
        (source / "media").mkdir()
        db = sqlite3.connect(source / "production.sqlite")
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA wal_autocheckpoint=0")
        db.execute("CREATE TABLE records(kind TEXT,id TEXT,doc TEXT)")
        db.execute("CREATE TABLE outbox(id TEXT)")
        for table in ("requests", "audit", "sessions", "failures"):
            db.execute(f"CREATE TABLE {table}(id TEXT)")
        user = {"id":"manager-1","enabled":True,"role":"manager","salt":"synthetic-salt","password":"synthetic-password-hash"}
        db.execute("INSERT INTO records VALUES (?,?,?)", ("user", user["id"], json.dumps(user)))
        media_id = "216f5bdd-d048-422f-915c-b7e8f2a9043f"
        content = b"synthetic immutable media"
        (source / "media" / media_id).write_bytes(content)
        media = {"id":media_id,"bytes":len(content),"sha256":hashlib.sha256(content).hexdigest()}
        db.execute("INSERT INTO records VALUES (?,?,?)", ("media", media_id, json.dumps(media)))
        db.commit()
        return source, db, user, media_id

    def test_live_wal_snapshot_preserves_account_and_media_without_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, live, user, media_id = self.make_source(root)
            try:
                self.assertGreater((source / "production.sqlite-wal").stat().st_size, 0)
                destination = root / "snapshot"
                result = backup.backup_state(source, destination)
                self.assertEqual(result["integrity"], "ok")
                with closing(sqlite3.connect(destination / "production.sqlite")) as restored:
                    saved = json.loads(restored.execute("SELECT doc FROM records WHERE kind='user'").fetchone()[0])
                    self.assertEqual(saved, user)
                    self.assertEqual(restored.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                self.assertEqual((source / "media" / media_id).read_bytes(), (destination / "media" / media_id).read_bytes())
                manifest = json.loads((destination / "snapshot.json").read_text())
                self.assertEqual(installer.validate_snapshot(destination.resolve())["records"], {"media": 1, "user": 1})
                self.assertTrue(manifest["containsPasswordHashes"])
                self.assertNotIn(user["password"], json.dumps(result))
                self.assertEqual(hashlib.sha256((destination / "production.sqlite").read_bytes()).hexdigest(), manifest["files"]["production.sqlite"])
                with self.assertRaisesRegex(ValueError, "already exists"):
                    backup.backup_state(source, destination)
                self.assertEqual(live.execute("SELECT count(*) FROM records").fetchone()[0], 2)
            finally:
                live.close()

    def test_corrupt_media_and_nested_snapshot_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, live, user, media_id = self.make_source(root)
            try:
                with self.assertRaisesRegex(ValueError, "outside"):
                    backup.backup_state(source, source / "snapshot")
                (source / "media" / media_id).write_bytes(b"changed")
                destination = root / "snapshot"
                with self.assertRaisesRegex(ValueError, "digest"):
                    backup.backup_state(source, destination)
                self.assertFalse((destination / "snapshot.json").exists())
            finally:
                live.close()

    def test_installer_checks_source_hashes_and_rejects_paths_outside_package(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp).resolve()
            names = ["server.mjs", "network.mjs", "core.mjs", "inventory.mjs", "printiq.mjs", "package.json", "deploy/install_printcrm.py", "deploy/sunnyland-production.service"]
            manifest = {}
            for name in names:
                path = source / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"synthetic source")
                manifest[name] = {"bytes":path.stat().st_size,"sha256":hashlib.sha256(path.read_bytes()).hexdigest()}
            manifest_path = source / "MANIFEST.json"
            manifest_path.write_text(json.dumps(manifest))
            self.assertEqual(installer.validate_source(source), manifest)
            (source / "server.mjs").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "checksum"):
                installer.validate_source(source)
            with self.assertRaisesRegex(ValueError, "Unsafe"):
                installer.checked_file(source, "../outside")
            with self.assertRaisesRegex(ValueError, "Unsafe"):
                installer.checked_file(source, "/outside")

    def test_installer_rejects_changed_snapshot_and_extra_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, live, user, media_id = self.make_source(root)
            try:
                snapshot = root / "snapshot"
                backup.backup_state(source, snapshot)
                manifest_path = snapshot / "snapshot.json"
                manifest = json.loads(manifest_path.read_text())
                (snapshot / "unrelated.txt").write_bytes(b"extra")
                manifest["files"]["unrelated.txt"] = hashlib.sha256(b"extra").hexdigest()
                manifest_path.write_text(json.dumps(manifest))
                with self.assertRaisesRegex(ValueError, "unexpected"):
                    installer.validate_snapshot(snapshot.resolve())
                del manifest["files"]["unrelated.txt"]
                manifest["records"]["user"] = 2
                manifest_path.write_text(json.dumps(manifest))
                with self.assertRaisesRegex(ValueError, "counts"):
                    installer.validate_snapshot(snapshot.resolve())
            finally:
                live.close()

    def test_installed_account_and_ledger_are_compared_without_exposing_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            source, live, user, media_id = self.make_source(root)
            try:
                snapshot = root / "snapshot"
                installed = root / "installed"
                backup.backup_state(source, snapshot)
                shutil.copytree(snapshot, installed)
                with patch.object(installer, "STATE", installed):
                    installer.verify_installed_state(snapshot)
                    with closing(sqlite3.connect(installed / "production.sqlite")) as changed:
                        user["password"] = "different-synthetic-hash"
                        changed.execute("UPDATE records SET doc=? WHERE kind='user'", (json.dumps(user),))
                        changed.commit()
                    with self.assertRaisesRegex(ValueError, "state changed.*records"):
                        installer.verify_installed_state(snapshot)
            finally:
                live.close()


if __name__ == "__main__":
    unittest.main()
