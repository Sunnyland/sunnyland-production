"""One message per process; stdout is a receipt, never credentials."""
import sys,json,os,ssl,smtplib,re,hashlib
from email.message import EmailMessage
from email.policy import SMTP
from datetime import datetime,timezone

def send(payload, env=os.environ, smtp_factory=None):
    required=['SMTP_HOST','SMTP_FROM']
    if env.get('SMTP_ENABLED')!='true' or any(not env.get(k) for k in required):
        return {'state':'blocked','receipt':{'reason':'Existing Sunnyland SMTP service is not configured/enabled.'}}
    event=payload['event']; to=event['to']; sender=env['SMTP_FROM']
    if any(not re.fullmatch(r'[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+', x) for x in [to,sender]):
        return {'state':'blocked','receipt':{'reason':'Invalid sender or recipient.'}}
    mode=env.get('SMTP_TLS','starttls')
    if mode not in ('starttls','tls'): return {'state':'blocked','receipt':{'reason':'TLS is required.'}}
    msg=EmailMessage(policy=SMTP); msg['From']=sender;msg['To']=to
    msg['Message-ID']='<sunnyland-'+hashlib.sha256(payload['id'].encode()).hexdigest()+'@'+sender.split('@')[1]+'>'
    msg['Date']=datetime.now(timezone.utc)
    if event['kind']=='client_review_code':
        if not re.fullmatch(r'[0-9]{8}',event.get('code','')):
            return {'state':'blocked','receipt':{'reason':'Invalid verification code.'}}
        msg['Subject']='Your Sunnyland Press sample review code'
        msg.set_content('Your code for the sample on job '+event['job']+' is '+event['code']+'. It expires in 10 minutes. If you did not request this code, you can ignore this email.')
    elif event['kind']=='production_alert':
        # Indigo agent reminders and alerts: the service writes the subject and plain-text body.
        subject,text=event.get('subject'),event.get('text')
        if not isinstance(subject,str) or not isinstance(text,str) or not subject.strip() or len(subject)>200 or len(text)>5000 or re.search(r'[\r\n]',subject):
            return {'state':'blocked','receipt':{'reason':'Invalid production alert.'}}
        msg['Subject']=subject.strip()
        msg.set_content(text+'\n\nSent by the Sunnyland Production Indigo agent.')
    else:
        msg['Subject']=event['job']+' - '+event['kind'].replace('_',' ')+' - '+event['title']
        msg.set_content('Job: '+event['job']+'\nSample: '+event['title']+'\nUpdate: '+event['kind'].replace('_',' ')+'\n\nOpen Sunnyland Production, select Samples and review this exact version.\nSample ID: '+event['sample']+'\n\nThe app shows the current approval state. This is a production sample review, separate from final customer proof approval.\n')
    client=None; data_started=False
    try:
        context=ssl.create_default_context()
        if smtp_factory: client=smtp_factory()
        elif mode=='tls': client=smtplib.SMTP_SSL(env['SMTP_HOST'],int(env.get('SMTP_PORT','465')),timeout=30,context=context)
        else: client=smtplib.SMTP(env['SMTP_HOST'],int(env.get('SMTP_PORT','587')),timeout=30)
        client.ehlo()
        if mode=='starttls': client.starttls(context=context);client.ehlo()
        if env.get('SMTP_USERNAME'): client.login(env['SMTP_USERNAME'],env.get('SMTP_PASSWORD',''))
        code,reply=client.mail(sender)
        if code!=250: return {'state':'rejected','receipt':{'reason':'SMTP rejected MAIL FROM','code':code}}
        code,reply=client.rcpt(to)
        if code not in (250,251): return {'state':'rejected','receipt':{'reason':'SMTP rejected recipient','code':code}}
        data_started=True
        code,reply=client.data(msg.as_bytes())
        if code!=250: return {'state':'rejected','receipt':{'reason':'SMTP rejected message DATA','code':code}}
        return {'state':'accepted','receipt':{'acceptedAt':datetime.now(timezone.utc).isoformat(),'messageId':str(msg['Message-ID']),'smtpCode':code,'response':reply.decode(errors='replace')[:1000]}}
    except smtplib.SMTPResponseException as e:
        return {'state':'rejected','receipt':{'reason':type(e).__name__,'code':e.smtp_code}}
    except Exception as e:
        return {'state':'uncertain' if data_started else 'rejected','receipt':{'reason':type(e).__name__,'afterDataStarted':data_started}}
    finally:
        if client:
            try: client.close()
            except Exception: pass

if __name__=='__main__':
    try: print(json.dumps(send(json.load(sys.stdin))))
    except Exception as e: print(json.dumps({'state':'blocked','receipt':{'reason':type(e).__name__}}))
