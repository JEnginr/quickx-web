
// ============================================================
//  QuickX QX 1.9 Final — Native Adjust Out + Shared Active Demand UI/Printers
//  Fixes:
//  1) Broken generated onclick strings that stopped JavaScript.
//  2) No longer depends on RF Plus being open in another tab.
//  3) Adds RF Plus login + warehouse/language proceed flow.
// ============================================================
// ============================================================
//  QX Web 1.9 connection mode
//  The browser talks only to the same QX Web origin. The host server proxies RF
//  Plus under /rf and serves read-only SQL endpoints under /api. This web branch
//  intentionally contains no Chrome-extension connection mode.
// ============================================================
const QX_LOC = (typeof window !== 'undefined' && window.location) ? window.location : { origin: '' };
const API = QX_LOC.origin + '/rf';
const RF9000 = QX_LOC.origin + '/rf9000';
const SQL_BRIDGE = QX_LOC.origin;
const COMPANY = 'LIVE';
const DEFAULT_USER = 'JAY_E';
const DEFAULT_WAREHOUSE = 'QMIL';
const DEFAULT_LANGUAGE = 'en';
const DEFAULT_DEMAND_SCAN_LIMIT = 250;
const DEMAND_SCAN_CONCURRENCY = 8;
const DEMAND_SUB_CONCURRENCY = 4;
const DEMAND_REQ_CACHE_TTL_MS = 10 * 60 * 1000;
let demandActiveWOCache = null;
const demandReqCache = new Map();
const demandPartResultCache = new Map();
const DEFAULT_LABEL_PRINTER = 'LABELPRINTER';
const LABEL_PRINTERS = ['LABELPRINTER', 'ZEBRASMALL'];
const DEFAULT_LABEL_COPIES = 1;
const QX_VERSION = '1.10 Beta v0.6';

// Issue Label Printing endpoint locked from real RF Plus Network capture.
const PRINT_ENDPOINT_CANDIDATES = [
  // Most likely screen names first — RF Plus builds sometimes vary by route/component name.
  '/api/issueLabelPrinting/processIssueLabelPrinting',
  '/api/issueLabelPrinting/processPrintIssueLabel',
  '/api/issueLabelPrinting/processIssueLabelPrint',
  '/api/issueLabelPrinting/processPrint',
  '/api/issueLabelPrinting/printIssueLabel',
  '/api/issueLabelPrinting/printLabel',
  '/api/issueLabelPrinting/print',
  '/api/reprintIssueLabel/processReprintIssueLabel',
  '/api/reprintIssueLabel/processPrintIssueLabel',
  '/api/reprintIssueLabel/printIssueLabel',
  '/api/reprintIssueLabel/printLabel',
  '/api/reprintIssueLabel/print',
  '/api/reprintIssueLabelPrinting/processReprintIssueLabel',
  '/api/reprintIssueLabelPrinting/printIssueLabel',
  '/api/issueLabel/processIssueLabel',
  '/api/issueLabel/processPrintIssueLabel',
  '/api/issueLabel/printIssueLabel',
  '/api/issueLabel/printLabel',
  '/api/issueLabel/print',
  '/api/issueLabels/printIssueLabel',
  '/api/issueLabels/printLabel',
  '/api/issuing/printIssueLabel',
  '/api/issuing/printLabel',
  '/api/labels/printIssueLabel',
  '/api/labels/printLabel',
  '/api/label/printIssueLabel',
  '/api/label/printLabel',
  '/api/label/print'
];

// QX Web authentication model
// ---------------------------
// RF Plus passwords are never saved. The RF Plus token and current-user identity
// live in sessionStorage, so a normal refresh keeps the session while separate tabs
// and separate devices do not overwrite one another. Long-lived UI preferences stay
// in localStorage.

function storageGet(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function storageSet(key, val) {
  try { localStorage.setItem(key, val); } catch (e) {}
}
function storageRemove(key) {
  try { localStorage.removeItem(key); } catch (e) {}
}
function authGet(key) {
  try { return sessionStorage.getItem(key); } catch (e) { return null; }
}
function authSet(key, val) {
  try { sessionStorage.setItem(key, val); } catch (e) {}
}
function authRemove(key) {
  try { sessionStorage.removeItem(key); } catch (e) {}
}

// One-time migration from the earlier Web build, which kept auth in localStorage.
// The migrated token is immediately validated before it can be used.
(function migrateLegacyWebAuth(){
  try {
    if (!authGet('qm_token')) {
      const legacyToken = localStorage.getItem('qm_token') || localStorage.getItem('token');
      const legacyUser = localStorage.getItem('currentUser');
      const legacyWh = localStorage.getItem('selectedWarehouse');
      if (legacyToken) authSet('qm_token', legacyToken);
      if (legacyUser) authSet('currentUser', legacyUser);
      if (legacyWh) authSet('selectedWarehouse', legacyWh);
    }
    localStorage.removeItem('qm_token');
    localStorage.removeItem('token');
    localStorage.removeItem('currentUser');
    localStorage.removeItem('selectedWarehouse');
  } catch (e) {}
})();

let tok = authGet('qm_token') || '';
let whs = authGet('selectedWarehouse') || DEFAULT_WAREHOUSE;
let usr = (() => {
  try { return JSON.parse(authGet('currentUser') || '{}').UserName || ''; }
  catch (e) { return ''; }
})();

const S = { tab: 'master', wo: null, lot: null, spl: null, sub: null, subs: [], ip: [], rp: [], retActions: [], dm: [], dmIssued: [], dmWos: [], dmCandidateCount: 0, dmRawCount: 0, dmActiveCount: 0, dmPerf: null, pplRows: [], pplPart: null, pl: null, plPart: null, kbRows: [], kbInputParts: [], issueSort: { key: 'none', dir: 'none' }, issueLocCache: new Map() };

let rfConnectionState = tok ? 'reconnecting' : 'login-required';
let rfSessionCheckPromise = null;
let rfLoginPromise = null;
let rfReconnectTimer = null;
let rfReconnectDelay = 2500;

function setRFConnectionState(state, message) {
  rfConnectionState = state;
  if (window.QXStatus && typeof window.QXStatus.setRFState === 'function') {
    window.QXStatus.setRFState(state, message);
  }
}

function getLoginCredentials() {
  const u = document.getElementById('loginUser');
  const p = document.getElementById('loginPass');
  return {
    username: (u && u.value ? u.value : '').trim().toUpperCase(),
    password: (p && p.value) ? p.value : ''
  };
}

function updateUserBadge() {
  const el = document.getElementById('um');
  if (!el) return;
  el.textContent = tok && usr ? (whs + ' · ' + usr) : 'Not logged in';
}

function showLogin(msg, isError) {
  const ov = document.getElementById('loginOverlay');
  const lm = document.getElementById('loginMsg');
  if (ov) ov.classList.remove('hidden');
  if (lm) {
    lm.textContent = msg || 'Sign in with your RF Plus user ID and password.';
    lm.className = 'login-msg' + (isError ? ' err' : '');
  }
  const u = document.getElementById('loginUser');
  const p = document.getElementById('loginPass');
  if (u && !u.value) { const last = storageGet('qx_last_user'); if (last) u.value = last; }
  setTimeout(() => { if (u && !u.value) u.focus(); else if (p) p.focus(); }, 60);
  updateUserBadge();
}

function hideLogin() {
  const ov = document.getElementById('loginOverlay');
  if (ov) ov.classList.add('hidden');
  updateUserBadge();
}

function setLoginWorking(isWorking, msg) {
  const btn = document.getElementById('loginBtn');
  const lm = document.getElementById('loginMsg');
  if (btn) {
    btn.disabled = !!isWorking;
    btn.textContent = isWorking ? 'Signing in...' : '🔐 SIGN IN';
  }
  if (lm && msg !== undefined) {
    lm.textContent = msg || '';
    lm.className = 'login-msg';
  }
}

function clearAuth() {
  tok = '';
  usr = '';
  whs = DEFAULT_WAREHOUSE;
  authRemove('qm_token');
  authRemove('token');
  authRemove('currentUser');
  authRemove('selectedWarehouse');
  updateUserBadge();
}

function clearPerUserTransientState() {
  try {
    const keys = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith('po_receiving_session_')) keys.push(k);
    }
    keys.forEach(k => sessionStorage.removeItem(k));
  } catch (e) {}
  try { if (typeof clrAll === 'function') clrAll(); } catch (e) {}
  try { if (typeof clearPartLookup === 'function') clearPartLookup(); } catch (e) {}
  try { if (typeof clearKanban === 'function') clearKanban(); } catch (e) {}
  try { if (typeof QXPOReceiving !== 'undefined' && QXPOReceiving.reset) QXPOReceiving.reset(); } catch (e) {}
}

function signOut() {
  clearPerUserTransientState();
  clearAuth();
  setRFConnectionState('login-required', 'Signed out');
  const p = document.getElementById('loginPass'); if (p) p.value = '';
  showLogin('Signed out. Sign in with your RF Plus user ID and password.');
  notifyNativeModulesSession();
  toast('Signed out', 'info', 2500);
}

function createRFError(message, status, payload) {
  const err = new Error(message || 'RF Plus API error');
  err.status = Number(status || 0);
  err.payload = payload;
  return err;
}

async function parseRFResponse(res) {
  let d;
  const text = await res.text();
  try { d = text ? JSON.parse(text) : {}; }
  catch (e) { throw createRFError('Invalid API response', res.status); }
  const msg = d.Msg || d.msg || d.Message || d.message;
  if (!res.ok) throw createRFError(msg || ('HTTP ' + res.status), res.status, d);
  if (d.Code !== undefined) {
    if (d.Code !== 100) throw createRFError(msg || 'RF Plus API error', res.status, d);
    return d.Data;
  }
  if (d.MsgType === 2 || d.msgType === 2) throw createRFError(msg || 'RF Plus API error', res.status, d);
  if (d.Data !== undefined) return d.Data;
  if (d.data !== undefined) return d.data;
  return d;
}

async function apiRaw(endpoint, body, tokenOverride) {
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' };
  const auth = tokenOverride !== undefined ? tokenOverride : tok;
  if (auth) headers.Authorization = auth;
  let res;
  try {
    res = await fetch(API + endpoint, {
      method: 'POST', headers, body: JSON.stringify(body || {}), credentials: 'same-origin', cache: 'no-store'
    });
  } catch (e) {
    const err = createRFError(e && e.message ? e.message : 'Failed to fetch', 0);
    err.isNetworkError = true;
    throw err;
  }
  return parseRFResponse(res);
}

function isAuthFailure(e) {
  const status = Number(e && e.status || 0);
  const payloadCode = Number(e && e.payload && (e.payload.Code ?? e.payload.code) || 0);
  const m = String(e && e.message || '').toLowerCase();
  return status === 401 || status === 403 || payloadCode === 401 || payloadCode === 403 ||
    m.includes('unauthorized') || m.includes('invalid token') || m.includes('token expired') ||
    m.includes('session expired') || m.includes('invalid session') || m.includes('session not found') ||
    m.includes('login required') || m.includes('not logged in') || m.includes('authentication failed');
}
function isNetworkFailure(e) {
  const status = Number(e && e.status || 0);
  return !!(e && e.isNetworkError) || status === 0 || status >= 500 || String(e && e.message || '').toLowerCase().includes('failed to fetch');
}

function persistAuthenticatedSession() {
  authSet('qm_token', tok);
  authSet('token', tok);
  authSet('selectedWarehouse', whs);
  authSet('currentUser', JSON.stringify({ UserName: usr }));
}

async function loginRFPlus(silent) {
  if (rfLoginPromise) return rfLoginPromise;
  const { username, password } = getLoginCredentials();
  if (!username || !password) {
    if (silent) return false;
    if (!username) { showLogin('Enter your RF Plus user ID.', true); const u = document.getElementById('loginUser'); if (u) u.focus(); return false; }
    showLogin('Enter your password.', true); const p = document.getElementById('loginPass'); if (p) p.focus(); return false;
  }

  rfLoginPromise = (async () => {
    setRFConnectionState('reconnecting', 'Signing in');
    setLoginWorking(true, 'Signing in to RF Plus...');
    try {
      const loginData = await apiRaw('/api/user/login', { company: COMPANY, username, password, sessionTakeover: true }, '');
      const user = loginData && (loginData.User || loginData.user || loginData);
      const token = user && (user.Token || user.token);
      if (!token) throw new Error('Login succeeded but no token was returned.');
      const warehouses = loginData.Warehouses || loginData.warehouses || [];
      tok = token;
      usr = user.UserName || user.userName || username;
      whs = warehouses.includes(DEFAULT_WAREHOUSE) ? DEFAULT_WAREHOUSE : (warehouses[0] || DEFAULT_WAREHOUSE);
      await apiRaw('/api/user/validateWarehouse', { warehouse: whs }, tok);
      await apiRaw('/api/user/validateLanguage', { language: DEFAULT_LANGUAGE }, tok);
      await apiRaw('/api/user/getUserModules', { userName: usr }, tok);
      persistAuthenticatedSession();
      storageSet('qx_last_user', usr);
      const p = document.getElementById('loginPass'); if (p) p.value = '';
      hideLogin();
      notifyNativeModulesSession();
      initPartLookupPrinter(true).catch(()=>{});
      updateUserBadge();
      rfReconnectDelay = 2500;
      setRFConnectionState('connected', 'Connected as ' + usr);
      toast('✅ Signed in as ' + usr, 'success');
      return true;
    } catch (e) {
      clearAuth();
      setRFConnectionState(isNetworkFailure(e) ? 'failed' : 'login-required', cleanError(e.message));
      showLogin('Sign in failed: ' + cleanError(e.message), true);
      return false;
    } finally {
      setLoginWorking(false);
      rfLoginPromise = null;
    }
  })();
  return rfLoginPromise;
}

async function validateExistingRFSession(options) {
  options = options || {};
  if (!tok || !usr) return false;
  if (rfSessionCheckPromise) return rfSessionCheckPromise;
  rfSessionCheckPromise = (async () => {
    setRFConnectionState('reconnecting', options.reason || 'Checking existing session');
    try {
      await apiRaw('/api/user/getUserModules', { userName: usr }, tok);
      persistAuthenticatedSession();
      hideLogin();
      notifyNativeModulesSession();
      updateUserBadge();
      rfReconnectDelay = 2500;
      setRFConnectionState('connected', 'Connected as ' + usr);
      return true;
    } catch (e) {
      if (isAuthFailure(e)) {
        clearAuth();
        setRFConnectionState('expired', 'RF Plus session expired');
        showLogin('RF Plus session expired. Sign in again.', true);
      } else {
        setRFConnectionState('failed', cleanError(e.message));
        scheduleSilentReconnect();
      }
      return false;
    } finally {
      rfSessionCheckPromise = null;
    }
  })();
  return rfSessionCheckPromise;
}

function scheduleSilentReconnect() {
  if (!tok || rfReconnectTimer) return;
  const delay = rfReconnectDelay;
  rfReconnectTimer = setTimeout(async () => {
    rfReconnectTimer = null;
    if (!tok) return;
    const ok = await validateExistingRFSession({ reason: 'Automatic reconnect' });
    if (!ok && tok) {
      rfReconnectDelay = Math.min(Math.round(rfReconnectDelay * 1.8), 30000);
      scheduleSilentReconnect();
    }
  }, delay);
}

async function bootstrapRFSession() {
  if (!tok || !usr) {
    setRFConnectionState('login-required', 'Login required');
    showLogin('Sign in with your RF Plus user ID and password.');
    return false;
  }
  hideLogin();
  return validateExistingRFSession({ reason: 'Restoring RF Plus session' });
}

async function reconnectQuickX() {
  if (!tok || !usr) {
    setRFConnectionState('login-required', 'Login required');
    showLogin('Sign in with your RF Plus user ID and password.');
    return false;
  }
  toast('Checking RF Plus session...', 'info', 2200);
  const ok = await validateExistingRFSession({ reason: 'Manual reconnect' });
  if (ok) {
    notifyNativeModulesSession();
    if (S.wo && S.sub !== null && (S.tab === 'master' || S.tab === 'pick')) loadParts();
    if (S.wo && S.sub !== null && S.tab === 'return') loadReturn();
    toast('✅ RF Plus connected', 'success', 2200);
  }
  return ok;
}

function cleanError(msg) {
  if (!msg) return 'Unknown error';
  if (msg === 'Failed to fetch') return 'Cannot reach RF Plus. Check the Quickmill network and the QX Web host.';
  return msg;
}

async function api(endpoint, body) {
  if (!tok) {
    setRFConnectionState('login-required', 'Login required');
    showLogin('Sign in with your RF Plus user ID and password.');
    throw new Error('Not logged in');
  }
  try {
    const result = await apiRaw(endpoint, body, tok);
    setRFConnectionState('connected', 'Connected as ' + usr);
    return result;
  } catch (e) {
    if (isAuthFailure(e)) {
      clearAuth();
      setRFConnectionState('expired', 'RF Plus session expired');
      showLogin('RF Plus session expired. Sign in again.', true);
    } else if (isNetworkFailure(e)) {
      // Never replay an inventory-changing POST automatically. Keep the token,
      // reconnect silently in the background, and let the user verify the result.
      setRFConnectionState('failed', cleanError(e.message));
      scheduleSilentReconnect();
    } else {
      setRFConnectionState('failed', cleanError(e.message));
    }
    throw createRFError(cleanError(e.message), e.status, e.payload);
  }
}


function getNativeAdjustModule() {
  return document.getElementById('adjustModule');
}
function activateNativeAdjust() {
  const module = getNativeAdjustModule();
  if (module && typeof module.activate === 'function') module.activate();
}
function notifyNativeModulesSession() {
  const module = getNativeAdjustModule();
  if (module && typeof module.onSessionChanged === 'function') module.onSessionChanged();
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}


// ============================================================
//  ISSUE LABEL PRINTING — API only, no RF Plus UI clicking
// ============================================================
function isDemandTabActive() {
  return S && S.tab === 'partDemand';
}
function isPartLookupActive() {
  return S && S.tab === 'partLookup';
}

function getActiveLabelPrinterEl() {
  if (isDemandTabActive()) {
    const dm = document.getElementById('dmLabelPrinter');
    if (dm) return dm;
  }
  return document.getElementById('labelPrinter') || document.getElementById('dmLabelPrinter');
}

function getActiveLabelCopiesEl() {
  if (isDemandTabActive()) {
    const dm = document.getElementById('dmLabelCopies');
    if (dm) return dm;
  }
  return document.getElementById('labelCopies') || document.getElementById('dmLabelCopies');
}

function getActiveAutoPrintEl() {
  if (isDemandTabActive()) {
    const dm = document.getElementById('dmAutoPrintAfterIssue');
    if (dm) return dm;
  }
  return document.getElementById('autoPrintAfterIssue') || document.getElementById('dmAutoPrintAfterIssue');
}

function getLabelPrinter() {
  const el = getActiveLabelPrinterEl();
  const v = String(el ? el.value : '').trim().toUpperCase();
  return LABEL_PRINTERS.includes(v) ? v : DEFAULT_LABEL_PRINTER;
}

function getLabelCopies() {
  const el = getActiveLabelCopiesEl();
  const n = parseInt(el ? el.value : DEFAULT_LABEL_COPIES, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LABEL_COPIES;
  return Math.min(n, 999);
}

function autoPrintAfterIssue() {
  const el = getActiveAutoPrintEl();
  return !!(el && el.checked);
}

function setAllLabelControlValues(printer, copies, auto) {
  ['labelPrinter', 'dmLabelPrinter'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = printer;
  });
  ['labelCopies', 'dmLabelCopies'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = copies;
  });
  ['autoPrintAfterIssue', 'dmAutoPrintAfterIssue'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.checked = !!auto;
  });
}

function saveLabelSettings() {
  const printer = getLabelPrinter();
  const copies = String(getLabelCopies());
  const auto = autoPrintAfterIssue();
  storageSet('qm_label_printer', printer);
  storageSet('qm_label_copies', copies);
  storageSet('qm_auto_print_after_issue', auto ? '1' : '0');
  setAllLabelControlValues(printer, copies, auto);
  updateLabelPrintStatus('Printer: ' + printer + ' · Copies: ' + copies);
}

function initLabelSettings() {
  let printer = String(storageGet('qm_label_printer') || DEFAULT_LABEL_PRINTER).trim().toUpperCase();
  if (!LABEL_PRINTERS.includes(printer)) printer = DEFAULT_LABEL_PRINTER;
  const copies = storageGet('qm_label_copies') || String(DEFAULT_LABEL_COPIES);
  const auto = storageGet('qm_auto_print_after_issue') === '1';
  setAllLabelControlValues(printer, copies, auto);
  updateLabelPrintStatus('Printer: ' + printer + ' · Copies: ' + copies);
}

function updateLabelPrintStatus(msg, isError) {
  ['labelPrintStatus', 'dmLabelPrintStatus'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = isError ? 'var(--danger)' : 'var(--muted)';
  });
}

const issuePrinterListCache = { warehouse:'', values:null, promise:null };
function printerIdFromAny(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim().toUpperCase();
  const id = value.ID || value.Id || value.id || value.Name || value.name || value.PrinterId || value.printerId || '';
  return String(id).trim().toUpperCase();
}
function collectPrinterValues(payload, out=[]) {
  if (Array.isArray(payload)) { payload.forEach(x => collectPrinterValues(x, out)); return out; }
  if (payload && typeof payload === 'object') {
    const direct = printerIdFromAny(payload);
    if (direct) out.push(direct);
    Object.values(payload).forEach(v => { if (v && typeof v === 'object') collectPrinterValues(v, out); });
  }
  return out;
}
async function getSharedIssuePrinterList(force=false) {
  if (!force && issuePrinterListCache.values && issuePrinterListCache.warehouse === whs) return issuePrinterListCache.values.slice();
  if (!force && issuePrinterListCache.promise && issuePrinterListCache.warehouse === whs) return issuePrinterListCache.promise;
  issuePrinterListCache.warehouse = whs;
  issuePrinterListCache.promise = (async () => {
    let values = LABEL_PRINTERS.slice();
    try {
      const response = await api('/api/printing/GetLabelPrinters', { warehouseId: whs });
      values = values.concat(collectPrinterValues(response));
    } catch (e) {}
    values = Array.from(new Set(values.map(x => String(x || '').trim().toUpperCase()).filter(Boolean)));
    issuePrinterListCache.values = values.length ? values : LABEL_PRINTERS.slice();
    issuePrinterListCache.promise = null;
    return issuePrinterListCache.values.slice();
  })();
  return issuePrinterListCache.promise;
}
function populatePrinterSelect(select, printers, preferred) {
  if (!select) return;
  const values = Array.from(new Set((printers || LABEL_PRINTERS).map(x => String(x || '').trim().toUpperCase()).filter(Boolean)));
  const chosen = String(preferred || select.value || DEFAULT_LABEL_PRINTER).trim().toUpperCase();
  if (chosen && !values.includes(chosen)) values.unshift(chosen);
  select.innerHTML = values.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
  select.value = values.includes(chosen) ? chosen : (values[0] || DEFAULT_LABEL_PRINTER);
}
function partLookupPrinterStorageKey() {
  return 'qx_part_lookup_printer_' + String(usr || 'ANONYMOUS').trim().toUpperCase();
}
function getPartLookupPrinter() {
  const el = document.getElementById('plLabelPrinter');
  return String((el && el.value) || DEFAULT_LABEL_PRINTER).trim().toUpperCase() || DEFAULT_LABEL_PRINTER;
}
function updatePartLookupPrinterStatus(msg, isError) {
  const el = document.getElementById('plLabelPrinterStatus');
  if (!el) return;
  el.textContent = msg || ('Active Demand labels use ' + getPartLookupPrinter() + '.');
  el.style.color = isError ? 'var(--danger)' : 'var(--muted)';
}
function savePartLookupPrinter() {
  const printer = getPartLookupPrinter();
  storageSet(partLookupPrinterStorageKey(), printer);
  updatePartLookupPrinterStatus('Active Demand labels use ' + printer + '.', false);
}
async function initPartLookupPrinter(force=false) {
  const select = document.getElementById('plLabelPrinter');
  if (!select) return;
  const preferred = storageGet(partLookupPrinterStorageKey()) || select.value || DEFAULT_LABEL_PRINTER;
  const printers = await getSharedIssuePrinterList(force);
  populatePrinterSelect(select, printers, preferred);
  savePartLookupPrinter();
}

function normalizeUom(v) {
  return String(v || 'EA').trim().toUpperCase() || 'EA';
}

function cleanPartForPrint(partId) {
  return String(partId || '').trim().toUpperCase();
}

function makeIssuePrintPayload(label) {
  const part = cleanPartForPrint(label.partId || label.PartId || label.PartID || label.Part);
  const qty = Number(label.qty || label.Qty || label.Quantity || 1) || 1;
  const copies = Number(label.copies || label.Copies || label.numberOfLabels || getLabelCopies()) || 1;
  const pieceRaw = label.pieceNo ?? label.PieceNo ?? label.PieceID ?? label.PieceId ?? 0;
  const pieceNum = Number(pieceRaw);
  return {
    WOId: String(label.WOId || label.woId || S.wo || '').trim().toUpperCase(),
    lotId: String(label.lotId ?? label.LotId ?? S.lot ?? '1'),
    splitId: String(label.splitId ?? label.SplitId ?? S.spl ?? '0'),
    subId: String(label.subId ?? label.SubId ?? S.sub ?? '0'),
    seqNo: String(label.seqNo ?? label.SeqNo ?? label.OperationNo ?? label.OperationNumber ?? ''),
    pieceNo: Number.isFinite(pieceNum) ? pieceNum : pieceRaw,
    partId: part,
    traceId: String(label.traceId ?? label.TraceId ?? ''),
    qty: String(qty),
    warehouseId: String(label.warehouseId || label.WarehouseId || whs || DEFAULT_WAREHOUSE),
    printerId: String(label.printerId || label.printer || getLabelPrinter()).trim().toUpperCase() || DEFAULT_LABEL_PRINTER,
    numberOfLabels: Math.min(Math.max(1, copies), 999),
    isIssueLabel: true,
    IsWOLPNPickingByOperationType: !!(label.IsWOLPNPickingByOperationType || label.isWOLPNPickingByOperationType)
  };
}

async function parseRFMaybeSuccess(res) {
  const text = await res.text();
  let d = null;
  try { d = text ? JSON.parse(text) : {}; }
  catch (e) { d = null; }

  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    if (d && typeof d === 'object') msg = d.Msg || d.msg || d.Message || d.message || d.Error || d.error || msg;
    else if (text) msg = text;
    throw new Error(msg);
  }

  // RF Plus printLabel returns text/plain on this build. Treat HTTP 200 as success.
  if (d === null) {
    const t = String(text || '').trim();
    if (/^false$/i.test(t)) throw new Error('RF Plus returned false');
    if (/error|exception|failed/i.test(t)) throw new Error(t);
    return { ok: true, raw: t };
  }

  const msg = d.Msg || d.msg || d.Message || d.message || d.Error || d.error;
  if (d.Code !== undefined && d.Code !== 100) throw new Error(msg || ('RF Plus code ' + d.Code));
  if (d.MsgType === 2 || d.msgType === 2) throw new Error(msg || 'RF Plus API error');
  return d.Data !== undefined ? d.Data : (d.data !== undefined ? d.data : d);
}

async function tryPrintEndpoint(endpoint, payload) {
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' };
  if (tok) headers.Authorization = tok;
  const res = await fetch(API + endpoint, { method: 'POST', headers, body: JSON.stringify(payload || {}) });
  return parseRFMaybeSuccess(res);
}

function normalizeRfPlusUrl(url) {
  if (!url) return '';
  let u = String(url).replace(/\\/g, '').replace(/['"`]+$/g, '');
  if (u.startsWith('//')) u = 'http:' + u;
  else if (u.startsWith('/')) u = RF9000 + u;
  else if (!/^https?:/i.test(u)) u = RF9000 + '/' + u.replace(/^\.\//, '');
  return u;
}

function extractApiPrintEndpoints(jsText) {
  const endpoints = new Set();
  const text = String(jsText || '');
  const re = /\/api\/[A-Za-z0-9_\-\/]*(?:[Pp]rint|[Ll]abel|[Rr]eprint|[Ii]ssue)[A-Za-z0-9_\-\/]*/g;
  let m;
  while ((m = re.exec(text))) {
    const ep = m[0].replace(/\\/g, '').replace(/['"`\)\];,]+$/g, '');
    if (/label|print|reprint/i.test(ep)) endpoints.add(ep);
  }
  return Array.from(endpoints);
}

function extractScriptUrls(text) {
  const out = new Set();
  const t = String(text || '');
  let m;
  const scriptTag = /<script[^>]+src=["']([^"']+\.js[^"']*)["']/gi;
  while ((m = scriptTag.exec(t))) out.add(normalizeRfPlusUrl(m[1]));

  // Angular lazy chunks often appear as quoted .js strings inside runtime/main bundle.
  const quotedJs = /["']([^"']+\.js(?:\?[^"']*)?)["']/gi;
  while ((m = quotedJs.exec(t))) out.add(normalizeRfPlusUrl(m[1]));

  // Some builds reference chunks like 1234: "abc.chunk.js" without a path.
  const looseJs = /([A-Za-z0-9._\-]+\.js)/gi;
  while ((m = looseJs.exec(t))) {
    const name = m[1];
    if (/runtime|main|polyfills|styles|chunk|issue|label|print/i.test(name)) out.add(normalizeRfPlusUrl(name));
  }
  return Array.from(out).filter(Boolean);
}

async function discoverPrintEndpointsFromRFPlus() {
  const cached = storageGet('qm_print_discovered_endpoints_v17');
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }
  const found = new Set();
  const seenScripts = new Set();
  const queue = [];

  try {
    const htmlRes = await fetch(RF9000 + '/');
    const html = await htmlRes.text();
    extractApiPrintEndpoints(html).forEach(x => found.add(x));
    extractScriptUrls(html).forEach(x => queue.push(x));

    // Scan enough chunks to catch lazy-loaded Issue Label Printing code, but cap it so it stays fast.
    while (queue.length && seenScripts.size < 80) {
      const url = queue.shift();
      if (!url || seenScripts.has(url)) continue;
      seenScripts.add(url);
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const js = await res.text();
        extractApiPrintEndpoints(js).forEach(x => found.add(x));
        extractScriptUrls(js).forEach(x => {
          if (!seenScripts.has(x) && queue.length < 160) queue.push(x);
        });
      } catch (e) {}
    }
  } catch (e) {}

  const arr = Array.from(found).sort((a, b) => {
    const score = x => (/issue/i.test(x) ? 25 : 0) + (/label/i.test(x) ? 25 : 0) + (/print/i.test(x) ? 15 : 0) + (/reprint/i.test(x) ? 5 : 0) - x.length / 1000;
    return score(b) - score(a);
  });
  if (arr.length) storageSet('qm_print_discovered_endpoints_v17', JSON.stringify(arr));
  return arr;
}

async function printIssueLabel(label, opts) {
  opts = opts || {};
  const payload = makeIssuePrintPayload(label);
  const setPrintStatus = typeof opts.statusUpdater === 'function' ? opts.statusUpdater : updateLabelPrintStatus;
  if (!payload.WOId) throw new Error('WO missing for issue label print');
  if (!payload.partId) throw new Error('Part number missing for issue label print');
  if (!payload.seqNo) throw new Error('Seq/Operation missing for issue label print');

  setPrintStatus('Printing issue label for ' + payload.partId + '...', false);

  try {
    await tryPrintEndpoint('/api/issuing/printLabel', payload);
    setPrintStatus('Printed ' + payload.partId + ' to ' + payload.printerId + ' · Copies: ' + payload.numberOfLabels, false);
    if (!opts.silent) toast('🏷 Label printed: ' + payload.partId + ' × ' + payload.qty, 'success', 4000);
    return true;
  } catch (e) {
    const msg = 'Issue label print failed: ' + cleanError(e.message || e);
    setPrintStatus(msg, true);
    if (!opts.silent) toast('❌ ' + msg, 'error', 9000);
    throw new Error(msg);
  }
}

function reqToPrintLabel(r, qtyOverride, copiesOverride) {
  const qty = qtyOverride || getDefaultPrintQtyForRow(r);
  const copies = copiesOverride || getLabelCopies();
  return {
    WOId: getReqWO(r),
    lotId: getReqLot(r),
    splitId: getReqSplit(r),
    subId: getReqSub(r),
    seqNo: r.SeqNo,
    pieceNo: r.PieceNo,
    partId: r.PartId,
    traceId: r.TraceId || '',
    uom: r.Uom || r.UOM || 'EA',
    qty: qty,
    copies: copies,
    printer: getLabelPrinter(),
    warehouseId: whs,
    isIssueLabel: true,
    IsWOLPNPickingByOperationType: false
  };
}

async function printIssueLabelFromIssueIndex(i) {
  const r = S.ip[i];
  if (!r) return;
  const need = Math.max(1, Number(r.CalculatedQty || 0) - Number(r.IssuedQty || 0));
  const btn = document.querySelector('[data-print-index="' + i + '"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Printing...'; }
  try {
    await printIssueLabel(reqToPrintLabel(r, need));
  } catch (e) {
    toast('❌ Label ' + r.PartId + ': ' + e.message, 'error', 9000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'LABEL'; }
  }
}

async function printDemandLabel(i) {
  const r = S.dm[i];
  if (!r) return;
  const qi = document.getElementById('dmq' + i);
  const qty = Math.max(1, Number(qi ? qi.value : r.NeedQty) || Number(r.NeedQty) || 1);
  const btn = document.querySelector('[data-demand-print="' + i + '"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Printing...'; }
  try {
    await printIssueLabel(reqToPrintLabel(r, qty));
  } catch (e) {
    toast('❌ Label ' + r.PartId + ': ' + e.message, 'error', 9000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'LABEL'; }
  }
}

// ============================================================
//  TAB SWITCHING
// ============================================================
function switchTab(t) {
  S.tab = t;
  document.querySelectorAll('.tab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === t)
  );

  const isWoView = (t === 'master' || t === 'pick');
  const isWoOrReturn = isWoView || t === 'return';
  const woCard = document.getElementById('woControlCard');
  if (woCard) woCard.classList.toggle('hidden', !isWoOrReturn);

  document.getElementById('tabIssue').classList.toggle('hidden', !isWoView);
  document.getElementById('tabReturn').classList.toggle('hidden', t !== 'return');
  const pp = document.getElementById('tabPrintPart');
  if (pp) pp.classList.toggle('hidden', t !== 'printPart');
  const adj = document.getElementById('tabAdjust');
  if (adj) adj.classList.toggle('hidden', t !== 'adjust');
  const pd = document.getElementById('tabPartDemand');
  if (pd) pd.classList.toggle('hidden', t !== 'partDemand');
  const pl = document.getElementById('tabPartLookup');
  if (pl) pl.classList.toggle('hidden', t !== 'partLookup');
  const kb = document.getElementById('tabKanban');
  if (kb) kb.classList.toggle('hidden', t !== 'kanban');
  const po = document.getElementById('tabPOReceiving');
  if (po) po.classList.toggle('hidden', t !== 'poReceiving');

  document.body.classList.toggle('pick-mode', t === 'pick');
  document.body.classList.toggle('master-mode', t === 'master');
  document.body.classList.toggle('adjust-mode', t === 'adjust');
  document.body.classList.toggle('return-mode', t === 'return');
  document.body.classList.toggle('print-part-mode', t === 'printPart');
  document.body.classList.toggle('part-lookup-mode', t === 'partLookup');
  document.body.classList.toggle('kanban-mode', t === 'kanban');
  document.body.classList.toggle('po-receiving-mode', t === 'poReceiving');

  if (t === 'printPart') { loadPrintPartPrinters(); }
  if (t === 'partLookup') { initPartLookupPrinter().catch(()=>{}); }
  if (t === 'poReceiving') { try { QXPOReceiving.init(); } catch (e) { console.error('PO init', e); } }
  if (t === 'adjust') { activateNativeAdjust(); }

  // WO Master and WO ISSUING are separate module experiences over the same RF Plus data:
  // Master = full table/actions/returns; WO ISSUING = iPad next-pick workflow.
  if (S.sub !== null && isWoView) {
    if (S.ip && S.ip.length) renderIssue(S.ip);
    else loadParts();
  }
  if (S.sub !== null && t === 'return') loadReturn();
}


function resizePOReceivingFrame() { /* removed in 1.8: PO Receiving is now a native module, no iframe. */ }

// ============================================================
//  TOAST NOTIFICATIONS
// ============================================================
function toast(msg, type, dur) {
  type = type || 'info'; dur = dur || 4000;
  const c = document.getElementById('toast');
  if (!c) return;
  const el = document.createElement('div');
  el.className = 'ti ' + (type === 'success' ? 'ts' : type === 'error' ? 'te' : 'ti2');
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), dur);
}

window.QXServices = Object.freeze({
  api: (endpoint, body) => api(endpoint, body),
  toast: (msg, type, dur) => toast(msg, type, dur),
  cleanError: msg => cleanError(msg),
  getWarehouse: () => whs,
  getUser: () => usr,
  isSignedIn: () => !!tok,
  reconnect: () => reconnectQuickX()
});

// ============================================================
//  STATUS BAR
// ============================================================
function stat(msg, type) {
  type = type || 'ld';
  const b = document.getElementById('statBar');
  b.className = 'statbar ' + type;
  b.classList.remove('hidden');
  const icon = type === 'ld' ? '<div class="spin"></div>' : type === 'ok' ? '✅' : '❌';
  b.innerHTML = icon + ' <span>' + esc(msg) + '</span>';
}
function hideStat() { document.getElementById('statBar').classList.add('hidden'); }

// ============================================================
//  LOAD WORK ORDER
// ============================================================

function isAllSubSelected() {
  return String(S.sub).toUpperCase() === 'ALL';
}

function getReqWO(r) { return r.WOId || S.wo; }
function getReqLot(r) { return r.LotId ?? r.lotId ?? S.lot; }
function getReqSplit(r) { return r.SplitId ?? r.splitId ?? S.spl; }
function getReqSub(r) { return r.SubId ?? r.subId ?? S.sub; }

function tagRequirementWithSub(r, subInfo) {
  const copy = Object.assign({}, r);
  copy.WOId = copy.WOId || S.wo;
  copy.LotId = copy.LotId ?? subInfo.LotId;
  copy.SplitId = copy.SplitId ?? subInfo.SplitId;
  copy.SubId = copy.SubId ?? subInfo.SubId;
  return copy;
}

// ============================================================
//  SQL BRIDGE READ HELPERS — WO Master / WO ISSUING
//  RF Plus API remains the only transaction path.
// ============================================================
async function fetchSqlBridge(path) {
  try {
    const res = await fetch(SQL_BRIDGE + path, { method: 'GET' });
    let j;
    try { j = await res.json(); }
    catch (e) { throw new Error('SQL Bridge returned invalid response'); }
    if (!res.ok || !j.ok) throw new Error((j && j.error) || ('SQL Bridge HTTP ' + res.status));
    if (window.QXStatus) window.QXStatus.bridgeUp();
    return j;
  } catch (e) {
    if (window.QXStatus) window.QXStatus.bridgeDown();
    throw e;
  }
}

function normalizeSqlWO(row) {
  return {
    LotId: row.LotId ?? row.LOT_ID ?? '1',
    SplitId: row.SplitId ?? row.SPLIT_ID ?? '0',
    SubId: row.SubId ?? row.SUB_ID ?? '0',
    Status: row.Status ?? row.STATUS ?? '',
    PartId: row.PartId ?? row.PART_ID ?? '',
    QXSource: 'SQL'
  };
}

function parseSqlIssueLocList(v) {
  const raw = String(v || '').trim();
  if (!raw) return [];
  return raw.split('|').map(x => {
    const idx = x.lastIndexOf(':');
    const loc = (idx >= 0 ? x.slice(0, idx) : x).trim().toUpperCase();
    const qty = Number(idx >= 0 ? x.slice(idx + 1) : 0) || 0;
    return { locationId: loc, qty, traceId: '', locStatus: 'A', raw: { source: 'SQL' } };
  }).filter(x => x.locationId && x.qty > 0);
}

function normalizeSqlRequirement(row) {
  const r = {
    WOId: row.WOId ?? row.WORKORDER_BASE_ID ?? S.wo,
    LotId: row.LotId ?? row.WORKORDER_LOT_ID ?? S.lot,
    SplitId: row.SplitId ?? row.WORKORDER_SPLIT_ID ?? S.spl,
    SubId: row.SubId ?? row.WORKORDER_SUB_ID ?? S.sub,
    PartId: row.PartId ?? row.PART_ID ?? row.ID ?? '',
    Desc: row.Desc ?? row.DESCRIPTION ?? '',
    Uom: row.Uom ?? row.STOCK_UM ?? 'EA',
    CalculatedQty: Number(row.CalculatedQty ?? row.CALC_QTY ?? 0) || 0,
    IssuedQty: Number(row.IssuedQty ?? row.ISSUED_QTY ?? 0) || 0,
    InvPartQty: Number(row.InvPartQty ?? row.INV_PART_QTY ?? 0) || 0,
    PartPrimaryLocID: row.PartPrimaryLocID ?? row.PART_PRIMARY_LOC_ID ?? row.BestLocationId ?? '',
    SeqNo: row.SeqNo ?? row.OPERATION_SEQ_NO ?? row.SEQ_NO ?? null,
    PieceNo: row.PieceNo ?? row.PIECE_NO ?? null,
    QXSqlRead: true,
    QXSource: 'SQL'
  };
  const locs = parseSqlIssueLocList(row.QXIssueLocList ?? row.StockLocationList ?? '');
  if (locs.length) {
    r.QXIssueLocs = locs;
    r.QXIssueLocResolved = true;
    r.QXActualStockQty = locs.reduce((sum, x) => sum + (Number(x.qty) || 0), 0);
    r.QXIssueLocID = locs[0].locationId;
    r.QXIssueLocQty = locs[0].qty;
    r.InvPartQty = r.QXActualStockQty;
    r.PartPrimaryLocID = r.PartPrimaryLocID || locs[0].locationId;
  }
  return r;
}

async function loadWOFromSql(v) {
  const data = await fetchSqlBridge('/api/wo?woId=' + encodeURIComponent(v));
  const rows = (data.rows || []).map(normalizeSqlWO);
  if (!rows.length) throw new Error('No SQL WO rows found');

  S.wo = v;
  S.subs = rows;
  S.lot = rows[0].LotId;
  S.spl = rows[0].SplitId;
  S.sub = null;

  document.getElementById('woMeta').textContent =
    'Lot ' + rows[0].LotId + ' · Split ' + rows[0].SplitId + ' · ' + rows.length + ' sub(s) · SQL Bridge';

  const subButtons = rows.map(s => {
    const sid = String(s.SubId);
    const st = s.Status ? ' ' + esc(s.Status) : '';
    return `<button class="pill" data-sub="${esc(sid)}">Sub ${esc(sid)}${st}</button>`;
  }).join('');
  document.getElementById('subPills').innerHTML = subButtons + '<button class="pill pill-all" data-sub="ALL">All Sub</button>';

  document.getElementById('subSec').classList.remove('hidden');
  hideStat();

  if (rows.length === 1) selSub(String(rows[0].SubId));
  else toast('SQL Bridge loaded WO. Select a Sub ID below.', 'success', 3500);
  return true;
}

async function loadWO() {
  const v = document.getElementById('woi').value.trim().toUpperCase();
  if (!v) return;
  clrDisplay();

  let sqlErr = null;
  stat('Loading ' + v + ' from SQL Bridge...', 'ld');
  try {
    await loadWOFromSql(v);
    return;
  } catch (e) {
    sqlErr = e;
    stat('SQL Bridge failed. Falling back to RF Plus...', 'ld');
  }

  try {
    const data = await api('/api/issuing/GetWOs', { WOId: v, IsIssuingReturn: S.tab === 'return' });
    if (!data || !data.length) { stat('No work order sub-lots found for ' + v, 'err'); return; }

    S.wo = v;
    S.subs = data;
    S.lot = data[0].LotId;
    S.spl = data[0].SplitId;
    S.sub = null;

    document.getElementById('woMeta').textContent =
      'Lot ' + data[0].LotId + ' · Split ' + data[0].SplitId + ' · ' + data.length + ' sub(s) · RF Plus fallback';

    const subButtons = data.map(s => {
      const sid = String(s.SubId);
      return `<button class="pill" data-sub="${esc(sid)}">Sub ${esc(sid)}</button>`;
    }).join('');
    document.getElementById('subPills').innerHTML = subButtons + '<button class="pill pill-all" data-sub="ALL">All Sub</button>';

    document.getElementById('subSec').classList.remove('hidden');
    hideStat();

    if (data.length === 1) selSub(String(data[0].SubId));
    else toast('SQL Bridge failed, RF Plus fallback loaded. Select a Sub ID below.', 'info');
  } catch (e) {
    const extra = sqlErr ? 'SQL Bridge: ' + cleanError(sqlErr.message) + ' | RF Plus: ' : '';
    stat('Error: ' + extra + e.message, 'err');
    toast(extra + e.message, 'error', 8000);
  }
}

function selSub(id) {
  id = String(id);
  S.sub = id;
  if (!isAllSubSelected()) {
    const s = S.subs.find(x => String(x.SubId) === id);
    if (s) { S.lot = s.LotId; S.spl = s.SplitId; }
  }
  document.querySelectorAll('.pill').forEach(p =>
    p.classList.toggle('active', p.dataset.sub === id)
  );
  (S.tab === 'master' || S.tab === 'pick' || S.tab === 'partDemand') ? loadParts() : (S.tab === 'return' ? loadReturn() : null);
}

function clrDisplay() {
  ['iPanel', 'sumRow', 'rPanel'].forEach(id => document.getElementById(id).classList.add('hidden'));
  ['iTb', 'rTb'].forEach(id => document.getElementById(id).innerHTML = '');
}

function clrAll() {
  S.wo = null; S.sub = null; S.subs = [];
  document.getElementById('woi').value = '';
  document.getElementById('woMeta').textContent = '';
  document.getElementById('subSec').classList.add('hidden');
  clrDisplay();
  hideStat();
}

// ============================================================
//  WO ISSUING — Load Requirements
// ============================================================
async function loadPartsFromSql() {
  const qs = new URLSearchParams();
  qs.set('woId', S.wo);
  if (!isAllSubSelected()) {
    qs.set('lotId', S.lot || '');
    qs.set('splitId', S.spl || '');
    qs.set('subId', S.sub || '');
  }
  const data = await fetchSqlBridge('/api/worequirements?' + qs.toString());
  const rows = (data.rows || []).map(normalizeSqlRequirement);
  S.ip = rows;
  renderIssue(S.ip);
  hideStat();
  const scope = isAllSubSelected() ? 'ALL Sub IDs' : ('Sub ' + S.sub);
  toast('SQL Bridge loaded ' + rows.length + ' requirement(s) for ' + scope, 'success', 3500);
  return true;
}

async function loadParts() {
  if (!S.wo || S.sub === null) return;

  const scope = isAllSubSelected() ? 'ALL Sub IDs' : ('Sub ' + S.sub);
  stat('Loading ' + scope + ' from SQL Bridge...', 'ld');
  let sqlErr = null;
  try {
    await loadPartsFromSql();
    return;
  } catch (e) {
    sqlErr = e;
    stat('SQL Bridge failed. Falling back to RF Plus...', 'ld');
  }

  if (isAllSubSelected()) {
    try {
      const results = await Promise.allSettled(S.subs.map(su => api('/api/issuing/validateWorkOrderAndGetRequirementsList', {
        WOId: S.wo, LotId: su.LotId, SplitId: su.SplitId, SubId: su.SubId, WarehouseId: whs
      }).then(d => ({ subInfo: su, data: d }))));

      const combined = [];
      let failed = 0;
      results.forEach(res => {
        if (res.status !== 'fulfilled') { failed++; return; }
        const subInfo = res.value.subInfo;
        const reqs = (res.value.data && res.value.data.Requirements) || [];
        reqs.forEach(r => combined.push(tagRequirementWithSub(r, subInfo)));
      });

      S.ip = combined;
      await hydrateIssueLocations(S.ip);
      renderIssue(S.ip);
      hideStat();
      toast('RF Plus fallback loaded All Sub: ' + combined.length + ' requirement(s)' + (failed ? ' · ' + failed + ' sub(s) failed' : ''), failed ? 'error' : 'success', 5000);
    } catch (e) {
      stat('Error loading all subs: SQL ' + cleanError(sqlErr && sqlErr.message) + ' | RF Plus ' + e.message, 'err');
      toast(e.message, 'error');
    }
    return;
  }

  try {
    const subInfo = S.subs.find(x => String(x.SubId) === String(S.sub)) || { LotId: S.lot, SplitId: S.spl, SubId: S.sub };
    const d = await api('/api/issuing/validateWorkOrderAndGetRequirementsList', {
      WOId: S.wo, LotId: S.lot, SplitId: S.spl, SubId: S.sub, WarehouseId: whs
    });
    S.ip = (d.Requirements || []).map(r => tagRequirementWithSub(r, subInfo));
    await hydrateIssueLocations(S.ip);
    renderIssue(S.ip);
    hideStat();
    toast('RF Plus fallback loaded requirements', 'info', 3500);
  } catch (e) {
    stat('Error: SQL ' + cleanError(sqlErr && sqlErr.message) + ' | RF Plus ' + e.message, 'err');
    toast(e.message, 'error');
  }
}

function getIssueStatusInfo(r) {
  const q = getIssueQuantities(r);

  if (q.need <= 0) {
    return { key: 'DONE', label: 'Done', badge: '<span class="badge b-done">✓ DONE</span>' };
  }
  if (!q.hasLoc || q.stockQty <= 0) {
    return { key: 'NO_STOCK', label: 'No Stock', badge: '<span class="badge b-ns">NO STOCK</span>' };
  }
  // Partial means either something is already issued OR stock is available but less than remaining demand.
  // This keeps low-stock lines out of the Pending filter so the iPad next-card can move to the next fully issuable item.
  if (q.issuedQty > 0 || q.stockQty < q.need) {
    return { key: 'PARTIAL', label: 'Partial', badge: '<span class="badge b-part">PARTIAL</span>' };
  }
  return { key: 'PENDING', label: 'Pending', badge: '<span class="badge b-pend">PENDING</span>' };
}

function getIssueFilterValues() {
  const part = document.getElementById('iFilterPart')?.value || '';
  const loc = document.getElementById('iFilterLocation')?.value || '';
  const desc = document.getElementById('iFilterDesc')?.value || '';
  const status = document.getElementById('iFilterStatus')?.value || 'ALL';
  const locSort = document.getElementById('iSortLocation')?.value || 'NONE';
  return {
    part: part.trim().toUpperCase(),
    loc: loc.trim().toUpperCase(),
    desc: desc.trim().toUpperCase(),
    status,
    locSort
  };
}


// ============================================================
//  WO ISSUING — Actual RF Plus Stock Location Resolver
//  QX 1.4 Final: show/use live stock location from RF Plus instead of only PartPrimaryLocID.
//  Matches RF Plus WO ISSUING behavior by hiding HOLD/unavailable locations.
// ============================================================
function cleanLocId(v) {
  return String(v == null ? '' : v).trim().toUpperCase();
}

function cleanPartId(v) {
  return String(v == null ? '' : v).trim().toUpperCase();
}

function getLocQty(x) {
  return Number(x?.Qty ?? x?.qty ?? x?.Quantity ?? x?.quantity ?? x?.AvailableQty ?? x?.availableQty ?? x?.OnHandQty ?? x?.onHandQty ?? 0) || 0;
}

function normalizeIssueLocRow(x) {
  const locationId = cleanLocId(x?.LocationId ?? x?.locationId ?? x?.locationID ?? x?.PartLocation ?? x?.partLocation ?? x?.Location ?? x?.location);
  const qty = getLocQty(x);
  return {
    locationId,
    qty,
    traceId: String(x?.TraceId ?? x?.traceId ?? ''),
    locStatus: cleanLocId(x?.LocStatus ?? x?.locStatus ?? x?.PartLocationStatus ?? x?.partLocationStatus ?? x?.partLocStatus ?? ''),
    raw: x
  };
}

async function getActualIssueLocations(partId, forceRefresh) {
  partId = cleanPartId(partId);
  if (!partId) return [];
  if (!forceRefresh && S.issueLocCache && S.issueLocCache.has(partId)) return S.issueLocCache.get(partId);

  const rows = await api('/api/issuing/getPartLocations', {
    partId: partId,
    warehouseId: whs,
    DoNotShowHoldLocations: true,
    DoNotShowUnavailableLocations: true
  });

  const list = (Array.isArray(rows) ? rows : [])
    .map(normalizeIssueLocRow)
    .filter(x => x.locationId && x.qty > 0);

  if (S.issueLocCache) S.issueLocCache.set(partId, list);
  return list;
}

function setBestIssueLocationOnReq(r, locs) {
  const list = Array.isArray(locs) ? locs : [];
  r.QXIssueLocs = list;
  r.QXIssueLocResolved = true;
  r.QXActualStockQty = list.reduce((sum, x) => sum + (Number(x.qty) || 0), 0);

  if (list.length === 1) {
    r.QXIssueLocID = list[0].locationId;
    r.QXIssueLocQty = list[0].qty;
  } else {
    const primary = cleanLocId(r.PartPrimaryLocID);
    const primaryLoc = primary ? list.find(x => cleanLocId(x.locationId) === primary) : null;
    r.QXIssueLocID = primaryLoc ? primaryLoc.locationId : '';
    r.QXIssueLocQty = primaryLoc ? primaryLoc.qty : 0;
  }
}

async function hydrateIssueLocations(reqs) {
  const rows = (reqs || []).filter(r => r && r.PartId && Number(r.InvPartQty || 0) > 0);
  const parts = Array.from(new Set(rows.map(r => cleanPartId(r.PartId)).filter(Boolean)));
  if (!parts.length) return;

  stat('Checking actual RF Plus stock locations...', 'ld');
  const batchSize = 6;
  for (let i = 0; i < parts.length; i += batchSize) {
    const batch = parts.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(part => getActualIssueLocations(part).then(locs => ({ part, locs })).catch(() => ({ part, locs: [] }))));
    results.forEach(({ part, locs }) => {
      rows.filter(r => cleanPartId(r.PartId) === part).forEach(r => setBestIssueLocationOnReq(r, locs));
    });
  }
}

function getDisplayIssueLocation(r) {
  return String(r?.QXIssueLocID || r?.PartPrimaryLocID || '');
}

function getDisplayIssueLocationTitle(r) {
  const primary = cleanLocId(r?.PartPrimaryLocID);
  const actual = cleanLocId(r?.QXIssueLocID);
  const locs = Array.isArray(r?.QXIssueLocs) ? r.QXIssueLocs : [];
  if (locs.length > 1) return 'Multiple RF Plus locations available: ' + locs.map(x => x.locationId + ' (' + x.qty + ')').join(', ');
  if (actual && primary && actual !== primary) return 'RF Plus actual stock location: ' + actual + ' · Primary: ' + primary;
  if (actual) return 'RF Plus actual stock location: ' + actual;
  if (primary) return 'Primary location: ' + primary;
  return '';
}

async function resolveIssueLocationForQty(r, requestedQty) {
  let locs = Array.isArray(r.QXIssueLocs) && r.QXIssueLocResolved ? r.QXIssueLocs : null;
  if (!locs) {
    locs = await getActualIssueLocations(r.PartId, true);
    setBestIssueLocationOnReq(r, locs);
  }
  locs = (locs || []).filter(x => x.locationId && Number(x.qty || 0) > 0);

  if (!locs.length) {
    throw new Error('No available RF Plus stock location found for ' + (r.PartId || '') + '. Refresh RF Plus/QX and check Inventory Lookup.');
  }

  let chosen = null;
  if (locs.length === 1) {
    chosen = locs[0];
  } else {
    const primary = cleanLocId(r.PartPrimaryLocID);
    const lines = locs.map((x, idx) => (idx + 1) + ') ' + x.locationId + '  Qty: ' + x.qty + (cleanLocId(x.locationId) === primary ? '  (Primary)' : '')).join('\n');
    const ans = prompt('Multiple RF Plus stock locations found for ' + r.PartId + '.\n\nChoose location number to issue from:\n\n' + lines, '1');
    if (ans === null) throw new Error('Issue cancelled. Location not selected.');
    const n = parseInt(ans, 10);
    if (!n || n < 1 || n > locs.length) throw new Error('Invalid location selection.');
    chosen = locs[n - 1];
  }

  const locQty = Number(chosen.qty || 0);
  if (requestedQty > locQty) {
    throw new Error('Location ' + chosen.locationId + ' has only ' + locQty + '. Requested issue qty is ' + requestedQty + '.');
  }

  r.QXIssueLocID = chosen.locationId;
  r.QXIssueLocQty = chosen.qty;
  return chosen;
}


function getIssueQuantities(r) {
  const reqQty = Number(r.CalculatedQty || 0);
  const issuedQty = Number(r.IssuedQty || 0);
  const resolvedStock = r && r.QXIssueLocResolved ? Number(r.QXActualStockQty || 0) : Number(r.InvPartQty || 0);
  const stockQty = resolvedStock || 0;
  const need = Math.max(0, reqQty - issuedQty);
  const loc = getDisplayIssueLocation(r);
  const hasLoc = !!loc || stockQty > 0;
  const availableIssueQty = (need > 0 && stockQty > 0 && hasLoc) ? Math.min(need, stockQty) : 0;
  return { reqQty, issuedQty, stockQty, need, hasLoc, availableIssueQty };
}

function getDefaultPrintQtyForRow(r) {
  const q = getIssueQuantities(r);
  if (q.availableIssueQty > 0) return q.availableIssueQty;
  if (q.need > 0) return q.need;
  return Math.max(1, q.reqQty || q.issuedQty || 1);
}

function compareBlankLast(a, b) {
  const aa = String(a || '').trim().toUpperCase();
  const bb = String(b || '').trim().toUpperCase();
  if (!aa && !bb) return 0;
  if (!aa) return 1;
  if (!bb) return -1;
  return aa.localeCompare(bb, undefined, { numeric: true, sensitivity: 'base' });
}

function updateIssueSortMark() {
  const mark = document.getElementById('locSortMark');
  if (!mark) return;
  const v = document.getElementById('iSortLocation')?.value || 'NONE';
  mark.textContent = v === 'AZ' ? '▲' : v === 'ZA' ? '▼' : '';
}

function applyIssueFiltersAndSort(reqs) {
  const f = getIssueFilterValues();
  let items = reqs.map((r, i) => {
    const info = getIssueStatusInfo(r);
    return {
      r,
      i,
      part: String(r.PartId || '').toUpperCase(),
      loc: String(getDisplayIssueLocation(r) || '').toUpperCase(),
      desc: String(r.Desc || '').toUpperCase(),
      sub: String(getReqSub(r) || '').toUpperCase(),
      statusKey: info.key,
      statusInfo: info
    };
  });

  if (f.part) items = items.filter(x => x.part.includes(f.part));
  if (f.loc) items = items.filter(x => x.loc.includes(f.loc));
  if (f.desc) {
    const words = f.desc.split(/\s+/).filter(Boolean);
    items = items.filter(x => words.every(w => x.desc.includes(w)));
  }
  if (f.status && f.status !== 'ALL') items = items.filter(x => x.statusKey === f.status);

  if (f.locSort === 'AZ') {
    items.sort((a, b) => compareBlankLast(a.loc, b.loc));
  } else if (f.locSort === 'ZA') {
    items.sort((a, b) => compareBlankLast(b.loc, a.loc));
  } else if (S.issueSort.key === 'part') {
    items.sort((a, b) => S.issueSort.dir === 'za' ? compareBlankLast(b.part, a.part) : compareBlankLast(a.part, b.part));
  } else if (S.issueSort.key === 'status') {
    const order = { PENDING: 1, PARTIAL: 2, NO_STOCK: 3, DONE: 4 };
    items.sort((a, b) => S.issueSort.dir === 'za'
      ? (order[b.statusKey] || 99) - (order[a.statusKey] || 99)
      : (order[a.statusKey] || 99) - (order[b.statusKey] || 99));
  }

  updateIssueSortMark();
  return items;
}


function renderNextPickCard(filtered) {
  const card = document.getElementById('nextPickCard');
  if (!card) return;
  if (S.tab !== 'pick') { card.classList.add('hidden'); card.innerHTML = ''; S.nextPickIndex = null; return; }
  const first = filtered && filtered.length ? filtered[0] : null;
  if (!first) {
    card.classList.add('hidden');
    card.innerHTML = '';
    S.nextPickIndex = null;
    return;
  }

  const r = first.r;
  const i = first.i;
  S.nextPickIndex = i;
  const q = getIssueQuantities(r);
  const loc = getDisplayIssueLocation(r) || '';
  const subId = getReqSub(r);
  const canIssue = q.availableIssueQty > 0;
  const issueDisabled = canIssue ? '' : 'disabled';
  const issueLabel = canIssue
    ? (first.statusInfo.key === 'PARTIAL' ? `ISSUE PARTIAL x${esc(q.availableIssueQty)}` : `ISSUE x${esc(q.availableIssueQty)}`)
    : first.statusInfo.label.toUpperCase();
  const stockClass = q.stockQty > 0 ? 'ok' : 'bad';
  const partialNote = first.statusInfo.key === 'PARTIAL'
    ? `<div class="next-partial-note">Partial stock: demand ${esc(q.need)} but stock ${esc(q.stockQty)}. Filter Status = Pending will skip this row.</div>`
    : '';

  card.classList.remove('hidden');
  card.innerHTML = `
    <div class="next-pick-top">
      <div>
        <div class="next-pick-kicker">NEXT ITEM FROM CURRENT FILTER / SORT</div>
        <div class="next-pick-desc" title="${esc(r.Desc)}">${esc(r.Desc || '')}</div>
        ${partialNote}
      </div>
      <div class="next-pick-status">${first.statusInfo.badge}</div>
    </div>
    <div class="next-pick-grid">
      <div class="next-pick-box big-part">
        <div class="next-label">Part ID</div>
        <div class="next-value">${esc(r.PartId || '')}</div>
      </div>
      <div class="next-pick-box big-location">
        <div class="next-label">Location</div>
        <div class="next-value">${q.hasLoc ? esc(loc) : '—'}</div>
      </div>
      <div class="next-pick-box">
        <div class="next-label">Sub</div>
        <div class="next-small-value">Sub ${esc(subId)}</div>
      </div>
      <div class="next-pick-box">
        <div class="next-label">Need</div>
        <div class="next-small-value">${esc(q.need)} ${esc(r.Uom || '')}</div>
      </div>
      <div class="next-pick-box">
        <div class="next-label">Stock</div>
        <div class="next-small-value ${stockClass}">${esc(q.stockQty)} ${esc(r.Uom || '')}</div>
      </div>
    </div>
    <div class="next-action-row next-action-row-3">
      <button class="btn btn-print next-action-btn" data-print-index="${i}">🏷 PRINT LABEL</button>
      <button class="btn btn-success next-action-btn" data-issue-index="${i}" ${issueDisabled}>✅ ${issueLabel}</button>
      <button class="btn btn-ghost next-action-btn next-custom-btn" data-custom-print-index="${i}">✎ LABEL QTY / COPIES</button>
    </div>`;
}

function renderIssue(reqs) {
  let tot = reqs.length, done = 0, pend = 0, ns = 0, partial = 0;
  reqs.forEach(r => {
    const info = getIssueStatusInfo(r);
    if (info.key === 'DONE') done++;
    else if (info.key === 'NO_STOCK') ns++;
    else if (info.key === 'PARTIAL') partial++;
    else pend++;
  });

  const filtered = applyIssueFiltersAndSort(reqs);
  renderNextPickCard(filtered);
  const rows = filtered.map(({ r, i, statusInfo }, visibleIdx) => {
    const q = getIssueQuantities(r);
    const reqQty = q.reqQty;
    const issuedQty = q.issuedQty;
    const stockQty = q.stockQty;
    const need = q.need;
    const loc = getDisplayIssueLocation(r) || '';
    const subId = getReqSub(r);
    const actionParts = [];
    if (q.availableIssueQty > 0) {
      const issueText = statusInfo.key === 'PARTIAL' ? 'ISSUE PARTIAL x' + esc(q.availableIssueQty) : 'ISSUE x' + esc(q.availableIssueQty);
      actionParts.push(`<button class="btn btn-success btn-xs" data-issue-index="${i}">${issueText}</button>`);
    }
    actionParts.push(`<button class="btn btn-print btn-xs" data-print-index="${i}">LABEL</button>`);
    actionParts.push(`<button class="btn btn-ghost btn-xs" data-custom-print-index="${i}">LABEL+</button>`);

    if (S.tab === 'master' && issuedQty > 0) {
      const retMax = Math.max(1, issuedQty);
      actionParts.push(`<input class="qi return-qi" id="mret${i}" type="number" min="1" max="${esc(retMax)}" value="${esc(retMax)}" title="Return Qty">`);
      actionParts.push(`<button class="btn btn-danger btn-xs" data-master-return-index="${i}">↩ RETURN</button>`);
    }

    const act = `<div class="row-actions">${actionParts.join('')}</div>`;
    const sc = stockQty > 0 ? 'var(--success)' : 'var(--danger)';
    return `<tr id="ir${i}" class="${visibleIdx === 0 ? 'first-visible-row' : ''}">
      <td class="wo-part-cell" data-label="Part ID"><b class="qx-part">${esc(r.PartId)}</b></td>
      <td class="wo-sub-cell" data-label="Sub"><span class="badge b-sub">Sub ${esc(subId)}</span></td>
      <td class="wo-desc-cell" data-label="Description" title="${esc(r.Desc)}">${esc(r.Desc)}</td>
      <td class="wo-req-cell" data-label="Req Qty">${esc(reqQty)} <span class="dim">${esc(r.Uom)}</span></td>
      <td class="wo-issued-cell" data-label="Issued">${esc(issuedQty)}</td>
      <td class="wo-stock-cell" data-label="In Stock" style="color:${sc};font-weight:700">${esc(stockQty)}</td>
      <td class="wo-location-cell mono" data-label="Location" title="${esc(getDisplayIssueLocationTitle(r))}">${loc ? esc(loc) : '<span class="dim">—</span>'}</td>
      <td class="wo-status-cell" data-label="Status">${statusInfo.badge}</td>
      <td class="wo-action-cell" data-label="Action">${act}</td>
    </tr>`;
  }).join('');

  const filterMeta = document.getElementById('iFilterMeta');
  if (filterMeta) {
    filterMeta.textContent = filtered.length === reqs.length
      ? reqs.length + ' part(s) shown'
      : filtered.length + ' of ' + reqs.length + ' part(s) shown';
  }

  document.getElementById('iTb').innerHTML = rows || '<tr><td colspan="9" class="empty">No requirements match the filters</td></tr>';
  ['sT', 'sD', 'sP', 'sN'].forEach((id, i) =>
    document.getElementById(id).textContent = [tot, done, pend, ns][i]
  );
  document.getElementById('sumRow').classList.remove('hidden');
  document.getElementById('iPanel').classList.remove('hidden');
  document.getElementById('btnAll').disabled = pend === 0;
  const retAll = document.getElementById('btnReturnAll');
  if (retAll) { retAll.classList.toggle('hidden', S.tab !== 'master'); retAll.disabled = !reqs.some(r => Number(r.IssuedQty || 0) > 0); }
}

function clearIssueFilters() {
  const part = document.getElementById('iFilterPart');
  const loc = document.getElementById('iFilterLocation');
  const desc = document.getElementById('iFilterDesc');
  const status = document.getElementById('iFilterStatus');
  const sort = document.getElementById('iSortLocation');
  if (part) part.value = '';
  if (loc) loc.value = '';
  if (desc) desc.value = '';
  if (status) status.value = 'ALL';
  if (sort) sort.value = 'NONE';
  S.issueSort = { key: 'none', dir: 'none' };
  renderIssue(S.ip || []);
}

function cycleIssueSort(key) {
  if (key === 'location') {
    const sort = document.getElementById('iSortLocation');
    if (!sort) return;
    sort.value = sort.value === 'NONE' ? 'AZ' : sort.value === 'AZ' ? 'ZA' : 'NONE';
    S.issueSort = { key: 'none', dir: 'none' };
  } else {
    const sort = document.getElementById('iSortLocation');
    if (sort) sort.value = 'NONE';
    S.issueSort = S.issueSort.key !== key
      ? { key, dir: 'az' }
      : S.issueSort.dir === 'az'
        ? { key, dir: 'za' }
        : { key: 'none', dir: 'none' };
  }
  renderIssue(S.ip || []);
}

// ============================================================
//  WO ISSUING — Issue Single Part
// ============================================================
async function issueSingle(i) {
  const r = S.ip[i];
  if (!r) return;
  const q = getIssueQuantities(r);
  const issueQty = q.availableIssueQty;
  if (!issueQty || issueQty <= 0) { toast('No available stock/location to issue for ' + (r.PartId || ''), 'error', 6000); return; }
  const row = document.getElementById('ir' + i);
  const btns = Array.from(document.querySelectorAll('[data-issue-index="' + i + '"]'));
  btns.forEach(btn => { btn.disabled = true; btn.textContent = 'Issuing...'; });
  try {
    await callIssue(r, issueQty);
    if (autoPrintAfterIssue()) {
      try { await printIssueLabel(reqToPrintLabel(r, issueQty), { silent: true }); }
      catch (pe) { toast('⚠ Issued, but label failed: ' + pe.message, 'error', 9000); }
    }
    toast('✅ ' + r.PartId + ' × ' + issueQty + ' issued', 'success');
    await loadParts();
  } catch (e) {
    toast('❌ ' + r.PartId + ': ' + e.message, 'error', 7000);
    btns.forEach(btn => { btn.disabled = false; btn.textContent = (q.stockQty < q.need ? 'ISSUE PARTIAL x' : 'ISSUE x') + issueQty; });
  }
}

async function callIssue(r, qty) {
  const chosenLoc = await resolveIssueLocationForQty(r, Number(qty || 0));
  return api('/api/issuing/processIssuing', {
    WOId: getReqWO(r), lotId: getReqLot(r), splitId: getReqSplit(r), subId: getReqSub(r),
    PartId: r.PartId, seqNo: r.SeqNo, pieceNo: r.PieceNo,
    traceId: null, traceList: null,
    locationId: chosenLoc.locationId, warehouseId: whs,
    TransactionDate: '', qty: qty,
    pieceTrackingPieces: null,
    pieceTrackingProperty: { length: null, width: null, height: null },
    Shift: null, Seq: null, Reason: '', Comments: ''
  });
}

// ============================================================
//  WO ISSUING — Issue ALL with stock
// ============================================================
async function issueAll() {
  const toIssue = S.ip.filter(r => {
    const q = getIssueQuantities(r);
    return q.need > 0 && q.availableIssueQty >= q.need; // skip partial-stock lines in Issue All
  });
  if (!toIssue.length) { toast('Nothing to issue — all done or no stock', 'info'); return; }

  const subLabel = isAllSubSelected() ? 'ALL Sub IDs' : ('Sub ' + S.sub);
  if (!confirm('⚠ ISSUE ALL WITH STOCK\n\nWork Order: ' + S.wo + '\nScope: ' + subLabel + '\nLines to issue: ' + toIssue.length + '\n\nThis will issue every fully available pending line. Continue?')) return;

  document.getElementById('btnAll').disabled = true;
  const prog = document.getElementById('iProgress');
  const bar = document.getElementById('iPBar');
  const lbl = document.getElementById('iPLbl');
  prog.classList.remove('hidden');

  let ok = 0, fail = 0;
  for (let i = 0; i < toIssue.length; i++) {
    const r = toIssue[i];
    const need = getIssueQuantities(r).availableIssueQty;
    lbl.textContent = '(' + (i + 1) + '/' + toIssue.length + ')  ' + r.PartId + ' × ' + need;
    bar.style.width = Math.round((i / toIssue.length) * 100) + '%';
    try {
      await callIssue(r, need);
      if (autoPrintAfterIssue()) {
        try { await printIssueLabel(reqToPrintLabel(r, need), { silent: true }); }
        catch (pe) { toast('⚠ Issued ' + r.PartId + ', label failed: ' + pe.message, 'error', 9000); }
      }
      ok++;
    } catch (e) {
      fail++;
      toast('❌ ' + r.PartId + ': ' + e.message, 'error', 7000);
    }
    await new Promise(res => setTimeout(res, 250));
  }

  bar.style.width = '100%';
  lbl.textContent = '✅ Complete — ' + ok + ' issued' + (fail ? ' | ' + fail + ' failed' : '');
  if (!fail) toast('✅ All ' + ok + ' parts issued successfully!', 'success', 5000);
  else toast('⚠ ' + ok + ' issued, ' + fail + ' failed', 'error', 6000);
  setTimeout(() => prog.classList.add('hidden'), 5000);
  await loadParts();
}

// ============================================================
//  WO ISSUE RETURN — Load
// ============================================================
async function loadReturn() {
  if (!S.wo || S.sub === null) return;
  if (isAllSubSelected()) {
    document.getElementById('rPanel').classList.add('hidden');
    stat('All Sub is for WO Issuing view only. Select one Sub ID for Issue Return.', 'err');
    toast('Select a specific Sub ID for WO Issue Return.', 'info', 5000);
    return;
  }
  stat('Loading issued parts...', 'ld');
  document.getElementById('rPanel').classList.remove('hidden');
  document.getElementById('rTb').innerHTML = '';
  const rl = document.getElementById('rLoading');
  rl.style.display = 'flex';

  try {
    const data = await api('/api/issueReturn/validateWOAndGetRequirements', {
      WOId: S.wo, LotId: S.lot, SplitId: S.spl, SubId: S.sub, WarehouseId: whs
    });
    const reqs = (data.ReqList || []).filter(r => Number(r.IssuedQty || 0) > 0);

    if (!reqs.length) {
      rl.style.display = 'none';
      document.getElementById('rTb').innerHTML = '<tr><td colspan="6" class="empty">No issued parts found for this sub</td></tr>';
      hideStat();
      return;
    }

    const locArr = await Promise.all(reqs.map(r =>
      api('/api/issueReturn/getIssuedLocations', {
        WOId: S.wo, LotId: S.lot, SplitId: S.spl, SubId: S.sub,
        PartId: r.PartId, WarehouseId: whs, SeqNo: r.SeqNo, PieceNo: r.PieceNo
      }).catch(() => [])
    ));

    rl.style.display = 'none';
    S.retActions = [];
    let ri = 0;
    const rows = [];
    reqs.forEach((r, idx) => {
      const locs = locArr[idx] || [];
      if (!locs.length) {
        rows.push(mkRetRow(ri++, r, null, r.IssuedQty));
      } else {
        locs.forEach(loc => rows.push(mkRetRow(ri++, r, loc, loc.Qty)));
      }
    });

    document.getElementById('rTb').innerHTML = rows.join('');
    hideStat();
  } catch (e) {
    rl.style.display = 'none';
    stat('Error: ' + e.message, 'err');
    toast(e.message, 'error');
  }
}

function mkRetRow(i, r, loc, qty) {
  const locId = loc ? (loc.locationId || loc.LocationId || loc.locationID || '') : '';
  const safeLoc = locId || '—';
  const seqNo = r.SeqNo == null ? null : r.SeqNo;
  const pieceNo = r.PieceNo == null ? null : r.PieceNo;
  S.retActions[i] = { partId: String(r.PartId || ''), locId: String(safeLoc), seqNo: seqNo, pieceNo: pieceNo };
  return `<tr>
    <td><b class="qx-part">${esc(r.PartId)}</b></td>
    <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.Desc)}">${esc(r.Desc)}</td>
    <td style="text-align:center;font-weight:600">${esc(qty)}</td>
    <td style="text-align:center"><input class="qi" id="rq${i}" type="number" min="1" max="${esc(qty)}" value="${esc(qty)}"></td>
    <td class="mono">${esc(safeLoc)}</td>
    <td style="text-align:right"><button class="btn btn-danger btn-xs" data-return-index="${i}">↩ RETURN</button></td>
  </tr>`;
}

// ============================================================
//  WO ISSUE RETURN — Process Return
// ============================================================
function doReturnAction(i) {
  const a = S.retActions && S.retActions[i];
  if (!a) { toast('Return action not found. Refresh and try again.', 'error'); return; }
  return doReturn(i, a.partId, a.locId, a.seqNo, a.pieceNo);
}

async function doReturn(i, partId, locId, seqNo, pieceNo) {
  const qi = document.getElementById('rq' + i);
  const qty = parseInt(qi.value, 10);
  if (!qty || qty <= 0) { toast('Enter a valid return quantity', 'error'); return; }
  const row = qi.closest('tr');
  const btn = row ? row.querySelector('button') : null;
  if (btn) { btn.disabled = true; btn.textContent = 'Returning...'; }
  try {
    await api('/api/issueReturn/processIssueReturn', {
      WOId: S.wo, lotId: S.lot, splitId: S.spl, subId: S.sub,
      PartId: partId, seqNo: String(seqNo), pieceNo: pieceNo,
      traceId: null, traceList: null,
      locationId: locId === '—' ? '' : locId, warehouseId: whs,
      TransactionDate: '', qty: qty,
      pieceTrackingPieces: null,
      pieceTrackingProperties: { length: null, width: null, height: null },
      LPN: null, Shift: null, Seq: null, Reason: '', Comments: ''
    });
    toast('✅ Returned ' + partId + ' × ' + qty, 'success');
    loadReturn();
  } catch (e) {
    toast('❌ ' + e.message, 'error', 7000);
    if (btn) { btn.disabled = false; btn.textContent = '↩ RETURN'; }
  }
}



// ============================================================
//  WO MASTER — Inline Return + Return All
// ============================================================
async function getIssuedLocationsForReq(r) {
  try {
    const locs = await api('/api/issueReturn/getIssuedLocations', {
      WOId: getReqWO(r), LotId: getReqLot(r), SplitId: getReqSplit(r), SubId: getReqSub(r),
      PartId: r.PartId, WarehouseId: whs, SeqNo: r.SeqNo, PieceNo: r.PieceNo
    });
    return Array.isArray(locs) ? locs : [];
  } catch (e) { return []; }
}

async function processReturnForReq(r, qty) {
  qty = Number(qty || 0);
  if (!r || !qty || qty <= 0) throw new Error('Invalid return quantity');
  const locs = await getIssuedLocationsForReq(r);
  let remaining = qty;
  const actions = [];
  if (locs.length) {
    for (const loc of locs) {
      if (remaining <= 0) break;
      const locQty = Number(loc.Qty || loc.qty || loc.IssuedQty || 0) || remaining;
      const useQty = Math.min(remaining, locQty);
      const locId = String(loc.locationId || loc.LocationId || loc.locationID || loc.Location || r.PartPrimaryLocID || '');
      actions.push({ qty: useQty, locId });
      remaining -= useQty;
    }
  }
  if (!actions.length) actions.push({ qty, locId: String(r.PartPrimaryLocID || '') });

  for (const a of actions) {
    await api('/api/issueReturn/processIssueReturn', {
      WOId: getReqWO(r), lotId: getReqLot(r), splitId: getReqSplit(r), subId: getReqSub(r),
      PartId: r.PartId, seqNo: String(r.SeqNo), pieceNo: r.PieceNo,
      traceId: null, traceList: null,
      locationId: a.locId === '—' ? '' : a.locId, warehouseId: whs,
      TransactionDate: '', qty: a.qty,
      pieceTrackingPieces: null,
      pieceTrackingProperties: { length: null, width: null, height: null },
      LPN: null, Shift: null, Seq: null, Reason: '', Comments: ''
    });
  }
}

async function returnFromMaster(i) {
  const r = S.ip[i];
  if (!r) return;
  const input = document.getElementById('mret' + i);
  const qty = Number(input ? input.value : r.IssuedQty);
  if (!qty || qty <= 0) { toast('Enter Return Qty', 'error'); return; }
  if (!confirm('Return ' + qty + ' of ' + r.PartId + ' back to stock?')) return;
  const btns = Array.from(document.querySelectorAll('[data-master-return-index="' + i + '"]'));
  btns.forEach(b => { b.disabled = true; b.textContent = 'Returning...'; });
  try {
    await processReturnForReq(r, qty);
    toast('✅ Returned ' + r.PartId + ' × ' + qty, 'success');
    await loadParts();
  } catch (e) {
    toast('❌ Return failed: ' + e.message, 'error', 8000);
    btns.forEach(b => { b.disabled = false; b.textContent = '↩ RETURN'; });
  }
}

async function returnAllToStock() {
  const rows = (S.ip || []).filter(r => Number(r.IssuedQty || 0) > 0);
  if (!rows.length) { toast('No issued parts to return.', 'info'); return; }
  const subLabel = isAllSubSelected() ? 'ALL Sub IDs' : ('Sub ' + S.sub);
  if (!confirm('⚠ RETURN ALL TO STOCK\n\nWork Order: ' + S.wo + '\nScope: ' + subLabel + '\nLines to return: ' + rows.length + '\n\nThis will return previously issued inventory back to stock. Continue?')) return;
  const btn = document.getElementById('btnReturnAll');
  if (btn) { btn.disabled = true; btn.textContent = 'Returning...'; }
  const prog = document.getElementById('iProgress');
  const bar = document.getElementById('iPBar');
  const lbl = document.getElementById('iPLbl');
  prog.classList.remove('hidden');
  let ok = 0, fail = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const qty = Number(r.IssuedQty || 0);
    lbl.textContent = '(' + (i + 1) + '/' + rows.length + ') Returning ' + r.PartId + ' × ' + qty;
    bar.style.width = Math.round((i / rows.length) * 100) + '%';
    try { await processReturnForReq(r, qty); ok++; }
    catch (e) { fail++; toast('❌ ' + r.PartId + ': ' + e.message, 'error', 7000); }
    await new Promise(res => setTimeout(res, 200));
  }
  bar.style.width = '100%';
  lbl.textContent = 'Return complete — ' + ok + ' returned' + (fail ? ' | ' + fail + ' failed' : '');
  toast(fail ? ('⚠ ' + ok + ' returned, ' + fail + ' failed') : ('✅ Returned all ' + ok + ' issued parts'), fail ? 'error' : 'success', 6000);
  if (btn) { btn.disabled = false; btn.textContent = '↩ RETURN ALL TO STOCK'; }
  setTimeout(() => prog.classList.add('hidden'), 4000);
  await loadParts();
}


// ============================================================
//  PART DEMAND SEARCH — search machines/WOs by Part ID
// ============================================================

function normalizePart(v) {
  return String(v || '').trim().toUpperCase();
}

function parseWOList(text) {
  return Array.from(new Set(String(text || '')
    .split(/[\n,;\t ]+/)
    .map(x => x.trim().toUpperCase())
    .filter(Boolean)));
}

function getDemandScanLimit() {
  const el = document.getElementById('dmLimit');
  const n = parseInt(el ? el.value : DEFAULT_DEMAND_SCAN_LIMIT, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DEMAND_SCAN_LIMIT;
  return Math.min(n, 500);
}

function woSortScore(wo) {
  const digits = String(wo || '').replace(/\D/g, '');
  return digits ? parseInt(digits, 10) : -1;
}

function newestWOFirst(wos) {
  return Array.from(new Set((wos || []).map(x => String(x).trim().toUpperCase()).filter(Boolean)))
    .sort((a, b) => {
      const sa = woSortScore(a), sb = woSortScore(b);
      if (sb !== sa) return sb - sa;
      return String(b).localeCompare(String(a), undefined, { numeric: true, sensitivity: 'base' });
    });
}

function extractWOId(row) {
  if (row == null) return '';
  if (typeof row === 'string' || typeof row === 'number') return String(row).trim().toUpperCase();
  const keys = ['WOId','WoId','woId','WOID','WorkOrder','workOrder','WorkOrderId','workOrderId','Machine','machine','OrderId','orderId'];
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && String(row[k]).trim()) return String(row[k]).trim().toUpperCase();
  }
  for (const [k, v] of Object.entries(row)) {
    if (/wo|work.?order|machine/i.test(k) && v !== null && v !== undefined && String(v).trim()) return String(v).trim().toUpperCase();
  }
  return '';
}

function statusTokensFromObject(obj) {
  if (!obj || typeof obj !== 'object') return [];
  const tokens = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    const key = String(k).toLowerCase();
    if (/(status|state|release|released|firm|closed|cancel|complete|posted|hold)/i.test(k)) {
      tokens.push((k + ':' + String(v)).toLowerCase());
      if (typeof v === 'boolean') tokens.push((k + ':' + (v ? 'true' : 'false')).toLowerCase());
    }
  }
  return tokens;
}

function classifyWOStatus(obj) {
  const tokens = statusTokensFromObject(obj);
  if (!tokens.length) return { kind: 'unknown', text: '' };
  const txt = tokens.join(' | ');

  // Hard exclusions first.
  if (/cancelled|canceled|cancel|closed|complete|completed|unreleased|un.?released|not.?released/.test(txt)) {
    return { kind: 'inactive', text: txt };
  }
  // Common boolean field patterns.
  if (/(isreleased|released|release):false/.test(txt)) return { kind: 'inactive', text: txt };
  if (/(isclosed|closed):true/.test(txt)) return { kind: 'inactive', text: txt };
  if (/(iscancelled|iscanceled|cancelled|canceled):true/.test(txt)) return { kind: 'inactive', text: txt };

  // Active states.  Values F/R are common shortcuts for Firm/Released.
  if (/firm|released|release:true|isreleased:true|status:f\b|status:r\b|status:firm\b|status:released\b/.test(txt)) {
    return { kind: 'active', text: txt };
  }
  return { kind: 'unknown', text: txt };
}

function toWORecords(data) {
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const row of data) {
    const id = extractWOId(row);
    if (id) out.push({ id, raw: row, status: classifyWOStatus(row) });
  }
  return out;
}

function filterWOCandidates(records, sourceLabel) {
  const unique = new Map();
  for (const r of records || []) {
    if (!r || !r.id) continue;
    const id = String(r.id).trim().toUpperCase();
    if (!id) continue;
    const st = r.status || classifyWOStatus(r.raw);
    // If RF Plus gives a clear inactive status, exclude immediately.
    if (st.kind === 'inactive') continue;
    // Active and unknown are kept here; unknown may be decided after exact GetWOs(WOId) returns sub/status details.
    if (!unique.has(id)) unique.set(id, { id, raw: r.raw, status: st, source: sourceLabel || 'rf' });
  }
  return newestWOFirst(Array.from(unique.keys())).map(id => unique.get(id));
}

function limitWORecordsForDemandScan(records) {
  const limit = getDemandScanLimit();
  const sortedIds = newestWOFirst((records || []).map(r => r.id));
  const byId = new Map((records || []).map(r => [r.id, r]));
  return { scanRecords: sortedIds.slice(0, limit).map(id => byId.get(id)).filter(Boolean), totalWos: sortedIds.length, limit };
}

function setDemandProgress(show, label, pct) {
  const p = document.getElementById('dmProgress');
  const l = document.getElementById('dmPLbl');
  const b = document.getElementById('dmPBar');
  if (!p || !l || !b) return;
  p.classList.toggle('hidden', !show);
  l.textContent = label || '';
  b.style.width = Math.max(0, Math.min(100, pct || 0)) + '%';
}

function clearDemandResults() {
  S.dm = [];
  S.dmIssued = [];
  S.dmCandidateCount = 0;
  S.dmRawCount = 0;
  S.dmActiveCount = 0;
  S.dmPerf = null;
  document.getElementById('dmTb').innerHTML = '';
  document.getElementById('dmPanel').classList.add('hidden');
  const issuedPanel = document.getElementById('dmIssuedPanel');
  if (issuedPanel) issuedPanel.classList.add('hidden');
  const issuedTb = document.getElementById('dmIssuedTb');
  if (issuedTb) issuedTb.innerHTML = '';
  const issuedSummary = document.getElementById('dmIssuedSummary');
  if (issuedSummary) issuedSummary.textContent = '';
  document.getElementById('dmSummary').textContent = '';
  document.getElementById('dmMeta').textContent = '';
  setDemandProgress(false);
}

function clearActiveWOCache() {
  demandActiveWOCache = null;
  demandReqCache.clear();
  demandPartResultCache.clear();
  toast('Active WO, demand, and return cache cleared', 'info');
}

async function tryLoadWOListFromRFPlus() {
  const now = Date.now();
  if (demandActiveWOCache && (now - demandActiveWOCache.time) < DEMAND_REQ_CACHE_TTL_MS) {
    return Object.assign({ fromCache: true }, demandActiveWOCache);
  }

  // Keep this conservative: RF Plus has different builds, and some bodies are ignored by the API.
  // We try likely active filters first, then fall back to the plain list and filter client-side.
  const attempts = [
    { body: { WOId: '', IsIssuingReturn: false, Status: 'Released' }, label: 'RF Released' },
    { body: { WOId: '', IsIssuingReturn: false, Status: 'Firm' }, label: 'RF Firm' },
    { body: { WOId: '', IsIssuingReturn: false, ReleasedOnly: true }, label: 'RF ReleasedOnly' },
    { body: { WOId: '', IsIssuingReturn: false }, label: 'RF all' },
    { body: { WOId: null, IsIssuingReturn: false }, label: 'RF null WO' },
    { body: { IsIssuingReturn: false }, label: 'RF no WO' }
  ];

  let allRecords = [];
  let rawCount = 0;
  for (const a of attempts) {
    try {
      const data = await api('/api/issuing/GetWOs', a.body);
      const records = toWORecords(data);
      if (records.length) {
        rawCount += records.length;
        allRecords.push(...records.map(r => Object.assign({}, r, { source: a.label })));
        // If the attempted filter clearly returned active rows, we can stop early.
        const activeCount = records.filter(r => r.status.kind === 'active').length;
        if (a.label !== 'RF all' && activeCount > 0) break;
      }
    } catch (e) {}
  }

  // De-duplicate and remove closed/cancelled/unreleased if RF Plus exposed those status fields.
  const filtered = filterWOCandidates(allRecords, 'rf');
  const result = { time: now, records: filtered, rawCount: allRecords.length || rawCount, activeCount: filtered.length };
  demandActiveWOCache = result;
  return Object.assign({ fromCache: false }, result);
}

function getActiveSubRecords(subs) {
  const records = toWORecords((subs || []).map(s => Object.assign({}, s, { WOId: extractWOId(s) || s.WOId || s.WoId })));
  if (!Array.isArray(subs) || !subs.length) return [];

  // If sub rows expose statuses, use them. If no status is exposed, keep them so QX 1 behavior still works.
  const statuses = (subs || []).map(classifyWOStatus);
  const hasKnown = statuses.some(s => s.kind !== 'unknown');
  if (!hasKnown) return subs;
  return subs.filter(s => classifyWOStatus(s).kind === 'active');
}

function reqCacheKey(wo, lot, split, subId) {
  return [wo, lot, split, subId, whs].map(x => String(x ?? '')).join('|');
}

function invalidateRequirementCacheForWO(wo) {
  const prefix = String(wo || '').toUpperCase() + '|';
  for (const k of Array.from(demandReqCache.keys())) {
    if (k.startsWith(prefix)) demandReqCache.delete(k);
  }
}

function invalidateDemandPartCacheForPart(partId) {
  const prefix = normalizePart(partId) + '|';
  for (const k of Array.from(demandPartResultCache.keys())) {
    if (String(k).startsWith(prefix)) demandPartResultCache.delete(k);
  }
}

async function getRequirementsCached(wo, lot, split, subId) {
  const key = reqCacheKey(wo, lot, split, subId);
  const now = Date.now();
  const cached = demandReqCache.get(key);
  if (cached && (now - cached.time) < DEMAND_REQ_CACHE_TTL_MS) return cached.data;
  const data = await api('/api/issuing/validateWorkOrderAndGetRequirementsList', {
    WOId: wo, LotId: lot, SplitId: split, SubId: subId, WarehouseId: whs
  });
  demandReqCache.set(key, { time: now, data });
  return data;
}

async function mapLimit(items, limit, worker, onDone) {
  const arr = Array.from(items || []);
  const results = new Array(arr.length);
  let next = 0;
  let done = 0;
  const runners = Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (next < arr.length) {
      const idx = next++;
      try { results[idx] = { status: 'fulfilled', value: await worker(arr[idx], idx) }; }
      catch (e) { results[idx] = { status: 'rejected', reason: e }; }
      done++;
      if (onDone) onDone(done, arr.length, arr[idx], results[idx]);
    }
  });
  await Promise.all(runners);
  return results;
}

async function getDemandAndReturnMatchesForWO(wo, targetPart) {
  const demand = [];
  const issued = [];
  const subsRaw = await api('/api/issuing/GetWOs', { WOId: wo, IsIssuingReturn: false });
  if (!Array.isArray(subsRaw) || !subsRaw.length) return { demand, issued };

  const subs = getActiveSubRecords(subsRaw);
  if (!subs.length) return { demand, issued };

  const results = await mapLimit(subs, DEMAND_SUB_CONCURRENCY, async sub => {
    const lot = sub.LotId;
    const split = sub.SplitId;
    const subId = sub.SubId;
    const d = await getRequirementsCached(wo, lot, split, subId);
    const reqs = d && Array.isArray(d.Requirements) ? d.Requirements : [];
    const localDemand = [];
    const localIssued = [];
    for (const r of reqs) {
      if (normalizePart(r.PartId) !== targetPart) continue;
      const reqQty = Number(r.CalculatedQty || 0);
      const issuedQty = Number(r.IssuedQty || 0);
      const need = reqQty - issuedQty;
      const base = {
        WOId: wo, LotId: lot, SplitId: split, SubId: subId,
        PartId: r.PartId, Desc: r.Desc, Uom: r.Uom,
        CalculatedQty: reqQty, IssuedQty: issuedQty, NeedQty: Math.max(0, need),
        InvPartQty: Number(r.InvPartQty || 0), PartPrimaryLocID: r.PartPrimaryLocID || '',
        SeqNo: r.SeqNo, PieceNo: r.PieceNo
      };
      if (need > 0) localDemand.push(base);
      if (issuedQty > 0) localIssued.push(Object.assign({}, base, { ReturnQty: issuedQty }));
    }
    return { demand: localDemand, issued: localIssued };
  });

  results.forEach(res => {
    if (res.status === 'fulfilled' && res.value) {
      if (Array.isArray(res.value.demand)) demand.push(...res.value.demand);
      if (Array.isArray(res.value.issued)) issued.push(...res.value.issued);
    }
  });
  return { demand, issued };
}

function demandPartCacheKey(part, records) {
  const limit = getDemandScanLimit();
  const wos = (records || []).map(r => r.id).join(',');
  return [part, limit, wos].join('|');
}

async function searchPartDemands() {
  const part = normalizePart(document.getElementById('dmPart').value);
  if (!part) { toast('Enter a part number first', 'error'); return; }
  clearDemandResults();
  switchTab('partDemand');

  const t0 = performance.now();
  let records = [];
  const pasted = parseWOList(document.getElementById('dmWos').value);
  if (pasted.length) {
    records = pasted.map(id => ({ id, raw: { WOId: id }, status: { kind: 'unknown', text: '' }, source: 'pasted' }));
    records = filterWOCandidates(records, 'pasted');
    S.dmRawCount = pasted.length;
    S.dmActiveCount = records.length;
  } else {
    document.getElementById('dmMeta').textContent = 'Loading RF Plus active WO list...';
    setDemandProgress(true, 'Loading RF Plus active Firm/Released WO list...', 5);
    const loaded = await tryLoadWOListFromRFPlus();
    records = loaded.records || [];
    S.dmRawCount = loaded.rawCount || 0;
    S.dmActiveCount = loaded.activeCount || records.length;
    if (loaded.fromCache) toast('Using cached active WO list', 'info', 2500);
  }

  if (!records.length) {
    setDemandProgress(false);
    document.getElementById('dmMeta').textContent = 'No active Firm/Released Work Orders found.';
    document.getElementById('dmTb').innerHTML = '<tr><td colspan="13" class="empty">No active Firm/Released WOs found. Paste an active WO list above if RF Plus does not expose the full list.</td></tr>';
    document.getElementById('dmPanel').classList.remove('hidden');
    return;
  }

  const limited = limitWORecordsForDemandScan(records);
  const scanRecords = limited.scanRecords;
  const originalCount = limited.totalWos;
  if (!scanRecords.length) {
    setDemandProgress(false);
    document.getElementById('dmMeta').textContent = 'No Work Orders passed filters.';
    return;
  }

  S.dmWos = scanRecords.map(r => r.id);
  S.dmCandidateCount = originalCount;

  const cacheKey = demandPartCacheKey(part, scanRecords);
  const now = Date.now();
  const cachedResult = demandPartResultCache.get(cacheKey);
  if (cachedResult && (now - cachedResult.time) < DEMAND_REQ_CACHE_TTL_MS) {
    S.dm = cachedResult.demand.slice();
    S.dmIssued = cachedResult.issued.slice();
    S.dmPerf = Object.assign({}, cachedResult.perf, { fromPartCache: true });
    renderDemandResults(S.dm, part, scanRecords.length);
    renderIssuedReturnResults(S.dmIssued, part);
    document.getElementById('dmMeta').textContent = 'Instant from unified part cache · scanned ' + scanRecords.length + ' WO(s) · Demand ' + S.dm.length + ' · Returnable ' + S.dmIssued.length;
    setDemandProgress(false);
    return;
  }

  const allDemand = [];
  const allIssued = [];
  const limitNote = originalCount > scanRecords.length
    ? 'Scanning newest ' + scanRecords.length + ' of ' + originalCount + ' active WO(s)...'
    : 'Scanning ' + scanRecords.length + ' active WO(s)...';
  document.getElementById('dmMeta').textContent = limitNote + ' · one scan builds demand + return · concurrency ' + DEMAND_SCAN_CONCURRENCY;

  await mapLimit(scanRecords, DEMAND_SCAN_CONCURRENCY, async rec => {
    return await getDemandAndReturnMatchesForWO(rec.id, part);
  }, (done, total, rec, res) => {
    if (res.status === 'fulfilled' && res.value) {
      if (Array.isArray(res.value.demand)) allDemand.push(...res.value.demand);
      if (Array.isArray(res.value.issued)) allIssued.push(...res.value.issued);
    }
    setDemandProgress(true, '(' + done + '/' + total + ') Checked ' + rec.id + ' for demand + issued ' + part, Math.round((done / total) * 100));
  });

  setDemandProgress(true, 'Unified search complete', 100);
  setTimeout(() => setDemandProgress(false), 1500);
  S.dm = allDemand;
  S.dmIssued = allIssued;
  S.dmPerf = {
    ms: Math.round(performance.now() - t0),
    raw: S.dmRawCount,
    active: originalCount,
    scanned: scanRecords.length,
    cacheSize: demandReqCache.size,
    unified: true
  };
  demandPartResultCache.set(cacheKey, { time: Date.now(), demand: allDemand.slice(), issued: allIssued.slice(), perf: S.dmPerf });
  renderDemandResults(allDemand, part, scanRecords.length);
  renderIssuedReturnResults(allIssued, part);
}


function displayedDemandWOIds() {
  const ids = new Set();
  (S.dm || []).forEach(r => { if (r && r.WOId) ids.add(String(r.WOId).trim().toUpperCase()); });
  (S.dmIssued || []).forEach(r => { if (r && r.WOId) ids.add(String(r.WOId).trim().toUpperCase()); });
  return newestWOFirst(Array.from(ids));
}

async function refreshVisibleDemandResults() {
  const part = normalizePart(document.getElementById('dmPart').value);
  if (!part) { toast('Enter/search a part number first', 'error'); return; }
  const woIds = displayedDemandWOIds();
  if (!woIds.length) { toast('No displayed Work Orders to refresh', 'info'); return; }

  const btn = document.getElementById('dmRefreshResultsBtn');
  const oldTxt = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Refreshing...'; }

  const t0 = performance.now();
  setDemandProgress(true, 'Refreshing ' + woIds.length + ' displayed WO(s) only...', 5);
  try {
    // Important: keep the active WO cache. Only invalidate requirements for WOs on screen.
    woIds.forEach(invalidateRequirementCacheForWO);
    demandPartResultCache.clear();

    const records = woIds.map(id => ({ id, raw: { WOId: id }, status: { kind: 'unknown', text: '' }, source: 'visible-refresh' }));
    const allDemand = [];
    const allIssued = [];

    await mapLimit(records, Math.min(DEMAND_SCAN_CONCURRENCY, Math.max(1, records.length)), async rec => {
      return await getDemandAndReturnMatchesForWO(rec.id, part);
    }, (done, total, rec, res) => {
      if (res.status === 'fulfilled' && res.value) {
        if (Array.isArray(res.value.demand)) allDemand.push(...res.value.demand);
        if (Array.isArray(res.value.issued)) allIssued.push(...res.value.issued);
      }
      setDemandProgress(true, '(' + done + '/' + total + ') Refreshed ' + rec.id, Math.round((done / total) * 100));
    });

    S.dm = allDemand;
    S.dmIssued = allIssued;
    S.dmWos = woIds;
    S.dmPerf = {
      ms: Math.round(performance.now() - t0),
      raw: S.dmRawCount || woIds.length,
      active: S.dmActiveCount || woIds.length,
      scanned: woIds.length,
      cacheSize: demandReqCache.size,
      unified: true,
      refreshedVisibleOnly: true
    };

    renderDemandResults(S.dm, part, woIds.length);
    renderIssuedReturnResults(S.dmIssued, part);
    document.getElementById('dmMeta').textContent = 'Refreshed displayed WOs only · ' + woIds.length + ' WO(s) · Demand ' + S.dm.length + ' · Returnable ' + S.dmIssued.length + ' · ' + (S.dmPerf.ms / 1000).toFixed(1) + 's';
    toast('✅ Refreshed ' + woIds.length + ' displayed WO(s)', 'success', 3500);
    setDemandProgress(true, 'Refresh complete', 100);
    setTimeout(() => setDemandProgress(false), 1200);
  } catch (e) {
    setDemandProgress(false);
    toast('Refresh failed: ' + e.message, 'error', 8000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = oldTxt || '🔄 Refresh'; }
  }
}

function renderDemandResults(rows, part, scannedCount) {
  let issuable = 0;
  const html = rows.map((r, i) => {
    const need = Number(r.NeedQty || 0);
    const stock = Number(r.InvPartQty || 0);
    const loc = String(r.PartPrimaryLocID || '');
    const canIssue = need > 0 && stock > 0 && loc && loc !== 'QMIL';
    const qty = Math.max(0, Math.min(need, stock || need));
    if (canIssue) issuable++;
    const status = canIssue
      ? (stock >= need ? '<span class="badge b-ready">READY</span>' : '<span class="badge b-low">LOW STOCK</span>')
      : '<span class="badge b-block">NO STOCK/LOC</span>';
    return `<tr id="dmr${i}">
      <td style="text-align:center"><input class="dm-check" type="checkbox" data-demand-check="${i}" ${canIssue ? 'checked' : 'disabled'}></td>
      <td class="dm-action-cell"><span class="dm-action-buttons"><button class="btn btn-success btn-xs dm-issue-btn" data-demand-issue="${i}" ${canIssue ? '' : 'disabled'}>ISSUE</button><button class="btn btn-print btn-xs dm-label-btn" data-demand-print="${i}">LABEL</button></span></td>
      <td class="mono"><b style="color:var(--primary)">${esc(r.WOId)}</b></td>
      <td style="text-align:center">${esc(r.SubId)}</td>
      <td><b class="qx-part">${esc(r.PartId)}</b></td>
      <td class="mono dm-location-cell">${loc ? esc(loc) : '<span class="dim">—</span>'}</td>
      <td style="text-align:center"><input class="dm-qty" id="dmq${i}" type="number" min="1" max="${esc(need)}" value="${esc(qty)}" ${canIssue ? '' : 'disabled'}></td>
      <td style="text-align:center;font-weight:700">${esc(need)}</td>
      <td style="text-align:center;color:${stock > 0 ? 'var(--success)' : 'var(--danger)'};font-weight:700">${esc(stock)}</td>
      <td>${status}</td>
      <td class="dm-desc" title="${esc(r.Desc)}">${esc(r.Desc)}</td>
      <td style="text-align:center;font-weight:600">${esc(r.CalculatedQty)} <span class="dim">${esc(r.Uom)}</span></td>
      <td style="text-align:center">${esc(r.IssuedQty)}</td>
    </tr>`;
  }).join('');

  document.getElementById('dmTb').innerHTML = html || '<tr><td colspan="13" class="empty">No open demand found for ' + esc(part) + ' in the active scanned WO list.</td></tr>';
  document.getElementById('dmPanel').classList.remove('hidden');
  document.getElementById('dmSummary').textContent = rows.length + ' demand(s), ' + issuable + ' issuable';
  const perf = S.dmPerf;
  const scannedText = perf
    ? 'Raw ' + perf.raw + ' → active/long ' + perf.active + ' → scanned ' + perf.scanned + ' · ' + (perf.ms / 1000).toFixed(1) + 's · cache ' + perf.cacheSize
    : 'Scanned ' + scannedCount + ' WO(s)';
  document.getElementById('dmMeta').textContent = scannedText + ' · Found ' + rows.length + ' demand(s)';
  document.getElementById('dmIssueSelectedBtn').disabled = issuable === 0;
}


function renderIssuedReturnResults(rows, part) {
  const panel = document.getElementById('dmIssuedPanel');
  const tb = document.getElementById('dmIssuedTb');
  const summary = document.getElementById('dmIssuedSummary');
  if (!panel || !tb) return;
  const html = (rows || []).map((r, i) => {
    const issuedQty = Math.max(0, Number(r.IssuedQty || r.ReturnQty || 0));
    const loc = String(r.PartPrimaryLocID || '');
    return `<tr id="dmret${i}">
      <td class="dm-action-cell"><span class="dm-action-buttons"><button class="btn btn-danger btn-xs dm-return-btn" data-demand-return="${i}">↩ RETURN</button></span></td>
      <td class="mono"><b style="color:var(--primary)">${esc(r.WOId)}</b></td>
      <td style="text-align:center">${esc(r.SubId)}</td>
      <td><b class="qx-part">${esc(r.PartId)}</b></td>
      <td class="mono dm-location-cell">${loc ? esc(loc) : '<span class="dim">auto</span>'}</td>
      <td style="text-align:center"><input class="dm-qty dm-return-qty" id="dmretq${i}" type="number" min="1" max="${esc(issuedQty)}" value="${esc(issuedQty)}"></td>
      <td style="text-align:center;color:var(--success);font-weight:700">${esc(issuedQty)}</td>
      <td class="dm-desc" title="${esc(r.Desc)}">${esc(r.Desc)}</td>
      <td style="text-align:center;font-weight:600">${esc(r.CalculatedQty)} <span class="dim">${esc(r.Uom)}</span></td>
    </tr>`;
  }).join('');
  tb.innerHTML = html || '<tr><td colspan="9" class="empty">No issued/returnable rows found for ' + esc(part) + ' in this same scan.</td></tr>';
  panel.classList.remove('hidden');
  if (summary) summary.textContent = (rows || []).length + ' returnable row(s)';
}

async function returnDemandIssued(i) {
  const r = S.dmIssued && S.dmIssued[i];
  if (!r) return;
  const qi = document.getElementById('dmretq' + i);
  const qty = parseFloat(qi ? qi.value : '0');
  if (!qty || qty <= 0) { toast('Enter valid return qty', 'error'); return; }
  if (qty > Number(r.IssuedQty || 0)) { toast('Return qty cannot be more than issued qty', 'error'); return; }
  const row = document.getElementById('dmret' + i);
  const btn = row ? row.querySelector('[data-demand-return]') : null;
  if (btn) { btn.disabled = true; btn.textContent = 'Returning...'; }
  try {
    await processReturnForReq(r, qty);
    toast('✅ Returned ' + r.PartId + ' × ' + qty + ' from ' + r.WOId + ' Sub ' + r.SubId, 'success', 5000);
    invalidateRequirementCacheForWO(r.WOId);
    demandPartResultCache.clear();
    r.IssuedQty = Math.max(0, Number(r.IssuedQty || 0) - qty);
    if (r.IssuedQty <= 0) S.dmIssued.splice(i, 1);
    renderIssuedReturnResults(S.dmIssued, normalizePart(document.getElementById('dmPart').value));
  } catch (e) {
    toast('❌ Return failed: ' + e.message, 'error', 8000);
    if (btn) { btn.disabled = false; btn.textContent = '↩ RETURN'; }
  }
}

async function issueDemand(i) {
  const r = S.dm[i];
  if (!r) return false;
  const qi = document.getElementById('dmq' + i);
  const qty = parseFloat(qi ? qi.value : '0');
  if (!qty || qty <= 0) { toast('Enter valid issue qty', 'error'); return false; }
  const row = document.getElementById('dmr' + i);
  const btn = row ? row.querySelector('[data-demand-issue]') : null;
  if (btn) { btn.disabled = true; btn.textContent = 'Issuing...'; }
  try {
    await api('/api/issuing/processIssuing', {
      WOId: r.WOId, lotId: r.LotId, splitId: r.SplitId, subId: r.SubId,
      PartId: r.PartId, seqNo: r.SeqNo, pieceNo: r.PieceNo,
      traceId: null, traceList: null, locationId: r.PartPrimaryLocID, warehouseId: whs,
      TransactionDate: '', qty: qty,
      pieceTrackingPieces: null,
      pieceTrackingProperty: { length: null, width: null, height: null },
      Shift: null, Seq: null, Reason: '', Comments: ''
    });
    if (autoPrintAfterIssue()) {
      try { await printIssueLabel(reqToPrintLabel(r, qty), { silent: true }); }
      catch (pe) { toast('⚠ Issued, but label failed: ' + pe.message, 'error', 9000); }
    }
    toast('✅ Issued ' + r.PartId + ' × ' + qty + ' to ' + r.WOId + ' Sub ' + r.SubId, 'success', 5000);
    invalidateRequirementCacheForWO(r.WOId);
    demandPartResultCache.clear();
    r.IssuedQty = Number(r.IssuedQty || 0) + qty;
    r.NeedQty = Math.max(0, Number(r.CalculatedQty || 0) - Number(r.IssuedQty || 0));
    if (r.NeedQty <= 0) S.dm.splice(i, 1);
    renderDemandResults(S.dm, normalizePart(document.getElementById('dmPart').value), S.dmWos.length);
    return true;
  } catch (e) {
    toast('❌ ' + r.WOId + ' Sub ' + r.SubId + ': ' + e.message, 'error', 7000);
    if (btn) { btn.disabled = false; btn.textContent = 'ISSUE'; }
    return false;
  }
}

async function issueSelectedDemands() {
  const indexes = Array.from(document.querySelectorAll('[data-demand-check]:checked'))
    .map(c => Number(c.dataset.demandCheck))
    .filter(n => Number.isFinite(n))
    .sort((a, b) => b - a); // process high-to-low so row removal does not shift remaining indexes
  if (!indexes.length) { toast('No demand rows selected', 'info'); return; }
  const btn = document.getElementById('dmIssueSelectedBtn');
  btn.disabled = true;
  let ok = 0, fail = 0;
  for (let x = 0; x < indexes.length; x++) {
    const i = indexes[x];
    setDemandProgress(true, '(' + (x + 1) + '/' + indexes.length + ') Issuing selected demand...', Math.round((x / indexes.length) * 100));
    try { if (await issueDemand(i)) ok++; else fail++; }
    catch (e) { fail++; }
    await new Promise(res => setTimeout(res, 120));
  }
  setDemandProgress(true, 'Issue selected complete', 100);
  setTimeout(() => setDemandProgress(false), 1500);
  btn.disabled = false;
  if (fail) toast('⚠ ' + ok + ' issued, ' + fail + ' failed', 'error', 6000);
}

function selectIssuableDemandRows() {
  document.querySelectorAll('[data-demand-check]').forEach(c => { if (!c.disabled) c.checked = true; });
}



// ============================================================
//  PART LOOKUP — SQL Bridge read, RF Plus issue
// ============================================================
function plNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function plFmt(v) {
  const n = plNum(v);
  if (Math.abs(n - Math.round(n)) < 0.000001) return String(Math.round(n));
  return n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}
function plDate(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v).trim();
  const ms = s.match(/\/Date\((\d+)(?:[+-]\d+)?\)\//);
  let d = null;
  if (ms) d = new Date(Number(ms[1]));
  else if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  else {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) d = new Date(t);
  }
  if (!d || Number.isNaN(d.getTime())) return s;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function plSetProgress(show, msg) {
  const p = document.getElementById('plProgress');
  const t = document.getElementById('plProgressText');
  if (p) p.classList.toggle('hidden', !show);
  if (t && msg) t.textContent = msg;
}
function plSetBridgeStatus(txt, type) {
  const el = document.getElementById('plBridgeStatus');
  if (!el) return;
  el.textContent = txt;
  el.className = 'dim pl-bridge ' + (type || '');
}
async function checkPartLookupBridge() {
  const btn = document.getElementById('plHealthBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking...'; }
  try {
    const res = await fetch(SQL_BRIDGE + '/api/health', { method: 'GET' });
    const j = await res.json();
    if (!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
    plSetBridgeStatus('Bridge: connected to ' + (j.server || 'VISUAL SQL') + ' / ' + (j.database || 'QM'), 'ok');
    toast('✅ SQL Bridge connected', 'success', 2500);
    return true;
  } catch (e) {
    plSetBridgeStatus('Bridge: not running', 'bad');
    toast('SQL Bridge not reachable. Start the QX 1.5 Beta SQL Bridge first.', 'error', 7000);
    return false;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Check Bridge'; }
  }
}
async function fetchPartLookup(partId) {
  const url = SQL_BRIDGE + '/api/partlookup?partId=' + encodeURIComponent(partId);
  try {
    const res = await fetch(url, { method: 'GET', cache: 'no-store' });
    let j;
    try { j = await res.json(); }
    catch (e) { throw new Error('SQL Bridge returned invalid response'); }
    if (!res.ok || !j.ok) throw new Error(j.error || ('SQL Bridge HTTP ' + res.status));
    if (window.QXStatus) window.QXStatus.bridgeUp();
    return j;
  } catch (e) {
    if (window.QXStatus) window.QXStatus.bridgeDown();
    throw e;
  }
}
function clearPartLookup() {
  S.pl = null; S.plPart = null;
  const p = document.getElementById('plPart'); if (p) p.value = '';
  const meta = document.getElementById('plMeta'); if (meta) meta.textContent = '';
  ['plSummaryPanel','plPartPanel','plStockPanel','plDemandPanel','plPoPanel','plIssuedPanel','plProgress'].forEach(id => {
    const el = document.getElementById(id); if (el) el.classList.add('hidden');
  });
  ['plPartInfo','plDemandHost','plStockTb','plPoTb','plIssuedTb'].forEach(id => {
    const el = document.getElementById(id); if (el) el.innerHTML = '';
  });
  if (typeof QXActiveDemand !== 'undefined') QXActiveDemand.clear('partLookup');
}
async function lookupPartLookup(forcePart) {
  const input = document.getElementById('plPart');
  const part = normalizePart(forcePart || (input ? input.value : ''));
  if (!part) { toast('Enter a Part ID', 'error'); return; }
  if (input) input.value = part;
  const btn = document.getElementById('plLookupBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }
  plSetProgress(true, 'Loading SQL data for ' + part + '...');
  const meta = document.getElementById('plMeta'); if (meta) meta.textContent = '';
  try {
    const data = await fetchPartLookup(part);
    S.pl = data;
    S.plPart = part;
    plSetBridgeStatus('Bridge: connected', 'ok');
    renderPartLookup(data);
    if (meta) meta.textContent = 'Loaded ' + part + ' · Bridge ' + (data.bridgeVersion || 'old/unknown') + ' · ' + (data.generatedAt || 'now');
  } catch (e) {
    toast('Part Lookup failed: ' + cleanError(e.message), 'error', 9000);
    plSetBridgeStatus('Bridge: error', 'bad');
    if (meta) meta.textContent = cleanError(e.message);
  } finally {
    plSetProgress(false);
    if (btn) { btn.disabled = false; btn.textContent = '📦 LOOKUP'; }
  }
}
function plStockRows() {
  const rows = (S.pl && Array.isArray(S.pl.stock)) ? S.pl.stock : [];
  return rows.filter(s => String(s.WAREHOUSE_ID || '').toUpperCase() === 'QMIL');
}
function plUsableStocks() {
  return plStockRows().filter(s => plNum(s.USABLE_FOR_ISSUE) === 1 && plNum(s.AVAILABLE_QTY) > 0);
}
function plCanUseStock(s) {
  return !!s && plNum(s.USABLE_FOR_ISSUE) === 1 && plNum(s.AVAILABLE_QTY) > 0;
}

// ============================================================
//  SHARED ACTIVE DEMAND COMPONENT
//  One renderer / transaction workflow used by Part Lookup and
//  PO Receiving. Reads selected-part demand/stock from the existing
//  SQL Bridge /api/partlookup endpoint; all issuing stays in RF Plus.
// ============================================================
const QXActiveDemand = (function () {
  const instances = new Map();

  function safeContext(v) { return String(v || '').replace(/[^a-zA-Z0-9_-]/g, ''); }
  function stateFor(context) {
    const key = safeContext(context);
    if (!instances.has(key)) instances.set(key, { context:key, data:null, partId:'', description:'', config:{}, requestSeq:0 });
    return instances.get(key);
  }
  function configure(context, options={}) {
    const st = stateFor(context);
    st.config = Object.assign({}, st.config, options || {});
    if (options.partId !== undefined) st.partId = normalizePart(options.partId);
    if (options.description !== undefined) st.description = String(options.description || '').trim();
    return st;
  }
  function panelFor(st) { return document.getElementById(st.config.panelId || ''); }
  function hostFor(st) { return document.getElementById(st.config.hostId || ''); }
  function summaryFor(st) { return document.getElementById(st.config.summaryId || ''); }
  function showPanel(st) {
    const panel = panelFor(st);
    if (panel) {
      panel.classList.remove('hidden');
      if (panel.tagName === 'DETAILS') panel.open = true;
    }
  }
  function selectedDescription(st) {
    if (st.description) return st.description;
    const partRows = st.data && Array.isArray(st.data.part) ? st.data.part : [];
    return partRows.length ? String(partRows[0].DESCRIPTION || '').trim() : '';
  }
  function stockRows(st) {
    const rows = st.data && Array.isArray(st.data.stock) ? st.data.stock : [];
    return rows.filter(x => String(x.WAREHOUSE_ID || '').toUpperCase() === 'QMIL');
  }
  function usableStocks(st) {
    return stockRows(st).filter(x => plNum(x.USABLE_FOR_ISSUE) === 1 && plNum(x.AVAILABLE_QTY) > 0);
  }
  function demandRows(st) {
    const rows = st.data && Array.isArray(st.data.demand) ? st.data.demand : [];
    const isActiveStatus = value => {
      const v = String(value ?? '').trim().toUpperCase();
      return !v || v === 'F' || v === 'R' || v === 'FIRM' || v === 'RELEASED';
    };
    // SQL is the authoritative filter (Firm/Released only). Keep a defensive
    // front-end filter too, so stale or alternate payloads cannot display an
    // explicitly inactive WO or requirement.
    return rows.filter(r => isActiveStatus(r.WO_STATUS ?? r.WOStatus ?? r.WorkOrderStatus)
      && isActiveStatus(r.REQ_STATUS ?? r.ReqStatus ?? r.RequirementStatus));
  }
  function setSummary(st, text) {
    const el = summaryFor(st);
    if (el) el.textContent = text || '';
  }
  function selectedHeader(st) {
    const part = st.partId || 'No Part ID';
    const desc = selectedDescription(st);
    return `<div class="ad-selected-part"><span class="ad-selected-label">Selected Part</span><span class="qx-part ad-selected-id">${esc(part)}</span>${desc ? `<span class="ad-selected-desc" title="${esc(desc)}">${esc(desc)}</span>` : ''}</div>`;
  }
  function renderMessage(st, message, kind='empty') {
    const host = hostFor(st);
    if (!host) return;
    showPanel(st);
    host.innerHTML = selectedHeader(st) + `<div class="ad-message ${kind === 'error' ? 'ad-error' : ''}">${esc(message)}</div>`;
    setSummary(st, '');
  }
  function setLoading(st, message) {
    const host = hostFor(st);
    if (!host) return;
    showPanel(st);
    host.innerHTML = selectedHeader(st) + `<div class="ad-loading"><div class="spin"></div><span>${esc(message || 'Loading active demand...')}</span></div>`;
    setSummary(st, 'Loading...');
  }
  function clear(context) {
    const st = stateFor(context);
    st.requestSeq++;
    st.data = null; st.partId = ''; st.description = ''; st.message = '';
    const host = hostFor(st); if (host) host.innerHTML = '';
    const panel = panelFor(st); if (panel) panel.classList.add('hidden');
    setSummary(st, '');
  }
  function showNoPart(context, options={}) {
    const st = configure(context, options);
    st.requestSeq++;
    st.data = null;
    st.partId = '';
    renderMessage(st, 'No Part ID is available for demand lookup.');
  }
  function render(context) {
    const st = stateFor(context);
    const host = hostFor(st);
    if (!host) return;
    showPanel(st);
    const rows = demandRows(st);
    const stocks = usableStocks(st);
    if (!st.partId) {
      renderMessage(st, 'No Part ID is available for demand lookup.');
      return;
    }
    if (!rows.length) {
      host.innerHTML = selectedHeader(st) + '<div class="ad-message">No active Firm or Released demand found for this part.</div>';
      setSummary(st, '0 active demand');
      return;
    }

    let issuable = 0;
    const body = rows.map((r, i) => {
      const remaining = Math.max(0, plNum(r.REMAINING_QTY));
      const first = stocks[0] || null;
      const canIssue = remaining > 0 && !!first;
      if (canIssue) issuable++;
      const max = first ? Math.max(1, Math.min(remaining || 1, plNum(first.AVAILABLE_QTY) || 1)) : Math.max(1, remaining || 1);
      const options = stocks.length ? stocks.map((stock, stockIndex) => {
        const loc = String(stock.LOCATION_ID || '').trim();
        const avail = plFmt(stock.AVAILABLE_QTY);
        return `<option value="${stockIndex}">${esc(loc)} · ${esc(avail)} available</option>`;
      }).join('') : '<option value="">No usable stock</option>';
      const badge = canIssue
        ? (plNum(first.AVAILABLE_QTY) >= remaining ? '<span class="badge b-ready">READY</span>' : '<span class="badge b-low">LOW STOCK</span>')
        : '<span class="badge b-block">NO USABLE STOCK</span>';
      return `<tr data-ad-row="${i}">
        <td class="ad-action-cell"><span class="dm-action-buttons"><button class="btn btn-success qx-action-btn ad-issue-btn" data-ad-issue="${i}" data-ad-context="${esc(st.context)}" ${canIssue ? '' : 'disabled'}>ISSUE</button><button class="btn btn-print qx-action-btn ad-label-btn" data-ad-label="${i}" data-ad-context="${esc(st.context)}">LABEL</button></span></td>
        <td class="mono ad-wo ad-wo-cell" data-label="Machine / WO"><b>${esc(r.WORKORDER_BASE_ID || '')}</b></td>
        <td class="ad-center ad-sub-cell" data-label="Sub">${esc(r.WORKORDER_SUB_ID ?? '')}</td>
        <td class="ad-loc-cell" data-label="Actual Location"><select class="ad-loc-select" data-ad-loc="${i}" data-ad-context="${esc(st.context)}" ${stocks.length ? '' : 'disabled'}>${options}</select></td>
        <td class="ad-center ad-available ad-avail-cell" data-label="Available" data-ad-avail="${i}">${first ? esc(plFmt(first.AVAILABLE_QTY)) : '0'}</td>
        <td class="ad-center ad-qty-cell qx-qty-cell" data-label="Issue Qty"><input class="ad-qty" data-ad-qty="${i}" data-ad-context="${esc(st.context)}" type="number" min="1" max="${esc(max)}" value="${esc(max)}" ${canIssue ? '' : 'disabled'}></td>
        <td class="ad-center ad-remaining ad-remain-cell" data-label="Remaining">${esc(plFmt(remaining))}</td>
        <td class="ad-center ad-required-cell" data-label="Required">${esc(plFmt(r.CALC_QTY))}</td>
        <td class="ad-center ad-issued-cell" data-label="Issued">${esc(plFmt(r.ISSUED_QTY))}</td>
        <td class="ad-status-cell qx-status-cell" data-label="Status" data-ad-status="${i}">${badge}</td>
        <td class="ad-desc qx-description-cell" data-label="Description" title="${esc(r.DESCRIPTION || '')}">${esc(r.DESCRIPTION || '')}</td>
      </tr>`;
    }).join('');

    host.innerHTML = selectedHeader(st) + `<div class="ad-table-wrap qx-responsive-table-wrap"><table class="ad-table qx-responsive-table"><colgroup><col class="ad-col-action"><col class="ad-col-wo"><col class="ad-col-sub"><col class="ad-col-location"><col class="ad-col-number"><col class="ad-col-qty"><col class="ad-col-number"><col class="ad-col-number"><col class="ad-col-number"><col class="ad-col-status"><col class="ad-col-description"></colgroup><thead><tr>
      <th data-short="Action">Action</th><th data-short="WO">Machine / WO</th><th class="ad-center" data-short="Sub">Sub</th><th data-short="Location">Actual Location</th><th class="ad-center" data-short="Avail">Available</th><th class="ad-center" data-short="Qty">Issue Qty</th><th class="ad-center" data-short="Remain">Remaining</th><th class="ad-center" data-short="Req">Required</th><th class="ad-center" data-short="Issued">Issued</th><th data-short="Status">Status</th><th data-short="Desc">Description</th>
    </tr></thead><tbody>${body}</tbody></table></div>`;
    setSummary(st, rows.length + ' active demand(s), ' + issuable + ' issuable');
  }
  function setData(context, options={}) {
    const st = configure(context, options);
    st.data = options.data || st.data || {};
    if (!st.partId) st.partId = normalizePart(st.data.partId || '');
    if (!st.description) st.description = selectedDescription(st);
    render(context);
    return st;
  }
  async function load(context, options={}) {
    const st = configure(context, options);
    if (!st.partId) {
      showNoPart(context, options);
      return null;
    }
    const requestedPart = st.partId;
    const requestId = ++st.requestSeq;
    setLoading(st, 'Loading active Firm and Released demand for ' + requestedPart + '...');
    try {
      const data = await fetchPartLookup(requestedPart);
      if (requestId !== st.requestSeq || st.partId !== requestedPart) return null;
      st.data = data;
      if (!st.description) st.description = selectedDescription(st);
      render(context);
      return data;
    } catch (e) {
      if (requestId !== st.requestSeq || st.partId !== requestedPart) return null;
      renderMessage(st, 'Active Demand lookup failed: ' + cleanError(e.message), 'error');
      toast('Active Demand lookup failed: ' + cleanError(e.message), 'error', 9000);
      return null;
    }
  }
  function selectedStock(st, i) {
    const sel = document.querySelector(`[data-ad-context="${st.context}"][data-ad-loc="${i}"]`);
    const stocks = usableStocks(st);
    const idx = sel ? Number(sel.value) : 0;
    return stocks[idx] || stocks[0] || null;
  }
  function updateRowState(context, i) {
    const st = stateFor(context);
    const row = demandRows(st)[i];
    if (!row) return;
    const stock = selectedStock(st, i);
    const remaining = Math.max(0, plNum(row.REMAINING_QTY));
    const canIssue = remaining > 0 && !!stock;
    const max = stock ? Math.max(1, Math.min(remaining || 1, plNum(stock.AVAILABLE_QTY) || 1)) : Math.max(1, remaining || 1);
    const qty = document.querySelector(`[data-ad-context="${st.context}"][data-ad-qty="${i}"]`);
    const btn = document.querySelector(`[data-ad-context="${st.context}"][data-ad-issue="${i}"]`);
    const avail = hostFor(st)?.querySelector(`[data-ad-avail="${i}"]`);
    const status = hostFor(st)?.querySelector(`[data-ad-status="${i}"]`);
    if (avail) avail.textContent = stock ? plFmt(stock.AVAILABLE_QTY) : '0';
    if (status) {
      status.innerHTML = canIssue
        ? (plNum(stock.AVAILABLE_QTY) >= remaining ? '<span class="badge b-ready">READY</span>' : '<span class="badge b-low">LOW STOCK</span>')
        : '<span class="badge b-block">NO USABLE STOCK</span>';
    }
    if (qty) {
      qty.max = String(max);
      qty.disabled = !canIssue;
      if (plNum(qty.value) > max || plNum(qty.value) <= 0) qty.value = String(max);
    }
    if (btn) btn.disabled = !canIssue;
  }
  async function refresh(context) {
    const st = stateFor(context);
    if (!st.partId) return null;
    const requestedPart = st.partId;
    const requestId = ++st.requestSeq;
    const previousHost = hostFor(st);
    if (previousHost) previousHost.classList.add('ad-refreshing');
    try {
      const data = await fetchPartLookup(requestedPart);
      if (requestId !== st.requestSeq || st.partId !== requestedPart) return null;
      st.data = data;
      if (typeof st.config.onRefreshData === 'function') {
        await st.config.onRefreshData(data, st);
      } else {
        render(context);
      }
      return data;
    } finally {
      if (requestId === st.requestSeq && previousHost) previousHost.classList.remove('ad-refreshing');
    }
  }
  async function issue(context, i) {
    const st = stateFor(context);
    const r = demandRows(st)[i];
    const stock = selectedStock(st, i);
    const qtyEl = document.querySelector(`[data-ad-context="${st.context}"][data-ad-qty="${i}"]`);
    const btn = document.querySelector(`[data-ad-context="${st.context}"][data-ad-issue="${i}"]`);
    if (!r || !stock) { toast('No usable stock location selected', 'error'); return; }
    const qty = plNum(qtyEl ? qtyEl.value : 0);
    const max = Math.min(plNum(r.REMAINING_QTY), plNum(stock.AVAILABLE_QTY));
    if (!qty || qty <= 0) { toast('Enter valid issue qty', 'error'); return; }
    if (qty > max) { toast('Issue qty is more than available or remaining demand', 'error'); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Issuing...'; }
    try {
      await api('/api/issuing/processIssuing', {
        WOId: r.WORKORDER_BASE_ID,
        lotId: r.WORKORDER_LOT_ID,
        splitId: r.WORKORDER_SPLIT_ID,
        subId: r.WORKORDER_SUB_ID,
        PartId: r.PART_ID || st.partId,
        seqNo: r.OPERATION_SEQ_NO,
        pieceNo: r.PIECE_NO,
        traceId: null,
        traceList: null,
        locationId: stock.LOCATION_ID,
        warehouseId: stock.WAREHOUSE_ID || whs,
        TransactionDate: '',
        qty: qty,
        pieceTrackingPieces: null,
        pieceTrackingProperty: { length:null, width:null, height:null },
        Shift: null,
        Seq: null,
        Reason: '',
        Comments: 'Issued from QuickX Active Demand'
      });
      toast('✅ Issued ' + (r.PART_ID || st.partId) + ' × ' + qty + ' to ' + r.WORKORDER_BASE_ID + ' Sub ' + r.WORKORDER_SUB_ID, 'success', 6000);
      invalidateRequirementCacheForWO(r.WORKORDER_BASE_ID);
      invalidateDemandPartCacheForPart(r.PART_ID || st.partId);
      await refresh(context);
    } catch (e) {
      toast('❌ Issue failed: ' + cleanError(e.message), 'error', 9000);
    } finally {
      const currentBtn = document.querySelector(`[data-ad-context="${st.context}"][data-ad-issue="${i}"]`);
      if (currentBtn) currentBtn.textContent = 'ISSUE';
      updateRowState(context, i);
    }
  }
  async function printLabel(context, i) {
    const st = stateFor(context);
    const r = demandRows(st)[i];
    if (!r) return;
    const stock = selectedStock(st, i);
    const qtyEl = document.querySelector(`[data-ad-context="${st.context}"][data-ad-qty="${i}"]`);
    const qty = Math.max(1, Number(qtyEl ? qtyEl.value : r.REMAINING_QTY) || Number(r.REMAINING_QTY) || 1);
    const btn = document.querySelector(`[data-ad-context="${st.context}"][data-ad-label="${i}"]`);
    if (btn) { btn.disabled = true; btn.textContent = 'Printing...'; }
    try {
      const printer = typeof st.config.getPrinter === 'function' ? st.config.getPrinter(st) : getLabelPrinter();
      const copies = typeof st.config.getCopies === 'function' ? st.config.getCopies(st) : getLabelCopies();
      await printIssueLabel({
        WOId: r.WORKORDER_BASE_ID,
        lotId: r.WORKORDER_LOT_ID,
        splitId: r.WORKORDER_SPLIT_ID,
        subId: r.WORKORDER_SUB_ID,
        seqNo: r.OPERATION_SEQ_NO,
        pieceNo: r.PIECE_NO,
        partId: r.PART_ID || st.partId,
        traceId: '',
        uom: (st.data && st.data.part && st.data.part[0] && st.data.part[0].STOCK_UM) || 'EA',
        qty: qty,
        copies: copies,
        printer: printer,
        warehouseId: (stock && stock.WAREHOUSE_ID) || whs,
        isIssueLabel: true,
        IsWOLPNPickingByOperationType: false
      }, { statusUpdater: typeof st.config.updatePrintStatus === 'function' ? st.config.updatePrintStatus : undefined });
    } catch (e) {
      toast('❌ Label ' + (r.PART_ID || st.partId) + ': ' + cleanError(e.message), 'error', 9000);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'LABEL'; }
    }
  }
  function handleClick(e) {
    const issueBtn = e.target.closest('[data-ad-issue]');
    if (issueBtn) { issue(issueBtn.dataset.adContext, Number(issueBtn.dataset.adIssue)); return true; }
    const labelBtn = e.target.closest('[data-ad-label]');
    if (labelBtn) { printLabel(labelBtn.dataset.adContext, Number(labelBtn.dataset.adLabel)); return true; }
    return false;
  }
  function handleChange(e) {
    const loc = e.target.closest('[data-ad-loc]');
    if (loc) { updateRowState(loc.dataset.adContext, Number(loc.dataset.adLoc)); return true; }
    return false;
  }

  return { configure, setData, load, clear, showNoPart, render, refresh, issue, printLabel, updateRowState, handleClick, handleChange };
})();
window.QXActiveDemand = QXActiveDemand;

function renderPartLookup(data) {
  const summary = data.summary || {};
  const partRows = Array.isArray(data.part) ? data.part : [];
  const rawStock = Array.isArray(data.stock) ? data.stock : [];
  const stock = rawStock.filter(s => String(s.WAREHOUSE_ID || '').toUpperCase() === 'QMIL');
  const demand = Array.isArray(data.demand) ? data.demand : [];
  const po = Array.isArray(data.purchaseOrders) ? data.purchaseOrders : [];
  const issued = Array.isArray(data.issued) ? data.issued : (Array.isArray(data.returnable) ? data.returnable : []);

  const sumPanel = document.getElementById('plSummaryPanel'); if (sumPanel) sumPanel.classList.remove('hidden');
  const totalAvailableQty = (summary.totalAvailableQty ?? stock.reduce((a, s) => a + plNum(s.AVAILABLE_QTY), 0));
  const sStock = document.getElementById('plSStock'); if (sStock) sStock.textContent = plFmt(totalAvailableQty);
  const sUsable = document.getElementById('plSUsable'); if (sUsable) sUsable.textContent = summary.usableStockLocations ?? plUsableStocks().length;
  const sDemand = document.getElementById('plSDemand'); if (sDemand) sDemand.textContent = summary.activeDemandRows ?? demand.length;
  const sPO = document.getElementById('plSPO'); if (sPO) sPO.textContent = summary.openPORows ?? po.length;

  renderPLPart(partRows, data.partId, data);
  renderPLStock(stock);
  renderPLDemand(data);
  renderPLPO(po);
  renderPLIssued(issued);
}
function renderPLPart(rows, partId, data) {
  const panel = document.getElementById('plPartPanel');
  const box = document.getElementById('plPartInfo');
  if (!panel || !box) return;
  panel.classList.remove('hidden');
  if (!rows.length) {
    box.innerHTML = '<div class="empty">Part master not found for <b>' + esc(partId) + '</b>.</div>';
    return;
  }
  const p = rows[0];
  // KANBAN must come from Visual Part Maintenance > User Def > KANBAN = QM.dbo.PART.USER_9.
  // Prioritize bridge top-level values so older/alternate part objects cannot override it.
  const kanbanCandidates = [
    data?.kanbanValue,
    data?.KANBAN_VALUE,
    data?.summary?.kanbanValue,
    data?.part?.[0]?.USER_9,
    data?.part?.[0]?.KANBAN_VALUE,
    data?.part?.[0]?.KANBAN,
    data?.part?.[0]?.PART_USER_9,
    p.USER_9,
    p.User_9,
    p.user_9,
    p.KANBAN_VALUE,
    p.KANBAN,
    p.PART_USER_9
  ];
  const kanbanRawOriginal = String(kanbanCandidates.find(v => v !== undefined && v !== null && String(v).trim() !== '') ?? '').trim();
  const kanbanRaw = kanbanRawOriginal.toUpperCase();
  const isKanban = (data?.isKanban === true) || (data?.summary?.isKanban === true) || ['YES','Y','TRUE','1','KANBAN'].includes(kanbanRaw);
  const bridgeVer = data?.bridgeVersion || 'old/unknown';
  const kanbanBadge = isKanban
    ? '<span class="badge b-ready pl-kanban-badge" title="Source: QM.dbo.PART.USER_9 = ' + esc(kanbanRawOriginal || 'YES') + ' · Bridge ' + esc(bridgeVer) + '">KANBAN: YES</span>'
    : '<span class="badge b-block pl-kanban-badge" title="Source: QM.dbo.PART.USER_9 = ' + esc(kanbanRawOriginal || 'blank') + ' · Bridge ' + esc(bridgeVer) + '">KANBAN: NO</span>';
  box.innerHTML = `<div class="pl-part-title"><span class="mono pl-part-number">${esc(p.ID)}</span> <span class="pl-part-sep">—</span> ${esc(p.DESCRIPTION)}</div>
    <div class="pl-part-chips">
      <span class="badge b-ready">${esc(p.STATUS || '—')}</span>
      ${kanbanBadge}
      <span class="pl-chip">U/M: <b>${esc(p.STOCK_UM || '—')}</b></span>
      <span class="pl-chip">Product: <b>${esc(p.PRODUCT_CODE || '—')}</b></span>
      <span class="pl-chip">Commodity: <b>${esc(p.COMMODITY_CODE || '—')}</b></span>
      <span class="pl-chip">Purchased: <b>${esc(p.PURCHASED || '—')}</b></span>
      <span class="pl-chip">Stocked: <b>${esc(p.STOCKED || '—')}</b></span>
    </div>`;
}
function renderPLStock(rows) {
  const panel = document.getElementById('plStockPanel');
  const tb = document.getElementById('plStockTb');
  if (!panel || !tb) return;
  panel.classList.remove('hidden');
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="7" class="empty">No stock locations found.</td></tr>';
    return;
  }
  tb.innerHTML = rows.map(s => {
    const usable = plCanUseStock(s);
    const status = usable ? '<span class="badge b-ready">USABLE</span>' :
      (String(s.LOCATION_ID || '').toUpperCase() === 'HOLD' || String(s.STATUS || '').toUpperCase() === 'H'
        ? '<span class="badge b-low">HOLD</span>' : '<span class="badge b-block">NO</span>');
    return `<tr>
      <td class="mono">${esc(s.WAREHOUSE_ID)}</td>
      <td class="mono"><b>${esc(s.LOCATION_ID)}</b></td>
      <td style="text-align:center;font-weight:800">${esc(plFmt(s.QTY))}</td>
      <td style="text-align:center">${esc(plFmt(s.COMMITTED_QTY))}</td>
      <td style="text-align:center;color:${plNum(s.AVAILABLE_QTY) > 0 ? 'var(--success)' : 'var(--muted)'};font-weight:900">${esc(plFmt(s.AVAILABLE_QTY))}</td>
      <td>${esc(s.STATUS || '')} ${String(s.LOCKED || '').toUpperCase() === 'Y' ? '<span class="badge b-block">LOCKED</span>' : ''}</td>
      <td>${status}</td>
    </tr>`;
  }).join('');
}
function renderPLDemand(data) {
  const partRows = data && Array.isArray(data.part) ? data.part : [];
  const description = partRows.length ? String(partRows[0].DESCRIPTION || '') : '';
  QXActiveDemand.setData('partLookup', {
    panelId: 'plDemandPanel',
    hostId: 'plDemandHost',
    summaryId: 'plDemandSummary',
    partId: (data && data.partId) || S.plPart || '',
    description,
    data: data || {},
    getPrinter: getPartLookupPrinter,
    getCopies: getLabelCopies,
    updatePrintStatus: updatePartLookupPrinterStatus,
    onRefreshData: async refreshed => {
      S.pl = refreshed;
      S.plPart = normalizePart(refreshed.partId || S.plPart || '');
      renderPartLookup(refreshed);
      const meta = document.getElementById('plMeta');
      if (meta) meta.textContent = 'Refreshed ' + S.plPart + ' after issue · ' + (refreshed.generatedAt || 'now');
    }
  });
}

function renderPLPO(rows) {
  const panel = document.getElementById('plPoPanel');
  const tb = document.getElementById('plPoTb');
  const sum = document.getElementById('plPoSummary');
  if (!panel || !tb) return;
  panel.classList.remove('hidden');
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="9" class="empty">No open incoming PO found.</td></tr>';
    if (sum) sum.textContent = '0 open PO';
    return;
  }
  let total = 0;
  tb.innerHTML = rows.map(r => {
    total += plNum(r.OPEN_QTY);
    return `<tr>
      <td class="mono"><b>${esc(r.PURC_ORDER_ID)}</b></td>
      <td style="text-align:center">${esc(r.LINE_NO)}</td>
      <td>${esc(r.VENDOR_ID)}</td>
      <td class="mono">${esc(r.PART_ID)}</td>
      <td style="text-align:center">${esc(plFmt(r.ORDER_QTY))}</td>
      <td style="text-align:center">${esc(plFmt(r.TOTAL_RECEIVED_QTY))}</td>
      <td style="text-align:center;color:var(--primary);font-weight:900">${esc(plFmt(r.OPEN_QTY))}</td>
      <td>${esc(plDate(r.DUE_DATE || r.colDUE_DATE || r.DESIRED_RECV_DATE || ''))}</td>
      <td class="kb-udf" title="${esc(r.UserDefined1 || r.USER_DEFINED_1 || r.USER_1 || '')}">${esc(r.UserDefined1 || r.USER_DEFINED_1 || r.USER_1 || '')}</td>
    </tr>`;
  }).join('');
  if (sum) sum.textContent = rows.length + ' open PO row(s), total open ' + plFmt(total);
}

function renderPLIssued(rows) {
  const panel = document.getElementById('plIssuedPanel');
  const tb = document.getElementById('plIssuedTb');
  const sum = document.getElementById('plIssuedSummary');
  if (!panel || !tb) return;
  panel.classList.remove('hidden');
  if (!rows || !rows.length) {
    tb.innerHTML = '<tr><td colspan="9" class="empty">No issued / returnable rows found for this part.</td></tr>';
    if (sum) sum.textContent = '0 returnable';
    return;
  }
  let total = 0;
  tb.innerHTML = rows.map((r, i) => {
    const issuedQty = Math.max(0, plNum(r.IssuedQty ?? r.ISSUED_QTY ?? r.ReturnQty));
    total += issuedQty;
    const wo = r.WOId ?? r.WORKORDER_BASE_ID ?? '';
    const sub = r.SubId ?? r.WORKORDER_SUB_ID ?? '';
    const part = r.PartId ?? r.PART_ID ?? S.plPart ?? '';
    const desc = r.Desc ?? r.DESCRIPTION ?? '';
    const loc = r.PartPrimaryLocID ?? r.LOCATION_ID ?? '';
    const req = r.CalculatedQty ?? r.CALC_QTY ?? '';
    const uom = r.Uom ?? r.STOCK_UM ?? '';
    return `<tr id="plret${i}">
      <td class="pl-action-cell"><button class="btn btn-danger btn-xs" data-pl-return="${i}">↩ RETURN</button></td>
      <td class="mono"><b style="color:var(--primary)">${esc(wo)}</b></td>
      <td style="text-align:center">${esc(sub)}</td>
      <td class="mono"><b>${esc(part)}</b></td>
      <td class="mono">${loc ? esc(loc) : '<span class="dim">auto</span>'}</td>
      <td style="text-align:center"><input class="dm-qty pl-return-qty" id="plretq${i}" type="number" min="1" max="${esc(issuedQty)}" value="${esc(issuedQty)}"></td>
      <td style="text-align:center;color:var(--success);font-weight:800">${esc(plFmt(issuedQty))}</td>
      <td class="pl-desc" title="${esc(desc)}">${esc(desc)}</td>
      <td style="text-align:center;font-weight:600">${esc(plFmt(req))} <span class="dim">${esc(uom)}</span></td>
    </tr>`;
  }).join('');
  if (sum) sum.textContent = rows.length + ' returnable row(s), total issued ' + plFmt(total);
}

async function returnPartLookupIssued(i) {
  if (!S.pl) return;
  const rows = Array.isArray(S.pl.issued) ? S.pl.issued : (Array.isArray(S.pl.returnable) ? S.pl.returnable : []);
  const r0 = rows[i];
  if (!r0) return;
  const qtyEl = document.getElementById('plretq' + i);
  const qty = plNum(qtyEl ? qtyEl.value : 0);
  const issuedQty = plNum(r0.IssuedQty ?? r0.ISSUED_QTY ?? r0.ReturnQty);
  if (!qty || qty <= 0) { toast('Enter valid return qty', 'error'); return; }
  if (qty > issuedQty) { toast('Return qty cannot be more than issued qty', 'error'); return; }
  const row = document.getElementById('plret' + i);
  const btn = row ? row.querySelector('[data-pl-return]') : null;
  if (btn) { btn.disabled = true; btn.textContent = 'Returning...'; }
  const r = {
    WOId: r0.WOId ?? r0.WORKORDER_BASE_ID,
    LotId: r0.LotId ?? r0.WORKORDER_LOT_ID ?? '1',
    SplitId: r0.SplitId ?? r0.WORKORDER_SPLIT_ID ?? '0',
    SubId: r0.SubId ?? r0.WORKORDER_SUB_ID ?? '0',
    PartId: r0.PartId ?? r0.PART_ID ?? S.plPart,
    Desc: r0.Desc ?? r0.DESCRIPTION ?? '',
    Uom: r0.Uom ?? r0.STOCK_UM ?? 'EA',
    CalculatedQty: plNum(r0.CalculatedQty ?? r0.CALC_QTY),
    IssuedQty: issuedQty,
    PartPrimaryLocID: r0.PartPrimaryLocID ?? r0.LOCATION_ID ?? '',
    SeqNo: r0.SeqNo ?? r0.OPERATION_SEQ_NO,
    PieceNo: r0.PieceNo ?? r0.PIECE_NO
  };
  try {
    await processReturnForReq(r, qty);
    toast('✅ Returned ' + r.PartId + ' × ' + qty + ' from ' + r.WOId + ' Sub ' + r.SubId, 'success', 5000);
    invalidateRequirementCacheForWO(r.WOId);
    demandPartResultCache.clear();
    await lookupPartLookup(S.plPart || r.PartId);
  } catch (e) {
    toast('❌ Return failed: ' + cleanError(e.message), 'error', 9000);
    if (btn) { btn.disabled = false; btn.textContent = '↩ RETURN'; }
  }
}
// ============================================================
//  KANBAN BULK MODULE — SQL Read / RF Plus Single Adjust Out
// ============================================================
function kbSetBridgeStatus(txt, type) {
  const el = document.getElementById('kbBridgeStatus');
  if (!el) return;
  el.textContent = txt;
  el.className = 'dim pl-bridge ' + (type || '');
}
function kbSetProgress(show, msg) {
  const box = document.getElementById('kbProgress');
  const t = document.getElementById('kbProgressText');
  if (box) box.classList.toggle('hidden', !show);
  if (t && msg) t.textContent = msg;
}
async function checkKanbanBridge() {
  const btn = document.getElementById('kbHealthBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking...'; }
  try {
    const res = await fetch(SQL_BRIDGE + '/api/health', { method: 'GET' });
    const j = await res.json();
    if (!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
    if (window.QXStatus) window.QXStatus.bridgeUp();
    toast('✅ SQL Bridge connected', 'success', 2500);
    return true;
  } catch (e) {
    if (window.QXStatus) window.QXStatus.bridgeDown();
    toast('SQL Bridge not reachable. Start the QX SQL Bridge first.', 'error', 7000);
    return false;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↻ Check Bridge'; }
  }
}
function parseKanbanPaste() {
  const text = document.getElementById('kbPaste')?.value || '';
  const counts = new Map();
  const order = [];
  text.split(/\r?\n/).forEach(line => {
    const raw = String(line || '').trim();
    if (!raw) return;
    let first = raw.includes('\t') ? raw.split('\t')[0] : (raw.includes(',') ? raw.split(',')[0] : raw.split(/\s+/)[0]);
    const part = normalizePart(first);
    if (!part || /^PART$/i.test(part) || /^PARTID$/i.test(part) || /^PART_ID$/i.test(part)) return;
    if (!counts.has(part)) order.push(part);
    counts.set(part, (counts.get(part) || 0) + 1);
  });
  return { partIds: order, counts };
}
async function fetchKanbanBulk(partIds) {
  try {
    const res = await fetch(SQL_BRIDGE + '/api/kanban/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ partIds })
    });
    let j;
    try { j = await res.json(); } catch (e) { throw new Error('SQL Bridge returned invalid Kanban response'); }
    if (!res.ok || !j.ok) throw new Error(j.error || ('SQL Bridge HTTP ' + res.status));
    if (window.QXStatus) window.QXStatus.bridgeUp();
    return j;
  } catch (e) {
    if (window.QXStatus) window.QXStatus.bridgeDown();
    throw e;
  }
}
async function analyzeKanban(opts) {
  const parsed = parseKanbanPaste();
  if (!parsed.partIds.length) { toast('Paste Part IDs first', 'error'); return; }
  if (parsed.partIds.length > 900) { toast('For first beta, please analyze 900 or fewer unique parts at once.', 'error', 9000); return; }
  S.kbInputParts = parsed.partIds;
  const btn = document.getElementById('kbAnalyzeBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Analyzing...'; }
  kbSetProgress(true, 'Analyzing ' + parsed.partIds.length + ' unique Kanban parts from SQL...');
  const meta = document.getElementById('kbMeta'); if (meta && !opts?.silent) meta.textContent = 'Loading SQL data...';
  try {
    const data = await fetchKanbanBulk(parsed.partIds);
    const rows = Array.isArray(data.rows) ? data.rows : [];
    rows.forEach(r => { r.scanCount = parsed.counts.get(String(r.partId || '').toUpperCase()) || r.scanCount || 1; });
    S.kbRows = rows;
    kbSetBridgeStatus('Bridge: connected', 'ok');
    renderKanban(data);
    if (meta) meta.textContent = 'Loaded ' + rows.length + ' row(s) · Bridge ' + (data.bridgeVersion || 'unknown') + ' · ' + (data.generatedAt || 'now');
  } catch (e) {
    kbSetBridgeStatus('Bridge: error', 'bad');
    toast('KANBAN SQL failed: ' + cleanError(e.message), 'error', 10000);
    if (meta) meta.textContent = cleanError(e.message);
  } finally {
    kbSetProgress(false);
    if (btn) { btn.disabled = false; btn.textContent = '🔎 Analyze List'; }
  }
}
function clearKanban() {
  S.kbRows = []; S.kbInputParts = [];
  const p = document.getElementById('kbPaste'); if (p) p.value = '';
  const meta = document.getElementById('kbMeta'); if (meta) meta.textContent = 'SQL is read-only. Single-row Adjust Out uses RF Plus API.';
  ['kbSummaryPanel','kbPanel','kbProgress'].forEach(id => { const el=document.getElementById(id); if(el) el.classList.add('hidden'); });
  const tb = document.getElementById('kbTb'); if (tb) tb.innerHTML = '';
}
function kbActionLabel(a) {
  if (a === 'IN_STOCK') return 'In Stock';
  if (a === 'ON_PO') return 'On PO';
  if (a === 'NEEDS_REORDER') return 'Needs Reorder';
  return 'Invalid';
}
function kbActionClass(a) {
  if (a === 'IN_STOCK') return 'in';
  if (a === 'ON_PO') return 'po';
  if (a === 'NEEDS_REORDER') return 'reorder';
  return 'invalid';
}
function renderKanban(data) {
  const rows = S.kbRows || [];
  const panel = document.getElementById('kbPanel'); if (panel) panel.classList.remove('hidden');
  const sum = data?.summary || {};
  const total = rows.length;
  const count = a => rows.filter(r => r.suggestedAction === a).length;
  const set=(id,v)=>{ const el=document.getElementById(id); if(el) el.textContent = v; };
  const sPanel = document.getElementById('kbSummaryPanel'); if (sPanel) sPanel.classList.remove('hidden');
  set('kbSTotal', sum.totalRows ?? total);
  set('kbSInStock', sum.inStock ?? count('IN_STOCK'));
  set('kbSOnPO', sum.onPO ?? count('ON_PO'));
  set('kbSReorder', sum.needsReorder ?? count('NEEDS_REORDER'));
  set('kbSInvalid', sum.invalid ?? count('INVALID'));
  const st = document.getElementById('kbSummaryText');
  if (st) st.textContent = 'Duplicates merged. Adjust Out is single-row only.';
  renderKanbanRows();
}
function filteredKanbanRows() {
  const rows = S.kbRows || [];
  const f = document.getElementById('kbFilterAction')?.value || 'ALL';
  const q = String(document.getElementById('kbSearch')?.value || '').trim().toUpperCase();
  return rows.filter(r => {
    if (f !== 'ALL' && r.suggestedAction !== f) return false;
    if (!q) return true;
    const hay = [r.partId, r.description, r.userDefined1, (r.incomingPOs||[]).map(p=>p.poId).join(' '), (r.locations||[]).map(l=>l.locationId).join(' ')].join(' ').toUpperCase();
    return hay.includes(q);
  });
}
function kbStockLocations(r) {
  return (r.locations || []).filter(l => plNum(l.availableQty ?? l.AvailableQty ?? l.qty ?? l.Qty) > 0);
}
function kbUsableLocations(r) {
  return kbStockLocations(r).filter(l => Number(l.usableForAdjust || l.USABLE_FOR_ADJUST || 0) === 1);
}
function kbPoSummary(pos) {
  const m = new Map();
  (pos || []).forEach(p => {
    const poId = String(p.poId || p.POId || '').trim();
    if (!poId) return;
    const openQty = plNum(p.openQty ?? p.OpenQty);
    if (openQty <= 0) return;
    if (!m.has(poId)) m.set(poId, { poId, openQty: 0 });
    m.get(poId).openQty += openQty;
  });
  return Array.from(m.values());
}
function renderKanbanRows() {
  const tb = document.getElementById('kbTb'); if (!tb) return;
  const rows = filteredKanbanRows();
  const meta = document.getElementById('kbFilterMeta'); if (meta) meta.textContent = rows.length + ' shown / ' + (S.kbRows||[]).length + ' total';
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="10" class="empty">No Kanban rows to show.</td></tr>'; return; }
  tb.innerHTML = rows.map((r) => {
    const i = (S.kbRows || []).indexOf(r);
    const locs = kbStockLocations(r);
    const usable = kbUsableLocations(r);
    const pos = (r.incomingPOs || []);
    const posSummary = kbPoSummary(pos);
    const locText = locs.length
      ? locs.slice(0,3).map(l => `<span class="mono">${esc(l.locationId || l.LocationId)}</span> · ${esc(plFmt(l.availableQty ?? l.AvailableQty ?? l.qty ?? l.Qty))}`).join('<br>') + (locs.length > 3 ? '<br><span class="dim">+' + (locs.length-3) + ' more</span>' : '')
      : '<span class="dim">—</span>';
    const poText = posSummary.length
      ? posSummary.slice(0,3).map(p => `<span class="mono">${esc(p.poId)}</span> · Open ${esc(plFmt(p.openQty))}`).join('<br>') + (posSummary.length > 3 ? '<br><span class="dim">+' + (posSummary.length-3) + ' more</span>' : '')
      : '<span class="dim">—</span>';
    const udf = r.userDefined1 || (pos.find(p=>p.userDefined1)?.userDefined1) || '';
    const canAdjust = r.isValid !== false && usable.length > 0 && !r.adjusted;
    const maxQty = usable.length ? Math.max(1, Math.floor(Number(usable[0].availableQty || usable[0].AvailableQty || 0))) : 1;
    const locSelect = canAdjust
      ? `<select class="kb-loc-select" id="kbloc${i}" title="Select stock location">${usable.map((l,idx)=>`<option value="${esc(l.locationId || l.LocationId)}" data-max="${esc(l.availableQty ?? l.AvailableQty)}"${idx===0?' selected':''}>${esc(l.locationId || l.LocationId)} · ${esc(plFmt(l.availableQty ?? l.AvailableQty))}</option>`).join('')}</select>`
      : '<span class="dim">—</span>';
    const qtyInput = canAdjust ? `<input class="kb-adjust-qty" id="kbqty${i}" type="number" min="1" max="${esc(maxQty)}" value="${esc(Math.min(100, maxQty))}" title="Qty to adjust out to Kanban">` : '<span class="dim">—</span>';
    const btn = canAdjust ? `<button class="btn btn-success btn-xs kb-adjust-btn" data-kb-adjust="${i}" title="RF Plus Adjust Out · Reason 5583 · ISSUED TO KANBAN- JE">ADJ KANBAN</button>` : (r.adjusted ? '<span class="badge b-ready">DONE</span>' : '<span class="dim">—</span>');
    const scan = Number(r.scanCount || 1) > 1 ? `<div class="kb-small-note">Scanned ${esc(r.scanCount)}×</div>` : '';
    const demand = Number(r.activeDemandQty || 0) > 0 ? `<div class="kb-small-note">Demand ${esc(plFmt(r.activeDemandQty))}</div>` : '';
    return `<tr id="kbrow${i}" class="${r.adjusted ? 'kb-row-done' : ''}">
      <td><b class="qx-part">${esc(r.partId)}</b>${scan}</td>
      <td class="kb-desc" title="${esc(r.description || '')}">${esc(r.description || (r.isValid ? '' : 'Part not found'))}</td>
      <td class="kb-stock" style="color:${r.availableQty>0?'var(--success)':'var(--muted)'}">${esc(plFmt(r.availableQty || 0))}${demand}</td>
      <td class="kb-locs">${locText}</td>
      <td class="kb-pos">${poText}</td>
      <td class="kb-udf" title="${esc(udf)}">${esc(udf)}</td>
      <td><span class="kb-action-pill ${kbActionClass(r.suggestedAction)}">${kbActionLabel(r.suggestedAction)}</span></td>
      <td class="kb-qty-cell">${qtyInput}</td>
      <td>${locSelect}</td>
      <td class="kb-rf-cell">${btn}</td>
    </tr>`;
  }).join('');
}
async function kanbanAdjustOut(i) {
  const r = (S.kbRows || [])[i];
  if (!r) return;
  const qtyEl = document.getElementById('kbqty' + i);
  const locEl = document.getElementById('kbloc' + i);
  const qty = plNum(qtyEl ? qtyEl.value : 0);
  const loc = locEl ? String(locEl.value || '').trim().toUpperCase() : '';
  const selectedOpt = locEl ? locEl.options[locEl.selectedIndex] : null;
  const max = selectedOpt ? plNum(selectedOpt.dataset.max) : plNum(r.availableQty);
  if (!qty || qty <= 0) { toast('Enter Adjust Out qty', 'error'); return; }
  if (!loc) { toast('Choose location', 'error'); return; }
  if (qty > max) { toast('Qty is more than selected location available stock', 'error', 7000); return; }
  if (!confirm(`ADJUST OUT TO KANBAN?\n\nPart: ${r.partId}\nQty: ${qty}\nLocation: ${loc}\nReason: 5583\nDescription: ISSUED TO KANBAN- JE\n\nThis will change inventory in RF Plus.`)) return;
  const btn = document.querySelector('[data-kb-adjust="' + i + '"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Working...'; }
  try {
    await api('/api/inventoryAdjust/InventoryAdjustOut', {
      partId: r.partId,
      qty: String(qty),
      warehouseId: whs,
      locationId: loc,
      transactionDescription: 'ISSUED TO KANBAN- JE',
      reason: '5583'
    });
    r.adjusted = true;
    r.adjustedQty = qty;
    r.adjustedLocation = loc;
    toast('✅ Kanban Adjust Out done: ' + r.partId + ' × ' + qty + ' from ' + loc, 'success', 7000);
    renderKanbanRows();
  } catch (e) {
    toast('❌ Kanban Adjust Out failed: ' + cleanError(e.message), 'error', 10000);
    if (btn) { btn.disabled = false; btn.textContent = 'ADJUST OUT'; }
  }
}
function exportKanbanCsv(mode) {
  const rows = (S.kbRows || []).filter(r => mode === 'ALL' || r.suggestedAction === mode);
  if (!rows.length) { toast('Nothing to export', 'error'); return; }
  const csvRows = [];
  const cols = ['Part ID','Description','Available Qty','Locations','Incoming PO','User Defined 1','Suggested Action','Demand Qty','Scan Count','Adjusted Qty','Adjusted Location'];
  csvRows.push(cols.join(','));
  const q = v => '"' + String(v ?? '').replace(/"/g,'""') + '"';
  rows.forEach(r => {
    const locs = kbStockLocations(r).map(l => `${l.locationId || l.LocationId}:${plFmt(l.availableQty ?? l.AvailableQty)}`).join(' | ');
    const pos = kbPoSummary(r.incomingPOs||[]).map(p => `${p.poId} open ${plFmt(p.openQty)}`).join(' | ');
    const udf = r.userDefined1 || ((r.incomingPOs||[]).find(p=>p.userDefined1)||{}).userDefined1 || '';
    csvRows.push([r.partId,r.description,plFmt(r.availableQty||0),locs,pos,udf,kbActionLabel(r.suggestedAction),plFmt(r.activeDemandQty||0),r.scanCount||1,r.adjustedQty||'',r.adjustedLocation||''].map(q).join(','));
  });
  const blob = new Blob([csvRows.join('\r\n')], { type:'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = mode === 'NEEDS_REORDER' ? 'kanban_needs_reorder.csv' : 'kanban_all_results.csv';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

// ============================================================
//  CUSTOM LABEL QTY / COPIES — iPad
// ============================================================
function openCustomLabelModal(i) {
  const r = S.ip[i];
  if (!r) return;
  S.customPrintIndex = i;
  const q = getIssueQuantities(r);
  const modal = document.getElementById('customLabelModal');
  if (!modal) return;
  const title = document.getElementById('customLabelTitle');
  const part = document.getElementById('customLabelPart');
  const meta = document.getElementById('customLabelMeta');
  const qty = document.getElementById('customLabelQty');
  const copies = document.getElementById('customLabelCopies');
  if (title) title.textContent = 'Custom Issue Label';
  if (part) part.textContent = r.PartId || '';
  if (meta) meta.textContent = 'Location ' + (getDisplayIssueLocation(r) || '—') + ' · Need ' + q.need + ' · Stock ' + q.stockQty + ' · Sub ' + getReqSub(r);
  if (qty) qty.value = String(getDefaultPrintQtyForRow(r));
  if (copies) copies.value = String(getLabelCopies());
  modal.classList.remove('hidden');
  setTimeout(() => { if (qty) qty.focus(); if (qty) qty.select(); }, 50);
}

function closeCustomLabelModal() {
  const modal = document.getElementById('customLabelModal');
  if (modal) modal.classList.add('hidden');
  S.customPrintIndex = null;
}

async function printCustomLabelFromModal() {
  const i = Number(S.customPrintIndex);
  const r = S.ip[i];
  if (!r) return;
  const qtyEl = document.getElementById('customLabelQty');
  const copiesEl = document.getElementById('customLabelCopies');
  const qty = Math.max(1, Number(qtyEl ? qtyEl.value : 1) || 1);
  const copies = Math.min(999, Math.max(1, Number(copiesEl ? copiesEl.value : 1) || 1));
  const btn = document.getElementById('customLabelPrintBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Printing...'; }
  try {
    await printIssueLabel(reqToPrintLabel(r, qty, copies));
    closeCustomLabelModal();
  } catch (e) {
    toast('❌ Custom label failed: ' + e.message, 'error', 9000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'PRINT CUSTOM LABEL'; }
  }
}


// ============================================================
//  PRINT PART LABEL — Part BarTender template via RF Plus API
// ============================================================
function normalizePPLPart(v) { return String(v || '').trim().toUpperCase(); }
function pplPrinter() {
  const el = document.getElementById('pplPrinter');
  return (el && el.value) || getLabelPrinter() || DEFAULT_LABEL_PRINTER;
}
function pplCopies() {
  const el = document.getElementById('pplCopies');
  return Math.max(1, Math.min(999, Number(el && el.value) || 1));
}
function pplQty() {
  const el = document.getElementById('pplQty');
  return Math.max(1, Number(el && el.value) || 1);
}
function setPPLInfo(msg, type) {
  const el = document.getElementById('pplInfo');
  if (!el) return;
  el.className = 'ppl-info ' + (type || '');
  el.textContent = msg || '';
}
function extractPartRecord(data, fallbackPart) {
  const arr = Array.isArray(data) ? data : (data && Array.isArray(data.Data) ? data.Data : []);
  const r = arr[0] || data || {};
  return {
    PartId: r.PartId || r.partId || r.Id || fallbackPart,
    Desc: r.Desc || r.Description || r.description || '',
    Uom: r.Uom || r.UOM || r.uom || '',
    IsTraceable: !!(r.IsTraceable || r.Traceable),
    raw: r
  };
}
async function validatePrintPart(part) {
  const partId = normalizePPLPart(part);
  if (!partId) throw new Error('Part ID is required');
  const data = await api('/api/inventoryTransfer/ValidatePartTrace', {
    partOrTraceId: partId,
    partId: null,
    partIdtoValidateTrace: null,
    isUseRFPlusTrace: null,
    isOutboundPickingValidateTrace: false,
    isUseMixedTrace: null
  });
  const rec = extractPartRecord(data, partId);
  if (!rec.PartId) throw new Error('Part not found');
  return rec;
}
async function loadPrintPartPrinters() {
  const sel = document.getElementById('pplPrinter');
  if (!sel) return;
  const preferred = sel.value || DEFAULT_LABEL_PRINTER;
  const printers = await getSharedIssuePrinterList();
  populatePrinterSelect(sel, printers, preferred);
  try {
    const def = await api('/api/printing/GetUserDefaultLabelPrinter', { warehouseId: whs });
    const p = printerIdFromAny(def && (def.Data || def.data || def));
    if (p) { populatePrinterSelect(sel, printers, p); }
  } catch (e) {}
}

async function validateSinglePrintPart() {
  const part = normalizePPLPart(document.getElementById('pplPart').value);
  const btn = document.getElementById('pplValidateBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Validating...'; }
  try {
    const rec = await validatePrintPart(part);
    S.pplPart = rec;
    document.getElementById('pplPart').value = rec.PartId;
    setPPLInfo(`${rec.PartId} — ${rec.Desc || 'No description'}${rec.Uom ? ' · UOM ' + rec.Uom : ''}`, 'ok');
    return rec;
  } catch (e) {
    S.pplPart = null;
    setPPLInfo('Part validation failed: ' + cleanError(e.message), 'err');
    throw e;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔍 Validate Part'; }
  }
}
async function printPartLabel(partId, qty, copies, printerId) {
  return api('/api/licenseBuild/printPartLabel', {
    partId: normalizePPLPart(partId),
    traceId: null,
    qty: String(Math.max(1, Number(qty) || 1)),
    numOfCopies: String(Math.max(1, Math.min(999, Number(copies) || 1))),
    printerId: printerId || pplPrinter(),
    customLabelFields: []
  });
}
async function printSinglePartLabel() {
  const part = normalizePPLPart(document.getElementById('pplPart').value);
  const btn = document.getElementById('pplPrintBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Printing...'; }
  try {
    const rec = (S.pplPart && normalizePPLPart(S.pplPart.PartId) === part) ? S.pplPart : await validateSinglePrintPart();
    await printPartLabel(rec.PartId, pplQty(), pplCopies(), pplPrinter());
    toast('✅ Part label printed: ' + rec.PartId, 'success');
  } catch (e) {
    toast('❌ Print part label failed: ' + cleanError(e.message), 'error', 9000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🏷 Print Label'; }
  }
}
function parseMassPartLabelRows() {
  const txt = document.getElementById('pplMassText').value || '';
  return txt.split(/\r?\n/).map((line, idx) => {
    const t = line.trim();
    if (!t) return null;
    const cols = t.includes('\t') ? t.split('\t') : t.split(/[ ,]+/);
    return {
      index: idx + 1,
      partId: normalizePPLPart(cols[0]),
      qty: Math.max(1, Number(cols[1]) || 1),
      copies: Math.max(1, Math.min(999, Number(cols[2]) || 1)),
      printerId: pplPrinter(),
      status: 'PENDING',
      desc: ''
    };
  }).filter(Boolean).filter(r => r.partId);
}
function renderMassPartLabelRows(rows) {
  const panel = document.getElementById('pplMassPanel');
  const tb = document.getElementById('pplMassTb');
  const summary = document.getElementById('pplMassSummary');
  if (!panel || !tb) return;
  panel.classList.remove('hidden');
  const arr = rows || S.pplRows || [];
  tb.innerHTML = arr.length ? arr.map((r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td class="mono cyan">${esc(r.partId)}</td>
      <td>${esc(r.desc || '')}</td>
      <td style="text-align:center">${esc(r.qty)}</td>
      <td style="text-align:center">${esc(r.copies)}</td>
      <td>${esc(r.printerId || pplPrinter())}</td>
      <td>${massStatusPill(r.status, r.error)}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty">Paste Excel rows above.</td></tr>';
  if (summary) {
    const ok = arr.filter(r => r.status === 'READY' || r.status === 'PRINTED').length;
    const bad = arr.filter(r => r.status === 'ERROR').length;
    summary.textContent = `${arr.length} row(s) · ${ok} ready/printed · ${bad} error`;
  }
}
function massStatusPill(status, err) {
  const s = status || 'PENDING';
  const cls = s === 'PRINTED' ? 'good' : s === 'READY' ? 'ready' : s === 'ERROR' ? 'bad' : 'wait';
  return `<span class="ppl-pill ${cls}" title="${esc(err || '')}">${esc(s)}</span>`;
}
async function prepareMassPartLabels() {
  S.pplRows = parseMassPartLabelRows();
  if (!S.pplRows.length) { toast('Paste part, qty, copies rows first', 'error'); return; }
  renderMassPartLabelRows(S.pplRows);
  const btn = document.getElementById('pplPrepareMassBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing...'; }
  try {
    for (let i = 0; i < S.pplRows.length; i++) {
      const row = S.pplRows[i];
      row.status = 'CHECKING'; renderMassPartLabelRows(S.pplRows);
      try {
        const rec = await validatePrintPart(row.partId);
        row.partId = rec.PartId;
        row.desc = rec.Desc || '';
        row.status = 'READY';
      } catch (e) {
        row.status = 'ERROR';
        row.error = cleanError(e.message);
      }
      renderMassPartLabelRows(S.pplRows);
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔍 Prepare / Validate'; }
  }
}
async function printMassPartLabels() {
  if (!S.pplRows || !S.pplRows.length) await prepareMassPartLabels();
  const ready = (S.pplRows || []).filter(r => r.status === 'READY');
  if (!ready.length) { toast('No ready label rows to print', 'error'); return; }
  if (!confirm('Print ' + ready.length + ' part label row(s)?')) return;
  const btn = document.getElementById('pplPrintMassBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Printing...'; }
  try {
    for (const row of S.pplRows) {
      if (row.status !== 'READY') continue;
      row.status = 'PRINTING'; renderMassPartLabelRows(S.pplRows);
      try {
        await printPartLabel(row.partId, row.qty, row.copies, row.printerId || pplPrinter());
        row.status = 'PRINTED';
      } catch (e) {
        row.status = 'ERROR';
        row.error = cleanError(e.message);
      }
      renderMassPartLabelRows(S.pplRows);
    }
    toast('✅ Mass part label print complete', 'success');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Print Mass Labels'; }
  }
}
function clearPrintPartModule() {
  ['pplPart','pplMassText'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const q = document.getElementById('pplQty'); if (q) q.value = '1';
  const c = document.getElementById('pplCopies'); if (c) c.value = '1';
  S.pplPart = null; S.pplRows = [];
  setPPLInfo('Enter a part number to validate description/UOM before printing.');
  const panel = document.getElementById('pplMassPanel'); if (panel) panel.classList.add('hidden');
}

// ============================================================
//  EVENT WIRING — Chrome extension friendly, no inline handlers
// ============================================================
document.addEventListener('click', e => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) { switchTab(tabBtn.dataset.tab); return; }

  const subBtn = e.target.closest('[data-sub]');
  if (subBtn) { selSub(subBtn.dataset.sub); return; }

  const issueBtn = e.target.closest('[data-issue-index]');
  if (issueBtn) { issueSingle(Number(issueBtn.dataset.issueIndex)); return; }

  const printBtn = e.target.closest('[data-print-index]');
  if (printBtn) { printIssueLabelFromIssueIndex(Number(printBtn.dataset.printIndex)); return; }

  const customPrintBtn = e.target.closest('[data-custom-print-index]');
  if (customPrintBtn) { openCustomLabelModal(Number(customPrintBtn.dataset.customPrintIndex)); return; }

  const retBtn = e.target.closest('[data-return-index]');
  if (retBtn) { doReturnAction(Number(retBtn.dataset.returnIndex)); return; }

  const masterRetBtn = e.target.closest('[data-master-return-index]');
  if (masterRetBtn) { returnFromMaster(Number(masterRetBtn.dataset.masterReturnIndex)); return; }

  const stepBtn = e.target.closest('[data-label-step]');
  if (stepBtn) {
    const [which, deltaRaw] = String(stepBtn.dataset.labelStep).split(':');
    const input = document.getElementById(which === 'copies' ? 'customLabelCopies' : 'customLabelQty');
    const delta = Number(deltaRaw || 0);
    if (input) {
      const min = Number(input.min || 1), max = Number(input.max || 999);
      let n = Number(input.value || min) + delta;
      n = Math.max(min, Math.min(max || 999, n));
      input.value = String(n);
      input.focus();
    }
    return;
  }

  const demandBtn = e.target.closest('[data-demand-issue]');
  if (demandBtn) { issueDemand(Number(demandBtn.dataset.demandIssue)); return; }

  const demandPrintBtn = e.target.closest('[data-demand-print]');
  if (demandPrintBtn) { printDemandLabel(Number(demandPrintBtn.dataset.demandPrint)); return; }

  const demandReturnBtn = e.target.closest('[data-demand-return]');
  if (demandReturnBtn) { returnDemandIssued(Number(demandReturnBtn.dataset.demandReturn)); return; }

  if (typeof QXActiveDemand !== 'undefined' && QXActiveDemand.handleClick(e)) return;

  const plReturnBtn = e.target.closest('[data-pl-return]');
  if (plReturnBtn) { returnPartLookupIssued(Number(plReturnBtn.dataset.plReturn)); return; }

  const kbAdjustBtn = e.target.closest('[data-kb-adjust]');
  if (kbAdjustBtn) { kanbanAdjustOut(Number(kbAdjustBtn.dataset.kbAdjust)); return; }

  const issueSortBtn = e.target.closest('[data-issue-sort]');
  if (issueSortBtn) { cycleIssueSort(issueSortBtn.dataset.issueSort); return; }
});

document.addEventListener('change', e => {
  if (typeof QXActiveDemand !== 'undefined' && QXActiveDemand.handleChange(e)) return;
});

document.getElementById('loginBtn').addEventListener('click', () => loginRFPlus(false));
(function wireLoginFields(){
  const u = document.getElementById('loginUser');
  const p = document.getElementById('loginPass');
  if (u) u.addEventListener('keydown', e => { if (e.key === 'Enter') { if (p) p.focus(); } });
  if (p) p.addEventListener('keydown', e => { if (e.key === 'Enter') loginRFPlus(false); });
  const so = document.getElementById('signOutBtn');
  if (so) so.addEventListener('click', signOut);
})();
document.getElementById('loadBtn').addEventListener('click', loadWO);
document.getElementById('clearBtn').addEventListener('click', clrAll);
document.getElementById('btnAll').addEventListener('click', issueAll);
document.getElementById('btnReturnAll').addEventListener('click', returnAllToStock);
document.getElementById('topReconnectBtn').addEventListener('click', reconnectQuickX);
document.getElementById('refreshPartsBtn').addEventListener('click', loadParts);
document.getElementById('refreshReturnBtn').addEventListener('click', loadReturn);
document.getElementById('woi').addEventListener('keydown', e => { if (e.key === 'Enter') loadWO(); });
document.getElementById('dmSearchBtn').addEventListener('click', searchPartDemands);
document.getElementById('dmIssueSelectedBtn').addEventListener('click', issueSelectedDemands);
document.getElementById('dmSelectAllBtn').addEventListener('click', selectIssuableDemandRows);
document.getElementById('clearDemandBtn').addEventListener('click', clearDemandResults);
const dmRefreshBtn = document.getElementById('dmRefreshActiveBtn');
if (dmRefreshBtn) dmRefreshBtn.addEventListener('click', () => { clearActiveWOCache(); clearDemandResults(); });
const dmRefreshResultsBtn = document.getElementById('dmRefreshResultsBtn');
if (dmRefreshResultsBtn) dmRefreshResultsBtn.addEventListener('click', refreshVisibleDemandResults);
document.getElementById('dmPart').addEventListener('keydown', e => { if (e.key === 'Enter') searchPartDemands(); });
const plLookupBtn = document.getElementById('plLookupBtn');
if (plLookupBtn) plLookupBtn.addEventListener('click', () => lookupPartLookup());
const plRefreshBtn = document.getElementById('plRefreshBtn');
if (plRefreshBtn) plRefreshBtn.addEventListener('click', () => lookupPartLookup(S.plPart));
const plHealthBtn = document.getElementById('plHealthBtn');
if (plHealthBtn) plHealthBtn.addEventListener('click', checkPartLookupBridge);
const plClearBtn = document.getElementById('plClearBtn');
if (plClearBtn) plClearBtn.addEventListener('click', clearPartLookup);
const plLabelPrinter = document.getElementById('plLabelPrinter');
if (plLabelPrinter) plLabelPrinter.addEventListener('change', savePartLookupPrinter);
const plPartInput = document.getElementById('plPart');
if (plPartInput) plPartInput.addEventListener('keydown', e => { if (e.key === 'Enter') lookupPartLookup(); });
const kbHealthBtn = document.getElementById('kbHealthBtn');
if (kbHealthBtn) kbHealthBtn.addEventListener('click', checkKanbanBridge);
const kbAnalyzeBtn = document.getElementById('kbAnalyzeBtn');
if (kbAnalyzeBtn) kbAnalyzeBtn.addEventListener('click', () => analyzeKanban());
const kbClearBtn = document.getElementById('kbClearBtn');
if (kbClearBtn) kbClearBtn.addEventListener('click', clearKanban);
const kbExportReorderBtn = document.getElementById('kbExportReorderBtn');
if (kbExportReorderBtn) kbExportReorderBtn.addEventListener('click', () => exportKanbanCsv('NEEDS_REORDER'));
const kbExportAllBtn = document.getElementById('kbExportAllBtn');
if (kbExportAllBtn) kbExportAllBtn.addEventListener('click', () => exportKanbanCsv('ALL'));
const kbPasteInput = document.getElementById('kbPaste');
if (kbPasteInput) kbPasteInput.addEventListener('keydown', e => { if (e.ctrlKey && e.key === 'Enter') analyzeKanban(); });
['kbFilterAction','kbSearch'].forEach(id => { const el=document.getElementById(id); if(el) el.addEventListener(id==='kbSearch'?'input':'change', renderKanbanRows); });
const pplValidateBtn = document.getElementById('pplValidateBtn');
if (pplValidateBtn) pplValidateBtn.addEventListener('click', validateSinglePrintPart);
const pplPrintBtn = document.getElementById('pplPrintBtn');
if (pplPrintBtn) pplPrintBtn.addEventListener('click', printSinglePartLabel);
const pplPrepareMassBtn = document.getElementById('pplPrepareMassBtn');
if (pplPrepareMassBtn) pplPrepareMassBtn.addEventListener('click', prepareMassPartLabels);
const pplPrintMassBtn = document.getElementById('pplPrintMassBtn');
if (pplPrintMassBtn) pplPrintMassBtn.addEventListener('click', printMassPartLabels);
const pplClearBtn = document.getElementById('pplClearBtn');
if (pplClearBtn) pplClearBtn.addEventListener('click', clearPrintPartModule);
const pplPartInput = document.getElementById('pplPart');
if (pplPartInput) pplPartInput.addEventListener('keydown', e => { if (e.key === 'Enter') validateSinglePrintPart().then(() => document.getElementById('pplQty').focus()).catch(()=>{}); });
const pplQtyInput = document.getElementById('pplQty');
if (pplQtyInput) pplQtyInput.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('pplCopies').focus(); });
const pplCopiesInput = document.getElementById('pplCopies');
if (pplCopiesInput) pplCopiesInput.addEventListener('keydown', e => { if (e.key === 'Enter') printSinglePartLabel(); });
const dmLimitInput = document.getElementById('dmLimit');
if (dmLimitInput) dmLimitInput.addEventListener('keydown', e => { if (e.key === 'Enter') searchPartDemands(); });
['labelPrinter', 'dmLabelPrinter'].forEach(id => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('change', saveLabelSettings);
    el.addEventListener('blur', saveLabelSettings);
  }
});
['labelCopies', 'dmLabelCopies'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', saveLabelSettings);
});
['autoPrintAfterIssue', 'dmAutoPrintAfterIssue'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', saveLabelSettings);
});
['iFilterPart', 'iFilterLocation', 'iFilterDesc'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', () => renderIssue(S.ip || []));
});
['iFilterStatus', 'iSortLocation'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', () => { S.issueSort = { key: 'none', dir: 'none' }; renderIssue(S.ip || []); });
});
document.getElementById('iClearFilters').addEventListener('click', clearIssueFilters);
document.getElementById('customLabelCancelBtn').addEventListener('click', closeCustomLabelModal);
const customLabelCloseBtn = document.getElementById('customLabelCloseBtn');
if (customLabelCloseBtn) customLabelCloseBtn.addEventListener('click', closeCustomLabelModal);
document.getElementById('customLabelPrintBtn').addEventListener('click', printCustomLabelFromModal);
document.getElementById('customLabelModal').addEventListener('click', e => { if (e.target.id === 'customLabelModal') closeCustomLabelModal(); });
document.getElementById('customLabelQty').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('customLabelCopies').focus(); });
document.getElementById('customLabelCopies').addEventListener('keydown', e => { if (e.key === 'Enter') printCustomLabelFromModal(); });

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('customLabelModal');
    if (modal && !modal.classList.contains('hidden')) { closeCustomLabelModal(); return; }
    clrAll();
  }
  if (e.altKey && e.key === '1') switchTab('master');
  if (e.altKey && e.key === '2') switchTab('pick');
  if (e.altKey && e.key === '3') switchTab('adjust');
  if (e.altKey && e.key === '5') switchTab('partLookup');
  if (e.altKey && e.key === '6') switchTab('kanban');
  if (e.altKey && e.key === '7') switchTab('printPart');
  if (e.altKey && e.key === '8') switchTab('poReceiving');
  if (S.tab === 'pick' && S.nextPickIndex != null && e.altKey && String(e.key).toLowerCase() === 'l') {
    e.preventDefault();
    printIssueLabelFromIssueIndex(Number(S.nextPickIndex));
  }
  if (S.tab === 'pick' && S.nextPickIndex != null && e.altKey && String(e.key).toLowerCase() === 'i') {
    e.preventDefault();
    issueSingle(Number(S.nextPickIndex));
  }
  if (S.tab === 'pick' && S.nextPickIndex != null && e.altKey && String(e.key).toLowerCase() === 'c') {
    e.preventDefault();
    openCustomLabelModal(Number(S.nextPickIndex));
  }
});

// Startup
updateUserBadge();
initLabelSettings();
initPartLookupPrinter().catch(()=>{});
document.getElementById('dmIssueSelectedBtn').disabled = true;
switchTab('master');



if (tok && usr) { hideLogin(); notifyNativeModulesSession(); } else { showLogin('Sign in with your RF Plus user ID and password.'); }


// ============================================================
//  QX 1.8 — Premium shell: status dots, toolbar title, avatar
//  (presentation only; reuses existing reconnect + bridge health)
// ============================================================
(function premiumShell(){
  const TAB_TITLES = {
    master:'WO Master', pick:'WO Issuing', adjust:'Inventory Adjust',
    partLookup:'Part Lookup',
    kanban:'Kanban', poReceiving:'PO Receiving', printPart:'Print Part Label'
  };

  // Dark-only product: one theme, no saved theme preference or toggle.
  function initTheme(){
    document.documentElement.setAttribute('data-theme', 'dark');
    try { localStorage.removeItem('qx_theme'); } catch(e){}
  }

  function setDot(id, state){ // state: ok | busy | down
    const d = document.getElementById(id);
    if (d) d.className = 'sd ' + state;
  }

  // Event-driven shared RF Plus status for every native module.
  function setRFState(state, message){
    const dotState = state === 'connected' ? 'ok' : state === 'reconnecting' ? 'busy' : 'down';
    setDot('rfDot', dotState);
    const label = document.getElementById('rfStatusLabel');
    const host = document.getElementById('rfStat');
    const labels = {
      connected:'RF Plus', reconnecting:'RF Reconnecting', expired:'RF Session expired',
      'login-required':'RF Login required', failed:'RF Connection failed'
    };
    if (label) label.textContent = labels[state] || 'RF Plus';
    if (host) host.title = message || labels[state] || 'RF Plus';
  }
  window.QXStatus = {
    setRFState,
    bridgeUp(){ setDot('brDot','ok'); },
    bridgeDown(){ setDot('brDot','down'); },
    rfUp(){ setRFState('connected', 'Connected as ' + (typeof usr !== 'undefined' ? usr : '')); },
    rfDown(){ setRFState((typeof tok !== 'undefined' && tok) ? 'failed' : 'login-required'); }
  };
  function refreshRFDot(){ setRFState(typeof rfConnectionState !== 'undefined' ? rfConnectionState : ((typeof tok !== 'undefined' && tok) ? 'connected' : 'login-required')); }

  function setTitle(t){
    const el = document.getElementById('tbTitle');
    if (el && TAB_TITLES[t]) el.textContent = TAB_TITLES[t];
  }
  function setAvatar(){
    const av = document.getElementById('umAvatar');
    if (!av) return;
    const name = (typeof usr !== 'undefined' && usr) ? String(usr) : '';
    av.textContent = name ? name.replace(/[^A-Za-z0-9]/g,'').slice(0,2).toUpperCase() : '–';
  }

  // Reflect login state on the badge wrapper without touching updateUserBadge internals.
  if (typeof window.updateUserBadge === 'function') {
    const _orig = window.updateUserBadge;
    window.updateUserBadge = function(){ _orig.apply(this, arguments); refreshRFDot(); setAvatar(); };
  }

  // RF Plus dot: click to reconnect (silent if token still valid).
  const rf = document.getElementById('rfStat');
  if (rf) rf.addEventListener('click', async () => {
    setDot('rfDot','busy');
    try { await reconnectQuickX(); }
    finally { setAvatar(); }
  });

  // Bridge dot: click to re-check SQL Bridge health.
  const br = document.getElementById('brStat');
  async function checkBridgeDot(){
    setDot('brDot','busy');
    try {
      const res = await fetch(SQL_BRIDGE + '/api/health', { method:'GET' });
      const j = await res.json().catch(() => ({}));
      setDot('brDot', (res.ok && j && j.ok) ? 'ok' : 'down');
    } catch (e) { setDot('brDot','down'); }
  }
  if (br) br.addEventListener('click', checkBridgeDot);

  // Update toolbar title whenever a nav item is clicked (after switchTab runs).
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-tab]');
    if (t) setTitle(t.dataset.tab);
  }, true);

  // Initial paint + a first silent bridge check.
  function init(){
    initTheme();
    refreshRFDot(); setAvatar();
    setTitle((typeof S !== 'undefined' && S.tab) ? S.tab : 'master');
    checkBridgeDot();
    bootstrapRFSession().catch(()=>{});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();


// ============================================================
//  PO Receiving — NATIVE module (QX 1.8)
//  Ported from the former po_receiving iframe app. Reuses the main
//  QuickX RF Plus session (tok/whs/usr), the shared api(), the shared
//  SQL_BRIDGE, toast(), and storage helpers. No own login / bridge /
//  reconnect. All DOM ids are prefixed po_ to avoid collisions.
//  Writes go through RF Plus API only; SQL is read-only.
// ============================================================
const QXPOReceiving = (function () {
  const COMPANY_PO = (typeof COMPANY !== 'undefined') ? COMPANY : 'LIVE';
  const S = { po:'', lines:[], raw:null, busy:false, modal:null, selectedDemandIndex:null, searchType:'po', vendorResults:[] };
  const sessionReceived = new Map();
  let bound = false;

  const $ = id => document.getElementById(id);
  function escp(v){return String(v??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}

  // session persistence (per PO)
  function sessionKeyForPO(po){ return 'po_receiving_session_'+String(usr||'ANON').trim().toUpperCase()+'_'+String(po||'').trim(); }
  function loadSessionForPO(po){
    sessionReceived.clear();
    try{ const raw=sessionStorage.getItem(sessionKeyForPO(po)); if(raw){ const obj=JSON.parse(raw); Object.keys(obj||{}).forEach(k=>sessionReceived.set(k,Number(obj[k])||0)); } }catch(e){}
  }
  function saveSessionForPO(po){
    try{ const obj={}; sessionReceived.forEach((v,k)=>{ if(v) obj[k]=v; }); sessionStorage.setItem(sessionKeyForPO(po), JSON.stringify(obj)); }catch(e){}
  }
  function clearSessionForPO(po){ try{ sessionStorage.removeItem(sessionKeyForPO(po)); }catch(e){} }

  function setStatus(msg,type){const el=$('po_statBar'); if(!el)return; if(!msg){el.classList.add('hidden'); return;} el.textContent=msg; el.className='po-statbar '+(type||'ld'); el.classList.remove('hidden');}
  function debug(obj){const el=$('po_debug'); if(el)el.value=typeof obj==='string'?obj:JSON.stringify(obj,null,2);}
  function poCleanError(msg){ return (typeof cleanError==='function') ? cleanError(msg) : (msg||'Unknown error'); }

  // ---- shared session API (reuse main app api()) ----
  async function poApi(endpoint, body){ return await api(endpoint, body); }
  async function bridgeGet(path){
    try {
      const res = await fetch(SQL_BRIDGE + path, { method:'GET', cache:'no-store' });
      const text = await res.text();
      let data; try { data = text ? JSON.parse(text) : {}; } catch(e){ throw new Error('SQL Bridge returned non-JSON: '+text.slice(0,180)); }
      if(!res.ok || data.ok===false){ throw new Error(data.error || data.message || ('HTTP '+res.status)); }
      if (window.QXStatus) window.QXStatus.bridgeUp();
      return data;
    } catch (e) {
      if (window.QXStatus) window.QXStatus.bridgeDown();
      throw e;
    }
  }

  function poDate(v){
    if(!v)return '—';
    try{const d=new Date(v); if(Number.isNaN(d.getTime()))return String(v).slice(0,10); return d.toLocaleDateString();}catch(e){return String(v).slice(0,10);}
  }
  function hideVendorResults(){
    S.vendorResults=[];
    const host=$('po_vendorResults');
    if(host){host.classList.add('hidden');host.innerHTML='';}
  }
  function renderVendorResults(data){
    const host=$('po_vendorResults'); if(!host)return;
    const rows=Array.isArray(data&&data.rows)?data.rows:[];
    S.vendorResults=rows;
    const warning=data&&data.warning?`<div class="po-vendor-empty">${escp(data.warning)}</div>`:'';
    if(!rows.length){host.innerHTML=`<div class="po-vendor-results-head"><span>Open PO Results</span><button class="btn btn-ghost btn-sm" data-po-vendor-close>Close</button></div>${warning}<div class="po-vendor-empty">No open Released POs found for this vendor.</div>`;host.classList.remove('hidden');return;}
    host.innerHTML=`<div class="po-vendor-results-head"><span>${rows.length} open PO${rows.length===1?'':'s'} found</span><button class="btn btn-ghost btn-sm" data-po-vendor-close>Close</button></div>${warning}<div class="po-vendor-list">${rows.map((r,i)=>{
      const po=String(r.POId??r.poId??'').trim();
      const vid=String(r.VendorId??r.vendorId??'').trim();
      const vn=String(r.VendorName??r.vendorName??'').trim();
      const lines=Number(r.OpenLineCount??r.openLineCount??0)||0;
      const qty=Number(r.TotalOpenQty??r.totalOpenQty??0)||0;
      return `<button type="button" class="po-vendor-result" data-po-vendor-index="${i}"><span class="po-vendor-result-top"><span class="po-vendor-po">PO ${escp(po)}</span><span class="po-pill open">${lines} open line${lines===1?'':'s'}</span></span><span class="po-vendor-name" title="${escp(vn||vid)}">${escp(vn||'Vendor '+vid)}</span><span class="po-vendor-meta"><span>ID: ${escp(vid||'—')}</span><span>PO Date: ${escp(poDate(r.PODate??r.poDate))}</span><span>Open Qty: ${escp(qty)}</span><span>Earliest Due: ${escp(poDate(r.EarliestDueDate??r.earliestDueDate))}</span></span></button>`;
    }).join('')}</div>`;
    host.classList.remove('hidden');
  }
  function setPOSearchType(type){
    S.searchType=type==='vendor'?'vendor':'po';
    const vendor=S.searchType==='vendor';
    $('po_searchType').value=S.searchType;
    $('po_searchLabel').textContent=vendor?'Vendor Name or ID':'Purchase Order';
    $('po_poInput').placeholder=vendor?'partial vendor name or Vendor ID':'e.g. 74633';
    $('po_loadPoBtn').textContent=vendor?'🔎 SEARCH OPEN POs':'▶ LOAD PO';
    if(!vendor)hideVendorResults();
  }
  async function searchOpenPOsByVendor(){
    const q=$('po_poInput').value.trim();
    if(!q){toast('Enter a Vendor Name or Vendor ID.','error');return;}
    setStatus('Searching open Released POs for '+q+'...','ld');
    $('po_loadPoBtn').disabled=true;
    try{
      const data=await bridgeGet('/api/po/vendor-search?q='+encodeURIComponent(q));
      renderVendorResults(data);
      setStatus(`${(data.rows||[]).length} open PO result(s) found for ${q}.`,'ok');
    }catch(e){hideVendorResults();setStatus('Vendor PO search failed: '+poCleanError(e.message),'err');toast('Vendor PO search failed: '+poCleanError(e.message),'error',8000);}
    finally{$('po_loadPoBtn').disabled=false;}
  }
  async function performPOSearch(){
    if(S.searchType==='vendor')return searchOpenPOsByVendor();
    return loadPO();
  }

  function demandComponentOptions(extra={}){
    return Object.assign({
      panelId:'po_demandPanel',
      hostId:'po_demandHost',
      summaryId:'po_demandSummary',
      getPrinter:()=>String(($('po_printerSel') && $('po_printerSel').value) || DEFAULT_LABEL_PRINTER).trim().toUpperCase(),
      getCopies:()=>1,
      updatePrintStatus:(msg,isErr)=>setStatus(msg,isErr?'err':'ok')
    }, extra || {});
  }
  function clearSelectedDemand(){
    S.selectedDemandIndex = null;
    QXActiveDemand.configure('poReceiving', demandComponentOptions());
    QXActiveDemand.clear('poReceiving');
  }
  async function selectDemandForLine(i){
    const x = S.lines[i];
    if(!x) return;
    S.selectedDemandIndex = i;
    renderLines();
    if(!String(x.part||'').trim()){
      QXActiveDemand.showNoPart('poReceiving', demandComponentOptions({description:x.desc||''}));
      return;
    }
    await QXActiveDemand.load('poReceiving', demandComponentOptions({
      partId:x.part,
      description:x.desc||''
    }));
  }

  function firstVal(o,keys,def=''){if(!o||typeof o!=='object')return def; for(const k of keys){if(o[k]!==undefined&&o[k]!==null&&o[k]!=='')return o[k];} const map={}; Object.keys(o).forEach(k=>map[k.toLowerCase()]=k); for(const k of keys){const real=map[String(k).toLowerCase()]; if(real&&o[real]!==undefined&&o[real]!==null&&o[real]!=='')return o[real];} return def;}
  function printerIdFromDefault(resp, fallback){ const data=resp && (resp.Data||resp.data||resp); const p=data && (data.printer||data.Printer||data); return String(firstVal(p,['ID','Id','id','PrinterId','printerId'],fallback||'')).trim(); }
  function flattenArrays(obj,out=[]){if(Array.isArray(obj)){obj.forEach(x=>flattenArrays(x,out)); return out;} if(obj&&typeof obj==='object'){const keys=Object.keys(obj).map(x=>x.toLowerCase()); if(keys.some(k=>['part','partid','line','lineno','lineid','linenumber','poid','qty','quantity','openqty','receivedqty'].includes(k)))out.push(obj); for(const v of Object.values(obj))if(v&&typeof v==='object')flattenArrays(v,out);} return out;}
  function cleanLocation(v){const s=String(v??'').trim(); if(!s||s==='—'||s==='-'||s.toLowerCase()==='null'||s.toLowerCase()==='undefined')return ''; return s.toUpperCase();}
  function keyForLine(x){return [x.po,x.line,x.deliveryLine,x.part].join('|');}
  function normalizeLine(x,fallbackPO){
    const ordered=Number(firstVal(x,['UserOrderQty','OrderQty','OrderedQty','Quantity','Qty','POQty','PurchaseQty','LineQty'],0))||0;
    const recVals=['UserReceivedQty','TotalUserReceivedQty','TotalReceivedQty','ReceivedQty','RecvQty','QtyReceived','Received','AlreadyReceivedQty'].map(k=>Number(firstVal(x,[k],0))||0);
    const rec=Math.max(0,...recVals);
    const remainingRaw=firstVal(x,['RemainingQty','OpenQty','BalanceQty','DueQty','QtyRemaining','QtyOpen'],null);
    let remaining=remainingRaw===null?Math.max(0,ordered-rec):(Number(remainingRaw)||0);
    if(ordered>0 && rec>0) remaining=Math.max(0, ordered-rec);
    const primaryLoc=cleanLocation(firstVal(x,['PrimaryLocID','PrimaryLocationId','PrimaryLocation','PrimaryLoc','PrimaryBin','DefaultLocation','DefaultLocationId'],''));
    const receivedLoc=cleanLocation(firstVal(x,['ReceivedLocID','ReceivedLocation','ReceiverLocation','Location','Loc','WarehouseLocation','ToLocation','LocationId','locationId','ToLocationId','toLocationId'],''));
    const line={raw:x,po:String(firstVal(x,['PurchaseOrder','PurchaseOrderId','POId','POID','PONumber','PO','OrderId'],fallbackPO||'')).trim(),line:String(firstVal(x,['Line','LineNo','LineId','LineNumber','POLine','POLineNo'],'')).trim(),deliveryLine:String(firstVal(x,['DeliveryLineNo','DelLineNo','DeliveryLine','DEL_SCHED_LINE_NO'],'')).trim(),receiverId:String(firstVal(x,['ReceiverId','ReceiverID','Receiver'],'')).trim(),part:String(firstVal(x,['PartId','PartID','Part','PartNumber','Item','ItemId'],'')).trim(),vendorPart:String(firstVal(x,['VendorPartID','VendorPartId','VendorPart','VendPartID','VendPartId','VendPart','VendorPartNumber','SupplierPartID'],'')).trim(),mfgPart:String(firstVal(x,['MfgPartID','MfgPartId','MFG_PART_ID','Mfg_Part_ID','ManufacturerPartID','ManufacturerPartId','ManufacturerPart'],'')).trim(),desc:String(firstVal(x,['Description','PartDescription','Desc','ItemDescription'],'')).trim(),userDefined1:String(firstVal(x,['UserDefined1','USER_1','User_1','colUSER_1'],'')).trim(),ordered,received:rec,remaining,uom:String(firstVal(x,['UOM','Uom','UnitOfMeasure','UM','PartUOM'],'EA')).trim().toUpperCase(),location:receivedLoc || primaryLoc,primaryLocation:primaryLoc,warehouse:String(firstVal(x,['Warehouse','WarehouseId','LineWarehouse','Whs','PrimaryWhsID'],whs)).trim(),trace:String(firstVal(x,['Trace','TraceId','TraceID','ConsignTraceId','RecvedConsignTraceId'],'')).trim()}; line.isNullPartLine=!line.part; if(line.isNullPartLine && !line.location) line.location='RECV';
    const sess=sessionReceived.get(keyForLine(line))||0; line.sessionReceived=sess; return line;
  }
  function effectiveReceived(x){return Math.max(Number(x&&x.received)||0, Number(x&&x.sessionReceived)||0);}
  function effectiveRemaining(x){const ordered=Number(x&&x.ordered)||0; if(ordered>0)return Math.max(0, ordered-effectiveReceived(x)); return Math.max(0, Number(x&&x.remaining)||0);}
  function dedupeLines(arr){const seen=new Set(); const out=[]; for(const x of arr){const key=keyForLine(x); if(seen.has(key))continue; seen.add(key); out.push(x);} return out;}

  async function loadPOFromSql(po){
    const data = await bridgeGet('/api/po?poId=' + encodeURIComponent(po));
    const rows = Array.isArray(data.lines) ? data.lines : [];
    return { raw:data, lines: rows.map(x=>normalizeLine(x, po)) };
  }

  async function loadPO(){
    const po=$('po_poInput').value.trim(); if(!po){toast('Enter PO number.','error'); return;}
    setPOSearchType('po'); hideVendorResults();
    clearSelectedDemand();
    S.po=po; setStatus('Loading PO '+po+' from SQL Bridge...','ld'); loadSessionForPO(po);
    try{
      const sql=await loadPOFromSql(po);
      S.raw=sql.raw;
      S.lines=dedupeLines(sql.lines).map(l=>{ if(!cleanLocation(l.location)) l.location=cleanLocation(l.primaryLocation) || (l.isNullPartLine?'RECV':''); return l; });
      $('po_poMeta').textContent='Loaded from QX SQL Bridge. Receive/Return/Update still use RF Plus API.';
      $('po_updatePoBtn').disabled=!S.lines.length; const rab=$('po_receiveAllBtn'); if(rab) rab.disabled=!S.lines.some(x=>effectiveRemaining(x)>0);
      debug({endpoint:'SQL /api/po',poId:po,count:S.lines.length,sample:S.lines.slice(0,5)});
      renderLines(); setStatus('Loaded '+S.lines.length+' line(s) for PO '+po+' from SQL.','ok'); return;
    }catch(sqlErr){
      const sqlMsg=poCleanError(sqlErr.message||String(sqlErr));
      debug({sqlBridgeError:String(sqlErr.message||sqlErr), note:'PO SQL load failed before RF Plus fallback.'});
      if(!tok){ setStatus('SQL Bridge PO load failed: '+sqlMsg+'. RF Plus is not connected, so fallback was skipped.', 'err'); toast('❌ SQL Bridge PO load failed. Check Bridge dot then try again.','error',8000); return; }
      setStatus('SQL Bridge PO load failed: '+sqlMsg+'. Trying RF Plus fallback...', 'err');
    }
    try{
      const data=await poApi('/api/POReceiving/validatePOAndGetLines',{POId:po,PartId:null});
      S.raw=data; let lines=flattenArrays(data).map(x=>normalizeLine(x,po)).filter(x=>!x.po||x.po===po||String(x.po).includes(po));
      S.lines=dedupeLines(lines).map(l=>{ if(!cleanLocation(l.location)) l.location=cleanLocation(l.primaryLocation) || (l.isNullPartLine?'RECV':''); return l; });
      $('po_poMeta').textContent='Loaded with RF Plus fallback. Location auto-selects PrimaryLocID when available.';
      $('po_updatePoBtn').disabled=!S.lines.length; const rab=$('po_receiveAllBtn'); if(rab) rab.disabled=!S.lines.some(x=>effectiveRemaining(x)>0);
      debug({endpoint:'/api/POReceiving/validatePOAndGetLines',count:S.lines.length,sample:S.lines.slice(0,5)});
      renderLines(); setStatus('Loaded '+S.lines.length+' line(s) for PO '+po+' with RF Plus fallback.','ok');
    }catch(e){setStatus('PO load failed: '+poCleanError(e.message),'err'); toast('❌ '+poCleanError(e.message),'error',8000); debug(String(e.message||e));}
  }

  function getFilteredLines(){
    const pf=$('po_partFilter').value.trim().toLowerCase(); const keyword=$('po_descFilter').value.trim().toLowerCase(); const sf=$('po_statusFilter').value;
    return S.lines.map((x,i)=>({x,i})).filter(({x})=>{
      if(pf&&!String(x.part||'').toLowerCase().includes(pf))return false;
      if(keyword){
        const matchesKeyword=[x.desc,x.vendorPart,x.mfgPart].some(v=>String(v||'').toLowerCase().includes(keyword));
        if(!matchesKeyword)return false;
      }
      const open=effectiveRemaining(x)>0; const rec=effectiveReceived(x)>0; if(sf==='open'&&!open)return false; if(sf==='received'&&!rec)return false; if(sf==='done'&&open)return false; return true;});
  }
  function statusPill(x){const rem=effectiveRemaining(x); const rec=effectiveReceived(x); if(rem<=0)return'<span class="po-pill po-p-done">DONE</span>'; if(rec>0)return'<span class="po-pill po-p-rec">PARTIAL</span>'; return '<span class="po-pill po-p-open">OPEN</span>';}
  function getLocation(x){ return cleanLocation(x && x.location) || cleanLocation(x && x.primaryLocation) || ((x && !x.part) ? 'RECV' : ''); }
  function renderLines(){
    const tb=$('po_lineTb'); if(!tb)return; const rows=getFilteredLines(); const lc=$('po_lineCount'); if(lc) lc.textContent=rows.length+' shown / '+S.lines.length+' total';
    if(!rows.length){tb.innerHTML='<tr><td colspan="11" class="po-empty">'+(S.lines.length?'No matching PO lines.':'No PO loaded yet.')+'</td></tr>'; return;}
    tb.innerHTML=rows.map(({x,i})=>{
      const rec=effectiveReceived(x); const rem=effectiveRemaining(x); const loc=getLocation(x); const canOpen=rem>0; const sess=Number(x.sessionReceived)||0; const canReturn=sess>0 || (rec>0 && rem>0);
      const selected = S.selectedDemandIndex === i;
      const partButton = x.part
        ? `<button type="button" class="po-part-link" data-po-demand-part data-i="${i}" title="Show active demand for ${escp(x.part)}">${escp(x.part)}</button>`
        : `<button type="button" class="po-part-link po-part-empty" data-po-demand-part data-i="${i}" title="This line has no Part ID">No Part ID</button>`;
      return `<tr class="${selected?'po-selected-line':''}" data-po-line-index="${i}"><td class="po-mono">${escp(x.line||'—')}</td><td class="po-part">${partButton}</td><td class="po-vend" title="${escp(x.vendorPart||'')}">${escp(x.vendorPart||'—')}</td><td class="po-descCell" title="${escp(x.desc)}">${escp(x.desc||'')}</td><td class="po-udfCell" title="${escp(x.userDefined1||'')}">${escp(x.userDefined1||'—')}</td><td style="text-align:center;font-weight:900">${escp(rem||0)}</td><td style="text-align:center;font-weight:900;color:var(--success)">${escp(rec||'—')}</td><td>${escp(x.uom)}</td><td class="po-loc">${escp(loc)}</td><td>${statusPill(x)}</td><td class="po-actionCell"><div class="po-actions"><button class="btn btn-success btn-sm po-allBtn" data-i="${i}" ${canOpen?'':'disabled'}>ALL</button><button class="btn btn-primary btn-sm po-partialBtn" data-i="${i}" ${canOpen?'':'disabled'}>PARTIAL</button><button class="btn btn-danger btn-sm po-returnBtn" data-i="${i}" ${canReturn?'':'disabled'}>↩ RETURN</button><button class="btn btn-print btn-sm po-labelBtn" data-i="${i}">LABEL</button><button class="btn btn-ghost btn-sm po-labelPlusBtn" data-i="${i}">LABEL+</button></div></td></tr>`;
    }).join('');
  }
  function renderLinesSafe(){try{renderLines();}catch(e){console.error(e);}}

  function lineNoPayload(x){ return Number(x.line)||x.line; }
  function deliveryPayload(x){ return x.deliveryLine ? Number(x.deliveryLine) : null; }
  function tracePayload(x){ return x.trace || null; }
  function receivePayload(x, qty){ return { warehouseId: whs, POId: String(x.po || S.po), lineNo: lineNoPayload(x), deliveryLineNo: deliveryPayload(x), traceId: tracePayload(x), partId: x.part, LPN: null, pieceTrackingPieces: '', pieceTrackingProperties: {length:null,width:null,height:null}, qty: String(qty), locationId: getLocation(x), assignToDemand: null }; }

  async function preValidateLine(x, qty, loc){
    const lineNo=lineNoPayload(x); const deliveryLineNo=deliveryPayload(x); const traceId=tracePayload(x);
    const isNullPart = !String(x.part||'').trim();
    loc = cleanLocation(loc) || getLocation(x) || (isNullPart ? 'RECV' : '');
    if(!loc) throw new Error('Receiving location is empty. RF Plus needs a real bin location.');
    if(isNullPart){ x.part=''; x.location=loc||'RECV'; await poApi('/api/POReceiving/validateQty',{POId:x.po,lineNo,deliveryLineNo,traceId,partId:'',qty:String(qty)}); return x.location; }
    try{await poApi('/api/inventoryTransfer/IsPartInventoryLocked',{partId:x.part});}catch(e){}
    await poApi('/api/POReceiving/validatePart',{POId:x.po,lineNo,partId:x.part});
    try{await poApi('/api/POReceiving/GetPOLineSpec',{POId:x.po,lineNo});}catch(e){}
    await poApi('/api/POReceiving/validateQty',{POId:x.po,lineNo,deliveryLineNo,traceId,partId:x.part,qty:String(qty)});
    try{
      const locResp=await poApi('/api/issuing/getPartLocations',{partId:x.part,showAnyQty:true,warehouseId:whs,isUseRFPlusTrace:false,isUseMixedTrace:false});
      const arr=Array.isArray(locResp)?locResp:flattenArrays(locResp);
      const primary=arr.find(r=>String(firstVal(r,['PrimaryLocation','primaryLocation'],'')).toLowerCase()==='true');
      const found=arr.find(r=>cleanLocation(firstVal(r,['LocationId','locationId','Location','Loc'],''))===loc) || primary || arr[0];
      const foundLoc=cleanLocation(found && firstVal(found,['LocationId','locationId','Location','Loc'],''));
      if(foundLoc){x.location=foundLoc; loc=foundLoc;}
    }catch(e){}
    try{await poApi('/api/inventoryTransfer/NeedSetPartLocationStatus',{partId:x.part,locationId:loc,warehouseId:null});}catch(e){}
    const valid=await poApi('/api/inventoryTransfer/validateLocationAndCreatePartLocation',{partId:x.part,toLocationId:loc,toWarehouseId:whs,isCreateHoldLocation:false,locStatus:''});
    const confirmed=cleanLocation(firstVal(valid && (valid.Data||valid.data||valid),['LocationId','locationId'],''));
    if(confirmed){x.location=confirmed; loc=confirmed;}
    return loc;
  }

  async function receiveLine(i, qty, opts={}){
    const x=S.lines[i]; if(!x)return; qty=Number(qty); if(!qty||qty<=0){toast('Enter receive qty.','error'); return;} const openQty=effectiveRemaining(x); if(qty>openQty){toast('Qty is more than open qty. Refreshing PO lines...','error'); await loadPO(); return;}
    let loc=getLocation(x); if(!loc){toast('No receiving location found for this line.','error'); return;} if(!opts.skipConfirm && !confirm(`Receive ${qty} ${x.uom} for PO ${x.po} line ${x.line} (${x.part}) into ${loc}?`))return;
    setBusy(true); setStatus('Receiving line '+x.line+'...', 'ld');
    try{
      loc = await preValidateLine(x, qty, loc); const body=receivePayload(x, qty); if(!body.locationId) throw new Error('Receiving location is empty.');
      const data=await poApi('/api/POReceiving/processReceiving',body);
      const k=keyForLine(x); sessionReceived.set(k,(sessionReceived.get(k)||0)+qty); saveSessionForPO(x.po||S.po); x.sessionReceived=sessionReceived.get(k); x.received=effectiveReceived(x); x.remaining=effectiveRemaining(x); x.location=loc;
      debug({endpoint:'/api/POReceiving/processReceiving',body,response:data}); renderLines(); setStatus(`Received ${qty} on line ${x.line}.`, 'ok'); toast('✅ Received line '+x.line,'success');
    }catch(e){setStatus('Receive failed: '+poCleanError(e.message),'err'); toast('❌ '+poCleanError(e.message),'error',8000); debug(String(e.message||e)); if(String(e.message||'').toLowerCase().includes('over receive')){try{await loadPO();}catch(_){}}}
    finally{setBusy(false);}
  }
  async function returnLine(i, qty){
    const x=S.lines[i]; if(!x)return; const rec=(Number(x.sessionReceived)||0) || (effectiveRemaining(x)>0 ? effectiveReceived(x) : 0); qty=Number(qty||rec); if(!rec){toast('Nothing available to return before UPDATE ORDER.','error'); return;}
    if(qty!==rec){toast('RF Plus captured return endpoint is line-level; it will return the received line amount.','info',7000);}
    if(!confirm(`Return received PO line ${x.line} (${x.part}) back to PO?\n\nRF Plus endpoint: receivingAdjust/adjustOffProcess`))return;
    setBusy(true); setStatus('Returning line '+x.line+' back to PO...', 'ld');
    try{
      const body={POId:x.po,lineNo:Number(x.line)||x.line,partId:x.part}; const data=await poApi('/api/receivingAdjust/adjustOffProcess',body);
      sessionReceived.set(keyForLine(x),0); saveSessionForPO(x.po||S.po); x.remaining=Number(x.remaining||0)+rec; x.sessionReceived=0;
      await loadPO().catch(()=>renderLines()); debug({endpoint:'/api/receivingAdjust/adjustOffProcess',body,response:data}); setStatus('Returned line '+x.line+' back to PO.', 'ok'); toast('✅ Returned line '+x.line,'success');
    }catch(e){setStatus('Return failed: '+poCleanError(e.message),'err'); toast('❌ '+poCleanError(e.message),'error',8000); debug(String(e.message||e));}
    finally{setBusy(false);}
  }
  async function printLabel(i, qty, copies){
    const x=S.lines[i]; if(!x)return; qty=Number(qty||x.sessionReceived||x.remaining||1); copies=Number(copies||1); if(!qty||qty<=0){toast('Enter label qty.','error'); return;} if(copies<1)copies=1; if(copies>20&&!confirm('Print '+copies+' copies?'))return;
    const loc=getLocation(x); if(!loc){toast('No receiving location found for label.','error'); return;} const printer=$('po_printerSel').value || 'LABELPRINTER';
    setBusy(true); setStatus('Printing PO label for line '+x.line+'...', 'ld');
    try{
      await poApi('/api/printing/GetCustomLabelFields/',{label_type:'PO Receiving'}).catch(()=>{}); await poApi('/api/printing/GetLabelPrinters',{warehouseId:whs}).catch(()=>{}); await poApi('/api/printing/GetUserDefaultLabelPrinter',{warehouseId:whs}).catch(()=>{});
      const body={POId:x.po,lineNo:Number(x.line)||x.line,partId:x.part,traceId:tracePayload(x),qty:String(qty),printerId:printer,numOfCopies:String(copies),customLabelFields:[],LocationId:loc};
      const last=await poApi('/api/printing/PrintReceivingLabels',body); debug({endpoint:'/api/printing/PrintReceivingLabels',body,response:last}); setStatus('PO label sent. Qty '+qty+' · Copies '+copies+'.','ok'); toast('✅ PO label printed','success');
    }catch(e){setStatus('Label print failed: '+poCleanError(e.message),'err'); toast('❌ '+poCleanError(e.message),'error',8000); debug(String(e.message||e));}
    finally{setBusy(false);}
  }
  async function printLabelNoBusy(x, qty, copies){
    const loc=getLocation(x); if(!loc) throw new Error('No receiving location found for label.'); const printer=$('po_printerSel').value || 'LABELPRINTER';
    const body={POId:x.po,lineNo:Number(x.line)||x.line,partId:x.part,traceId:tracePayload(x),qty:String(qty),printerId:printer,numOfCopies:String(copies||1),customLabelFields:[],LocationId:loc};
    return await poApi('/api/printing/PrintReceivingLabels',body);
  }
  async function updateOrder(){
    if(!S.po){toast('Load PO first.','error'); return;} const recTotal=Array.from(sessionReceived.values()).reduce((a,b)=>a+Number(b||0),0);
    if(!confirm(`UPDATE ORDER for PO ${S.po}?\n\nThis posts receiving to Visual and prints receiver report.\nReceived this session: ${recTotal}`))return;
    setBusy(true); setStatus('Updating PO '+S.po+'...', 'ld');
    try{
      const finish=await poApi('/api/POReceiving/finishPO',{POId:S.po,LeaveOpen:true,VendorPacklistID:'',VendorPacklistDate:''});
      const receiverId=String(firstVal(finish && (finish.Data||finish.data||finish),['ReceiverId','receiverId'],''));
      let another=null; try{another=await poApi('/api/POReceiving/linesAnotherSite',{POId:S.po});}catch(e){}
      try{await poApi('/api/printing/GetReportPrinters',{warehouseId:whs});}catch(e){}
      const defReport=await poApi('/api/printing/GetUserDefaultReportPrinter',{warehouseId:whs}).catch(()=>null);
      const printerId=printerIdFromDefault(defReport,'RECEIVER SLIPS') || 'RECEIVER SLIPS';
      const report=receiverId?await poApi('/api/printing/PrintReceivingReports',{POId:S.po,receiverId,printerId,numOfCopies:1}):null;
      debug({finishPO:finish,receiverId,linesAnotherSite:another,PrintReceivingReports:report}); setStatus('PO '+S.po+' updated and receiver report sent.', 'ok'); toast('✅ UPDATE ORDER complete','success',7000);
      clearSessionForPO(S.po); await loadPO();
    }catch(e){setStatus('Update Order failed: '+poCleanError(e.message),'err'); toast('❌ '+poCleanError(e.message),'error',9000); debug(String(e.message||e));}
    finally{setBusy(false);}
  }
  async function receiveAllWithLabels(){
    if(!S.lines.length){toast('Load PO first.','error'); return;}
    const open=S.lines.map((x,i)=>({x,i,qty:effectiveRemaining(x)})).filter(r=>r.qty>0);
    if(!open.length){toast('No open PO lines to receive.','info'); return;}
    const copiesRaw=prompt(`Receive all open lines for PO ${S.po} and print labels?\n\nOpen lines: ${open.length}\nEnter label copies for each line:`, '1'); if(copiesRaw===null)return;
    let copies=Number(copiesRaw||1); if(!copies||copies<1)copies=1; if(copies>20&&!confirm(`Print ${copies} copies for each of ${open.length} lines?`))return;
    if(!confirm(`FINAL CHECK\n\nReceive ALL open quantities for PO ${S.po} and print labels for every line?\nLines: ${open.length}\nLabel copies per line: ${copies}`))return;
    setBusy(true); let ok=0, fail=0; const errors=[]; setStatus(`Receiving all ${open.length} line(s)...`, 'ld');
    for(const r of open){
      const x=r.x, qty=r.qty; let loc=getLocation(x);
      try{
        if(!loc) throw new Error('Receiving location is empty.'); loc = await preValidateLine(x, qty, loc); const body=receivePayload(x, qty); if(!body.locationId) throw new Error('Receiving location is empty.');
        await poApi('/api/POReceiving/processReceiving',body);
        const k=keyForLine(x); sessionReceived.set(k,(sessionReceived.get(k)||0)+qty); saveSessionForPO(x.po||S.po); x.sessionReceived=sessionReceived.get(k); x.received=effectiveReceived(x); x.remaining=effectiveRemaining(x); x.location=loc;
        await printLabelNoBusy(x, qty, copies); ok++; setStatus(`Receive all progress: ${ok}/${open.length}`, 'ld');
      }catch(e){fail++; errors.push(`Line ${x.line} ${x.part}: ${poCleanError(e.message)}`);}
    }
    renderLines(); setBusy(false);
    if(fail){setStatus(`Receive all completed with ${fail} error(s). ${ok} line(s) received.`, 'err'); debug({ok,fail,errors}); toast(`⚠️ ${ok} received, ${fail} failed`,'error',9000);}
    else{setStatus(`Received all ${ok} line(s) and printed labels.`, 'ok'); toast(`✅ Received all ${ok} line(s) + labels`,'success',7000);}
  }

  function setBusy(v){S.busy=!!v; const scope=$('tabPOReceiving'); if(!scope)return; scope.querySelectorAll('button,input,select').forEach(el=>{ if(el.closest('.modal-overlay'))return; el.disabled=!!v; }); document.querySelectorAll('#po_qtyModal button,#po_qtyModal input').forEach(el=>{el.disabled=false;}); if(!v){renderLines(); $('po_updatePoBtn').disabled=!S.lines.length; const rab=$('po_receiveAllBtn'); if(rab) rab.disabled=!S.lines.some(x=>effectiveRemaining(x)>0);}}
  function clearAll(){ if(S.po) clearSessionForPO(S.po); clearSelectedDemand(); S.po=''; S.lines=[]; S.raw=null; sessionReceived.clear(); $('po_poInput').value=''; setPOSearchType('po'); hideVendorResults(); $('po_poMeta').textContent='Load a PO. Use ALL / PARTIAL / RETURN / LABEL directly from each line.'; $('po_updatePoBtn').disabled=true; const rab=$('po_receiveAllBtn'); if(rab) rab.disabled=true; debug(''); setStatus('', ''); renderLines();}

  function openQtyModal(kind, i){
    const x=S.lines[i]; if(!x)return; const m=$('po_qtyModal'); const title=$('po_modalTitle'); const info=$('po_modalInfo'); const input=$('po_modalQty'); const ok=$('po_modalOk'); const hint=$('po_modalHint'); const copiesBlock=$('po_copiesBlock'); const copiesInput=$('po_modalCopies'); const qtyLabel=$('po_modalQtyLabel');
    const rec=effectiveReceived(x); const rem=effectiveRemaining(x); const def=kind==='partial'?(rem||1):kind==='return'?(((Number(x.sessionReceived)||0)||(effectiveRemaining(x)>0?effectiveReceived(x):0))||1):((Number(x.sessionReceived)||0)||rem||1);
    title.textContent=kind==='partial'?'PARTIAL RECEIVE':kind==='return'?'RETURN RECEIVED QTY':'LABEL+'; qtyLabel.textContent=kind==='label'?'Label Qty':'Receive Qty';
    info.innerHTML=`<b>PO ${escp(x.po)} · Line ${escp(x.line)}</b> · <span class="po-part">${escp(x.part)}</span><br>${escp(x.desc)}<br>Open <b>${escp(rem)} ${escp(x.uom)}</b> · Rec'd <b>${escp(rec)}</b> · Location <b>${escp(getLocation(x))}</b>`;
    input.value=def; copiesInput.value='1'; copiesBlock.classList.toggle('hidden', kind!=='label');
    hint.textContent=kind==='return'?'Return uses RF Plus Adjust Order endpoint and returns the received line back to PO.':kind==='label'?'Print one-off labels with different label qty and copies.':'Receive only part of the open quantity for this PO line.';
    ok.textContent=kind==='partial'?'Receive Partial':kind==='return'?'Return to PO':'Print Label+'; ok.className='btn '+(kind==='return'?'btn-danger':'btn-primary');
    S.modal={kind,i}; m.classList.remove('hidden'); setTimeout(()=>{input.focus(); input.select();},50);
  }
  function closeQtyModal(){$('po_qtyModal').classList.add('hidden'); S.modal=null;}
  function changeInputNumber(id, delta, min=0){const input=$(id); const n=Number(input.value||0)+delta; input.value=Math.max(min,n); input.focus(); input.select();}
  function changeModalQty(delta){changeInputNumber('po_modalQty', delta, 0);}
  function changeModalCopies(delta){changeInputNumber('po_modalCopies', delta, 1);}
  async function modalOk(){const m=S.modal; if(!m)return; const q=Number($('po_modalQty').value||0); const c=Number($('po_modalCopies').value||1); closeQtyModal(); if(m.kind==='partial')return receiveLine(m.i,q,{skipConfirm:true}); if(m.kind==='return')return returnLine(m.i,q); if(m.kind==='label')return printLabel(m.i,q,c);}

  function bindUI(){
    if(bound)return; bound=true;
    $('po_poInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();performPOSearch();}});
    $('po_loadPoBtn').addEventListener('click',performPOSearch);
    $('po_searchType').addEventListener('change',e=>setPOSearchType(e.target.value));
    $('po_vendorResults').addEventListener('click',e=>{
      if(e.target.closest('[data-po-vendor-close]')){hideVendorResults();return;}
      const b=e.target.closest('[data-po-vendor-index]'); if(!b)return;
      const row=S.vendorResults[Number(b.dataset.poVendorIndex)]; if(!row)return;
      const po=String(row.POId??row.poId??'').trim(); if(!po)return;
      setPOSearchType('po'); $('po_poInput').value=po; hideVendorResults(); loadPO();
    });
    $('po_clearBtn').addEventListener('click',clearAll);
    $('po_updatePoBtn').addEventListener('click',updateOrder);
    $('po_receiveAllBtn').addEventListener('click',receiveAllWithLabels);
    $('po_partFilter').addEventListener('input',renderLinesSafe);
    $('po_descFilter').addEventListener('input',renderLinesSafe);
    $('po_statusFilter').addEventListener('change',renderLinesSafe);
    $('po_lineTb').addEventListener('click',e=>{const part=e.target.closest('[data-po-demand-part]'); if(part){const i=Number(part.dataset.i); if(Number.isFinite(i)) selectDemandForLine(i); return;} const b=e.target.closest('button'); if(!b)return; const i=Number(b.dataset.i); if(!Number.isFinite(i))return; if(b.classList.contains('po-allBtn'))receiveLine(i,effectiveRemaining(S.lines[i]),{skipConfirm:true}); else if(b.classList.contains('po-partialBtn'))openQtyModal('partial',i); else if(b.classList.contains('po-returnBtn'))openQtyModal('return',i); else if(b.classList.contains('po-labelBtn'))printLabel(i,effectiveReceived(S.lines[i])||effectiveRemaining(S.lines[i])||1,1); else if(b.classList.contains('po-labelPlusBtn'))openQtyModal('label',i);});
    $('po_modalClose').addEventListener('click',closeQtyModal); $('po_modalCancel').addEventListener('click',closeQtyModal);
    $('po_qtyMinus').addEventListener('click',()=>changeModalQty(-1)); $('po_qtyPlus').addEventListener('click',()=>changeModalQty(1));
    $('po_copiesMinus').addEventListener('click',()=>changeModalCopies(-1)); $('po_copiesPlus').addEventListener('click',()=>changeModalCopies(1));
    $('po_modalOk').addEventListener('click',modalOk);
    $('po_modalQty').addEventListener('keydown',e=>{if(e.key==='Enter')modalOk(); if(e.key==='Escape')closeQtyModal();});
    $('po_modalCopies').addEventListener('keydown',e=>{if(e.key==='Enter')modalOk(); if(e.key==='Escape')closeQtyModal();});
    setPOSearchType('po');
    renderLines();
  }
  return { init: bindUI, reset: clearAll };
})();
