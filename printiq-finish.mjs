// Finishes a printIQ Printing operation with the ProductionIntegration SOAP call RunTimingEvent.
// printIQ adds a time entry for every call, so a call is never repeated: the worker marks the outbox row
// 'sending' first, and anything other than a definite answer is left 'uncertain' for a manager to check in printIQ.
// Start, end and duration are all the moment of finishing, so no press time is added to the job.
const codes = /^(SUCCESS|FAIL_[A-Z_]+)$/;
const escape = value => String(value).replace(/[<>&'"]/g, c => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'})[c]);
const positive = n => Number.isSafeInteger(n) && n > 0;

/// Plant-local wall time (printIQ is told the time zone separately).
export function plantStamp(iso) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-AU', {timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'}).formatToParts(new Date(iso)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

export class PrintIQFinish {
  constructor({base = process.env.PRINTIQ_BASE_URL, appName = process.env.PRINTIQ_APP_NAME_V1, appKey = process.env.PRINTIQ_APP_KEY_V1,
    enabled = process.env.PRINTIQ_FINISH_ENABLED === 'true', timeZone = 'AUS Eastern Standard Time', fetcher = fetch} = {}) {
    Object.assign(this, {base, appName, appKey, enabled, timeZone, fetcher});
  }

  envelope(event) {
    const when = plantStamp(event.at);
    const fields = {AppKey: this.appKey, AppName: this.appName, JobNo: event.printiqJobNo, SectionKey: event.sectionKey, OperationKey: event.operationKey,
      OperatorUserName: event.operator, StartDate: when, EndDate: when, Duration: 0, TimeZoneId: this.timeZone, Finish: 'true'};
    return '<?xml version="1.0" encoding="utf-8"?>\n<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>' +
      '<RunTimingEvent xmlns="http://iq.co.nz/">' + Object.entries(fields).map(([k, v]) => `<${k}>${escape(v)}</${k}>`).join('') +
      '</RunTimingEvent></soap12:Body></soap12:Envelope>';
  }

  async deliver(entry) {
    const event = JSON.parse(entry.body);
    // Checks that fail before sending mean nothing reached printIQ, so they are safe to fix and queue again.
    if (!this.enabled) return {state: 'blocked', receipt: {reason: 'Printing-operation finishes are switched off on this server (PRINTIQ_FINISH_ENABLED).'}};
    if (!/^https:\/\/[a-z0-9.-]+\.printiq\.com$/i.test(this.base || '') || !this.appName || !this.appKey)
      return {state: 'blocked', receipt: {reason: 'printIQ application name, key or address is not configured.'}};
    if (event.kind !== 'printing_finish' || !/^J?\d+(?:-\d+)?$/.test(event.printiqJobNo || '') || !positive(event.sectionKey) ||
        !positive(event.operationKey) || !/^[\w .@-]{1,60}$/.test(event.operator || '') || !Number.isFinite(Date.parse(event.at)))
      return {state: 'rejected', receipt: {reason: 'Invalid Printing-operation finish.'}};
    let response, text;
    try {
      response = await this.fetcher(this.base + '/WebService/ProductionIntegration.asmx', {method: 'POST',
        headers: {'Content-Type': 'application/soap+xml; charset=utf-8'}, body: this.envelope(event), redirect: 'error', signal: AbortSignal.timeout(30000)});
      text = (await response.text()).slice(0, 20000);
    } catch (error) {
      return {state: 'uncertain', receipt: {reason: 'No answer from printIQ (' + (error.name || 'error') + '). Check the operation in printIQ before doing anything else.'}};
    }
    const result = /<RunTimingEventResult>\s*([^<]*?)\s*<\/RunTimingEventResult>/.exec(text)?.[1] ?? '';
    const at = new Date().toISOString();
    if (response.ok && result === 'SUCCESS') return {state: 'accepted', receipt: {result, acceptedAt: at}};
    if (response.ok && codes.test(result)) return {state: 'rejected', receipt: {result, reason: 'printIQ refused the finish (' + result + ').', at}};
    if (response.status >= 400 && response.status < 500) return {state: 'rejected', receipt: {reason: `printIQ returned HTTP ${response.status}.`, at}};
    return {state: 'uncertain', receipt: {reason: `Unclear answer from printIQ (HTTP ${response.status}${result ? ', ' + result.slice(0, 40) : ''}). Check the operation in printIQ.`, at}};
  }
}
