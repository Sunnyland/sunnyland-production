import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "deploy"))
import indigo_press as p

NOW = datetime(2026, 11, 23, 5, 0, tzinfo=timezone.utc)  # 16:00 at the plant
def job(pos, status, name, jid, copies=110, sheets=257, substrate='"80 Offset" 1~257'):
    return {"properties": {"position": str(pos), "Job_StatusEN": status, "Name": name, "Job_Id": jid, "Copy_Range": str(copies),
                           "Sheets": str(sheets), "Substrate_Name": substrate, "Duplex": "Yes"}}

class Press(unittest.TestCase):
    def test_job_numbers_from_press_job_names(self):
        self.assertEqual(p.job_number("064248b VK The Mallee's Living Histories Book Vol 8 Text V3"), "J064248")
        self.assertEqual(p.job_number("J064415 Kim Huang - Bag Label A5"), "J064415")
        self.assertEqual(p.job_number("J064489-1_cards.pdf"), "J064489-01")
        self.assertEqual(p.job_number("064248a__W2PLayout_FB 001__F.pdf"), "J064248")
        self.assertIsNone(p.job_number("Imaging Associates A4 Reorder Sheet - DO NOT DELETE"))
        self.assertIsNone(p.job_number("0642489 too long"))

    def test_printing_job_runs_and_minutes(self):
        q1 = p.queue_rows({"Jobs": [job(1, "needs attention", "J064415 Bag Label", "114660"), job(0, "printing", "064248b VK Mallee Text", "114358")]})
        self.assertEqual([r["position"] for r in q1], [0, 1])
        self.assertEqual(q1[0]["substrate"], "80 Offset")
        s1 = p.advance(None, "Printing", q1, NOW)
        self.assertEqual(s1["printing"]["job"], "J064248"); self.assertEqual(s1["printing"]["since"], NOW.isoformat())
        self.assertEqual([r["job"] for r in s1["loaded"]], ["J064415"])
        s2 = p.advance(s1, "Printing", q1, NOW + timedelta(minutes=1))
        self.assertEqual(s2["printing"]["since"], NOW.isoformat(), "same job keeps its start")
        self.assertEqual(s2["today"]["printingMinutes"], 1.0)
        q2 = p.queue_rows({"Jobs": [job(0, "printing", "J064415 Bag Label", "114660", copies=430, sheets=1)]})
        s3 = p.advance(s2, "Printing", q2, NOW + timedelta(minutes=41))
        self.assertEqual(s3["history"][-1]["job"], "J064248"); self.assertEqual(s3["history"][-1]["minutes"], 41.0)
        self.assertEqual(s3["today"]["printingMinutes"], 1.0, "a 40-minute gap is not counted")
        s4 = p.advance(s3, "Idle", [], NOW + timedelta(minutes=42))
        self.assertIsNone(s4["printing"]); self.assertEqual(s4["history"][-1]["job"], "J064415")
        self.assertEqual(s4["today"]["printingMinutes"], 2.0)
        s5 = p.advance(s4, "Idle", [], NOW + timedelta(minutes=44))
        self.assertEqual(s5["today"]["stoppedMinutes"], 2.0); self.assertEqual(s5["press"]["since"], s4["press"]["since"])
        held = p.queue_rows({"Jobs": [job(0, "needs attention", "J064343 ELT 2027 Posters Lay", "114800", copies=1, sheets=281)]}, "held")
        s7 = p.advance(s5, "Idle", [], NOW + timedelta(minutes=45), held)
        self.assertEqual(s7["loaded"][0]["job"], "J064343"); self.assertEqual(s7["loaded"][0]["location"], "held")
        # A new plant day starts the minutes again; history is kept.
        s6 = p.advance(s5, "Idle", [], NOW + timedelta(hours=10))
        self.assertEqual(s6["today"]["printingMinutes"], 0); self.assertEqual(len(s6["history"]), 2)

if __name__ == "__main__":
    unittest.main()
