import {printIQJobKey} from './job-tickets.mjs';
const timezone='Australia/Melbourne';
const dayFormat=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});
const completeLabels=new Set(['complete','completed']);
export function validDay(s){
  return typeof s==='string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10)===s;
}
export function finishDay(s){
  if(validDay(s))return s;
  if(typeof s!=='string'||!validDay(s.slice(0,10)))return null;
  if(!/(Z|[+-]\d\d:\d\d)$/i.test(s))return s.slice(0,10);
  return Number.isFinite(Date.parse(s))?dayFormat.format(new Date(s)):null;
}
// Published weekday public holidays for the Mildura urban area. Additional plant closure dates
// and newly declared holidays may be supplied in the service environment as YYYY-MM-DD values.
const gazetted=new Set(('2025-12-25 2025-12-26 2026-01-01 2026-01-26 2026-03-09 2026-04-03 2026-04-06 2026-06-08 2026-09-25 2026-11-03 2026-12-25 2026-12-28 '+
  '2027-01-01 2027-01-26 2027-03-08 2027-03-26 2027-03-29 2027-06-14 2027-11-02 2027-12-27 2027-12-28').split(' '));
function annualHolidays(year){
  const dates=new Set(gazetted);
  const date=(month,day)=>new Date(Date.UTC(year,month-1,day));
  const key=d=>d.toISOString().slice(0,10);
  const add=(month,day)=>dates.add(key(date(month,day)));
  const weekday=(m,w,n)=>1+(w-date(m,1).getUTCDay()+7)%7+7*(n-1);
  for(const [month,day] of [[1,1],[1,26]]){
    const w=date(month,day).getUTCDay();add(month,day+(w===6?2:w===0?1:0));
  }
  add(3,weekday(3,1,2));add(4,25);add(6,weekday(6,1,2));add(11,weekday(11,2,1));
  // Gregorian Easter (Meeus/Jones/Butcher).
  const a=year%19,b=Math.floor(year/100),c=year%100,h=(19*a+b-Math.floor(b/4)-Math.floor((b-Math.floor((b+8)/25)+1)/3)+15)%30;
  const l=(32+2*(b%4)+2*Math.floor(c/4)-h-c%4)%7,m=Math.floor((a+11*h+22*l)/451),n=h+l-7*m+114;
  const easterMonth=Math.floor(n/31),easterDay=n%31+1;
  add(easterMonth,easterDay-2);add(easterMonth,easterDay+1);
  add(12,25);add(12,26);
  if([0,6].includes(date(12,25).getUTCDay()))add(12,27);
  if([0,6].includes(date(12,26).getUTCDay()))add(12,28);
  return dates;
}
/// A Mildura plant working day: a weekday that is not a public holiday or a configured closure.
export function isPlantWorkday(day){
  if(!validDay(day))return false;
  const date=new Date(day+'T00:00:00Z'),week=date.getUTCDay();
  if(week===0||week===6)return false;
  const closures=new Set((process.env.SUNNYLAND_PLANT_CLOSURES??'').split(',').map(s=>s.trim()));
  return !annualHolidays(date.getUTCFullYear()).has(day) && !closures.has(day);
}
export function visibleFrom(now=new Date()){
  const date=new Date(finishDay(now.toISOString())+'T00:00:00Z');
  const closures=new Set((process.env.SUNNYLAND_PLANT_CLOSURES??'').split(',').map(s=>s.trim()));
  const named=new Set([...annualHolidays(date.getUTCFullYear()),...annualHolidays(date.getUTCFullYear()-1)]);
  for(let days=0;;date.setUTCDate(date.getUTCDate()-1)){
    const day=date.toISOString().slice(0,10),week=date.getUTCDay();
    if(week!==0 && week!==6 && !named.has(day) && !closures.has(day) && ++days===11)return day;
  }
}
export function directoryCutoff(now=new Date()){
  const day=visibleFrom(now);
  const midday=new Date(day+'T00:00:00Z');
  const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',hourCycle:'h23'}).format(midday));
  const utc=new Date(+midday-hour*3600000).toISOString();
  return '(CompletedDate eq null or CompletedDate ge '+utc+')';
}
export function rememberStatus(store,{job,printiqId,completedAt,status,complete},asOf=new Date().toISOString()){
  if(!job||!Number.isSafeInteger(printiqId))return;
  const actual=finishDay(completedAt), done=complete===true||Boolean(actual)||completeLabels.has(String(status).trim().toLowerCase());
  if(!done && complete!==false)return;
  const old=store.get('jobVisibility',job);
  if(old && Date.parse(old.asOf)>Date.parse(asOf))return;
  const day=done?(actual??(old?.printiqId===printiqId?old.completedOn:null)??finishDay(asOf)):null;
  if(!old && !done)return;
  store.put('jobVisibility',{id:job,printiqId,completedOn:day,asOf});
}
export function hiddenJobs(store,now=new Date()){
  const cutoff=visibleFrom(now),cache=new Map();
  const lookup=store.db.prepare("SELECT kind,doc FROM records WHERE id=? AND kind IN ('job','jobVisibility')");
  return (job,remote)=>{
    if(!job)return false;
    if(!cache.has(job)){
      const records=Object.fromEntries(lookup.all(job).map(row=>[row.kind,JSON.parse(row.doc)]));
      const key=printIQJobKey(job);
      const observed=(key && key!==job ? store.get('jobVisibility',key) : null) ?? records.jobVisibility,local=records.job;
      const day=observed?observed.completedOn:finishDay(local?.completedAt);
      cache.set(job,{hidden:Boolean(day && day<cutoff),id:observed?.printiqId??local?.printiqId});
    }
    const row=cache.get(job);
    return row.hidden && (!remote || !row.id || row.id===remote);
  };
}
export function observeDirectory(store,rows){
  const ids=store.get('jobStatusCatalogue','current')?.completeIds??[],at=new Date().toISOString();
  for(const j of rows){
    const known=ids.length && Number.isSafeInteger(j.productionStatusId);
    rememberStatus(store,{job:j.id,printiqId:j.printiqId,completedAt:j.completedAt,complete:known?ids.includes(j.productionStatusId):undefined},at);
  }
}
