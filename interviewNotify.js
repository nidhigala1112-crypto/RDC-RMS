// Sends interview emails to the candidate, the interviewer, and the
// vacancy's assigned recruiter: an immediate confirmation when scheduled, a
// dedicated email the moment a Meet link is generated (since that usually
// happens as a separate step after the interview is first created), and a
// reminder the day before.
const { sendMail } = require('./mailer');
const scorecardLink = require('./scorecardLink');
const { buildInterviewIcs } = require('./ics');
const panel = require('./panel');

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildInterviewHtml({ interview, candidate, vacancy, heading, intro, scorecard }) {
  const rowStyle = 'padding:6px 0; font-size:14px;';
  const labelStyle = 'padding:6px 12px 6px 0; font-size:13px; color:#6E7169; white-space:nowrap; vertical-align:top;';
  const rows = [
    ['Candidate', candidate?.full_name],
    ['Position', vacancy?.title],
    ['Company', vacancy?.company],
    ['Date', interview.scheduled_date],
    ['Time', interview.scheduled_time],
    ['Round', interview.round],
    (interview.panel_names && interview.panel_names.length > 1) ? ['Interview panel', interview.panel_names.join(', ')] : ['Interviewer', interview.interviewer],
    ['Location', interview.location],
    ['Meeting link', interview.meeting_link ? `<a href="${escapeHtml(interview.meeting_link)}">${escapeHtml(interview.meeting_link)}</a>` : null]
  ].filter(([, v]) => v);

  return `
  <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
    <div style="border-left:4px solid #B0502C; padding-left:12px; margin-bottom:20px;">
      <h2 style="margin:0; color:#1E2422;">${escapeHtml(heading)}</h2>
    </div>
    <p style="font-size:14px; color:#23271F;">${escapeHtml(intro)}</p>
    <table style="margin-top:12px;">
      ${rows.map(([label, value]) => `<tr><td style="${labelStyle}">${escapeHtml(label)}</td><td style="${rowStyle}">${label === 'Meeting link' ? value : escapeHtml(value)}</td></tr>`).join('')}
    </table>
    ${scorecard ? `
    <div style="margin-top:22px; padding:14px 16px; background:#F3F5F4; border-radius:8px;">
      <div style="font-size:14px; font-weight:bold; color:#1E2422;">Your interview scorecard</div>
      <div style="font-size:13px; color:#5C6A66; margin:4px 0 12px;">After the interview, please rate the candidate here and say how they should be hired (On Roll, Off Roll, Fixed Term Contract or Retainer Contract). It takes about two minutes and needs no login.${scorecard.hasResume ? ' The candidate\'s resume is attached to this email.' : ''}</div>
      <a href="${escapeHtml(scorecard.url)}" style="background:#1E3A52; color:#ffffff; padding:10px 18px; border-radius:8px; text-decoration:none; font-weight:bold; font-size:14px;">Fill in the scorecard</a>
      <div style="font-size:11.5px; color:#8A948F; margin-top:10px;">Link works until ${escapeHtml(scorecard.expiry)} and is meant only for you — please don't forward it.</div>
    </div>` : ''}
    <p style="color:#9A9C92; font-size:11px; margin-top:28px;">Sent automatically by RDC's Recruitment Management System.</p>
  </div>`;
}

// Candidate + interviewer + the vacancy's assigned recruiter — deduplicated,
// since the recruiter and interviewer are sometimes the same person.
async function getRecipients({ dbGet }, interview, candidate, vacancy) {
  let recruiterEmail = null;
  if (vacancy?.assigned_recruiter_id) {
    const recruiter = await dbGet('SELECT email FROM users WHERE id = ?', [vacancy.assigned_recruiter_id]);
    recruiterEmail = recruiter?.email || null;
  }
  return [...new Set([candidate?.email, interview.interviewer_email, recruiterEmail].filter(Boolean))];
}


const baseUrl = () => (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

// One email for the candidate and recruiter, and a separate one for the interviewer that also carries
// their private scorecard link. The candidate must never see that link, so the two are never combined.
async function sendInviteEmails({ dbGet, dbRun }, ctx, { heading, intro, subject }, opts = {}) {
  const { interview, candidate, vacancy } = ctx;
  const all = await getRecipients({ dbGet }, interview, candidate, vacancy);
  if (!all.length) return false;
  const interviewerEmail = (interview.interviewer_email || '').trim();
  // a panel member's record only ever emails that member; the candidate and recruiter hear once, from the main record
  const isMember = !!interview.panel_id && interview.panel_id !== interview.id;
  const others = isMember ? [] : all.filter((e) => e.toLowerCase() !== interviewerEmail.toLowerCase());

  const method = opts.cancel ? 'CANCEL' : 'REQUEST';
  const calendarFor = (attendees) => {
    if (opts.noCalendar) return {};
    const content = buildInterviewIcs({ interview, candidate, vacancy, method, attendees, organizerEmail: process.env.SMTP_USER });
    return content ? { icalEvent: { method, content } } : {};
  };
  if (others.length) {
    // the candidate's calendar entry lists only the candidate; the interviewer's own copy is sent separately below
    await sendMail({ to: others.join(', '), subject, html: buildInterviewHtml({ interview, candidate, vacancy, heading, intro }), ...calendarFor(others.map((e) => ({ email: e, name: e === candidate?.email ? candidate.full_name : undefined }))) });
  }
  if (interviewerEmail) {
    let scorecard = null;
    try {
      const link = await scorecardLink.ensureLink({ dbGet, dbRun }, interview.id);
      scorecard = {
        url: scorecardLink.buildUrl(baseUrl(), link.token),
        expiry: new Date(link.expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
      };
    } catch (err) {
      console.warn(`⚠️  Scorecard link not added to interviewer email for ${interview.id}:`, err.message);
    }
    let attachments = [];
    if (!opts.cancel) { try { attachments = await scorecardLink.resumeAttachment({ dbGet }, interview.candidate_id); } catch { /* resume is a bonus — never block the invite */ } }
    await sendMail({ to: interviewerEmail, subject, attachments, html: buildInterviewHtml({ interview, candidate, vacancy, heading, intro, scorecard: opts.cancel || !scorecard ? null : { ...scorecard, hasResume: attachments.length > 0 } }), ...calendarFor([{ email: interviewerEmail, name: interview.interviewer }]) });
  }
  return true;
}

async function loadContext({ dbGet }, interviewId) {
  const interview = await dbGet('SELECT * FROM interviews WHERE id = ?', [interviewId]);
  if (!interview) return null;
  if (interview.panel_id) interview.panel_names = await panel.names({ dbAll: require('./database').dbAll }, interview);
  const [candidate, vacancy] = await Promise.all([
    dbGet('SELECT * FROM candidates WHERE id = ?', [interview.candidate_id]),
    dbGet('SELECT * FROM vacancies WHERE id = ?', [interview.vacancy_id])
  ]);
  return { interview, candidate, vacancy };
}

async function sendInterviewConfirmation({ dbGet, dbRun }, interviewId, opts = {}) {
  const ctx = await loadContext({ dbGet }, interviewId);
  if (!ctx) return;
  const { interview, candidate, vacancy } = ctx;
  const rescheduled = !!opts.rescheduled;
  const sent = await sendInviteEmails({ dbGet, dbRun }, ctx, {
    heading: rescheduled ? 'Interview Rescheduled' : 'Interview Scheduled',
    intro: rescheduled
      ? `This interview has been rescheduled. Updated details below.`
      : `An interview has been scheduled${vacancy ? ` for ${vacancy.title}` : ''}. Details below.${!interview.meeting_link && interview.type === 'Video' ? ' A meeting link will follow separately once it\'s generated.' : ''}`,
    subject: `${rescheduled ? 'Interview Rescheduled' : 'Interview Scheduled'} — ${candidate?.full_name || 'Candidate'}`
  });
  if (!sent) return; // nothing we can do without at least one email address
  await dbRun('UPDATE interviews SET confirmation_sent = 1 WHERE id = ?', [interviewId]);
}

// Sent when an already-announced interview is cancelled: a plain email plus a calendar CANCEL so the entry
// disappears from everyone's calendar.
async function sendInterviewCancellation({ dbGet, dbRun }, interviewId) {
  const ctx = await loadContext({ dbGet }, interviewId);
  if (!ctx) return;
  await sendInviteEmails({ dbGet, dbRun }, ctx, {
    heading: 'Interview Cancelled',
    intro: 'This interview has been cancelled. We will be in touch if it is rescheduled.',
    subject: `Interview Cancelled — ${ctx.candidate?.full_name || 'Candidate'}`
  }, { cancel: true });
}

// Fired specifically when a Google Meet link is generated for an interview
// (see the /api/interviews/:id/generate-meet-link route) — separate from the
// scheduling confirmation, since the link is usually created as a follow-up
// step rather than at the moment the interview is first saved.
async function sendMeetLinkEmail({ dbGet, dbRun }, interviewId) {
  const ctx = await loadContext({ dbGet }, interviewId);
  if (!ctx) return;
  await sendInviteEmails({ dbGet, dbRun }, ctx, {
    heading: 'Google Meet Link Ready',
    intro: `A Google Meet link has been created for this interview.`,
    subject: `Meet Link: Interview — ${ctx.candidate?.full_name || 'Candidate'}`
  });
}

async function sendInterviewReminder({ dbGet, dbRun }, interviewId) {
  const ctx = await loadContext({ dbGet }, interviewId);
  if (!ctx) return;
  const sent = await sendInviteEmails({ dbGet, dbRun }, ctx, {
    heading: 'Interview Reminder — Tomorrow',
    intro: `This is a reminder that the interview below is scheduled for tomorrow.`,
    subject: `Reminder: Interview Tomorrow — ${ctx.candidate?.full_name || 'Candidate'}`
  }, { noCalendar: true });
  if (!sent) return;
  await dbRun('UPDATE interviews SET reminder_sent = 1 WHERE id = ?', [interviewId]);
}

// Called on startup and hourly. Confirmation emails fire immediately from the
// create/update route itself (see server.js); this only handles the
// day-before reminder sweep, since that has to happen on a schedule rather
// than in response to a single request.
async function checkInterviewReminders({ dbAll, dbGet, dbRun }) {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const due = await dbAll(
    `SELECT id FROM interviews WHERE is_deleted = 0 AND reminder_sent = 0 AND scheduled_date = ? AND status IN ('Scheduled','Confirmed')`,
    [tomorrow]
  );
  for (const { id } of due) {
    try {
      await sendInterviewReminder({ dbGet, dbRun }, id);
    } catch (err) {
      console.warn(`⚠️  Interview reminder not sent for ${id}:`, err.message);
    }
  }
}

module.exports = { sendInterviewCancellation, sendInterviewConfirmation, sendMeetLinkEmail, sendInterviewReminder, checkInterviewReminders };
