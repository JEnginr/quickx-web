// QX Web 1.10 Beta v0.6 native Inventory Adjust module.
// Adjust Out and Adjust In share one UI and the main QuickX RF Plus session.
// SQL endpoints are read-only and mode-specific; every inventory change uses RF Plus.
(function(){
  const templateHtml = `
<div class="adj-module">
  <div class="card adj-mode-card">
    <div class="adj-mode-title"><div><b>Inventory Adjust</b><span id="modeHelp">Remove inventory from a location that currently has stock.</span></div></div>
    <div class="adj-mode-switch" role="tablist" aria-label="Inventory adjustment type">
      <button id="modeOutBtn" class="adj-mode-btn active" role="tab" aria-selected="true">Adjust Out</button>
      <button id="modeInBtn" class="adj-mode-btn" role="tab" aria-selected="false">Adjust In</button>
    </div>
  </div>

  <div class="card adj-hero">
    <div class="card-header"><span id="singleTitle">Fast Adjust Out</span><span class="dim" id="singleSub">RF Plus transaction</span></div>
    <div class="card-body adj-compact-body">
      <div class="adj-top-grid">
        <div class="fg adj-part-box"><label>1 · Part ID</label><input id="partInput" class="adj-big" placeholder="scan/type part and press Enter" autocomplete="off"></div>
        <div class="fg"><label>2 · Qty</label><input id="qtyInput" class="adj-big" type="number" min="0" step="any" placeholder="qty"></div>
        <div class="fg"><label>UOM</label><input id="uomInput" class="adj-big" value="EA"></div>
        <div class="fg adj-desc-box"><label>3 · Transaction Description</label><select id="quickDescSelect"></select></div>
        <div class="fg adj-reason-box"><label>Reason</label><select id="reasonSelect"><option value="">Select reason...</option></select></div>
      </div>
      <div class="adj-manual-row hidden" id="manualRow"><div class="fg"><label>Transaction Description</label><input id="commentInput" placeholder="type description"></div></div>

      <div class="adj-selected-strip">
        <div class="fg"><label><span id="locationLabel">Selected Location</span></label><input id="locInput" list="locationSuggestions" placeholder="location" autocomplete="off"><datalist id="locationSuggestions"></datalist></div>
        <div><span id="stockLabel">Available Stock</span><b id="selStockText">—</b></div>
        <div class="fg"><label>Trace / Lot / Serial</label><input id="traceInput" placeholder="optional / RF Plus rules apply" autocomplete="off"></div>
        <div class="fg hidden" id="locStatusBlock"><label>New Location Status Required</label><select id="locStatusSelect"><option value="">Select status...</option><option value="A">A · Available</option><option value="U">U · Unavailable</option><option value="H">H · Hold</option></select></div>
      </div>

      <div class="adj-actions">
        <button class="btn btn-primary" id="findBtn">🔎 FIND / VALIDATE PART</button>
        <button class="btn btn-danger" id="submitBtn" disabled>⚠ ADJUST OUT</button>
        <button class="btn btn-ghost" id="clearBtn">✕ CLEAR</button>
      </div>
      <div class="adj-key-help" id="keyHelp">Keyboard: Enter on Part = find stock · Enter on Qty = move to Adjust Out · Ctrl+Enter = submit with confirmation.</div>
    </div>
  </div>

  <div id="statBar" class="adj-statbar hidden"></div>

  <div class="card">
    <div class="card-header"><span id="massTitle">Mass Adjust Out</span><span class="dim" id="massSubtitle">paste Part ID + Qty from Excel</span></div>
    <div class="card-body adj-compact-body">
      <div class="adj-mass-grid">
        <div class="fg"><label>Excel Paste Area</label><textarea id="massPaste" rows="7"></textarea></div>
        <div class="adj-mass-side">
          <div class="adj-mass-hint" id="massHint"></div>
          <button class="btn btn-success" id="massProcessBtn">⚡ MASS ADJUST OUT</button>
          <button class="btn btn-ghost" id="massPrepareBtn">🔎 PREPARE ONLY</button>
          <button class="btn btn-ghost" id="massClearBtn">✕ CLEAR MASS</button>
        </div>
      </div>
      <div class="adj-mass-progress hidden" id="massProgress"><div id="massProgressLabel"></div><div class="pw"><div class="pb" id="massProgressBar"></div></div></div>
      <div class="adj-table-wrap adj-mass-table-wrap"><table><thead><tr><th>#</th><th>Part</th><th class="adj-center">Qty</th><th>Location</th><th>Trace</th><th class="adj-center" id="massStockHead">Stock</th><th>Status</th></tr></thead><tbody id="massTb"><tr><td colspan="7" class="empty">Paste Excel rows above.</td></tr></tbody></table></div>
    </div>
  </div>

  <div class="card">
    <div class="card-header"><span id="locationsTitle">Stock Locations</span><span id="resultCount" class="dim"></span></div>
    <div class="adj-filters"><input id="locFilter" placeholder="filter location..."><input id="traceFilter" placeholder="filter trace..."></div>
    <div class="adj-table-wrap"><table><thead><tr><th>Part</th><th>Description</th><th>Location</th><th class="adj-center">Available</th><th>UOM</th><th>Trace</th><th>Status</th></tr></thead><tbody id="resultTb"><tr><td colspan="7" class="empty">Enter a part and press Enter.</td></tr></tbody></table></div>
  </div>

  <details class="adj-advanced"><summary>Advanced / API Debug</summary><div class="adj-advanced-content"><button class="btn btn-ghost" id="loadReasonsBtn">📋 RELOAD REASONS</button><textarea id="debug" rows="8" readonly></textarea></div></details>
</div>`;

  const templateCss = `
:host{display:block;color:var(--text);font-family:var(--font,'Segoe UI',system-ui,sans-serif);min-width:0;color-scheme:dark;}
*{box-sizing:border-box}.hidden{display:none!important}.adj-module{display:block;min-width:0}.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:14px;overflow:hidden;box-shadow:var(--shadow-card)}
.card-header{padding:12px 15px;border-bottom:1px solid var(--border);font-size:11px;text-transform:uppercase;letter-spacing:.65px;color:var(--muted);font-weight:800;display:flex;justify-content:space-between;align-items:center;gap:10px}.card-body{padding:16px}.adj-compact-body{padding:15px}.dim{color:var(--muted);font-size:11.5px}
.adj-mode-card{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:13px 15px}.adj-mode-title b{display:block;font-size:15px}.adj-mode-title span{display:block;color:var(--muted);font-size:11px;margin-top:3px}.adj-mode-switch{display:inline-flex;padding:4px;border:1px solid var(--border-strong);border-radius:11px;background:#0d1118;gap:4px}.adj-mode-btn{appearance:none;border:0;border-radius:8px;padding:9px 18px;min-height:40px;background:transparent;color:var(--muted);font-weight:850;cursor:pointer}.adj-mode-btn.active{background:var(--primary);color:#02232a;box-shadow:0 1px 0 rgba(255,255,255,.2) inset}
.fg{display:flex;flex-direction:column;gap:5px;min-width:0}.fg label{font-size:10.5px;color:var(--muted);text-transform:uppercase;font-weight:750;letter-spacing:.45px}
input,select,textarea{box-sizing:border-box;width:100%;background:#151a22!important;border:1px solid var(--border-strong);color:#e8edf5!important;border-radius:9px;padding:9px 11px;font-size:13px;outline:none;font-family:inherit;color-scheme:dark!important;-webkit-text-fill-color:#e8edf5}
select option,select optgroup{background:#151a22!important;color:#e8edf5!important;color-scheme:dark!important;-webkit-text-fill-color:#e8edf5}select option:checked{background:#2a83c9!important;color:#fff!important}select:disabled,option:disabled,input:disabled{background:#10141b!important;color:#7f8998!important;-webkit-text-fill-color:#7f8998;opacity:.75}
input:focus,select:focus,textarea:focus{border-color:var(--primary);box-shadow:0 0 0 3px var(--accent-glow)}input::placeholder,textarea::placeholder{color:var(--muted);opacity:.6;-webkit-text-fill-color:var(--muted)}#massPaste{background:#11161e!important;color:var(--text)!important;-webkit-text-fill-color:var(--text);resize:vertical;min-height:140px;line-height:1.4}#massPaste::placeholder{color:var(--muted)!important;-webkit-text-fill-color:var(--muted)!important;opacity:.6}.adj-big{font-size:15px;font-weight:750;letter-spacing:.4px;font-family:var(--mono,Consolas,monospace)}
.adj-top-grid{display:grid;grid-template-columns:minmax(180px,1.45fr) minmax(80px,.55fr) minmax(72px,.45fr) minmax(220px,1.35fr) minmax(180px,1.1fr);gap:10px;align-items:end}.adj-manual-row{margin-top:10px}
.adj-selected-strip{margin-top:12px;border:1px solid var(--border);background:var(--row-hover);border-radius:10px;display:grid;grid-template-columns:minmax(180px,1fr) .7fr minmax(180px,1fr) minmax(180px,.8fr);gap:12px;padding:10px 12px;align-items:end}.adj-selected-strip span{display:block;color:var(--muted);font-size:10.5px;text-transform:uppercase;font-weight:800;letter-spacing:.4px;margin-bottom:8px}.adj-selected-strip b{display:block;font-family:var(--mono,Consolas,monospace);color:var(--success);font-size:16px;padding-bottom:9px}.primary-location-text{color:var(--warning)!important;-webkit-text-fill-color:var(--warning)!important;font-weight:850}
.adj-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px}.btn{min-height:40px;border-radius:9px;border:1px solid transparent;padding:9px 16px;font-size:13px;font-weight:750;cursor:pointer;display:inline-flex;gap:6px;align-items:center;justify-content:center;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,.16),0 1px 0 rgba(255,255,255,.12) inset;transition:filter .12s ease,transform .06s ease}.btn:hover:not(:disabled){filter:brightness(1.05)}.btn:active:not(:disabled){transform:translateY(1px)}.btn:disabled{opacity:.42;cursor:not-allowed;filter:saturate(.55)}.btn-primary{background:linear-gradient(180deg,color-mix(in srgb,var(--primary) 92%,white),var(--primary));border-color:color-mix(in srgb,var(--primary) 70%,black);color:#03222a}.btn-success{background:linear-gradient(180deg,color-mix(in srgb,var(--success) 90%,white),var(--success));border-color:color-mix(in srgb,var(--success) 68%,black);color:#04231a}.btn-danger{background:linear-gradient(180deg,color-mix(in srgb,var(--danger) 92%,white),var(--danger));border-color:color-mix(in srgb,var(--danger) 70%,black);color:#fff}.btn-warning{background:linear-gradient(180deg,color-mix(in srgb,var(--warning) 92%,white),var(--warning));border-color:color-mix(in srgb,var(--warning) 70%,black);color:#332600}.btn-ghost{background:linear-gradient(180deg,color-mix(in srgb,var(--surface2) 80%,white 6%),var(--surface2));border-color:var(--border-strong);color:var(--text)}.adj-key-help{margin-top:10px;color:var(--muted);font-size:11.5px}.adj-statbar{margin:0 0 14px;padding:10px 13px;border-radius:10px;border:1px solid var(--border);font-size:12.5px;font-weight:650}.adj-statbar.ok{color:var(--success);border-color:color-mix(in srgb,var(--success) 45%,transparent);background:color-mix(in srgb,var(--success) 8%,var(--surface))}.adj-statbar.err{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 45%,transparent);background:color-mix(in srgb,var(--danger) 8%,var(--surface))}.adj-statbar.ld{color:var(--primary)}
.adj-mass-grid{display:grid;grid-template-columns:minmax(380px,1.6fr) minmax(220px,.7fr);gap:14px}.adj-mass-side{display:flex;flex-direction:column;gap:9px}.adj-mass-hint{border:1px solid var(--border);background:var(--row-hover);border-radius:9px;padding:11px;color:var(--muted);font-size:11.5px;line-height:1.55}.adj-mass-progress{margin-top:12px;color:var(--muted);font-size:11.5px}.pw{height:7px;background:#0c1016;border:1px solid var(--border);border-radius:99px;overflow:hidden;margin-top:6px}.pb{height:100%;background:var(--primary);width:0}.adj-filters{display:flex;gap:8px;padding:9px 12px;border-bottom:1px solid var(--border);background:var(--row-hover)}.adj-filters input{flex:1;padding:7px 10px}.adj-table-wrap{overflow:auto;max-height:560px}.adj-mass-table-wrap{max-height:440px;margin-top:12px;border:1px solid var(--border);border-radius:10px}table{width:100%;border-collapse:collapse;font-size:12.5px}th{text-align:left;color:var(--faint);font-size:10.5px;text-transform:uppercase;letter-spacing:.45px;padding:9px 10px;border-bottom:1px solid var(--border);background:var(--surface);position:sticky;top:0;z-index:1}td{padding:9px 10px;border-bottom:1px solid var(--border);vertical-align:middle}tr:hover td{background:var(--row-hover)}tr.selected td{background:color-mix(in srgb,var(--primary) 12%,transparent)}tr[data-index]{cursor:pointer}.adj-center{text-align:center}.mono{font-family:var(--mono,Consolas,monospace)}.empty{text-align:center;padding:26px;color:var(--muted)}
.rowBadge,.massStatus{display:inline-block;border:1px solid var(--border);border-radius:999px;padding:3px 8px;font-size:9.5px;font-weight:900;text-transform:uppercase;color:var(--muted)}.rowBadge.sel,.massStatus.ready{border-color:var(--success);background:color-mix(in srgb,var(--success) 14%,transparent);color:var(--success)}.massStatus.need,.massStatus.processing{border-color:var(--warning);background:color-mix(in srgb,var(--warning) 12%,transparent);color:var(--warning)}.massStatus.failed,.massStatus.invalid{border-color:var(--danger);background:color-mix(in srgb,var(--danger) 12%,transparent);color:var(--danger)}.massStatus.completed{border-color:var(--primary);background:color-mix(in srgb,var(--primary) 12%,transparent);color:var(--primary)}.rowError{color:var(--danger);font-size:11px}.rowOk{color:var(--success);font-size:11px}.rowWarn{color:var(--warning);font-size:11px}.massLocSelect,.massLocInput,.massTraceInput,.massLocStatusSelect{min-width:150px;padding:6px 8px;font-size:12px}.massLocStatusSelect{margin-top:6px}
.adj-advanced{background:var(--surface);border:1px solid var(--border);border-radius:10px;margin-bottom:14px}.adj-advanced summary{padding:11px 14px;cursor:pointer;color:var(--muted);font-weight:800;text-transform:uppercase;font-size:11px;letter-spacing:.6px}.adj-advanced-content{border-top:1px solid var(--border);padding:12px;display:flex;gap:8px;flex-wrap:wrap}.adj-advanced-content textarea{min-height:140px;flex-basis:100%;font-family:var(--mono,Consolas,monospace);font-size:11.5px}
@media(max-width:1100px){.adj-top-grid{grid-template-columns:1fr 1fr}.adj-part-box,.adj-desc-box,.adj-reason-box{grid-column:span 2}.adj-selected-strip{grid-template-columns:1fr 1fr}.adj-mass-grid{grid-template-columns:1fr}.adj-actions .btn{flex:1}.adj-filters{flex-direction:column}}
@media(max-width:680px){.adj-mode-card{align-items:stretch;flex-direction:column}.adj-mode-switch{width:100%}.adj-mode-btn{flex:1}.adj-top-grid{grid-template-columns:1fr}.adj-part-box,.adj-desc-box,.adj-reason-box{grid-column:auto}.adj-selected-strip{grid-template-columns:1fr}.adj-actions{display:grid;grid-template-columns:1fr}.adj-actions .btn{width:100%}}
`;

  class QXInventoryAdjustElement extends HTMLElement {
    constructor(){ super(); this.attachShadow({mode:'open'}); this._initialized=false; this._activated=false; }
    connectedCallback(){
      if(this._initialized) return;
      this._initialized=true;
      const root=this.shadowRoot;
      root.innerHTML='<style>'+templateCss+'</style>'+templateHtml;
      const by=id=>root.getElementById(id);
      const state={
        mode:'out', reasons:[], rows:[], selectedIndex:-1, partInfo:null, partValidated:false,
        primaryLocation:'', primaryLocationValid:false, invalidDestination:'', filterLoc:'', filterTrace:'', massItems:[], massHash:'', massProcessing:false,
        submitting:false, lastSubmits:new Map(), sessionUser:'', reasonsLoaded:false
      };
      const fallbackReasons=[
        {code:'1351.7',desc:'R&D'},{code:'5510.1',desc:'BUILDING REPAIR-FACILITY'},{code:'5530',desc:'MILLING SUPPLY'},
        {code:'5555',desc:'INVENT. WRITE OFF'},{code:'5556',desc:'INVENTORY ADJUST'},{code:'5580',desc:'ROADBOX'},
        {code:'5583',desc:'KANBAN'},{code:'5588',desc:'SHOP SUPPLY'},{code:'5588.1',desc:'PAINT BOOTH'},
        {code:'5589',desc:'SHOP TOOLS'},{code:'5885.1',desc:'DEMO MAT/MISC'},{code:'5975',desc:'OFFICE SUPPLY'}
      ];
      const services=()=>window.QXServices||{};
      const warehouse=()=>{const s=services(); return (s.getWarehouse&&s.getWarehouse())||'QMIL';};
      const clean=msg=>{const s=services(); return s.cleanError?s.cleanError(msg):(msg||'Unknown error');};
      const notify=(msg,type,ms)=>{const s=services(); if(s.toast)s.toast(msg,type,ms);};
      const rfApi=async(endpoint,body)=>{const s=services(); if(!s.api) throw new Error('QuickX shared RF Plus service is not ready.'); return s.api(endpoint,body);};
      const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
      const isIn=()=>state.mode==='in';
      const sameLocation=(a,b)=>String(a||'').trim().toUpperCase()===String(b||'').trim().toUpperCase();
      function setPrimaryInfo(location,valid=true){state.primaryLocation=String(location||'').trim().toUpperCase();state.primaryLocationValid=!!(state.primaryLocation&&valid);updatePrimaryVisual();}
      function isPrimaryLocation(location,row=null){const loc=String(location||'').trim().toUpperCase();if(!loc)return false;return !!((state.primaryLocationValid&&sameLocation(loc,state.primaryLocation))||(row&&row.isPrimary&&sameLocation(loc,row.location)));}
      function isMassPrimary(item,location,row=null){const loc=String(location||'').trim().toUpperCase();if(!loc)return false;return !!((item&&item.primaryLocation&&sameLocation(loc,item.primaryLocation))||(row&&row.isPrimary&&sameLocation(loc,row.location)));}
      function updatePrimaryVisual(){const input=by('locInput');if(!input)return;input.classList.toggle('primary-location-text',isPrimaryLocation(input.value,selectedRow()));}
      function setStatus(msg,type){const el=by('statBar'); if(!el)return; if(!msg){el.classList.add('hidden');return;} el.textContent=msg; el.className='adj-statbar '+(type||'ld'); el.classList.remove('hidden');}
      function debug(obj){const el=by('debug'); if(el)el.value=typeof obj==='string'?obj:JSON.stringify(obj,null,2);}
      function firstVal(o,keys,def=''){
        if(!o||typeof o!=='object')return def; for(const k of keys){if(o[k]!==undefined&&o[k]!==null&&o[k]!=='')return o[k];}
        const map={}; Object.keys(o).forEach(k=>map[k.toLowerCase()]=k); for(const k of keys){const real=map[String(k).toLowerCase()];if(real&&o[real]!==undefined&&o[real]!==null&&o[real]!=='')return o[real];} return def;
      }
      function boolish(v){if(v===true||v===1)return true; return ['true','yes','y','1','a','b'].includes(String(v??'').trim().toLowerCase());}
      function numVal(v){const n=Number(String(v??'').replace(/,/g,''));return Number.isFinite(n)?n:0;}
      function firstObject(data){if(Array.isArray(data))return data[0]||{}; if(data&&typeof data==='object'){for(const k of ['Part','part','Item','item'])if(data[k]&&typeof data[k]==='object')return data[k];} return data||{};}
      function normalizePartInfo(data,part){const x=firstObject(data);const assign=String(firstVal(x,['AssignMethod','assignMethod','TraceAssign','traceAssign'],'')).trim().toUpperCase();const traceFlag=firstVal(x,['IsTraceable','isTraceable','Traceable','traceable'],null);return {raw:data,partId:String(firstVal(x,['PartId','partId','PartID','ID','Id'],part)).trim(),description:String(firstVal(x,['Desc','Description','description','PartDescription'],'')).trim(),uom:String(firstVal(x,['Uom','UOM','PartUOM','StockUM'],'EA')).trim().toUpperCase(),assignMethod:assign,isTraceable:boolish(traceFlag)||!!assign};}
      function responseBool(v){if(typeof v==='boolean')return v;if(typeof v==='number')return v!==0;if(v&&typeof v==='object'){for(const k of ['NeedSetPartLocationStatus','needSetPartLocationStatus','IsNeedSet','isNeedSet','Result','result','Value','value'])if(v[k]!==undefined)return responseBool(v[k]);}return ['true','yes','y','1'].includes(String(v??'').toLowerCase());}
      async function bridgeGet(path){const res=await fetch(path,{method:'GET',cache:'no-store',credentials:'same-origin'});const text=await res.text();let data;try{data=text?JSON.parse(text):{};}catch(e){throw new Error('QX server returned invalid data.');}if(!res.ok||data.ok===false)throw new Error(data.error||data.message||('HTTP '+res.status));return data;}
      async function bridgePost(path,body){const res=await fetch(path,{method:'POST',cache:'no-store',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});const text=await res.text();let data;try{data=text?JSON.parse(text):{};}catch(e){throw new Error('QX server returned invalid data.');}if(!res.ok||data.ok===false)throw new Error(data.error||data.message||('HTTP '+res.status));return data;}
      function debounce(fn,ms){let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms);};}
      function uniqueRows(rows){const seen=new Set(),out=[];for(const r of rows||[]){const k=[r.part,r.location,r.trace,r.qty].join('|');if(!seen.has(k)){seen.add(k);out.push(r);}}return out;}

      function reasonBodies(){return [{warehouseId:warehouse()}];}
      function extractReasons(data){const out=[];function walk(o){if(Array.isArray(o)){o.forEach(walk);return;}if(o&&typeof o==='object'){const code=firstVal(o,['Reason','ReasonId','ReasonID','ReasonCode','Code','ID','Id','id'],'');const desc=firstVal(o,['ReasonDescription','Description','ReasonDesc','Name','Value','Text','Label'],'');if(code||desc)out.push({code:String(code||desc),desc:String(desc||code)});Object.values(o).forEach(v=>{if(v&&typeof v==='object')walk(v);});}}walk(data);const seen=new Set();return out.filter(r=>{const k=r.code.trim();if(!k||seen.has(k))return false;seen.add(k);return true;});}
      async function loadReasons(){
        try{setStatus('Loading RF Plus adjustment reasons...','ld');const data=await rfApi('/api/inventoryAdjust/GetReason',reasonBodies()[0]);const fromRF=extractReasons(data);const seen=new Set();state.reasons=[...fallbackReasons,...fromRF].filter(r=>{if(seen.has(r.code))return false;seen.add(r.code);return true;});renderReasons();setStatus('RF Plus reasons loaded.','ok');}
        catch(e){state.reasons=fallbackReasons.slice();renderReasons();setStatus('Using saved adjustment reason list.','err');debug({reasonLoadError:e.message});}
      }
      function renderReasons(){const sel=by('reasonSelect');const current=sel?.value||'';sel.innerHTML='<option value="">Select reason...</option>'+state.reasons.map(r=>`<option value="${escapeHtml(r.code)}">${escapeHtml(r.code)}${r.desc?' · '+escapeHtml(r.desc):''}</option>`).join('');const wanted=current||(isIn()?'5556':'5583');if([...sel.options].some(o=>o.value===wanted))sel.value=wanted;}
      function renderDescriptions(){const sel=by('quickDescSelect');if(isIn()){sel.innerHTML='<option value="Manual / other...">Manual / other...</option>';sel.value='Manual / other...';by('commentInput').value=by('commentInput').value||'Manual / other...';by('manualRow').classList.remove('hidden');}else{sel.innerHTML='<option value="ISSUED TO KANBAN- JE" data-reason="5583">ISSUED TO KANBAN- JE → 5583 KANBAN</option><option value="ISSUED TO PAINT - JE" data-reason="5588.1">ISSUED TO PAINT - JE → 5588.1 PAINT BOOTH</option><option value="">Manual / other...</option>';sel.value='ISSUED TO KANBAN- JE';by('commentInput').value='ISSUED TO KANBAN- JE';by('manualRow').classList.add('hidden');}}
      function applyQuickDesc(){const sel=by('quickDescSelect');const opt=sel?.selectedOptions?.[0];if(isIn()){by('manualRow').classList.remove('hidden');if(!by('commentInput').value.trim())by('commentInput').value='Manual / other...';}else if(sel.value){by('commentInput').value=sel.value;by('manualRow').classList.add('hidden');const r=opt?.dataset?.reason;if(r)by('reasonSelect').value=r;}else{by('manualRow').classList.remove('hidden');}updatePreview();}

      function mapSqlLocation(x,partRow,partId,primary){
        const location=String(firstVal(x,['LocationId','LOCATION_ID','locationId'],'')).trim().toUpperCase();
        return {
          raw:x,
          part:String(firstVal(x,['PartId','PART_ID','partId'],partId)).trim().toUpperCase(),
          desc:String(firstVal(partRow,['Description','DESCRIPTION'],'')).trim(),
          location,
          qty:firstVal(x,['AvailableQty','AVAILABLE_QTY'],0),
          uom:String(firstVal(partRow,['UOM','StockUM','STOCK_UM'],'EA')).trim().toUpperCase(),
          trace:'',
          status:String(firstVal(x,['LocationStatus','STATUS'],'A')).trim().toUpperCase(),
          isPrimary:boolish(firstVal(x,['IsPrimary'],false))||sameLocation(location,primary)
        };
      }
      async function getInventoryAdjustSqlRead(part){
        const partId=String(part||'').trim().toUpperCase();
        let data;
        try{
          data=await bridgeGet('/api/inventory-adjust/part?partId='+encodeURIComponent(partId)+'&warehouseId='+encodeURIComponent(warehouse()));
        }catch(e){
          const err=new Error(`SQL inventory read failed for ${partId}: ${clean(e.message)}`);err.qxSql=true;throw err;
        }
        const partRows=Array.isArray(data.part)?data.part:(data.part?[data.part]:[]);
        const p=partRows[0]||null;
        if(!p){const err=new Error(`Part ${partId} was not found in SQL dbo.PART.`);err.qxSql=true;throw err;}
        const primary=String(data.primaryLocation||firstVal(p,['PrimaryLocID','PRIMARY_LOC_ID'],'')).trim().toUpperCase();
        const allRaw=Array.isArray(data.destinationLocations)?data.destinationLocations:(Array.isArray(data.locations)?data.locations:[]);
        const stockRaw=Array.isArray(data.stockLocations)?data.stockLocations:allRaw.filter(x=>numVal(firstVal(x,['AvailableQty','AVAILABLE_QTY'],0))>0);
        const destinationRows=uniqueRows(allRaw.map(x=>mapSqlLocation(x,p,partId,primary))).filter(r=>r.location&&r.location!=='HOLD');
        const stockRows=uniqueRows(stockRaw.map(x=>mapSqlLocation(x,p,partId,primary))).filter(r=>r.location&&r.location!=='HOLD'&&numVal(r.qty)>0);
        return {
          data,part:p,partId,description:String(firstVal(p,['Description','DESCRIPTION'],'')).trim(),uom:String(firstVal(p,['UOM','StockUM','STOCK_UM'],'EA')).trim().toUpperCase(),
          primary,primaryValid:boolish(data.primaryLocationValid),primaryExists:boolish(data.primaryLocationExists),primaryAvailable:firstVal(data,['primaryAvailableQty'],0),
          lookupIssue:String(data.primaryLookupIssue||''),source:String(data.primaryLocationSource||data.readSource||''),destinationRows,stockRows
        };
      }
      async function getAdjustOutStockLocations(part){
        const read=await getInventoryAdjustSqlRead(part);
        return {...read,rows:read.stockRows};
      }
      async function getAdjustInDestinationLocations(part){
        const read=await getInventoryAdjustSqlRead(part);
        return {...read,rows:read.destinationRows};
      }
      async function getPrimaryLocationFromSql(part){
        const read=await getInventoryAdjustSqlRead(part);
        return {primary:read.primary,valid:read.primaryValid,exists:read.primaryExists,available:read.primaryAvailable,source:read.source,read};
      }
      async function getAdjustInPrimaryBatch(parts){
        const unique=[...new Set((parts||[]).map(x=>String(x||'').trim().toUpperCase()).filter(Boolean))];
        if(!unique.length)return {data:{rows:[]},map:new Map()};
        const data=await bridgePost('/api/inventory-adjust/primary-locations',{partIds:unique,warehouseId:warehouse()});
        const map=new Map();
        (Array.isArray(data.rows)?data.rows:[]).forEach(x=>{
          const partId=String(firstVal(x,['PartId','PART_ID'],'')).trim().toUpperCase();
          if(!partId)return;
          map.set(partId,{partId,primary:String(firstVal(x,['PrimaryLocID','PRIMARY_LOC_ID'],'')).trim().toUpperCase(),valid:boolish(firstVal(x,['PrimaryLocationValid'],false)),exists:boolish(firstVal(x,['PrimaryLocationExists'],false)),available:firstVal(x,['PrimaryAvailableQty'],0),uom:String(firstVal(x,['UOM'],'EA')).trim().toUpperCase(),description:String(firstVal(x,['Description'],'')).trim(),raw:x});
        });
        return {data,map};
      }
      async function validatePart(part){const data=await rfApi('/api/inventoryAdjust/ValidatePart',{partId:part,isAdjustOut:!isIn()});const info=normalizePartInfo(data,part);if(!info.partId)throw new Error('RF Plus did not validate this Part ID.');return info;}

      async function findPart(){
        const part=by('partInput').value.trim().toUpperCase();if(!part){notify('Enter Part ID','error');return;}
        state.partValidated=false;state.partInfo=null;state.invalidDestination='';state.rows=[];state.selectedIndex=-1;by('locStatusBlock').classList.add('hidden');by('locStatusSelect').value='';
        try{
          setStatus((isIn()?'Validating Adjust In part ':'Loading Adjust Out stock for ')+part+'...','ld');
          const [info,read]=await Promise.all([validatePart(part),isIn()?getAdjustInDestinationLocations(part):getAdjustOutStockLocations(part)]);
          state.partInfo={...info,description:read.description||info.description,uom:read.uom||info.uom};state.partValidated=true;if(state.partInfo.uom)by('uomInput').value=state.partInfo.uom;
          state.rows=read.rows;state.selectedIndex=-1;
          if(isIn()){
            setPrimaryInfo(read.primary,read.primaryValid);
            renderLocationSuggestions(state.rows);
            const idx=read.primaryValid?state.rows.findIndex(r=>sameLocation(r.location,read.primary)):-1;
            if(idx>=0)selectRow(idx,{silent:true});else{by('locInput').value='';updatePrimaryVisual();}
            if(info.isTraceable&&['A','B'].includes(info.assignMethod)&&!by('traceInput').value)by('traceInput').value='<AUTO>';
            renderRows();updatePreview();
            if(idx>=0){setStatus(`Adjust In ready for ${part}. Default destination ${read.primary} selected; you may choose another RF Plus-valid location.`, 'ok');notify('✅ Default destination selected','success');setTimeout(()=>by('qtyInput').focus(),50);}
            else{const msg=read.lookupIssue||'No valid SQL primary destination was available. Enter another destination location; RF Plus will validate it.';setStatus(msg,'err');notify('Destination location required','error',7500);setTimeout(()=>by('locInput').focus(),50);}
            debug({mode:'Adjust In',validatePart:info,sqlRoute:'/api/inventory-adjust/part',sqlSource:read.source,primaryLocation:read.primary,primaryLocationValid:read.primaryValid,destinationSuggestions:state.rows,sqlRead:read.data});
          }else{
            setPrimaryInfo(read.primary,state.rows.some(r=>sameLocation(r.location,read.primary)));
            renderLocationSuggestions(state.rows);
            if(state.rows.length===1)selectRow(0,{silent:true});else{by('locInput').value='';updatePrimaryVisual();}
            renderRows();updatePreview();
            if(state.rows.length===1){setStatus(`Found 1 stocked location for ${part}; ${state.rows[0].location} selected automatically.`, 'ok');notify('✅ Stock location selected','success');setTimeout(()=>by('qtyInput').focus(),50);}
            else if(state.rows.length>1){setStatus(`Found ${state.rows.length} stocked locations for ${part}. Select the correct location.`, 'ok');notify('Choose a stock location','success');setTimeout(()=>by('locInput').focus(),50);}
            else{setStatus(`No available stock was found for ${part} in ${warehouse()}.`, 'err');notify('No available stock location','error');}
            debug({mode:'Adjust Out',sqlRoute:'/api/inventory-adjust/part',sqlSource:read.source,part:read.part,primaryLocation:read.primary,stockLocations:state.rows,sqlRead:read.data});
          }
        }catch(e){state.rows=[];state.selectedIndex=-1;state.partValidated=false;renderRows();renderLocationSuggestions([]);updatePreview();const prefix=e.qxSql?'SQL inventory lookup failed: ':'Part lookup failed: ';setStatus(prefix+clean(e.message),'err');notify(clean(e.message),'error',9000);debug({mode:isIn()?'Adjust In':'Adjust Out',sqlRoute:'/api/inventory-adjust/part',error:e.message,sqlError:!!e.qxSql});}
      }

      function filteredRows(){
        const lf=state.filterLoc.toUpperCase(),tf=state.filterTrace.toUpperCase();
        return state.rows.map((r,i)=>({r,i})).filter(x=>(!lf||x.r.location.toUpperCase().includes(lf))&&(!tf||String(x.r.trace).toUpperCase().includes(tf))).sort((a,b)=>{
          if((a.i===state.selectedIndex)!==(b.i===state.selectedIndex))return a.i===state.selectedIndex?-1:1;
          if(isIn()&&((a.r.isPrimary?1:0)!==(b.r.isPrimary?1:0)))return (b.r.isPrimary?1:0)-(a.r.isPrimary?1:0);
          return a.r.location.localeCompare(b.r.location);
        });
      }
      function renderLocationSuggestions(rows){
        const dl=by('locationSuggestions');
        dl.innerHTML=(rows||[]).filter(r=>r.location).map(r=>`<option value="${escapeHtml(r.location)}">${escapeHtml(r.location)}${isIn()?' · current ':' · stock '}${escapeHtml(numVal(r.qty))}</option>`).join('');
      }
      function renderRows(){
        const tb=by('resultTb'),rows=filteredRows();by('resultCount').textContent=state.rows.length?`${rows.length}/${state.rows.length} shown`:'';
        if(!state.rows.length){tb.innerHTML='<tr><td colspan="7" class="empty">Enter a part and press Enter.</td></tr>';return;}
        if(!rows.length){tb.innerHTML='<tr><td colspan="7" class="empty">No rows match filter.</td></tr>';return;}
        tb.innerHTML=rows.map(({r,i})=>{const sel=i===state.selectedIndex;const pri=isPrimaryLocation(r.location,r);const usable=isIn()?!!r.location:(!!r.location&&numVal(r.qty)>0);const status=sel?'SELECTED':usable?(isIn()?'VALID LOCATION':'AVAILABLE'):'NO STOCK';return `<tr class="${sel?'selected':''}" data-index="${i}" tabindex="0"><td class="mono"><b style="color:var(--primary)">${escapeHtml(r.part)}</b></td><td title="${escapeHtml(r.desc)}">${escapeHtml(r.desc)}</td><td class="mono ${pri?'primary-location-text':''}"><b>${escapeHtml(r.location||'—')}</b></td><td class="adj-center" style="font-weight:800;color:${numVal(r.qty)>0?'var(--success)':'var(--muted)'}">${escapeHtml(r.qty??0)}</td><td>${escapeHtml(r.uom||'EA')}</td><td class="mono">${escapeHtml(r.trace||'—')}</td><td><span class="rowBadge ${sel?'sel':''}">${escapeHtml(status)}</span></td></tr>`;}).join('');
        tb.querySelectorAll('[data-index]').forEach(tr=>{tr.addEventListener('click',()=>selectRow(Number(tr.dataset.index)));tr.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();selectRow(Number(tr.dataset.index));by('qtyInput').focus();}});});
      }
      function selectRow(i,opts={}){const r=state.rows[i];if(!r)return;state.selectedIndex=i;by('locInput').value=r.location||'';if(!isIn()&&r.trace)by('traceInput').value=r.trace;if(r.uom)by('uomInput').value=r.uom;renderRows();updatePreview();updatePrimaryVisual();if(!opts.silent)notify('Selected location '+r.location,'success');}

      function getPayload(){const desc=(isIn()?by('commentInput').value.trim():(by('quickDescSelect').value||by('commentInput').value.trim())).trim();return {partId:by('partInput').value.trim().toUpperCase(),traceId:by('traceInput').value.trim(),qty:by('qtyInput').value.trim(),warehouseId:warehouse(),locationId:by('locInput').value.trim().toUpperCase(),transactionDescription:desc,reason:by('reasonSelect').value};}
      function selectedRow(){return state.selectedIndex>=0?state.rows[state.selectedIndex]:null;}
      function validatePayload(){const p=getPayload(),missing=[];if(!p.partId)missing.push('Part');if(!state.partValidated)missing.push('Validate Part');if(numVal(p.qty)<=0)missing.push('Positive Qty');if(!p.locationId)missing.push('Location');if(p.locationId==='HOLD')missing.push('HOLD location is prohibited');if(isIn()&&state.invalidDestination&&sameLocation(p.locationId,state.invalidDestination))missing.push('Choose another valid location');if(!p.transactionDescription)missing.push('Transaction Description');if(!p.reason)missing.push('Reason');let row=selectedRow();if(!isIn()){row=state.rows.find(r=>sameLocation(r.location,p.locationId))||null;if(!row||numVal(row.qty)<=0)missing.push('Select an actual stocked location');else if(numVal(p.qty)>numVal(row.qty))missing.push('Qty is more than stock');}if(isIn()&&state.partInfo?.isTraceable&&!['A','B'].includes(state.partInfo.assignMethod)&&!p.traceId)missing.push('Trace / Lot / Serial');return {ok:!missing.length,missing,payload:p,row};}
      function updatePreview(){const v=validatePayload(),row=v.row;by('selStockText').textContent=row?`${row.qty??0} ${row.uom||by('uomInput').value||'EA'}`:'—';const btn=by('submitBtn');btn.disabled=!v.ok||state.submitting;btn.title=v.ok?(isIn()?'Submit Adjust In':'Submit Adjust Out'):'Missing: '+v.missing.join(', ');updatePrimaryVisual();}

      async function validateInDestination(p){try{const need=await rfApi('/api/inventoryTransfer/NeedSetPartLocationStatus',{partId:p.partId,locationId:p.locationId,warehouseId:p.warehouseId});let locStatus='';if(responseBool(need)){by('locStatusBlock').classList.remove('hidden');locStatus=by('locStatusSelect').value;if(!locStatus){const err=new Error('This is a new part/location combination. Select Available, Unavailable, or Hold status, then submit again.');err.qxNeedsStatus=true;throw err;}}const result=await rfApi('/api/InventoryAdjust/ValidateLocationAndCreatePartLocation',{partId:p.partId,toLocationId:p.locationId,toWarehouseId:p.warehouseId,locStatus});const returned=String(firstVal(firstObject(result),['LocationId','locationId'],p.locationId)).trim().toUpperCase();return returned||p.locationId;}catch(e){if(!e.qxNeedsStatus)e.qxDestination=true;throw e;}}
      function profileFields(profile){const arr=firstVal(profile,['TraceProfiles','traceProfiles','Profiles','profiles','Fields','fields'],[]);return Array.isArray(arr)?arr:[];}
      async function generateInTrace(partId,requested){const profile=await rfApi('/api/POReceiving/getTraceProfile',{PartId:partId,IsUseRFPlusTrace:false,isUseMixedTrace:false});const apply=boolish(firstVal(profile,['Apply_To_Rec','ApplyToRec','applyToRec'],false));const fields=profileFields(profile);if(!apply)return requested||'<AUTO>';if(fields.length)throw new Error('This part requires trace-profile details. Use RF Plus for this Adjust In until those profile fields are added to QX.');const result=await rfApi('/api/POReceiving/updateTraceProfile',{ID:requested||'<AUTO>',partId,IsUseRFPlusTrace:false,isUseMixedTrace:false});const obj=firstObject(result);return String(firstVal(obj,['ID','Id','id'],typeof result==='string'?result:(requested||'<AUTO>'))).trim();}
      async function resolveInTrace(p,info){if(!info?.isTraceable)return p.traceId||'';let trace=(p.traceId||'').trim();if(!trace&&['A','B'].includes(info.assignMethod))trace='<AUTO>';if(!trace)throw new Error('Trace / lot / serial is required for this part.');if(trace!=='<AUTO>'){const vr=await rfApi('/api/POReceiving/validateTrace',{traceId:trace,PartId:p.partId,isAdjustOut:false,isUseRFPlusTrace:false,isValidateRFPlusTraceQTY:false,isUseMixedTrace:false});if(boolish(firstVal(firstObject(vr),['TraceExist','traceExist'],false)))return String(firstVal(firstObject(vr),['TraceId','traceId'],trace));return generateInTrace(p.partId,trace);}return generateInTrace(p.partId,trace);}
      async function validateMaxLot(p,info){if(!info?.isTraceable)return;const result=await rfApi('/api/POReceiving/getMaxLotQty',{PartId:p.partId,isUseRFPlusTrace:false,isUseMixedTrace:false});const max=numVal(typeof result==='object'?firstVal(result,['MaxLotQty','Max_Lot_Qty','maxLotQty','Value'],result):result);if(max>0&&numVal(p.qty)>max)throw new Error(`Quantity cannot exceed the RF Plus max lot quantity of ${max}.`);}
      function fingerprint(p,mode){return [mode,p.partId,p.traceId,p.qty,p.warehouseId,p.locationId,p.transactionDescription,p.reason].join('|').toUpperCase();}
      function ensureNotDuplicate(fp){const now=Date.now(),last=state.lastSubmits.get(fp)||0;if(now-last<15000)throw new Error('This identical adjustment was already submitted or is still processing. Wait 15 seconds before retrying.');state.lastSubmits.set(fp,now);}
      async function submitSingle(){
        if(state.submitting)return;const v=validatePayload();if(!v.ok){notify('Missing: '+v.missing.join(', '),'error',7000);return;}let p={...v.payload};const mode=isIn()?'IN':'OUT';const msg=`ADJUST ${mode}?\n\nPart: ${p.partId}\nQty: ${p.qty}\nLocation: ${p.locationId}\nReason: ${p.reason}\nDescription: ${p.transactionDescription}\n\nThis will change inventory through RF Plus.`;if(!confirm(msg))return;
        const btn=by('submitBtn');state.submitting=true;btn.disabled=true;btn.textContent='Submitting...';let fp='';
        try{
          if(isIn()){p.locationId=await validateInDestination(p);p.traceId=await resolveInTrace(p,state.partInfo);await validateMaxLot(p,state.partInfo);}fp=fingerprint(p,state.mode);ensureNotDuplicate(fp);setStatus(`Submitting Adjust ${mode} for ${p.partId}...`,'ld');const endpoint=isIn()?'/api/inventoryAdjust/InventoryAdjustIn':'/api/inventoryAdjust/InventoryAdjustOut';const res=await rfApi(endpoint,p);debug({endpoint,payload:p,response:res});setStatus(`Adjust ${mode} completed for ${p.partId} · Qty ${p.qty} · ${p.locationId}`,'ok');notify(`✅ Adjust ${mode} completed`,'success',8000);
          if(isIn()){by('qtyInput').value='';by('traceInput').value=state.partInfo?.isTraceable&&['A','B'].includes(state.partInfo.assignMethod)?'<AUTO>':'';await refreshInPartAfterSuccess(p.partId,p.locationId);}else{by('qtyInput').value='';by('traceInput').value='';await refreshOutPartAfterSuccess(p.partId,p.locationId);}
        }catch(e){if(fp&&!String(e.message).includes('already submitted'))state.lastSubmits.delete(fp);if(isIn()&&e.qxDestination){state.invalidDestination=p.locationId;setStatus(`Adjust IN needs another location: ${clean(e.message)}`,'err');notify(`Needs Location: ${clean(e.message)}`,'error',9000);}else{setStatus(`Adjust ${mode} failed: ${clean(e.message)}`,'err');notify(`Adjust ${mode} failed: ${clean(e.message)}`,'error',9000);}debug({mode,endpoint:isIn()?'/api/inventoryAdjust/InventoryAdjustIn':'/api/inventoryAdjust/InventoryAdjustOut',payload:p,error:e.message,destinationRejected:!!e.qxDestination});}
        finally{state.submitting=false;btn.textContent=isIn()?'＋ ADJUST IN':'⚠ ADJUST OUT';updatePreview();}
      }
      async function refreshInPartAfterSuccess(part,location){try{const read=await getAdjustInDestinationLocations(part);state.rows=read.rows;setPrimaryInfo(read.primary,read.primaryValid);renderLocationSuggestions(read.rows);let idx=read.rows.findIndex(r=>sameLocation(r.location,location));if(idx<0&&read.primaryValid)idx=read.rows.findIndex(r=>sameLocation(r.location,read.primary));state.selectedIndex=-1;if(idx>=0)selectRow(idx,{silent:true});else{by('locInput').value=location||'';renderRows();updatePreview();}}catch(e){debug({refreshWarning:e.message,mode:'Adjust In'});}}
      async function refreshOutPartAfterSuccess(part,location){try{const read=await getAdjustOutStockLocations(part);state.rows=read.rows;setPrimaryInfo(read.primary,state.rows.some(r=>sameLocation(r.location,read.primary)));renderLocationSuggestions(state.rows);let idx=state.rows.findIndex(r=>sameLocation(r.location,location));if(idx<0&&state.rows.length===1)idx=0;state.selectedIndex=-1;if(idx>=0)selectRow(idx,{silent:true});else{by('locInput').value='';renderRows();updatePreview();}}catch(e){debug({refreshWarning:e.message,mode:'Adjust Out',sqlRoute:'/api/inventory-adjust/part'});}}

      function parseMass(){const text=by('massPaste').value||'',rows=[];text.split(/\r?\n/).forEach((line,idx)=>{const raw=line.trim();if(!raw)return;const cols=raw.includes('\t')?raw.split('\t'):raw.includes(',')?raw.split(','):raw.split(/\s{2,}/);const part=String(cols[0]||'').trim().toUpperCase(),qty=String(cols[1]||'').trim(),location=String(cols[2]||'').trim().toUpperCase(),trace=String(cols[3]||'').trim();if(!part||/^part\s*(id|code)?$/i.test(part))return;const base={line:idx+1,part,qty,location,trace,locations:[],selectedLocation:location,selectedStock:'',uom:'EA',partInfo:null,primaryLocation:'',autoPrimary:false,providedLocation:!!location};if(!qty||numVal(qty)<=0)rows.push({...base,status:'INVALID QUANTITY',message:'Quantity must be greater than zero'});else rows.push({...base,status:'PENDING',message:''});});return rows;}
      function massClass(st){if(st==='READY')return'ready';if(st==='NEEDS LOCATION'||st==='NEEDS TRACE'||st==='NEEDS STATUS')return'need';if(st==='PROCESSING')return'processing';if(st==='COMPLETED')return'completed';if(st==='FAILED')return'failed';if(st.startsWith('INVALID'))return'invalid';return'';}
      function massHash(){const p=getPayload();return [state.mode,by('massPaste').value,p.transactionDescription,p.reason].join('|');}
      function renderMass(){
        const tb=by('massTb');
        if(!state.massItems.length){tb.innerHTML='<tr><td colspan="7" class="empty">Paste Excel rows above.</td></tr>';return;}
        tb.innerHTML=state.massItems.map((it,i)=>{
          const selectedLoc=it.selectedLocation||it.location||'';
          const selectedPrimary=isMassPrimary(it,selectedLoc);
          let loc='';
          if(isIn()){
            loc=`<input class="massLocInput ${selectedPrimary?'primary-location-text':''}" data-index="${i}" value="${escapeHtml(selectedLoc)}" placeholder="required location">${it.needsLocationStatus?`<select class="massLocStatusSelect" data-index="${i}"><option value="">Location status...</option><option value="A" ${it.locStatus==='A'?'selected':''}>A · Available</option><option value="U" ${it.locStatus==='U'?'selected':''}>U · Unavailable</option><option value="H" ${it.locStatus==='H'?'selected':''}>H · Hold</option></select>`:''}`;
          }else if(it.locations?.length>1&&it.status!=='COMPLETED'){
            loc=`<select class="massLocSelect ${selectedPrimary?'primary-location-text':''}" data-index="${i}"><option value="">Choose location...</option>${it.locations.map(r=>{const v=[r.location,r.trace||'',r.qty||'',r.uom||'EA'].join('||');return `<option value="${escapeHtml(v)}" ${(sameLocation(it.selectedLocation,r.location)&&String(it.trace||'')===String(r.trace||''))?'selected':''}>${escapeHtml(`${r.location} · stock ${r.qty||0}${r.trace?' · trace '+r.trace:''}`)}</option>`;}).join('')}</select>`;
          }else{
            loc=`<span class="mono ${selectedPrimary?'primary-location-text':''}">${escapeHtml(selectedLoc||'—')}</span>`;
          }
          const trace=isIn()?`<input class="massTraceInput" data-index="${i}" value="${escapeHtml(it.trace||'')}" placeholder="if required">`:`<span class="mono">${escapeHtml(it.trace||'—')}</span>`;
          const msg=it.message?`<div class="${it.status==='FAILED'||it.status.startsWith('INVALID')?'rowError':it.status.startsWith('NEEDS')?'rowWarn':'rowOk'}">${escapeHtml(it.message)}</div>`:'';
          return `<tr><td>${i+1}</td><td class="mono"><b style="color:var(--primary)">${escapeHtml(it.part)}</b></td><td class="adj-center"><b>${escapeHtml(it.qty)}</b></td><td>${loc}</td><td>${trace}</td><td class="adj-center"><b>${escapeHtml(it.selectedStock===''?'—':it.selectedStock)}</b></td><td><span class="massStatus ${massClass(it.status)}">${escapeHtml(it.status)}</span>${msg}</td></tr>`;
        }).join('');
        tb.querySelectorAll('.massLocSelect').forEach(el=>el.addEventListener('change',massOutLocationChanged));
        tb.querySelectorAll('.massLocInput').forEach(el=>el.addEventListener('change',massInLocationChanged));
        tb.querySelectorAll('.massTraceInput').forEach(el=>el.addEventListener('input',massTraceChanged));
        tb.querySelectorAll('.massLocStatusSelect').forEach(el=>el.addEventListener('change',massStatusChanged));
      }
      function massOutLocationChanged(e){const it=state.massItems[Number(e.target.dataset.index)];if(!it)return;if(!e.target.value){it.selectedLocation='';it.status='NEEDS LOCATION';it.message='Choose location';renderMass();return;}const [loc,trace,stock,uom]=e.target.value.split('||');it.selectedLocation=loc;it.trace=trace;it.selectedStock=stock;it.uom=uom;if(numVal(it.qty)>numVal(stock)){it.status='FAILED';it.message='Qty is more than selected stock';}else{it.status='READY';it.message='Ready';}renderMass();}
      async function massInLocationChanged(e){const it=state.massItems[Number(e.target.dataset.index)];if(!it)return;it.selectedLocation=e.target.value.trim().toUpperCase();it.autoPrimary=false;it.needsLocationStatus=false;it.locStatus='';if(!it.selectedLocation){it.status='NEEDS LOCATION';it.message='Enter a destination location';renderMass();return;}it.status='PROCESSING';it.message='Checking destination...';renderMass();try{const need=await rfApi('/api/inventoryTransfer/NeedSetPartLocationStatus',{partId:it.part,locationId:it.selectedLocation,warehouseId:warehouse()});it.needsLocationStatus=responseBool(need);if(it.needsLocationStatus){it.status='NEEDS STATUS';it.message='Select Available, Unavailable, or Hold';}else if(it.partInfo?.isTraceable&&!['A','B'].includes(it.partInfo.assignMethod)&&!it.trace){it.status='NEEDS TRACE';it.message='Enter trace / lot / serial';}else{it.status='READY';it.message='Ready';}}catch(err){it.status='NEEDS LOCATION';it.message='Location rejected: '+clean(err.message).slice(0,115);}renderMass();}
      function massTraceChanged(e){const it=state.massItems[Number(e.target.dataset.index)];if(!it)return;it.trace=e.target.value.trim();if(it.status==='NEEDS TRACE'&&it.trace){it.status=it.needsLocationStatus&&!it.locStatus?'NEEDS STATUS':'READY';it.message=it.status==='READY'?'Ready':'Select destination location status';}renderMass();}
      function massStatusChanged(e){const it=state.massItems[Number(e.target.dataset.index)];if(!it)return;it.locStatus=e.target.value;if(it.locStatus){if(it.partInfo?.isTraceable&&!['A','B'].includes(it.partInfo.assignMethod)&&!it.trace){it.status='NEEDS TRACE';it.message='Enter trace / lot / serial';}else{it.status='READY';it.message='Ready';}}else{it.status='NEEDS STATUS';it.message='Select destination location status';}renderMass();}
      function setMassProgress(msg,pct){const box=by('massProgress');if(!msg){box.classList.add('hidden');return;}box.classList.remove('hidden');by('massProgressLabel').textContent=msg;by('massProgressBar').style.width=Math.max(0,Math.min(100,pct||0))+'%';}
      async function prepareMass(){
        const items=parseMass(),base=getPayload();
        if(!base.transactionDescription||!base.reason){notify('Select transaction description and reason first','error');return false;}
        if(!items.length){notify('Paste Part ID + Qty rows first','error');return false;}
        state.massItems=items;state.massHash=massHash();renderMass();

        let primaryBatch={data:{rows:[]},map:new Map()},primaryBatchError='';
        if(isIn()){
          try{
            primaryBatch=await getAdjustInPrimaryBatch(items.filter(x=>!x.status.startsWith('INVALID')).map(x=>x.part));
            debug({massPrimaryLookup:{source:primaryBatch.data.primaryLocationSource||primaryBatch.data.readSource||'',requested:[...new Set(items.map(x=>x.part))],returned:[...primaryBatch.map.keys()]}});
          }catch(e){primaryBatchError=clean(e.message);debug({massPrimaryLookupError:primaryBatchError,requested:[...new Set(items.map(x=>x.part))]});}
        }

        for(let i=0;i<items.length;i++){
          const it=items[i];if(it.status.startsWith('INVALID'))continue;
          it.status='PROCESSING';it.message='Validating part...';renderMass();setMassProgress(`Checking ${i+1}/${items.length}: ${it.part}`,i/items.length*100);
          try{
            const primaryInfo=primaryBatch.map.get(it.part)||null;
            if(isIn()){
              it.partInfo=await validatePartForMode(it.part,true);
              it.locations=[];it.uom=it.partInfo.uom||primaryInfo?.uom||'EA';it.primaryLocation=primaryInfo?.primary||'';
              if(!it.selectedLocation){
                if(primaryInfo?.primary&&primaryInfo.valid){it.selectedLocation=primaryInfo.primary;it.selectedStock=String(primaryInfo.available??0);it.autoPrimary=true;}
              }else{it.autoPrimary=false;}
              if(it.partInfo.isTraceable&&['A','B'].includes(it.partInfo.assignMethod)&&!it.trace)it.trace='<AUTO>';
              if(!it.selectedLocation){
                it.status='NEEDS LOCATION';
                if(primaryInfo?.primary&&!primaryInfo.valid)it.message=`SQL primary ${primaryInfo.primary} is inactive or unavailable. Select a destination location.`;
                else if(primaryBatchError)it.message='Primary location SQL lookup failed. Select a location; technical details are in Advanced / Debug.';
                else it.message='Primary location could not be retrieved from SQL for this Part ID. Select a location or review the part master record.';
              }
              else if(it.partInfo.isTraceable&&!['A','B'].includes(it.partInfo.assignMethod)&&!it.trace){it.status='NEEDS TRACE';it.message='Enter trace / lot / serial';}
              else{
                const needStatus=await rfApi('/api/inventoryTransfer/NeedSetPartLocationStatus',{partId:it.part,locationId:it.selectedLocation,warehouseId:warehouse()});
                it.needsLocationStatus=responseBool(needStatus);
                if(it.needsLocationStatus&&!it.locStatus){it.status='NEEDS STATUS';it.message='Select Available, Unavailable, or Hold';}
                else{it.status='READY';it.message=it.autoPrimary?'Ready · default destination selected':'Ready';}
              }
            }else{
              const read=await getAdjustOutStockLocations(it.part);
              const usable=read.rows;it.locations=usable;it.primaryLocation=read.primary||'';it.uom=read.uom||'EA';
              if(!usable.length){it.status='INVALID PART';it.message='No stock location found';}
              else if(usable.length===1){const r=usable[0];it.selectedLocation=r.location;it.selectedStock=String(r.qty||0);it.trace=r.trace||'';it.uom=r.uom||'EA';if(numVal(it.qty)>numVal(r.qty)){it.status='FAILED';it.message='Qty is more than stock';}else{it.status='READY';it.message='Auto selected';}}
              else{it.status='NEEDS LOCATION';it.message='Choose a stock location';}
            }
          }catch(e){it.status='INVALID PART';it.message=clean(e.message).slice(0,140);}
          renderMass();
        }
        setMassProgress('Validation complete',100);setTimeout(()=>setMassProgress('',0),1200);
        return !items.some(x=>['NEEDS LOCATION','NEEDS TRACE','NEEDS STATUS','INVALID PART','INVALID QUANTITY','FAILED'].includes(x.status));
      }
      async function validatePartForMode(part,inMode){const data=await rfApi('/api/inventoryAdjust/ValidatePart',{partId:part,isAdjustOut:!inMode});const info=normalizePartInfo(data,part);if(!info.partId)throw new Error('Invalid Part ID');return info;}
      async function processMass(){
        if(state.massProcessing)return;
        const ready=state.massItems.filter(x=>x.status==='READY');if(!ready.length){notify('No ready rows to process','error');return;}
        const base=getPayload(),label=isIn()?'IN':'OUT',total=ready.reduce((a,x)=>a+numVal(x.qty),0);
        if(!confirm(`MASS ADJUST ${label}?

Rows: ${ready.length}
Total Qty: ${total}
Reason: ${base.reason}
Description: ${base.transactionDescription}

This changes inventory through RF Plus.`))return;
        state.massProcessing=true;let ok=0,fail=0;
        for(const it of state.massItems){
          if(it.status!=='READY')continue;it.status='PROCESSING';it.message='Submitting...';renderMass();setMassProgress(`Submitting ${ok+fail+1}/${ready.length}: ${it.part}`,(ok+fail)/ready.length*100);
          let p={partId:it.part,traceId:it.trace||'',qty:String(it.qty),warehouseId:warehouse(),locationId:it.selectedLocation,transactionDescription:base.transactionDescription,reason:base.reason};let fp='';
          try{
            if(isIn()){p.locationId=await validateMassInDestination(p,it);p.traceId=await resolveInTrace(p,it.partInfo);await validateMaxLot(p,it.partInfo);}
            fp=fingerprint(p,state.mode);ensureNotDuplicate(fp);await rfApi(isIn()?'/api/inventoryAdjust/InventoryAdjustIn':'/api/inventoryAdjust/InventoryAdjustOut',p);
            it.status='COMPLETED';it.message=isIn()?'Adjusted in':'Adjusted out';ok++;if(isIn())await getAdjustInDestinationLocations(it.part);
          }catch(e){
            if(fp&&!String(e.message).includes('already submitted'))state.lastSubmits.delete(fp);
            if(isIn()&&e.qxDestination){it.status='NEEDS LOCATION';it.autoPrimary=false;it.message='Location rejected: '+clean(e.message).slice(0,125);}
            else{it.status='FAILED';it.message=clean(e.message).slice(0,170);}
            fail++;
          }
          renderMass();
        }
        state.massProcessing=false;setMassProgress(`Mass Adjust complete: ${ok} completed, ${fail} failed`,100);setStatus(`Mass Adjust ${label} complete: ${ok} completed, ${fail} failed.`,fail?'err':'ok');notify(`Mass Adjust ${label}: ${ok} completed, ${fail} failed`,fail?'error':'success',9000);
      }
      async function validateMassInDestination(p,it){try{const need=await rfApi('/api/inventoryTransfer/NeedSetPartLocationStatus',{partId:p.partId,locationId:p.locationId,warehouseId:p.warehouseId});if(responseBool(need)&&!it.locStatus){const err=new Error('Destination location status is required.');err.qxNeedsStatus=true;throw err;}const result=await rfApi('/api/InventoryAdjust/ValidateLocationAndCreatePartLocation',{partId:p.partId,toLocationId:p.locationId,toWarehouseId:p.warehouseId,locStatus:it.locStatus||''});return String(firstVal(firstObject(result),['LocationId','locationId'],p.locationId)).trim().toUpperCase()||p.locationId;}catch(e){if(!e.qxNeedsStatus)e.qxDestination=true;throw e;}}
      async function massClick(){const h=massHash();if(!state.massItems.length||state.massHash!==h||state.massItems.some(x=>x.status==='PENDING'))await prepareMass();const blocking=state.massItems.filter(x=>['NEEDS LOCATION','NEEDS TRACE','NEEDS STATUS','INVALID PART','INVALID QUANTITY','FAILED'].includes(x.status));if(blocking.length){setStatus(`Mass Adjust has ${blocking.length} row(s) that need attention.`, 'err');notify('Fix rows that need attention before processing','error',7000);return;}await processMass();}
      function clearMass(){by('massPaste').value='';state.massItems=[];state.massHash='';renderMass();setMassProgress('',0);}

      function setMode(mode,opts={}){if(!['out','in'].includes(mode))return;state.mode=mode;state.rows=[];state.selectedIndex=-1;state.partInfo=null;state.partValidated=false;state.primaryLocation='';state.primaryLocationValid=false;state.invalidDestination='';state.massItems=[];state.massHash='';by('modeOutBtn').classList.toggle('active',mode==='out');by('modeInBtn').classList.toggle('active',mode==='in');by('modeOutBtn').setAttribute('aria-selected',mode==='out');by('modeInBtn').setAttribute('aria-selected',mode==='in');by('singleTitle').textContent=mode==='in'?'Fast Adjust In':'Fast Adjust Out';by('modeHelp').textContent=mode==='in'?'Add inventory to a destination location. RF Plus validates or creates the part/location record.':'Remove inventory from a location that currently has stock.';by('locationLabel').textContent=mode==='in'?'Destination Location':'Selected Stock Location';by('stockLabel').textContent=mode==='in'?'Current Available':'Available Stock';by('locationsTitle').textContent=mode==='in'?'Valid / Existing Location Suggestions':'Stock Locations';by('submitBtn').textContent=mode==='in'?'＋ ADJUST IN':'⚠ ADJUST OUT';by('submitBtn').className='btn '+(mode==='in'?'btn-success':'btn-danger');by('findBtn').textContent=mode==='in'?'🔎 VALIDATE PART / LOCATIONS':'🔎 FIND / AUTO SELECT';by('massTitle').textContent=mode==='in'?'Mass Adjust In':'Mass Adjust Out';by('massSubtitle').textContent=mode==='in'?'paste Part ID + Qty + optional Location + optional Trace':'paste Part ID + Qty from Excel';by('massProcessBtn').textContent=mode==='in'?'⚡ MASS ADJUST IN':'⚡ MASS ADJUST OUT';by('massStockHead').textContent=mode==='in'?'Current Qty':'Stock';by('massPaste').placeholder=mode==='in'?'Column 1 = Part ID\nColumn 2 = Qty\nColumn 3 = Location (optional)\nColumn 4 = Trace (optional)\n\nExample:\n05100091\t10\tP1A1':'Column 1 = Part ID\nColumn 2 = Qty\n\nExample:\n05100091\t100\n07502239\t1';by('massHint').innerHTML=mode==='in'?'<b>Mass Adjust In</b><br>The SQL primary location is the default when Location is blank. An Excel location overrides it. Every destination is validated by RF Plus before submission.':'<b>Mass Adjust Out</b><br>One stock location auto-selects. Multiple locations pause for you to choose.';by('keyHelp').innerHTML=mode==='in'?'Keyboard: <b>Enter</b> on Part = validate part · <b>Enter</b> on Qty = move to Adjust In · <b>Ctrl+Enter</b> = submit with confirmation.':'Keyboard: <b>Enter</b> on Part = find stock · <b>Enter</b> on Qty = move to Adjust Out · <b>Ctrl+Enter</b> = submit with confirmation.';by('locInput').readOnly=false;by('locStatusBlock').classList.add('hidden');by('locStatusSelect').value='';renderDescriptions();renderReasons();clearFieldsForMode();renderRows();renderLocationSuggestions([]);renderMass();setStatus('', '');if(!opts.silent)setTimeout(()=>by('partInput').focus(),50);}
      function clearFieldsForMode(){['partInput','locInput','traceInput','qtyInput','locFilter','traceFilter'].forEach(id=>by(id).value='');by('uomInput').value='EA';state.filterLoc='';state.filterTrace='';state.invalidDestination='';setPrimaryInfo('',false);if(isIn()){by('commentInput').value='Manual / other...';by('reasonSelect').value='5556';}else{by('commentInput').value='ISSUED TO KANBAN- JE';by('reasonSelect').value='5583';}updatePreview();}
      function clearAll(){state.rows=[];state.selectedIndex=-1;state.partInfo=null;state.partValidated=false;state.invalidDestination='';clearFieldsForMode();renderRows();renderLocationSuggestions([]);debug('');setStatus('','');setTimeout(()=>by('partInput').focus(),50);}

      function bind(){
        by('modeOutBtn').addEventListener('click',()=>setMode('out'));by('modeInBtn').addEventListener('click',()=>setMode('in'));
        by('loadReasonsBtn').addEventListener('click',loadReasons);by('findBtn').addEventListener('click',findPart);by('submitBtn').addEventListener('click',submitSingle);by('clearBtn').addEventListener('click',clearAll);
        by('massProcessBtn').addEventListener('click',massClick);by('massPrepareBtn').addEventListener('click',prepareMass);by('massClearBtn').addEventListener('click',clearMass);by('massPaste').addEventListener('input',()=>{state.massItems=[];state.massHash='';renderMass();});
        by('quickDescSelect').addEventListener('change',applyQuickDesc);['reasonSelect','partInput','qtyInput','uomInput','commentInput','locInput','traceInput','locStatusSelect'].forEach(id=>by(id).addEventListener('input',updatePreview));by('locInput').addEventListener('input',()=>{if(state.invalidDestination&&!sameLocation(by('locInput').value,state.invalidDestination))state.invalidDestination='';updatePrimaryVisual();});by('locInput').addEventListener('change',()=>{const loc=by('locInput').value.trim().toUpperCase();state.selectedIndex=state.rows.findIndex(r=>sameLocation(r.location,loc));renderRows();updatePreview();});
        by('partInput').addEventListener('input',()=>{state.partValidated=false;state.partInfo=null;state.invalidDestination='';setPrimaryInfo('',false);updatePreview();autoFind();});by('partInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();findPart();}});by('qtyInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();by('submitBtn').focus();}});by('locFilter').addEventListener('input',e=>{state.filterLoc=e.target.value;renderRows();});by('traceFilter').addEventListener('input',e=>{state.filterTrace=e.target.value;renderRows();});
        root.addEventListener('keydown',e=>{if(!document.body.classList.contains('adjust-mode'))return;if(e.ctrlKey&&e.key==='Enter'){e.preventDefault();submitSingle();}});
      }
      const autoFind=debounce(()=>{const part=by('partInput').value.trim();if(part.length>=5)findPart();},850);

      state.reasons=fallbackReasons.slice();bind();setMode('out',{silent:true});
      this.activate=()=>{this._activated=true;setTimeout(()=>by('partInput').focus(),60);if(!state.reasonsLoaded){state.reasonsLoaded=true;setTimeout(()=>loadReasons().catch(()=>{}),100);}};
      this.onSessionChanged=()=>{const svc=services();const signed=!!(svc.isSignedIn&&svc.isSignedIn());const next=signed&&svc.getUser?String(svc.getUser()||'').trim().toUpperCase():'';if(!signed||(state.sessionUser&&next!==state.sessionUser)){clearAll();clearMass();state.lastSubmits.clear();}state.sessionUser=next;state.reasonsLoaded=false;if(this._activated&&signed)this.activate();};
      this.getState=()=>state;
    }
  }
  if(!customElements.get('qx-inventory-adjust'))customElements.define('qx-inventory-adjust',QXInventoryAdjustElement);
})();
