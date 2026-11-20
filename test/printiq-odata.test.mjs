import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createJobsReader, ODataJobsReader} from '../printiq-application.mjs';
import {readJob, searchJobs} from '../job-documents.mjs';

const job = {Id:37, JobNo:'J12345', JobTitle:'Test document'};

test('configured Jobs reader sends only the OData key on the list and exact-job GETs', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sunnyland-odata-'));
  const before = process.env.CREDENTIALS_DIRECTORY;
  process.env.CREDENTIALS_DIRECTORY = dir;
  t.after(() => {
    if (before === undefined) delete process.env.CREDENTIALS_DIRECTORY;
    else process.env.CREDENTIALS_DIRECTORY = before;
    rmSync(dir, {recursive:true, force:true});
  });
  writeFileSync(join(dir, 'printiq-jobs.json'), JSON.stringify({type:'odata', apiKey:' saved-data-key '}), {mode:0o600});
  const reader = createJobsReader();
  assert.equal(reader.jobsConfigured, true);
  let reads = 0;
  reader.fetcher = async (target, options) => {
    const url = new URL(target);
    assert.equal(url.origin, 'https://sunnyland.printiq.com');
    assert.equal(url.pathname, '/api/v1/odata/Jobs');
    assert.equal(url.searchParams.has('LoginToken'), false);
    assert.equal(url.search.includes('saved-data-key'), false);
    assert.equal(options.method, 'GET');
    assert.equal(options.headers['PrintIQ-Access-Token'], 'saved-data-key');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'error');
    reads++;
    return Response.json({value:[job]});
  };
  const first = await searchJobs(reader, '', null);
  assert.equal(first.jobs.length, 1);
  assert.equal((await readJob(reader, first.jobs[0].id, String(job.Id))).id, job.JobNo);
  await assert.rejects(reader.call('Notes?'), /restricted/);
  await assert.rejects(reader.call('Jobs?', {method:'POST'}), /restricted/);
  assert.equal(reads, 2);
});

test('OData denial reports the status without retrying login or disclosing the credential', async () => {
  for (const status of [401, 403]) {
    let calls = 0;
    const reader = new ODataJobsReader('private-test-key', async () => {
      calls++;
      return new Response('private-test-key', {status});
    });
    await assert.rejects(searchJobs(reader, '', null), error =>
      error.http === status && error.message.includes('OData') && !error.message.includes('private-test-key'));
    assert.equal(calls, 1);
  }
  assert.throws(() => new ODataJobsReader(' '), /missing/);
});
