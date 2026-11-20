import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ApplicationJobsReader, createJobsReader} from '../printiq-application.mjs';
import {searchJobs, readJob} from '../job-documents.mjs';

const credential = {UserName:'test-user', Password:'p &+', ApplicationName:'Intense', ApplicationKey:'a+/='};
const job = {Id:7, JobNo:'J123', JobTitle:'Mock Job'};
const isLogin = url => url.pathname === '/api/QuoteProcess/GetApplicationLogInToken';

test('the service selects application login only when its named systemd credential is installed', t => {
  const previous = process.env.CREDENTIALS_DIRECTORY;
  const dir = mkdtempSync(join(tmpdir(), 'jobs-login-test-'));
  process.env.CREDENTIALS_DIRECTORY = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.CREDENTIALS_DIRECTORY;
    else process.env.CREDENTIALS_DIRECTORY = previous;
    rmSync(dir, {recursive:true, force:true});
  });
  assert.equal(createJobsReader() instanceof ApplicationJobsReader, false);
  const file = join(dir, 'printiq-jobs.json');
  writeFileSync(file, JSON.stringify(credential), {mode:0o600});
  assert.equal(createJobsReader().jobsConfigured, true);
  writeFileSync(file, '{');
  assert.throws(() => createJobsReader(), /Invalid printIQ Jobs/);
});

test('Jobs login is shared by concurrent list and detail reads and never authorises writes', async () => {
  let logins = 0, reads = 0;
  const reader = new ApplicationJobsReader(credential, async (url, options) => {
    assert.equal(url.origin, 'https://sunnyland.printiq.com');
    assert.equal(options.redirect, 'error');
    if (isLogin(url)) {
      assert.equal(options.method, 'POST');
      assert.deepEqual(Object.fromEntries(url.searchParams), credential);
      logins++;
      return Response.json('test-session');
    }
    assert.equal(options.method, 'GET');
    assert.equal(url.pathname, '/api/v1/odata/Jobs');
    assert.equal(options.headers.Authorization, 'Bearer test-session');
    assert.equal(url.searchParams.has('LoginToken'), false);
    reads++;
    return Response.json({value:[job]});
  });
  const [list, detail] = await Promise.all([searchJobs(reader, '', null), readJob(reader, 'J123', '7')]);
  assert.equal(list.jobs[0].id, detail.id);
  await assert.rejects(reader.call('Notes?', {method:'POST'}), /restricted/);
  await assert.rejects(reader.call('Jobs?', {method:'POST'}), /restricted/);
  assert.deepEqual([logins, reads], [1, 2]);
});

test('uses the CRM login-token query transport when required and refreshes an expired session', async () => {
  let logins = 0, bearers = 0, expired = false;
  const reader = new ApplicationJobsReader(credential, async (url, options) => {
    if (isLogin(url)) return Response.json('session-' + ++logins);
    if (options.headers.Authorization) { bearers++; return new Response(null, {status:401}); }
    const token = url.searchParams.get('LoginToken');
    if (expired && token === 'session-1') return new Response(null, {status:401});
    assert.equal(token, 'session-' + logins);
    return Response.json({value:[job]});
  });
  await searchJobs(reader, '', null);
  await searchJobs(reader, '', null);
  assert.equal(bearers, 1);
  expired = true;
  await searchJobs(reader, '', null);
  assert.equal(logins, 2);
});

test('a denied, invalid or redirected login exposes no credential and cannot read Jobs', async () => {
  for (const status of [200, 401, 302]) {
    let calls = 0;
    const reader = new ApplicationJobsReader(credential, async (url, opts) => {
      calls++;
      assert.ok(isLogin(url)); assert.equal(opts.redirect, 'error');
      return new Response(status === 200 ? 'null' : credential.Password, {status});
    });
    await assert.rejects(searchJobs(reader, '', null), error =>
      /login/.test(error.message) && !error.message.includes(credential.Password));
    assert.equal(calls, 1);
  }
});

test('a forbidden Jobs read reports the status and stops without another login', async () => {
  let requests = 0;
  const reader = new ApplicationJobsReader(credential, async url => {
    requests++;
    return isLogin(url) ? Response.json('session') : new Response(null,{status:403});
  });
  await assert.rejects(searchJobs(reader, '', null), error => error.http === 403);
  assert.equal(requests, 2);
});
