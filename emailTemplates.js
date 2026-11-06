// One-click candidate emails (shortlist, rejection, documents needed...). A recruiter picks a template from an
// application, sees the filled-in email, can edit it, and sends. Optionally the application status is updated
// in the same step, and the email is logged on the candidate's communication history. Replies go to the
// recruiter (Reply-To), not the shared mailbox.
const { v4: uuidv4 } = require('uuid');
const { sendMail } = require('./mailer');

const SIGN = '\n\nRegards,\n{{recruiter_name}}\n{{company}}';
const DEFAULTS = [
  { key: 'shortlisted', name: 'Shortlisted — next steps', set_status: 'Shortlisted', reject_reason: '',
    subject: 'Your application for {{role}} — {{company}}',
    body: 'Dear {{candidate_name}},\n\nThank you for your interest in the {{role}} position at {{company}}. We are pleased to let you know that your profile has been shortlisted.\n\nWe will contact you shortly with the next steps.' + SIGN },
  { key: 'welcome_joined', name: 'Welcome — joined', set_status: '', reject_reason: '',
    subject: 'Welcome to {{company}}',
    body: 'Dear {{candidate_name}},\n\nWelcome to {{company}}! We are delighted to have you join us as {{role}}.\n\nYour joining has been recorded in our system. If you have any questions in your first days, please reach out to us.\n\nWe wish you a great start.' + SIGN },
  { key: 'status_update', name: 'Application update — still in process', set_status: '', reject_reason: '',
    subject: 'Update on your application — {{role}}',
    body: 'Dear {{candidate_name}},\n\nThank you for your patience. This is a quick update on your application for {{role}} at {{company}}: your profile is still under review and we will get back to you as soon as we have news.' + SIGN },
  { key: 'rejection_screening', name: 'Not shortlisted', set_status: 'Rejected', reject_reason: 'Not shortlisted',
    subject: 'Your application for {{role}} — {{company}}',
    body: 'Dear {{candidate_name}},\n\nThank you for applying for the {{role}} position at {{company}} and for the time you invested in your application.\n\nAfter careful review, we will not be moving forward with your profile for this role. We will keep your details on file and may reach out if a suitable opportunity arises.\n\nWe wish you all the best in your career.' + SIGN },
  { key: 'rejection_interview', name: 'Not selected — after interview', set_status: 'Rejected', reject_reason: 'Not selected after interview',
    subject: 'Your interview for {{role}} — {{company}}',
    body: 'Dear {{candidate_name}},\n\nThank you for taking the time to interview with us for the {{role}} position at {{company}}. We enjoyed learning about your experience.\n\nAfter careful consideration, we have decided not to proceed with your candidature for this role. This was not an easy decision, and we appreciate your interest in {{company}}.\n\nWe wish you every success ahead.' + SIGN },
  { key: 'position_closed', name: 'Position closed / on hold', set_status: 'Rejected', reject_reason: 'Position closed',
    subject: 'Update on the {{role}} position — {{company}}',
    body: 'Dear {{candidate_name}},\n\nThank you for your interest in the {{role}} position at {{company}}. We wanted to let you know that this position has now been closed, so we will not be taking your application further for this role.\n\nWe appreciate the time you gave us and will keep your profile in mind for future openings.' + SIGN },
  { key: 'documents_needed', name: 'Documents needed', set_status: '', reject_reason: '',
    subject: 'Documents required — {{role}}, {{company}}',
    body: 'Dear {{candidate_name}},\n\nTo move ahead with your application for {{role}} at {{company}}, please send us the following documents:\n\n[[list the documents needed]]\n\nYou can reply to this email with them attached.' + SIGN },
  { key: 'assessment_invite', name: 'Assessment invitation', set_status: '', reject_reason: '',
    subject: 'Assessment for {{role}} — {{company}}',
    body: 'Dear {{candidate_name}},\n\nAs part of the selection process for {{role}} at {{company}}, please complete the assessment at the link below:\n\n[[paste the assessment link]]\n\nIt is best taken in one sitting without interruptions. Please let us know once you have completed it.' + SIGN }
];

async function seed({ dbRun }) {
  for (const t of DEFAULTS) {
    await dbRun('INSERT OR IGNORE INTO email_templates (key, name, subject, body, set_status, reject_reason) VALUES (?,?,?,?,?,?)',
      [t.key, t.name, t.subject, t.body, t.set_status, t.reject_reason]);
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function textToHtml(text) {
  const linked = esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  return `<div style="font-family:Arial,sans-serif; font-size:14px; line-height:1.6; color:#23271F; max-width:620px;">${
    linked.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px;">${p.replace(/\n/g, '<br>')}</p>`).join('')}</div>`;
}

function fill(text, vars) { return String(text || '').replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== '' ? vars[k] : m)); }

async function loadContext({ dbGet }, { application_id, candidate_id, vacancy_id }, user) {
  let app = null;
  if (application_id) app = await dbGet('SELECT * FROM applications WHERE id = ? AND is_deleted = 0', [application_id]);
  const cid = (app && app.candidate_id) || candidate_id; const vid = (app && app.vacancy_id) || vacancy_id;
  const candidate = cid ? await dbGet('SELECT * FROM candidates WHERE id = ? AND is_deleted = 0', [cid]) : null;
  const vacancy = vid ? await dbGet('SELECT * FROM vacancies WHERE id = ? AND is_deleted = 0', [vid]) : null;
  if (!candidate) throw new Error('Candidate not found');
  let recruiter = user;
  if (vacancy && vacancy.assigned_recruiter_id) { const r = await dbGet('SELECT full_name, email FROM users WHERE id = ?', [vacancy.assigned_recruiter_id]); if (r) recruiter = r; }
  return { app, candidate, vacancy, recruiter };
}

async function listTemplates({ dbAll }) { return dbAll('SELECT key, name, subject, body, set_status, reject_reason, updated_at FROM email_templates ORDER BY rowid'); }

async function render(db, key, ref, user) {
  const t = await db.dbGet('SELECT * FROM email_templates WHERE key = ?', [key]);
  if (!t) throw new Error('Template not found');
  const { app, candidate, vacancy, recruiter } = await loadContext(db, ref, user);
  const vars = {
    candidate_name: candidate.full_name, first_name: String(candidate.full_name || '').split(/\s+/)[0],
    role: vacancy ? vacancy.title : 'the position', company: vacancy && vacancy.company ? vacancy.company : 'RDC Group',
    location: vacancy ? vacancy.location || '' : '', recruiter_name: (recruiter && recruiter.full_name) || (user && user.full_name) || 'The Recruitment Team',
    recruiter_email: (recruiter && recruiter.email) || ''
  };
  return {
    template: t.key, template_name: t.name, to: candidate.email || '', subject: fill(t.subject, vars), body: fill(t.body, vars),
    set_status: app ? t.set_status || '' : '', reject_reason: t.reject_reason || '',
    application_id: app ? app.id : null, candidate_id: candidate.id, current_status: app ? app.status : null
  };
}

async function send(db, p, user) {
  const to = String(p.to || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('Enter a valid email address for the candidate.');
  if (!String(p.subject || '').trim() || !String(p.body || '').trim()) throw new Error('Subject and message cannot be empty.');
  if (/\[\[[^\]]+\]\]/.test(p.subject + p.body)) throw new Error('The message still has a [[placeholder]] to fill in — replace it before sending.');
  if (/\{\{\w+\}\}/.test(p.subject + p.body)) throw new Error('The message still has an unfilled {{field}} — please complete it.');
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) throw new Error('Email isn\'t configured on this server yet — SMTP_USER / SMTP_PASS are missing from .env.');
  await sendMail({ to, subject: p.subject, html: textToHtml(p.body), replyTo: user && user.email ? user.email : undefined });

  const candidate = p.candidate_id ? await db.dbGet('SELECT id FROM candidates WHERE id = ?', [p.candidate_id]) : null;
  if (candidate) {
    await db.dbRun(`INSERT INTO communications (id, candidate_id, date, type, direction, subject, notes, created_by) VALUES (?, ?, date('now'), 'Email', 'Outbound', ?, ?, ?)`,
      [uuidv4(), candidate.id, p.subject, p.body, user.id]);
  }
  let statusChanged = null;
  if (p.set_status && p.application_id) {
    const app = await db.dbGet('SELECT id, status FROM applications WHERE id = ? AND is_deleted = 0', [p.application_id]);
    const ORDER = { Sourced: 0, Screening: 1, Shortlisted: 2, Interview: 3, Offered: 4, Joined: 5 };
    const closing0 = ['Rejected', 'Withdrawn'].includes(p.set_status);
    // Closing statuses (Rejected/Withdrawn) apply from any open stage; a forward status (e.g. Shortlisted) only ever
    // moves an application forward, so an email can never pull someone back from Interview to Shortlisted.
    const allowed = app && app.status !== p.set_status && app.status !== 'Joined'
      && (closing0 ? true : (app.status in ORDER && ORDER[p.set_status] > ORDER[app.status]));
    if (allowed) {
      const closing = closing0;
      await db.dbRun("UPDATE applications SET status = ?, rejection_reason = CASE WHEN ? = 1 THEN COALESCE(NULLIF(rejection_reason, ''), ?) ELSE rejection_reason END, updated_at = datetime('now') WHERE id = ?",
        [p.set_status, closing ? 1 : 0, p.reject_reason || 'Closed by recruiter', app.id]);
      await db.logActivity('applications', app.id, `Status set by email (${p.template || 'custom'})`, app.status, p.set_status, user.id, user.full_name);
      statusChanged = p.set_status;
    }
  }
  await db.logAudit(user.id, user.full_name, 'send_email', 'candidates', p.candidate_id || '', { template: p.template, to, status: statusChanged });
  return { sent: true, to, statusChanged };
}

// Rejects every still-open applicant of a vacancy, emailing each one the "position closed" template.
async function closeOut(db, vacancyId, { sendEmails = true } = {}, user) {
  const vacancy = await db.dbGet('SELECT id FROM vacancies WHERE id = ? AND is_deleted = 0', [vacancyId]);
  if (!vacancy) throw new Error('Vacancy not found');
  const apps = await db.dbAll("SELECT id, candidate_id FROM applications WHERE vacancy_id = ? AND is_deleted = 0 AND status NOT IN ('Joined','Rejected','Withdrawn')", [vacancyId]);
  const result = { total: apps.length, emailed: 0, rejected: 0, noEmail: 0, failed: [], emailNotConfigured: sendEmails && !(process.env.SMTP_USER && process.env.SMTP_PASS) };
  for (const a of apps) {
    try {
      const msg = await render(db, 'position_closed', { application_id: a.id }, user);
      if (sendEmails && msg.to && process.env.SMTP_USER && process.env.SMTP_PASS) {
        await send(db, { ...msg, template: 'position_closed' }, user); result.emailed += 1; result.rejected += 1;
      } else {
        if (sendEmails && !msg.to) result.noEmail += 1;
        await db.dbRun("UPDATE applications SET status = 'Rejected', rejection_reason = COALESCE(NULLIF(rejection_reason, ''), 'Position closed'), updated_at = datetime('now') WHERE id = ?", [a.id]);
        await db.logActivity('applications', a.id, 'Closed out with vacancy', null, 'Rejected', user.id, user.full_name);
        result.rejected += 1;
      }
    } catch (err) { result.failed.push({ application_id: a.id, error: err.message }); }
  }
  await db.logAudit(user.id, user.full_name, 'close_out_vacancy', 'vacancies', vacancyId, result);
  return result;
}

module.exports = { seed, listTemplates, render, send, closeOut, DEFAULTS };
