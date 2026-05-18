// IceMorocco – App Logic (with Live Company Search)
let searchMode='nom';
let isLiveAvailable=false; // true when server.js is running
let lastLiveResults=new Map();
let searchInFlight=false;
const LIVE_CACHE_KEY='icm_live_company_cache_v1';
const SEARCH_STATE_KEY='icm_search_state_v1';

// Check if live search server is available
async function checkLiveSearch(){
  try{
    const r=await fetch('/api/health',{signal:AbortSignal.timeout(1200)});
    isLiveAvailable=r.ok;
  }catch{isLiveAvailable=false;}
  const el=document.getElementById('db-count');
  if(isLiveAvailable){
    el.textContent='999 000+';
    document.getElementById('live-badge')&&(document.getElementById('live-badge').style.display='inline');
  }else{
    el.textContent=DB.length.toLocaleString('fr-FR');
  }
}

// Init
document.addEventListener('DOMContentLoaded',async()=>{
  document.getElementById('db-count').textContent=DB.length.toLocaleString('fr-FR');
  const t=new Date().toISOString().split('T')[0];
  const d=new Date(); d.setDate(d.getDate()+30);
  sv('inv-date',t); sv('inv-due',d.toISOString().split('T')[0]);
  sv('inv-num',`${new Date().getFullYear()}-001`);
  loadVendor(); addRow();
  ['tva','cur'].forEach(id=>document.getElementById(id).addEventListener('change',calc));
  document.getElementById('s-name').addEventListener('input',syncCompany);
  document.getElementById('inv-num').addEventListener('input',syncNum);
  syncDocType();
  initBusinessTools();
  await checkLiveSearch();
  restoreRoute();
});

// Pages
function showPage(p,opts={}){
  const updateUrl=opts.updateUrl!==false;
  document.querySelectorAll('.page').forEach(x=>x.classList.remove('active'));
  document.querySelectorAll('.sbn').forEach(x=>x.classList.remove('active'));
  document.getElementById('page-'+p).classList.add('active');
  document.getElementById('sbn-'+p)?.classList.add('active');
  document.body.className=`is-${p}-page`;
  closeMobileMenu();
  if(updateUrl)updateRoute(p);
  window.scrollTo({top:0,behavior:'smooth'});
}

function returnToSearch(){
  showPage('search');
  clearSearch();
}

function toggleMobileMenu(){
  const menu=document.getElementById('mobile-menu');
  const btn=document.querySelector('.mobile-menu-btn');
  if(!menu)return;
  const open=menu.style.display!=='none';
  menu.style.display=open?'none':'grid';
  btn?.setAttribute('aria-expanded',String(!open));
}

function closeMobileMenu(){
  const menu=document.getElementById('mobile-menu');
  const btn=document.querySelector('.mobile-menu-btn');
  if(menu)menu.style.display='none';
  btn?.setAttribute('aria-expanded','false');
}

function updateRoute(page){
  const url=new URL(window.location.href);
  if(page==='search'){
    const q=document.getElementById('q')?.value.trim();
    if(q){
      url.searchParams.set('q',q);
      url.searchParams.set('mode',searchMode);
      url.hash='';
    }else{
      url.searchParams.delete('q');
      url.searchParams.delete('mode');
      url.hash='';
    }
  }else{
    url.searchParams.delete('q');
    url.searchParams.delete('mode');
    url.hash=page;
  }
  history.replaceState(null,'',url);
}

function restoreRoute(){
  const url=new URL(window.location.href);
  const hash=url.hash.replace('#','');
  const knownPages=['search','ice-check','salary','invoice','words','tools','about','faq','contact','terms','privacy'];
  const q=url.searchParams.get('q');
  const saved=readSearchState();
  const mode=url.searchParams.get('mode')||saved.mode||'nom';
  if(hash&&knownPages.includes(hash)&&hash!=='search'){
    showPage(hash,{updateUrl:false});
    return;
  }
  applySearchMode(mode,{clear:false});
  const restoredQuery=q||'';
  if(restoredQuery){
    sv('q',restoredQuery);
    go({updateUrl:false});
  }else{
    showPage('search',{updateUrl:false});
  }
}

function readSearchState(){
  try{return JSON.parse(localStorage.getItem(SEARCH_STATE_KEY)||'{}')||{};}catch{return {};}
}

function saveSearchState(q){
  try{localStorage.setItem(SEARCH_STATE_KEY,JSON.stringify({q,mode:searchMode}));}catch{}
}

// Search mode
function applySearchMode(m,{clear=true}={}){
  m=m==='ice'?'ice':'nom';
  searchMode=m;
  document.getElementById('mt-nom').classList.toggle('active',m==='nom');
  document.getElementById('mt-ice').classList.toggle('active',m==='ice');
  const inp=document.getElementById('q');
  inp.placeholder=m==='ice'?'Saisir un ICE à 15 chiffres':'Nom de société ou marque';
  inp.inputMode=m==='ice'?'numeric':'text';
  if(clear){
    inp.value='';
    clearSearch();
    updateRoute('search');
  }
}

function setMode(m){
  applySearchMode(m,{clear:true});
}

function setSearchLoading(loading){
  searchInFlight=loading;
  const btn=document.getElementById('search-submit');
  if(!btn)return;
  btn.classList.toggle('is-loading',loading);
  btn.disabled=loading;
  btn.setAttribute('aria-busy',String(loading));
  const label=btn.querySelector('.btn-label');
  if(label)label.textContent=loading?'Recherche...':'Rechercher';
}

// Search — local DB first, then live charika.ma
async function go(opts={}){
  if(searchInFlight)return;
  const updateUrl=opts.updateUrl!==false;
  const input=document.getElementById('q');
  let raw=input.value.trim().toLowerCase();
  if(!raw) return;
  setSearchLoading(true);
  try{
  const rawDigits=raw.replace(/\D/g,'');
  if(searchMode==='ice'){
    raw=rawDigits;
    input.value=rawDigits;
  }
  saveSearchState(input.value.trim());
  if(updateUrl)updateRoute('search');
  const words=raw.split(/\s+/).filter(Boolean);
  const nameTokens=searchTokens(raw);
  const liveMode=searchMode;
  const cachedResults=getCachedCompanies().map((c,i)=>({
    ...c,
    id:85000+i,
    _live:true,
    _source:c._source||'cache',
  }));
  const searchableDB=[...DB,...cachedResults];

  // 1. Local DB search
  const broadLocalRes=searchableDB.filter(c=>{
    if(searchMode==='ice'){
      const iceDigits=String(c.ice||'').replace(/\D/g,'');
      return rawDigits&&iceDigits&&(iceDigits.startsWith(rawDigits)||iceDigits===rawDigits);
    }
    const h=[c.name,c.ville,c.act,c.type,c.rc,c.if_,c.cap].join(' ').toLowerCase();
    return words.some(w=>h.includes(w));
  });
  const strictLocalRes=searchMode==='nom'&&nameTokens.length>1
    ? broadLocalRes.filter(c=>nameTokens.every(t=>normalizeCompanyKey(c.name).includes(t)))
    : [];
  let localRes=dedupeResults(strictLocalRes.length?strictLocalRes:broadLocalRes);
  localRes.sort((a,b)=>scoreResult(b,raw,words)-scoreResult(a,raw,words));
  lastLiveResults=new Map(localRes.filter(c=>c._live).map(c=>[c.id,c]));

  // Show local results immediately
  renderResults(localRes,raw);
  scrollToResults();

  // 2. Live search from charika.ma (if server is running)
  const canSearchLive=liveMode==='nom' ? raw.length>=2 : raw.length>=6;
  if(isLiveAvailable && canSearchLive){
    try{
      const r=await fetch(`/api/search?q=${encodeURIComponent(raw)}&mode=${encodeURIComponent(liveMode)}`);
      const data=await r.json();
      if(data.results&&data.results.length>0){
        let liveResults=data.results.map((c,i)=>({
          id:90000+i,
          name:c.name,
          type:c.type||'',
          ice:c.ice||'',if_:c.if_||'',rc:c.rc||'',pat:c.pat||'',cap:c.cap||'',
          addr:c.addr||'',
          ville:c.ville||'',
          act:c.act||'',
          date:formatCompanyDate(c.date||''),
          statut:c.statut||'Actif',
          tel:c.tel||'',
          fax:c.fax||'',
          email:c.email||'',
          website:c.website||'',
          _live:true,
          _slug:c.slug,
          _url:c.url,
          _source:'charika',
        }));
        cacheCompanies(liveResults);
        let hasStrictLive=false;
        if(liveMode==='nom'&&nameTokens.length>1){
          const strictLive=liveResults.filter(c=>nameTokens.every(t=>normalizeCompanyKey(c.name).includes(t)));
          if(strictLive.length){
            liveResults=strictLive;
            hasStrictLive=true;
          }
        }
        const baseResults=hasStrictLive ? dedupeResults(strictLocalRes) : localRes;
        const merged=dedupeResults(mergeResults(baseResults,liveResults))
          .sort((a,b)=>scoreResult(b,raw,words)-scoreResult(a,raw,words));
        lastLiveResults=new Map(merged.filter(c=>c._live).map(c=>[c.id,c]));
        renderResults(merged,raw);
        scrollToResults();
      }
    }catch(e){
      console.log('Live search unavailable:',e.message);
    }
  }
  }finally{
    setSearchLoading(false);
  }
}

function scrollToResults(){
  const panel=document.getElementById('results-panel');
  if(!panel||panel.style.display==='none')return;
  setTimeout(()=>panel.scrollIntoView({behavior:'smooth',block:'start'}),80);
}

function formatCompanyDate(value=''){
  const raw=String(value||'').trim();
  if(!raw)return '';
  const clean=raw.replace(/[T\s].*$/,'').replace(/\./g,'/').replace(/-/g,'/');
  let m=clean.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if(m)return `${m[3].padStart(2,'0')}/${m[2].padStart(2,'0')}/${m[1]}`;
  m=clean.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if(m)return `${m[1].padStart(2,'0')}/${m[2].padStart(2,'0')}/${m[3]}`;
  m=clean.match(/^(\d{4})\/(\d{1,2})$/);
  if(m)return `${m[2].padStart(2,'0')}/${m[1]}`;
  m=clean.match(/^(\d{1,2})\/(\d{4})$/);
  if(m)return `${m[1].padStart(2,'0')}/${m[2]}`;
  m=clean.match(/^(\d{4})$/);
  if(m)return m[1];
  const parsed=Date.parse(raw);
  if(!Number.isNaN(parsed)){
    const date=new Date(parsed);
    return `${String(date.getDate()).padStart(2,'0')}/${String(date.getMonth()+1).padStart(2,'0')}/${date.getFullYear()}`;
  }
  return raw;
}

function searchTokens(q=''){
  return normalizeCompanyKey(q)
    .split(/\s+/)
    .filter(t=>t.length>1&&!['ste','societe','sarl','sa','au','maroc','ma'].includes(t));
}

function normalizeCompanyKey(v=''){
  return String(v)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/\b(ste|societe|sarl|sa|au|ltd|maroc|ma)\b/g,'')
    .replace(/[^a-z0-9]+/g,' ')
    .trim();
}

function dataCompleteness(c){
  return ['ice','if_','rc','date','addr','ville','cap','act','tel','email','website']
    .reduce((n,k)=>n+(c[k]?1:0),0);
}

function scoreResult(c,raw,words){
  const name=(c.name||'').toLowerCase();
  const hay=[c.name,c.ville,c.act,c.type,c.rc,c.if_,c.cap,c.addr].join(' ').toLowerCase();
  let score=words.filter(w=>hay.includes(w)).length;
  if(name===raw)score+=20;
  if(name.includes(raw))score+=8;
  if(name.startsWith(raw))score+=6;
  if(String(c.ice||'').replace(/\D/g,'').length===15)score+=10;
  score+=Math.min(dataCompleteness(c),6);
  return score;
}

function isSameCompany(a,b){
  const aIce=String(a.ice||'').replace(/\D/g,'');
  const bIce=String(b.ice||'').replace(/\D/g,'');
  if(aIce&&bIce)return aIce===bIce;
  const ak=normalizeCompanyKey(a.name);
  const bk=normalizeCompanyKey(b.name);
  if(!ak||!bk)return false;
  
  const nameMatch = ak===bk||ak.includes(bk)||bk.includes(ak);
  if (nameMatch) {
    const vA = normalizeCompanyKey(a.ville || '');
    const vB = normalizeCompanyKey(b.ville || '');
    if (vA && vB && vA !== vB) return false;
    return true;
  }
  return false;
}

function mergeCompanyData(primary,secondary){
  const merged={...secondary,...primary};
  ['type','ice','if_','rc','pat','cap','addr','ville','act','date','statut','tel','fax','email','website','_slug','_url','_source']
    .forEach(k=>{merged[k]=primary[k]||secondary[k]||'';});
  return merged;
}

function preferCompanyRecord(a={},b={}){
  const aHasIce=String(a.ice||'').replace(/\D/g,'').length===15;
  const bHasIce=String(b.ice||'').replace(/\D/g,'').length===15;
  if(aHasIce!==bHasIce)return aHasIce?a:b;
  if(Boolean(a._live)!==Boolean(b._live))return a._live?a:b;
  return dataCompleteness(a)>=dataCompleteness(b)?a:b;
}

function dedupeResults(results=[]){
  const merged=[];
  results.forEach(item=>{
    if(!item||!item.name)return;
    const idx=merged.findIndex(existing=>isSameCompany(existing,item));
    if(idx===-1){
      merged.push(item);
      return;
    }
    const preferred=preferCompanyRecord(item,merged[idx]);
    const fallback=preferred===item?merged[idx]:item;
    merged[idx]=mergeCompanyData(preferred,fallback);
  });
  return merged;
}

function mergeResults(localRes,liveResults){
  const merged=dedupeResults(localRes);
  liveResults.forEach(live=>{
    const idx=merged.findIndex(local=>isSameCompany(local,live));
    if(idx===-1){
      merged.push(live);
      return;
    }
    const local=merged[idx];
    const richer=dataCompleteness(live)>dataCompleteness(local);
    merged[idx]=richer?mergeCompanyData(live,local):mergeCompanyData(local,live);
  });
  return merged;
}

function getCachedCompanies(){
  try{
    const cached=JSON.parse(localStorage.getItem(LIVE_CACHE_KEY)||'[]');
    return Array.isArray(cached)?cached:[];
  }catch{
    return [];
  }
}

function cacheCompanies(companies=[]){
  if(!Array.isArray(companies)||!companies.length)return;
  const cached=dedupeResults(getCachedCompanies());
  const all=dedupeResults([...cached,...companies]);
  const byKey=new Map();
  all.forEach(c=>{
    const key=companyCacheKey(c);
    if(key)byKey.set(key,c);
  });
  try{localStorage.setItem(LIVE_CACHE_KEY,JSON.stringify([...byKey.values()].slice(-600)));}catch{}
}

function cacheCompany(company){
  cacheCompanies(company?[company]:[]);
}

function companyCacheKey(c){
  const ice=String(c?.ice||'').replace(/\D/g,'');
  if(ice)return `ice:${ice}`;
  const name=normalizeCompanyKey(c?.name||'');
  return name?`name:${name}`:'';
}

// Fetch full company details from charika.ma
async function fetchLiveDetails(id){
  if(!isLiveAvailable)return;
  const base=lastLiveResults.get(id);
  if(!base)return;
  return fetchCompanyDetails(base,id);
}

async function fetchLocalSourceDetails(id){
  if(!isLiveAvailable)return openModal(id);
  const base=DB.find(x=>x.id===id);
  if(!base||!base.source)return openModal(id);
  const url=base.source.startsWith('http')?base.source:`https://${base.source}`;
  return fetchCompanyDetails({...base,_url:url},id);
}

async function fetchCompanyDetails(base,id){
  try{
    toast('Chargement des détails...');
    const lookup=await fetchStructuredCompany(base);
    if(lookup)base=mergeCompanyData(lookup,base);
    const params=base._url
      ?`url=${encodeURIComponent(base._url)}`
      :`slug=${encodeURIComponent(base._slug||'')}`;
    const r=await fetch(`/api/company?${params}`);
    const data=await r.json();
    if(data.name||base.name){
      // Show enriched modal
      const c={
        ...base,
        ...data,
        id,
        addr:data.addr||base.addr||'',
        ville:base.ville||data.ville||'',
        ice:data.ice||base.ice||'',
        rc:data.rc||base.rc||'',
        if_:data.if_||base.if_||'',
        pat:data.pat||base.pat||'',
        date:formatCompanyDate(data.date||base.date||''),
        tel:data.tel||base.tel||'',
        fax:data.fax||base.fax||'',
        email:data.email||base.email||'',
        website:data.website||base.website||'',
        act:data.act||base.act||'',
        type:data.type||base.type||'',
        cap:data.cap||base.cap||'',
      };
      cacheCompany(c);
      lastLiveResults.set(id,c);
      document.getElementById('modal-body').innerHTML=`
        <div class="mo-name">${c.name}</div>
        ${c.type?`<div class="mo-type">${c.type}</div>`:''}
        <div class="mo-grid">
          ${c.tel?`<div class="mo-field"><div class="mo-fl">Téléphone</div><div class="mo-fv">${c.tel}</div></div>`:''}
          ${c.fax?`<div class="mo-field"><div class="mo-fl">Fax</div><div class="mo-fv">${c.fax}</div></div>`:''}
          ${c.email?`<div class="mo-field"><div class="mo-fl">Email</div><div class="mo-fv">${c.email}</div></div>`:''}
          ${c.website?`<div class="mo-field"><div class="mo-fl">Site web</div><div class="mo-fv"><a href="http://${c.website}" target="_blank">${c.website}</a></div></div>`:''}
          ${c.ice?`<div class="mo-field"><div class="mo-fl">ICE</div><div class="mo-fv amber">${c.ice}</div></div>`:''}
          ${c.if_?`<div class="mo-field"><div class="mo-fl">IF</div><div class="mo-fv">${c.if_}</div></div>`:''}
          ${c.rc?`<div class="mo-field"><div class="mo-fl">RC</div><div class="mo-fv">${c.rc}</div></div>`:''}
          ${c.pat?`<div class="mo-field"><div class="mo-fl">Patente</div><div class="mo-fv">${c.pat}</div></div>`:''}
          ${c.date?`<div class="mo-field"><div class="mo-fl">Création</div><div class="mo-fv">${formatCompanyDate(c.date)}</div></div>`:''}
          ${c.cap?`<div class="mo-field"><div class="mo-fl">Capital</div><div class="mo-fv">${c.cap}</div></div>`:''}
          ${c.ville?`<div class="mo-field"><div class="mo-fl">Ville</div><div class="mo-fv">${c.ville}</div></div>`:''}
        </div>
        ${c.act?`<div class="mo-act">${c.act}</div>`:''}
        ${c.addr?`<div class="mo-field" style="margin-bottom:16px"><div class="mo-fl">Adresse</div><div class="mo-fv">${c.addr}</div></div>`:''}
          ${c.directors&&c.directors.length?`
          <div style="margin-top:12px">
            <div class="mo-fl" style="margin-bottom:6px">Dirigeants</div>
            ${c.directors.map(d=>`<div class="mo-fv" style="margin-bottom:2px">${d.name} - <em>${d.role}</em></div>`).join('')}
          </div>`:''}
        <div class="mo-btns">
          <button class="mo-btn" onclick="closeModal()">Fermer</button>
        </div>`;
      document.getElementById('modal').style.display='flex';
      toast('Détails chargés');
    }
  }catch(e){
    showLiveModal(base);
    toast('Détails partiels affichés');
  }
}

async function fetchStructuredCompany(base){
  if(!base||!base.name||base.ice&&base.rc&&base.addr)return null;
  try{
    const r=await fetch(`/api/search?q=${encodeURIComponent(base.name)}&mode=nom`);
    const data=await r.json();
    const matches=(data.results||[]).filter(c=>isSameCompany(base,c));
    if(!matches.length)return null;
    const match=matches.sort((a,b)=>dataCompleteness(b)-dataCompleteness(a))[0];
    cacheCompany(match);
    return match;
  }catch{
    return null;
  }
}

function showLiveModal(c){
  cacheCompany(c);
  document.getElementById('modal-body').innerHTML=`
    <div class="mo-name">${c.name}</div>
    ${c.type?`<div class="mo-type">${c.type}</div>`:''}
    <div class="mo-grid">
      ${c.ice?`<div class="mo-field"><div class="mo-fl">ICE</div><div class="mo-fv amber">${c.ice}</div></div>`:''}
      ${c.if_?`<div class="mo-field"><div class="mo-fl">IF</div><div class="mo-fv">${c.if_}</div></div>`:''}
      ${c.rc?`<div class="mo-field"><div class="mo-fl">RC</div><div class="mo-fv">${c.rc}</div></div>`:''}
      ${c.pat?`<div class="mo-field"><div class="mo-fl">Patente</div><div class="mo-fv">${c.pat}</div></div>`:''}
      ${c.date?`<div class="mo-field"><div class="mo-fl">Création</div><div class="mo-fv">${formatCompanyDate(c.date)}</div></div>`:''}
      ${c.ville?`<div class="mo-field"><div class="mo-fl">Ville</div><div class="mo-fv">${c.ville}</div></div>`:''}
      ${c.tel?`<div class="mo-field"><div class="mo-fl">Téléphone</div><div class="mo-fv">${c.tel}</div></div>`:''}
      ${c.email?`<div class="mo-field"><div class="mo-fl">Email</div><div class="mo-fv">${c.email}</div></div>`:''}
      ${c.cap?`<div class="mo-field"><div class="mo-fl">Capital</div><div class="mo-fv">${c.cap}</div></div>`:''}
    </div>
    ${c.act?`<div class="mo-act">${c.act}</div>`:''}
    ${c.addr?`<div class="mo-field" style="margin-bottom:16px"><div class="mo-fl">Adresse</div><div class="mo-fv">${c.addr}</div></div>`:''}
    <div class="mo-btns">
      <button class="mo-btn" onclick="closeModal()">Fermer</button>
    </div>`;
  document.getElementById('modal').style.display='flex';
}

function useLiveClient(name,addr,ville,email,ice,tel=''){
  closeModal(); showPage('invoice');
  setTimeout(()=>{
    sv('c-name',name); sv('c-addr',addr); sv('c-city',ville); sv('c-ice',ice);
    if(tel)sv('c-tel',tel);
    toast('Client rempli automatiquement');
  },200);
}

function renderResults(res,q){
  document.getElementById('empty-state').style.display='flex';
  const panel=document.getElementById('results-panel');
  panel.style.display='block';
  document.getElementById('res-count-badge').textContent=`${res.length} résultat${res.length!==1?'s':''}`;
  const list=document.getElementById('res-list');
  const empty=document.getElementById('res-empty');
  if(!res.length){
    list.innerHTML='';
    const emptyText=empty.querySelector('p');
    if(emptyText){
      emptyText.textContent=searchMode==='ice'
        ?"ICE introuvable dans les données chargées. Essayez d'abord le nom de l'entreprise pour récupérer ses informations complètes."
        :"Vérifiez l'orthographe ou essayez un autre terme.";
    }
    empty.style.display='block';
    return;
  }
  empty.style.display='none';
  
  function esc(str){
    return (str||'').replace(/'/g,"\\'").replace(/"/g,"&quot;");
  }

  list.innerHTML=res.map(c=>{
    const isLive=c._live;
    const addrText = [c.addr, c.ville].filter(Boolean).join(' - ');
    const createdAt=formatCompanyDate(c.date);

    return `
    <div class="co-card ${isLive?'co-card-live':''}" style="padding: 16px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px; flex-wrap:wrap; gap:12px;">
        <div style="flex: 1 1 min-content;">
          <div style="font-weight:700; font-size:18px; color:var(--text-main); margin-bottom:4px; word-break:break-word;">${c.name}</div>
          ${c.statut ? `<span class="co-badge ${c.statut==='Actif'?'b-actif':'b-dissous'}">${c.statut==='Actif'?'EN ACTIVITÉ':'DISSOUS'}</span>` : ''}
        </div>
      </div>

      <div style="display:grid; grid-template-columns: 1fr; gap:8px; font-size:14px; color:var(--text-light);">
        ${c.act ? `<div><strong style="color:var(--text-main)">Activité :</strong> 
          ${c.act.length > 80 ? `
            <span id="act-short-${c.id}">${c.act.substring(0, 80)}<span style="color:var(--primary); cursor:pointer; font-weight:700;" onclick="document.getElementById('act-short-${c.id}').style.display='none'; document.getElementById('act-full-${c.id}').style.display='inline';">...</span></span>
            <span id="act-full-${c.id}" style="display:none;">${c.act} <span style="color:var(--primary); cursor:pointer; font-weight:700; margin-left:4px;" onclick="document.getElementById('act-full-${c.id}').style.display='none'; document.getElementById('act-short-${c.id}').style.display='inline';">Voir moins</span></span>
          ` : `<span>${c.act}</span>`}
        </div>` : ''}
        ${addrText ? `<div><strong style="color:var(--text-main)">Adresse :</strong> ${addrText}</div>` : ''}
        
        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap:12px; margin-top:8px; background:var(--bg-lighter); padding:12px; border-radius:8px; border:1px solid var(--border-color);">
          ${c.rc ? `<div><strong style="color:var(--text-main); display:block; font-size:11px; text-transform:uppercase; letter-spacing:0.5px;">RC</strong> <span style="font-size:15px; word-break:break-word;">${c.rc}</span></div>` : ''}
          <div><strong style="color:var(--text-main); display:block; font-size:11px; text-transform:uppercase; letter-spacing:0.5px;">ICE</strong> ${c.ice ? `<div style="display:flex; align-items:center; gap:6px;"><span style="font-size:15px; font-family:monospace; color:var(--primary); font-weight:600; word-break:break-all;">${c.ice}</span><button onclick="copyICE('${c.ice}')" style="background:transparent; border:none; cursor:pointer; color:var(--muted); padding:2px; display:flex; align-items:center; justify-content:center;" title="Copier l'ICE"><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2"></path><rect x="8" y="8" width="14" height="14" rx="2" ry="2"></rect></svg></button></div>` : `<span style="font-size:15px; color:var(--muted); font-weight:700;">Non disponible</span>`}</div>
          ${c.type ? `<div><strong style="color:var(--text-main); display:block; font-size:11px; text-transform:uppercase; letter-spacing:0.5px;">Forme juridique</strong> <span style="font-size:15px; word-break:break-word;">${c.type}</span></div>` : ''}
          ${c.cap ? `<div><strong style="color:var(--text-main); display:block; font-size:11px; text-transform:uppercase; letter-spacing:0.5px;">Capital</strong> <span style="font-size:15px">${c.cap}</span></div>` : ''}
          ${createdAt ? `<div><strong style="color:var(--text-main); display:block; font-size:11px; text-transform:uppercase; letter-spacing:0.5px;">Date Création</strong> <span style="font-size:15px">${createdAt}</span></div>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

function clearSearch(){
  document.getElementById('results-panel').style.display='none';
  document.getElementById('empty-state').style.display='flex';
  document.getElementById('res-list').innerHTML='';
}

// Copy ICE
function copyICE(ice){
  navigator.clipboard?.writeText(ice).then(()=>toast('ICE copié : '+ice)).catch(()=>toast('ICE : '+ice));
}

function initBusinessTools(){
  const today=new Date().toISOString().split('T')[0];
  sv('due-start',today);
  verifyIceInput();
  calcSalarySim();
  convertWordsTool();
  calcTvaTool();
  calcMarginTool();
  calcDueDateTool();
}

function verifyIceInput(){
  const input=document.getElementById('ice-check-input');
  const box=document.getElementById('ice-check-result');
  if(!input||!box)return;
  const digits=input.value.replace(/\D/g,'');
  if(input.value!==digits)input.value=digits;
  if(!digits){
    box.innerHTML=`<div class="result-label">Résultat</div><strong>En attente d'un ICE</strong><p>Saisissez un numéro pour commencer.</p>`;
    return;
  }
  if(digits.length!==15){
    box.innerHTML=`<div class="result-label">Format</div><strong class="bad">ICE incomplet</strong><p>${digits.length}/15 chiffres. Un ICE marocain doit contenir exactement 15 chiffres.</p>`;
    return;
  }
  box.innerHTML='<div class="result-label">Format</div><strong class="good">Format valide</strong><p>Le numéro contient 15 chiffres. Vous pouvez lancer la recherche dans les sources disponibles.</p>';
}

async function verifyIceAndSearch(){
  const input=document.getElementById('ice-check-input');
  const box=document.getElementById('ice-check-result');
  if(!input||!box)return;
  const ice=input.value.replace(/\D/g,'');
  verifyIceInput();
  if(ice.length!==15)return;
  box.innerHTML='<div class="result-label">Recherche</div><strong>Recherche en cours...</strong><p>Consultation des données chargées et découvertes.</p>';
  const local=DB.find(c=>String(c.ice||'').replace(/\D/g,'')===ice);
  if(local){
    box.innerHTML=`<div class="result-label">Entreprise trouvée</div><strong class="good">${local.name}</strong><p>${[local.type,local.ville,local.rc].filter(Boolean).join(' · ')}</p><button class="tool-secondary" onclick="openModal(${local.id})">Voir la fiche</button>`;
    return;
  }
  try{
    const r=await fetch(`/api/search?q=${encodeURIComponent(ice)}&mode=ice`);
    const data=await r.json();
    const c=data.results&&data.results[0];
    if(c){
      const item={id:89000,name:c.name,type:c.type||'',ice:c.ice||'',rc:c.rc||'',addr:c.addr||'',ville:c.ville||'',act:c.act||'',date:formatCompanyDate(c.date||''),cap:c.cap||'',statut:c.statut||'Actif',_live:true,_url:c.url,_slug:c.slug,_source:'charika'};
      lastLiveResults.set(item.id,item);
      cacheCompany(item);
      box.innerHTML=`<div class="result-label">Entreprise trouvée</div><strong class="good">${item.name}</strong><p>${[item.type,item.ville,item.rc].filter(Boolean).join(' · ')}</p><button class="tool-secondary" onclick="fetchLiveDetails(${item.id})">Voir la fiche</button>`;
      return;
    }
  }catch{}
  box.innerHTML=`<div class="result-label">Recherche</div><strong class="bad">Aucune fiche trouvée</strong><p>Le format est valide, mais aucune entreprise correspondante n'est disponible dans les données chargées.</p>`;
}

function money(v){
  return (Number(v)||0).toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2})+' MAD';
}

function readNum(id, fallback=0){
  const value=parseFloat(document.getElementById(id)?.value);
  return Number.isFinite(value)?value:fallback;
}

function calcIrAnnual(taxable){
  const brackets=[
    [40000,0],
    [60000,.10],
    [80000,.20],
    [100000,.30],
    [180000,.34],
    [Infinity,.37],
  ];
  let prev=0;
  let tax=0;
  for(const [limit,rate] of brackets){
    if(taxable<=prev)break;
    const slice=Math.min(taxable,limit)-prev;
    tax+=slice*rate;
    prev=limit;
  }
  return Math.max(0,tax);
}

function calcSalarySim(){
  const box=document.getElementById('salary-result');
  if(!box)return;
  const gross=Math.max(0,readNum('salary-gross'));
  const dependents=Math.min(6,Math.max(0,readNum('salary-dependents')));
  const expenseRate=Math.max(0,readNum('salary-expense-rate'))/100;
  const cnssRate=Math.max(0,readNum('salary-cnss-rate'))/100;
  const amoRate=Math.max(0,readNum('salary-amo-rate'))/100;
  const employerRate=Math.max(0,readNum('salary-employer-rate'))/100;
  const cnssCap=Math.max(0,readNum('salary-cnss-cap',6000));
  const cnss=Math.min(gross,cnssCap)*cnssRate;
  const amo=gross*amoRate;
  const annualGross=gross*12;
  const annualSocial=(cnss+amo)*12;
  const professionalExpenses=annualGross*expenseRate;
  const annualTaxable=Math.max(0,annualGross-annualSocial-professionalExpenses);
  const familyDeduction=dependents*30*12;
  const irMonthly=Math.max(0,(calcIrAnnual(annualTaxable)-familyDeduction)/12);
  const net=gross-cnss-amo-irMonthly;
  const employerCost=gross+(gross*employerRate);
  box.innerHTML=`
    <div class="result-label">Résumé mensuel</div>
    <div class="salary-main"><span>Net estimé</span><strong>${money(net)}</strong></div>
    <div class="calc-lines">
      <div><span>Brut</span><strong>${money(gross)}</strong></div>
      <div><span>CNSS salarié</span><strong>${money(cnss)}</strong></div>
      <div><span>AMO salarié</span><strong>${money(amo)}</strong></div>
      <div><span>IR estimé</span><strong>${money(irMonthly)}</strong></div>
      <div><span>Coût employeur estimé</span><strong>${money(employerCost)}</strong></div>
    </div>
    <p>Les taux sont modifiables. Vérifiez toujours le calcul final avec votre comptable ou les barèmes officiels.</p>`;
}

function convertWordsTool(){
  const amount=readNum('words-amount');
  const currency=document.getElementById('words-currency')?.value||'MAD';
  const whole=Math.floor(Math.max(0,amount));
  const cents=Math.round((Math.max(0,amount)-whole)*100);
  const names={MAD:['dirhams','centimes'],EUR:['euros','centimes'],USD:['dollars','cents']};
  const [unit,sub]=names[currency]||names.MAD;
  let text=`${n2w(whole)} ${unit}`;
  if(cents)text+=` et ${n2w(cents).toLowerCase()} ${sub}`;
  sv2('words-result',text);
}

function copyWordsResult(){
  const text=document.getElementById('words-result')?.textContent||'';
  navigator.clipboard?.writeText(text).then(()=>toast('Texte copié')).catch(()=>toast(text));
}

function calcTvaTool(){
  const base=readNum('tva-base');
  const rate=readNum('tva-rate-tool')/100;
  const tax=base*rate;
  const total=base+tax;
  sv2('tva-tool-result',`TVA : ${money(tax)} · TTC : ${money(total)}`);
}

function calcMarginTool(){
  const cost=readNum('margin-cost');
  const sale=readNum('margin-sale');
  const margin=sale-cost;
  const rate=sale?margin/sale*100:0;
  sv2('margin-tool-result',`Marge : ${money(margin)} · Taux : ${rate.toLocaleString('fr-FR',{maximumFractionDigits:2})}%`);
}

function calcDueDateTool(){
  const start=document.getElementById('due-start')?.value;
  const days=readNum('due-days',30);
  if(!start)return;
  const d=new Date(`${start}T00:00:00`);
  d.setDate(d.getDate()+days);
  sv2('due-tool-result',`Échéance : ${d.toLocaleDateString('fr-FR')}`);
}

// Modal
function openModal(id){
  const c=DB.find(x=>x.id===id); if(!c) return;
  document.getElementById('modal-body').innerHTML=`
    <div class="mo-name">${c.name}</div>
    ${c.type?`<div class="mo-type">${c.type}</div>`:''}
    ${c.cap||c.date?`<div class="mo-capital">${c.cap?`Capital social : <strong>${c.cap}</strong>`:''}${c.cap&&c.date?' · ':''}${c.date?`Créée le ${formatCompanyDate(c.date)}`:''}</div>`:''}
    <div class="mo-grid">
      ${c.ice?`<div class="mo-field"><div class="mo-fl">ICE</div><div class="mo-fv amber">${c.ice}</div></div>`:''}
      ${c.if_?`<div class="mo-field"><div class="mo-fl">Identifiant Fiscal (IF)</div><div class="mo-fv">${c.if_}</div></div>`:''}
      ${c.rc?`<div class="mo-field"><div class="mo-fl">Registre de Commerce</div><div class="mo-fv">${c.rc}</div></div>`:''}
      ${c.pat?`<div class="mo-field"><div class="mo-fl">Patente</div><div class="mo-fv">${c.pat}</div></div>`:''}
      ${c.date?`<div class="mo-field"><div class="mo-fl">Date de création</div><div class="mo-fv">${formatCompanyDate(c.date)}</div></div>`:''}
      <div class="mo-field"><div class="mo-fl">État</div><div class="mo-fv ${c.statut==='Actif'?'green':'red'}">${c.statut==='Actif'?'En activité':'Dissous'}</div></div>
      ${c.ville?`<div class="mo-field"><div class="mo-fl">Ville</div><div class="mo-fv">${c.ville}</div></div>`:''}
    </div>
    ${c.act?`<div class="mo-act">${c.act}</div>`:''}
    ${c.addr||c.ville?`<div class="mo-field" style="margin-bottom:16px"><div class="mo-fl">Adresse officielle</div><div class="mo-fv">${[c.addr,c.ville].filter(Boolean).join(', ')} - Maroc</div></div>`:''}
    <div class="mo-btns">
      <button class="mo-btn" onclick="closeModal()">Fermer</button>
    </div>`;
  document.getElementById('modal').style.display='flex';
}
function closeModal(){document.getElementById('modal').style.display='none';}

function useClient(id){
  const c=DB.find(x=>x.id===id); if(!c) return;
  closeModal(); showPage('invoice');
  setTimeout(()=>{
    sv('c-name',c.name); sv('c-addr',c.addr); sv('c-city',c.ville);
    sv('c-if',c.if_); sv('c-ice',c.ice);
    toast('Client rempli automatiquement');
  },200);
}

// Invoice
let lc=0;
function addRow(){
  lc++;const id=lc;
  const tr=document.createElement('tr'); tr.id='r'+id;
  tr.innerHTML=`
    <td><input class="pf" type="text" placeholder="Description" oninput="calc()"/></td>
    <td><select class="pf" onchange="calc()"><option>U</option><option>Pièce</option><option>Heure</option><option>Jour</option><option>Forfait</option><option>Kg</option><option>M²</option></select></td>
    <td><input class="pf" type="number" value="1" min="0" oninput="calc()"/></td>
    <td><input class="pf" type="number" value="0" min="0" step="0.01" oninput="calc()"/></td>
    <td class="td-t" id="lt${id}">0,00</td>
    <td class="no-print"><button class="del-r" onclick="delRow(${id})">×</button></td>`;
  document.getElementById('tbody').appendChild(tr); calc();
}
function delRow(id){document.getElementById('r'+id)?.remove();calc();}
function calc(){
  const cur=document.getElementById('cur').value||'MAD';
  const tva=parseFloat(document.getElementById('tva').value)||0;
  let ht=0;
  document.querySelectorAll('#tbody tr').forEach(tr=>{
    const n=tr.querySelectorAll('input[type=number]');
    if(n.length<2)return;
    const v=(parseFloat(n[0].value)||0)*(parseFloat(n[1].value)||0);
    ht+=v; const c=tr.querySelector('.td-t'); if(c)c.textContent=fmt(v);
  });
  const tv=ht*tva/100,ttc=ht+tv;
  sv2('t-ht',`${fmt(ht)} ${cur}`);sv2('t-tva',`${fmt(tv)} ${cur}`);sv2('t-ttc',`${fmt(ttc)} ${cur}`);
  sv2('tva-lbl',`TVA (${tva}%)`);
  sv2('t-words',n2w(Math.round(ttc))+' '+(cur==='MAD'?'dirhams':cur.toLowerCase()));
}
function fmt(n){return n.toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2});}
function syncCompany(){
  const n=document.getElementById('s-name')?.value||'';
  const el=document.getElementById('ph-logo-box');
  if(el)el.textContent=n?'Société':'ICE';
  const c=document.getElementById('ph-company'); if(c)c.textContent=n||'Nom de votre société';
  const city=document.getElementById('s-city')?.value;
  const tel=document.getElementById('s-tel')?.value;
  const email=document.getElementById('s-email')?.value;
  const m=document.getElementById('ph-meta-line');
  if(m)m.textContent=[city,tel,email].filter(Boolean).join(' · ');
}
function syncNum(){
  const v=document.getElementById('inv-num')?.value||'';
  const el=document.getElementById('ph-inv-num'); if(el)el.textContent='#'+v;
}
function syncDocType(){
  const value=document.getElementById('doc-type')?.value||'FACTURE CONFORME';
  sv2('ph-doc-type',value);
  const label=value.charAt(0)+value.slice(1).toLowerCase();
  sv2('paper-doc-type',label);
}
const VF=['s-name','s-addr','s-city','s-tel','s-email','s-if','s-rc','s-ice','pay-method','pay-bank','pay-rib'];
function saveVendor(){const d={};VF.forEach(i=>{d[i]=document.getElementById(i)?.value||'';});localStorage.setItem('icm4',JSON.stringify(d));toast('Sauvegardé');}
function loadVendor(){try{const d=JSON.parse(localStorage.getItem('icm4')||'{}');VF.forEach(i=>{const e=document.getElementById(i);if(e&&d[i])e.value=d[i];});syncCompany();}catch(e){}}
function clearInv(){
  if(!confirm('Effacer la facture ?'))return;
  document.querySelectorAll('#paper input,#paper select,#paper textarea').forEach(e=>{if(e.tagName==='SELECT')e.selectedIndex=0;else e.value='';});
  document.getElementById('tbody').innerHTML='';lc=0;addRow();
  const today=new Date();
  const due=new Date(); due.setDate(due.getDate()+30);
  sv('inv-date',today.toISOString().split('T')[0]);
  sv('inv-due',due.toISOString().split('T')[0]);
  sv('inv-num',`${today.getFullYear()}-001`);
  calc();syncCompany();syncNum();syncDocType();
}
function fitInvoiceForPrint(){
  const paper=document.getElementById('paper');
  if(!paper)return;
  paper.style.removeProperty('--print-scale');
  const a4ContentHeightPx=1046; // A4 height minus 8mm margins at 96dpi.
  const scale=Math.min(1,Math.max(.72,a4ContentHeightPx/paper.scrollHeight));
  paper.style.setProperty('--print-scale',scale.toFixed(3));
}
function resetInvoicePrintFit(){
  document.getElementById('paper')?.style.removeProperty('--print-scale');
}
window.addEventListener('beforeprint',fitInvoiceForPrint);
window.addEventListener('afterprint',resetInvoicePrintFit);
function sv(id,v){const e=document.getElementById(id);if(e)e.value=v;}
function sv2(id,v){const e=document.getElementById(id);if(e)e.textContent=v;}
function esc(v){return String(v).replace(/\\/g,'\\\\').replace(/'/g,"\\'");}
function n2w(n){
  if(!n)return 'Zéro';
  const o=['','Un','Deux','Trois','Quatre','Cinq','Six','Sept','Huit','Neuf','Dix','Onze','Douze','Treize','Quatorze','Quinze','Seize','Dix-sept','Dix-huit','Dix-neuf'];
  const t=['','','Vingt','Trente','Quarante','Cinquante','Soixante','Soixante','Quatre-vingt','Quatre-vingt'];
  function b(n){if(n<20)return o[n];const q=Math.floor(n/10),r=n%10;if(q===7)return 'Soixante-'+(r===1?'et-onze':o[10+r]);if(q===9)return 'Quatre-vingt-'+o[r];return t[q]+(r===1&&q!==8?' et ':r?'-':'')+(r?o[r]:q===8?'s':'');}
  function h(n){if(n<100)return b(n);const c=Math.floor(n/100),r=n%100;return(c>1?o[c]+' ':'')+'Cent'+(c>1&&!r?'s':'')+(r?' '+b(r):'');}
  if(n<1000)return h(n);
  if(n<1e6){const k=Math.floor(n/1000),r=n%1000;return(k>1?h(k)+' ':'')+'Mille'+(r?' '+h(r):'');}
  const m=Math.floor(n/1e6),r=n%1e6;return h(m)+' Million'+(m>1?'s':'')+(r?' '+n2w(r):'');
}
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.style.opacity='1';clearTimeout(t._t);t._t=setTimeout(()=>t.style.opacity='0',2600);}
