// When an offer's status is set to "Approved", automatically generates the
// appointment letter (same builder used by the manual download button) and
// emails it as an attachment to the candidate, the vacancy's assigned
// recruiter, and any additional stakeholder emails entered on the offer.
const fs = require('fs');
const { sendMail } = require('./mailer');
const { buildAppointmentLetterDocx } = require('./offerLetter');

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function getRecipients({ dbGet }, offer, candidate, vacancy) {
  const emails = [candidate?.email];
  if (vacancy?.assigned_recruiter_id) {
    const recruiter = await dbGet('SELECT email FROM users WHERE id = ?', [vacancy.assigned_recruiter_id]);
    if (recruiter?.email) emails.push(recruiter.email);
  }
  if (offer.additional_recipients) {
    for (const raw of offer.additional_recipients.split(',')) {
      const email = raw.trim();
      if (email) emails.push(email);
    }
  }
  return [...new Set(emails.filter(Boolean))];
}

function buildLetterEmailHtml({ candidate, vacancy, onboardingLink }) {
  return `
  <div style="font-family:Calibri, Carlito, Arial, sans-serif; font-size:15px; color:#23271F; line-height:1.6;">
    <p>Dear Mr./Ms. ${escapeHtml(candidate.full_name)},</p>
    <p><strong>Congratulations!</strong></p>
    <p>We are pleased to inform you that you have been selected for the position of <strong>${escapeHtml(vacancy.title)}</strong>${vacancy.location ? ', ' + escapeHtml(vacancy.location) : ''} in <strong>${escapeHtml(vacancy.company)}</strong>.</p>
    <p>Please find your Appointment letter in the attachment.</p>
    <p>Kindly confirm your acceptance.</p>
    <p>At the time of joining, it is mandatory to submit the below-mentioned documents and fill the Onboarding Form linked below:</p>
    ${onboardingLink ? `<p><a href="${escapeHtml(onboardingLink)}" style="background:#1E3A52; color:#ffffff; padding:10px 18px; border-radius:6px; text-decoration:none; font-weight:bold; display:inline-block;">Fill in your Onboarding Form</a><br><span style="font-size:12px; color:#6E7169;">${escapeHtml(onboardingLink)}</span></p>` : ''}
    <ol style="padding-left:20px;">
      <li>PAN Card</li>
      <li>Aadhar Card</li>
      <li>10th certificate</li>
      <li>Last qualification certificate</li>
      <li>Copy of Resignation</li>
      <li>Experience Letter &amp; Relieving Letter</li>
    </ol>
    <p><strong>Please Note:</strong> You will not be able to join duty without producing these documents at the time of joining.</p>
    <p>We look forward to a long association with you.</p>
  </div>`;
}

// The onboarding form link for this offer: the built-in form (one private link per candidate) when the
// onboarding module is wired in, otherwise the company's old external link / the Settings fallback.
async function resolveOnboardingLink({ dbGet, dbRun }, offer, company, baseUrl) {
  try {
    const onboarding = require('./onboarding');
    if (onboarding.isEnabled && (await onboarding.isEnabled({ dbGet }))) {
      const l = await onboarding.ensureLink({ dbGet, dbRun }, offer.candidate_id, offer.vacancy_id, offer.id);
      return onboarding.buildUrl(baseUrl, l.token);
    }
  } catch (err) { if (err.code !== 'MODULE_NOT_FOUND') console.warn('⚠️  Onboarding link not created:', err.message); }
  const row = await dbGet("SELECT value FROM settings WHERE key = 'onboarding_form_link'");
  return ((company && company.onboarding_form_link) || '').trim() || row?.value || '';
}

const baseUrl = () => (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

async function sendAppointmentLetterEmail({ dbGet, dbRun }, offerId) {
  const offer = await dbGet('SELECT * FROM offers WHERE id = ?', [offerId]);
  if (!offer) throw new Error('Offer not found');
  const [candidate, vacancy] = await Promise.all([
    dbGet('SELECT * FROM candidates WHERE id = ?', [offer.candidate_id]),
    dbGet('SELECT * FROM vacancies WHERE id = ?', [offer.vacancy_id])
  ]);
  if (!candidate) throw new Error('This offer has no linked candidate');
  if (!vacancy) throw new Error('This offer has no linked vacancy');
  if (!vacancy.company) throw new Error('This vacancy has no Company set — set it on the vacancy first');

  const company = await dbGet('SELECT * FROM clients WHERE company_name = ?', [vacancy.company]);
  if (!company) throw new Error(`No company record found for "${vacancy.company}" — check the Companies screen`);

  const buffer = await buildAppointmentLetterDocx({ candidate, vacancy, offer, company });
  const to = await getRecipients({ dbGet }, offer, candidate, vacancy);
  if (!to.length) throw new Error('No recipient email addresses found — check the candidate\'s email and this offer\'s Additional Recipients field');

  const onboardingLink = await resolveOnboardingLink({ dbGet, dbRun }, offer, company, baseUrl());

  const html = buildLetterEmailHtml({ candidate, vacancy, onboardingLink });

  await sendMail({
    to: to.join(', '),
    subject: `Appointment Letter — ${candidate.full_name}`,
    html,
    attachments: [{ filename: `Appointment Letter - ${candidate.full_name}.docx`, content: buffer }]
  });
  await dbRun('UPDATE offers SET letter_sent = 1 WHERE id = ?', [offerId]);
  return { recipients: to };
}

// Sends the letter the recruiter uploaded by hand (PDF / Word / image) instead of the generated one.
async function sendManualLetterEmail({ dbGet, dbRun }, offerId) {
  const offer = await dbGet('SELECT * FROM offers WHERE id = ? AND is_deleted = 0', [offerId]);
  if (!offer) throw new Error('Offer not found');
  if (!offer.manual_letter_path || !fs.existsSync(offer.manual_letter_path)) throw new Error('No uploaded letter found for this offer — upload the file first.');
  const [candidate, vacancy] = await Promise.all([
    dbGet('SELECT * FROM candidates WHERE id = ?', [offer.candidate_id]),
    dbGet('SELECT * FROM vacancies WHERE id = ?', [offer.vacancy_id])
  ]);
  if (!candidate) throw new Error('This offer has no linked candidate');
  if (!vacancy) throw new Error('This offer has no linked vacancy');
  const company = vacancy.company ? await dbGet('SELECT * FROM clients WHERE company_name = ?', [vacancy.company]) : null;
  const to = await getRecipients({ dbGet }, offer, candidate, vacancy);
  if (!candidate.email) throw new Error('The candidate has no email address on file — add it to the candidate first.');
  const onboardingLink = await resolveOnboardingLink({ dbGet, dbRun }, offer, company, baseUrl());
  await sendMail({
    to: to.join(', '),
    subject: `Appointment Letter — ${candidate.full_name}`,
    html: buildLetterEmailHtml({ candidate, vacancy: { ...vacancy, company: vacancy.company || '' }, onboardingLink }),
    attachments: [{ filename: offer.manual_letter_name || 'Appointment Letter', path: offer.manual_letter_path, contentType: offer.manual_letter_mime || undefined }]
  });
  await dbRun("UPDATE offers SET letter_sent = 1, status = CASE WHEN status IN ('Draft','Approved') THEN 'Sent' ELSE status END, updated_at = datetime('now') WHERE id = ?", [offerId]);
  return { recipients: to };
}

module.exports = { sendAppointmentLetterEmail, sendManualLetterEmail, resolveOnboardingLink, buildLetterEmailHtml };
