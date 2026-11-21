import json
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "deploy"))
import indigo_watch as w

NOW = datetime(2026, 11, 21, 3, 0, tzinfo=timezone.utc)


class Watch(unittest.TestCase):
    def test_queue_groups_by_job_and_reports_unnumbered_recent_entries(self):
        entries = [("a", {"nativeJobId": "064379", "status": "Completed", "submissionTime": "2026-11-20T09:00:00+11:00"}),
                   ("b", {"nativeJobId": "J064379", "status": "Running", "submissionTime": "2026-11-21T10:00:00+11:00"}),
                   ("c", {"nativeJobId": "000000", "jobPartId": "IP0.D", "status": "Running", "submissionTime": "2026-11-21T13:00:00+11:00"}),
                   ("d", {"nativeJobId": "000000", "submissionTime": "2026-11-10T13:00:00+11:00"})]
        queue, unmatched = w.queue_state(entries, NOW)
        self.assertEqual(list(queue), ["J064379"])
        self.assertEqual(queue["J064379"]["entries"], 2)
        self.assertEqual(queue["J064379"]["status"], "Running")
        self.assertEqual([u["queueEntryId"] for u in unmatched], ["c"])

    def test_indigo_health_needs_a_recent_connected_report(self):
        fresh = {"sourceStatus": {"state": "connected", "lastSuccessfulAt": (NOW - timedelta(minutes=2)).isoformat()}}
        stale = {"sourceStatus": {"state": "connected", "lastSuccessfulAt": (NOW - timedelta(minutes=30)).isoformat()}}
        self.assertTrue(w.indigo_health(fresh, NOW)["ok"])
        self.assertFalse(w.indigo_health(stale, NOW)["ok"])
        self.assertFalse(w.indigo_health({"sourceStatus": {"state": "error"}}, NOW)["ok"])
        self.assertFalse(w.indigo_health(None, NOW)["ok"])

    def test_collect_keeps_recent_approvals_and_survives_missing_sources(self):
        month = b"date;severity;jobid;event\n"
        recent = int((NOW - timedelta(hours=1)).timestamp() * 1000); old = int((NOW - timedelta(days=60)).timestamp() * 1000)
        month += f"{recent};info;J064379;Milestone reached: PageApproved\n{old};info;J060001;Milestone reached: PageApproved\n".encode()
        with tempfile.TemporaryDirectory() as d:
            state = Path(d)
            with sqlite3.connect(state / "observations.sqlite3") as db:
                db.execute("CREATE TABLE entries(queue_id TEXT, entry_json TEXT)")
                db.execute("INSERT INTO entries VALUES (?,?)", ("q1", json.dumps({"nativeJobId": "064379", "submissionTime": NOW.isoformat()})))
            (state / "status.json").write_text(json.dumps({"sourceStatus": {"state": "connected", "lastSuccessfulAt": NOW.isoformat()}}))
            watch = w.collect(NOW, read_journal=lambda name: month if name == "History.26_11.csv" else b"date;severity;jobid;event\n", state=state)
            self.assertEqual(list(watch["approvals"]), ["J064379"])
            self.assertIn("J064379", watch["queue"])
            self.assertTrue(watch["health"]["indigo"]["ok"] and watch["health"]["cockpit"]["ok"])
            missing = w.collect(NOW, read_journal=lambda name: b"", state=Path(d) / "nothing")
            self.assertFalse(missing["health"]["cockpit"]["ok"])
            self.assertFalse(missing["health"]["indigo"]["ok"])


if __name__ == "__main__":
    unittest.main()
