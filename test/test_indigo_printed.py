import json
import shutil
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "deploy"))
import indigo_printed as p

FIX = Path(__file__).resolve().parent / "fixtures" / "indigo"
NOW = datetime(2026, 11, 12, 1, 0, tzinfo=timezone.utc)
IP = "82f36c7615b14a0f9cadc4b3be1de4af"
PP = "e01f2e5393e74874bc3d75343d76a19e"


class FakeCache:
    class CacheError(Exception):
        pass

    @staticmethod
    def quantity_fields(raw, job, sha, now, tag):
        assert raw["AcceptanceDetails"]["Products"][0]["JobNo"] == job
        return {"issues": [], "printingOperations": [
            {"acceptedSectionKey": 901, "quotedSectionKey": 11, "operationKey": 5001, "pressKey": 51, "pressName": "Ryobi W/T"}]}


class FakeReader:
    token = "t"
    calls = 0

    def acceptance(self, job):
        FakeReader.calls += 1
        raise FakeCache.CacheError("http_404")

    def _read(self, path, params, body):
        FakeReader.calls += 1
        return ({"AcceptanceDetails": {"Products": [{"JobNo": "064238", "Quantity": 1700, "StatusName": "Complete",
                 "MiddlewareProductDetail": {"Sections": [{"QQDSKey": 11, "QPressKey": 51, "QPressName": "Ryobi W/T",
                 "PSSectionDescription": " 113gsm Silk Art printed CMYK x 2 sides ", "PSNUp": 4,
                 "QPrsShortNameFront": "CMYK", "QPrsShortNameReverse": "CMYK"}]}}]}}, "sha")


class Printed(unittest.TestCase):
    def test_press_ticket_counts_paper_sheets_not_the_component_counter(self):
        t = p.parse_ticket((FIX / "J064238-IP0D-ticket.jdf").read_bytes())
        self.assertEqual(t["sheets"], {"113gsm Sovereign Silk WHITE LG": 870})
        self.assertEqual(t["requested"], 1)
        self.assertEqual(sorted(t["separations"].values()), [1738, 1739, 1739, 1753])

    def test_cockpit_imposition_number_up_sides_and_paper(self):
        imposed = p.parse_imposition((FIX / "J064238-IP0D-imposed.jdf").read_bytes())
        self.assertEqual((imposed["up"], imposed["sheetsPerSet"], imposed["sides"], imposed["imposed"]), (2, 1, 2, True))
        self.assertEqual(imposed["media"], "113gsm Sovereign Silk WHITE LG")
        pages = p.parse_imposition((FIX / "J064238-PP0D-pages.jdf").read_bytes())
        self.assertFalse(pages["imposed"]); self.assertIsNone(pages["up"])
        simplex = p.parse_imposition((FIX / "J064265-signa-2up-simplex.jdf").read_bytes())
        self.assertEqual((simplex["up"], simplex["sides"]), (2, 1))

    def test_collect_joins_ticket_imposition_and_printiq(self):
        with tempfile.TemporaryDirectory() as d:
            state, share = Path(d) / "state", Path(d) / "PTJobs"
            state.mkdir()
            reports = share / "Jobs" / "2026-11-11" / "064238" / "RendererReports"
            (reports / "Imposed sheet_1").mkdir(parents=True); (reports / "FSWDS").mkdir()
            (share / "Jobs" / "2026-11-10" / "064241").mkdir(parents=True)
            shutil.copy(FIX / "J064238-IP0D-imposed.jdf", reports / "Imposed sheet_1" / f"D7_{IP}_in.jdf")
            shutil.copy(FIX / "J064238-PP0D-pages.jdf", reports / "FSWDS" / f"D7_{PP}_in.jdf")
            with sqlite3.connect(state / "observations.sqlite3") as db:
                db.execute("CREATE TABLE entries(queue_id TEXT, entry_json TEXT)")
                rows = [(IP, {"queueEntryId": IP, "nativeJobId": "064238", "jobPartId": "IP0.D", "status": "Completed", "submissionTime": "2026-11-11T09:45:41+11:00"}),
                        (PP, {"queueEntryId": PP, "nativeJobId": "064238", "jobPartId": "PP0.D", "status": "Completed", "submissionTime": "2026-11-11T08:53:45+11:00"}),
                        ("a" * 32, {"queueEntryId": "a" * 32, "nativeJobId": "064299", "status": "Running", "submissionTime": "2026-11-11T08:53:45+11:00"}),
                        ("b" * 32, {"queueEntryId": "b" * 32, "nativeJobId": "064100", "status": "Completed", "submissionTime": "2026-10-01T08:53:45+11:00"})]
                db.executemany("INSERT INTO entries VALUES (?,?)", [(q, json.dumps(e)) for q, e in rows])
            tickets = {IP: p.parse_ticket((FIX / "J064238-IP0D-ticket.jdf").read_bytes()),
                       PP: {"sheets": {"100 Offset": 1}, "waste": {}, "separations": {"Black": 2}, "requested": 1, "status": "Completed"}}
            snapshot, memo = p.collect(NOW, state=state, share=p.Share(str(share)), ticket=tickets.__getitem__, reader=FakeReader(), cache=FakeCache)
            self.assertEqual([j["job"] for j in snapshot["jobs"]], ["J064238"])
            job = snapshot["jobs"][0]
            self.assertEqual(job["printiq"]["quantity"], 1700)
            self.assertEqual(job["printiq"]["printiqJobNo"], "064238")
            self.assertEqual(job["printiq"]["sections"][0]["press"], "Ryobi W/T")
            self.assertEqual([e["part"] for e in job["entries"]], ["PP0.D", "IP0.D"])
            ip = job["entries"][1]
            self.assertEqual((ip["imposition"]["up"], ip["impositionState"], ip["ticket"]["sheets"]["113gsm Sovereign Silk WHITE LG"]), (2, "found", 870))
            self.assertEqual(job["entries"][0]["imposition"]["imposed"], False)
            self.assertTrue(all(h["ok"] for h in snapshot["health"].values()))
            # Second run within the hour: nothing read again.
            calls = FakeReader.calls
            again, _ = p.collect(NOW + timedelta(minutes=10), state=state, share=p.Share(str(share)),
                                 ticket=lambda q: self.fail("ticket re-read"), reader=FakeReader(), cache=FakeCache, memo=memo)
            self.assertEqual(FakeReader.calls, calls)
            self.assertEqual(again["jobs"][0]["entries"][1]["imposition"]["up"], 2)

    def test_missing_imposition_is_retried_then_reported_missing(self):
        with tempfile.TemporaryDirectory() as d:
            state, share = Path(d) / "state", Path(d) / "PTJobs"
            state.mkdir(); (share / "Jobs").mkdir(parents=True)
            with sqlite3.connect(state / "observations.sqlite3") as db:
                db.execute("CREATE TABLE entries(queue_id TEXT, entry_json TEXT)")
                db.execute("INSERT INTO entries VALUES (?,?)", (IP, json.dumps({"nativeJobId": "064238", "status": "Completed", "submissionTime": "2026-11-11T09:45:41+11:00"})))
            ticket = lambda q: {"sheets": {"x": 10}, "waste": {}, "separations": {}, "requested": 1}
            s1, memo = p.collect(NOW, state=state, share=p.Share(str(share)), ticket=ticket, reader=FakeReader(), cache=FakeCache)
            self.assertEqual(s1["jobs"][0]["entries"][0]["impositionState"], "looking")
            s2, memo = p.collect(NOW + timedelta(days=4), state=state, share=p.Share(str(share)), ticket=ticket, reader=FakeReader(), cache=FakeCache, memo=memo)
            # Older than the lookback? No: 4 days later is still inside it, and the search has given up.
            self.assertEqual(s2["jobs"][0]["entries"][0]["impositionState"], "missing")

    def test_smbclient_listing_lines_are_parsed(self):
        line = "  064238                              D        0  Wed Nov 11 08:50:20 2026"
        m = p.Share.LINE.match(line)
        self.assertEqual((m[1], m[2]), ("064238", "D"))
        spaced = "  064193 A2 Corflutes - Merbein C Park      D        0  Tue Nov 10 10:00:00 2026"
        self.assertEqual(p.Share.LINE.match(spaced)[1], "064193 A2 Corflutes - Merbein C Park")

    def test_an_odd_printiq_product_is_recorded_not_fatal(self):
        class Odd(FakeCache):
            @staticmethod
            def quantity_fields(*args):
                raise TypeError("banner product")
        with tempfile.TemporaryDirectory() as d:
            state = Path(d)
            with sqlite3.connect(state / "observations.sqlite3") as db:
                db.execute("CREATE TABLE entries(queue_id TEXT, entry_json TEXT)")
                db.execute("INSERT INTO entries VALUES (?,?)", (IP, json.dumps({"nativeJobId": "064238", "status": "Completed", "submissionTime": "2026-11-11T09:45:41+11:00"})))
            (state / "PTJobs" / "Jobs").mkdir(parents=True)
            snap, _ = p.collect(NOW, state=state, share=p.Share(str(state / "PTJobs")), ticket=lambda q: {"sheets": {"x": 3}, "separations": {}},
                                reader=FakeReader(), cache=Odd)
            self.assertIn("TypeError", snap["jobs"][0]["printiq"]["error"])

    def test_one_recursive_smbclient_listing_finds_every_cockpit_jdf(self):
        listing = "\n".join(["Domain=[PPMS]", "\\Jobs\\2026-11-11\\064238\\RendererReports\\FSWDS",
            f"  D7_{PP}_in.jdf      A    59450  Wed Nov 11 08:53:46 2026", "",
            "\\Jobs\\2026-11-11\\064238\\RendererReports\\Imposed sheet_1",
            f"  D7_{IP}_in.jdf      A    58789  Wed Nov 11 09:45:42 2026"])

        class Smb(p.Share):
            def __init__(self): self.root = None
            def _smb(self, commands, timeout=30): return listing

        files = Smb().cockpit_files("Jobs/2026-11-11/064238/RendererReports")
        self.assertEqual(files[f"D7_{IP}_in.jdf"], f"Jobs/2026-11-11/064238/RendererReports/Imposed sheet_1/D7_{IP}_in.jdf")
        self.assertEqual(len(files), 2)


if __name__ == "__main__":
    unittest.main()
