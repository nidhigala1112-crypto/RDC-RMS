// Pulls finished Plant PRO SRT / DISC results from the assessment portal (hr.rdcc.ai) into the tracker.
// Every hour (and on "Check now") it looks at assessments that are Pending/Sent, asks the portal for that
// candidate's result, and — once the portal says it is done — completes the record using the same matcher as
// the Excel import. The portal's exact address and field names are set in Settings, so no code change is needed
// when the portal team tells you how to read results.
const { applyResult, normType } = require('./assessmentIntake');

const CONFIG_KEY = 'portal_pull_config';
const LAST_KEY = 'portal_pull_last';
const DEFAULTS = {
  enabled: false,
  srt_url: '', disc_url: '',
  auth_header: 'X-API-Key', auth_value: '',
  results_path: '', status_path: '', completed_values: 'completed,done,submitted,finished',
  score_path: 'score', summary_path: 'result', report_path: 'report_url', date_path: 'completed_at'
};

async function upsert({ dbGet, dbRun }, key, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  if (await dbGet('SELECT key FROM settings WHERE key = ?', [key])) await dbRun("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?", [v, key]);
  else await dbRun('INSERT INTO settings (key, value) VALUES (?, ?)', [key, v]);
}
async function getConfig({ dbGet }) {
  const row = await dbGet('SELECT value FROM settings WHERE key = ?', [CONFIG_KEY]);
  let saved = {}; try { saved = row ? JSON.parse(row.value) : {}; } catch { /* ignore */ }
  return { ...DEFAULTS, ...saved };
}
// The access value is a secret: it is never sent back to the browser, only "has_secret".
async function getPublicConfig(db) {
  const c = await getConfig(db); const { auth_value, ...rest } = c;
  const last = await db.dbGet('SELECT value FROM settings WHERE key = ?', [LAST_KEY]);
  let lastRun = null; try { lastRun = last ? JSON.parse(last.value) : null; } catch { /* ignore */ }
  return { ...rest, has_secret: !!auth_value, last: lastRun };
}
async function saveConfig(db, input) {
  const cur = await getConfig(db);
  const next = { ...cur };
  for (const k of Object.keys(DEFAULTS)) {
    if (input[k] === undefined) continue;
    if (k === 'enabled') next.enabled = !!input.enabled;
    else if (k === 'auth_value') { if (String(input.auth_value).trim()) next.auth_value = String(input.auth_value).trim(); }
    else next[k] = String(input[k]).trim();
  }
  for (const k of ['srt_url', 'disc_url']) {
    if (next[k] && !/^https?:\/\//i.test(next[k])) throw new Error('Portal addresses must start with https://');
  }
  await upsert(db, CONFIG_KEY, next);
  return getPublicConfig(db);
}

const dig = (obj, path) => {
  if (!path) return undefined;
  return String(path).split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);
};
const last10 = (m) => String(m || '').replace(/\D/g, '').slice(-10);

function buildUrl(tpl, c) {
  const enc = encodeURIComponent;
  return tpl.replace(/\{(email|mobile|candidate_code|name)\}/g, (_, k) => enc(k === 'mobile' ? last10(c.mobile) : (c[k === 'name' ? 'full_name' : k] || '')));
}

// Reads one candidate's result. Returns { state: 'done'|'waiting'|'error', item?, message? }
async function fetchOne(cfg, a, type) {
  const tpl = type === 'DISC' ? cfg.disc_url : cfg.srt_url;
  if (!tpl) return { state: 'skip' };
  const url = buildUrl(tpl, a);
  const headers = { Accept: 'application/json' };
  if (cfg.auth_header && cfg.auth_value) headers[cfg.auth_header] = cfg.auth_value;
  let res;
  try { res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) }); }
  catch (e) { return { state: 'error', message: `portal not reachable (${e.message})` }; }
  if (res.status === 404 || res.status === 204) return { state: 'waiting' };
  if (res.status === 401 || res.status === 403) return { state: 'error', message: 'the portal refused the access key' };
  if (!res.ok) return { state: 'error', message: `portal answered ${res.status}` };
  let body; try { body = await res.json(); } catch { return { state: 'error', message: 'portal reply was not JSON' }; }
  let obj = cfg.results_path ? dig(body, cfg.results_path) : body;
  if (Array.isArray(obj)) obj = obj[0];
  if (!obj || typeof obj !== 'object') return { state: 'waiting' };
  const score = dig(obj, cfg.score_path);
  const summary = dig(obj, cfg.summary_path);
  const status = cfg.status_path ? String(dig(obj, cfg.status_path) ?? '').toLowerCase() : '';
  const okValues = String(cfg.completed_values || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  const done = cfg.status_path ? okValues.includes(status) : (score !== undefined && score !== null && score !== '');
  if (!done) return { state: 'waiting' };
  const flat = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return { state: 'done', item: { candidate_code: a.candidate_code, email: a.email, mobile: a.mobile, assessment_type: type,
    score: flat(score), result_summary: flat(summary), report_link: flat(dig(obj, cfg.report_path)), assessment_date: flat(dig(obj, cfg.date_path)).slice(0, 10) } };
}

async function pending(db) {
  return db.dbAll(`SELECT a.id, a.assessment_type, c.candidate_code, c.full_name, c.email, c.mobile
    FROM assessments a JOIN candidates c ON c.id = a.candidate_id
    WHERE a.is_deleted = 0 AND a.status IN ('Pending','Sent') AND c.is_deleted = 0
      AND a.created_at >= datetime('now','-90 days') ORDER BY a.created_at`);
}

// dry: only report what the portal says, change nothing.
async function run(db, { dry = false, force = false } = {}) {
  const cfg = await getConfig(db);
  if (!cfg.enabled && !force) return { skipped: true, message: 'Automatic pull is off.' };
  const todo = await pending(db);
  const out = { at: new Date().toISOString(), checked: 0, completed: 0, waiting: 0, errors: [], dry };
  const seenErr = new Set();
  for (const a of todo) {
    const type = normType(a.assessment_type);
    if (!type) continue;
    const r = await fetchOne(cfg, a, type);
    if (r.state === 'skip') continue;
    out.checked++;
    if (r.state === 'waiting') { out.waiting++; continue; }
    if (r.state === 'error') { if (!seenErr.has(r.message)) { seenErr.add(r.message); out.errors.push(r.message); } if (/not reachable|refused/.test(r.message)) break; continue; }
    if (dry) { out.completed++; continue; }
    const res = await applyResult(db, r.item);
    if (res.ok) out.completed++; else out.errors.push(`${a.full_name}: ${res.error}`);
  }
  if (!dry) await upsert(db, LAST_KEY, out);
  return out;
}

module.exports = { getPublicConfig, saveConfig, run, DEFAULTS };
