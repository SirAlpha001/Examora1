const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=t=>new Date(t).toLocaleString('en-GB',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
const $=id=>document.getElementById(id), now=()=>Date.now();
let db={users:[],questions:[],exams:[],attempts:[],notifs:[],log:[],set:{inst:'Examora',selfReg:false,grade:[70,60,50,40]}},sid=null,flash=null,cx={qi:0},tick=null,answerTimer=null,serverOffset=0;
const pendingAnswers=new Map();
async function api(path,{method='GET',body}={}){
  const res=await fetch(path,{method,credentials:'same-origin',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  let data={};try{data=await res.json()}catch{throw new Error('The server returned an unreadable response.')}
  if(!res.ok){const error=new Error(data.error||'The request failed.');error.status=res.status;error.path=path;throw error}
  return data}
async function refresh(){db=await api('/api/state');sid=db.currentUser.id;return db}
const U=()=>db.users.find(u=>u.id===sid), Q=id=>db.questions.find(q=>q.id===id), E=id=>db.exams.find(e=>e.id===id);
const norm=s=>String(s||'').toLowerCase().replace(/\s+/g,' ').trim();
const ST={draft:'Draft',scheduled:'Scheduled',active:'Active',completed:'Completed',published:'Published'};
const est=e=>e.published?'published':e.status==='draft'?'draft':now()<e.opens?'scheduled':now()<=e.closes?'active':'completed';
const asg=(e,u)=>e.status!=='draft'&&(e.classes.includes(u.klass)||e.regs.includes(u.reg));
const assigned=e=>db.users.filter(x=>x.role==='student'&&asg(e,x));
const mine=(e,u)=>db.attempts.find(a=>a.examId===e.id&&a.uid===u.id);
const curA=()=>db.attempts.find(a=>a.examId===cx.e&&a.uid===sid);
const used=q=>db.exams.some(e=>e.status!=='draft'&&e.qs.some(x=>x.id===q.id));
const grade=p=>{const g=db.set.grade;return p>=g[0]?'A':p>=g[1]?'B':p>=g[2]?'C':p>=g[3]?'D':'F'};
const mmss=ms=>{const s=Math.max(0,Math.ceil(ms/1000));return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')};
function tot(a){const e=E(a.examId);let m=0,max=0,pend=0;e.qs.forEach(x=>{max+=x.marks;const s=a.scores[x.id];if(s&&s.m!=null)m+=s.m;else pend++});
  const p=max?Math.round(m/max*1000)/10:0;return{m,max,pend,p,g:grade(p),pass:p>=e.pass}}
const fa=(q,v)=>q.type==='mcq'?(v||[]).map(i=>q.opts[i]).join(', ')||'—':v||'—';
const ca=q=>q.type==='mcq'?q.correct.map(i=>q.opts[i]).join(', '):q.type==='tf'?q.correct[0]:q.type==='short'?(q.accepted.join(' / ')||'Marked by lecturer'):'Marked by lecturer';
const bars=(o,mx)=>Object.entries(o).map(([k,v])=>`<div class="bar"><span>${esc(k)}</span><i style="width:${mx?Math.min(100,v/mx*100):0}%"></i><b>${v}</b></div>`).join('')||'<span class="muted">No data yet.</span>';

const ROUTES={admin:['admin','users','lexams','lexam','mark','reports','announce','config','log','notifications','profile','password'],
 lecturer:['lecturer','bank','qform','lexams','nexam','lexam','mark','reports','notifications','profile','password'],
 student:['dashboard','exams','results','result','sit','take','notifications','profile','password']};
const NAVS={admin:[['admin','Dashboard'],['users','Users'],['lexams','Examinations'],['reports','Reports'],['announce','Announcements'],['config','Setup'],['log','Activity log'],['notifications','Notifications']],
 lecturer:[['lecturer','Dashboard'],['bank','Question bank'],['lexams','Examinations'],['reports','Reports'],['notifications','Notifications']],
 student:[['dashboard','Dashboard'],['exams','My examinations'],['results','My results'],['notifications','Notifications']]};
const PARENT={qform:'bank',nexam:'lexams',lexam:'lexams',mark:'lexams',sit:'exams',take:'exams',result:'results'};
const th=a=>'<thead><tr>'+a.map(x=>`<th>${x}</th>`).join('')+'</tr></thead>';
const tbl=(h,rows,empty)=>`<div class="scroll"><table>${th(h)}<tbody>${rows.length?rows.join(''):`<tr><td colspan="${h.length}" class="muted">${empty}</td></tr>`}</tbody></table></div>`;
const pill=s=>`<span class="pill ${s==='Active'||s==='Published'?'ok':''}">${s}</span>`;

function authV(r){const reg=r==='register';return `<div class="auth"><div class="wrap"><h1 style="font-size:34px;letter-spacing:.06em">Examora</h1><p class="meta">Online Examination Management System<br>${esc(db.set.inst)}</p>
${flash?`<div class="flash ${flash.t}">${esc(flash.m)}</div>`:''}
<form class="box" id="${reg?'reg':'login'}"><h3 style="margin:0">${reg?'Create your account':'Sign in'}</h3>
${reg?`<label>Full name</label><input name="name" required><label>Registration number</label><input name="reg" required><label>Class</label><input name="klass" placeholder="BIT Year 2" required><label>Email</label><input name="email" type="email" required>`:`<label>Registration number or email</label><input name="id" required>`}
<label>Password</label><input name="pw" type="password" minlength="${reg?12:1}" required>${reg?'<label>Confirm password</label><input name="pw2" type="password" required>':''}
<button style="width:100%">${reg?'Create account':'Sign in'}</button></form>
<p class="sw">${reg?'<a href="#login">Back to sign in</a>':db.set.selfReg?'New student? <a href="#register">Create an account</a>':''}</p></div></div>`}

const V={
dashboard:u=>{const ex=db.exams.filter(e=>asg(e,u)),open=ex.filter(e=>est(e)==='active'&&!(mine(e,u)||{}).done),up=ex.filter(e=>est(e)==='scheduled'),res=ex.filter(e=>e.published&&(mine(e,u)||{}).done);
 const L=a=>a.map(e=>`<div class="note"><b>${esc(e.title)}</b><br><span class="muted">${fmt(e.opens)} · ${e.mins} min</span></div>`).join('');
 const nn=db.notifs.filter(n=>n.uid===u.id&&!n.read).length;
 return `<h1>Welcome, ${esc(u.name)}</h1><p class="meta">${esc(u.reg)} · ${esc(u.klass)}</p><div class="grid">
 <div class="card"><h3>Available now</h3>${open.length?L(open):'<span class="muted">No examinations are open right now.</span>'}</div>
 <div class="card"><h3>Coming up</h3>${up.length?L(up):'<span class="muted">Nothing scheduled.</span>'}</div>
 <div class="card"><h3>Latest results</h3>${res.length?res.slice(0,3).map(e=>`<div class="note">${esc(e.code)} — ${tot(mine(e,u)).p}%</div>`).join(''):'<span class="muted">No published results yet.</span>'}</div>
 <div class="card"><h3>Notifications</h3>${nn?`You have ${nn} unread. `:'You are up to date. '}<a href="#notifications">View all</a></div></div>`},
exams:u=>`<h1>My examinations</h1>`+tbl(['Code','Title','Subject','Opens','Closes','Time allowed','Status',''],db.exams.filter(e=>asg(e,u)).map(e=>{const a=mine(e,u),s=est(e);
 const act=a&&a.done?(e.published?`<button class="sm" data-a="res" data-v="${e.id}">View result</button>`:'<span class="muted">Submitted</span>'):s==='active'?`<button class="sm" data-a="sit" data-v="${e.id}">${a?'Resume':'Start'}</button>`:s==='scheduled'?'<span class="muted">Not open</span>':'<span class="miss">Missed</span>';
 return `<tr><td>${esc(e.code)}</td><td>${esc(e.title)}</td><td>${esc(e.subject)}</td><td class="nw">${fmt(e.opens)}</td><td class="nw">${fmt(e.closes)}</td><td>${e.mins} min</td><td>${pill(a&&a.done&&s!=='published'?'Completed':ST[s])}</td><td>${act}</td></tr>`}),'No examinations assigned to you.'),
sit:u=>{const e=E(cx.e);return `<h1>${esc(e.title)}</h1><p class="meta">${esc(e.code)} · ${esc(e.subject)}</p><div class="card"><div class="note">Time allowed: <b>${e.mins} minutes</b> (never past ${fmt(e.closes)})</div><div class="note">Questions: <b>${e.qs.length}</b> · Total marks: <b>${e.qs.reduce((s,x)=>s+x.marks,0)}</b> · Pass mark: <b>${e.pass}%</b></div><div class="note">${esc(e.instr||'')}</div>
 <p>The timer starts when you press Start. You can submit only once.</p><div class="row"><button data-a="start" data-v="${e.id}">Start</button><button class="alt" data-a="go" data-v="exams">Back</button></div></div>`},
take:u=>{const a=curA();if(!a||a.done){setTimeout(()=>go('exams'));return''}const e=E(a.examId),n=e.qs.length,i=Math.min(cx.qi,n-1),q=Q(e.qs[i].id),v=a.ans[q.id];let inp;
 if(q.type==='mcq')inp=q.opts.map((o,k)=>`<label class="opt"><input type="checkbox" value="${k}" ${(v||[]).includes(k)?'checked':''}> ${esc(o)}</label>`).join('');
 else if(q.type==='tf')inp=['true','false'].map(o=>`<label class="opt"><input type="radio" name="tf" value="${o}" ${v===o?'checked':''}> ${o==='true'?'True':'False'}</label>`).join('');
 else if(q.type==='short')inp=`<input value="${esc(v||'')}" placeholder="Your answer">`;else inp=`<textarea rows="9">${esc(v||'')}</textarea>`;
 const nums=e.qs.map((y,k)=>{const s=a.ans[y.id],h=Array.isArray(s)?s.length:s;return `<button class="num ${k===i?'cur':''} ${a.review[y.id]?'rev':h?'ans':''}" data-a="q" data-v="${k}">${k+1}</button>`}).join('');
 return `<div class="tk"><div><b>${esc(e.title)}</b><br><span class="muted">${esc(e.code)}</span></div><div class="t"><span id="timer"></span><span id="sv">All answers saved</span></div></div><div id="wn" class="muted" style="margin-bottom:8px"></div>
 <div class="tkgrid"><div class="card" id="qbox"><div class="muted">Question ${i+1} of ${n} · ${e.qs[i].marks} mark(s)</div><p><b>${esc(q.text)}</b></p>${inp}</div><div class="card"><h3>Questions</h3><div class="nums">${nums}</div><p class="muted" style="font-size:12px">Blue: answered. Amber: marked for review.</p></div></div>
 <div class="row"><button class="alt" data-a="q" data-v="${Math.max(0,i-1)}">Previous</button><button class="alt" data-a="q" data-v="${Math.min(n-1,i+1)}">Next</button><button class="alt" data-a="rev" data-v="${q.id}">${a.review[q.id]?'Unmark review':'Mark for review'}</button><button data-a="submit">Submit</button></div>`},
results:u=>{const es=db.exams.filter(e=>e.published&&(mine(e,u)||{}).done);return `<h1>My results</h1>`+tbl(['Examination','Subject','Date','Marks','%','Grade','Result',''],es.map(e=>{const T=tot(mine(e,u));return `<tr><td>${esc(e.title)}</td><td>${esc(e.subject)}</td><td>${fmt(e.closes)}</td><td>${T.m}/${T.max}</td><td>${T.p}</td><td>${T.g}</td><td>${T.pass?'Pass':'Fail'}</td><td><button class="sm" data-a="res" data-v="${e.id}">Details</button></td></tr>`}),'No published results yet.')},
result:u=>{const e=E(cx.e),a=e&&mine(e,u);if(!e||!a||!e.published){setTimeout(()=>go('results'));return''}const T=tot(a);
 return `<h1>${esc(e.title)}</h1><p class="meta">${T.m}/${T.max} · ${T.p}% · Grade ${T.g} · ${T.pass?'Pass':'Fail'}</p>`+e.qs.map((x,i)=>{const q=Q(x.id),s=a.scores[x.id]||{},d=a.resultAnswers?.[x.id]||{},key={...q,correct:d.correct||[],accepted:d.accepted||[]};return `<div class="card"><div class="muted">Question ${i+1} · ${s.m??0}/${x.marks}</div><p><b>${esc(q.text)}</b></p><div class="note">Your answer: ${esc(fa(q,a.ans[q.id]))}</div><div class="note">Correct answer: ${esc(ca(key))}</div>${s.fb?`<div class="note">Feedback: ${esc(s.fb)}</div>`:''}</div>`}).join('')+`<button class="alt" data-a="go" data-v="results">Back</button>`},

lecturer:u=>{const es=db.exams.filter(e=>e.by===u.id),pend=db.attempts.filter(a=>a.done&&es.some(e=>e.id===a.examId&&!e.published)&&tot(a).pend).length;
 return `<h1>Welcome, ${esc(u.name)}</h1><p class="meta">Lecturer</p><div class="grid"><div class="card"><h3>Questions</h3><div class="big">${db.questions.filter(q=>!q.archived).length}</div></div><div class="card"><h3>My examinations</h3><div class="big">${es.length}</div></div><div class="card"><h3>Waiting for marking</h3><div class="big">${pend}</div></div></div>`},
bank:u=>{const s=norm(cx.s),t=cx.t||'';return `<h1>Question bank</h1><form id="qf" class="box row" style="max-width:none"><input name="s" placeholder="Search" value="${esc(cx.s||'')}" style="flex:2"><select name="t" style="flex:1"><option value="">All types</option>${['mcq','tf','short','essay'].map(x=>`<option value="${x}" ${t===x?'selected':''}>${x}</option>`).join('')}</select><button>Filter</button><button type="button" class="alt" data-a="newq">New question</button></form>`+
 tbl(['Question','Type','Subject','Marks','Author',''],db.questions.filter(q=>!q.archived&&(!t||q.type===t)&&(!s||norm(q.text+q.subject).includes(s))).map(q=>{const own=q.by===u.id,lk=used(q);return `<tr><td>${esc(q.text.slice(0,70))}</td><td>${q.type}</td><td>${esc(q.subject)}</td><td>${q.marks}</td><td>${esc((db.users.find(x=>x.id===q.by)||{}).name||'')}</td><td class="nw">${own&&!lk?`<button class="sm" data-a="eq" data-v="${q.id}">Edit</button>`:''}${own?`<button class="sm alt" data-a="aq" data-v="${q.id}">Archive</button>`:''}${lk?'<span class="muted">Locked</span>':''}</td></tr>`}),'No questions found.')},
qform:u=>{const q=cx.q?Q(cx.q):{type:'mcq',text:'',marks:1,subject:'',opts:[],correct:[],accepted:[],notes:''};
 return `<h1>${cx.q?'Edit':'New'} question</h1><form class="box" id="qs"><label>Type</label><select name="type">${[['mcq','Multiple choice'],['tf','True or false'],['short','Short answer'],['essay','Essay']].map(([v,l])=>`<option value="${v}" ${q.type===v?'selected':''}>${l}</option>`).join('')}</select>
 <label>Question</label><textarea name="text" rows="3" required>${esc(q.text)}</textarea><label>Marks</label><input name="marks" type="number" min="0.5" step="0.5" value="${q.marks}" required><label>Subject</label><input name="subject" value="${esc(q.subject)}" required>
 <label>Options (multiple choice: one per line, 2 to 6)</label><textarea name="opts" rows="4">${esc(q.opts.join('\n'))}</textarea><label>Correct option numbers (e.g. 1,3)</label><input name="correct" value="${q.type==='mcq'?q.correct.map(i=>i+1).join(','):''}">
 <label>True or false answer</label><select name="tf"><option value="true" ${q.correct[0]==='true'?'selected':''}>True</option><option value="false" ${q.correct[0]==='false'?'selected':''}>False</option></select>
 <label>Accepted answers (short answer: one per line; leave empty to mark by hand)</label><textarea name="acc" rows="3">${esc(q.accepted.join('\n'))}</textarea><label>Notes for markers (students never see these)</label><textarea name="notes" rows="2">${esc(q.notes)}</textarea>
 <div class="row"><button>Save question</button><button type="button" class="alt" data-a="go" data-v="bank">Cancel</button></div></form>`},
lexams:u=>`<h1>Examinations</h1><div class="row" style="margin-bottom:16px"><button data-a="newe">New examination</button></div>`+tbl(['Code','Title','Opens','Closes','Status',''],db.exams.filter(e=>e.by===u.id||u.role==='admin').map(e=>`<tr><td>${esc(e.code)}</td><td>${esc(e.title)}</td><td class="nw">${fmt(e.opens)}</td><td class="nw">${fmt(e.closes)}</td><td>${pill(ST[est(e)])}</td><td><button class="sm" data-a="oe" data-v="${e.id}">Open</button></td></tr>`),'No examinations yet.'),
nexam:u=>`<h1>New examination</h1><form class="box" id="ne"><label>Code</label><input name="code" required><label>Title</label><input name="title" required><label>Subject</label><input name="subject" required>
 <label>Opens</label><input name="opens" type="datetime-local" required><label>Closes</label><input name="closes" type="datetime-local" required><label>Minutes allowed</label><input name="mins" type="number" min="5" value="40" required><label>Pass mark (%)</label><input name="pass" type="number" min="0" max="100" value="50" required>
 <label>Instructions</label><textarea name="instr" rows="2"></textarea><label>Questions (tick to include, edit marks)</label>${db.questions.filter(q=>!q.archived).map(q=>`<label class="opt"><input type="checkbox" name="q" value="${q.id}"><span style="flex:1">${esc(q.text.slice(0,60))}</span><input name="m_${q.id}" type="number" step="0.5" min="0.5" value="${q.marks}" style="width:80px"></label>`).join('')}
 <label>Classes (comma separated)</label><input name="classes" placeholder="BIT Year 2"><label>Individual registration numbers (comma separated)</label><input name="regs"><div class="row"><button>Save as draft</button><button type="button" class="alt" data-a="go" data-v="lexams">Cancel</button></div></form>`,
lexam:u=>{const e=E(cx.e);if(!e){setTimeout(()=>go('lexams'));return''}const s=est(e),sub=assigned(e);
 const head=`<h1>${esc(e.title)}</h1><p class="meta">${esc(e.code)} · ${esc(e.subject)} · ${pill(ST[s])}</p><div class="card"><div class="note">${fmt(e.opens)} to ${fmt(e.closes)} · ${e.mins} min · pass ${e.pass}%</div><div class="note">Questions: ${e.qs.map(x=>esc(Q(x.id).text.slice(0,40))+' ('+x.marks+')').join('; ')||'none'}</div><div class="note">Assigned: ${esc([...e.classes,...e.regs].join(', ')||'nobody')}</div><div class="row" style="margin-top:12px">`;
 const btn=s==='draft'?`<button data-a="sched" data-v="${e.id}">Schedule</button><button class="danger" data-a="dele" data-v="${e.id}">Delete</button>`:s==='completed'?`<button data-a="pub" data-v="${e.id}">Publish results</button>`:s==='published'&&u.role==='admin'?`<button class="danger" data-a="unpub" data-v="${e.id}">Unpublish</button>`:'';
 return head+btn+`<button class="alt" data-a="go" data-v="lexams">Back</button></div></div>`+(s==='draft'?'':'<h3>Submissions</h3>'+tbl(['Student','Reg no.','Status','Score',''],sub.map(x=>{const a=mine(e,x),T=a&&a.done?tot(a):null;return `<tr><td>${esc(x.name)}</td><td>${esc(x.reg)}</td><td>${a?(a.done?'Submitted':'In progress'):'Not started'}</td><td>${T?`${T.m}/${T.max} (${T.p}%)${T.pend?' · '+T.pend+' to mark':''}`:'—'}</td><td>${T?`<button class="sm" data-a="mk" data-v="${a.id}">Mark</button>`:''}</td></tr>`}),'No assigned students.'))},
mark:u=>{const a=db.attempts.find(x=>x.id===cx.a);if(!a){setTimeout(()=>go('lexams'));return''}const e=E(a.examId),s=db.users.find(x=>x.id===a.uid),T=tot(a),lock=e.published;
 return `<h1>${esc(s.name)} · ${esc(e.code)}</h1><p class="meta">${T.m}/${T.max} · ${T.p}% · Grade ${T.g} · ${T.pass?'Pass':'Fail'}</p>${T.pend?`<div class="flash warn">${T.pend} question(s) still need a mark.</div>`:''}${lock?'<div class="flash warn">Published marks are locked.</div>':''}
 <form id="mk">${e.qs.map((x,i)=>{const q=Q(x.id),sc=a.scores[x.id];return `<div class="card"><div class="muted">Question ${i+1} · out of ${x.marks}</div><p><b>${esc(q.text)}</b></p><div class="note">Student answer: ${esc(fa(q,a.ans[q.id]))}</div><div class="note">Correct answer: ${esc(ca(q))}</div>${q.notes?`<div class="note">Marking notes: ${esc(q.notes)}</div>`:''}
 <label>Mark</label><input name="m_${x.id}" type="number" min="0" max="${x.marks}" step="0.5" value="${sc.m??''}" ${lock?'disabled':''}><label>Feedback</label><input name="f_${x.id}" value="${esc(sc.fb||'')}" ${lock?'disabled':''}></div>`}).join('')}
 <div class="row">${lock?'':'<button>Save marks</button>'}<button type="button" class="alt" data-a="oe" data-v="${e.id}">Back</button></div></form>`},
reports:u=>{const es=db.exams.filter(e=>u.role==='admin'||e.by===u.id),t=cx.rt||'perf',f=cx.re||'all',sel=es.filter(e=>f==='all'||e.id===f);let h,rows=[];
 if(t==='perf'){h=['Student','Reg no.','Exam','Marks','%','Grade','Result'];sel.forEach(e=>db.attempts.filter(a=>a.examId===e.id&&a.done).forEach(a=>{const s=db.users.find(x=>x.id===a.uid),T=tot(a);rows.push([s.name,s.reg,e.code,T.m+'/'+T.max,T.p,T.g,T.pass?'Pass':'Fail'])}))}
 else if(t==='part'){h=['Exam','Assigned','Sat','Participation %'];sel.forEach(e=>{const n=assigned(e).length,k=db.attempts.filter(a=>a.examId===e.id&&a.done).length;rows.push([e.code,n,k,n?Math.round(k/n*100):0])})}
 else{h=['Student','Reg no.','Exam never sat'];sel.forEach(e=>assigned(e).forEach(s=>{if(!db.attempts.some(a=>a.examId===e.id&&a.uid===s.id&&a.done))rows.push([s.name,s.reg,e.code])}))}
 const csv=[h,...rows].map(r=>r.map(c=>'"'+String(c).replace(/^[=+\-@]/,"'$&").replace(/"/g,'""')+'"').join(',')).join('\n');
 return `<h1>Reports</h1><form id="rp" class="box row" style="max-width:none"><select name="rt"><option value="perf" ${t==='perf'?'selected':''}>Student performance</option><option value="part" ${t==='part'?'selected':''}>Participation</option><option value="never" ${t==='never'?'selected':''}>Students who never sat an exam</option></select><select name="re"><option value="all">All exams</option>${es.map(e=>`<option value="${e.id}" ${f===e.id?'selected':''}>${esc(e.code)}</option>`).join('')}</select><button>Show</button></form>`+tbl(h,rows.map(r=>'<tr>'+r.map(c=>`<td>${esc(c)}</td>`).join('')+'</tr>'),'Nothing to report yet.')+`<label>CSV (select and copy)</label><textarea rows="5" readonly>${esc(csv)}</textarea>`},

admin:u=>{const st=db.users.filter(x=>x.role==='student').length,lc=db.users.filter(x=>x.role==='lecturer').length,c={};db.exams.forEach(e=>{const s=est(e);c[ST[s]]=(c[ST[s]]||0)+1});
 const at=db.attempts.filter(a=>a.done&&E(a.examId).published),pf={Pass:0,Fail:0},sb={},sn={},gr={};at.forEach(a=>{const T=tot(a),e=E(a.examId);pf[T.pass?'Pass':'Fail']++;sb[e.subject]=(sb[e.subject]||0)+T.p;sn[e.subject]=(sn[e.subject]||0)+1;gr[T.g]=(gr[T.g]||0)+1});Object.keys(sb).forEach(k=>sb[k]=Math.round(sb[k]/sn[k]));
 return `<h1>Administrator dashboard</h1><p class="meta">Read from stored data on every load</p><div class="grid"><div class="card"><h3>Students</h3><div class="big">${st}</div></div><div class="card"><h3>Lecturers</h3><div class="big">${lc}</div></div><div class="card"><h3>Exams</h3><div class="big">${db.exams.length}</div></div></div><br><div class="grid">
 <div class="card"><h3>Exams by status</h3>${bars(c,db.exams.length)}</div><div class="card"><h3>Pass versus fail</h3>${bars(pf,at.length)}</div><div class="card"><h3>Average score by subject (%)</h3>${bars(sb,100)}</div><div class="card"><h3>Students per grade</h3>${bars(gr,at.length)}</div></div>`},
users:u=>`<h1>Users</h1><form class="box" id="nu"><h3 style="margin:0">Create account</h3><label>Full name</label><input name="name" required><label>Registration number</label><input name="reg" required><label>Email</label><input name="email" type="email" required><label>Role</label><select name="role"><option value="student">Student</option><option value="lecturer">Lecturer</option><option value="admin">Administrator</option></select><label>Class (students)</label><input name="klass"><button>Create with temporary password</button></form>
 <form class="box" id="imp"><h3 style="margin:0">Import students</h3><label>One per line: name, registration number, email, class</label><textarea name="rows" rows="4" required></textarea><button>Import</button></form>${cx.tp?`<div class="card"><h3>Temporary passwords (shown once)</h3><textarea rows="4" readonly>${esc(cx.tp)}</textarea></div>`:''}`+
 tbl(['Name','Reg no.','Email','Role','Class','Status',''],db.users.map(x=>`<tr><td>${esc(x.name)}</td><td>${esc(x.reg)}</td><td>${esc(x.email)}</td><td>${x.role}</td><td>${esc(x.klass)}</td><td>${x.active?(x.lock>now()?'Locked':'Active'):'Deactivated'}</td><td class="nw">${x.id===u.id?'':`<button class="sm" data-a="tog" data-v="${x.id}">${x.active?'Deactivate':'Activate'}</button>`}<button class="sm alt" data-a="unl" data-v="${x.id}">Unlock</button><button class="sm alt" data-a="rst" data-v="${x.id}">Reset password</button></td></tr>`),''),
announce:u=>`<h1>Announcements</h1><form class="box" id="ann"><label>Message (appears in everyone’s notifications)</label><textarea name="m" rows="3" required></textarea><button>Send to everyone</button></form>`,
config:u=>{const s=db.set;return `<h1>Setup</h1><form class="box" id="cfg"><label>Institution name</label><input name="inst" value="${esc(s.inst)}" required><label class="opt"><input type="checkbox" name="selfReg" ${s.selfReg?'checked':''}> Allow students to create their own accounts</label>
 <label>Grade scale: minimum % for A, B, C, D</label><div class="row">${s.grade.map((g,i)=>`<input name="g${i}" type="number" min="0" max="100" value="${g}" style="width:80px">`).join('')}</div><button>Save settings</button></form>`},
log:u=>`<h1>Activity log</h1>`+tbl(['When','Who','What'],db.log.map(l=>`<tr><td class="nw">${fmt(l.t)}</td><td>${esc(l.u)}</td><td>${esc(l.a)}</td></tr>`),'Nothing recorded yet.'),
notifications:u=>`<h1>Notifications</h1><div class="card">${db.notifs.filter(n=>n.uid===u.id).map(n=>`<div class="note">${esc(n.m)}<br><span class="muted">${fmt(n.t)}</span></div>`).join('')||'<span class="muted">You have no notifications.</span>'}</div>`,
profile:u=>`<h1>My profile</h1><div class="card" style="max-width:440px"><div class="note"><span class="muted">Name</span><br>${esc(u.name)}</div><div class="note"><span class="muted">Registration number</span><br>${esc(u.reg)}</div><div class="note"><span class="muted">Role</span><br>${u.role}</div><div class="note"><span class="muted">Class</span><br>${esc(u.klass||'—')}</div><div class="note"><span class="muted">Email</span><br>${esc(u.email)}</div></div>`,
password:u=>`<h1>Change password</h1><p class="meta">${u.mustChangePassword?'You must choose a new password before continuing. ':''}Use at least 12 characters.</p><form class="box" id="pw"><label>Current password</label><input name="old" type="password" required><label>New password</label><input name="pw" type="password" minlength="12" required><label>Confirm new password</label><input name="pw2" type="password" minlength="12" required><button>Update password</button></form>`};

function shell(u,r,body){
  const fl=flash?`<div class="flash ${flash.t}">${esc(flash.m)}</div>`:'';
  if(r==='take')return `<main>${fl}${body}</main>`;
  const nn=db.notifs.filter(n=>n.uid===u.id&&!n.read).length,on=PARENT[r]||r;
  return `<div class="shell"><aside><div class="brand">Examora</div><div class="sub">${esc(db.set.inst)}</div><nav>${NAVS[u.role].map(n=>`<a href="#${n[0]}" class="${on===n[0]?'on':''}">${n[1]}${n[0]==='notifications'&&nn?`<span class="badge">${nn}</span>`:''}</a>`).join('')}</nav>
  <div class="me"><b>${esc(u.name)}</b><span>${{admin:'Administrator',lecturer:'Lecturer',student:'Student'}[u.role]}</span><a href="#profile">My profile</a><a href="#password">Change password</a><a href="#login" data-a="out">Sign out</a></div></aside><main>${fl}${body}</main></div>`}

function render(){
  clearInterval(tick);const app=$('app');if(!db)return;
  const r=(location.hash||'#login').slice(1),u=U();
  if(!u){if(!['login','register'].includes(r)||(r==='register'&&!db.set.selfReg)){location.hash='#login';return}app.innerHTML=authV(r);flash=null;return}
  if(u.mustChangePassword&&r!=='password'){location.hash='#password';return}
  if(!ROUTES[u.role].includes(r)){location.hash='#'+ROUTES[u.role][0];return}
  app.innerHTML=shell(u,r,V[r](u));flash=null;
  if(r==='notifications'&&db.notifs.some(n=>!n.read)){
    db.notifs.forEach(n=>{n.read=true});
    api('/api/notifications/read-all',{method:'POST',body:{}}).catch(handleError)
  }
  if(r==='take')startTick()}
function go(h,f,c){flash=f||null;if(c)Object.assign(cx,c);if(location.hash==='#'+h)render();else location.hash=h}
async function handleError(error){
  if(error.status===401&&error.path!=='/api/auth/login'){sid=null;flash={t:'err',m:'Your session expired. Please sign in again.'};location.hash='#login';render();return}
  flash={t:'err',m:error.message||'The request failed.'};render()}
function startTick(){const a=curA();if(!a)return;const f=()=>{const l=a.deadline-(now()+serverOffset);if(l<=0){clearInterval(tick);api(`/api/attempts/${a.id}/submit`,{method:'POST',body:{}}).then(async()=>{await refresh();go('results',{t:'warn',m:'Time is up. Your exam was submitted automatically.'})}).catch(handleError);return}
  $('timer').textContent=mmss(l);$('wn').textContent=l<=60000?'Warning: one minute left.':l<=300000?'Warning: five minutes left.':''};f();tick=setInterval(f,1000)}
function setSv(message){const s=$('sv');if(!s)return;s.textContent=message||(!navigator.onLine?'Connection lost. Unsaved answers will be sent when it returns.':pendingAnswers.size?'Saving answers…':'All answers saved');s.className=message||!navigator.onLine?'off':''}
async function flushAnswers(){
  if(!navigator.onLine||!pendingAnswers.size){setSv();return}
  setSv('Saving answers…');
  for(const [questionId,entry] of pendingAnswers){
    try{
      const saved=await api(`/api/attempts/${entry.attemptId}/answers/${questionId}`,{method:'PUT',body:{answer:entry.answer}});
      if(pendingAnswers.get(questionId)===entry){pendingAnswers.delete(questionId);if(saved.serverTime)serverOffset=saved.serverTime-now()}
    }catch(error){setSv(`Answer not saved: ${error.message}`);return}
  }
  setSv()}
window.addEventListener('online',()=>{setSv();flushAnswers()});window.addEventListener('offline',()=>setSv());

const app=$('app');
const saveAns=e=>{const box=e.target.closest('#qbox');if(!box)return;const a=curA();if(!a||a.done)return;const E1=E(a.examId),q=Q(E1.qs[Math.min(cx.qi,E1.qs.length-1)].id);
  const answer=q.type==='mcq'?[...box.querySelectorAll('input:checked')].map(i=>+i.value):q.type==='tf'?box.querySelector('input[name="tf"]:checked')?.value||null:e.target.value;
  a.ans[q.id]=answer;pendingAnswers.set(q.id,{attemptId:a.id,answer});setSv();clearTimeout(answerTimer);answerTimer=setTimeout(flushAnswers,300)};

const connectedActs={
 go:v=>go(v),
 out:async()=>{await api('/api/auth/logout',{method:'POST',body:{}});sid=null;db.users=[];go('login')},
 sit:v=>go('sit',null,{e:v}),
 res:v=>go('result',null,{e:v}),
 start:async v=>{const started=await api(`/api/exams/${v}/start`,{method:'POST',body:{}});cx.e=v;cx.qi=0;serverOffset=started.serverTime?started.serverTime-now():0;await refresh();go('take')},
 q:v=>{cx.qi=+v;render()},
 rev:async v=>{const a=curA(),reviewed=!a.review[v];await api(`/api/attempts/${a.id}/review/${v}`,{method:'POST',body:{reviewed}});await refresh();render()},
 submit:async()=>{const a=curA(),e=E(a.examId),un=e.qs.filter(x=>{const s=a.ans[x.id];return Array.isArray(s)?!s.length:!s}).length;
  await flushAnswers();if(pendingAnswers.size)throw new Error('Some answers are not saved yet. Reconnect before submitting.');
  if(!confirm(un?un+' question(s) are unanswered. Submit anyway?':'Submit your exam now? You cannot change answers afterwards.'))return;
  await api(`/api/attempts/${a.id}/submit`,{method:'POST',body:{}});await refresh();go('results',{t:'ok',m:'Submission received. Results appear after your lecturer publishes them.'})},
 newq:()=>go('qform',null,{q:null}),
 eq:v=>go('qform',null,{q:v}),
 aq:async v=>{if(!confirm('Archive this question? Old exams keep it.'))return;await api(`/api/questions/${v}`,{method:'DELETE',body:{}});await refresh();render()},
 newe:()=>go('nexam'),
 oe:v=>go('lexam',null,{e:v}),
 mk:v=>go('mark',null,{a:v}),
 sched:async v=>{await api(`/api/exams/${v}/schedule`,{method:'POST',body:{}});await refresh();go('lexam',{t:'ok',m:'Scheduled. Assigned students were notified and the questions are locked.'})},
 dele:async v=>{if(!confirm('Delete this draft?'))return;await api(`/api/exams/${v}`,{method:'DELETE',body:{}});await refresh();go('lexams')},
 pub:async v=>{await api(`/api/exams/${v}/publish`,{method:'POST',body:{}});await refresh();go('lexam',{t:'ok',m:'Results published. Marks are now locked.'})},
 unpub:async v=>{await api(`/api/exams/${v}/unpublish`,{method:'POST',body:{}});await refresh();go('lexam',{t:'ok',m:'Results unpublished.'})},
 tog:async v=>{const account=db.users.find(x=>x.id===v);await api(`/api/users/${v}`,{method:'PATCH',body:{active:!account.active}});await refresh();render()},
 unl:async v=>{await api(`/api/users/${v}/unlock`,{method:'POST',body:{}});await refresh();render()},
 rst:async v=>{const account=db.users.find(x=>x.id===v),result=await api(`/api/users/${v}/reset-password`,{method:'POST',body:{}});cx.tp=`${account.email} : ${result.temporaryPassword}`;await refresh();go('users',{t:'ok',m:`Temporary password for ${account.name} (shown once).`})}};

const connectedForms={
 login:async d=>{const result=await api('/api/auth/login',{method:'POST',body:{identifier:d.id.trim(),password:d.pw}});sid=result.user.id;await refresh();go(ROUTES[result.user.role][0])},
 reg:async d=>{if(d.pw!==d.pw2)throw new Error('Passwords do not match.');await api('/api/auth/register',{method:'POST',body:{name:d.name.trim(),reg:d.reg.trim(),email:d.email.trim(),klass:d.klass.trim(),password:d.pw}});go('login',{t:'ok',m:'Account created. Please sign in.'})},
 pw:async d=>{if(d.pw!==d.pw2)throw new Error('New passwords do not match.');await api('/api/auth/password',{method:'POST',body:{currentPassword:d.old,newPassword:d.pw}});await refresh();go(ROUTES[U().role][0],{t:'ok',m:'Your password has been updated.'})},
 qf:d=>{cx.s=d.s;cx.t=d.t;render()},
 rp:d=>{cx.rt=d.rt;cx.re=d.re;render()},
 qs:async d=>{const type=d.type,opts=d.opts.split(/\r?\n/).map(x=>x.trim()).filter(Boolean),correct=[],accepted=[];
  if(type==='mcq'){for(const value of d.correct.split(',')){const index=Number(value.trim())-1;if(Number.isInteger(index)&&index>=0)correct.push(index)}if(opts.length<2||opts.length>6)throw new Error('Multiple choice needs 2 to 6 options.');if(!correct.length)throw new Error('Enter valid correct option numbers.')}
  if(type==='tf')correct.push(d.tf);if(type==='short')accepted.push(...d.acc.split(/\r?\n/).map(x=>x.trim()).filter(Boolean));
  const question={type,text:d.text.trim(),marks:Number(d.marks),subject:d.subject.trim(),options:type==='mcq'?opts:[],correct,accepted,notes:d.notes.trim()};
  if(cx.q)await api(`/api/questions/${cx.q}`,{method:'PUT',body:question});else await api('/api/questions',{method:'POST',body:question});
  await refresh();go('bank',{t:'ok',m:'Question saved.'},{q:null})},
 ne:async(d,f,fd)=>{const ids=fd.getAll('q'),questions=ids.map(id=>({id,marks:Number(d[`m_${id}`])})),split=value=>value.split(',').map(x=>x.trim()).filter(Boolean);
  await api('/api/exams',{method:'POST',body:{code:d.code.trim().toUpperCase(),title:d.title.trim(),subject:d.subject.trim(),opensAt:new Date(d.opens).getTime(),closesAt:new Date(d.closes).getTime(),durationMinutes:Number(d.mins),passMark:Number(d.pass),instructions:d.instr,questions,classes:split(d.classes),regs:split(d.regs)}});
  await refresh();go('lexams',{t:'ok',m:'Draft saved. Open it to schedule.'})},
 mk:async d=>{const attempt=db.attempts.find(x=>x.id===cx.a),exam=E(attempt.examId),marks=exam.qs.map(question=>({questionId:question.id,mark:d[`m_${question.id}`]===''?null:Number(d[`m_${question.id}`]),feedback:d[`f_${question.id}`]||''}));
  await api(`/api/attempts/${attempt.id}/marks`,{method:'PUT',body:{marks}});await refresh();go('mark',{t:'ok',m:'Marks saved.'})},
 nu:async d=>{const result=await api('/api/users',{method:'POST',body:{name:d.name.trim(),reg:d.reg.trim(),email:d.email.trim(),role:d.role,klass:d.klass.trim()}});
  cx.tp=`${d.email.trim()} : ${result.temporaryPassword}`;await refresh();go('users',{t:'ok',m:'Account created. The user must change the temporary password at first sign-in.'})},
 imp:async d=>{const result=await api('/api/users/import',{method:'POST',body:{rows:d.rows}});cx.tp=result.credentials.map(x=>`${x.email} : ${x.password}`).join('\n');await refresh();go('users',{t:'ok',m:`Imported ${result.credentials.length} student(s). Each must change the temporary password at first sign-in.`})},
 ann:async d=>{await api('/api/announcements',{method:'POST',body:{message:d.m.trim()}});await refresh();go('announce',{t:'ok',m:'Announcement sent.'})},
 cfg:async d=>{await api('/api/settings',{method:'PUT',body:{institution:d.inst.trim(),selfRegistration:!!d.selfReg,gradeScale:[0,1,2,3].map(i=>Number(d[`g${i}`]))}});await refresh();go('config',{t:'ok',m:'Settings saved.'})}};

app.removeEventListener('input',saveAns);
app.removeEventListener('change',saveAns);
app.onclick=async e=>{const button=e.target.closest('[data-a]');if(!button)return;const action=connectedActs[button.dataset.a];if(!action)return;try{await action(button.dataset.v,button)}catch(error){handleError(error)}};
app.onsubmit=async e=>{e.preventDefault();const form=e.target,handler=connectedForms[form.getAttribute('id')];if(!handler)return;const fd=new FormData(form);try{await handler(Object.fromEntries(fd),form,fd)}catch(error){handleError(error)}};
app.addEventListener('input',saveAns);
app.addEventListener('change',e=>{if(e.target.type==='checkbox'||e.target.type==='radio')saveAns(e)});
window.addEventListener('hashchange',render);
async function boot(){
  try{
    const config=await api('/api/public');db.set.inst=config.institution;db.set.selfReg=config.selfRegistration;
    try{
      const session=await api('/api/auth/me');sid=session.user.id;await refresh();
      const route=(location.hash||'').slice(1);
      if(!route||route==='login'||!ROUTES[session.user.role].includes(route))location.hash=`#${ROUTES[session.user.role][0]}`;
      else render()
    }catch(error){if(error.status!==401)throw error;sid=null;render()}
  }catch(error){flash={t:'err',m:`Cannot connect to the OEMS server: ${error.message}`};render()}}
boot();

