// Builds and sends the weekly RDC's Recruitment Management System email: vacancies in progress
// plus a table of upcoming joinings. Sent
// automatically every Monday morning (if the server happens to be running
// then), with a startup catch-up check and a manual "Send Now" endpoint to
// cover the times it isn't.
const { sendMail } = require('./mailer');
const { loadPipeline } = require('./pipeline');

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / (1000 * 60 * 60 * 24));
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function buildTrackerHtml({ dbAll }) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  // Table 1: everything still in progress (not Closed / Closed Internally / Cancelled).
  const vacancies = await dbAll(`
    SELECT v.title, v.company, v.location, v.priority, v.received_from, v.status,
           v.positions_required, v.positions_filled, u.full_name AS recruiter
    FROM vacancies v
    LEFT JOIN users u ON u.id = v.assigned_recruiter_id
    WHERE v.is_deleted = 0 AND v.status NOT IN ('Closed', 'Closed Internally', 'Cancelled')
    ORDER BY v.company, v.created_at ASC
  `);

  // Table 2: upcoming joinings (not yet joined / dropped / deferred, DOJ today or later).
  const joinings = await dbAll(`
    SELECT c.full_name, c.mobile, v.title AS designation,
           COALESCE(NULLIF(j.joining_location, ''), v.location) AS location,
           v.job_type AS employment_type,
           j.expected_date, j.status
    FROM joining j
    LEFT JOIN candidates c ON c.id = j.candidate_id
    LEFT JOIN vacancies v ON v.id = j.vacancy_id
    WHERE j.is_deleted = 0 AND j.status IN ('Expected', 'Confirmed')
      AND (j.expected_date IS NULL OR j.expected_date = '' OR j.expected_date >= ?)
    ORDER BY CASE WHEN j.expected_date IS NULL OR j.expected_date = '' THEN 1 ELSE 0 END, j.expected_date ASC
  `, [todayStr]);

  const pipeline = await loadPipeline(dbAll);

  const rowStyle = 'padding:8px 10px; border:1px solid #D9D6CB; font-size:13px;';
  const headStyle = 'padding:8px 10px; text-align:left; font-size:12px; color:#1E2422; background:#F1EFE7; border:1px solid #D9D6CB;';
  const emptyRow = (cols, msg) => `<tr><td colspan="${cols}" style="${rowStyle} text-align:center; color:#6E7169;">${msg}</td></tr>`;
  const fmtDate = (d) => {
    if (!d) return '—';
    const dt = new Date(d);
    return isNaN(dt) ? escapeHtml(d) : dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  const vacancyRows = vacancies.length ? vacancies.map((v) => `
    <tr>
      <td style="${rowStyle}">${escapeHtml(v.title)}</td>
      <td style="${rowStyle}">${escapeHtml(v.company || '—')}</td>
      <td style="${rowStyle}">${escapeHtml(v.location || '—')}</td>
      <td style="${rowStyle}">${escapeHtml(v.priority || '—')}</td>
      <td style="${rowStyle}">${escapeHtml(v.received_from || '—')}</td>
      <td style="${rowStyle}">${escapeHtml(v.recruiter || '—')}</td>
      <td style="${rowStyle}">${escapeHtml(v.status || '—')}</td>
      <td style="${rowStyle} text-align:center;">${Math.max((v.positions_required || 0) - (v.positions_filled || 0), 0)}</td>
    </tr>`).join('') : emptyRow(8, 'No vacancies in progress right now.');

  const joiningRows = joinings.length ? joinings.map((j) => `
    <tr>
      <td style="${rowStyle}">${escapeHtml(j.full_name || '—')}</td>
      <td style="${rowStyle}">${escapeHtml(j.designation || '—')}</td>
      <td style="${rowStyle}">${escapeHtml(j.location || '—')}</td>
      <td style="${rowStyle}">${escapeHtml(j.employment_type || '—')}</td>
      <td style="${rowStyle}">${fmtDate(j.expected_date)}</td>
      <td style="${rowStyle}">${escapeHtml(j.mobile || '—')}</td>
    </tr>`).join('') : emptyRow(6, 'No upcoming joinings.');

  const shown = pipeline.slice(0, 300);
  const pipelineRows = shown.length ? shown.map((p) => `
    <tr>
      <td style="${rowStyle}">${escapeHtml(p.candidate || '—')}</td>
      <td style="${rowStyle}">${escapeHtml(p.vacancy || '—')}</td>
      <td style="${rowStyle}">${escapeHtml(p.recruiter || '—')}</td>
      <td style="${rowStyle}">${escapeHtml(p.status)}</td>
      <td style="${rowStyle}"><strong>${escapeHtml(p.pending_who)}</strong><br><span style="color:#6E7169;">${escapeHtml(p.pending_what)}</span></td>
      <td style="${rowStyle} text-align:center;">${p.days_in_stage}</td>
    </tr>`).join('') : emptyRow(6, 'No candidates in the pipeline right now.');

  return `
  <div style="font-family:Arial,sans-serif; max-width:820px; margin:0 auto;">
    <div style="border-left:4px solid #B0502C; padding-left:12px; margin-bottom:20px;">
      <h2 style="margin:0; color:#1E2422;">Weekly Recruitment Tracker</h2>
      <div style="color:#6E7169; font-size:13px;">${today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
    </div>

    <h3 style="color:#1E2422; font-size:15px;">Vacancies in Progress (${vacancies.length})</h3>
    <table style="width:100%; border-collapse:collapse; margin-bottom:28px;">
      <tr>
        <th style="${headStyle}">Vacancy</th><th style="${headStyle}">Company</th><th style="${headStyle}">Location</th>
        <th style="${headStyle}">Priority</th><th style="${headStyle}">Raised By</th><th style="${headStyle}">Recruiter</th><th style="${headStyle}">Status</th>
        <th style="${headStyle}">Count</th>
      </tr>
      ${vacancyRows}
    </table>

    <h3 style="color:#1E2422; font-size:15px;">Candidates in Pipeline (${pipeline.length})</h3>
    <table style="width:100%; border-collapse:collapse; margin-bottom:28px;">
      <tr>
        <th style="${headStyle}">Candidate</th><th style="${headStyle}">Vacancy</th><th style="${headStyle}">Recruiter</th>
        <th style="${headStyle}">Stage</th><th style="${headStyle}">Pending with</th><th style="${headStyle}">Days</th>
      </tr>
      ${pipelineRows}
    </table>
    ${pipeline.length > shown.length ? `<p style="color:#6E7169; font-size:12px; margin-top:-18px;">Showing the first ${shown.length} of ${pipeline.length}.</p>` : ''}

    <h3 style="color:#1E2422; font-size:15px;">Upcoming Joinings (${joinings.length})</h3>
    <table style="width:100%; border-collapse:collapse;">
      <tr>
        <th style="${headStyle}">Name</th><th style="${headStyle}">Designation</th><th style="${headStyle}">Location</th><th style="${headStyle}">Type of Employment</th>
        <th style="${headStyle}">Tentative DOJ</th><th style="${headStyle}">Contact No.</th>
      </tr>
      ${joiningRows}
    </table>

    <p style="color:#9A9C92; font-size:11px; margin-top:28px;">Count = positions still to be filled. Days = time since the candidate's last update. Sent automatically by RDC's Recruitment Management System.</p>
  </div>`;
}

async function sendWeeklyTracker({ dbAll, dbGet, dbRun }) {
  const recipientsRow = await dbGet("SELECT value FROM settings WHERE key = 'email_recipients'");
  let recipients = [];
  try { recipients = JSON.parse(recipientsRow?.value || '[]'); } catch { /* leave empty */ }
  if (!recipients.length) {
    throw new Error('No recipients set — add at least one email address to "email_recipients" in Settings first.');
  }
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error('Email isn\'t configured on this server yet — SMTP_USER / SMTP_PASS are missing from .env.');
  }

  const html = await buildTrackerHtml({ dbAll });
  await sendMail({
    to: recipients.join(', '),
    subject: `Weekly Recruitment Tracker — ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`,
    html
  });

  await dbRun(`UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = 'weekly_tracker_last_sent'`, [new Date().toISOString().slice(0, 10)]);
  return { recipients };
}

// Called on server startup and hourly: sends once per Monday, even if the
// server wasn't running at exactly 9am — but never more than once per day.
async function maybeSendWeeklyTracker({ dbAll, dbGet, dbRun }) {
  const isMonday = new Date().getDay() === 1;
  if (!isMonday) return;
  const today = new Date().toISOString().slice(0, 10);
  const lastSentRow = await dbGet("SELECT value FROM settings WHERE key = 'weekly_tracker_last_sent'");
  if (lastSentRow?.value === today) return; // already sent today
  try {
    await sendWeeklyTracker({ dbAll, dbGet, dbRun });
    console.log('✅ Weekly position tracker email sent.');
  } catch (err) {
    console.warn('⚠️  Weekly tracker email not sent:', err.message);
  }
}

module.exports = { buildTrackerHtml, sendWeeklyTracker, maybeSendWeeklyTracker };
