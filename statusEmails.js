// Emails the candidate when their application moves to a new status, so nobody has to remember to send them.
// Which statuses send an email is switched on / off by an admin (Admin -> Email templates). The wording comes
// from the same templates recruiters use by hand. Every send is logged on the candidate's communications and in
// auto_email_log (one email per application and status, so reopening and re-closing never sends twice).
// Interview invites, offer and appointment-letter emails already go out from their own steps, so those are not repeated.
const { v4: uuidv4 } = require('uuid');
const { sendMail } = require('./mailer');
const emailTemplates = require('./emailTemplates');

const RULES = [
  { status: 'Screening', label: 'Moved to Screening', template: 'status_update', on: false, hint: 'A short "still under review" update' },
  { status: 'Shortlisted', label: 'Shortlisted', template: 'shortlisted', on: true, hint: 'Tells the candidate their profile is shortlisted' },
  { status: 'Rejected', label: 'Rejected / not selected', template: 'rejection_*', on: true, hint: 'Polite rejection — the "after interview" wording is used if they had reached the interview stage' },
  { status: 'Joined', label: 'Joined', template: 'welcome_joined', on: true, hint: 'Welcome message once the joining is recorded' }
];
const KEY = 'auto_status_emails';

async function getConfig(db) {
  const row = await db.dbGet('SELECT value FROM settings WHERE key = ?', [KEY]);
  let saved = {}; try { saved = JSON.parse((row && row.value) || '{}'); } catch { saved = {}; }
  return Object.fromEntries(RULES.map((r) => [r.status, saved[r.status] === undefined ? r.on : !!saved[r.status]]));
}
async function saveConfig(db, body) {
  const cfg = await getConfig(db);
  for (const r of RULES) if (body && body[r.status] !== undefined) cfg[r.status] = !!body[r.status];
  const v = JSON.stringify(cfg);
  if (await db.dbGet('SELECT key FROM settings WHERE key = ?', [KEY])) await db.dbRun("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?", [v, KEY]);
  else await db.dbRun('INSERT INTO settings (key, value) VALUES (?, ?)', [KEY, v]);
  return cfg;
}

// Returns a short sentence for the recruiter ("Email sent to the candidate (Shortlisted)"), or null when nothing was sent.
async function notify(db, { application, from, to, user }) {
  try {
    if (!application || !to || from === to) return null;
    const rule = RULES.find((r) => r.status === to);
    if (!rule) return null;
    const cfg = await getConfig(db);
    if (!cfg[to]) return null;
    if (await db.dbGet('SELECT id FROM auto_email_log WHERE application_id = ? AND status = ?', [application.id, to])) return null;
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return `Status email not sent — email is not set up on this server`;
    let key = rule.template;
    if (to === 'Rejected') key = ['Interview', 'Offered'].includes(from) ? 'rejection_interview' : 'rejection_screening';
    const msg = await emailTemplates.render(db, key, { application_id: application.id }, user || null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(msg.to || '')) return `Status email not sent — ${msg.template_name ? 'the candidate' : 'candidate'} has no valid email address`;
    if (/\[\[[^\]]+\]\]|\{\{\w+\}\}/.test(msg.subject + msg.body)) return 'Status email not sent — the template still has an unfilled field (Admin → Email templates)';
    const ctx = await db.dbGet('SELECT v.assigned_recruiter_id FROM applications a LEFT JOIN vacancies v ON v.id = a.vacancy_id WHERE a.id = ?', [application.id]);
    const rec = ctx && ctx.assigned_recruiter_id ? await db.dbGet('SELECT email FROM users WHERE id = ?', [ctx.assigned_recruiter_id]) : null;
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const html = msg.body.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px;">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
    await sendMail({ to: msg.to, cc: rec && rec.email ? rec.email : undefined, replyTo: rec && rec.email ? rec.email : undefined, subject: msg.subject, html });
    await db.dbRun('INSERT INTO auto_email_log (id, application_id, status, to_email) VALUES (?,?,?,?)', [uuidv4(), application.id, to, msg.to]);
    await db.dbRun(`INSERT INTO communications (id, candidate_id, date, type, direction, subject, notes, created_by) VALUES (?, ?, date('now'), 'Email', 'Outbound', ?, ?, ?)`,
      [uuidv4(), msg.candidate_id, msg.subject, msg.body, (user && user.id) || null]);
    await db.logAudit((user && user.id) || null, (user && user.full_name) || 'System', 'auto_status_email', 'applications', application.id, { status: to, to: msg.to });
    return `Email sent to the candidate (${rule.label.toLowerCase()})`;
  } catch (err) {
    console.warn(`⚠️  Status email not sent (${to}):`, err.message);
    return `Status email not sent — ${err.message}`;
  }
}

module.exports = { RULES, getConfig, saveConfig, notify };
