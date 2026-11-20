'use strict';
const el = id => document.getElementById(id);
const message = (id, text) => { el(id).textContent = text; };
async function post(action, body) {
  const res = await fetch(action,{method:'POST',credentials:'same-origin',cache:'no-store',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  let data;
  try { data=await res.json(); } catch { throw new Error('The review service is unavailable. Reopen your invitation to try again.'); }
  if (!res.ok) throw new Error(data.error || 'Could not complete this review.');
  return data;
}
function show(data) {
  message('title',data.title);message('job','Job '+data.job+'  /  Version '+data.version);
  el('questionBox').hidden=!data.question;message('question',data.question);
  if (!el('viewer').firstChild) {
    const video=data.mime.startsWith('video/');
    const media=document.createElement(video?'video':'img');
    if(video) { media.controls=true;media.playsInline=true;media.preload='metadata'; } else media.alt=data.title;
    media.src='media';el('viewer').append(media);
  }
  el('viewOnly').hidden=data.mode!=='view';
  document.querySelector('.expiry').textContent=new Date(data.expiresAt).toLocaleDateString('en-AU',{dateStyle:'long'});
  el('approval').hidden=data.mode!=='approval'||Boolean(data.result);
  el('receipt').hidden=!data.result;
  if(data.result) {
    message('result',data.result==='approved'?'Sample approved':'Changes requested');
    message('decisionDate',new Date(data.decisionAt).toLocaleString('en-AU'));
    message('decisionComment',data.comment);
  }
  document.title=data.title+' · Sunnyland Press';el('review').hidden=false;message('status','');
}
let token=location.hash.slice(1);
if (location.hash) history.replaceState(null,'',location.pathname);
post('open',{token}).then(show).catch(e=>message('status',e.message));
token='';
el('approval').addEventListener('change',()=>{
  el('comment').required=el('approval').elements.decision.value==='changes_requested';
  message('optional',el('comment').required?'(required)':'(optional)');
});
el('sendCode').onclick=async()=>{
  const button=el('sendCode');button.disabled=true;
  try {await post('code',{});message('codeStatus','Code sent. It is valid for 10 minutes.');el('code').focus();}
  catch(e){message('codeStatus',e.message);}
  finally {button.disabled=false;}
};
el('approval').onsubmit=async e=>{
  e.preventDefault();const button=el('approval').querySelector('button[type=submit]');button.disabled=true;
  try {show(await post('decision',{result:el('approval').elements.decision.value,comment:el('comment').value,code:el('code').value}));}
  catch(error){message('status',error.message);el('status').scrollIntoView({block:'nearest'});}
  finally {button.disabled=false;}
};
