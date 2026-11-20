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
    def env(self): return {'SMTP_ENABLED':'true','SMTP_HOST':'test.invalid','SMTP_FROM':'service@example.test'}
    def payload(self): return {'id':'123','event':{'to':'rep@example.test','job':'J100','kind':'sample_ready','title':'Fold','sample':'s1'}}
if __name__=='__main__':unittest.main()
