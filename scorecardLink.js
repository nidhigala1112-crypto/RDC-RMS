// Shareable interviewer scorecard links. Each interview can have one secret
// link (long random token, valid for 30 days) that lets the interviewer fill
// in the scorecard in their browser without an account. The public page only
// ever sees the candidate's name, the role, company, round and date.
const crypto = require('crypto');
const fs = require('fs');
const { sendMail } = require('./mailer');

const EXPIRY_DAYS = 30;
const RECOMMENDATIONS = ['Proceed', 'Hold', 'Reject'];
const HIRE_TYPES = ['On Roll', 'Off Roll', 'Fixed Term Contract', 'Retainer Contract'];
const { KEYS: CRITERIA, isSalesRole, average } = require('./scorecardCriteria');

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function isoIn(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function buildUrl(baseUrl, token) {
  return `${String(baseUrl).replace(/\/$/, '')}/scorecard/${token}`;
}

// Returns the interview's current link, creating one if there is none (or the
// old one has expired, or `regenerate` is set — which invalidates the old link).
async function ensureLink({ dbGet, dbRun }, interviewId, { regenerate = false } = {}) {
  const row = await dbGet('SELECT id, scorecard_token, scorecard_token_expires FROM interviews WHERE id = ? AND is_deleted = 0', [interviewId]);
  if (!row) throw new Error('Interview not found');
  const stillValid = row.scorecard_token && row.scorecard_token_expires && row.scorecard_token_expires > new Date().toISOString();
  if (stillValid && !regenerate) return { token: row.scorecard_token, expires_at: row.scorecard_token_expires };
  const token = crypto.randomBytes(24).toString('hex');
  const expires = isoIn(EXPIRY_DAYS);
  await dbRun('UPDATE interviews SET scorecard_token = ?, scorecard_token_expires = ?, updated_at = datetime(\'now\') WHERE id = ?', [token, expires, interviewId]);
  return { token, expires_at: expires };
}

async function loadByToken({ dbGet }, token) {
  if (!/^[a-f0-9]{48}$/.test(String(token || ''))) return { error: 'This link is not valid.', status: 404 };
  const row = await dbGet(`
    SELECT i.*, c.full_name AS candidate_name, v.title AS vacancy_title, v.company AS vacancy_company, j.title AS jd_title
    FROM interviews i
    LEFT JOIN candidates c ON c.id = i.candidate_id
    LEFT JOIN vacancies v ON v.id = i.vacancy_id
    LEFT JOIN jds j ON j.id = v.jd_id
    WHERE i.scorecard_token = ? AND i.is_deleted = 0`, [token]);
  if (!row) return { error: 'This link is not valid. Ask the recruiter for a new one.', status: 404 };
  if (!row.scorecard_token_expires || row.scorecard_token_expires <= new Date().toISOString()) {
    return { error: 'This link has expired. Ask the recruiter to send you a new one.', status: 410 };
  }
  return { row };
}

function parseCard(raw) {
  try { const c = JSON.parse(raw || '{}'); return c && typeof c === 'object' ? c : {}; } catch { return {}; }
}

// The candidate's current resume (latest version) — used for the email attachment and the page's download link.
async function currentResume({ dbGet }, candidateId) {
  if (!candidateId) return null;
  const r = await dbGet('SELECT file_name, file_path, mime_type FROM resumes WHERE candidate_id = ? ORDER BY is_current DESC, version DESC LIMIT 1', [candidateId]);
  return r && r.file_path && fs.existsSync(r.file_path) ? r : null;
}

// Resume attachment for the interviewer's email (nodemailer format), or [] if the candidate has none on file.
async function resumeAttachment(db, candidateId) {
  const r = await currentResume(db, candidateId);
  return r ? [{ filename: r.file_name, path: r.file_path, contentType: r.mime_type || undefined }] : [];
}

async function getResumeFile(db, token) {
  const { row, error, status } = await loadByToken(db, token);
  if (error) return { error, status };
  const r = await currentResume(db, row.candidate_id);
  if (!r) return { error: 'No resume is on file for this candidate.', status: 404 };
  return { path: r.file_path, name: r.file_name };
}

// What the interviewer's page is allowed to see.
async function getPublicView(db, token) {
  const { row, error, status } = await loadByToken(db, token);
  if (error) return { error, status };
  const card = parseCard(row.scorecard);
  const resume = await currentResume(db, row.candidate_id);
  return {
    data: {
      resume_name: resume ? resume.file_name : null,
      candidate: row.candidate_name || '',
      vacancy: row.vacancy_title || '',
      company: row.vacancy_company || '',
      is_sales: isSalesRole(row.vacancy_title, row.jd_title),
      round: row.round || 1,
      scheduled_date: row.scheduled_date || '',
      interviewer: row.interviewer || '',
      submitted_at: row.scorecard_submitted_at || null,
      expires_at: row.scorecard_token_expires,
      scorecard: { scores: card.scores || {}, strengths: card.strengths || '', concerns: card.concerns || '' },
      recommendation: row.recommendation || '',
      hire_type: row.hire_type || '',
      feedback: row.feedback || ''
    }
  };
}

async function submitPublic(db, token, body) {
  const { dbRun, dbGet } = db;
  const { row, error, status } = await loadByToken(db, token);
  if (error) return { error, status };

  const scores = {};
  for (const k of CRITERIA) {
    const n = Math.round(Number(body && body.scores && body.scores[k]));
    if (n >= 1 && n <= 5) scores[k] = n;
  }
  const recommendation = RECOMMENDATIONS.includes(body && body.recommendation) ? body.recommendation : '';
  const hireType = HIRE_TYPES.includes(body && body.hire_type) ? body.hire_type : '';
  if (!Object.keys(scores).length && !recommendation) {
    return { error: 'Please score at least one criterion or choose a recommendation before submitting.', status: 400 };
  }
  const clip = (v, n) => String((v === undefined || v === null) ? '' : v).slice(0, n).trim();
  const card = { scores, strengths: clip(body.strengths, 2000), concerns: clip(body.concerns, 2000) };
  const avgScore = average(scores);
  const rating = avgScore !== null ? avgScore : row.rating;
  const feedback = clip(body.feedback, 5000) || row.feedback || '';

  await dbRun(`UPDATE interviews SET scorecard = ?, rating = ?, recommendation = ?, hire_type = ?, feedback = ?,
      scorecard_submitted_at = datetime('now'),
      status = CASE WHEN status IN ('Scheduled', 'Confirmed', 'Rescheduled') THEN 'Completed' ELSE status END,
      updated_at = datetime('now') WHERE id = ?`,
    [JSON.stringify(card), rating, recommendation || row.recommendation || null, hireType || row.hire_type || null, feedback, row.id]);

  // Let the vacancy's recruiter know (best effort — never blocks the interviewer's submission).
  try {
    if (process.env.SMTP_USER && process.env.SMTP_PASS && row.vacancy_id) {
      const rec = await dbGet(`SELECT u.email FROM vacancies v JOIN users u ON u.id = v.assigned_recruiter_id WHERE v.id = ?`, [row.vacancy_id]);
      if (rec && rec.email) {
        await sendMail({
          to: rec.email,
          subject: `Scorecard submitted — ${row.candidate_name || 'candidate'} (${row.vacancy_title || 'vacancy'})`,
          html: `<div style="font-family:Arial,sans-serif; font-size:14px; line-height:1.6; max-width:560px;">
            <p>${escapeHtml(row.interviewer || 'The interviewer')} has submitted the scorecard for <strong>${escapeHtml(row.candidate_name || '')}</strong>
            (${escapeHtml(row.vacancy_title || '')}, round ${escapeHtml(row.round || 1)}).</p>
            <p>Average rating: <strong>${rating ?? '—'}</strong>${recommendation ? ` · Recommendation: <strong>${escapeHtml(recommendation)}</strong>` : ''}${hireType ? ` · Hire as: <strong>${escapeHtml(hireType)}</strong>` : ''}</p>
            <p style="color:#6E7169; font-size:12px;">Open the interview in RDC's Recruitment Management System to see the full scorecard.</p></div>`
        });
      }
    }
  } catch (err) { console.warn('⚠️  Could not email scorecard notification:', err.message); }

  return { ok: true, rating, interviewId: row.id, interviewer: row.interviewer };
}

async function sendLinkEmail({ dbGet }, interviewId, url, expiresAt) {
  const row = await dbGet(`
    SELECT i.*, c.full_name AS candidate_name, v.title AS vacancy_title, v.company AS vacancy_company
    FROM interviews i LEFT JOIN candidates c ON c.id = i.candidate_id LEFT JOIN vacancies v ON v.id = i.vacancy_id
    WHERE i.id = ?`, [interviewId]);
  if (!row) throw new Error('Interview not found');
  if (!row.interviewer_email) throw new Error('This interview has no interviewer email — add it first, or copy the link and send it yourself.');
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) throw new Error('Email isn\'t configured on this server yet — SMTP_USER / SMTP_PASS are missing from .env.');
  const expiry = new Date(expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const attachments = await resumeAttachment({ dbGet }, row.candidate_id);
  await sendMail({
    to: row.interviewer_email,
    attachments,
    subject: `Please submit your interview scorecard — ${row.candidate_name || 'candidate'} (${row.vacancy_title || ''})`,
    html: `<div style="font-family:Arial,sans-serif; font-size:14px; line-height:1.6; max-width:560px; color:#16221F;">
      <p>Dear ${escapeHtml(row.interviewer || 'Interviewer')},</p>
      <p>Thank you for interviewing <strong>${escapeHtml(row.candidate_name || '')}</strong> for <strong>${escapeHtml(row.vacancy_title || '')}</strong>${row.vacancy_company ? ` at ${escapeHtml(row.vacancy_company)}` : ''} (round ${escapeHtml(row.round || 1)}).</p>
      <p>Please share your assessment using the scorecard below — it takes about two minutes and needs no login. The candidate's resume is attached for reference.</p>
      <p style="margin:20px 0;"><a href="${escapeHtml(url)}" style="background:#1E3A52; color:#ffffff; padding:11px 20px; border-radius:8px; text-decoration:none; font-weight:bold;">Fill in the scorecard</a></p>
      <p style="color:#5C6A66; font-size:12.5px;">If the button doesn't work, copy this link into your browser:<br>${escapeHtml(url)}<br>The link works until ${escapeHtml(expiry)} and is meant only for you — please don't forward it.</p>
    </div>`
  });
  return { to: row.interviewer_email };
}

module.exports = { resumeAttachment, getResumeFile, HIRE_TYPES, ensureLink, buildUrl, getPublicView, submitPublic, sendLinkEmail, EXPIRY_DAYS };
