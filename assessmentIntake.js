// Gets Plant PRO SRT / DISC results into the tracker without retyping them. Two entry points share one matcher:
//   1. the portal (or anyone with the API key) POSTs results to /api/integrations/assessment-result
//   2. a recruiter uploads the Excel/CSV export from the portal on the Assessments page (preview, then apply)
// A result is matched to a candidate by candidate code, e-mail or mobile (last 10 digits). If the candidate
// already has an unfinished assessment of that type it is completed; otherwise a new record is created and
// linked to the candidate's most recent open application.
const crypto = require('crypto');
const XLSX = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const { findDuplicates } = require('./duplicates');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function normType(t) {
  const s = String(t || '').toLowerCase();
  if (/disc|people|personality/.test(s)) return 'DISC';
  if (/srt|plant|pro\b|safety|skill/.test(s)) return 'Plant PRO SRT';
  return null;
}

async function newApiKey({ dbRun }) {
  const key = 'rdc_' + crypto.randomBytes(24).toString('hex');
  await dbRun("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = 'integration_api_key_hash'", [sha(key)]);
  return key;
}
async function keyIsValid({ dbGet }, presented) {
  if (!presented) return false;
  const row = await dbGet("SELECT value FROM settings WHERE key = 'integration_api_key_hash'");
  if (!row || !row.value) return false;
  const a = Buffer.from(sha(presented)); const b = Buffer.from(row.value);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function findCandidate({ dbGet, dbAll }, item) {
  if (item.candidate_code) {
    const c = await dbGet('SELECT id, candidate_code, full_name FROM candidates WHERE candidate_code = ? AND is_deleted = 0', [String(item.candidate_code).trim()]);
    if (c) return { candidate: c };
  }
  const matches = await findDuplicates(dbAll, { email: item.email, mobile: item.mobile });
  if (matches.length === 1) return { candidate: matches[0] };
  if (matches.length > 1) return { error: 'email and mobile belong to different candidates' };
  return { error: 'no candidate with this email / mobile' };
}

// item: { candidate_code?, email?, mobile?, assessment_type, status?, score?, result_summary?, report_link?, assessment_date? }
async function applyResult(db, item, actor = { id: null, name: 'Portal integration' }, { dry = false } = {}) {
  const type = normType(item.assessment_type);
  if (!type) return { ok: false, error: 'assessment_type must be Plant PRO SRT or DISC' };
  const found = await findCandidate(db, item);
  if (found.error) return { ok: false, error: found.error };
  const c = found.candidate;
  const status = ['Pending', 'Sent', 'Completed', 'Not Required'].includes(item.status) ? item.status : 'Completed';
  const fields = {
    status, assessment_date: item.assessment_date ? String(item.assessment_date).slice(0, 10) : today(),
    score: item.score !== undefined && item.score !== null && item.score !== '' ? String(item.score) : null,
    result_summary: item.result_summary || null, report_link: item.report_link || null
  };
  let rec = await db.dbGet("SELECT id, status FROM assessments WHERE candidate_id = ? AND assessment_type = ? AND is_deleted = 0 AND status IN ('Pending','Sent') ORDER BY created_at DESC LIMIT 1", [c.id, type]);
  if (!rec) rec = await db.dbGet('SELECT id, status FROM assessments WHERE candidate_id = ? AND assessment_type = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT 1', [c.id, type]);
  const action = rec ? 'updated' : 'created';
  if (dry) return { ok: true, action, candidate: { id: c.id, code: c.candidate_code, name: c.full_name } };
  if (rec) {
    await db.dbRun(`UPDATE assessments SET status = ?, assessment_date = ?, score = COALESCE(?, score), result_summary = COALESCE(?, result_summary), report_link = COALESCE(?, report_link), updated_at = datetime('now') WHERE id = ?`,
      [fields.status, fields.assessment_date, fields.score, fields.result_summary, fields.report_link, rec.id]);
  } else {
    const app = await db.dbGet("SELECT id, vacancy_id FROM applications WHERE candidate_id = ? AND is_deleted = 0 AND status NOT IN ('Rejected','Withdrawn') ORDER BY created_at DESC LIMIT 1", [c.id]);
    rec = { id: uuidv4() };
    await db.dbRun(`INSERT INTO assessments (id, candidate_id, vacancy_id, application_id, assessment_type, status, assessment_date, score, result_summary, report_link, created_by)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [rec.id, c.id, app ? app.vacancy_id : null, app ? app.id : null, type, fields.status, fields.assessment_date, fields.score, fields.result_summary, fields.report_link, actor.id]);
  }
  await db.logAudit(actor.id, actor.name, 'assessment_result', 'assessments', rec.id, { type, candidate: c.candidate_code, ...fields, source: actor.id ? 'file import' : 'portal' });
  return { ok: true, action, id: rec.id, candidate: { id: c.id, code: c.candidate_code, name: c.full_name } };
}

/* ---------- Excel / CSV export from the portal ---------- */
const HEADERS = [
  ['candidate_code', /candidate.?(code|id)|^code$/i],
  ['email', /e-?mail/i],
  ['mobile', /mobile|phone|contact|whatsapp/i],
  ['assessment_type', /^(test|assessment|type|test name|assessment type|module)$/i],
  ['assessment_date', /date|completed on|taken on/i],
  ['report_link', /link|url|report/i],
  ['score', /^(score|total score|overall score|total|marks|percentage|%)$/i],
  ['result_summary', /result|summary|outcome|profile|style|band|grade|category|remark/i],
  ['name', /name/i]
];

function parseSheet(buffer, { defaultType } = {}) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  if (!rows.length) throw new Error('The file has no data rows.');
  const headers = Object.keys(rows[0]);
  const map = {}; const used = new Set();
  for (const [field, re] of HEADERS) {
    const h = headers.find((x) => !used.has(x) && re.test(String(x).trim()));
    if (h) { map[field] = h; used.add(h); }
  }
  if (!map.email && !map.mobile && !map.candidate_code) throw new Error('Could not find an Email, Mobile or Candidate code column. Check the first row of the file has column headings.');
  const items = rows.map((r, i) => {
    const get = (f) => (map[f] ? String(r[map[f]] ?? '').trim() : '');
    let date = get('assessment_date');
    const dm = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/.exec(date); // dd/mm/yyyy
    if (dm) date = `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`;
    return { row: i + 2, name: get('name'), candidate_code: get('candidate_code'), email: get('email'), mobile: get('mobile'),
      assessment_type: normType(get('assessment_type')) || defaultType || '', assessment_date: date, score: get('score'), result_summary: get('result_summary'), report_link: get('report_link') };
  }).filter((x) => x.email || x.mobile || x.candidate_code);
  return { items, columns: map };
}

module.exports = { newApiKey, keyIsValid, applyResult, parseSheet, normType };
