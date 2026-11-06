// Emails a recruiter when a vacancy is assigned to them (whether at creation
// or by changing "Assigned Recruiter" later) — once per assignment, so
// unrelated edits to the vacancy don't re-send it.
const { sendMail } = require('./mailer');

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function sendVacancyAssignedEmail({ dbGet }, vacancyId) {
  const vacancy = await dbGet('SELECT * FROM vacancies WHERE id = ?', [vacancyId]);
  if (!vacancy || !vacancy.assigned_recruiter_id) return;
  const recruiter = await dbGet('SELECT * FROM users WHERE id = ?', [vacancy.assigned_recruiter_id]);
  if (!recruiter?.email) return;

  const rowStyle = 'padding:6px 0; font-size:14px;';
  const labelStyle = 'padding:6px 12px 6px 0; font-size:13px; color:#6E7169; white-space:nowrap; vertical-align:top;';
  const rows = [
    ['Vacancy', vacancy.title],
    ['Company', vacancy.company],
    ['Location', vacancy.location],
    ['Priority', vacancy.priority],
    ['Positions required', vacancy.positions_required]
  ].filter(([, v]) => v);

  const html = `
  <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
    <div style="border-left:4px solid #B0502C; padding-left:12px; margin-bottom:20px;">
      <h2 style="margin:0; color:#1E2422;">Vacancy Assigned to You</h2>
    </div>
    <p style="font-size:14px; color:#23271F;">A vacancy has been assigned to you in RDC's Recruitment Management System.</p>
    <table style="margin-top:12px;">
      ${rows.map(([label, value]) => `<tr><td style="${labelStyle}">${escapeHtml(label)}</td><td style="${rowStyle}">${escapeHtml(value)}</td></tr>`).join('')}
    </table>
    <p style="color:#9A9C92; font-size:11px; margin-top:28px;">Sent automatically by RDC's Recruitment Management System.</p>
  </div>`;

  await sendMail({ to: recruiter.email, subject: `Vacancy Assigned: ${vacancy.title}`, html });
}

module.exports = { sendVacancyAssignedEmail };
