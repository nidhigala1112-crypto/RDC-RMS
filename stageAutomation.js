// Moves records forward on their own when something happens elsewhere, so recruiters don't have to update
// the same fact in three places:
//   interview scheduled        -> application becomes "Interview"
//   offer sent / accepted      -> application becomes "Offered"; accepted also creates the joining record
//   offer declined             -> application becomes "Withdrawn"
//   joining marked Joined      -> application "Joined", candidate "Placed"
//   joining marked Dropped     -> application "Withdrawn"
//   scorecard submitted        -> interview "Completed", application at least "Interview"
//   application Rejected / Withdrawn -> its upcoming interviews are cancelled (with the cancellation emails)
//                                       and its unsent offers are withdrawn
//   any status change          -> the candidate email set up under Admin -> Email templates (see statusEmails.js)
// Rules only ever move an application FORWARD along the pipeline and never touch one that is already
// Rejected, Withdrawn or Joined — a person's decision always wins over automation. Every automatic change is
// written to the audit log and activity history, and returned so the screen can tell the recruiter.
const { v4: uuidv4 } = require('uuid');
const statusEmails = require('./statusEmails');

const ORDER = { Sourced: 0, Screening: 1, Shortlisted: 2, Interview: 3, Offered: 4, Joined: 5 };
const TERMINAL = ['Rejected', 'Withdrawn', 'Joined'];
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

let db = null;
function init(deps) { db = deps; }

async function findApplication(ref) {
  let app = null;
  if (ref.application_id) app = await db.dbGet('SELECT * FROM applications WHERE id = ? AND is_deleted = 0', [ref.application_id]);
  if (!app && ref.candidate_id && ref.vacancy_id) {
    app = await db.dbGet('SELECT * FROM applications WHERE candidate_id = ? AND vacancy_id = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT 1', [ref.candidate_id, ref.vacancy_id]);
  }
  return app;
}

async function record(user, app, from, to, why) {
  await db.logActivity('applications', app.id, 'Stage moved automatically', from, to, user.id, user.full_name);
  await db.logAudit(user.id, user.full_name, 'auto_stage', 'applications', app.id, { from, to, why });
}

async function advance(ref, target, why, notes, user) {
  const app = await findApplication(ref);
  if (!app || !(app.status in ORDER) || ORDER[app.status] >= ORDER[target]) return;
  await db.dbRun("UPDATE applications SET status = ?, updated_at = datetime('now') WHERE id = ?", [target, app.id]);
  await record(user, app, app.status, target, why);
  notes.push(`Application moved to ${target}`);
  const mail = await statusEmails.notify(db, { application: app, from: app.status, to: target, user });
  if (mail) notes.push(mail);
}

async function withdraw(ref, reason, notes, user) {
  const app = await findApplication(ref);
  if (!app || TERMINAL.includes(app.status)) return;
  await db.dbRun("UPDATE applications SET status = 'Withdrawn', rejection_reason = COALESCE(NULLIF(rejection_reason, ''), ?), updated_at = datetime('now') WHERE id = ?", [reason, app.id]);
  await record(user, app, app.status, 'Withdrawn', reason);
  notes.push(`Application marked Withdrawn (${reason.toLowerCase()})`);
  await closeDownstream(app, notes, user);
}

// An application that ends (Rejected / Withdrawn) must not leave live interviews or unsent offers behind.
async function closeDownstream(app, notes, user) {
  const ivs = await db.dbAll("SELECT id, confirmation_sent FROM interviews WHERE is_deleted = 0 AND status IN ('Scheduled','Confirmed','Rescheduled') AND (application_id = ? OR (candidate_id = ? AND vacancy_id = ?))", [app.id, app.candidate_id, app.vacancy_id]);
  for (const iv of ivs) {
    await db.dbRun("UPDATE interviews SET status = 'Cancelled', updated_at = datetime('now') WHERE id = ?", [iv.id]);
    await db.logActivity('interviews', iv.id, 'Cancelled automatically (application closed)', null, 'Cancelled', user.id, user.full_name);
    if (iv.confirmation_sent) { try { await require('./interviewNotify').sendInterviewCancellation({ dbGet: db.dbGet, dbRun: db.dbRun }, iv.id); } catch (e) { console.warn('⚠️  Cancellation email not sent:', e.message); } }
  }
  if (ivs.length) notes.push(`${ivs.length} upcoming interview${ivs.length === 1 ? '' : 's'} cancelled`);
  const ofs = await db.dbAll("SELECT id FROM offers WHERE is_deleted = 0 AND status IN ('Draft','Changes Requested','Pending Approval') AND (application_id = ? OR (candidate_id = ? AND vacancy_id = ?))", [app.id, app.candidate_id, app.vacancy_id]);
  for (const o of ofs) {
    await db.dbRun("UPDATE offers SET status = 'Withdrawn', approval_token = NULL, updated_at = datetime('now') WHERE id = ?", [o.id]);
    await db.logActivity('offers', o.id, 'Withdrawn automatically (application closed)', null, 'Withdrawn', user.id, user.full_name);
  }
  if (ofs.length) notes.push(`${ofs.length} unsent offer${ofs.length === 1 ? '' : 's'} withdrawn`);
}

async function ensureJoining(offer, notes, user) {
  if (!offer.candidate_id || !offer.vacancy_id) return;
  const exists = await db.dbGet('SELECT id, offer_id FROM joining WHERE candidate_id = ? AND vacancy_id = ? AND is_deleted = 0 LIMIT 1', [offer.candidate_id, offer.vacancy_id]);
  if (exists) {
    if (!exists.offer_id) await db.dbRun('UPDATE joining SET offer_id = ? WHERE id = ?', [offer.id, exists.id]);
    return;
  }
  const [cand, vac] = await Promise.all([
    db.dbGet('SELECT notice_period FROM candidates WHERE id = ?', [offer.candidate_id]),
    db.dbGet('SELECT location FROM vacancies WHERE id = ?', [offer.vacancy_id])
  ]);
  let date = offer.expected_joining; let estimated = false;
  if (!date) {
    const days = parseInt(cand && cand.notice_period, 10);
    date = ymd(new Date(Date.now() + (days > 0 ? days : 30) * 86400000)); estimated = true;
  }
  const app = await findApplication({ candidate_id: offer.candidate_id, vacancy_id: offer.vacancy_id });
  const id = uuidv4();
  await db.dbRun(
    `INSERT INTO joining (id, offer_id, application_id, candidate_id, vacancy_id, expected_date, status, offered_ctc, joining_location, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 'Expected', ?, ?, ?)`,
    [id, offer.id, app ? app.id : null, offer.candidate_id, offer.vacancy_id, date, offer.offered_ctc || null, (vac && vac.location) || null, user.id]);
  await db.logActivity('joining', id, 'Created automatically from accepted offer', null, date, user.id, user.full_name);
  await db.logAudit(user.id, user.full_name, 'auto_create', 'joining', id, { from_offer: offer.id, expected_date: date, estimated });
  notes.push(`Joining record created for ${date}${estimated ? ' (date estimated from notice period — please confirm)' : ''}`);
}

// Called after every create/update of interviews, offers and joining. Never throws: automation is a
// convenience and must not be able to make a normal save fail.
async function afterWrite(table, { id, values, existing }, user) {
  const notes = [];
  if (!db) return notes;
  try {
    const changed = (k) => values[k] !== undefined && (!existing || existing[k] !== values[k]);
    if (table === 'applications' && existing && changed('status')) {
      const row = await db.dbGet('SELECT * FROM applications WHERE id = ?', [id]);
      if (row && ['Rejected', 'Withdrawn'].includes(row.status)) await closeDownstream(row, notes, user);
      if (row) { const mail = await statusEmails.notify(db, { application: row, from: existing.status, to: row.status, user }); if (mail) notes.push(mail); }
    }
    if (table === 'interviews') {
      const row = await db.dbGet('SELECT * FROM interviews WHERE id = ?', [id]);
      if (row && !['Cancelled', 'No Show'].includes(row.status)) await advance(row, 'Interview', 'interview scheduled', notes, user);
    }
    if (table === 'offers' && changed('status')) {
      const row = await db.dbGet('SELECT * FROM offers WHERE id = ?', [id]);
      if (row && ['Pending Approval', 'Sent', 'Negotiation', 'Approved', 'Accepted'].includes(row.status)) await advance(row, 'Offered', `offer ${row.status.toLowerCase()}`, notes, user);
      if (row && row.status === 'Accepted') await ensureJoining(row, notes, user);
      if (row && row.status === 'Declined') await withdraw(row, 'Offer declined', notes, user);
    }
    if (table === 'joining' && changed('status')) {
      const row = await db.dbGet('SELECT * FROM joining WHERE id = ?', [id]);
      if (row && row.status === 'Joined') {
        if (!row.actual_date) await db.dbRun("UPDATE joining SET actual_date = date('now') WHERE id = ?", [id]);
        await advance(row, 'Joined', 'candidate joined', notes, user);
        if (row.candidate_id) {
          await db.dbRun("UPDATE candidates SET status = 'Placed', updated_at = datetime('now') WHERE id = ? AND status != 'Placed'", [row.candidate_id]);
          notes.push('Candidate marked Placed');
        }
      }
      if (row && row.status === 'Dropped') await withdraw(row, 'Dropped before joining', notes, user);
    }
    if (table === 'joining' && (changed('status') || changed('actual_date'))) {
      const j = await db.dbGet('SELECT * FROM joining WHERE id = ?', [id]);
      if (j && j.status === 'Joined' && j.actual_date) {
        const out = await require('./onboarding').maybeAutoPush(db, j.candidate_id, user, j.vacancy_id);
        if (out.sent) notes.push('Details and documents sent to the HRMS');
        else if (out.error) notes.push(`HRMS hand-over failed: ${out.error}`);
        else if (out.waiting) notes.push(`HRMS: ${out.waiting}`);
      }
    }
  } catch (err) {
    console.warn(`⚠️  Automatic stage update skipped (${table} ${id}):`, err.message);
  }
  return notes;
}

module.exports = { init, afterWrite, ORDER };
