"""Private console password entry for an already-provisioned manager."""
import argparse,getpass,json,os,shutil,subprocess
from pathlib import Path

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--email',required=True)
    parser.add_argument('--node',default=os.environ.get('NODE_BINARY') or shutil.which('node'))
    args=parser.parse_args()
    print('SUNNYLAND PRODUCTION - MANAGER PASSWORD\n')
    print('Account: '+args.email)
    print('Choose at least 14 characters. Your typing will not be displayed.\n')
    if not args.node: raise RuntimeError('Node.js was not found.')
    while True:
        password=getpass.getpass('New password: ')
        confirm=getpass.getpass('Repeat password: ')
        if len(password)>=14 and password==confirm:break
        print('Use at least 14 characters and enter the same password twice.\n')
    result=subprocess.run([args.node,str(Path(__file__).with_name('provision.mjs')),'activate'],input=json.dumps({'email':args.email,'password':password}),text=True,encoding='utf8',capture_output=True)
    password=confirm=None
    if result.returncode:raise RuntimeError(result.stderr.strip() or 'Account activation was not confirmed.')
    response=json.loads(result.stdout)
    if not response.get('enabled'):raise RuntimeError('Account activation was not confirmed.')
    print('\nYour manager account is ready. Return to ChatGPT to finish the server connection.')
    input('Press Enter to close this window.')

if __name__=='__main__':
    try:main()
    except KeyboardInterrupt:print('\nCancelled. No password was changed.')
    except Exception as error:
        print('\nSetup could not finish: '+str(error))
        input('Press Enter to close this window.')
