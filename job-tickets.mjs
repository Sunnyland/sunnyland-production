import {need, str} from './core.mjs';

const jobNumber = /^J\d+(?:-\d+)?$/;

// The trailing design letter belongs to the artwork. Numeric printIQ parts stay exact.
export function printIQJobKey(value) {
  if (typeof value !== 'string') return null;
  const match = /^J?([0-9]{6}(?:-[0-9]+)?)[a-z]?$/i.exec(value.trim());
  return match ? 'J'+match[1] : null;
}

export function printIQNumberFilter(key) {
  need(typeof key==='string' && printIQJobKey(key)===key,'Choose a valid printIQ job number.');
  return "(JobNo eq '"+key+"' or JobNo eq '"+key.slice(1)+"')";
}

export function samePrintIQJob(left,right) {
  const key=printIQJobKey(left);
  return left===right || (key!==null && key===printIQJobKey(right));
}

export async function readNumberMatch(iq, key) {
  const params = new URLSearchParams({'$filter':printIQNumberFilter(key),
    '$select':'Id,JobNo,JobTitle,Quantity,DueDate,CompletedDate,ProductionStatusId','$top':'2'});
  const reply = await iq.call('Jobs?'+params);
  need(Array.isArray(reply?.value) && reply.value.length === 1 && !reply['@odata.nextLink'],
       'Job missing or ambiguous in printIQ.',409);
  const row = reply.value[0];
  need((row?.JobNo === key || row?.JobNo === key.slice(1)) && Number.isSafeInteger(row.Id) && row.Id>0,
       'The printIQ job reference changed.',409);
  return row;
}

// The printed caption omits the .3 suffix carried by the Code 128 symbol.
export function printedTicket(code) {
  const match = /^(J\d+(?:-\d+)?)\|(\d+)(?:\.3)?$/.exec(code);
  if (!match) return null;
  return {job:match[1], key:match[2], code:match[1]+'|'+match[2]};
}

export async function resolveTicket(store, code, iq, jobs=iq) {
  const printed = printedTicket(code);
  const alias = !printed && printIQJobKey(code);
  const existingOperation = !printed && (store.get('jobTicket',code) || store.get('operation',code));
  need(!(alias && existingOperation && store.get('job',alias)),
       'This code matches a job and an operation. Open the job by number or select the operation.',409);
  const number = printed?.job ?? (existingOperation ? code : alias || code);
  if (jobNumber.test(number) && (!printed || !store.get('job', number))) {
    if (store.get('job', number)) return {kind:'job', job:number};
    const key = printIQJobKey(number);
    const remote = key && jobs.call ? await readNumberMatch(jobs,key) : await jobs.job(number);
    return {kind:'unregistered', job:key || remote.JobNo, name:remote.JobTitle || ''};
  }
  const link = store.get('jobTicket', printed?.code ?? code);
  const direct = store.get('operation', code);
  need(!link || !direct || direct.id === link.operation, 'This code matches two operations. Select the job manually.', 409);
  const op = link ? store.require('operation', link.operation) : direct;
  if (!op && printed) {
    const job = store.require('job', printed.job);
    let section = null;
    if (iq.token) {
      const remote = await iq.ticketOperation(printed.key);
      const sectionID = remote?.QuoteDetailSectionId?.toString();
      if (sectionID && job.sections.some(s => s.id === sectionID)) section = sectionID;
    }
    return {kind:'ticket', job:printed.job, code:printed.code, operationKey:printed.key, section};
  }
  if (printed && op) need(op.job === printed.job, 'The barcode belongs to a different job.', 409);
  need(op, 'This ticket code has no linked operation. Open the job by number, or ask a manager to link the printed code.', 404);
  const job = store.require('job', op.job);
  store.section(job, op.section);
  return {kind:'operation', job:job.id, section:op.section, operation:op.id};
}

export function linkTicket(store, actor, data, fromPrintedTicket = false) {
  if (!fromPrintedTicket) store.manager(actor);
  const job = store.activeJob(data.job);
  const section = store.section(job, data.section);
  const raw = str(data.code, 'ticket barcode', 160);
  const printed = printedTicket(raw);
  if (fromPrintedTicket) need(printed && printed.job === job.id, 'Scan the operation barcode for this job.');
  if (printed) need(printed.job === job.id, 'The barcode belongs to a different job.', 409);
  need(!/^J\d+(?:-\d+)?\|/.test(raw) || printed, 'This ticket format is unrecognised. Check the printed operation code.');
  const code = printed?.code ?? raw;
  need(!jobNumber.test(code), 'This is a job number. Scan the operation barcode.');
  const id = str(data.operation, 'operation identifier', 100);
  const prior = store.get('jobTicket', code);
  const direct = store.get('operation', code);
  need((!direct || direct.id === id) && (!prior || prior.operation === id), 'This barcode already identifies another operation.', 409);
  let op = store.get('operation', id);
  if (op) {
    need(op.job === job.id && op.section === section.id, 'The operation belongs to another job or section.', 409);
  } else {
    need(!store.get('jobTicket', id) && !jobNumber.test(id), 'Operation identifier conflicts with a ticket.', 409);
    op = store.put('operation', {id, job:job.id, section:section.id, name:str(data.name,'operation name'),
      location:str(data.location,'machine or location'), unit:str(data.unit,'unit',40), state:'ready', revision:0,
      artworkRevision:1, elapsedSeconds:0, good:0, waste:0, updatedAt:new Date().toISOString()});
  }
  if (printed) {
    need(!op.printiqOperationKey || op.printiqOperationKey === printed.key, 'This operation already has a different printIQ operation ID.', 409);
    if (!op.printiqOperationKey) store.put('operation', {...op, printiqOperationKey:printed.key});
  }
  return prior || store.put('jobTicket', {id:code, job:job.id, section:section.id, operation:op.id, actor:actor.id});
}

export function sampleContext(store, job, data, versions) {
  const prior = versions[0];
  const operation = data.operation ?? prior?.operation ?? null;
  const section = data.section ?? prior?.section ?? null;
  if (prior) need((prior.operation ?? null) === operation && (prior.section ?? null) === section,
    'A replacement must stay with the original job, section and operation.', 409);
  if (section !== null) store.section(job, section);
  if (operation !== null) {
    const op = store.require('operation', operation);
    need(op.job === job.id && op.section === section, 'Choose an operation from this job section.', 409);
  }
  return {operation, section};
}

export function jobNoteLines(event) {
  if (event.kind === 'job_video') {
    return [`Document video: ${event.title}`,`Open in Sunnyland Production: sunnylandproduction://jobs/${encodeURIComponent(event.job)}/videos/${encodeURIComponent(event.id)}`];
  }
  if (event.kind === 'operation') {
    const minutes = Math.floor(event.elapsedSeconds / 60);
    const seconds = event.elapsedSeconds % 60;
    return [`Operation: ${event.name} · ${event.location}`, `Timer: ${event.state} · ${minutes}m ${seconds}s accumulated`,
      ...(event.printiqOperationKey ? [`printIQ operation ID: ${event.printiqOperationKey}`] : []), `Recorded at: ${event.updatedAt}`, ...(event.state === 'completed' ? [`Good: ${event.good} · Waste: ${event.waste} ${event.unit}`] : [])];
  }
  if (event.kind === 'indigo_printed' && Array.isArray(event.lines)) return event.lines.map(String);
  if (['sample_submitted','sample_decision'].includes(event.kind)) {
    return [`Folding sample: ${event.title} · version ${event.version}`, `Approval: ${event.state}`,
      ...(event.operationName ? [`Operation: ${event.operationName}`] : []),
      ...(event.kind === 'sample_decision' && event.decisionNote ? [event.decisionNote] : []),
      `Open sample: sunnylandproduction://jobs/${encodeURIComponent(event.job)}/samples/${encodeURIComponent(event.id)}`];
  }
  return [JSON.stringify(event,null,2),'This is an activity note; it does not change printIQ stock balances or job status.'];
}
