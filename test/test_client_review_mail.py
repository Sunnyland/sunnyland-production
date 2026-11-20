import sys
import unittest
from email import policy
from email.parser import BytesParser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mail_transport import send
from test_mail import SMTPFake


class ClientMailTests(unittest.TestCase):
    def test_client_code_email(self):
        messages = []

        class Capture(SMTPFake):
            def data(self, raw):
                messages.append(BytesParser(policy=policy.default).parsebytes(raw))
                return 250, b'accepted by test transport'

        env = {'SMTP_ENABLED':'true', 'SMTP_FROM':'press@example.test', 'SMTP_HOST':'smtp.example.test'}
        event = {'kind':'client_review_code', 'job':'J100', 'code':'01234567', 'to':'client@example.test'}
        result = send({'id':'test-only', 'event':event}, env, Capture)
        self.assertEqual(result['state'], 'accepted')
        self.assertEqual(messages[0]['To'], event['to'])
        self.assertIn(event['code'], messages[0].get_content())
        self.assertIn('J100', messages[0].get_content())
        self.assertNotIn('01234567', str(messages[0]['Subject']))
        event['code'] = '123'
        self.assertEqual(send({'id':'test-only', 'event':event}, env, Capture)['state'], 'blocked')
        self.assertEqual(len(messages), 1)
