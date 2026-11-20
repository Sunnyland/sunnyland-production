import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {PrintIQ} from './printiq.mjs';

const origin = 'https://sunnyland.printiq.com';

function failure(message, status) {
  const error = new Error(message);
  error.http = status;
  return error;
}

export function createJobsReader() {
  const directory = process.env.CREDENTIALS_DIRECTORY;
  if (!directory) return new PrintIQ();
  let source;
  try {
    source = readFileSync(join(directory, 'printiq-jobs.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return new PrintIQ();
    throw new Error('Cannot read the printIQ Jobs credential.');
  }
  let credential;
  try { credential = JSON.parse(source); }
  catch { throw new Error('Invalid printIQ Jobs credential file.'); }
  if (credential?.type === 'odata') return new ODataJobsReader(credential.apiKey);
  return new ApplicationJobsReader(credential);
}

export class ODataJobsReader extends PrintIQ {
  constructor(key, fetcher = fetch) {
    if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key))
      throw new Error('The printIQ OData Jobs key is missing or invalid.');
    super({token:key.trim(), fetcher, write:false});
  }

  get jobsConfigured() { return true; }

  async call(path, {method = 'GET'} = {}) {
    if (method !== 'GET' || !path.startsWith('Jobs?'))
      throw new Error('The OData Jobs credential is restricted to Jobs reads.');
    try {
      return await super.call(path);
    } catch (error) {
      if (error.http) throw failure('printIQ Jobs returned HTTP ' + error.http + ' using the configured OData application key.', error.http);
      throw new Error('Could not read the printIQ Jobs response with the configured OData key.');
    }
  }
}

// Inherit the existing exact-job lookup and its identity checks.
export class ApplicationJobsReader extends PrintIQ {
  #credential;
  #session;
  #pending;

  constructor(credential, fetcher = fetch) {
    super({fetcher});
    for (const field of ['UserName', 'Password', 'ApplicationName', 'ApplicationKey']) {
      if (typeof credential?.[field] !== 'string' || !credential[field].trim())
        throw new Error('Missing printIQ Jobs credential field ' + field + '.');
    }
    this.#credential = credential;
  }

  get jobsConfigured() { return true; }

  async #request(url, options) {
    try {
      return await this.fetcher(url, {...options, redirect: 'error', cache: 'no-store',
        signal: AbortSignal.timeout(30000)});
    } catch {
      throw new Error('Could not reach printIQ over HTTPS.');
    }
  }

  async #login() {
    const url = new URL('/api/QuoteProcess/GetApplicationLogInToken', origin);
    for (const field of ['UserName', 'Password', 'ApplicationName', 'ApplicationKey'])
      url.searchParams.set(field, this.#credential[field]);
    const response = await this.#request(url, {method: 'POST', headers: {Accept: 'application/json'}});
    if (!response.ok) throw failure('printIQ application login returned HTTP ' + response.status + '.', response.status);
    const raw = (await response.text()).trim();
    let token;
    try { token = JSON.parse(raw); }
    catch { token = raw; }
    if (typeof token !== 'string' || !/^[A-Za-z0-9._~+/=-]+$/.test(token) ||
        /^(null|true|false)$/i.test(token))
      throw new Error('printIQ application login did not return a usable token.');
    return {token, expiresAt: Date.now() + 10 * 60 * 1000, mode: null};
  }

  async #getSession() {
    if (this.#session?.expiresAt > Date.now()) return this.#session;
    if (!this.#pending) {
      this.#pending = this.#login().then(session => this.#session = session)
        .finally(() => { this.#pending = null; });
    }
    return this.#pending;
  }

  async #read(path, session) {
    // These are the two login-token transports used by the existing CRM reader.
    for (const mode of session.mode ? [session.mode] : ['bearer', 'query']) {
      const url = new URL('/api/v1/odata/' + path, origin);
      const headers = {Accept: 'application/json'};
      if (mode === 'bearer') headers.Authorization = 'Bearer ' + session.token;
      else url.searchParams.set('LoginToken', session.token);
      const response = await this.#request(url, {method: 'GET', headers});
      if (response.ok) {
        let data;
        try { data = await response.json(); }
        catch { throw new Error('printIQ returned an unreadable Jobs response.'); }
        session.mode = mode;
        return data;
      }
      await response.body?.cancel();
      if (response.status !== 401)
        throw failure('printIQ Jobs returned HTTP ' + response.status + '.', response.status);
    }
    throw failure('printIQ issued a login token but Jobs rejected it (HTTP 401).', 401);
  }

  async call(path, {method = 'GET'} = {}) {
    if (method !== 'GET' || !path.startsWith('Jobs?'))
      throw new Error('Application login is restricted to Jobs reads.');
    const session = await this.#getSession();
    const previouslyAccepted = Boolean(session.mode);
    try { return await this.#read(path, session); }
    catch (error) {
      if (error.http !== 401) throw error;
      if (this.#session === session) this.#session = null;
      if (!previouslyAccepted) throw error;
      return this.#read(path, await this.#getSession());
    }
  }
}
