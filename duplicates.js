// Duplicate detection for candidates. A candidate is a duplicate when another
// (not deleted) record has the same email (case-insensitive) or the same
// mobile number (compared on the last 10 digits, so +91 / spaces / hyphens
// don't matter).
const { normalizeMobile } = require('./resumeParser');

function normalizeEmail(e) {
  return String(e || '').trim().toLowerCase();
}

async function findDuplicates(dbAll, { email, mobile, excludeId }) {
  const em = normalizeEmail(email);
  const mb = normalizeMobile(mobile);
  if (!em && !mb) return [];
  const rows = await dbAll(
    `SELECT id, candidate_code, full_name, email, mobile, current_company, status
     FROM candidates WHERE is_deleted = 0 ${excludeId ? 'AND id != ?' : ''}`,
    excludeId ? [excludeId] : []
  );
  const matches = [];
  for (const r of rows) {
    const byEmail = em && normalizeEmail(r.email) === em;
    const byMobile = mb && normalizeMobile(r.mobile) === mb;
    if (byEmail || byMobile) {
      matches.push({ ...r, matched_on: byEmail && byMobile ? 'email and mobile' : byEmail ? 'email' : 'mobile' });
    }
  }
  return matches;
}

function describe(d) {
  return `${d.full_name} (${d.candidate_code}) already has the same ${d.matched_on}`;
}

module.exports = { findDuplicates, describe, normalizeEmail };
