// Automatic follow-up reminders for the stages that usually stall:
//   interviews  -> feedback / scorecard not in yet (interviewer is nudged, recruiter gets a task)
//   assessments -> not sent yet (recruiter task) or sent but not completed (candidate nudged)
//   offers      -> no response to the offer, or the validity date is close / lapsed
//   joining     -> upcoming joining (candidate prep emails) or the date passed with no outcome recorded
//
// Each run is safe to repeat: every email is remembered in `reminder_log` so it is only ever sent once,
// follow-up tasks are keyed (`followups.auto_key`) so they are created once, and a task closes itself when
// the thing it was waiting for has happened. Tasks show up on the Follow-ups page; each recruiter also
// gets one short digest email per day.
const crypto = require('crypto');
const { sendMail } = require('./mailer');
const scorecardLink = require('./scorecardLink');

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function diffDays(a, b) { // b - a, whole days, both YYYY-MM-DD
  const pa = String(a).slice(0, 10).split('-').map(Number);
  const pb = String(b).slice(0, 10).split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (d) => { const dt = new Date(d); return isNaN(dt) ? String(d || '') : dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }); };
const baseUrl = () => (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const isOff = (v) => ['false', '0', 'no', 'off'].includes(String(v ?? '').trim().toLowerCase());
const emailConfigured = () => !!(process.env.SMTP_USER && process.env.SMTP_PASS);

// Reminders never go out in the middle of the night; the hourly check simply waits for the morning.
const SEND_FROM_HOUR = 8;
const SEND_UNTIL_HOUR = 19;

function shell(heading, body, recruiter) {
  const contact = recruiter && (recruiter.email || recruiter.full_name)
    ? `<p style="font-size:13px; color:#5C6A66;">Questions? Write to ${esc(recruiter.full_name || 'your recruiter')}${recruiter.email ? ` at <a href="mailto:${esc(recruiter.email)}">${esc(recruiter.email)}</a>` : ''}.</p>` : '';
  return `<div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto; font-size:14px; color:#23271F; line-height:1.6;">
    <div style="border-left:4px solid #FFC72C; padding-left:12px; margin-bottom:18px;"><h2 style="margin:0; font-size:18px; color:#16221F;">${esc(heading)}</h2></div>
    ${body}${contact}
    <p style="color:#9A9C92; font-size:11px; margin-top:26px;">Sent automatically by RDC's Recruitment Management System.</p></div>`;
}

async function loadSettings({ dbAll }) {
  const rows = await dbAll("SELECT key, value FROM settings WHERE key IN ('reminders_enabled','reminders_candidate_emails','onboarding_form_link')");
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { enabled: !isOff(m.reminders_enabled), candidateEmails: !isOff(m.reminders_candidate_emails), onboardingLink: m.onboarding_form_link || '' };
}

// Works out everything that is due today. Nothing is sent or saved here.
async function collect(db, today, settings) {
  const { dbAll } = db;
  const emails = []; // { key, kind: 'candidate'|'interviewer', to, subject, html, who }
  const tasks = [];  // { key, candidate_id, name, note, assigned_to }

  const users = Object.fromEntries((await dbAll('SELECT id, full_name, email FROM users')).map((u) => [u.id, u]));
  const clients = Object.fromEntries((await dbAll('SELECT company_name, onboarding_form_link FROM clients')).map((c) => [c.company_name, c]));
  const onboardingFor = (company) => ((clients[company] && clients[company].onboarding_form_link) || '').trim() || settings.onboardingLink || '';
  const recruiterOf = (rid) => (rid ? users[rid] : null) || null;
  const role = (r) => `${r.vtitle || 'the role'}${r.vcompany ? ' at ' + r.vcompany : ''}`;

  /* ---------- Interviews: feedback still missing ---------- */
  const interviews = await dbAll(`
    SELECT i.id, i.round, i.interviewer, i.interviewer_email, i.scheduled_date, i.status, i.rating, i.scorecard, i.candidate_id,
           c.full_name AS cname, v.title AS vtitle, v.company AS vcompany, v.assigned_recruiter_id AS rid
    FROM interviews i LEFT JOIN candidates c ON c.id = i.candidate_id LEFT JOIN vacancies v ON v.id = i.vacancy_id
    WHERE i.is_deleted = 0 AND i.status IN ('Scheduled','Confirmed','Completed','Rescheduled')
      AND i.scheduled_date IS NOT NULL AND i.scheduled_date != '' AND i.scheduled_date < ?`, [today]);
  for (const i of interviews) {
    let hasScores = false;
    try { const sc = typeof i.scorecard === 'string' ? JSON.parse(i.scorecard || 'null') : i.scorecard; hasScores = !!(sc && sc.scores && Object.keys(sc.scores).length); } catch { /* ignore */ }
    if ((i.rating !== null && i.rating !== '' && i.rating !== undefined) || hasScores) continue;
    const days = diffDays(i.scheduled_date, today);
    tasks.push({
      key: `fb:${i.id}`, candidate_id: i.candidate_id, name: i.cname, assigned_to: i.rid,
      note: `Interview feedback pending — ${i.cname || 'candidate'}, round ${i.round || 1} with ${i.interviewer || 'the interviewer'} (${days} day${days === 1 ? '' : 's'} ago)${i.status === 'Scheduled' ? '. Also mark the interview outcome.' : ''}`
    });
    if (i.interviewer_email && days <= 14 && (days >= 1)) {
      const stage = days >= 3 ? 2 : 1;
      emails.push({
        key: `fbmail${stage}:${i.id}`, kind: 'interviewer', to: i.interviewer_email, who: i.interviewer || i.interviewer_email,
        subject: `${stage === 2 ? 'Reminder: ' : ''}Please submit your interview scorecard — ${i.cname || 'candidate'}`,
        needsLink: i.id, headingText: 'Interview scorecard pending',
        intro: `<p>Dear ${esc(i.interviewer || 'Interviewer')},</p><p>${stage === 2 ? 'A gentle reminder: we' : 'We'} haven't received your scorecard for <strong>${esc(i.cname || 'the candidate')}</strong> (round ${esc(i.round || 1)}, ${esc(role(i))}), interviewed on ${esc(fmt(i.scheduled_date))}. It takes about two minutes and needs no login.</p>`,
        recruiter: recruiterOf(i.rid)
      });
    }
  }

  /* ---------- Assessments ---------- */
  const assessments = await dbAll(`
    SELECT a.id, a.assessment_type, a.status, a.created_at, a.candidate_id,
           c.full_name AS cname, c.email AS cemail, v.title AS vtitle, v.company AS vcompany, v.assigned_recruiter_id AS rid
    FROM assessments a LEFT JOIN candidates c ON c.id = a.candidate_id LEFT JOIN vacancies v ON v.id = a.vacancy_id
    WHERE a.is_deleted = 0 AND a.status IN ('Pending','Sent')`);
  for (const a of assessments) {
    const age = diffDays(String(a.created_at).slice(0, 10), today);
    if (a.status === 'Pending' && age >= 1) {
      tasks.push({ key: `asm-send:${a.id}`, candidate_id: a.candidate_id, name: a.cname, assigned_to: a.rid, note: `Send the ${a.assessment_type} assessment to ${a.cname || 'candidate'} — still marked Pending after ${age} day${age === 1 ? '' : 's'}.` });
    }
    if (a.status === 'Sent' && age >= 2) {
      tasks.push({ key: `asm-chase:${a.id}`, candidate_id: a.candidate_id, name: a.cname, assigned_to: a.rid, note: `${a.assessment_type} assessment sent ${age} days ago and not completed — chase ${a.cname || 'the candidate'} and record the result.` });
      if (a.cemail && age <= 21) {
        const stage = age >= 5 ? 2 : 1;
        emails.push({
          key: `asmmail${stage}:${a.id}`, kind: 'candidate', to: a.cemail, who: a.cname,
          subject: `Reminder: please complete your ${a.assessment_type} assessment${a.vcompany ? ' — ' + a.vcompany : ''}`,
          headingText: 'Assessment reminder',
          body: `<p>Dear ${esc(a.cname || 'Candidate')},</p><p>This is a gentle reminder to complete the <strong>${esc(a.assessment_type)}</strong> assessment we sent you for ${esc(role(a))}. Completing it helps us move your application forward.</p><p>If you have already completed it, please ignore this message.</p>`,
          recruiter: recruiterOf(a.rid)
        });
      }
    }
  }

  /* ---------- Offers waiting for a response ---------- */
  const offers = await dbAll(`
    SELECT o.id, o.status, o.valid_till, o.candidate_id, COALESCE(NULLIF(o.offer_date,''), substr(o.created_at,1,10)) AS base,
           c.full_name AS cname, c.email AS cemail, v.title AS vtitle, v.company AS vcompany, v.assigned_recruiter_id AS rid
    FROM offers o LEFT JOIN candidates c ON c.id = o.candidate_id LEFT JOIN vacancies v ON v.id = o.vacancy_id
    WHERE o.is_deleted = 0 AND o.status IN ('Sent','Approved','Negotiation')`);
  // Offers waiting for the Authorized Signatory
  const awaiting = await dbAll(`
    SELECT o.id, o.candidate_id, o.approval_requested_to AS sig, substr(o.approval_requested_at,1,10) AS asked, c.full_name AS cname, v.assigned_recruiter_id AS rid
    FROM offers o LEFT JOIN candidates c ON c.id = o.candidate_id LEFT JOIN vacancies v ON v.id = o.vacancy_id
    WHERE o.is_deleted = 0 AND o.status = 'Pending Approval' AND o.approval_requested_at IS NOT NULL`);
  for (const o of awaiting) {
    const waited = diffDays(o.asked, today);
    if (waited >= 1) tasks.push({ key: `offer-approval:${o.id}`, candidate_id: o.candidate_id, name: o.cname, assigned_to: o.rid, note: `Offer for ${o.cname || 'candidate'} has been waiting ${waited} day${waited === 1 ? '' : 's'} for ${o.sig || 'the Authorized Signatory'} to approve — follow up, or open the offer and press Send for approval to send a fresh link.` });
  }
  for (const o of offers) {
    const age = diffDays(o.base, today);
    const left = o.valid_till ? diffDays(today, o.valid_till) : null;
    const rec = recruiterOf(o.rid);
    if (left !== null && left < 0) {
      tasks.push({ key: `offer-lapsed:${o.id}`, candidate_id: o.candidate_id, name: o.cname, assigned_to: o.rid, note: `Offer to ${o.cname || 'candidate'} lapsed on ${fmt(o.valid_till)} with no acceptance — extend the validity or withdraw the offer.` });
      continue;
    }
    if (left !== null && left <= 2) {
      tasks.push({ key: `offer-expiry:${o.id}`, candidate_id: o.candidate_id, name: o.cname, assigned_to: o.rid, note: `Offer to ${o.cname || 'candidate'} is valid till ${fmt(o.valid_till)} (${left === 0 ? 'today' : left + ' day' + (left === 1 ? '' : 's') + ' left'}) — still no acceptance.` });
      if (o.cemail) {
        emails.push({
          key: `offexp:${o.id}`, kind: 'candidate', to: o.cemail, who: o.cname,
          subject: `Your offer${o.vcompany ? ' from ' + o.vcompany : ''} is valid till ${fmt(o.valid_till)}`, headingText: 'Offer validity',
          body: `<p>Dear ${esc(o.cname || 'Candidate')},</p><p>Your offer for ${esc(role(o))} is valid till <strong>${esc(fmt(o.valid_till))}</strong>. Kindly confirm your acceptance before then so we can proceed with your joining formalities.</p>`,
          recruiter: rec
        });
      }
    } else if (age >= 3) {
      tasks.push({ key: `offer-chase:${o.id}`, candidate_id: o.candidate_id, name: o.cname, assigned_to: o.rid, note: `Follow up with ${o.cname || 'candidate'} — offer is ${age} days old and not yet accepted (status: ${o.status}).` });
      if (o.cemail && age <= 30) {
        const stage = age >= 6 ? 2 : 1;
        emails.push({
          key: `offmail${stage}:${o.id}`, kind: 'candidate', to: o.cemail, who: o.cname,
          subject: `${stage === 2 ? 'Reminder: ' : ''}Your offer${o.vcompany ? ' from ' + o.vcompany : ''} — please confirm`, headingText: 'Offer — awaiting your confirmation',
          body: `<p>Dear ${esc(o.cname || 'Candidate')},</p><p>We shared an offer with you for ${esc(role(o))}. ${stage === 2 ? 'We are yet to hear from you. ' : ''}Kindly confirm your acceptance, or let us know if you would like to discuss anything.</p>`,
          recruiter: rec
        });
      }
    }
  }

  /* ---------- Joining ---------- */
  const joinings = await dbAll(`
    SELECT j.id, j.expected_date, j.status, j.joining_location, j.reporting_manager, j.documents_pending, j.candidate_id,
           c.full_name AS cname, c.email AS cemail, v.title AS vtitle, v.company AS vcompany, v.location AS vloc, v.assigned_recruiter_id AS rid
    FROM joining j LEFT JOIN candidates c ON c.id = j.candidate_id LEFT JOIN vacancies v ON v.id = j.vacancy_id
    WHERE j.is_deleted = 0 AND j.status IN ('Expected','Confirmed') AND j.expected_date IS NOT NULL AND j.expected_date != ''`);
  for (const j of joinings) {
    const d = diffDays(today, j.expected_date);
    const where = j.joining_location || j.vloc || '';
    if (d < 0) {
      tasks.push({ key: `join-overdue:${j.id}`, candidate_id: j.candidate_id, name: j.cname, assigned_to: j.rid, note: `${j.cname || 'Candidate'}'s joining date (${fmt(j.expected_date)}) has passed — mark them Joined, Deferred or Dropped.` });
      continue;
    }
    if (d > 3) continue;
    tasks.push({ key: `join-prep:${j.id}`, candidate_id: j.candidate_id, name: j.cname, assigned_to: j.rid, note: `${j.cname || 'Candidate'} joins ${d === 0 ? 'today' : d === 1 ? 'tomorrow' : 'in ' + d + ' days'} (${fmt(j.expected_date)})${j.documents_pending ? ' — documents pending: ' + j.documents_pending : ' — confirm documents and the onboarding form are ready'}.` });
    if (!j.cemail) continue;
    const link = onboardingFor(j.vcompany);
    const rec = recruiterOf(j.rid);
    if (d === 1 || d === 0) {
      emails.push({
        key: `joinfinal:${j.id}`, kind: 'candidate', to: j.cemail, who: j.cname,
        subject: `${d === 0 ? 'Welcome — your first day at' : 'See you tomorrow at'} ${j.vcompany || 'RDC'}`, headingText: d === 0 ? 'Your first day' : 'See you tomorrow',
        body: `<p>Dear ${esc(j.cname || 'Candidate')},</p><p>We look forward to welcoming you ${d === 0 ? 'today' : 'tomorrow, <strong>' + esc(fmt(j.expected_date)) + '</strong>'} as <strong>${esc(j.vtitle || 'a team member')}</strong>${where ? ' at ' + esc(where) : ''}.${j.reporting_manager ? ` Please report to <strong>${esc(j.reporting_manager)}</strong>.` : ''}</p>${j.documents_pending ? `<p>Documents we still need from you: <strong>${esc(j.documents_pending)}</strong>.</p>` : '<p>Please carry the original documents listed in your appointment email.</p>'}${link ? `<p>If you haven't yet, please fill the onboarding form: <a href="${esc(link)}">${esc(link)}</a></p>` : ''}`,
        recruiter: rec
      });
    } else {
      emails.push({
        key: `joinearly:${j.id}`, kind: 'candidate', to: j.cemail, who: j.cname,
        subject: `Your joining on ${fmt(j.expected_date)}${j.vcompany ? ' — ' + j.vcompany : ''}`, headingText: 'Joining coming up',
        body: `<p>Dear ${esc(j.cname || 'Candidate')},</p><p>Your joining as <strong>${esc(j.vtitle || 'a team member')}</strong> is on <strong>${esc(fmt(j.expected_date))}</strong>${where ? ' at ' + esc(where) : ''}. A few things to get ready:</p><ul><li>Original documents and photocopies as listed in your appointment email</li><li>The onboarding form, filled in before your first day${link ? `: <a href="${esc(link)}">open the form</a>` : ''}</li></ul>${j.documents_pending ? `<p>Documents we still need from you: <strong>${esc(j.documents_pending)}</strong>.</p>` : ''}<p>Please reply if your joining date needs to change.</p>`,
        recruiter: rec
      });
    }
  }

  /* ---------- Decisions waiting after interviews ---------- */
  const decisions = await dbAll(`
    SELECT i.id, i.round, i.recommendation, i.candidate_id, i.vacancy_id,
           c.full_name AS cname, v.title AS vtitle, v.assigned_recruiter_id AS rid
    FROM interviews i
    JOIN applications a ON a.candidate_id = i.candidate_id AND a.vacancy_id = i.vacancy_id AND a.is_deleted = 0 AND a.status = 'Interview'
    LEFT JOIN candidates c ON c.id = i.candidate_id LEFT JOIN vacancies v ON v.id = i.vacancy_id
    WHERE i.is_deleted = 0 AND i.recommendation IN ('Proceed','Reject','Hold')
      AND NOT EXISTS (SELECT 1 FROM offers o WHERE o.candidate_id = i.candidate_id AND o.vacancy_id = i.vacancy_id AND o.is_deleted = 0)
      AND NOT EXISTS (SELECT 1 FROM interviews i2 WHERE i2.candidate_id = i.candidate_id AND i2.vacancy_id = i.vacancy_id AND i2.is_deleted = 0
                      AND i2.status NOT IN ('Cancelled','No Show') AND COALESCE(i2.round, 1) > COALESCE(i.round, 1))`);
  const latest = new Map();
  for (const d of decisions) { const k = `${d.candidate_id}:${d.vacancy_id}`; if (!latest.has(k) || (latest.get(k).round || 1) < (d.round || 1)) latest.set(k, d); }
  for (const d of latest.values()) {
    const what = d.recommendation === 'Proceed' ? 'recommends proceeding — schedule the next round or make an offer'
      : d.recommendation === 'Reject' ? 'recommends rejecting — send the rejection (Next step ▾ → Send email) or override' : 'is on Hold — decide whether to proceed or reject';
    tasks.push({ key: `decision:${d.candidate_id}:${d.vacancy_id}`, candidate_id: d.candidate_id, name: d.cname, assigned_to: d.rid, note: `Decision needed for ${d.cname || 'candidate'} (${d.vtitle || 'role'}): the round ${d.round || 1} scorecard ${what}.` });
  }

  /* ---------- Closed vacancies that still have open applicants ---------- */
  const closedOpen = await dbAll(`
    SELECT v.id, v.title, v.vacancy_code, v.assigned_recruiter_id AS rid, COUNT(a.id) AS n
    FROM vacancies v JOIN applications a ON a.vacancy_id = v.id AND a.is_deleted = 0 AND a.status NOT IN ('Joined','Rejected','Withdrawn')
    WHERE v.is_deleted = 0 AND v.status IN ('Closed','Closed Internally','Cancelled') AND COALESCE(v.closed_at, v.updated_at) >= date('now','-90 day')
    GROUP BY v.id`);
  for (const v of closedOpen) {
    tasks.push({ key: `closed-open:${v.id}`, entity_type: 'vacancy', entity_id: v.id, name: `${v.vacancy_code || ''} ${v.title || ''}`.trim(), assigned_to: v.rid,
      note: `${v.title || 'Vacancy'} is closed but ${v.n} applicant${v.n === 1 ? ' is' : 's are'} still open — open the vacancy and use "Close out remaining applicants" to reject them with a courteous email, or move them to another vacancy.` });
  }

  /* ---------- Someone joined but has other open applications ---------- */
  const placed = await dbAll(`
    SELECT c.id, c.full_name, COUNT(a.id) AS n, MIN(v.assigned_recruiter_id) AS rid
    FROM candidates c
    JOIN joining j ON j.candidate_id = c.id AND j.is_deleted = 0 AND j.status = 'Joined'
    JOIN applications a ON a.candidate_id = c.id AND a.is_deleted = 0 AND a.status NOT IN ('Joined','Rejected','Withdrawn')
    LEFT JOIN vacancies v ON v.id = a.vacancy_id
    WHERE c.is_deleted = 0 GROUP BY c.id`);
  for (const p of placed) {
    tasks.push({ key: `placed-others:${p.id}`, candidate_id: p.id, name: p.full_name, assigned_to: p.rid,
      note: `${p.full_name} has joined but still has ${p.n} other open application${p.n === 1 ? '' : 's'} — withdraw ${p.n === 1 ? 'it' : 'them'} so they stop showing in pipelines.` });
  }
  return { emails, tasks, users };
}

async function buildEmailHtml(db, e) {
  if (e.kind === 'interviewer') {
    let linkHtml = '';
    try {
      const link = await scorecardLink.ensureLink(db, e.needsLink);
      const url = scorecardLink.buildUrl(baseUrl(), link.token);
      linkHtml = `<p style="margin:18px 0;"><a href="${esc(url)}" style="background:#1E3A52; color:#fff; padding:10px 18px; border-radius:8px; text-decoration:none; font-weight:bold;">Fill in the scorecard</a></p><p style="font-size:12px; color:#5C6A66;">The link is meant only for you — please don't forward it.</p>`;
    } catch { /* link unavailable: the email still asks for feedback */ }
    return shell(e.headingText, e.intro + linkHtml, e.recruiter);
  }
  return shell(e.headingText, e.body, e.recruiter);
}

function digestHtml(user, items) {
  const rows = items.map((t) => `<tr><td style="padding:7px 10px; border:1px solid #D9D6CB; font-size:13px;">${esc(t.note)}</td></tr>`).join('');
  return shell(`${items.length} follow-up${items.length === 1 ? '' : 's'} need your attention`,
    `<p>Good morning ${esc((user.full_name || '').split(' ')[0] || '')},</p><p>These items are waiting on you. They also appear under <strong>Follow-ups</strong> in the tracker and tick themselves off once the work is done.</p>
     <table style="width:100%; border-collapse:collapse; margin:12px 0;">${rows}</table>
     <p><a href="${esc(baseUrl())}">Open the tracker</a></p>`);
}

// dry = only report what would happen. force = ignore the daytime-only sending window (manual "Run now").
async function run(db, { dry = false, force = false, today = null, now = new Date(), tasksOnly = false } = {}) {
  const { dbAll, dbGet, dbRun } = db;
  const settings = await loadSettings(db);
  const out = { dry, enabled: settings.enabled, emailConfigured: emailConfigured(), tasksCreated: [], tasksResolved: 0, tasksOpen: 0, emails: [], failed: [], note: '' };
  if (!settings.enabled) { out.note = 'Automatic reminders are switched off in Settings.'; return out; }
  const day = today || ymd(now);
  const hour = now.getHours();
  const inWindow = force || (hour >= SEND_FROM_HOUR && hour < SEND_UNTIL_HOUR);

  const plan = await collect(db, day, settings);

  /* ---- tasks (Follow-ups page) ---- */
  const existing = await dbAll('SELECT id, auto_key, completed, note FROM followups WHERE auto_key IS NOT NULL AND is_deleted = 0');
  const byKey = new Map(existing.map((r) => [r.auto_key, r]));
  const active = new Set(plan.tasks.map((t) => t.key));
  for (const t of plan.tasks) {
    const ex = byKey.get(t.key);
    if (!ex) {
      out.tasksCreated.push(t.note);
      if (!dry) {
        await dbRun(`INSERT INTO followups (id, entity_type, entity_id, entity_name, note, due_date, assigned_to, completed, auto_key)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`, [crypto.randomUUID(), t.entity_type || 'candidate', t.entity_id || t.candidate_id, t.name || '', t.note, day, t.assigned_to || null, t.key]);
      }
    } else if (!ex.completed && ex.note !== t.note && !dry) {
      await dbRun("UPDATE followups SET note = ?, updated_at = datetime('now') WHERE id = ?", [t.note, ex.id]);
    }
  }
  for (const ex of existing) {
    if (!ex.completed && !active.has(ex.auto_key)) {
      out.tasksResolved += 1;
      if (!dry) await dbRun("UPDATE followups SET completed = 1, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [ex.id]);
    }
  }
  out.tasksOpen = plan.tasks.length;

  if (tasksOnly) return out;

  /* ---- emails ---- */
  const logged = new Set((await dbAll('SELECT key FROM reminder_log')).map((r) => r.key));
  const due = plan.emails.filter((e) => !logged.has(e.key) && (e.kind !== 'candidate' || settings.candidateEmails));
  // Keys look like "offmail2:<id>" (name + stage : entity). If several stages of the same reminder are due at once
  // (say the server was off for a few days) only the latest one goes out.
  const parse = (k) => { const m = /^([a-z]+)(\d)?:(.+)$/.exec(k); return { group: `${m[1]}:${m[3]}`, stage: Number(m[2] || 0) }; };
  const best = new Map();
  for (const e of due) {
    const { group, stage } = parse(e.key);
    if (!best.has(group) || parse(best.get(group).key).stage < stage) best.set(group, e);
  }
  const finalDue = [...best.values()];
  for (const e of finalDue) {
    const item = { to: e.to, subject: e.subject, kind: e.kind, who: e.who || '' };
    if (!inWindow) { out.note = 'Emails wait for the daytime sending window (8am–7pm).'; out.emails.push({ ...item, held: true }); continue; }
    if (dry) { out.emails.push(item); continue; }
    if (!emailConfigured()) { out.emails.push({ ...item, held: true }); out.note = 'Email isn\'t configured (SMTP_USER / SMTP_PASS missing in .env) — tasks were created, emails are on hold.'; continue; }
    try {
      await sendMail({ to: e.to, subject: e.subject, html: await buildEmailHtml(db, e) });
      await dbRun("INSERT OR IGNORE INTO reminder_log (key, kind, detail) VALUES (?, ?, ?)", [e.key, e.kind, `${e.subject} → ${e.to}`]);
      // sending a later stage also settles the earlier one, so it can't fire afterwards
      if (/2:/.test(e.key)) await dbRun("INSERT OR IGNORE INTO reminder_log (key, kind, detail) VALUES (?, ?, 'superseded')", [e.key.replace(/2:/, '1:'), e.kind]);
      out.emails.push(item);
    } catch (err) {
      out.failed.push({ ...item, error: err.message });
    }
  }

  /* ---- one digest per recruiter per day ---- */
  if (inWindow && !dry && emailConfigured()) {
    const open = await dbAll(`SELECT f.note, f.assigned_to, u.full_name, u.email FROM followups f JOIN users u ON u.id = f.assigned_to
                              WHERE f.auto_key IS NOT NULL AND f.completed = 0 AND f.is_deleted = 0 AND u.is_active = 1 AND u.email IS NOT NULL AND u.email != ''`);
    const byUser = new Map();
    for (const r of open) { if (!byUser.has(r.assigned_to)) byUser.set(r.assigned_to, { user: r, items: [] }); byUser.get(r.assigned_to).items.push(r); }
    for (const [uid, { user, items }] of byUser) {
      const key = `digest:${uid}:${day}`;
      if (logged.has(key)) continue;
      try {
        await sendMail({ to: user.email, subject: `${items.length} follow-up${items.length === 1 ? '' : 's'} need your attention — ${fmt(day)}`, html: digestHtml(user, items) });
        await dbRun("INSERT OR IGNORE INTO reminder_log (key, kind, detail) VALUES (?, 'digest', ?)", [key, `${items.length} items → ${user.email}`]);
        out.emails.push({ to: user.email, subject: 'Daily digest', kind: 'digest', who: user.full_name });
      } catch (err) { out.failed.push({ to: user.email, subject: 'Daily digest', kind: 'digest', error: err.message }); }
    }
  }
  return out;
}

module.exports = { run, collect, loadSettings };
