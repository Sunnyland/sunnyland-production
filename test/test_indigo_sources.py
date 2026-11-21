import io
import json
import re
import sys
import unittest
from datetime import datetime,timezone
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"deploy"))
import indigo_sources as m
NOW=datetime(2026,11,20,1,tzinfo=timezone.utc)
STAMP=int(NOW.timestamp()*1000)-60_000
class Sources(unittest.TestCase):
    def test_all_205_jobs_are_checked_within_the_live_filter_limit(self):
        numbers=[f"J{i:06d}" for i in range(1,206)]
        requests=[]
        def read(params):
            spellings=re.findall(r"JobNo eq '([^']+)'",params['$filter'])
            self.assertLessEqual(len(spellings),20)
            group=spellings[::2]
            self.assertEqual(spellings[1::2],[key[1:] for key in group])
            requests.extend(group)
            rows=[{'Id':int(key[1:]),'JobNo':key[1:]} for key in group]
            if numbers[-1] in group:rows.append({'Id':900,'JobNo':numbers[-1]})
            return {'value':rows}
        result=m.odata(numbers+['000001A','J000205B'],read)
        self.assertEqual(requests,numbers)
        self.assertEqual(len(result),205)
        self.assertIsNone(result[numbers[-1]])
        self.assertEqual(result[numbers[-2]]['Id'],204)

    def test_report_http_stage_and_status_without_request_details(self):
        def denied(*_):
            raise m.HTTPError("https://example.invalid/?token=private",403,"private response",{},io.BytesIO())
        with self.assertRaises(m.SourceHTTPError) as error:
            m.checked_read("planning job-number lookup",m.odata,["J064500"],denied)
        self.assertEqual(str(error.exception),"printIQ planning job-number lookup returned HTTP 403")

    def test_design_letters_resolve_once_and_both_supplier_spellings_are_checked(self):
        rows=self.read([(1,'064500A','PageApproved'),(2,'J064500b','PageApproved'),(3,'064500-01a','ProofSent')])
        self.assertEqual(set(rows),{'J064500','J064500-01'})
        self.assertTrue(rows['J064500']['approved'])
        self.assertFalse(rows['J064500-01']['approved'])
        self.assertFalse(self.read([(1,'064500A','ProofSent'),(2,'064500B','PageApproved')])['J064500']['approved'])
        def read(q):
            self.assertEqual(q['$filter'],"JobNo eq 'J000123' or JobNo eq '000123'")
            return {'value':[{'JobNo':'000123','Id':8}]}
        self.assertEqual(m.odata(['000123a','J000123B'],read)['J000123']['Id'],8)
        self.assertEqual(m.odata(['000123A'],lambda _:{'value':[{'JobNo':'000123','Id':8},{'JobNo':'J000123','Id':9}]}),{'J000123':None})
        with self.assertRaises(ValueError):
            m.odata(['000123A'],lambda _:{'value':[{'JobNo':'000124','Id':8}]})

    def test_lettered_press_entries_stay_distinct_and_flag_the_same_job_for_reconciliation(self):
        entries=[(key,{'nativeJobId':source,'submissionTime':'2026-11-18T09:00:00+11:00'})
                 for key,source in [('q1','064500A'),('q2','J064500B'),('q3','064500-01B')]]
        history,risks=m.press_evidence(entries,{'jobs':[]},NOW)
        self.assertEqual([r['sourceJob'] for r in history],['064500A','J064500B','064500-01B'])
        self.assertEqual([r['job'] for r in history],['J064500','J064500','J064500-01'])
        self.assertEqual(len(risks['J064500']),2)

    def test_acceptance_read_uses_the_verified_directory_spelling(self):
        class Reader:
            token='fixture'
            def acceptance(self,k):return k
            def _read(self,path,query,body):
                return path,body
        self.assertEqual(m.read_acceptance(Reader(),'J000123','J000123'),'J000123')
        self.assertEqual(m.read_acceptance(Reader(),'J000123','000123'),('/api/QuoteProcess/GetAcceptanceDetails',{'JobNo':'000123'}))
        with self.assertRaises(ValueError):m.read_acceptance(Reader(),'J000123','000124')

    def read(self,lines):
        def get(month):
            body=lines if month=="History.26_11.csv" else []
            return ("date;severity;jobid;event\n"+"".join(str(STAMP+i)+";info;"+j+";Milestone reached: "+k+"\n" for i,j,k in body)).encode()
        return m.approvals(get,NOW)
    def test_approval_is_current_and_component_exact(self):
        rows=self.read([(1,"064500-01","PageApproved"),(2,"064500-02","ProofSent"),(3,"064502","PageApproved"),(4,"064502","PageRejected"),(5,"064503","PageProductionApproved")])
        self.assertTrue(rows['J064500-01']['approved']);self.assertFalse(rows['J064500-02']['approved']);self.assertFalse(rows['J064502']['approved']);self.assertNotIn("J064503",rows)
    def test_unapproved_child_blocks_parent_and_malformed_journal_fails(self):
        a=self.read([(1,"064500","PageApproved"),(2,"064500a","ProofSent")]);self.assertFalse(a['J064500']['approved'])
        with self.assertRaises(ValueError):m.approvals(lambda _:b"job,approved\n",NOW)
    def test_backfill_uses_submission_or_physical_date_with_exclusive_boundary(self):
        q=[('a',{'nativeJobId':'064500','submissionTime':'2026-11-05T23:50:00+11:00'}),('b',{'nativeJobId':'064501','submissionTime':'2026-11-20T00:00:00+11:00'}),('c',{'nativeJobId':'not-a-job','submissionTime':'2026-11-19T10:00:00+11:00'})]
        r={'sourceExactIDs':{'queueEntryId':'a'},'state':'observedPrinted','printedAt':'2026-11-06T00:10:00+11:00','actualOutput':2,'purpose':'proof','historical':True}
        h,risk=m.press_evidence(q,{'jobs':[{'jobNo':'J064500','results':[r]}]},NOW)
        self.assertEqual([e['entry'] for e in h],['a','c']);self.assertIsNone(h[1]['job']);self.assertNotIn('J064500',risk);self.assertIn('J064501',risk)
    def test_unmapped_count_or_queue_state_never_is_a_native_finish(self):
        q=[('a',{'nativeJobId':'064500','submissionTime':'2026-11-18T08:00:00+11:00'})]
        r={'sourceExactIDs':{'queueEntryId':'a'},'state':'observedPrinted','printedAt':'2026-11-18T09:00:00+11:00','actualOutput':1,'purpose':'unknown'}
        h,risk=m.press_evidence(q,{'jobs':[{'jobNo':'J064500','results':[r]}]},NOW);self.assertEqual(h[0]['evidence'],'physical output');self.assertIn('J064500',risk)
    def test_all_directory_pages_even_when_service_uses_small_pages(self):
        responses=iter([{'value':[{'Id':1,'JobNo':'J064500','ProductionStatusId':2}],'@odata.nextLink':'unused'},{'value':[{'Id':2,'JobNo':'J064501','ProductionStatusId':2}]}])
        self.assertEqual(len(m.directory_approved(lambda q:next(responses),{2})),2)
        self.assertEqual(m.directory_approved(None,set()),{})

class Speeds(unittest.TestCase):
    def section(self, front="CMYK", back="None", **fields):
        return {"PrintedQStockSizeName":"450 × 320 mm", "PSTotalSheetsToPrint":1000,
                "QPrsShortNameFront":front, "QPrsShortNameReverse":back, **fields}

    def test_standard_faces_and_mixed_duplex(self):
        for front, back, minutes in [
            ("CMYK", "None", 27), ("CMYK", "CMYK", 44), ("CMYK", "Black", 35),
            ("EPM", "Unprinted", 23), ("Enhanced Productivity Mode", "EPM", 35),
            ("two-color", "Blank", 19), ("K", "Monochrome", 27), ("EPM", "Black", 31),
        ]:
            with self.subTest(front=front, back=back):
                self.assertEqual(m.press_estimate(self.section(front, back)), (minutes, None))
        self.assertEqual(m.press_estimate(self.section("CMYK", "Black", QPressOptionName="EPM")), (31, None))

    def test_round_once_use_accepted_press_sheets_once(self):
        row = self.section("CMYK", "CMYK", PSTotalSheetsToPrint=1, PSNUp=24, PSFinishSheets=2, PSMakeReadySpoils=18)
        self.assertEqual(m.press_estimate(row), (11, None))
        row["PSTotalSheetsToPrint"] = 30
        self.assertEqual(m.press_estimate(row), (11, None))

    def test_rotated_dimensions_and_numerical_printed_stock(self):
        for name in ("320x450", "450.0 x 320 mm", "SRA3"):
            self.assertEqual(m.press_estimate(self.section(PrintedQStockSizeName=name)), (27, None))
        measured = dict(PrintedStockSheetWidth={"mm":320}, PrintedStockSheetDepth={"mm":450})
        self.assertEqual(m.press_estimate(self.section(PrintedQStockSizeName="", **measured)), (27, None))
        for data in ({"PrintedQStockSizeName":"SRA2"}, {"PrintedQStockSizeName":None},
                     {"PrintedQStockSizeName":"320x460", **measured},
                     {"PrintedStockSheetWidth":{"mm":340}, "PrintedStockSheetDepth":{"mm":460}},
                     {"PrintedQStockSizeName":"330x490"}):
            self.assertIsNone(m.press_estimate(self.section(**data))[0])

    def test_pre_trim_sheets_up_to_the_indigo_maximum_use_the_same_rate(self):
        for name in ("324x454 Pre Trim", "480x320 Pre Trim", "330 x 482 mm"):
            self.assertEqual(m.press_estimate(self.section(PrintedQStockSizeName=name)), (27, None))
        pre = dict(PrintedStockSheetWidth={"mm":324}, PrintedStockSheetDepth={"mm":454})
        self.assertEqual(m.press_estimate(self.section(PrintedQStockSizeName="324x454 Pre Trim", **pre)), (27, None))
        self.assertIsNone(m.press_estimate(self.section(PrintedQStockSizeName="320x450", **pre))[0])

    def test_only_finishing_work_counts_as_finishing(self):
        for name in ("Local Delivery", "No Guillo", "Concept, Design and Layout x0.5 hours", "Die Library", "PDF Proof Prue Piez",
                     "Base Charges - Applies to all jobs", "Invoicing fee", "Printing", "Plate for Ryobi 754", "Paper Stock Draw"):
            self.assertTrue(m.NOT_FINISHING.search(name), name)
        for name in ("Guillotine", "Guillotine Pre-Trim", "Gloss Laminate", "Handwork Staple", "Machine Collate", "Perforation ",
                     "Numbers from  17301", "Diecut using library die", "Saddle Stitch (flat Sheet)", "Drill", "Drying"):
            self.assertFalse(m.NOT_FINISHING.search(name), name)

    def test_unknown_special_missing_and_conflicting_inputs(self):
        for data in ({"QPrsShortNameFront":"CMYK + White"}, {"QPrsShortNameFront":"3 colours"},
                     {"QPrsDescriptionFront":"EPM"}, {"QPrsShortNameReverse":None},
                     {"QPressOptionName":"Double hit"}, {"PSTotalSheetsToPrint":0}, {"PSTotalSheetsToPrint":True}):
            with self.subTest(data=data):
                minutes, reason=m.press_estimate(self.section(**data))
                self.assertIsNone(minutes)
                self.assertTrue(reason)

    def test_single_sided_description_confirms_empty_reverse_process(self):
        row=self.section(back=None, QPrsKeyReverse=None, QPrsDescriptionReverse=None,
                         QPrsExternalCodeReverse=None, PSPrintDescription="150gsm Silk CMYK x 1 side")
        self.assertEqual(m.press_estimate(row), (27, None))
        row["PSPrintDescription"]="150gsm Silk CMYK x 2 sides"
        self.assertIsNone(m.press_estimate(row)[0])

class Projection(unittest.TestCase):
    def test_exact_section_press_stock_finished_jobs_and_existing_press_output(self):
        class Cache:
            @staticmethod
            def quantity_fields(raw,*_):
                return {"acceptanceProductKey":101,"productKey":202,"issues":[],"printingOperations":[
                    {"operationKey":303,"quotedSectionKey":404,"acceptedSectionKey":505,"pressKey":64},
                    {"operationKey":304,"quotedSectionKey":406,"acceptedSectionKey":506,"pressKey":71}]}
        job='J064500'
        remote={'Id':101,'QuotedProductDetailId':606,'DueDate':'2026-11-24'}
        prod={'JobNo':job,'StatusName':'Preflight Ready','QuantityKey':606,'MiddlewareProductDetail':{'Sections':[
            {'QQDSKey':404,'QPressKey':64,'QStockCode':'ABC','PrintedQStockSizeName':'320x450','PSTotalSheetsToPrint':500,
             'QPrsShortNameFront':'CMYK','QPrsShortNameReverse':'None'},
            {'QQDSKey':406,'QPressKey':71,'QStockCode':'OTHER','PSTotalSheetsToPrint':300}],
            'Operations':[{'QQDSKey':404,'POOperationName':'Printing'},{'QQDSKey':404,'POOperationName':'Fold'},{'QQDSKey':406,'POOperationName':'Laminate'},
              {'QQDSKey':None,'POOperationName':'Handwork Glue'},{'QQDSKey':None,'POOperationName':'PDF Proof Prue Piez'},
              {'QQDSKey':None,'POOperationName':'Base Charges - Applies to all jobs'},{'QQDSKey':None,'POOperationName':'Cartons'},
              {'QQDSKey':404,'POOperationName':'Plate for Ryobi 754'},{'QQDSKey':None,'POOperationName':'Dispatch'}]}}
        raw=({'AcceptanceDetails':{'Products':[prod]}},'digest')
        def run(approval=True,risks=()):return m.project(job,remote,raw,{'approved':approval},risks,Cache,NOW)
        self.assertEqual(run(False)['runs'],[])
        self.assertEqual(run(True,[{'reason':'Check press output'}])['state'],'Check press output')
        runs=run()['runs'];self.assertEqual(len(runs),1);self.assertEqual((runs[0]['stock'],runs[0]['finishes'],runs[0]['minutes']),('ABC 320x450','Fold, Handwork Glue',19))
        self.assertEqual(runs[0]['finishOps'],[{'name':'Fold'},{'name':'Handwork Glue'}])
        binding=runs[0]['operation']
        prod['JobNo']='064500'
        self.assertEqual(run()['runs'][0]['operation'],binding)
        self.assertEqual(prod['JobNo'],'064500')
        raw[0]['AcceptanceDetails']['Products'].append({**prod,'JobNo':'J064500'})
        with self.assertRaises(ValueError):run()
        raw[0]['AcceptanceDetails']['Products'].pop()
        prod['StatusName']='Complete';self.assertEqual(run()['state'],'complete');self.assertFalse(run()['runs'])
        remote['QuotedProductDetailId']=99
        with self.assertRaises(ValueError):run()
