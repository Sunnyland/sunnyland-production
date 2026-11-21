import unittest,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from mail_transport import send
class SMTPFake:
    def ehlo(self): pass
    def starttls(self,**kw): pass
    def mail(self,*a): return 250,b'ok'
    def rcpt(self,*a): return 250,b'ok'
    def data(self,*a): return 250,b'queued as TEST-123'
    def close(self): pass
class MailTests(unittest.TestCase):
    def test_accepted_receipt(self):
        r=send(self.payload(),self.env(),SMTPFake)
        self.assertEqual(r['state'],'accepted');self.assertEqual(r['receipt']['smtpCode'],250);self.assertIn('TEST-123',r['receipt']['response'])
    def test_ambiguous_data_no_resend(self):
        class Lost(SMTPFake):
            def data(self,*a): raise TimeoutError()
        self.assertEqual(send(self.payload(),self.env(),Lost)['state'],'uncertain')
    def test_disabled(self): self.assertEqual(send(self.payload(),{})['state'],'blocked')
    def test_production_alert_uses_its_own_subject_and_rejects_header_injection(self):
        sent=[]
        class Capture(SMTPFake):
            def data(self,message): sent.append(message);return 250,b'ok'
        event={'to':'paul@sunnyland.com.au','kind':'production_alert','job':'J064379','subject':'J064379 needs artwork approval by tomorrow','text':'Due: Friday'}
        self.assertEqual(send({'id':'a1','event':event},self.env(),Capture)['state'],'accepted')
        self.assertIn(b'Subject: J064379 needs artwork approval by tomorrow',sent[0]);self.assertIn(b'Indigo agent',sent[0])
        for bad in ({'subject':'x\nBcc: someone@example.test'},{'subject':''},{'text':None}):
            self.assertEqual(send({'id':'a2','event':{**event,**bad}},self.env(),Capture)['state'],'blocked')
    def env(self): return {'SMTP_ENABLED':'true','SMTP_HOST':'test.invalid','SMTP_FROM':'service@example.test'}
    def payload(self): return {'id':'123','event':{'to':'rep@example.test','job':'J100','kind':'sample_ready','title':'Fold','sample':'s1'}}
if __name__=='__main__':unittest.main()
