// Candidate onboarding form (replaces the Google form) + hand-over to the company HRMS.
//
//   * One private link per candidate (48-hex token, valid 30 days, no login). It is created automatically
//     when the appointment letter is emailed, and can also be sent by hand from Onboarding / Joining.
//   * The candidate fills personal, address, ID, bank, education, previous-job and nominee details and uploads
//     documents (PAN, Aadhaar, certificates, photo, cancelled cheque ...). Drafts are saved; "Submit" validates.
//   * HR can review, mark Verified, and download everything as one ZIP.
//   * When the candidate's Joining record becomes "Joined" with a joining date, the details and documents are
//     sent to the HRMS (address / key set in Settings). If the form is not submitted yet, the hand-over happens
//     the moment it is. Failures are kept and retried; nothing is lost.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { sendMail } = require('./mailer');

const EXPIRY_DAYS = 30;
const HRMS_KEY = 'hrms_config';
const DOC_DIR = path.join(__dirname, 'uploads', 'onboarding');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- The form: one definition used by the candidate page, validation and the HRMS payload ----
const GENDERS = ['Male', 'Female', 'Other'];
const MARITAL = ['Single', 'Married', 'Divorced', 'Widowed'];
const BLOOD = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', "Don't know"];
const SECTIONS = [
  { key: 'personal', title: 'Personal details', fields: [
    { key: 'full_name', label: 'Full name (as per Aadhaar / PAN)', required: true },
    { key: 'father_name', label: "Father's name", required: true },
    { key: 'mother_name', label: "Mother's name" },
    { key: 'dob', label: 'Date of birth', type: 'date', required: true },
    { key: 'gender', label: 'Gender', type: 'select', options: GENDERS, required: true },
    { key: 'marital_status', label: 'Marital status', type: 'select', options: MARITAL, required: true },
    { key: 'spouse_name', label: "Spouse's name", hint: 'If married' },
    { key: 'blood_group', label: 'Blood group', type: 'select', options: BLOOD },
    { key: 'nationality', label: 'Nationality', default: 'Indian' }
  ] },
  { key: 'contact', title: 'Contact details', fields: [
    { key: 'mobile', label: 'Mobile number', type: 'tel', required: true },
    { key: 'alt_mobile', label: 'Alternate mobile number', type: 'tel' },
    { key: 'personal_email', label: 'Personal email', type: 'email', required: true },
    { key: 'emergency_name', label: 'Emergency contact — name', required: true },
    { key: 'emergency_relation', label: 'Emergency contact — relationship', required: true },
    { key: 'emergency_mobile', label: 'Emergency contact — mobile', type: 'tel', required: true }
  ] },
  { key: 'address', title: 'Address', fields: [
    { key: 'cur_address', label: 'Current address', type: 'textarea', required: true },
    { key: 'cur_city', label: 'City', required: true },
    { key: 'cur_state', label: 'State', required: true },
    { key: 'cur_pin', label: 'PIN code', required: true },
    { key: 'same_address', label: 'Permanent address is the same as current', type: 'checkbox' },
    { key: 'perm_address', label: 'Permanent address', type: 'textarea', required: true, unless: 'same_address' },
    { key: 'perm_city', label: 'City', required: true, unless: 'same_address' },
    { key: 'perm_state', label: 'State', required: true, unless: 'same_address' },
    { key: 'perm_pin', label: 'PIN code', required: true, unless: 'same_address' }
  ] },
  { key: 'identity', title: 'Identity & statutory', fields: [
    { key: 'pan', label: 'PAN number', required: true, hint: 'e.g. ABCDE1234F' },
    { key: 'aadhaar', label: 'Aadhaar number', required: true, hint: '12 digits' },
    { key: 'uan', label: 'UAN (PF number)', hint: 'If you have worked before and have one — 12 digits' },
    { key: 'esic', label: 'ESIC number', hint: 'If you have one' },
    { key: 'passport', label: 'Passport number', hint: 'Optional' }
  ] },
  { key: 'bank', title: 'Bank account (for salary)', fields: [
    { key: 'bank_holder', label: 'Account holder name', required: true },
    { key: 'bank_name', label: 'Bank name', required: true },
    { key: 'bank_account', label: 'Account number', required: true },
    { key: 'bank_ifsc', label: 'IFSC code', required: true, hint: 'e.g. HDFC0001234' },
    { key: 'bank_branch', label: 'Branch' }
  ] },
  { key: 'education', title: 'Education', fields: [
    { key: 'edu_level', label: 'Highest qualification', required: true, hint: 'e.g. B.E. Civil, MBA, Diploma' },
    { key: 'edu_institute', label: 'University / institute', required: true },
    { key: 'edu_year', label: 'Year of passing', required: true },
    { key: 'edu_percent', label: 'Percentage / CGPA' }
  ] },
  { key: 'employment', title: 'Previous employment', note: 'Freshers can leave this section blank.', fields: [
    { key: 'prev_company', label: 'Last employer' },
    { key: 'prev_designation', label: 'Designation' },
    { key: 'prev_from', label: 'From', type: 'date' },
    { key: 'prev_to', label: 'To (last working day)', type: 'date' },
    { key: 'prev_reason', label: 'Reason for leaving' }
  ] },
  { key: 'nominee', title: 'Nominee (PF / gratuity / insurance)', fields: [
    { key: 'nominee_name', label: 'Nominee name', required: true },
    { key: 'nominee_relation', label: 'Relationship', required: true },
    { key: 'nominee_dob', label: 'Nominee date of birth', type: 'date' }
  ] }
];
const DOC_TYPES = [
  { key: 'photo', label: 'Passport-size photograph', required: true },
  { key: 'pan', label: 'PAN card', required: true },
  { key: 'aadhaar', label: 'Aadhaar card (front and back)', required: true },
  { key: 'tenth', label: '10th certificate / marksheet', required: true },
  { key: 'qualification', label: 'Last qualification certificate', required: true },
  { key: 'cheque', label: 'Cancelled cheque / bank passbook first page', required: true },
  { key: 'resignation', label: 'Copy of resignation / acceptance' },
  { key: 'experience', label: 'Experience & relieving letter' },
  { key: 'other', label: 'Other documents' }
];
const FIELD_KEYS = SECTIONS.flatMap((s) => s.fields.map((f) => f.key));
const FIELD_BY_KEY = Object.fromEntries(SECTIONS.flatMap((s) => s.fields.map((f) => [f.key, f])));
const MAX_DOCS_PER_TYPE = 3;
const MAX_DOC_BYTES = 8 * 1024 * 1024;

const FORMAT = {
  pan: [/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'PAN must look like ABCDE1234F.'],
  aadhaar: [/^\d{12}$/, 'Aadhaar must be 12 digits.'],
  uan: [/^\d{12}$/, 'UAN must be 12 digits.'],
  bank_ifsc: [/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC must look like HDFC0001234.'],
  bank_account: [/^\d{6,20}$/, 'Account number must be digits only (6–20).'],
  mobile: [/^\d{10}$/, 'Mobile must be 10 digits.'],
  alt_mobile: [/^\d{10}$/, 'Alternate mobile must be 10 digits.'],
  emergency_mobile: [/^\d{10}$/, 'Emergency contact mobile must be 10 digits.'],
  personal_email: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter a valid email address.'],
  cur_pin: [/^\d{6}$/, 'PIN code must be 6 digits.'],
  perm_pin: [/^\d{6}$/, 'PIN code must be 6 digits.']
};

// Light clean-up before storing: trim, cap length, normalise IDs, drop unknown keys.
function clean(input) {
  const out = {};
  for (const k of FIELD_KEYS) {
    const f = FIELD_BY_KEY[k];
    let v = input && input[k];
    if (f.type === 'checkbox') { out[k] = v === true || v === 'true' || v === 1 || v === '1'; continue; }
    v = String(v === undefined || v === null ? '' : v).trim().slice(0, f.type === 'textarea' ? 500 : 200);
    if (['pan', 'bank_ifsc'].includes(k)) v = v.toUpperCase().replace(/\s/g, '');
    if (['aadhaar', 'uan', 'bank_account', 'mobile', 'alt_mobile', 'emergency_mobile', 'cur_pin', 'perm_pin'].includes(k)) v = v.replace(/[\s-]/g, '');
    if (['mobile', 'alt_mobile', 'emergency_mobile'].includes(k) && v.length > 10) v = v.slice(-10); // drops a +91 / 91 prefix
    out[k] = v;
  }
  return out;
}

function validate(data, docs, declaration) {
  const errors = {};
  for (const s of SECTIONS) for (const f of s.fields) {
    if (f.type === 'checkbox') continue;
    const skip = f.unless && data[f.unless];
    const v = data[f.key];
    if (!skip && f.required && !v) { errors[f.key] = `${f.label} is required.`; continue; }
    if (!skip && v && FORMAT[f.key] && !FORMAT[f.key][0].test(v)) errors[f.key] = FORMAT[f.key][1];
  }
  if (data.uan && !FORMAT.uan[0].test(data.uan)) errors.uan = FORMAT.uan[1];
  const have = new Set(docs.map((d) => d.doc_type));
  for (const d of DOC_TYPES) if (d.required && !have.has(d.key)) errors['doc_' + d.key] = `${d.label} is required.`;
  if (!declaration) errors.declaration = 'Please tick the declaration.';
  return errors;
}

// ---- Links ----
const buildUrl = (baseUrl, token) => `${String(baseUrl).replace(/\/$/, '')}/onboarding/${token}`;
const isoIn = (days) => new Date(Date.now() + days * 86400000).toISOString();
const isEnabled = async () => true;

async function ensureLink({ dbGet, dbRun }, candidateId, vacancyId, offerId, { regenerate = false } = {}) {
  if (!candidateId) throw new Error('A candidate is needed to create an onboarding link.');
  let row = await dbGet('SELECT * FROM onboarding WHERE candidate_id = ? AND COALESCE(vacancy_id, \'\') = COALESCE(?, \'\') AND is_deleted = 0 ORDER BY created_at DESC LIMIT 1', [candidateId, vacancyId || null]);
  if (!row) {
    const id = uuidv4();
    await dbRun(`INSERT INTO onboarding (id, candidate_id, vacancy_id, offer_id, status, data) VALUES (?,?,?,?, 'Invited', '{}')`, [id, candidateId, vacancyId || null, offerId || null]);
    row = await dbGet('SELECT * FROM onboarding WHERE id = ?', [id]);
  } else if (offerId && !row.offer_id) {
    await dbRun('UPDATE onboarding SET offer_id = ? WHERE id = ?', [offerId, row.id]);
  }
  const valid = row.token && row.token_expires && row.token_expires > new Date().toISOString();
  if (valid && !regenerate) return { id: row.id, token: row.token, expires_at: row.token_expires };
  const token = crypto.randomBytes(24).toString('hex'); const expires = isoIn(EXPIRY_DAYS);
  await dbRun("UPDATE onboarding SET token = ?, token_expires = ?, updated_at = datetime('now') WHERE id = ?", [token, expires, row.id]);
  return { id: row.id, token, expires_at: expires };
}

async function loadByToken({ dbGet }, token) {
  if (!/^[a-f0-9]{48}$/.test(String(token || ''))) return { error: 'This link is not valid.', status: 404 };
  const row = await dbGet('SELECT * FROM onboarding WHERE token = ? AND is_deleted = 0', [token]);
  if (!row) return { error: 'This link is not valid. Ask HR for a new one.', status: 404 };
  if (!row.token_expires || row.token_expires <= new Date().toISOString()) return { error: 'This link has expired. Please ask HR to send you a new one.', status: 410 };
  return { row };
}

const parse = (s) => { try { const o = JSON.parse(s || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
const locked = (row) => ['Verified'].includes(row.status) || row.hrms_status === 'Sent';

async function context({ dbGet }, row) {
  const [candidate, vacancy, offer, joining] = await Promise.all([
    dbGet('SELECT * FROM candidates WHERE id = ?', [row.candidate_id]),
    row.vacancy_id ? dbGet('SELECT * FROM vacancies WHERE id = ?', [row.vacancy_id]) : null,
    row.offer_id ? dbGet('SELECT * FROM offers WHERE id = ?', [row.offer_id]) : null,
    dbGet('SELECT * FROM joining WHERE candidate_id = ? AND COALESCE(vacancy_id, \'\') = COALESCE(?, \'\') AND is_deleted = 0 ORDER BY created_at DESC LIMIT 1', [row.candidate_id, row.vacancy_id || null])
  ]);
  return { candidate, vacancy, offer, joining };
}

async function docsOf({ dbAll }, id) {
  return dbAll('SELECT id, doc_type, file_name, file_size, mime_type, uploaded_at FROM onboarding_docs WHERE onboarding_id = ? ORDER BY uploaded_at', [id]);
}

// ---- Candidate-facing (public) ----
async function getPublic(db, token) {
  const { row, error, status } = await loadByToken(db, token);
  if (error) return { error, status };
  const { candidate, vacancy, joining } = await context(db, row);
  const saved = parse(row.data);
  const prefill = { dob: candidate && candidate.date_of_birth, full_name: candidate && candidate.full_name, mobile: candidate && candidate.mobile, personal_email: candidate && candidate.email, nationality: 'Indian' };
  const data = {};
  for (const k of FIELD_KEYS) data[k] = saved[k] !== undefined && saved[k] !== '' ? saved[k] : (prefill[k] || '');
  return { data: {
    candidate: candidate ? candidate.full_name : '', position: vacancy ? vacancy.title : '', company: vacancy ? vacancy.company : '',
    joining_date: joining ? (joining.actual_date || joining.expected_date || '') : '', location: joining && joining.joining_location || (vacancy && vacancy.location) || '',
    status: row.status, locked: locked(row), submitted_at: row.submitted_at || null, expires_at: row.token_expires,
    sections: SECTIONS, doc_types: DOC_TYPES, max_per_type: MAX_DOCS_PER_TYPE,
    values: data, declaration: !!saved.__declaration, docs: await docsOf(db, row.id)
  } };
}

async function save(db, token, body, { submit = false } = {}) {
  const { row, error, status } = await loadByToken(db, token);
  if (error) return { error, status };
  if (locked(row)) return { error: 'HR has already verified your details, so they can no longer be changed here. Please contact HR if something needs correcting.', status: 409 };
  const data = clean(body && body.values);
  const declaration = !!(body && body.declaration);
  const docs = await docsOf(db, row.id);
  if (submit) {
    const errors = validate(data, docs, declaration);
    if (Object.keys(errors).length) return { error: 'Please fix the highlighted items.', errors, status: 422 };
  }
  const stored = { ...data, __declaration: declaration };
  const next = submit ? 'Submitted' : (row.status === 'Submitted' ? 'Submitted' : 'In Progress');
  await db.dbRun(`UPDATE onboarding SET data = ?, status = ?, submitted_at = CASE WHEN ? THEN datetime('now') ELSE submitted_at END, updated_at = datetime('now') WHERE id = ?`,
    [JSON.stringify(stored), next, submit ? 1 : 0, row.id]);
  // the date of birth given here fills the candidate record if it was empty
  if (submit && data.dob && row.candidate_id) { try { await db.dbRun("UPDATE candidates SET date_of_birth = ? WHERE id = ? AND COALESCE(date_of_birth, '') = ''", [data.dob, row.candidate_id]); } catch { /* best effort */ } }
  return { ok: true, id: row.id, candidateId: row.candidate_id, submitted: submit };
}

function sniff(buf, ext) {
  const h = buf.subarray(0, 8);
  if (ext === '.pdf') return h.subarray(0, 4).toString('latin1') === '%PDF';
  if (ext === '.png') return h[0] === 0x89 && h.subarray(1, 4).toString('latin1') === 'PNG';
  if (ext === '.jpg' || ext === '.jpeg') return h[0] === 0xff && h[1] === 0xd8;
  return false;
}
const MIME = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

async function addDoc(db, token, docType, file) {
  const { row, error, status } = await loadByToken(db, token);
  if (error) return { error, status };
  if (locked(row)) return { error: 'Your details are already verified; documents can no longer be changed here.', status: 409 };
  if (!DOC_TYPES.some((d) => d.key === docType)) return { error: 'Unknown document type.', status: 400 };
  if (!file) return { error: 'Choose a file.', status: 400 };
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!MIME[ext]) return { error: 'Only PDF, JPG or PNG files are accepted.', status: 400 };
  if (file.size > MAX_DOC_BYTES) return { error: 'That file is larger than 8 MB.', status: 400 };
  if (!sniff(file.buffer, ext)) return { error: 'That file does not look like a real ' + ext.slice(1).toUpperCase() + '.', status: 400 };
  const existing = await db.dbAll('SELECT id FROM onboarding_docs WHERE onboarding_id = ? AND doc_type = ? ORDER BY uploaded_at', [row.id, docType]);
  if (existing.length >= MAX_DOCS_PER_TYPE) return { error: `You can upload up to ${MAX_DOCS_PER_TYPE} files for this item. Remove one first.`, status: 400 };
  const dir = path.join(DOC_DIR, row.id); fs.mkdirSync(dir, { recursive: true });
  const id = uuidv4(); const stored = path.join(dir, `${docType}-${id}${ext}`);
  fs.writeFileSync(stored, file.buffer);
  const name = String(file.originalname).replace(/[^\w.\- ()]/g, '_').slice(0, 120);
  await db.dbRun('INSERT INTO onboarding_docs (id, onboarding_id, doc_type, file_name, file_path, mime_type, file_size) VALUES (?,?,?,?,?,?,?)', [id, row.id, docType, name, stored, MIME[ext], file.size]);
  if (row.status === 'Invited') await db.dbRun("UPDATE onboarding SET status = 'In Progress', updated_at = datetime('now') WHERE id = ?", [row.id]);
  return { ok: true, docs: await docsOf(db, row.id) };
}

async function removeDoc(db, token, docId) {
  const { row, error, status } = await loadByToken(db, token);
  if (error) return { error, status };
  if (locked(row)) return { error: 'Your details are already verified; documents can no longer be changed here.', status: 409 };
  const d = await db.dbGet('SELECT * FROM onboarding_docs WHERE id = ? AND onboarding_id = ?', [docId, row.id]);
  if (!d) return { error: 'File not found.', status: 404 };
  try { fs.unlinkSync(d.file_path); } catch { /* already gone */ }
  await db.dbRun('DELETE FROM onboarding_docs WHERE id = ?', [d.id]);
  return { ok: true, docs: await docsOf(db, row.id) };
}

// ---- HR side ----
async function list({ dbAll }, { status, q } = {}) {
  const rows = await dbAll(`
    SELECT o.id, o.candidate_id, o.vacancy_id, o.status, o.submitted_at, o.hrms_status, o.hrms_pushed_at, o.hrms_error, o.token_expires, o.created_at, o.updated_at,
           c.full_name AS candidate, c.candidate_code, v.title AS vacancy, v.company,
           j.status AS joining_status, j.expected_date, j.actual_date,
           (SELECT COUNT(*) FROM onboarding_docs d WHERE d.onboarding_id = o.id) AS doc_count
    FROM onboarding o
    LEFT JOIN candidates c ON c.id = o.candidate_id
    LEFT JOIN vacancies v ON v.id = o.vacancy_id
    LEFT JOIN joining j ON j.candidate_id = o.candidate_id AND COALESCE(j.vacancy_id,'') = COALESCE(o.vacancy_id,'') AND j.is_deleted = 0
    WHERE o.is_deleted = 0 ORDER BY COALESCE(j.expected_date, o.created_at) DESC`);
  const needle = String(q || '').toLowerCase();
  const required = DOC_TYPES.filter((d) => d.required).length;
  return rows.filter((r) => (!status || r.status === status || (status === 'Ready for HRMS' && ['Submitted', 'Verified'].includes(r.status) && r.hrms_status !== 'Sent')) && (!needle || `${r.candidate} ${r.vacancy} ${r.company}`.toLowerCase().includes(needle)))
    .map((r) => ({ ...r, required_docs: required }));
}

async function detail(db, id) {
  const row = await db.dbGet('SELECT * FROM onboarding WHERE id = ? AND is_deleted = 0', [id]);
  if (!row) return null;
  const ctx = await context(db, row);
  const { token, data, ...rest } = row;
  return { ...rest, has_link: !!token, values: parse(data), docs: await docsOf(db, id), sections: SECTIONS, doc_types: DOC_TYPES,
    candidate: ctx.candidate && ctx.candidate.full_name, candidate_email: ctx.candidate && ctx.candidate.email, vacancy: ctx.vacancy && ctx.vacancy.title, company: ctx.vacancy && ctx.vacancy.company,
    joining: ctx.joining ? { status: ctx.joining.status, expected_date: ctx.joining.expected_date, actual_date: ctx.joining.actual_date } : null };
}

async function docFile({ dbGet }, onboardingId, docId) {
  const d = await dbGet('SELECT * FROM onboarding_docs WHERE id = ? AND onboarding_id = ?', [docId, onboardingId]);
  return d && fs.existsSync(d.file_path) ? d : null;
}

async function setVerified(db, id, user) {
  const row = await db.dbGet('SELECT * FROM onboarding WHERE id = ? AND is_deleted = 0', [id]);
  if (!row) throw new Error('Onboarding record not found.');
  if (row.status !== 'Submitted' && row.status !== 'Verified') throw new Error('The candidate has not submitted the form yet.');
  await db.dbRun("UPDATE onboarding SET status = 'Verified', verified_by = ?, verified_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [user.full_name, id]);
}
async function reopen(db, id) {
  const row = await db.dbGet('SELECT * FROM onboarding WHERE id = ? AND is_deleted = 0', [id]);
  if (!row) throw new Error('Onboarding record not found.');
  if (row.hrms_status === 'Sent') throw new Error('Already sent to the HRMS, so it can no longer be reopened here.');
  await db.dbRun("UPDATE onboarding SET status = 'In Progress', verified_by = NULL, verified_at = NULL, updated_at = datetime('now') WHERE id = ?", [id]);
}

async function sendLinkEmail(db, id, baseUrl) {
  const row = await db.dbGet('SELECT * FROM onboarding WHERE id = ? AND is_deleted = 0', [id]);
  if (!row) throw new Error('Onboarding record not found.');
  const { candidate, vacancy, joining } = await context(db, row);
  if (!candidate || !candidate.email) throw new Error('The candidate has no email address on file.');
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) throw new Error("Email isn't configured on this server yet — SMTP_USER / SMTP_PASS are missing from .env.");
  const link = await ensureLink(db, row.candidate_id, row.vacancy_id, row.offer_id);
  const url = buildUrl(baseUrl, link.token);
  const doj = joining && (joining.actual_date || joining.expected_date);
  const expiry = new Date(link.expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  await sendMail({
    to: candidate.email,
    subject: `Onboarding form — ${vacancy ? vacancy.title : 'your joining'}${vacancy && vacancy.company ? ' at ' + vacancy.company : ''}`,
    html: `<p>Dear ${esc(candidate.full_name)},</p>
      <p>Welcome! To complete your joining formalities${doj ? ` for <strong>${esc(new Date(doj).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }))}</strong>` : ''}, please fill in your onboarding form and upload the required documents.</p>
      <p style="margin:20px 0;"><a href="${esc(url)}" style="background:#1E3A52; color:#ffffff; padding:11px 20px; border-radius:6px; text-decoration:none; font-weight:bold; display:inline-block;">Open the onboarding form</a></p>
      <p>You will need: passport-size photo, PAN, Aadhaar, 10th and last qualification certificates, a cancelled cheque, and (if applicable) your resignation copy and experience / relieving letters. Photos or PDFs are fine. You can save your progress and come back to the same link.</p>
      <p style="color:#6E7169; font-size:13px;">The link works until ${esc(expiry)} and is meant only for you — please don't share it.</p>`
  });
  await db.dbRun("UPDATE onboarding SET invited_at = datetime('now') WHERE id = ?", [id]);
  return { to: candidate.email, url };
}

// ---- HRMS hand-over ----
const HRMS_DEFAULTS = { enabled: false, auto_push: true, require_verified: false, url: '', auth_type: 'none', auth_header: 'Authorization', auth_value: '', docs_mode: 'base64' };
async function getConfig({ dbGet }) {
  const row = await dbGet('SELECT value FROM settings WHERE key = ?', [HRMS_KEY]);
  let saved = {}; try { saved = row ? JSON.parse(row.value) : {}; } catch { /* ignore */ }
  return { ...HRMS_DEFAULTS, ...saved };
}
async function getPublicConfig(db) { const { auth_value, ...rest } = await getConfig(db); return { ...rest, has_secret: !!auth_value }; }
async function saveConfig(db, input) {
  const next = { ...(await getConfig(db)) };
  for (const k of Object.keys(HRMS_DEFAULTS)) {
    if (input[k] === undefined) continue;
    if (['enabled', 'auto_push', 'require_verified'].includes(k)) next[k] = !!input[k];
    else if (k === 'auth_value') { if (String(input.auth_value).trim()) next.auth_value = String(input.auth_value).trim(); }
    else next[k] = String(input[k]).trim();
  }
  if (next.url && !/^https?:\/\//i.test(next.url)) throw new Error('The HRMS address must start with https:// (or http:// on your own network).');
  if (!['none', 'bearer', 'header', 'basic'].includes(next.auth_type)) throw new Error('Unknown sign-in type.');
  if (!['base64', 'multipart', 'none'].includes(next.docs_mode)) throw new Error('Unknown document mode.');
  if (next.enabled && !next.url) throw new Error('Enter the HRMS address before switching the hand-over on.');
  const v = JSON.stringify(next);
  if (await db.dbGet('SELECT key FROM settings WHERE key = ?', [HRMS_KEY])) await db.dbRun("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?", [v, HRMS_KEY]);
  else await db.dbRun('INSERT INTO settings (key, value) VALUES (?, ?)', [HRMS_KEY, v]);
  return getPublicConfig(db);
}

function group(v) {
  const pick = (keys) => Object.fromEntries(keys.map((k) => [k, v[k] ?? '']));
  return {
    personal: pick(['full_name', 'father_name', 'mother_name', 'dob', 'gender', 'marital_status', 'spouse_name', 'blood_group', 'nationality']),
    contact: pick(['mobile', 'alt_mobile', 'personal_email', 'emergency_name', 'emergency_relation', 'emergency_mobile']),
    address: { current: { address: v.cur_address, city: v.cur_city, state: v.cur_state, pin: v.cur_pin }, permanent: v.same_address ? { same_as_current: true, address: v.cur_address, city: v.cur_city, state: v.cur_state, pin: v.cur_pin } : { address: v.perm_address, city: v.perm_city, state: v.perm_state, pin: v.perm_pin } },
    identity: pick(['pan', 'aadhaar', 'uan', 'esic', 'passport']),
    bank: { account_holder: v.bank_holder, bank_name: v.bank_name, account_number: v.bank_account, ifsc: v.bank_ifsc, branch: v.bank_branch },
    education: { highest_qualification: v.edu_level, institute: v.edu_institute, year_of_passing: v.edu_year, percentage: v.edu_percent },
    previous_employment: { company: v.prev_company, designation: v.prev_designation, from: v.prev_from, to: v.prev_to, reason_for_leaving: v.prev_reason },
    nominee: { name: v.nominee_name, relation: v.nominee_relation, dob: v.nominee_dob }
  };
}

async function buildPayload(db, id, { docs = 'base64' } = {}) {
  const row = await db.dbGet('SELECT * FROM onboarding WHERE id = ? AND is_deleted = 0', [id]);
  if (!row) throw new Error('Onboarding record not found.');
  const { candidate, vacancy, offer, joining } = await context(db, row);
  let recruiter = null;
  if (vacancy && vacancy.assigned_recruiter_id) recruiter = await db.dbGet('SELECT full_name, email FROM users WHERE id = ?', [vacancy.assigned_recruiter_id]);
  const files = await db.dbAll('SELECT * FROM onboarding_docs WHERE onboarding_id = ? ORDER BY doc_type, uploaded_at', [id]);
  const label = Object.fromEntries(DOC_TYPES.map((d) => [d.key, d.label]));
  const documents = files.map((f) => {
    const base = { type: f.doc_type, label: label[f.doc_type] || f.doc_type, file_name: f.file_name, mime_type: f.mime_type, size: f.file_size };
    if (docs === 'base64' && fs.existsSync(f.file_path)) base.content_base64 = fs.readFileSync(f.file_path).toString('base64');
    return base;
  });
  const payload = {
    event: 'candidate_joined', source: "RDC's Recruitment Management System", sent_at: new Date().toISOString(), reference: id,
    candidate_code: candidate && candidate.candidate_code || null,
    job: { company: vacancy && vacancy.company || null, designation: vacancy && vacancy.title || null, location: (joining && joining.joining_location) || (vacancy && vacancy.location) || null,
      employment_type: vacancy && vacancy.job_type || null, date_of_joining: joining ? (joining.actual_date || joining.expected_date) : null,
      reporting_manager: joining && joining.reporting_manager || null, offered_ctc: (joining && (joining.joined_ctc || joining.offered_ctc)) || (offer && offer.offered_ctc) || null, recruiter: recruiter && recruiter.full_name || null },
    employee: group(parse(row.data)),
    documents
  };
  return { payload, row, files };
}

function authHeaders(cfg) {
  const h = {};
  if (cfg.auth_type === 'bearer' && cfg.auth_value) h.Authorization = `Bearer ${cfg.auth_value}`;
  else if (cfg.auth_type === 'header' && cfg.auth_value) h[cfg.auth_header || 'X-API-Key'] = cfg.auth_value;
  else if (cfg.auth_type === 'basic' && cfg.auth_value) h.Authorization = 'Basic ' + Buffer.from(cfg.auth_value).toString('base64');
  return h;
}

async function push(db, id, user, { auto = false } = {}) {
  const cfg = await getConfig(db);
  if (!cfg.url) throw new Error('The HRMS address is not set yet — add it in Settings → HRMS hand-over.');
  const { payload, files } = await buildPayload(db, id, { docs: cfg.docs_mode === 'base64' ? 'base64' : 'none' });
  let res; let text = '';
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 60000);
    try {
      if (cfg.docs_mode === 'multipart') {
        const fd = new FormData();
        fd.append('data', JSON.stringify(payload));
        for (const f of files) if (fs.existsSync(f.file_path)) fd.append(f.doc_type, new Blob([fs.readFileSync(f.file_path)], { type: f.mime_type }), f.file_name);
        res = await fetch(cfg.url, { method: 'POST', headers: authHeaders(cfg), body: fd, signal: ctl.signal });
      } else {
        res = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeaders(cfg) }, body: JSON.stringify(payload), signal: ctl.signal });
      }
    } finally { clearTimeout(t); }
    text = (await res.text().catch(() => '')).slice(0, 500);
    if (!res.ok) throw new Error(`HRMS replied ${res.status}${text ? ': ' + text.replace(/\s+/g, ' ').slice(0, 200) : ''}`);
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'The HRMS did not answer within 60 seconds.' : (err.cause && err.cause.code ? `${err.message} (${err.cause.code})` : err.message);
    await db.dbRun("UPDATE onboarding SET hrms_status = 'Failed', hrms_error = ?, hrms_attempts = COALESCE(hrms_attempts,0) + 1, updated_at = datetime('now') WHERE id = ?", [msg.slice(0, 400), id]);
    await db.logAudit(user ? user.id : null, user ? user.full_name : 'System', auto ? 'hrms_push_failed_auto' : 'hrms_push_failed', 'onboarding', id, { error: msg.slice(0, 200) });
    throw new Error(msg);
  }
  await db.dbRun("UPDATE onboarding SET hrms_status = 'Sent', hrms_error = NULL, hrms_response = ?, hrms_pushed_at = datetime('now'), hrms_attempts = COALESCE(hrms_attempts,0) + 1, updated_at = datetime('now') WHERE id = ?", [text, id]);
  await db.logAudit(user ? user.id : null, user ? user.full_name : 'System', auto ? 'hrms_push_auto' : 'hrms_push', 'onboarding', id, { documents: payload.documents.length });
  return { ok: true, documents: payload.documents.length };
}

// Runs when a Joining record becomes Joined (with a date) and when the candidate submits / HR verifies.
// Sends only when everything is in place; otherwise says what it is waiting for.
async function maybeAutoPush(db, candidateId, user, vacancyId) {
  try {
    const cfg = await getConfig(db);
    const rows = await db.dbAll("SELECT * FROM onboarding WHERE candidate_id = ? AND is_deleted = 0 AND COALESCE(hrms_status,'') != 'Sent' ORDER BY created_at DESC", [candidateId]);
    const row = vacancyId ? (rows.find((r) => r.vacancy_id === vacancyId) || rows[0]) : rows[0];
    const joined = await db.dbGet("SELECT * FROM joining WHERE candidate_id = ? AND status = 'Joined' AND COALESCE(actual_date,'') != '' AND is_deleted = 0 ORDER BY updated_at DESC LIMIT 1", [candidateId]);
    if (!joined) return { waiting: 'The candidate is not marked Joined with a joining date yet.' };
    if (!row) return { waiting: 'The candidate has no onboarding form yet — send them the link from Onboarding.' };
    if (!['Submitted', 'Verified'].includes(row.status)) return { waiting: 'The candidate has not submitted the onboarding form yet; it will be sent to the HRMS as soon as they do.' };
    if (cfg.require_verified && row.status !== 'Verified') return { waiting: 'Waiting for HR to verify the form (required in Settings).' };
    if (!cfg.enabled || !cfg.auto_push) return { waiting: 'Ready for the HRMS — automatic hand-over is off, press "Send to HRMS" on the Onboarding screen.' };
    await push(db, row.id, user || null, { auto: true });
    return { sent: true };
  } catch (err) { return { error: err.message }; }
}

// Hourly: retry anything that failed (up to 5 tries) and anything that became ready while HRMS was switched off.
async function retryPending(db) {
  const cfg = await getConfig(db);
  if (!cfg.enabled || !cfg.auto_push || !cfg.url) return 0;
  const rows = await db.dbAll(`SELECT o.candidate_id, o.vacancy_id FROM onboarding o JOIN joining j ON j.candidate_id = o.candidate_id AND j.status = 'Joined' AND COALESCE(j.actual_date,'') != '' AND j.is_deleted = 0
    WHERE o.is_deleted = 0 AND o.status IN ('Submitted','Verified') AND COALESCE(o.hrms_status,'') != 'Sent' AND COALESCE(o.hrms_attempts,0) < 5`);
  let n = 0;
  for (const r of rows) { const out = await maybeAutoPush(db, r.candidate_id, null, r.vacancy_id); if (out.sent) n++; }
  return n;
}

// ---- Download everything for one candidate as a ZIP (for manual HRMS upload) ----
async function buildPackage(db, id, archive) {
  const { payload, row, files } = await buildPayload(db, id, { docs: 'none' });
  archive.append(JSON.stringify(payload, null, 2), { name: 'employee-details.json' });
  const flat = []; const walk = (prefix, o) => { for (const [k, v] of Object.entries(o)) { if (v && typeof v === 'object' && !Array.isArray(v)) walk(prefix + k + ' / ', v); else flat.push([prefix + k, v === null || v === undefined ? '' : String(v)]); } };
  walk('', { ...payload.job && { job: payload.job }, ...payload.employee });
  const XLSX = require('xlsx'); const ws = XLSX.utils.aoa_to_sheet([['Field', 'Value'], ...flat]); ws['!cols'] = [{ wch: 44 }, { wch: 50 }];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Employee details');
  archive.append(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { name: 'employee-details.xlsx' });
  const label = Object.fromEntries(DOC_TYPES.map((d) => [d.key, d.label]));
  const n = {};
  for (const f of files) {
    if (!fs.existsSync(f.file_path)) continue;
    n[f.doc_type] = (n[f.doc_type] || 0) + 1;
    archive.file(f.file_path, { name: `documents/${(label[f.doc_type] || f.doc_type).replace(/[^\w ]+/g, '').trim().replace(/\s+/g, '_')}_${n[f.doc_type]}${path.extname(f.file_path)}` });
  }
  // the candidate's CV and assessment report travel with the package
  const included = [];
  try {
    const rs = await db.dbGet('SELECT file_name, file_path FROM resumes WHERE candidate_id = ? ORDER BY is_current DESC, version DESC LIMIT 1', [row.candidate_id]);
    if (rs && rs.file_path && fs.existsSync(rs.file_path)) { archive.file(rs.file_path, { name: `resume/${String(rs.file_name || 'Resume' + path.extname(rs.file_path)).replace(/[\\/:*?"<>|]+/g, '_')}` }); included.push('Resume: included'); }
    else included.push('Resume: NOT on file — upload it on the candidate record');
  } catch (e) { included.push('Resume: could not be added (' + e.message + ')'); }
  try {
    const rep = require('./candidateReports');
    const d = await rep.candidateData({ dbAll: db.dbAll, dbGet: db.dbGet }, row.candidate_id);
    const buf = d ? await rep.assessmentDocx(d) : null;
    if (buf) { archive.append(buf, { name: `assessment-report/Assessment Report - ${String(d.c.full_name || 'candidate').replace(/[^\w ]+/g, '').trim()}.docx` }); included.push('Assessment report: included'); }
    else included.push('Assessment report: NOT available — no assessment is recorded for this candidate');
  } catch (e) { included.push('Assessment report: could not be added (' + e.message + ')'); }
  archive.append(`Onboarding package\r\n\r\nemployee-details.json / .xlsx : the details the candidate filled in\r\ndocuments/ : the documents the candidate uploaded\r\nresume/ : the candidate's resume\r\nassessment-report/ : assessment results\r\n\r\n${included.join('\r\n')}\r\n`, { name: 'README.txt' });
  return row;
}

module.exports = { SECTIONS, DOC_TYPES, isEnabled, ensureLink, buildUrl, getPublic, save, addDoc, removeDoc, list, detail, docFile, setVerified, reopen, sendLinkEmail,
  getConfig, getPublicConfig, saveConfig, buildPayload, push, maybeAutoPush, retryPending, buildPackage, validate, clean };
