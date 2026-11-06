require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const XLSX = require('xlsx');
const cron = require('node-cron');
const reminders = require('./reminders');
const stageAutomation = require('./stageAutomation');
const emailTemplates = require('./emailTemplates');
const assessmentIntake = require('./assessmentIntake');
const scorecardCriteria = require('./scorecardCriteria');
const portalPull = require('./portalPull');
const { sendMail } = require('./mailer');
const candidateReports = require('./candidateReports');
const { loadPipeline } = require('./pipeline');
const offerApproval = require('./offerApproval');
const { buildAppointmentLetterDocx } = require('./offerLetter');
const { sendAppointmentLetterEmail, sendManualLetterEmail } = require('./offerNotify');
const { sendVacancyAssignedEmail } = require('./vacancyNotify');
const panel = require('./panel');
const statusEmails = require('./statusEmails');
const { calculateCtcBreakdown } = require('./ctcCalculator');
const { sendWeeklyTracker, maybeSendWeeklyTracker } = require('./weeklyTracker');
const googleCalendar = require('./googleCalendar');
const { sendInterviewConfirmation, sendInterviewCancellation, sendMeetLinkEmail, checkInterviewReminders } = require('./interviewNotify');

const {
  dbRun,
  dbGet,
  dbAll,
  nextCode,
  logActivity,
  logAudit,
  parseJsonFields,
  initialize,
  UPLOADS_DIR
} = require('./database');
stageAutomation.init({ dbGet, dbAll, dbRun, logActivity, logAudit });

const app = express();

// Safety net: wraps every app.get/post/put/delete/patch handler so that if an
// async route throws (like the SQLITE_ERROR that surfaced here — a table
// missing a column the delete route expected), Express gets a proper
// next(err) instead of an unhandled promise rejection. Node terminates the
// entire process on an unhandled rejection by default, which would otherwise
// mean one broken request takes the server down for every user until it's
// restarted. The matching error-handling middleware (after all routes,
// see bottom of file) turns caught errors into a clean 500 response instead.
for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
  const original = app[method].bind(app);
  app[method] = (path, ...handlers) => original(path, ...handlers.map((h) =>
    typeof h === 'function'
      ? (req, res, next) => { try { Promise.resolve(h(req, res, next)).catch(next); } catch (err) { next(err); } }
      : h
  ));
}
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'recruitment-ats-local-dev-secret';

const tableConfig = {
  users: {
    fields: ['full_name', 'username', 'role', 'email', 'phone', 'is_active'],
    jsonFields: [],
    softDelete: false,
    orderBy: 'created_at DESC',
    superAdminOnly: true,
    required: ['full_name', 'username', 'role'],
    enums: { role: ['super_admin', 'hr_manager', 'recruiter', 'viewer'] },
    searchFields: ['full_name', 'username', 'email'],
    filterFields: ['role', 'is_active']
  },
  clients: {
    fields: ['company_name', 'registered_address', 'cin', 'phone', 'email', 'website', 'signatory_name', 'signatory_designation', 'signatory_email', 'onboarding_form_link', 'contact_person', 'industry', 'location', 'account_owner_id', 'billing_details', 'notes', 'is_active'],
    jsonFields: [],
    softDelete: true,
    orderBy: 'company_name ASC',
    createdBy: true,
    required: ['company_name'],
    searchFields: ['company_name', 'contact_person', 'email', 'location'],
    filterFields: ['account_owner_id', 'is_active', 'industry']
  },
  interviewers: {
    fields: ['employee_code', 'name', 'designation', 'city', 'company', 'location', 'email', 'phone', 'is_active'],
    jsonFields: [],
    softDelete: true,
    orderBy: 'name ASC',
    createdBy: true,
    required: ['name'],
    searchFields: ['name', 'employee_code', 'designation', 'city', 'location', 'email'],
    writeRoles: ['super_admin', 'hr_manager'],
    filterFields: ['is_active', 'city', 'company']
  },
  signatories: {
    fields: ['name', 'designation', 'email', 'company', 'is_active'],
    jsonFields: [],
    softDelete: true,
    orderBy: 'name ASC',
    createdBy: true,
    required: ['name', 'email'],
    searchFields: ['name', 'designation', 'email', 'company'],
    writeRoles: ['super_admin', 'hr_manager'],
    filterFields: ['is_active', 'company']
  },
  jds: {
    fields: ['title', 'company', 'summary', 'responsibilities', 'required_skills', 'preferred_skills', 'experience_min', 'experience_max', 'qualification', 'other_requirements', 'version', 'parent_id', 'is_archived'],
    jsonFields: ['required_skills', 'preferred_skills'],
    softDelete: true,
    orderBy: 'updated_at DESC',
    createdBy: true,
    required: ['title'],
    searchFields: ['title', 'qualification'],
    filterFields: ['is_archived', 'company']
  },
  vacancies: {
    fields: ['vacancy_code', 'title', 'company', 'client_id', 'received_from', 'date_received', 'ctc_min', 'ctc_max', 'location', 'job_type', 'priority', 'jd_id', 'jd_version', 'positions_required', 'positions_filled', 'assigned_recruiter_id', 'status', 'closure_reason', 'vacancy_reason', 'reason_details'],
    jsonFields: [],
    softDelete: true,
    orderBy: 'created_at DESC',
    code: ['VAC', 'vacancy_code'],
    createdBy: true,
    required: ['title', 'company', 'date_received', 'vacancy_reason', 'assigned_recruiter_id'],
    enums: {
      vacancy_reason: ['New Position', 'Replacement', 'Additional Headcount', 'Backfill (transfer / promotion)', 'Other'],
      company: ['RDC Concrete India Limited', 'Ultrafine Mineral & Admixture Pvt. Limited', 'ROBO Silicon Pvt Ltd'],
      status: ['Open', 'On Hold', 'Closed', 'Closed Internally', 'Cancelled'],
      priority: ['Low', 'Medium', 'High', 'Urgent'],
      job_type: ['Retainer', 'Fixed Term', 'Off Role', 'Trainee', 'Full Time']
    },
    searchFields: ['title', 'vacancy_code', 'location', 'received_from', 'company'],
    filterFields: ['company', 'status', 'priority', 'assigned_recruiter_id'],
    onWrite: handleVacancyWrite
  },
  candidates: {
    fields: ['candidate_code', 'full_name', 'mobile', 'email', 'date_of_birth', 'current_location', 'address', 'preferred_location', 'total_experience', 'relevant_experience', 'current_company', 'current_designation', 'current_ctc', 'expected_ctc', 'notice_period', 'qualification', 'skills', 'source', 'linkedin_url', 'status', 'last_contacted', 'remarks', 'tags', 'next_action', 'next_action_due', 'next_action_assigned_id'],
    jsonFields: ['skills', 'tags'],
    softDelete: true,
    orderBy: 'created_at DESC',
    code: ['CAN', 'candidate_code'],
    createdBy: true,
    required: ['full_name'],
    enums: { status: ['Active', 'Passive', 'Placed', 'Not Interested', 'Blacklisted'] },
    searchFields: ['full_name', 'candidate_code', 'email', 'mobile', 'current_company', 'current_location'],
    filterFields: ['status', 'source', 'next_action_assigned_id']
  },
  applications: {
    fields: ['candidate_id', 'vacancy_id', 'recruiter_id', 'jd_id', 'jd_version', 'match_score', 'manual_score', 'score_override_reason', 'score_breakdown', 'score_version', 'score_weights', 'score_calculated_at', 'status', 'rejection_reason'],
    jsonFields: ['score_breakdown', 'score_weights'],
    softDelete: true,
    orderBy: 'created_at DESC',
    required: ['candidate_id', 'vacancy_id'],
    enums: {
      status: ['Sourced', 'Screening', 'Shortlisted', 'Interview', 'Offered', 'Joined', 'Rejected', 'Withdrawn']
    },
    filterFields: ['candidate_id', 'vacancy_id', 'recruiter_id', 'status'],
    onWrite: calculateMatchScore
  },
  interviews: {
    fields: ['application_id', 'candidate_id', 'vacancy_id', 'round', 'interviewer', 'interviewer_email', 'type', 'scheduled_date', 'scheduled_time', 'meeting_link', 'location', 'status', 'feedback', 'scorecard', 'rating', 'recommendation', 'hire_type'],
    jsonFields: ['scorecard'],
    softDelete: true,
    orderBy: 'scheduled_date DESC, scheduled_time DESC',
    createdBy: true,
    required: ['candidate_id', 'vacancy_id'],
    enums: {
      type: ['Video', 'Phone', 'In-person', 'Panel'],
      status: ['Scheduled', 'Confirmed', 'Completed', 'No Show', 'Cancelled', 'Rescheduled'],
      recommendation: ['Proceed', 'Hold', 'Reject'],
      hire_type: ['On Roll', 'Off Roll', 'Fixed Term Contract', 'Retainer Contract']
    },
    filterFields: ['candidate_id', 'vacancy_id', 'application_id', 'status'],
    onWrite: sendInterviewConfirmationOnSchedule
  },
  offers: {
    fields: ['application_id', 'candidate_id', 'vacancy_id', 'offered_ctc', 'fixed_component', 'variable_component', 'basic_pay', 'hra', 'special_allowance', 'lta', 'employer_pf', 'gratuity', 'joining_bonus', 'benefits', 'offer_date', 'valid_till', 'expected_joining', 'additional_recipients', 'letter_remarks', 'status'],
    jsonFields: [],
    softDelete: true,
    orderBy: 'created_at DESC',
    createdBy: true,
    required: ['candidate_id', 'vacancy_id', 'offered_ctc'],
    enums: { status: ['Draft', 'Pending Approval', 'Changes Requested', 'Approved', 'Sent', 'Negotiation', 'Accepted', 'Declined', 'Withdrawn'] },
    filterFields: ['candidate_id', 'vacancy_id', 'status'],
    onWrite: sendAppointmentLetterOnApproval
  },
  joining: {
    fields: ['offer_id', 'application_id', 'candidate_id', 'vacancy_id', 'expected_date', 'actual_date', 'status', 'offered_ctc', 'joined_ctc', 'joining_location', 'reporting_manager', 'documents_pending', 'drop_reason'],
    jsonFields: [],
    softDelete: true,
    orderBy: 'expected_date DESC',
    createdBy: true,
    required: ['candidate_id', 'vacancy_id', 'expected_date'],
    enums: { status: ['Expected', 'Confirmed', 'Joined', 'Dropped', 'Deferred'] },
    filterFields: ['candidate_id', 'vacancy_id', 'status'],
    onWrite: syncVacancyFillStatus
  },
  communications: {
    fields: ['candidate_id', 'date', 'type', 'direction', 'subject', 'notes', 'follow_up_date'],
    jsonFields: [],
    softDelete: true,
    orderBy: 'date DESC',
    createdBy: true,
    required: ['candidate_id', 'type'],
    enums: { direction: ['Inbound', 'Outbound'] },
    filterFields: ['candidate_id', 'type']
  },
  assessments: {
    fields: ['candidate_id', 'vacancy_id', 'application_id', 'assessment_type', 'status', 'assessment_date', 'score', 'result_summary', 'report_link', 'remarks'],
    jsonFields: [],
    softDelete: true,
    orderBy: 'created_at DESC',
    createdBy: true,
    required: ['candidate_id', 'assessment_type'],
    enums: {
      assessment_type: ['Plant PRO SRT', 'DISC'],
      status: ['Pending', 'Sent', 'Completed', 'Not Required']
    },
    filterFields: ['candidate_id', 'vacancy_id', 'application_id', 'status', 'assessment_type']
  },
  followups: {
    fields: ['entity_type', 'entity_id', 'entity_name', 'note', 'due_date', 'assigned_to', 'completed', 'completed_at'],
    jsonFields: [],
    softDelete: true,
    orderBy: 'completed ASC, due_date ASC',
    createdBy: true,
    required: ['entity_type', 'entity_id', 'note', 'due_date'],
    enums: { entity_type: ['candidate', 'vacancy', 'client', 'application'] },
    searchFields: ['entity_name', 'note'],
    filterFields: ['assigned_to', 'completed', 'entity_type']
  },
  notes: {
    fields: ['entity_type', 'entity_id', 'content', 'tags'],
    jsonFields: ['tags'],
    softDelete: true,
    orderBy: 'created_at DESC',
    createdBy: true,
    required: ['entity_type', 'entity_id', 'content'],
    enums: { entity_type: ['candidate', 'vacancy', 'client', 'application', 'interview', 'offer'] },
    filterFields: ['entity_type', 'entity_id']
  }
};

// Records when a vacancy first reaches a closed state, so closure TAT (time to
// fill) can be measured as closed_at minus created_at. Only ever sets it once —
// reopening and re-closing a vacancy doesn't overwrite the original closure date.
// Runs both vacancy side-effects: TAT tracking (closed_at) and emailing the
// recruiter when they're newly assigned. Combined into one function since a
// table can only have one onWrite hook.
async function handleVacancyWrite(ctx) {
  await setVacancyClosedAt(ctx);
  await notifyOnRecruiterAssignment(ctx);
}

// Emails the assigned recruiter once per assignment — tracked separately
// from "has this vacancy ever been saved" so reassigning to a *different*
// recruiter later sends a fresh email, but unrelated edits (status,
// priority, etc.) never re-send it to the same recruiter.
async function notifyOnRecruiterAssignment({ id, values, existing }) {
  if (!values.assigned_recruiter_id) return;
  const alreadyNotified = existing && existing.assigned_recruiter_notified_id === values.assigned_recruiter_id;
  if (alreadyNotified) return;
  try {
    await sendVacancyAssignedEmail({ dbGet }, id);
    await dbRun('UPDATE vacancies SET assigned_recruiter_notified_id = ? WHERE id = ?', [values.assigned_recruiter_id, id]);
  } catch (err) {
    console.warn(`⚠️  Vacancy assignment email not sent for ${id}:`, err.message);
  }
}

async function setVacancyClosedAt({ id, values, existing }) {
  if (!values.status || !['Closed', 'Closed Internally', 'Cancelled'].includes(values.status)) return;
  const current = existing || (await dbGet('SELECT closed_at FROM vacancies WHERE id = ?', [id]));
  if (current && !current.closed_at) {
    await dbRun(`UPDATE vacancies SET closed_at = datetime('now') WHERE id = ?`, [id]);
  }
}

// Recomputes a vacancy's positions_filled from its joining records whenever a
// joining record is created/updated, and auto-closes the vacancy once filled.
async function syncVacancyFillStatus({ values, existing }) {
  const vacancyId = values.vacancy_id || (existing && existing.vacancy_id);
  if (!vacancyId) return;
  const row = await dbGet(
    "SELECT COUNT(*) AS filled FROM joining WHERE vacancy_id = ? AND is_deleted = 0 AND status = 'Joined'",
    [vacancyId]
  );
  const vacancy = await dbGet('SELECT positions_required, status FROM vacancies WHERE id = ?', [vacancyId]);
  if (!vacancy) return;
  const filled = row.filled;
  const shouldClose = vacancy.status === 'Open' && filled >= vacancy.positions_required;
  await dbRun(
    `UPDATE vacancies SET positions_filled = ?, updated_at = datetime('now')${shouldClose ? ", status = 'Closed', closure_reason = COALESCE(closure_reason, 'Positions filled')" : ''} WHERE id = ?`,
    [filled, vacancyId]
  );
}

// ─── Candidate ↔ JD match scoring ──────────────────────────────────────────────
// A JD is tagged to a vacancy (vacancies.jd_id); an application tags a candidate
// to a vacancy. Whenever an application is created or updated, this compares the
// candidate's profile against that vacancy's JD and stores a percentage match
// score plus a component breakdown, using the weights configured in Settings.
function safeParseArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function skillsOverlapPct(required, candidateSkills) {
  if (!required.length) return null;
  const haystack = candidateSkills.map((s) => s.toLowerCase().trim());
  const matched = required.filter((skill) => {
    const needle = skill.toLowerCase().trim();
    return haystack.some((s) => s.includes(needle) || needle.includes(s));
  });
  return matched.length / required.length;
}

// Fires the "Interview Scheduled" confirmation email the first time an
// interview is created or edited — never more than once per interview, so
// editing feedback/rating later doesn't re-send it. Failures are logged but
// never block saving the interview itself (email being down shouldn't stop
// someone from doing their job in the tracker).
// Fires when an offer's status is set to "Approved" — sends the appointment
// letter automatically, once. Editing other fields on an already-approved
// offer never re-triggers it; the "Resend Appointment Letter" button in the
// UI covers any situation where it needs to go out again.
// Approval of an offer belongs to the Authorized Signatory (see offerApproval.js). Only a Super Admin can override it by hand.
function offerApprovalBlocked(req, values, existing) {
  if (!values.status || (existing && existing.status === values.status)) return false;
  if (!['Approved', 'Pending Approval'].includes(values.status)) return false;
  return currentUser(req).role !== 'super_admin';
}

async function sendAppointmentLetterOnApproval({ id, values, existing }) {
  if (values.status !== 'Approved') return;
  if (existing && existing.letter_sent) return;
  try {
    await sendAppointmentLetterEmail({ dbGet, dbRun }, id);
  } catch (err) {
    console.warn(`⚠️  Appointment letter email not sent for offer ${id}:`, err.message);
  }
}

// The recruiter of an application is the recruiter of its vacancy (never left blank when one is known).
async function recruiterForVacancy(vacancyId, user) {
  const v = vacancyId ? await dbGet('SELECT assigned_recruiter_id FROM vacancies WHERE id = ?', [vacancyId]) : null;
  if (v && v.assigned_recruiter_id) return v.assigned_recruiter_id;
  return user && user.role === 'recruiter' ? user.id : null;
}

// Links a candidate to a vacancy (creates the application) — used when a vacancy is picked on the new-candidate form.
async function linkCandidateToVacancy(candidateId, vacancyId, user) {
  const vac = await dbGet('SELECT id, jd_id FROM vacancies WHERE id = ? AND is_deleted = 0', [vacancyId]);
  if (!vac) return null;
  const dup = await dbGet('SELECT id FROM applications WHERE candidate_id = ? AND vacancy_id = ? AND is_deleted = 0', [candidateId, vacancyId]);
  if (dup) return dup.id;
  const id = uuidv4();
  const values = { id, candidate_id: candidateId, vacancy_id: vacancyId, recruiter_id: await recruiterForVacancy(vacancyId, user), status: 'Sourced' };
  const { sql, params } = createInsert('applications', values);
  await dbRun(sql, params);
  await logActivity('applications', id, 'Created', null, null, user.id, user.full_name);
  await logAudit(user.id, user.full_name, 'create', 'applications', id, values);
  try { await calculateMatchScore({ id }); } catch (e) { console.warn('⚠️  Match score not calculated:', e.message); }
  return id;
}

// Every list shows where the candidate stands in the pipeline (the application's current status), so a change made
// on one screen is visible on all of them without opening anything.
const STAGE_RANK = { Offered: 6, Interview: 5, Shortlisted: 4, Screening: 3, Sourced: 2, Joined: 1, Rejected: 0, Withdrawn: 0 };
async function decorateStage(table, rows) {
  if (!rows.length) return;
  if (table === 'candidates') {
    const ids = rows.map((r) => r.id);
    const apps = await dbAll(`SELECT a.candidate_id, a.status, v.title FROM applications a LEFT JOIN vacancies v ON v.id = a.vacancy_id WHERE a.is_deleted = 0 AND a.candidate_id IN (${ids.map(() => '?').join(',')}) ORDER BY a.created_at`, ids);
    for (const r of rows) {
      const mine = apps.filter((a) => a.candidate_id === r.id);
      const best = mine.sort((a, b) => (STAGE_RANK[b.status] ?? 0) - (STAGE_RANK[a.status] ?? 0))[0];
      r.stage = best ? best.status : null; r.stage_vacancy = best ? best.title : null;
    }
    return;
  }
  if (!['interviews', 'offers', 'joining', 'assessments'].includes(table)) return;
  const cids = [...new Set(rows.map((r) => r.candidate_id).filter(Boolean))];
  if (!cids.length) return;
  const apps = await dbAll(`SELECT id, candidate_id, vacancy_id, status FROM applications WHERE is_deleted = 0 AND candidate_id IN (${cids.map(() => '?').join(',')}) ORDER BY created_at`, cids);
  for (const r of rows) {
    const a = apps.find((x) => x.id === r.application_id) || apps.filter((x) => x.candidate_id === r.candidate_id && x.vacancy_id === r.vacancy_id).pop();
    r.app_stage = a ? a.status : null;
  }
}

// Keeps a panel's extra interviewers in step with the main interview (see panel.js).
async function applyPanel(id, rawPanel, user, silent = false) {
  try {
    await panel.apply({ dbAll, dbGet, dbRun }, id, rawPanel, { silent, userId: user && user.id, notify: (rid, values, existing) => sendInterviewConfirmationOnSchedule({ id: rid, values, existing }) });
  } catch (err) { console.warn(`⚠️  Interview panel not updated for ${id}:`, err.message); }
}

async function sendInterviewConfirmationOnSchedule({ id, values, existing }) {
  if (values.status === 'Cancelled' && existing && existing.status !== 'Cancelled') {
    // only people who were told about the interview need to hear it is off
    if (existing.confirmation_sent) {
      try { await sendInterviewCancellation({ dbGet, dbRun }, id); }
      catch (err) { console.warn(`⚠️  Interview cancellation email not sent for ${id}:`, err.message); }
    }
    return;
  }
  const rescheduled = existing && existing.confirmation_sent && (
    (values.scheduled_date && values.scheduled_date !== existing.scheduled_date) ||
    (values.scheduled_time && values.scheduled_time !== existing.scheduled_time)
  );
  if (existing && existing.confirmation_sent && !rescheduled) {
    // already announced: the only thing still worth doing is a Meet link that is missing for a video interview
    try {
      const iv = await dbGet('SELECT * FROM interviews WHERE id = ?', [id]);
      if (iv && iv.type === 'Video' && !iv.meeting_link && !['Cancelled', 'No Show', 'Completed'].includes(iv.status) && iv.scheduled_date) {
        if (await createMeetFor(id)) { await sendMeetLinkEmail({ dbGet, dbRun }, id); noteInterview(id, 'Google Meet link created and emailed'); }
      }
    } catch (err) { console.warn(`⚠️  Meet link not added for interview ${id}:`, err.message); }
    return;
  }
  try {
    let interview = await dbGet('SELECT * FROM interviews WHERE id = ?', [id]);
    // Video interviews get their Google Meet link right here, before the invite goes out, so the very first
    // email already carries it. When that is not possible the reason is shown to the recruiter (not just logged).
    if (interview && interview.type === 'Video' && !interview.meeting_link) await createMeetFor(id);
    else if (interview && interview.type === 'Video' && rescheduled && interview.google_event_id) {
      try { await googleCalendar.updateEventTimes({ dbGet, dbRun }, interview.google_event_id, `${interview.scheduled_date}T${interview.scheduled_time || '10:00'}:00`, addMinutesToLocalDateTime(interview.scheduled_date, interview.scheduled_time || '10:00', 45)); }
      catch (e) { console.warn(`⚠️  Google event not moved for ${id}:`, e.message); }
    }
    await sendInterviewConfirmation({ dbGet, dbRun }, id, { rescheduled });
  } catch (err) {
    console.warn(`⚠️  Interview confirmation email not sent for ${id}:`, err.message);
  }
}

// What the recruiter is told after saving an interview (shown with the "Also done automatically" message).
const interviewNotes = new Map();
function noteInterview(id, msg) { interviewNotes.set(id, msg); }
function takeInterviewNote(id) { const m = interviewNotes.get(id); interviewNotes.delete(id); return m || null; }

// Creates the Meet link for a video interview; returns true when a link now exists.
async function createMeetFor(id) {
  const iv = await dbGet('SELECT scheduled_date, meeting_link FROM interviews WHERE id = ?', [id]);
  if (iv && iv.meeting_link) return true;
  if (!iv || !iv.scheduled_date) { noteInterview(id, 'No Meet link yet — set the interview date and it is created automatically'); return false; }
  try {
    if (!(await googleCalendar.isConnected({ dbGet }))) {
      noteInterview(id, 'Meet link NOT created — Google Calendar is not connected yet (Super Admin: Settings → Google Calendar). The invite went out without a link');
      return false;
    }
    await generateMeetLinkForInterview(id);
    noteInterview(id, 'Google Meet link created and included in the invites');
    return true;
  } catch (e) {
    noteInterview(id, `Meet link NOT created — ${e.message}`);
    console.warn(`⚠️  Auto Meet link generation failed for interview ${id}:`, e.message);
    return false;
  }
}

async function calculateMatchScore({ id }) {
  const application = await dbGet('SELECT * FROM applications WHERE id = ?', [id]);
  if (!application) return;
  const [candidate, vacancy] = await Promise.all([
    dbGet('SELECT * FROM candidates WHERE id = ?', [application.candidate_id]),
    dbGet('SELECT * FROM vacancies WHERE id = ?', [application.vacancy_id])
  ]);
  if (!candidate || !vacancy || !vacancy.jd_id) return; // nothing to score against yet
  const jd = await dbGet('SELECT * FROM jds WHERE id = ?', [vacancy.jd_id]);
  if (!jd) return;

  const weightsRow = await dbGet("SELECT value FROM settings WHERE key = 'scoring_weights'");
  let configured = {};
  try { configured = JSON.parse(weightsRow.value); } catch { /* fall back to defaults below */ }
  const weights = {
    mandatory: configured.mandatory ?? 50,
    preferred: configured.preferred ?? 10,
    experience: configured.experience ?? 20,
    qualification: configured.qualification ?? 10
  };

  const candidateSkills = safeParseArray(candidate.skills);
  const mandatoryPct = skillsOverlapPct(safeParseArray(jd.required_skills), candidateSkills);
  const preferredPct = skillsOverlapPct(safeParseArray(jd.preferred_skills), candidateSkills);

  let experienceScore = null;
  if (jd.experience_min != null || jd.experience_max != null) {
    const exp = candidate.total_experience || 0;
    const aboveMin = jd.experience_min == null || exp >= jd.experience_min;
    const belowMax = jd.experience_max == null || exp <= jd.experience_max;
    experienceScore = aboveMin && belowMax ? 1 : 0;
  }

  // Free-text qualification matching is inherently approximate — this checks
  // whether the JD's qualification text appears (or vice versa), so it should
  // be read as a rough signal, not an authoritative pass/fail.
  let qualificationScore = null;
  if (jd.qualification && candidate.qualification) {
    const jdQual = jd.qualification.toLowerCase();
    const canQual = candidate.qualification.toLowerCase();
    qualificationScore = (jdQual.includes(canQual) || canQual.includes(jdQual)) ? 1 : 0;
  }

  const components = [
    ['mandatory', mandatoryPct, weights.mandatory],
    ['preferred', preferredPct, weights.preferred],
    ['experience', experienceScore, weights.experience],
    ['qualification', qualificationScore, weights.qualification]
  ].filter(([, score]) => score !== null);

  if (!components.length) return; // JD has no requirements we can compare against yet

  const totalWeight = components.reduce((sum, [, , w]) => sum + w, 0) || 1;
  const matchScore = Math.round(components.reduce((sum, [, score, w]) => sum + score * w, 0) / totalWeight * 100);
  const breakdown = {};
  for (const [key, score, w] of components) breakdown[key] = { score: Math.round(score * 100), weight: w };

  await dbRun(
    `UPDATE applications SET match_score = ?, score_breakdown = ?, score_version = 'v1.0', score_weights = ?, score_calculated_at = datetime('now') WHERE id = ?`,
    [matchScore, JSON.stringify(breakdown), JSON.stringify(weights), id]
  );
}

// Lightweight request-body validation shared by the create/update routes.
function validateInput(table, config, values, isCreate) {
  const errors = [];
  if (isCreate) {
    for (const field of config.required || []) {
      if (values[field] === undefined || values[field] === null || values[field] === '') {
        errors.push(`${field} is required`);
      }
    }
  }
  for (const [field, allowed] of Object.entries(config.enums || {})) {
    if (values[field] !== undefined && values[field] !== null && values[field] !== '' && !allowed.includes(values[field])) {
      errors.push(`${field} must be one of: ${allowed.join(', ')}`);
    }
  }
  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
    errors.push('email is not a valid email address');
  }
  if (table === 'candidates' && values.date_of_birth) {
    const dob = new Date(values.date_of_birth + 'T00:00:00Z');
    const age = (Date.now() - dob.getTime()) / 31557600000;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date_of_birth) || isNaN(dob)) errors.push('date_of_birth is not a valid date');
    else if (age < 14 || age > 80) errors.push('date_of_birth looks wrong — the candidate would be ' + Math.floor(age) + ' years old');
  }
  return errors;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}-${uuidv4()}-${safeName}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: path.join(__dirname, 'data') }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 8
  }
}));

const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

function currentUser(req) {
  return req.session.user || null;
}

function requireAuth(req, res, next) {
  if (!currentUser(req)) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    const user = currentUser(req);
    if (!user || !roles.includes(user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

function canWrite(req, res, table) {
  const user = currentUser(req);
  if (user.role === 'viewer') {
    res.status(403).json({ error: 'Viewer role is read-only' });
    return false;
  }
  if (tableConfig[table].writeRoles && !tableConfig[table].writeRoles.includes(user.role)) {
    res.status(403).json({ error: 'Only an admin (Super Admin or HR Manager) can change this list.' });
    return false;
  }
  if (tableConfig[table].superAdminOnly && user.role !== 'super_admin') {
    res.status(403).json({ error: 'Super Admin role required' });
    return false;
  }
  return true;
}

function serializeJsonFields(input, jsonFields) {
  const output = { ...input };
  for (const field of jsonFields) {
    if (output[field] !== undefined && output[field] !== null && typeof output[field] !== 'string') {
      output[field] = JSON.stringify(output[field]);
    }
  }
  return output;
}

function parseRows(rows, jsonFields) {
  return rows.map((row) => parseJsonFields(row, jsonFields));
}

// The generic routes below do `SELECT *`, which for `users` includes the bcrypt
// password_hash column. Every authenticated user (including viewers) could read
// every other user's hash via GET /api/users — strip it before it ever leaves the server.
function stripSecrets(table, row) {
  if (table === 'users' && row) delete row.password_hash;
  if (table === 'offers' && row) { delete row.approval_token; delete row.approval_signature; delete row.approval_agent; delete row.manual_letter_path; }
  if (table === 'interviews' && row) delete row.scorecard_token; // the secret link token is only handed out by the link endpoint
  return row;
}

function filterInput(body, fields) {
  return fields.reduce((values, field) => {
    if (body[field] !== undefined) values[field] = body[field];
    return values;
  }, {});
}

function createInsert(table, values) {
  const columns = Object.keys(values);
  const placeholders = columns.map(() => '?').join(',');
  const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`;
  return { sql, params: columns.map((column) => values[column]) };
}

function createUpdate(table, values, id) {
  const columns = Object.keys(values);
  const assignments = columns.map((column) => `${column} = ?`).join(',');
  const sql = `UPDATE ${table} SET ${assignments}, updated_at = datetime('now') WHERE id = ?`;
  return { sql, params: [...columns.map((column) => values[column]), id] };
}

app.get('/api/health', async (_req, res) => {
  const result = await dbGet("SELECT datetime('now') AS database_time");
  res.json({ ok: true, database_time: result.database_time });
});

// In-memory login throttle: 5 failed attempts locks that username out for 15 minutes.
// This is per-process (resets on restart, not shared across multiple app instances) —
// fine for a single small-team internal deployment, not a substitute for a proper
// rate limiter if this is ever load-balanced across processes.
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const loginAttempts = new Map();

function isLockedOut(username) {
  const entry = loginAttempts.get(username);
  if (!entry) return false;
  if (entry.count < LOGIN_MAX_ATTEMPTS) return false;
  if (Date.now() - entry.lastAttempt > LOGIN_LOCKOUT_MS) {
    loginAttempts.delete(username);
    return false;
  }
  return true;
}

function recordLoginFailure(username) {
  const entry = loginAttempts.get(username) || { count: 0, lastAttempt: 0 };
  entry.count += 1;
  entry.lastAttempt = Date.now();
  loginAttempts.set(username, entry);
}

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  if (isLockedOut(username)) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }

  const user = await dbGet('SELECT * FROM users WHERE username = ? AND is_active = 1', [username]);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    recordLoginFailure(username);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  loginAttempts.delete(username);

  req.session.user = {
    id: user.id,
    full_name: user.full_name,
    username: user.username,
    role: user.role,
    email: user.email
  };

  await logAudit(user.id, user.full_name, 'login', 'user', user.id, {});
  res.json({ user: req.session.user });
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  const user = currentUser(req);
  await logAudit(user.id, user.full_name, 'logout', 'user', user.id, {});
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: currentUser(req) });
});

// Links to the other HR apps on the RDC portal (editable in Settings).
app.get('/api/tools', requireAuth, async (_req, res) => {
  const rows = await dbAll("SELECT key, value FROM settings WHERE key IN ('srt_url', 'disc_url')");
  const v = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  res.json({
    srt: v.srt_url || 'https://hr.rdcc.ai/srt/admin',
    disc: v.disc_url || 'https://hr.rdcc.ai/disc/admin'
  });
});

// TAT insights: average days to close (by company / recruiter / location) and
// vacancies that have been open longer than the "critical" threshold.
app.get('/api/dashboard/tat', requireAuth, async (_req, res) => {
  const setting = await dbGet("SELECT value FROM settings WHERE key = 'sla_vacancy_critical_days'");
  const threshold = Math.max(parseInt(setting && setting.value, 10) || 30, 1);
  const days = "MAX(julianday(v.closed_at) - julianday(COALESCE(NULLIF(v.date_received, ''), v.created_at)), 0)";
  const closedBase = `FROM vacancies v LEFT JOIN users u ON u.id = v.assigned_recruiter_id
    WHERE v.is_deleted = 0 AND v.status IN ('Closed', 'Closed Internally') AND v.closed_at IS NOT NULL`;
  const group = (expr) => dbAll(`SELECT COALESCE(NULLIF(${expr}, ''), 'Not set') AS label,
      COUNT(*) AS closed, ROUND(AVG(${days}), 1) AS avg_days
    ${closedBase} GROUP BY label ORDER BY avg_days DESC`);
  const [byCompany, byRecruiter, byLocation, overall, aging] = await Promise.all([
    group('v.company'), group('u.full_name'), group('v.location'),
    dbGet(`SELECT COUNT(*) AS closed, ROUND(AVG(${days}), 1) AS avg_days ${closedBase}`),
    dbAll(`SELECT v.id, v.vacancy_code, v.title, v.company, v.location, v.priority, v.status,
        u.full_name AS recruiter, v.positions_required - v.positions_filled AS remaining,
        CAST(ROUND(julianday('now') - julianday(COALESCE(NULLIF(v.date_received,''), v.created_at))) AS INTEGER) AS days_open
      FROM vacancies v LEFT JOIN users u ON u.id = v.assigned_recruiter_id
      WHERE v.is_deleted = 0 AND v.status IN ('Open', 'On Hold')
        AND julianday('now') - julianday(COALESCE(NULLIF(v.date_received,''), v.created_at)) > ?
      ORDER BY days_open DESC`, [threshold])
  ]);
  res.json({ threshold, overall, byCompany, byRecruiter, byLocation, aging });
});

// A filter value like "Scheduled,Confirmed" matches either (used by the clickable dashboard tiles).
function addFilter(clauses, params, field, value) {
  const vals = String(value).split(',').map((v) => v.trim()).filter(Boolean);
  if (vals.length > 1) { clauses.push(`${field} IN (${vals.map(() => '?').join(',')})`); params.push(...vals); }
  else { clauses.push(`${field} = ?`); params.push(vals[0] ?? value); }
}

// Every open candidate with who it is waiting on — feeds the "Pending with" tiles.
app.get('/api/dashboard/pipeline', requireAuth, async (_req, res) => { res.json(await loadPipeline(dbAll)); });
// Closed vacancies behind one TAT tile (by company / recruiter / location).
app.get('/api/dashboard/closed', requireAuth, async (req, res) => {
  const col = { company: 'v.company', recruiter: 'u.full_name', location: 'v.location' }[req.query.group];
  if (!col) return res.status(400).json({ error: 'Unknown group' });
  const value = String(req.query.value || '');
  const cond = value === 'Not set' ? `(${col} IS NULL OR ${col} = '')` : `${col} = ?`;
  res.json(await dbAll(`SELECT v.id, v.vacancy_code, v.title, v.company, v.location, u.full_name AS recruiter, v.created_at, v.closed_at,
      MAX(CAST(ROUND(julianday(v.closed_at) - julianday(COALESCE(NULLIF(v.date_received,''), v.created_at))) AS INTEGER), 0) AS days
    FROM vacancies v LEFT JOIN users u ON u.id = v.assigned_recruiter_id
    WHERE v.is_deleted = 0 AND v.status IN ('Closed','Closed Internally') AND v.closed_at IS NOT NULL AND ${cond} ORDER BY days DESC`, value === 'Not set' ? [] : [value]));
});

app.get('/api/dashboard', requireAuth, async (_req, res) => {
  const [
    vacancies,
    candidates,
    applications,
    interviews,
    offers,
    joining,
    overdueFollowups,
    dueTodayFollowups
  ] = await Promise.all([
    dbGet("SELECT COUNT(*) AS count FROM vacancies WHERE is_deleted = 0 AND status = 'Open'"),
    dbGet("SELECT COUNT(*) AS count FROM candidates WHERE is_deleted = 0"),
    dbAll("SELECT status, COUNT(*) AS count FROM applications WHERE is_deleted = 0 GROUP BY status"),
    dbGet("SELECT COUNT(*) AS count FROM interviews WHERE is_deleted = 0 AND status IN ('Scheduled','Confirmed')"),
    dbGet("SELECT COUNT(*) AS count FROM offers WHERE is_deleted = 0 AND status IN ('Draft','Pending Approval','Changes Requested','Approved','Sent','Negotiation','Accepted')"),
    dbGet("SELECT COUNT(*) AS count FROM joining WHERE is_deleted = 0 AND status IN ('Expected','Confirmed')"),
    dbGet("SELECT COUNT(*) AS count FROM followups WHERE is_deleted = 0 AND completed = 0 AND due_date < date('now')"),
    dbGet("SELECT COUNT(*) AS count FROM followups WHERE is_deleted = 0 AND completed = 0 AND due_date = date('now')")
  ]);

  res.json({
    open_vacancies: vacancies.count,
    candidates: candidates.count,
    application_statuses: applications,
    upcoming_interviews: interviews.count,
    active_offers: offers.count,
    joining_expected: joining.count,
    overdue_followups: overdueFollowups.count,
    due_today_followups: dueTodayFollowups.count
  });
});

app.get('/api/search', requireAuth, async (req, res) => {
  const query = `%${String(req.query.q || '').trim()}%`;
  if (query === '%%') return res.json({ candidates: [], vacancies: [], clients: [] });

  const [candidates, vacancies, clients] = await Promise.all([
    dbAll('SELECT id, candidate_code, full_name, email, mobile FROM candidates WHERE is_deleted = 0 AND (full_name LIKE ? OR email LIKE ? OR mobile LIKE ? OR candidate_code LIKE ?) LIMIT 10', [query, query, query, query]),
    dbAll('SELECT id, vacancy_code, title, location, status FROM vacancies WHERE is_deleted = 0 AND (title LIKE ? OR vacancy_code LIKE ? OR location LIKE ?) LIMIT 10', [query, query, query]),
    dbAll('SELECT id, company_name, contact_person, email FROM clients WHERE is_deleted = 0 AND (company_name LIKE ? OR contact_person LIKE ? OR email LIKE ?) LIMIT 10', [query, query, query])
  ]);

  res.json({ candidates, vacancies, clients });
});

// Excel export for any table — respects the same q/filter params as its list
// screen, so exporting after searching/filtering exports just that subset.
// Registered before the generic per-table loop below, otherwise the generic
// `GET /api/<table>/:id` route would match "export" as an id and shadow this.
const EXPORT_LABEL_FIELDS = { clients: 'company_name', vacancies: 'title', candidates: 'full_name', jds: 'title', users: 'full_name', applications: 'id', offers: 'id' };
const EXPORT_RELATION_TABLE = {
  client_id: 'clients', candidate_id: 'candidates', vacancy_id: 'vacancies', jd_id: 'jds',
  recruiter_id: 'users', assigned_recruiter_id: 'users', account_owner_id: 'users',
  next_action_assigned_id: 'users', assigned_to: 'users', application_id: 'applications', offer_id: 'offers'
};

function prettifyHeader(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Adds minutes to a date+time using local wall-clock arithmetic only — never
// round-trips through toISOString(), which forces UTC and previously caused
// the computed "end" time to land before "start" once the server's local
// timezone (IST) was taken into account. Both this and the original
// scheduled_date/scheduled_time stay in the same local clock representation,
// and Google is told explicitly which timeZone that is (see googleCalendar.js).
function addMinutesToLocalDateTime(dateStr, timeStr, minutesToAdd) {
  const [h, m] = timeStr.split(':').map(Number);
  const base = new Date(`${dateStr}T00:00:00`);
  base.setHours(h, m + minutesToAdd, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}T${pad(base.getHours())}:${pad(base.getMinutes())}:00`;
}

function daysBetween(a, b) {
  if (!a || !b) return '';
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

// ---- Custom reports (admin picks the columns) ----
const reports = require('./reports');
const resumeParser = require('./resumeParser');
const scorecardLink = require('./scorecardLink');
const duplicates = require('./duplicates');
app.get('/api/reports/catalogue', requireAuth, requireRole('super_admin', 'hr_manager'), (_req, res) => {
  res.json(reports.catalogue());
});
app.post('/api/reports/run', requireAuth, requireRole('super_admin', 'hr_manager'), async (req, res) => {
  try {
    res.json(await reports.runReport(dbAll, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post('/api/reports/download', requireAuth, requireRole('super_admin', 'hr_manager'), async (req, res) => {
  try {
    const { headers, rows } = await reports.runReport(dbAll, req.body || {});
    const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    sheet['!cols'] = headers.map(() => ({ wch: 22 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, 'Report');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const user = currentUser(req);
    await logAudit(user.id, user.full_name, 'report', req.body.report, null, { columns: headers, count: rows.length });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${req.body.report}-report-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Downloadable reports: one candidate (Word or print/PDF page) and a consolidated Excel ----
app.get('/api/candidates/:id/report', requireAuth, async (req, res) => {
  try {
    const d = await candidateReports.candidateData({ dbAll, dbGet }, req.params.id);
    if (!d) return res.status(404).json({ error: 'Candidate not found' });
    const user = currentUser(req);
    await logAudit(user.id, user.full_name, 'candidate_report', 'candidates', req.params.id, { format: req.query.format || 'docx' });
    const safe = String(d.c.full_name || 'candidate').replace(/[^\w .-]+/g, '').trim() || 'candidate';
    if (req.query.format === 'html') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.send(candidateReports.candidateHtml(d)); }
    const buf = await candidateReports.candidateDocx(d);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="Candidate report - ${safe}.docx"`);
    res.send(buf);
  } catch (err) { console.error('Candidate report failed:', err); res.status(500).json({ error: `Could not build the report: ${err.message}` }); }
});
app.get('/api/reports/consolidated', requireAuth, requireRole('super_admin', 'hr_manager', 'recruiter'), async (req, res) => {
  try {
    const { buffer, count } = await candidateReports.consolidatedXlsx({ dbAll }, req.query);
    const user = currentUser(req);
    await logAudit(user.id, user.full_name, 'consolidated_report', 'candidates', null, { filters: req.query, count });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Consolidated-candidate-report-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(buffer);
  } catch (err) { console.error('Consolidated report failed:', err); res.status(500).json({ error: err.message }); }
});

// ---- Interviewer scorecard links ----
const appBaseUrl = (req) => (process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

app.post('/api/interviews/:id/scorecard-link', requireAuth, async (req, res) => {
  if (!canWrite(req, res, 'interviews')) return;
  try {
    const link = await scorecardLink.ensureLink({ dbGet, dbRun }, req.params.id, { regenerate: !!(req.body && req.body.regenerate) });
    const user = currentUser(req);
    if (req.body && req.body.regenerate) await logAudit(user.id, user.full_name, 'new_scorecard_link', 'interviews', req.params.id, {});
    res.json({ url: scorecardLink.buildUrl(appBaseUrl(req), link.token), expires_at: link.expires_at });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/interviews/:id/scorecard-link/email', requireAuth, async (req, res) => {
  if (!canWrite(req, res, 'interviews')) return;
  try {
    const link = await scorecardLink.ensureLink({ dbGet, dbRun }, req.params.id);
    const url = scorecardLink.buildUrl(appBaseUrl(req), link.token);
    const { to } = await scorecardLink.sendLinkEmail({ dbGet }, req.params.id, url, link.expires_at);
    const user = currentUser(req);
    await logAudit(user.id, user.full_name, 'email_scorecard_link', 'interviews', req.params.id, { to });
    res.json({ ok: true, to });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Offer approval by the Authorized Signatory ----
app.get('/api/offers/:id/signatories', requireAuth, async (req, res) => {
  try { res.json(await offerApproval.signatoryOptions({ dbGet, dbAll }, req.params.id)); } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/offers/:id/send-for-approval', requireAuth, async (req, res) => {
  if (!canWrite(req, res, 'offers')) return;
  const user = currentUser(req);
  try {
    const before = await dbGet('SELECT * FROM offers WHERE id = ?', [req.params.id]);
    const out = await offerApproval.requestApproval({ dbGet, dbRun, dbAll }, req.params.id, { baseUrl: appBaseUrl(req), user, signatoryId: req.body && req.body.signatory_id });
    await logAudit(user.id, user.full_name, 'offer_sent_for_approval', 'offers', req.params.id, { to: out.to });
    const auto = await runAutomation('offers', { id: req.params.id, values: { status: 'Pending Approval' }, existing: before }, user);
    res.json({ ...out, _auto: auto });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
// Public (no login) signatory page, reached only through the secret token.
const noStore = (res) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); };
app.get('/offer-approval/:token', (_req, res) => { noStore(res); res.sendFile(path.join(publicDir, 'offer-approval.html')); });
app.get('/api/public/offer-approval/:token', async (req, res) => {
  noStore(res);
  const out = await offerApproval.getPublic({ dbGet, dbRun }, req.params.token);
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.json(out.data);
});
app.get('/api/public/offer-approval/:token/letter', async (req, res) => {
  noStore(res);
  try {
    const out = await offerApproval.previewLetter({ dbGet, dbRun }, req.params.token);
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${out.name.replace(/[^\w .()-]+/g, '')}"`);
    res.send(out.buffer);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/public/offer-approval/:token', async (req, res) => {
  noStore(res);
  const out = await offerApproval.decide({ dbGet, dbRun }, req.params.token, req.body || {}, { ip: req.ip, agent: req.get('user-agent') });
  if (out.error) return res.status(out.status).json({ error: out.error });
  try {
    await logAudit(null, `Authorized signatory (${(req.body && req.body.name) || 'link'})`, out.decision === 'approve' ? 'offer_approved' : 'offer_changes_requested', 'offers', out.id, { ip: req.ip });
    await runAutomation('offers', { id: out.id, values: { status: out.decision === 'approve' ? 'Approved' : 'Changes Requested' }, existing: { status: 'Pending Approval' } }, { id: null, full_name: 'Authorized signatory' });
  } catch { /* bookkeeping is best effort */ }
  res.json({ ok: true, decision: out.decision, letter: out.letter ? { sent: out.letter.sent } : undefined });
});

// Public (no login): the interviewer's own page and its data, reached only through the secret token.
app.get('/scorecard/:token', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.sendFile(path.join(publicDir, 'scorecard.html'));
});
app.get('/api/public/scorecard/:token', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const out = await scorecardLink.getPublicView({ dbGet, dbRun, dbAll }, req.params.token);
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.json(out.data);
});
app.get('/api/public/scorecard/:token/resume', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const out = await scorecardLink.getResumeFile({ dbGet }, req.params.token);
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.download(out.path, out.name);
});
app.post('/api/public/scorecard/:token', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const out = await scorecardLink.submitPublic({ dbGet, dbRun, dbAll }, req.params.token, req.body || {});
  if (out.error) return res.status(out.status).json({ error: out.error });
  reminders.run({ dbAll, dbGet, dbRun }, { tasksOnly: true }).catch(() => {}); // a Proceed/Reject recommendation creates the "decide next step" task right away
  try { await logAudit(null, `Interviewer (${out.interviewer || 'scorecard link'})`, 'scorecard_submitted', 'interviews', out.interviewId, { rating: out.rating }); } catch { /* audit is best effort */ }
  try { await stageAutomation.afterWrite('interviews', { id: out.interviewId, values: {}, existing: null }, { id: null, full_name: `Interviewer (${out.interviewer || 'scorecard link'})` }); } catch { /* the scorecard is already saved */ }
  res.json({ ok: true, rating: out.rating });
});

// ---- Master lists (admin-managed pick-lists) ----
const masterLists = require('./masterLists');
const adminOnly = requireRole('super_admin', 'hr_manager');
const listUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
const sheetOk = (f) => /\.(xlsx|xls|csv)$/i.test((f && f.originalname) || '');
const mlErr = (res, err) => res.status(err.status || 400).json({ error: err.message });
app.get('/api/lists', requireAuth, async (_req, res) => res.json(await masterLists.forForms({ dbAll })));
app.post('/api/interviewers/import', requireAuth, adminOnly, listUpload.single('file'), async (req, res) => {
  try {
    if (!req.file || !sheetOk(req.file)) return res.status(400).json({ error: 'Choose an Excel (.xlsx) or CSV file.' });
    const out = await masterLists.importInterviewers({ dbGet, dbRun }, req.file.buffer);
    const user = currentUser(req); await logAudit(user.id, user.full_name, 'import', 'interviewers', null, out);
    res.json(out);
  } catch (err) { mlErr(res, err); }
});
app.get('/api/master-lists/:key', requireAuth, adminOnly, async (req, res) => { try { res.json(await masterLists.list({ dbAll, dbGet }, req.params.key)); } catch (err) { mlErr(res, err); } });
app.post('/api/master-lists/:key/import', requireAuth, adminOnly, listUpload.single('file'), async (req, res) => {
  try {
    if (!req.file || !sheetOk(req.file)) return res.status(400).json({ error: 'Choose an Excel (.xlsx) or CSV file.' });
    const out = await masterLists.importSheet({ dbAll, dbGet, dbRun }, req.params.key, req.file.buffer);
    const user = currentUser(req); await logAudit(user.id, user.full_name, 'import', 'master_lists', req.params.key, out);
    res.json(out);
  } catch (err) { mlErr(res, err); }
});
app.post('/api/master-lists/:key', requireAuth, adminOnly, async (req, res) => {
  try {
    const id = await masterLists.add({ dbGet, dbRun }, req.params.key, req.body || {});
    const user = currentUser(req); await logAudit(user.id, user.full_name, 'create', 'master_lists', id, { list: req.params.key, name: req.body && req.body.name });
    res.status(201).json({ id });
  } catch (err) { mlErr(res, err); }
});
app.put('/api/master-lists/:key/:id', requireAuth, adminOnly, async (req, res) => {
  try {
    await masterLists.update({ dbGet, dbRun }, req.params.key, req.params.id, req.body || {});
    const user = currentUser(req); await logAudit(user.id, user.full_name, 'update', 'master_lists', req.params.id, { list: req.params.key, ...(req.body || {}) });
    res.json({ ok: true });
  } catch (err) { mlErr(res, err); }
});
app.delete('/api/master-lists/:key/:id', requireAuth, adminOnly, async (req, res) => {
  try {
    await masterLists.remove({ dbRun }, req.params.key, req.params.id);
    const user = currentUser(req); await logAudit(user.id, user.full_name, 'delete', 'master_lists', req.params.id, { list: req.params.key });
    res.json({ ok: true });
  } catch (err) { mlErr(res, err); }
});

// ---- Onboarding form (replaces the Google form) + HRMS hand-over ----
const onboarding = require('./onboarding');
const archiver = require('archiver');
const onboardDocUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
const hrOnly = requireRole('super_admin', 'hr_manager', 'recruiter');
const publicHeaders = (res) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); };

// Public (no login): the candidate's own form, reached only through the private link.
app.get('/onboarding/:token', (_req, res) => { publicHeaders(res); res.sendFile(path.join(publicDir, 'onboarding.html')); });
app.get('/api/public/onboarding/:token', async (req, res) => {
  publicHeaders(res);
  const out = await onboarding.getPublic({ dbGet, dbRun, dbAll }, req.params.token);
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.json(out.data);
});
async function onboardingSave(req, res, submit) {
  publicHeaders(res);
  const out = await onboarding.save({ dbGet, dbRun, dbAll }, req.params.token, req.body || {}, { submit });
  if (out.error) return res.status(out.status).json({ error: out.error, errors: out.errors });
  if (submit) {
    try { await logAudit(null, 'Candidate (onboarding form)', 'onboarding_submitted', 'onboarding', out.id, {}); } catch { /* best effort */ }
    // tell the recruiter, and hand over to the HRMS if the candidate has already joined
    (async () => {
      try {
        const c = await dbGet('SELECT c.full_name, v.title, u.email FROM onboarding o LEFT JOIN candidates c ON c.id = o.candidate_id LEFT JOIN vacancies v ON v.id = o.vacancy_id LEFT JOIN users u ON u.id = v.assigned_recruiter_id WHERE o.id = ?', [out.id]);
        if (c && c.email && process.env.SMTP_USER && process.env.SMTP_PASS) {
          await sendMail({ to: c.email, subject: `Onboarding form submitted — ${c.full_name || 'candidate'}`, html: `<p><strong>${escapeHtmlSrv(c.full_name || 'The candidate')}</strong> has submitted the onboarding form${c.title ? ' for ' + escapeHtmlSrv(c.title) : ''}, with documents.</p><p>Open <strong>Onboarding</strong> in RDC’s Recruitment Management System to review and verify it.</p>` });
        }
      } catch (e) { console.warn('⚠️  Could not email onboarding notification:', e.message); }
      await onboarding.maybeAutoPush({ dbGet, dbRun, dbAll, logAudit }, out.candidateId, null);
    })();
  }
  res.json({ ok: true });
}
const escapeHtmlSrv = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
app.put('/api/public/onboarding/:token', (req, res) => onboardingSave(req, res, false));
app.post('/api/public/onboarding/:token/submit', (req, res) => onboardingSave(req, res, true));
app.post('/api/public/onboarding/:token/docs/:type', onboardDocUpload.single('file'), async (req, res) => {
  publicHeaders(res);
  const out = await onboarding.addDoc({ dbGet, dbRun, dbAll }, req.params.token, req.params.type, req.file);
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.json({ docs: out.docs });
});
app.delete('/api/public/onboarding/:token/docs/:docId', async (req, res) => {
  publicHeaders(res);
  const out = await onboarding.removeDoc({ dbGet, dbRun, dbAll }, req.params.token, req.params.docId);
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.json({ docs: out.docs });
});

// HR side
app.get('/api/onboarding', requireAuth, hrOnly, async (req, res) => res.json(await onboarding.list({ dbAll }, { status: req.query.status, q: req.query.q })));
app.get('/api/onboarding/hrms-config', requireAuth, requireRole('super_admin', 'hr_manager'), async (_req, res) => res.json(await onboarding.getPublicConfig({ dbGet })));
app.put('/api/onboarding/hrms-config', requireAuth, requireRole('super_admin'), async (req, res) => {
  try {
    const user = currentUser(req);
    const out = await onboarding.saveConfig({ dbGet, dbRun }, req.body || {});
    await logAudit(user.id, user.full_name, 'update_hrms_config', 'settings', 'hrms_config', { enabled: out.enabled, auto_push: out.auto_push });
    res.json(out);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
// create (or fetch) the onboarding record for a candidate and optionally email the link
app.post('/api/onboarding/invite', requireAuth, hrOnly, async (req, res) => {
  try {
    const { candidate_id, vacancy_id, offer_id, send } = req.body || {};
    if (!candidate_id) return res.status(400).json({ error: 'Choose a candidate.' });
    const link = await onboarding.ensureLink({ dbGet, dbRun }, candidate_id, vacancy_id || null, offer_id || null);
    const url = onboarding.buildUrl(appBaseUrl(req), link.token);
    let sentTo = null;
    if (send) sentTo = (await onboarding.sendLinkEmail({ dbGet, dbRun }, link.id, appBaseUrl(req))).to;
    const user = currentUser(req);
    await logAudit(user.id, user.full_name, send ? 'send_onboarding_link' : 'create_onboarding_link', 'onboarding', link.id, { to: sentTo });
    res.json({ id: link.id, url, expires_at: link.expires_at, sent_to: sentTo });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.get('/api/onboarding-invitees', requireAuth, hrOnly, async (_req, res) => {
  // people who have an offer in progress or a joining record, with no onboarding form created yet
  res.json(await dbAll(`
    SELECT x.candidate_id, x.vacancy_id, x.offer_id, c.full_name AS candidate, c.email, v.title AS vacancy, v.company, x.src FROM (
      SELECT candidate_id, vacancy_id, offer_id, 'Joining' AS src FROM joining WHERE is_deleted = 0 AND status IN ('Expected','Confirmed','Joined')
      UNION
      SELECT candidate_id, vacancy_id, id AS offer_id, 'Offer' AS src FROM offers WHERE is_deleted = 0 AND status IN ('Approved','Sent','Accepted')
    ) x
    JOIN candidates c ON c.id = x.candidate_id LEFT JOIN vacancies v ON v.id = x.vacancy_id
    WHERE NOT EXISTS (SELECT 1 FROM onboarding o WHERE o.candidate_id = x.candidate_id AND COALESCE(o.vacancy_id,'') = COALESCE(x.vacancy_id,'') AND o.is_deleted = 0)
    GROUP BY x.candidate_id, x.vacancy_id ORDER BY c.full_name`));
});
app.get('/api/onboarding/by-candidate/:candidateId', requireAuth, hrOnly, async (req, res) => {
  const row = await dbGet("SELECT id FROM onboarding WHERE candidate_id = ? AND COALESCE(vacancy_id,'') = COALESCE(?, '') AND is_deleted = 0 ORDER BY created_at DESC LIMIT 1", [req.params.candidateId, req.query.vacancy_id || null]);
  res.json(row ? await onboarding.detail({ dbGet, dbAll }, row.id) : null);
});
app.get('/api/onboarding/:id', requireAuth, hrOnly, async (req, res) => {
  const d = await onboarding.detail({ dbGet, dbAll }, req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json(d);
});
app.get('/api/onboarding/:id/docs/:docId', requireAuth, hrOnly, async (req, res) => {
  const d = await onboarding.docFile({ dbGet }, req.params.id, req.params.docId);
  if (!d) return res.status(404).json({ error: 'File not found' });
  res.download(d.file_path, d.file_name);
});
app.post('/api/onboarding/:id/link', requireAuth, hrOnly, async (req, res) => {
  try {
    const row = await dbGet('SELECT * FROM onboarding WHERE id = ? AND is_deleted = 0', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const link = await onboarding.ensureLink({ dbGet, dbRun }, row.candidate_id, row.vacancy_id, row.offer_id, { regenerate: !!(req.body && req.body.regenerate) });
    let sentTo = null;
    if (req.body && req.body.send) sentTo = (await onboarding.sendLinkEmail({ dbGet, dbRun }, row.id, appBaseUrl(req))).to;
    const user = currentUser(req);
    await logAudit(user.id, user.full_name, req.body && req.body.send ? 'send_onboarding_link' : 'onboarding_link', 'onboarding', row.id, { to: sentTo });
    res.json({ url: onboarding.buildUrl(appBaseUrl(req), link.token), expires_at: link.expires_at, sent_to: sentTo });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/onboarding/:id/verify', requireAuth, hrOnly, async (req, res) => {
  try {
    const user = currentUser(req);
    await onboarding.setVerified({ dbGet, dbRun }, req.params.id, user);
    await logAudit(user.id, user.full_name, 'onboarding_verified', 'onboarding', req.params.id, {});
    const row = await dbGet('SELECT candidate_id, vacancy_id FROM onboarding WHERE id = ?', [req.params.id]);
    const auto = await onboarding.maybeAutoPush({ dbGet, dbRun, dbAll, logAudit }, row.candidate_id, user, row.vacancy_id);
    res.json({ ok: true, hrms: auto });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/onboarding/:id/reopen', requireAuth, hrOnly, async (req, res) => {
  try { await onboarding.reopen({ dbGet, dbRun }, req.params.id); const user = currentUser(req); await logAudit(user.id, user.full_name, 'onboarding_reopened', 'onboarding', req.params.id, {}); res.json({ ok: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/onboarding/:id/push-hrms', requireAuth, hrOnly, async (req, res) => {
  try {
    const row = await dbGet('SELECT status, hrms_status FROM onboarding WHERE id = ? AND is_deleted = 0', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.hrms_status === 'Sent') return res.status(400).json({ error: 'Already sent to the HRMS — sending again could create a duplicate employee there.' });
    if (!['Submitted', 'Verified'].includes(row.status)) return res.status(400).json({ error: 'The candidate has not submitted the form yet.' });
    const cfg = await onboarding.getConfig({ dbGet });
    if (!cfg.enabled) return res.status(400).json({ error: 'The HRMS hand-over is switched off — turn it on in Settings → HRMS hand-over first.' });
    const out = await onboarding.push({ dbGet, dbRun, dbAll, logAudit }, req.params.id, currentUser(req));
    res.json(out);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.get('/api/onboarding/:id/package', requireAuth, hrOnly, async (req, res) => {
  try {
    const row = await dbGet('SELECT o.id, c.full_name FROM onboarding o LEFT JOIN candidates c ON c.id = o.candidate_id WHERE o.id = ? AND o.is_deleted = 0', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const user = currentUser(req);
    await logAudit(user.id, user.full_name, 'onboarding_package', 'onboarding', row.id, {});
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="Onboarding - ${String(row.full_name || 'candidate').replace(/[^\w ]+/g, '').trim()}.zip"`);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (e) => { console.error('ZIP failed:', e.message); res.destroy(e); });
    archive.pipe(res);
    await onboarding.buildPackage({ dbGet, dbAll }, row.id, archive);
    await archive.finalize();
  } catch (err) { if (!res.headersSent) res.status(400).json({ error: err.message }); }
});

// ---- Resume parsing + duplicate detection (registered before the generic /:id routes) ----
const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });


// Interviews, offers, joining and assessments belong to one candidate's application. The forms only ask for
// candidate + vacancy, so the application is looked up here — and if an application is given instead,
// the candidate and vacancy are filled from it. Nobody has to type the same details twice.
const APPLICATION_LINKED = ['interviews', 'offers', 'joining', 'assessments'];
async function linkToApplication(values, table) {
  try {
    if (values.application_id && (!values.candidate_id || !values.vacancy_id)) {
      const a = await dbGet('SELECT candidate_id, vacancy_id FROM applications WHERE id = ? AND is_deleted = 0', [values.application_id]);
      if (a) { values.candidate_id = values.candidate_id || a.candidate_id; values.vacancy_id = values.vacancy_id || a.vacancy_id; }
    } else if (!values.application_id && values.candidate_id && values.vacancy_id) {
      const a = await dbGet('SELECT id FROM applications WHERE candidate_id = ? AND vacancy_id = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT 1', [values.candidate_id, values.vacancy_id]);
      if (a) values.application_id = a.id;
    }
    if (values.application_id && !values.offer_id && values.candidate_id && values.vacancy_id) {
      // a joining record points at the offer it came from
      const o = await dbGet("SELECT id FROM offers WHERE candidate_id = ? AND vacancy_id = ? AND is_deleted = 0 AND status NOT IN ('Declined','Withdrawn') ORDER BY created_at DESC LIMIT 1", [values.candidate_id, values.vacancy_id]);
      if (o && table === 'joining') values.offer_id = o.id;
    }
  } catch { /* linking is a convenience; never block saving */ }
}

// Follows a save with the automatic consequences (stage moves, joining record...), then refreshes the
// follow-up task list in the background so "decide next step" tasks appear straight away.
async function runAutomation(table, ctx, user) {
  const notes = await stageAutomation.afterWrite(table, ctx, user);
  if (['interviews', 'offers', 'joining', 'vacancies'].includes(table)) {
    reminders.run({ dbAll, dbGet, dbRun }, { tasksOnly: true }).catch(() => {});
  }
  return notes;
}

// Everything the create forms need to pre-fill themselves once a candidate is chosen.
app.get('/api/candidates/:id/autofill', requireAuth, async (req, res) => {
  const c = await dbGet('SELECT id, full_name, expected_ctc, notice_period, current_location FROM candidates WHERE id = ? AND is_deleted = 0', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Candidate not found' });
  const applications = await dbAll(`
    SELECT a.id, a.vacancy_id, a.status, v.title AS vacancy_title, v.vacancy_code, v.location AS vacancy_location
    FROM applications a JOIN vacancies v ON v.id = a.vacancy_id
    WHERE a.candidate_id = ? AND a.is_deleted = 0 AND a.status NOT IN ('Rejected','Withdrawn')
    ORDER BY a.created_at DESC`, [c.id]);
  const interviews = await dbAll(`SELECT vacancy_id, round, interviewer, interviewer_email, type FROM interviews
    WHERE candidate_id = ? AND is_deleted = 0 AND status != 'Cancelled' ORDER BY created_at DESC LIMIT 20`, [c.id]);
  const offers = await dbAll(`SELECT id, vacancy_id, offered_ctc, expected_joining, status FROM offers
    WHERE candidate_id = ? AND is_deleted = 0 AND status NOT IN ('Declined','Withdrawn') ORDER BY created_at DESC LIMIT 5`, [c.id]);
  const assessments = await dbAll(`SELECT vacancy_id, assessment_type FROM assessments
    WHERE candidate_id = ? AND is_deleted = 0 AND status != 'Not Required'`, [c.id]);
  res.json({ candidate: c, applications, interviews, offers, assessments });
});

// Candidates who currently have an open application, most recent first — offered as one-click
// suggestions in the Interview / Assessment / Offer / Joining forms so nobody has to type a name.
app.get('/api/candidates/in-pipeline', requireAuth, async (_req, res) => {
  const rows = await dbAll(`
    SELECT c.id, c.full_name, c.candidate_code, MAX(a.created_at) AS last_activity
    FROM candidates c JOIN applications a ON a.candidate_id = c.id
    WHERE c.is_deleted = 0 AND a.is_deleted = 0 AND a.status NOT IN ('Rejected','Withdrawn','Joined')
    GROUP BY c.id ORDER BY last_activity DESC LIMIT 10`);
  res.json({ data: rows });
});

// Interviewers used before (name + email), so the second time is a pick, not a re-type.
app.get('/api/interviewer-suggestions', requireAuth, async (_req, res) => {
  // The interviewer directory, plus anyone typed on a past interview. Emails typed on past
  // interviews are remembered, so each person's email only has to be entered once.
  const used = await dbAll(`
    SELECT interviewer AS name, MAX(interviewer_email) AS email, MAX(created_at) AS last_used
    FROM interviews WHERE is_deleted = 0 AND interviewer IS NOT NULL AND TRIM(interviewer) != ''
    GROUP BY LOWER(TRIM(interviewer))`);
  const usedBy = new Map(used.map((u) => [u.name.trim().toLowerCase(), u]));
  const dir = await dbAll('SELECT name, designation, city, location, email FROM interviewers WHERE is_deleted = 0 AND is_active = 1 ORDER BY name');
  const seen = new Set();
  const data = dir.map((d) => {
    const u = usedBy.get(d.name.trim().toLowerCase()); seen.add(d.name.trim().toLowerCase());
    return { name: d.name, email: d.email || (u && u.email) || '', designation: d.designation, city: d.city, location: d.location, last_used: u ? u.last_used : null };
  });
  for (const u of used) if (!seen.has(u.name.trim().toLowerCase())) data.push(u);
  data.sort((a, b) => (b.last_used || '').localeCompare(a.last_used || '') || a.name.localeCompare(b.name));
  res.json({ data });
});

app.get('/api/candidates/check-duplicate', requireAuth, async (req, res) => {
  const matches = await duplicates.findDuplicates(dbAll, {
    email: req.query.email, mobile: req.query.mobile, excludeId: req.query.exclude || null
  });
  res.json({ duplicates: matches });
});

app.post('/api/candidates/parse-resume', requireAuth, memoryUpload.single('resume'), async (req, res) => {
  if (!canWrite(req, res, 'candidates')) return;
  if (!req.file) return res.status(400).json({ error: 'Choose a resume file first.' });
  try {
    const text = await resumeParser.extractText(req.file.buffer, req.file.originalname);
    if (!text.trim()) {
      return res.status(422).json({ error: 'This looks like a scanned or photographed resume — it has no readable text, so nothing could be filled in. Save the file with the candidate anyway and type the details, or use a Word / text-based PDF version.' });
    }
    const fields = resumeParser.parseResumeText(text);
    const matches = await duplicates.findDuplicates(dbAll, { email: fields.email, mobile: fields.mobile });
    res.json({ fields, duplicates: matches });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// Scorecards for review: interviews with their scores, optionally for one vacancy.
app.get('/api/scorecards', requireAuth, async (req, res) => {
  const params = [];
  let where = "i.is_deleted = 0 AND i.status != 'Cancelled'";
  if (req.query.vacancy_id) { where += ' AND i.vacancy_id = ?'; params.push(req.query.vacancy_id); }
  const rows = await dbAll(`
    SELECT i.id, i.candidate_id, i.vacancy_id, i.round, i.interviewer, i.status, i.scheduled_date,
           i.scorecard, i.rating, i.recommendation, i.hire_type, i.feedback,
           c.full_name AS candidate, c.candidate_code, v.title AS vacancy, v.company, j.title AS jd_title
    FROM interviews i
    LEFT JOIN candidates c ON c.id = i.candidate_id
    LEFT JOIN vacancies v ON v.id = i.vacancy_id
    LEFT JOIN jds j ON j.id = v.jd_id
    WHERE ${where}
    ORDER BY c.full_name, i.round`, params);
  // Attach each candidate's assessment results (latest of each type that applies to this vacancy).
  const cids = [...new Set(rows.map((r) => r.candidate_id).filter(Boolean))];
  const assessments = cids.length ? await dbAll(
    `SELECT candidate_id, vacancy_id, assessment_type, status, score, result_summary, report_link, assessment_date
     FROM assessments WHERE is_deleted = 0 AND candidate_id IN (${cids.map(() => '?').join(',')})
     ORDER BY created_at DESC`, cids) : [];
  const assessmentsFor = (candidateId, vacancyId) => {
    const seen = new Set();
    return assessments.filter((a) => a.candidate_id === candidateId && (!a.vacancy_id || a.vacancy_id === vacancyId))
      .filter((a) => (seen.has(a.assessment_type) ? false : seen.add(a.assessment_type)));
  };
  res.json(rows.map((r) => ({
    ...r,
    scorecard: parseJsonFields({ scorecard: r.scorecard }, ['scorecard']).scorecard,
    is_sales: scorecardCriteria.isSalesRole(r.vacancy, r.jd_title),
    assessments: assessmentsFor(r.candidate_id, r.vacancy_id)
  })));
});

app.get('/api/:table/export', requireAuth, async (req, res) => {
  const table = req.params.table;
  const config = tableConfig[table];
  if (!config) return res.status(404).json({ error: 'Unknown table' });

  const clauses = config.softDelete ? ['is_deleted = 0'] : [];
  const params = [];
  const q = String(req.query.q || '').trim();
  if (q && config.searchFields) {
    clauses.push(`(${config.searchFields.map((f) => `${f} LIKE ?`).join(' OR ')})`);
    config.searchFields.forEach(() => params.push(`%${q}%`));
  }
  for (const field of config.filterFields || []) {
    if (req.query[field]) addFilter(clauses, params, field, req.query[field]);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await dbAll(`SELECT * FROM ${table} ${where} ORDER BY ${config.orderBy}`, params);

  // Resolve any foreign-key columns (candidate_id, vacancy_id, ...) to a human label
  // via one batched lookup query per relation field, instead of one query per row.
  const relationLookups = {};
  for (const field of config.fields || []) {
    const relatedTable = EXPORT_RELATION_TABLE[field];
    if (!relatedTable || !tableConfig[relatedTable]) continue;
    const ids = [...new Set(rows.map((r) => r[field]).filter(Boolean))];
    if (!ids.length) continue;
    const labelCol = EXPORT_LABEL_FIELDS[relatedTable] || 'id';
    const placeholders = ids.map(() => '?').join(',');
    const related = await dbAll(`SELECT id, ${labelCol} FROM ${relatedTable} WHERE id IN (${placeholders})`, ids);
    relationLookups[field] = new Map(related.map((r) => [r.id, r[labelCol]]));
  }

  const data = rows.map((r) => {
    const out = {};
    for (const field of config.fields || []) {
      let value = r[field];
      if ((config.jsonFields || []).includes(field)) {
        value = safeParseArray(value).join(', ');
      } else if (relationLookups[field]) {
        value = relationLookups[field].get(value) || '';
      }
      out[prettifyHeader(field)] = value === null || value === undefined ? '' : value;
    }
    if ('created_at' in r) out['Created'] = r.created_at;
    if ('closed_at' in r) out['Closed'] = r.closed_at || '';
    if (table === 'vacancies') {
      const tatStart = r.date_received || r.created_at;
      out['TAT (days)'] = r.closed_at ? daysBetween(tatStart, r.closed_at)
        : (r.status === 'Open' || r.status === 'On Hold') ? daysBetween(tatStart, new Date().toISOString()) : '';
    }
    if ('updated_at' in r) out['Last Updated'] = r.updated_at;
    return out;
  });

  const worksheet = XLSX.utils.json_to_sheet(data);
  worksheet['!cols'] = Object.keys(data[0] || {}).map(() => ({ wch: 20 }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, config.title || prettifyHeader(table));
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  const user = currentUser(req);
  await logAudit(user.id, user.full_name, 'export', table, null, { count: rows.length });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${table}-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.send(buffer);
});

// ---- Manually made offer / appointment letters: upload, download, remove, send ----
const OFFER_LETTER_DIR = path.join(path.dirname(UPLOADS_DIR), 'offer-letters');
if (!fs.existsSync(OFFER_LETTER_DIR)) fs.mkdirSync(OFFER_LETTER_DIR, { recursive: true });
const LETTER_TYPES = { '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
const letterUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.post('/api/offers/:id/manual-letter', requireAuth, letterUpload.single('letter'), async (req, res) => {
  if (!canWrite(req, res, 'offers')) return;
  const offer = await dbGet('SELECT id, manual_letter_path FROM offers WHERE id = ? AND is_deleted = 0', [req.params.id]);
  if (!offer) return res.status(404).json({ error: 'Offer not found' });
  if (!req.file) return res.status(400).json({ error: 'Choose a file to upload.' });
  const ext = path.extname(req.file.originalname).toLowerCase();
  if (!LETTER_TYPES[ext]) return res.status(400).json({ error: 'Upload a PDF, Word (.doc/.docx) or image (.jpg/.png) file.' });
  const stored = path.join(OFFER_LETTER_DIR, `${offer.id}-${Date.now()}${ext}`);
  fs.writeFileSync(stored, req.file.buffer);
  if (offer.manual_letter_path && fs.existsSync(offer.manual_letter_path)) { try { fs.unlinkSync(offer.manual_letter_path); } catch { /* old file stays */ } }
  const name = req.file.originalname.replace(/[\r\n"]/g, '_').slice(0, 150);
  await dbRun("UPDATE offers SET manual_letter_name = ?, manual_letter_path = ?, manual_letter_mime = ?, manual_letter_uploaded_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [name, stored, LETTER_TYPES[ext], offer.id]);
  const user = currentUser(req);
  await logAudit(user.id, user.full_name, 'upload_manual_letter', 'offers', offer.id, { file: name });
  res.json({ ok: true, name });
});

app.get('/api/offers/:id/manual-letter', requireAuth, async (req, res) => {
  const offer = await dbGet('SELECT manual_letter_name, manual_letter_path FROM offers WHERE id = ? AND is_deleted = 0', [req.params.id]);
  if (!offer || !offer.manual_letter_path || !fs.existsSync(offer.manual_letter_path)) return res.status(404).json({ error: 'No uploaded letter.' });
  res.download(offer.manual_letter_path, offer.manual_letter_name || 'Appointment Letter');
});

app.delete('/api/offers/:id/manual-letter', requireAuth, async (req, res) => {
  if (!canWrite(req, res, 'offers')) return;
  const offer = await dbGet('SELECT id, manual_letter_path FROM offers WHERE id = ? AND is_deleted = 0', [req.params.id]);
  if (!offer) return res.status(404).json({ error: 'Offer not found' });
  if (offer.manual_letter_path && fs.existsSync(offer.manual_letter_path)) { try { fs.unlinkSync(offer.manual_letter_path); } catch { /* ignore */ } }
  await dbRun("UPDATE offers SET manual_letter_name = NULL, manual_letter_path = NULL, manual_letter_mime = NULL, manual_letter_uploaded_at = NULL, updated_at = datetime('now') WHERE id = ?", [offer.id]);
  const user = currentUser(req);
  await logAudit(user.id, user.full_name, 'remove_manual_letter', 'offers', offer.id, {});
  res.json({ ok: true });
});

app.post('/api/offers/:id/send-manual-letter', requireAuth, async (req, res) => {
  if (!canWrite(req, res, 'offers')) return;
  try {
    const { recipients } = await sendManualLetterEmail({ dbGet, dbRun }, req.params.id);
    const user = currentUser(req);
    await logAudit(user.id, user.full_name, 'send_manual_letter', 'offers', req.params.id, { recipients });
    res.json({ ok: true, recipients });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/offers/:id/resend-appointment-letter', requireAuth, async (req, res) => {
  if (!canWrite(req, res, 'offers')) return;
  try {
    const { recipients } = await sendAppointmentLetterEmail({ dbGet, dbRun }, req.params.id);
    const user = currentUser(req);
    await logAudit(user.id, user.full_name, 'send_appointment_letter', 'offers', req.params.id, { recipients });
    res.json({ ok: true, recipients });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/offers/:id/appointment-letter', requireAuth, async (req, res) => {
  const offer = await dbGet('SELECT * FROM offers WHERE id = ?', [req.params.id]);
  if (!offer) return res.status(404).json({ error: 'Offer not found' });
  const [candidate, vacancy] = await Promise.all([
    dbGet('SELECT * FROM candidates WHERE id = ?', [offer.candidate_id]),
    dbGet('SELECT * FROM vacancies WHERE id = ?', [offer.vacancy_id])
  ]);
  if (!candidate) return res.status(400).json({ error: 'This offer has no linked candidate' });
  if (!vacancy) return res.status(400).json({ error: 'This offer has no linked vacancy' });
  if (!vacancy.company) return res.status(400).json({ error: 'This vacancy has no Company set — set it on the vacancy first' });

  const company = await dbGet('SELECT * FROM clients WHERE company_name = ?', [vacancy.company]);
  if (!company) return res.status(400).json({ error: `No company record found for "${vacancy.company}" — check the Companies screen` });

  try {
    const buffer = await buildAppointmentLetterDocx({ candidate, vacancy, offer, company });
    const user = currentUser(req);
    await logAudit(user.id, user.full_name, 'generate_letter', 'offers', offer.id, { candidate: candidate.full_name });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="Appointment Letter - ${candidate.full_name}.docx"`);
    res.send(buffer);
  } catch (err) {
    console.error('Letter generation failed:', err);
    res.status(500).json({ error: `Could not generate the letter: ${err.message}` });
  }
});


// Keeps interview scorecards tidy: scores are whole numbers 1-5, and the overall
// rating is always the average of the criteria that were scored.
function normalizeScorecard(values) {
  if (values.scorecard === undefined) return;
  let card = values.scorecard;
  if (typeof card === 'string') { try { card = JSON.parse(card); } catch { card = {}; } }
  card = card && typeof card === 'object' ? card : {};
  const scores = {};
  for (const [k, v] of Object.entries(card.scores || {})) {
    const n = Math.round(Number(v));
    if (n >= 1 && n <= 5 && scorecardCriteria.KEYS.includes(k)) scores[k] = n;
  }
  const out = { scores, strengths: String(card.strengths || ''), concerns: String(card.concerns || '') };
  values.scorecard = JSON.stringify(out);
  const avgScore = scorecardCriteria.average(scores);
  if (avgScore !== null) values.rating = avgScore;
}

async function rejectIfDuplicateCandidate(res, values, excludeId, existing) {
  const emailChanged = existing ? duplicates.normalizeEmail(values.email) !== duplicates.normalizeEmail(existing.email) : true;
  const mobileChanged = existing ? String(values.mobile || '') !== String(existing.mobile || '') : true;
  const email = (!existing || emailChanged) ? values.email : null;
  const mobile = (!existing || mobileChanged) ? values.mobile : null;
  if (!email && !mobile) return false;
  const matches = await duplicates.findDuplicates(dbAll, { email, mobile, excludeId });
  if (!matches.length) return false;
  res.status(409).json({
    error: `Duplicate candidate: ${duplicates.describe(matches[0])}. Open the existing record instead of adding another.`,
    duplicates: matches
  });
  return true;
}

for (const [table, config] of Object.entries(tableConfig)) {
  app.get(`/api/${table}`, requireAuth, async (req, res) => {
    const includeDeleted = req.query.includeDeleted === 'true';
    const clauses = [];
    const params = [];

    if (config.softDelete && !includeDeleted) clauses.push('is_deleted = 0');

    const q = String(req.query.q || '').trim();
    if (q && config.searchFields && config.searchFields.length) {
      clauses.push(`(${config.searchFields.map((f) => `${f} LIKE ?`).join(' OR ')})`);
      config.searchFields.forEach(() => params.push(`%${q}%`));
    }

    for (const field of config.filterFields || []) {
      if (req.query[field] !== undefined && req.query[field] !== '') addFilter(clauses, params, field, req.query[field]);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const countRow = await dbGet(`SELECT COUNT(*) AS total FROM ${table} ${where}`, params);

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    const offset = (page - 1) * pageSize;

    const rows = await dbAll(
      `SELECT * FROM ${table} ${where} ORDER BY ${config.orderBy} LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    try { await decorateStage(table, rows); } catch (e) { console.warn('⚠️  Stage not added to the list:', e.message); }
    res.json({ data: parseRows(rows, config.jsonFields).map((r) => stripSecrets(table, r)), total: countRow.total, page, pageSize });
  });

  app.get(`/api/${table}/:id`, requireAuth, async (req, res) => {
    const deletedFilter = config.softDelete ? ' AND is_deleted = 0' : '';
    const row = await dbGet(`SELECT * FROM ${table} WHERE id = ?${deletedFilter}`, [req.params.id]);
    if (!row) return res.status(404).json({ error: `${table} record not found` });
    const extra = table === 'interviews' ? await panel.forForm({ dbAll, dbGet }, row) : {};
    res.json({ ...stripSecrets(table, parseJsonFields(row, config.jsonFields)), ...extra });
  });

  app.post(`/api/${table}`, requireAuth, async (req, res) => {
    if (!canWrite(req, res, table)) return;
    const user = currentUser(req);
    const id = uuidv4();
    const values = serializeJsonFields(filterInput(req.body, config.fields), config.jsonFields);
    values.id = id;
    if (APPLICATION_LINKED.includes(table)) await linkToApplication(values, table);
    if (table === 'applications' && !values.recruiter_id) values.recruiter_id = await recruiterForVacancy(values.vacancy_id, user);
    if (table === 'vacancies' && !values.assigned_recruiter_id && user.role === 'recruiter') values.assigned_recruiter_id = user.id;

    const errors = validateInput(table, config, values, true);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    if (table === 'offers' && offerApprovalBlocked(req, values, null)) return res.status(400).json({ error: 'An offer is approved by the Authorized Signatory. Use "Send for approval" on the offer — it is marked Approved once they sign.' });

    if (table === 'candidates' && await rejectIfDuplicateCandidate(res, values, null, null)) return;
    if (table === 'interviews') normalizeScorecard(values);
    if (table === 'interviews' && req.body.panel !== undefined) { try { panel.parsePanel(req.body.panel); } catch (e) { return res.status(400).json({ error: e.message }); } }

    if (config.createdBy) values.created_by = user.id;
    if (table === 'users' && req.body.password) {
      values.password_hash = await bcrypt.hash(req.body.password, 10);
    }
    if (table === 'users' && !values.password_hash) {
      return res.status(400).json({ error: 'Password is required when creating a user' });
    }

    // Code fields (VAC-00001, CAN-00001, ...) are generated from the current max,
    // so retry a few times on a rare concurrent-insert collision instead of failing outright.
    let attempts = config.code ? 5 : 1;
    let lastErr;
    while (attempts-- > 0) {
      if (config.code && !req.body[config.code[1]]) {
        values[config.code[1]] = await nextCode(config.code[0], table, config.code[1]);
      }
      try {
        const { sql, params } = createInsert(table, values);
        await dbRun(sql, params);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (!config.code || !/UNIQUE constraint failed/i.test(err.message)) throw err;
      }
    }
    if (lastErr) throw lastErr;

    await logActivity(table, id, 'Created', null, null, user.id, user.full_name);
    await logAudit(user.id, user.full_name, 'create', table, id, values);
    // a new panel interview: create the members first (quietly) so the candidate's invite can list the whole panel
    if (table === 'interviews' && req.body.panel !== undefined) await applyPanel(id, req.body.panel, user, true);
    if (config.onWrite) await config.onWrite({ id, values, existing: null });
    if (table === 'interviews') await applyPanel(id, req.body.panel, user);
    let linkedNote = null;
    if (table === 'candidates' && req.body.link_vacancy_id) { try { linkedNote = (await linkCandidateToVacancy(id, req.body.link_vacancy_id, user)) ? 'candidate linked to the vacancy' : null; } catch (e) { console.warn('⚠️  Vacancy not linked:', e.message); } }
    const auto = await runAutomation(table, { id, values, existing: null }, user);
    if (linkedNote) auto.push(linkedNote);
    if (table === 'interviews') { const n = takeInterviewNote(id); if (n) auto.push(n); }

    const row = await dbGet(`SELECT * FROM ${table} WHERE id = ?`, [id]);
    res.status(201).json({ ...stripSecrets(table, parseJsonFields(row, config.jsonFields)), ...(auto.length ? { _auto: auto } : {}) });
  });

  app.put(`/api/${table}/:id`, requireAuth, async (req, res) => {
    if (!canWrite(req, res, table)) return;
    const user = currentUser(req);
    const existing = await dbGet(`SELECT * FROM ${table} WHERE id = ?`, [req.params.id]);
    if (!existing) return res.status(404).json({ error: `${table} record not found` });

    const values = serializeJsonFields(filterInput(req.body, config.fields), config.jsonFields);

    const errors = validateInput(table, config, values, false);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    if (table === 'offers' && offerApprovalBlocked(req, values, existing)) return res.status(400).json({ error: 'An offer is approved by the Authorized Signatory. Use "Send for approval" on the offer — it is marked Approved once they sign.' });

    if (table === 'candidates' && (values.email !== undefined || values.mobile !== undefined)
      && await rejectIfDuplicateCandidate(res, values, req.params.id, existing)) return;
    if (table === 'interviews') normalizeScorecard(values);
    if (table === 'interviews' && req.body.panel !== undefined) { try { panel.parsePanel(req.body.panel); } catch (e) { return res.status(400).json({ error: e.message }); } }

    if (table === 'users' && req.body.password) {
      values.password_hash = await bcrypt.hash(req.body.password, 10);
    }
    if (Object.keys(values).length === 0 && !(table === 'interviews' && req.body.panel !== undefined)) {
      return res.status(400).json({ error: 'No valid fields provided' });
    }

    if (Object.keys(values).length) { const { sql, params } = createUpdate(table, values, req.params.id); await dbRun(sql, params); }
    await logActivity(table, req.params.id, 'Updated', JSON.stringify(existing), JSON.stringify(values), user.id, user.full_name);
    await logAudit(user.id, user.full_name, 'update', table, req.params.id, values);
    if (table === 'vacancies' && values.assigned_recruiter_id && values.assigned_recruiter_id !== existing.assigned_recruiter_id) {
      // the applications follow their vacancy's recruiter (only those that were blank or still on the previous recruiter)
      await dbRun("UPDATE applications SET recruiter_id = ?, updated_at = datetime('now') WHERE vacancy_id = ? AND is_deleted = 0 AND (recruiter_id IS NULL OR recruiter_id = '' OR recruiter_id = ?)", [values.assigned_recruiter_id, req.params.id, existing.assigned_recruiter_id || '']);
    }
    if (config.onWrite && Object.keys(values).length) await config.onWrite({ id: req.params.id, values, existing });
    if (table === 'interviews') await applyPanel(req.params.id, req.body.panel, user);
    const auto = await runAutomation(table, { id: req.params.id, values, existing }, user);
    if (table === 'interviews') { const n = takeInterviewNote(req.params.id); if (n) auto.push(n); }

    const row = await dbGet(`SELECT * FROM ${table} WHERE id = ?`, [req.params.id]);
    res.json({ ...stripSecrets(table, parseJsonFields(row, config.jsonFields)), ...(auto.length ? { _auto: auto } : {}) });
  });

  app.delete(`/api/${table}/:id`, requireAuth, async (req, res) => {
    if (!canWrite(req, res, table)) return;
    const user = currentUser(req);
    const existing = await dbGet(`SELECT * FROM ${table} WHERE id = ?`, [req.params.id]);
    if (!existing) return res.status(404).json({ error: `${table} record not found` });

    if (table === 'users') {
      // Users are deactivated, never hard-deleted: other rows (clients.account_owner_id,
      // created_by, assigned_recruiter_id, ...) reference user ids, and a hard delete
      // either breaks that foreign key or leaves those references dangling.
      await dbRun(`UPDATE users SET is_active = 0, updated_at = datetime('now') WHERE id = ?`, [req.params.id]);
    } else if (config.softDelete) {
      await dbRun(`UPDATE ${table} SET is_deleted = 1, deleted_at = datetime('now'), deleted_by = ?, updated_at = datetime('now') WHERE id = ?`, [user.id, req.params.id]);
    } else {
      await dbRun(`DELETE FROM ${table} WHERE id = ?`, [req.params.id]);
    }

    await logActivity(table, req.params.id, table === 'users' ? 'Deactivated' : 'Deleted', JSON.stringify(existing), null, user.id, user.full_name);
    await logAudit(user.id, user.full_name, table === 'users' ? 'deactivate' : 'delete', table, req.params.id, {});
    res.json({ ok: true });
  });
}

app.post('/api/candidates/:id/resumes', requireAuth, upload.single('resume'), async (req, res) => {
  const user = currentUser(req);
  const candidate = await dbGet('SELECT id, full_name FROM candidates WHERE id = ? AND is_deleted = 0', [req.params.id]);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  if (!req.file) return res.status(400).json({ error: 'Resume file is required' });

  const versionRow = await dbGet('SELECT COALESCE(MAX(version), 0) + 1 AS version FROM resumes WHERE candidate_id = ?', [candidate.id]);
  await dbRun('UPDATE resumes SET is_current = 0 WHERE candidate_id = ?', [candidate.id]);

  const resumeId = uuidv4();
  await dbRun(
    `INSERT INTO resumes (id,candidate_id,version,file_name,file_size,file_path,mime_type,uploaded_by,is_current)
     VALUES (?,?,?,?,?,?,?,?,1)`,
    [resumeId, candidate.id, versionRow.version, req.file.originalname, req.file.size, req.file.path, req.file.mimetype, user.id]
  );

  await logActivity('candidate', candidate.id, 'Resume Uploaded', null, req.file.originalname, user.id, user.full_name);
  await logAudit(user.id, user.full_name, 'upload_resume', 'candidate', candidate.id, { resume_id: resumeId, file_name: req.file.originalname });

  const resume = await dbGet('SELECT * FROM resumes WHERE id = ?', [resumeId]);
  res.status(201).json(resume);
});

app.get('/api/candidates/:id/resumes', requireAuth, async (req, res) => {
  const rows = await dbAll('SELECT * FROM resumes WHERE candidate_id = ? ORDER BY version DESC', [req.params.id]);
  res.json(parseRows(rows, ['parsed_data']));
});


app.get('/api/resumes/:id/download', requireAuth, async (req, res) => {
  if (currentUser(req).role === 'viewer') {
    return res.status(403).json({ error: 'Viewer role cannot download resumes' });
  }
  const resume = await dbGet('SELECT * FROM resumes WHERE id = ?', [req.params.id]);
  if (!resume || !fs.existsSync(resume.file_path)) {
    return res.status(404).json({ error: 'Resume file not found' });
  }
  res.download(resume.file_path, resume.file_name);
});

app.post('/api/applications/:id/recalculate-score', requireAuth, async (req, res) => {
  if (!canWrite(req, res, 'applications')) return;
  const application = await dbGet('SELECT * FROM applications WHERE id = ?', [req.params.id]);
  if (!application) return res.status(404).json({ error: 'Application not found' });
  await calculateMatchScore({ id: req.params.id });
  const row = await dbGet('SELECT * FROM applications WHERE id = ?', [req.params.id]);
  res.json(parseJsonFields(row, ['score_breakdown', 'score_weights']));
});

app.get('/api/settings', requireAuth, async (_req, res) => {
  const rows = (await dbAll('SELECT key, value, updated_at, updated_by FROM settings ORDER BY key ASC')).filter((r) => !r.key.endsWith('_hash') && !r.key.startsWith('portal_pull_') && !r.key.startsWith('hrms_'));
  const parsed = rows.map((row) => {
    let value = row.value;
    try { value = JSON.parse(row.value); } catch { /* plain string setting, keep as-is */ }
    return { ...row, value };
  });
  res.json(parsed);
});

app.put('/api/settings/:key', requireAuth, requireRole('super_admin', 'hr_manager'), async (req, res) => {
  const user = currentUser(req);
  const existing = await dbGet('SELECT key FROM settings WHERE key = ?', [req.params.key]);
  if (!existing || req.params.key.endsWith('_hash') || req.params.key.startsWith('portal_pull_') || req.params.key.startsWith('hrms_')) return res.status(404).json({ error: 'Unknown setting key' });
  if (req.body.value === undefined) return res.status(400).json({ error: 'value is required' });

  const stored = typeof req.body.value === 'string' ? req.body.value : JSON.stringify(req.body.value);
  await dbRun(`UPDATE settings SET value = ?, updated_at = datetime('now'), updated_by = ? WHERE key = ?`, [stored, user.id, req.params.key]);
  await logAudit(user.id, user.full_name, 'update_setting', 'settings', req.params.key, { value: req.body.value });

  const row = await dbGet('SELECT key, value, updated_at, updated_by FROM settings WHERE key = ?', [req.params.key]);
  let value = row.value;
  try { value = JSON.parse(row.value); } catch { /* plain string setting, keep as-is */ }
  res.json({ ...row, value });
});

// Pure calculation, no DB access — computes the monthly compensation
// breakdown from a single annual CTC figure per RDC's official slab
// structure. Used by the Offers form so a recruiter only has to enter CTC.
app.post('/api/ctc-breakdown', requireAuth, (req, res) => {
  try {
    const { monthly } = calculateCtcBreakdown(req.body.ctc);
    res.json(monthly);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Candidate email templates: preview, edit, send, and "close out" a vacancy ─────────────
app.get('/api/status-emails', requireAuth, async (_req, res) => { res.json({ rules: statusEmails.RULES.map(({ status, label, hint }) => ({ status, label, hint })), config: await statusEmails.getConfig({ dbGet, dbRun }) }); });
app.put('/api/status-emails', requireAuth, requireRole('super_admin', 'hr_manager'), async (req, res) => {
  const user = currentUser(req); const cfg = await statusEmails.saveConfig({ dbGet, dbRun }, req.body || {});
  await logAudit(user.id, user.full_name, 'update', 'settings', 'auto_status_emails', cfg); res.json({ config: cfg });
});
app.get('/api/email-templates', requireAuth, async (_req, res) => {
  res.json(await emailTemplates.listTemplates({ dbAll }));
});

app.put('/api/email-templates/:key', requireAuth, requireRole('super_admin', 'hr_manager'), async (req, res) => {
  const user = currentUser(req);
  const existing = await dbGet('SELECT key FROM email_templates WHERE key = ?', [req.params.key]);
  if (!existing) return res.status(404).json({ error: 'Template not found' });
  if (req.body.reset) {
    const def = emailTemplates.DEFAULTS.find((t) => t.key === req.params.key);
    if (!def) return res.status(400).json({ error: 'This is a custom template — there is no original to restore.' });
    await dbRun("UPDATE email_templates SET name = ?, subject = ?, body = ?, set_status = ?, reject_reason = ?, updated_at = datetime('now'), updated_by = ? WHERE key = ?",
      [def.name, def.subject, def.body, def.set_status, def.reject_reason, user.id, req.params.key]);
  } else {
    const { subject, body } = req.body;
    if (!String(subject || '').trim() || !String(body || '').trim()) return res.status(400).json({ error: 'Subject and message cannot be empty.' });
    await dbRun("UPDATE email_templates SET subject = ?, body = ?, updated_at = datetime('now'), updated_by = ? WHERE key = ?", [subject, body, user.id, req.params.key]);
  }
  await logAudit(user.id, user.full_name, 'edit_email_template', 'settings', req.params.key, { reset: !!req.body.reset });
  res.json(await dbGet('SELECT key, name, subject, body, set_status, reject_reason, updated_at FROM email_templates WHERE key = ?', [req.params.key]));
});

app.post('/api/email-templates/render', requireAuth, async (req, res) => {
  if (!canWrite(req, res, 'applications')) return;
  try { res.json(await emailTemplates.render({ dbGet }, req.body.template, req.body, currentUser(req))); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/email-templates/send', requireAuth, async (req, res) => {
  if (!canWrite(req, res, 'applications')) return;
  try {
    const user = currentUser(req);
    const result = await emailTemplates.send({ dbGet, dbRun, logActivity, logAudit }, req.body, user);
    reminders.run({ dbAll, dbGet, dbRun }, { tasksOnly: true }).catch(() => {});
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/vacancies/:id/close-out', requireAuth, async (req, res) => {
  if (!canWrite(req, res, 'applications')) return;
  try {
    const result = await emailTemplates.closeOut({ dbGet, dbAll, dbRun, logActivity, logAudit }, req.params.id, { sendEmails: req.body.send_emails !== false }, currentUser(req));
    reminders.run({ dbAll, dbGet, dbRun }, { tasksOnly: true }).catch(() => {});
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Assessment results: portal webhook (API key) + Excel/CSV import ───────────────────────
app.post('/api/integrations/api-key', requireAuth, requireRole('super_admin'), async (req, res) => {
  const user = currentUser(req);
  const key = await assessmentIntake.newApiKey({ dbRun });
  await logAudit(user.id, user.full_name, 'new_integration_key', 'settings', 'integration_api_key', {});
  res.json({ key });
});
app.get('/api/integrations/status', requireAuth, requireRole('super_admin', 'hr_manager'), async (_req, res) => {
  const row = await dbGet("SELECT value, updated_at FROM settings WHERE key = 'integration_api_key_hash'");
  res.json({ has_key: !!(row && row.value), updated_at: row && row.updated_at });
});

// Pull results from the portal (configured in Settings; secret never returned to the browser)
app.get('/api/integrations/portal-pull', requireAuth, requireRole('super_admin', 'hr_manager'), async (_req, res) => {
  res.json(await portalPull.getPublicConfig({ dbGet, dbRun }));
});
app.put('/api/integrations/portal-pull', requireAuth, requireRole('super_admin'), async (req, res) => {
  const user = currentUser(req);
  try {
    const out = await portalPull.saveConfig({ dbGet, dbRun }, req.body || {});
    await logAudit(user.id, user.full_name, 'update_portal_pull', 'settings', 'portal_pull_config', { enabled: out.enabled });
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/integrations/portal-pull/run', requireAuth, requireRole('super_admin', 'hr_manager'), async (req, res) => {
  const out = await portalPull.run({ dbGet, dbAll, dbRun, logAudit }, { dry: !!(req.body && req.body.dry), force: true });
  res.json(out);
});

// Called by the portal / IT. One result or { results: [...] }; header  X-API-Key: <key>
app.post('/api/integrations/assessment-result', async (req, res) => {
  const presented = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!(await assessmentIntake.keyIsValid({ dbGet }, presented))) return res.status(401).json({ error: 'Invalid or missing API key.' });
  const list = Array.isArray(req.body.results) ? req.body.results.slice(0, 200) : [req.body];
  const out = [];
  for (const item of list) {
    try { out.push(await assessmentIntake.applyResult({ dbGet, dbAll, dbRun, logAudit }, item)); }
    catch (err) { out.push({ ok: false, error: err.message }); }
  }
  const ok = out.filter((r) => r.ok).length;
  res.status(ok === out.length ? 200 : ok ? 207 : 422).json({ processed: out.length, saved: ok, results: out });
});

const sheetUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
app.post('/api/assessments/import', requireAuth, sheetUpload.single('file'), async (req, res) => {
  if (!canWrite(req, res, 'assessments')) return;
  if (!req.file) return res.status(400).json({ error: 'Choose the Excel or CSV file first.' });
  try {
    const { items, columns } = assessmentIntake.parseSheet(req.file.buffer, { defaultType: assessmentIntake.normType(req.body.assessment_type) });
    const rows = [];
    for (const it of items.slice(0, 500)) {
      const r = it.assessment_type ? await assessmentIntake.applyResult({ dbGet, dbAll, dbRun, logAudit }, it, undefined, { dry: true }) : { ok: false, error: 'test type not recognised — choose SRT or DISC above' };
      rows.push({ ...it, match: r.ok ? { ...r.candidate, action: r.action } : null, error: r.ok ? null : r.error });
    }
    res.json({ rows, columns: Object.keys(columns), total: items.length });
  } catch (err) { res.status(422).json({ error: err.message }); }
});
app.post('/api/assessments/import/apply', requireAuth, async (req, res) => {
  if (!canWrite(req, res, 'assessments')) return;
  const user = currentUser(req);
  const out = { created: 0, updated: 0, failed: [] };
  for (const it of (req.body.rows || []).slice(0, 500)) {
    try {
      const r = await assessmentIntake.applyResult({ dbGet, dbAll, dbRun, logAudit }, it, { id: user.id, name: user.full_name });
      if (r.ok) out[r.action] += 1; else out.failed.push({ row: it.row, error: r.error });
    } catch (err) { out.failed.push({ row: it.row, error: err.message }); }
  }
  reminders.run({ dbAll, dbGet, dbRun }, { tasksOnly: true }).catch(() => {});
  res.json(out);
});

// ── Bulk resume upload ────────────────────────────────────────────────────────
const bulkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 25 } });
app.post('/api/candidates/bulk-upload', requireAuth, bulkUpload.array('resumes', 25), async (req, res) => {
  if (!canWrite(req, res, 'candidates')) return;
  const user = currentUser(req);
  const vacancy = req.body.vacancy_id ? await dbGet('SELECT id, title, jd_id, assigned_recruiter_id FROM vacancies WHERE id = ? AND is_deleted = 0', [req.body.vacancy_id]) : null;
  if (req.body.vacancy_id && !vacancy) return res.status(400).json({ error: 'That vacancy was not found.' });
  const source = (req.body.source || '').trim() || 'Bulk upload';
  const results = [];

  const addToVacancy = async (candidateId) => {
    if (!vacancy) return null;
    const have = await dbGet('SELECT id FROM applications WHERE candidate_id = ? AND vacancy_id = ? AND is_deleted = 0', [candidateId, vacancy.id]);
    if (have) return { existing: true };
    const id = uuidv4();
    const vals = { id, candidate_id: candidateId, vacancy_id: vacancy.id, recruiter_id: vacancy.assigned_recruiter_id || user.id, jd_id: vacancy.jd_id || null, status: 'Sourced' };
    const { sql, params } = createInsert('applications', vals);
    await dbRun(sql, params);
    await calculateMatchScore({ id });
    const a = await dbGet('SELECT match_score FROM applications WHERE id = ?', [id]);
    return { created: true, score: a ? a.match_score : null };
  };

  for (const file of req.files || []) {
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
    try {
      const text = await resumeParser.extractText(file.buffer, name);
      if (!text.trim()) { results.push({ file: name, status: 'failed', message: 'No text could be read (scanned image?) — add this one manually.' }); continue; }
      const fields = resumeParser.parseResumeText(text);
      if (!fields.full_name || (!fields.email && !fields.mobile)) {
        results.push({ file: name, status: 'failed', message: `Could not find ${!fields.full_name ? 'the name' : 'an email or mobile'} — add this one manually.` }); continue;
      }
      const dups = await duplicates.findDuplicates(dbAll, { email: fields.email, mobile: fields.mobile });
      if (dups.length) {
        const d = dups[0]; let app = null; try { app = await addToVacancy(d.id); } catch { /* reported below as not tagged */ }
        results.push({ file: name, status: 'duplicate', candidate: { id: d.id, code: d.candidate_code, name: d.full_name },
          message: `Already in the system as ${d.candidate_code} (same ${d.matched_on})${app ? (app.existing ? ' and already applied to this vacancy.' : ' — added to this vacancy.') : '.'}`, applied: !!(app && app.created) });
        continue;
      }
      const cfg = tableConfig.candidates;
      const values = serializeJsonFields(filterInput({ ...fields, source, status: 'Active' }, cfg.fields), cfg.jsonFields);
      const id = uuidv4(); values.id = id; values.created_by = user.id;
      let attempts = 5;
      while (attempts-- > 0) {
        values.candidate_code = await nextCode(cfg.code[0], 'candidates', cfg.code[1]);
        try { const { sql, params } = createInsert('candidates', values); await dbRun(sql, params); break; }
        catch (err) { if (!/UNIQUE constraint failed/i.test(err.message) || attempts === 0) throw err; }
      }
      const stored = `${Date.now()}-${uuidv4()}-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, stored), file.buffer);
      await dbRun(`INSERT INTO resumes (id,candidate_id,version,file_name,file_size,file_path,mime_type,uploaded_by,is_current) VALUES (?,?,1,?,?,?,?,?,1)`,
        [uuidv4(), id, name, file.size, path.join(UPLOADS_DIR, stored), file.mimetype, user.id]);
      await logActivity('candidates', id, 'Created from bulk resume upload', null, name, user.id, user.full_name);
      await logAudit(user.id, user.full_name, 'bulk_create_candidate', 'candidates', id, { file: name });
      let app = null; let tagError = '';
      try { app = await addToVacancy(id); } catch (err) { tagError = err.message; }
      results.push({ file: name, status: 'created', candidate: { id, code: values.candidate_code, name: values.full_name }, applied: !!app, score: app ? app.score : null,
        message: `Added as ${values.candidate_code}${app ? ' and tagged to the vacancy' : ''}.${tagError ? ' (Could not tag to the vacancy: ' + tagError + ')' : ''}` });
    } catch (err) {
      results.push({ file: name, status: 'failed', message: /pdf|xref|stream/i.test(err.message) ? 'This file could not be read as a PDF — it may be damaged or password-protected. Add this one manually.' : err.message });
    }
  }
  res.json({ results });
});

// Preview (dry=1) or immediately run today's automatic reminders.
app.post('/api/reminders/run', requireAuth, requireRole('super_admin', 'hr_manager'), async (req, res) => {
  try {
    const dry = req.query.dry === '1' || (req.body && req.body.dry === true);
    const result = await reminders.run({ dbAll, dbGet, dbRun }, { dry, force: true });
    if (!dry) { const u = currentUser(req); await logAudit(u.id, u.full_name, 'run_reminders', 'settings', 'reminders', { emails: result.emails.length, tasks: result.tasksCreated.length }); }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tracker/send-now', requireAuth, requireRole('super_admin', 'hr_manager'), async (req, res) => {
  try {
    const { recipients } = await sendWeeklyTracker({ dbAll, dbGet, dbRun });
    const user = currentUser(req);
    await logAudit(user.id, user.full_name, 'send_tracker', 'settings', null, { recipients });
    res.json({ ok: true, recipients });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/google/status', requireAuth, async (_req, res) => {
  res.json({ connected: await googleCalendar.isConnected({ dbGet }) });
});

app.get('/api/google/auth', requireAuth, requireRole('super_admin'), (req, res) => {
  try {
    res.redirect(googleCalendar.getAuthUrl());
  } catch (err) {
    res.status(400).send(err.message);
  }
});

app.get('/api/google/oauth/callback', requireAuth, requireRole('super_admin'), async (req, res) => {
  try {
    if (req.query.error) throw new Error(`Google declined: ${req.query.error}`);
    await googleCalendar.handleOAuthCallback({ code: req.query.code, userId: currentUser(req).id, dbRun });
    res.send('<script>window.close(); window.opener && window.opener.postMessage("google-connected", "*");</script>Connected — you can close this tab.');
  } catch (err) {
    res.status(400).send(`Could not connect Google Calendar: ${err.message}`);
  }
});

app.post('/api/google/disconnect', requireAuth, requireRole('super_admin'), async (req, res) => {
  await googleCalendar.disconnect({ dbRun });
  res.json({ ok: true });
});

// Shared by the manual "Generate Meet Link" button and the automatic
// on-schedule flow below — creates the Calendar event/Meet link and saves it
// onto the interview, but does NOT send any email itself (callers decide
// whether/when to notify, so the automatic flow can fold this into a single
// combined email instead of firing a second one).
async function generateMeetLinkForInterview(interviewId) {
  let interview = await dbGet('SELECT * FROM interviews WHERE id = ?', [interviewId]);
  if (!interview) throw new Error('Interview not found');
  // a panel shares ONE meeting: members copy the main interview's link instead of creating their own event
  if (interview.panel_id && interview.panel_id !== interview.id) {
    const main = await dbGet('SELECT * FROM interviews WHERE id = ?', [interview.panel_id]);
    if (main) { const link = main.meeting_link || await generateMeetLinkForInterview(main.id); await dbRun('UPDATE interviews SET meeting_link = ? WHERE id = ?', [link, interviewId]); return link; }
  }
  const panelEmails = interview.panel_id ? (await panel.members({ dbAll }, interview)).map((r) => r.interviewer_email) : [];
  if (!interview.scheduled_date) throw new Error('Set a scheduled date first');

  const [candidate, vacancy] = await Promise.all([
    dbGet('SELECT * FROM candidates WHERE id = ?', [interview.candidate_id]),
    dbGet('SELECT * FROM vacancies WHERE id = ?', [interview.vacancy_id])
  ]);

  const startDateTime = `${interview.scheduled_date}T${interview.scheduled_time || '10:00'}:00`;
  const endDateTime = addMinutesToLocalDateTime(interview.scheduled_date, interview.scheduled_time || '10:00', 45);

  const { meetLink, eventId } = await googleCalendar.createMeetEvent({ dbGet, dbRun }, {
    summary: `Interview: ${candidate?.full_name || 'Candidate'} — ${vacancy?.title || 'Position'}`,
    description: `Round ${interview.round || 1} interview via RDC's Recruitment Management System.`,
    startDateTime, endDateTime,
    attendeeEmails: [...new Set([candidate?.email, interview.interviewer_email, ...panelEmails].filter(Boolean))]
  });
  await dbRun('UPDATE interviews SET meeting_link = ?, google_event_id = ? WHERE id = ?', [meetLink, eventId, interviewId]);
  return meetLink;
}

app.post('/api/interviews/:id/resend-confirmation', requireAuth, async (req, res) => {
  if (!canWrite(req, res, 'interviews')) return;
  try {
    await sendInterviewConfirmation({ dbGet, dbRun }, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/interviews/:id/generate-meet-link', requireAuth, async (req, res) => {
  if (!canWrite(req, res, 'interviews')) return;
  try {
    const meetLink = await generateMeetLinkForInterview(req.params.id);
    const user = currentUser(req);
    await logAudit(user.id, user.full_name, 'generate_meet_link', 'interviews', req.params.id, { meetLink });
    try {
      const row = await dbGet('SELECT id, panel_id FROM interviews WHERE id = ?', [req.params.id]);
      const mainId = row && row.panel_id ? row.panel_id : req.params.id;
      await sendMeetLinkEmail({ dbGet, dbRun }, mainId);
      if (row && row.panel_id) {
        await dbRun("UPDATE interviews SET meeting_link = ? WHERE panel_id = ? AND is_deleted = 0", [meetLink, row.panel_id]);
        for (const m of (await panel.members({ dbAll }, row)).filter((r) => r.id !== mainId)) await sendMeetLinkEmail({ dbGet, dbRun }, m.id);
      }
    } catch (mailErr) {
      console.warn('⚠️  Meet link email not sent:', mailErr.message);
    }
    res.json({ meeting_link: meetLink });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/audit-logs', requireAuth, requireRole('super_admin', 'hr_manager'), async (_req, res) => {
  const rows = await dbAll('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 500');
  res.json(parseRows(rows, ['changes']));
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API route not found' });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

async function start() {
  if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
    console.warn('⚠️  SESSION_SECRET is not set — using the built-in development default. Set a real secret before deploying.');
  }
  await initialize();
  await emailTemplates.seed({ dbRun });
  try {
    if (!(await dbGet("SELECT key FROM settings WHERE key = 'interviewers_seeded'"))) {
      const { v4: uid } = require('uuid');
      for (const p of require('./interviewers_seed.json')) {
        if (await dbGet('SELECT id FROM interviewers WHERE employee_code = ?', [p.employee_code])) continue;
        await dbRun('INSERT INTO interviewers (id,employee_code,name,designation,city,company,location,email) VALUES (?,?,?,?,?,?,?,?)', [uid(), p.employee_code, p.name, p.designation, p.city, p.company, p.location, p.email || null]);
      }
      await dbRun("INSERT INTO settings (key,value) VALUES ('interviewers_seeded', ?)", [new Date().toISOString()]);
    }
    // Fill in emails for anyone loaded earlier without one (never overwrites an email you entered).
    for (const p of require('./interviewers_seed.json')) {
      if (p.email) await dbRun("UPDATE interviewers SET email = ? WHERE employee_code = ? AND (email IS NULL OR email = '')", [p.email, p.employee_code]);
    }
  } catch (e) { console.error('Interviewers not loaded:', e.message); }
  try { await require('./standardJds').load({ dbGet, dbRun }); } catch (e) { console.error('Standard JDs not loaded:', e.message); }
  // Any application without a calculated score yet (freshly seeded demo data, or one
  // created before its vacancy had a JD tagged) gets a real score computed on boot.
  const unscored = await dbAll("SELECT id FROM applications WHERE match_score IS NULL AND is_deleted = 0");
  for (const { id } of unscored) await calculateMatchScore({ id });

  // Weekly position tracker: fires every Monday at 9am if the server is running
  // continuously, plus a catch-up check (below, and hourly) in case it wasn't.
  cron.schedule('0 9 * * 1', () => maybeSendWeeklyTracker({ dbAll, dbGet, dbRun }));
  cron.schedule('0 * * * *', () => maybeSendWeeklyTracker({ dbAll, dbGet, dbRun }));
  await maybeSendWeeklyTracker({ dbAll, dbGet, dbRun });

  // Interview reminders: checked hourly (and once on boot) rather than at a
  // single fixed time, so a server restarted partway through the day still
  // catches tomorrow's interviews without a long wait.
  cron.schedule('0 * * * *', () => checkInterviewReminders({ dbAll, dbGet, dbRun }));
  await checkInterviewReminders({ dbAll, dbGet, dbRun });

  // Automatic follow-ups (interview feedback, assessments, offers, joining). Checked hourly and on boot;
  // everything is de-duplicated, and emails only go out in the daytime window.
  const runReminders = () => reminders.run({ dbAll, dbGet, dbRun })
    .then((r) => { if (r.emails.some((e) => !e.held) || r.tasksCreated.length) console.log(`🔔 Reminders: ${r.emails.filter((e) => !e.held).length} email(s), ${r.tasksCreated.length} new follow-up(s).`); })
    .catch((err) => console.warn('⚠️  Reminder run failed:', err.message));
  cron.schedule('5 * * * *', runReminders);
  cron.schedule('40 * * * *', () => require('./onboarding').retryPending({ dbGet, dbAll, dbRun, logAudit }).then((n) => { if (n) console.log(`HRMS hand-over: ${n} onboarding record(s) sent.`); }).catch((e) => console.error('HRMS retry failed:', e.message)));
  cron.schedule('20 * * * *', () => portalPull.run({ dbGet, dbAll, dbRun, logAudit }).then((r) => { if (r && r.completed) console.log(`Portal results: ${r.completed} assessment(s) completed.`); }).catch((e) => console.error('Portal pull failed:', e.message)));
  await runReminders();

  app.listen(PORT, () => {
    console.log(`RDC's Recruitment Management System server running at http://localhost:${PORT}`);
    if (!process.env.APP_BASE_URL) console.log("ℹ️  APP_BASE_URL is not set in .env — scorecard links in interviewer emails will point to this computer (localhost) and only open here. Set it to the address interviewers use once the tracker is hosted.");
  });
}

// Catches errors passed to next() by the wrapper above (or thrown by any
// synchronous route code) and returns a clean JSON error instead of letting
// Express's own crash-prone default handler take over. Must be registered
// after every route above.
app.use((err, req, res, _next) => {
  console.error(`Unhandled error on ${req.method} ${req.path}:`, err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong on the server. Check the terminal for details.' });
});

// Final safety net for errors outside Express's request/response cycle
// entirely (e.g. inside a cron job) — logs them without ever crashing the
// whole server process, which is the actual failure mode being guarded
// against throughout this file.
process.on('unhandledRejection', (err) => console.error('Unhandled promise rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

if (require.main === module) {
  start().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

module.exports = { app, start };
