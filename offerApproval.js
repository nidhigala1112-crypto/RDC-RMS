// Offer approval by the company's Authorized Signatory, with an electronic signature.
//   1. The recruiter presses "Send for approval" -> the signatory gets an email with a private link (valid 7 days).
//   2. The signatory reviews the offer on that page and either approves + signs, or asks for changes.
//   3. On approval the offer becomes "Approved", the signature is stamped on the appointment letter, and the
//      signed letter is emailed to the candidate (same email as before). The signatory's name, time, IP address
//      and a fingerprint of the offer figures are kept as the audit trail.
// This is an electronic signature with an audit trail. It is not a Class 3 Digital Signature Certificate (DSC) /
// Aadhaar eSign; if the company needs one of those, a signing provider has to be connected.
const crypto = require('crypto');
const { sendMail } = require('./mailer');
const { sendAppointmentLetterEmail } = require('./offerNotify');
const { buildAppointmentLetterDocx } = require('./offerLetter');

const EXPIRY_DAYS = 7;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => (n === null || n === undefined || n === '' ? '—' : '₹ ' + Number(n).toLocaleString('en-IN'));
const fmtD = (d) => { if (!d) return '—'; const x = new Date(d); return isNaN(x) ? String(d) : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
const iso = (days) => new Date(Date.now() + days * 86400000).toISOString();

// A fingerprint of what the signatory saw, so a later change to the figures is detectable.
const fingerprint = (o) => crypto.createHash('sha256').update(JSON.stringify([o.id, o.candidate_id, o.vacancy_id, o.offered_ctc, o.basic_pay, o.hra, o.special_allowance, o.lta, o.employer_pf, o.gratuity, o.variable_component, o.joining_bonus, o.expected_joining, o.valid_till, o.letter_remarks])).digest('hex');

async function context({ dbGet }, offerId) {
  const offer = await dbGet('SELECT * FROM offers WHERE id = ? AND is_deleted = 0', [offerId]);
  if (!offer) return null;
  const [candidate, vacancy] = await Promise.all([dbGet('SELECT * FROM candidates WHERE id = ?', [offer.candidate_id]), dbGet('SELECT * FROM vacancies WHERE id = ?', [offer.vacancy_id])]);
  const company = vacancy && vacancy.company ? await dbGet('SELECT * FROM clients WHERE company_name = ?', [vacancy.company]) : null;
  const recruiter = vacancy && vacancy.assigned_recruiter_id ? await dbGet('SELECT full_name, email FROM users WHERE id = ?', [vacancy.assigned_recruiter_id]) : null;
  return { offer, candidate, vacancy, company, recruiter };
}

function summaryRows(x) {
  const { offer: o, candidate: c, vacancy: v } = x;
  return [['Candidate', c && c.full_name], ['Position', v && v.title], ['Company', v && v.company], ['Location', v && v.location], ['Type of employment', v && v.job_type],
    ['Annual CTC', inr(o.offered_ctc)], ['Basic pay (per month)', inr(o.basic_pay)], ['House rent allowance (per month)', inr(o.hra)], ['Special allowance (per month)', inr(o.special_allowance)],
    ['LTA (per month)', inr(o.lta)], ['Employer PF (per month)', inr(o.employer_pf)], ['Gratuity (per month)', inr(o.gratuity)], ['Variable (per month)', o.variable_component ? inr(o.variable_component) : null],
    ['Joining bonus', o.joining_bonus ? inr(o.joining_bonus) : null], ['Offer date', fmtD(o.offer_date)], ['Valid till', fmtD(o.valid_till)], ['Expected joining', fmtD(o.expected_joining)], ['Remarks', o.letter_remarks]]
    .filter(([, val]) => val !== null && val !== undefined && val !== '' && val !== '—');
}


// The signatories a recruiter can pick for an offer: those for the offer's company, plus any marked for all companies.
async function signatoryOptions({ dbGet, dbAll }, offerId) {
  const x = await context({ dbGet }, offerId);
  if (!x) throw new Error('Offer not found.');
  const company = x.vacancy && x.vacancy.company;
  const rows = await dbAll("SELECT id, name, designation, email, company FROM signatories WHERE is_deleted = 0 AND is_active = 1 AND COALESCE(email,'') != '' AND (COALESCE(company,'') = '' OR company = ?) ORDER BY name", [company || '']);
  const o = x.offer;
  // the recruiter chooses: nothing is pre-selected unless it is the only option or the one this offer was already sent to
  let def = rows.find((r) => o.approval_requested_to && r.email.toLowerCase() === o.approval_requested_to.toLowerCase());
  return { options: rows, default_id: def ? def.id : (rows.length === 1 ? rows[0].id : null), company };
}
// Name / designation / email that apply to this offer: the one chosen at "Send for approval", else the company's default.
function signerOf(offer, company) {
  return { name: (offer && offer.signatory_name) || (company && company.signatory_name) || '', designation: (offer && offer.signatory_designation) || (company && company.signatory_designation) || 'Authorised Signatory',
    email: (offer && offer.approval_requested_to) || (company && company.signatory_email) || '' };
}

async function requestApproval(db, offerId, { baseUrl, user, signatoryId }) {
  const x = await context(db, offerId);
  if (!x) throw new Error('Offer not found.');
  const { offer, candidate, vacancy, company, recruiter } = x;
  if (!['Draft', 'Changes Requested', 'Pending Approval'].includes(offer.status)) throw new Error(`This offer is already ${offer.status.toLowerCase()}.`);
  if (!candidate || !vacancy) throw new Error('The offer needs a candidate and a vacancy.');
  if (!company) throw new Error(`No company record for "${vacancy.company || 'this vacancy'}" — set the Company on the vacancy and check the Companies screen.`);
  // who signs: the person the recruiter picked; with no pick, the company's default (only if it is the sole option)
  const opts = await signatoryOptions({ dbGet: db.dbGet, dbAll: db.dbAll }, offerId);
  let chosen = null;
  if (signatoryId) {
    chosen = opts.options.find((r) => r.id === signatoryId);
    if (!chosen) throw new Error('That Authorized Signatory is not available for this company. Pick another one.');
  } else if (opts.default_id && opts.options.length === 1) chosen = opts.options[0];
  else if (company.signatory_email && !opts.options.length) chosen = { name: company.signatory_name, designation: company.signatory_designation, email: company.signatory_email };
  if (!chosen) throw new Error(opts.options.length ? 'Choose the Authorized Signatory who should approve this offer.' : `No Authorized Signatory is set up for ${company.company_name}. Add one under Admin → Signatories.`);
  if (!offer.offered_ctc || !offer.basic_pay) throw new Error('Enter the Annual CTC and press "Calculate breakdown" first, then save the offer.');
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) throw new Error('Email is not set up on this server yet (SMTP_USER / SMTP_PASS in .env).');

  const token = crypto.randomBytes(24).toString('hex');
  const link = `${String(baseUrl).replace(/\/$/, '')}/offer-approval/${token}`;
  await db.dbRun(`UPDATE offers SET status = 'Pending Approval', approval_token = ?, approval_token_expires = ?, approval_requested_at = datetime('now'), approval_requested_to = ?,
    approval_note = NULL, approval_decision = NULL, signatory_name = ?, signatory_designation = ?, signatory_email = ?, updated_at = datetime('now') WHERE id = ?`, [token, iso(EXPIRY_DAYS), chosen.email, chosen.name || null, chosen.designation || null, chosen.email, offerId]);

  const rows = summaryRows(x).map(([k, v]) => `<tr><td style="padding:5px 10px; color:#6E7169; border-bottom:1px solid #EEE;">${esc(k)}</td><td style="padding:5px 10px; border-bottom:1px solid #EEE;"><strong>${esc(v)}</strong></td></tr>`).join('');
  try {
    await sendMail({
      to: chosen.email, cc: recruiter && recruiter.email ? recruiter.email : undefined, replyTo: recruiter && recruiter.email ? recruiter.email : undefined,
      subject: `Offer approval needed — ${candidate.full_name} (${vacancy.title})`,
      html: `<div style="font-family:Arial,sans-serif; max-width:600px; font-size:14px; color:#23271F; line-height:1.6;">
        <p>Dear ${esc(chosen.name || 'Sir/Madam')},</p>
        <p>An offer for <strong>${esc(candidate.full_name)}</strong> (${esc(vacancy.title)}${vacancy.location ? ', ' + esc(vacancy.location) : ''}) needs your approval and signature${recruiter ? ` — requested by ${esc(recruiter.full_name)}` : ''}.</p>
        <table style="border-collapse:collapse; width:100%; margin:12px 0;">${rows}</table>
        <p><a href="${esc(link)}" style="background:#FFC72C; color:#1E2422; padding:11px 20px; border-radius:8px; text-decoration:none; font-weight:bold; display:inline-block;">Review, approve and sign</a></p>
        <p style="color:#6E7169; font-size:12.5px;">The link is private to you and valid for ${EXPIRY_DAYS} days. On approval, the appointment letter carrying your signature is sent to the candidate automatically. You can also ask for changes on the same page.</p>
        <p style="color:#9A9C92; font-size:11px; margin-top:24px;">Sent by RDC's Recruitment Management System${user ? ' on behalf of ' + esc(user.full_name) : ''}.</p></div>`
    });
  } catch (e) {
    await db.dbRun("UPDATE offers SET status = ?, approval_token = NULL, updated_at = datetime('now') WHERE id = ?", [offer.status, offerId]); // roll back: nothing was sent
    throw new Error(`The email could not be sent: ${e.message}`);
  }
  return { to: chosen.email, name: chosen.name, expires_at: iso(EXPIRY_DAYS) };
}

async function load(db, token) {
  if (!/^[a-f0-9]{48}$/.test(String(token || ''))) return { error: 'This link is not valid.', status: 404 };
  const row = await db.dbGet('SELECT id FROM offers WHERE approval_token = ? AND is_deleted = 0', [token]);
  if (!row) return { error: 'This link is not valid or has been replaced by a newer one.', status: 404 };
  const x = await context(db, row.id);
  return { x };
}

async function getPublic(db, token) {
  const { x, error, status } = await load(db, token);
  if (error) return { error, status };
  const o = x.offer;
  const expired = !o.approval_token_expires || o.approval_token_expires <= new Date().toISOString();
  return { data: {
    candidate: x.candidate && x.candidate.full_name, position: x.vacancy && x.vacancy.title, company: x.vacancy && x.vacancy.company,
    signatory: signerOf(x.offer, x.company).name, designation: signerOf(x.offer, x.company).designation,
    rows: summaryRows(x), requested_by: x.recruiter && x.recruiter.full_name, requested_at: o.approval_requested_at,
    expires_at: o.approval_token_expires, expired, state: o.status === 'Pending Approval' ? 'pending' : o.approval_decision === 'approved' ? 'approved' : o.approval_decision === 'changes' ? 'changes' : 'closed',
    decided_at: o.approved_at, decided_by: o.approved_by_name, note: o.approval_note
  } };
}

// Unsigned preview of the letter, so the signatory can read it before signing.
async function previewLetter(db, token) {
  const { x, error, status } = await load(db, token);
  if (error) return { error, status };
  if (!x.company) return { error: 'No company record.', status: 400 };
  const offer = { ...x.offer, approval_signature: null, approved_by_name: null };
  return { buffer: await buildAppointmentLetterDocx({ candidate: x.candidate, vacancy: x.vacancy, offer, company: x.company }), name: `Appointment Letter (preview) - ${x.candidate.full_name}.docx` };
}

const SIG_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

async function decide(db, token, body, meta) {
  const { x, error, status } = await load(db, token);
  if (error) return { error, status };
  const o = x.offer;
  if (!o.approval_token_expires || o.approval_token_expires <= new Date().toISOString()) return { error: 'This link has expired. Ask the recruiter to send it again.', status: 410 };
  if (o.status !== 'Pending Approval') return { error: 'This offer has already been dealt with.', status: 409 };
  const decision = body && body.decision === 'approve' ? 'approve' : body && body.decision === 'changes' ? 'changes' : null;
  if (!decision) return { error: 'Choose Approve or Request changes.', status: 400 };

  if (decision === 'changes') {
    const note = String(body.note || '').trim().slice(0, 1500);
    if (!note) return { error: 'Please say what needs to change.', status: 400 };
    await db.dbRun("UPDATE offers SET status = 'Changes Requested', approval_decision = 'changes', approval_note = ?, approved_by_name = ?, approved_at = datetime('now'), approval_ip = ?, approval_token = NULL, updated_at = datetime('now') WHERE id = ?",
      [note, String(body.name || signerOf(x.offer, x.company).name || '').slice(0, 120), meta.ip, o.id]);
    await notifyRecruiter(db, x, `Changes requested on the offer for ${x.candidate.full_name}`, `<p>${esc(signerOf(x.offer, x.company).name || 'The signatory')} asked for changes:</p><blockquote style="border-left:3px solid #FFC72C; margin:8px 0; padding:4px 12px;">${esc(note)}</blockquote><p>Update the offer and press <strong>Send for approval</strong> again.</p>`);
    return { ok: true, decision, id: o.id, offer: x.offer, candidateId: o.candidate_id };
  }

  const name = String(body.name || '').trim().slice(0, 120);
  if (name.length < 3) return { error: 'Please type your full name.', status: 400 };
  if (!body.consent) return { error: 'Please tick the box to confirm you approve this offer.', status: 400 };
  let signature = null;
  if (body.signature) {
    const okPng = SIG_RE.test(body.signature) && body.signature.length <= 400000
      && Buffer.from(body.signature.split(',')[1], 'base64').subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!okPng) return { error: 'The signature image is not valid — clear it and draw again, or leave it blank to use your typed name.', status: 400 };
    signature = body.signature;
  }
  const hash = fingerprint(o);
  await db.dbRun(`UPDATE offers SET status = 'Approved', approval_decision = 'approved', approved_by_name = ?, approved_at = datetime('now'), approval_signature = ?, approval_ip = ?, approval_agent = ?,
    approval_hash = ?, approval_note = NULL, approval_token = NULL, updated_at = datetime('now') WHERE id = ?`, [name, signature, meta.ip, String(meta.agent || '').slice(0, 250), hash, o.id]);
  let letter = { sent: false };
  try { const r = await sendAppointmentLetterEmail(db, o.id); letter = { sent: true, to: r.recipients }; }
  catch (e) { letter = { sent: false, error: e.message }; }
  await notifyRecruiter(db, x, `Offer approved — ${x.candidate.full_name}`, `<p><strong>${esc(name)}</strong> approved and signed the offer for ${esc(x.candidate.full_name)} (${esc(x.vacancy.title)}).</p>${letter.sent ? `<p>The signed appointment letter has been emailed to ${esc(letter.to.join(', '))}.</p>` : `<p style="color:#B3261E;">The appointment letter could not be emailed automatically (${esc(letter.error)}). Open the offer and use <strong>Email it now</strong>.</p>`}`);
  return { ok: true, decision, id: o.id, letter, candidateId: o.candidate_id };
}

async function notifyRecruiter(db, x, subject, inner) {
  try {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return;
    const to = [x.recruiter && x.recruiter.email].filter(Boolean);
    if (!to.length) return;
    await sendMail({ to: to.join(', '), subject, html: `<div style="font-family:Arial,sans-serif; max-width:560px; font-size:14px; line-height:1.6;">${inner}<p style="color:#9A9C92; font-size:11px; margin-top:24px;">Sent by RDC's Recruitment Management System.</p></div>` });
  } catch (e) { console.warn('⚠️  Could not notify the recruiter about the offer decision:', e.message); }
}

module.exports = { signatoryOptions, signerOf, requestApproval, getPublic, previewLetter, decide, EXPIRY_DAYS };
