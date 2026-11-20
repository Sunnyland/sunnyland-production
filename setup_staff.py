"""Interactive bootstrap. Password is not stored in shell history."""
import getpass,os,subprocess
from pathlib import Path
env=os.environ.copy()
env['SUNNYLAND_USER_EMAIL']=input('Staff email: ').strip()
env['SUNNYLAND_USER_NAME']=input('Display name: ').strip()
env['SUNNYLAND_USER_ROLE']=input('Role (operator / rep / manager): ').strip()
password=getpass.getpass('Password (at least 14 characters): ')
if password!=getpass.getpass('Repeat password: '): raise SystemExit('Passwords differ.')
env['SUNNYLAND_USER_PASSWORD']=password
result=subprocess.run([env.get('NODE_BINARY','node'),str(Path(__file__).with_name('setup.mjs'))],env=env)
raise SystemExit(result.returncode)
