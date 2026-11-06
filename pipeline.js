// "Who is this candidate waiting on?" — one place that works it out from the application, its latest
// interview, assessments, offer and joining record. Used by the weekly email and the dashboard.
const today = () => new Date().toISOString().slice(0, 10);
const fmt = (d) => { const x = new Date(d); return isNaN(x) ? String(d || '') : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };

function pendingWith(a) {
  const t = today();
  const parts = [];
  const iv = a.iv_status ? a : null;
  const who = (n) => (n ? ` (${n})` : '');
  switch (a.status) {
    case 'Sourced': return { who: 'Recruiter', what: 'Screening', group: 'Recruiter' };
    case 'Screening': return { who: 'Recruiter', what: 'Screening call / shortlisting', group: 'Recruiter' };
    case 'Shortlisted':
      if (!iv) return { who: 'Recruiter', what: 'Schedule interview', group: 'Recruiter' };
    // falls through when an interview already exists
    case 'Interview': {
      if (!iv) return { who: 'Recruiter', what: 'Schedule interview', group: 'Recruiter' };
      const open = ['Scheduled', 'Confirmed', 'Rescheduled'].includes(a.iv_status);
      let res;
      if (open && a.iv_date && a.iv_date >= t) res = { who: 'Interview', what: `Round ${a.iv_round || 1} on ${fmt(a.iv_date)}${who(a.iv_interviewer)}`, group: 'Interview' };
      else if (open || (a.iv_status === 'Completed' && !a.iv_reco && !a.iv_scored)) res = { who: 'Interviewer', what: `Feedback${who(a.iv_interviewer)}`, group: 'Interviewer' };
      else if (a.iv_reco === 'Proceed') res = { who: 'Recruiter', what: 'Next round or offer', group: 'Recruiter' };
      else if (a.iv_reco === 'Hold') res = { who: 'Hiring manager', what: 'Decision (on hold)', group: 'Hiring manager' };
      else if (a.iv_reco === 'Reject') res = { who: 'Recruiter', what: 'Reject and inform candidate', group: 'Recruiter' };
      else if (a.iv_status === 'No Show') res = { who: 'Recruiter', what: 'Reschedule (no show)', group: 'Recruiter' };
      else res = { who: 'Recruiter', what: 'Next step', group: 'Recruiter' };
      parts.push(res);
      if (a.as_open) parts.push({ who: 'Candidate', what: `${a.as_open} assessment`, group: 'Candidate' });
      return { who: parts.map((p) => p.who).join(' + '), what: parts.map((p) => p.what).join(' · '), group: parts[0].group };
    }
    case 'Offered':
      if (a.jn_status && ['Expected', 'Confirmed'].includes(a.jn_status)) return { who: 'Candidate', what: `Joining${a.jn_date ? ' on ' + fmt(a.jn_date) : ''}`, group: 'Candidate' };
      if (a.of_status === 'Draft') return { who: 'Recruiter', what: 'Finalise and send offer for approval', group: 'Recruiter' };
      if (a.of_status === 'Pending Approval') return { who: 'Authorized signatory', what: 'Offer approval and signature', group: 'Authorized signatory' };
      if (['Approved', 'Sent', 'Negotiation'].includes(a.of_status)) return { who: 'Candidate', what: a.of_status === 'Negotiation' ? 'Negotiating the offer' : 'Offer acceptance', group: 'Candidate' };
      if (a.of_status === 'Accepted') return { who: 'Recruiter', what: 'Create joining record', group: 'Recruiter' };
      return { who: 'Recruiter', what: 'Create offer', group: 'Recruiter' };
    default: return { who: '—', what: '', group: 'Recruiter' };
  }
}

// Every open application with the facts pendingWith() needs. Rejected / Withdrawn / Joined are not "in pipeline".
async function loadPipeline(dbAll, { vacancyId } = {}) {
  const rows = await dbAll(`
    SELECT a.id AS application_id, a.status, a.created_at, a.updated_at, a.candidate_id, a.vacancy_id,
           c.full_name AS candidate, c.candidate_code, c.mobile,
           v.title AS vacancy, v.company, v.location, v.job_type, v.vacancy_code,
           u.full_name AS recruiter,
           (SELECT status FROM interviews i WHERE i.application_id = a.id AND i.is_deleted = 0 AND i.status != 'Cancelled' ORDER BY i.round DESC, i.created_at DESC LIMIT 1) AS iv_status,
           (SELECT scheduled_date FROM interviews i WHERE i.application_id = a.id AND i.is_deleted = 0 AND i.status != 'Cancelled' ORDER BY i.round DESC, i.created_at DESC LIMIT 1) AS iv_date,
           (SELECT round FROM interviews i WHERE i.application_id = a.id AND i.is_deleted = 0 AND i.status != 'Cancelled' ORDER BY i.round DESC, i.created_at DESC LIMIT 1) AS iv_round,
           (SELECT interviewer FROM interviews i WHERE i.application_id = a.id AND i.is_deleted = 0 AND i.status != 'Cancelled' ORDER BY i.round DESC, i.created_at DESC LIMIT 1) AS iv_interviewer,
           (SELECT recommendation FROM interviews i WHERE i.application_id = a.id AND i.is_deleted = 0 AND i.status != 'Cancelled' ORDER BY i.round DESC, i.created_at DESC LIMIT 1) AS iv_reco,
           (SELECT scorecard_submitted_at FROM interviews i WHERE i.application_id = a.id AND i.is_deleted = 0 AND i.status != 'Cancelled' ORDER BY i.round DESC, i.created_at DESC LIMIT 1) AS iv_scored,
           (SELECT group_concat(DISTINCT CASE assessment_type WHEN 'Plant PRO SRT' THEN 'SRT' ELSE assessment_type END) FROM assessments s WHERE s.candidate_id = a.candidate_id AND s.is_deleted = 0 AND s.status IN ('Pending','Sent') AND (s.vacancy_id IS NULL OR s.vacancy_id = a.vacancy_id)) AS as_open,
           (SELECT status FROM offers o WHERE o.application_id = a.id AND o.is_deleted = 0 AND o.status NOT IN ('Declined','Withdrawn') ORDER BY o.created_at DESC LIMIT 1) AS of_status,
           (SELECT status FROM joining j WHERE j.application_id = a.id AND j.is_deleted = 0 ORDER BY j.created_at DESC LIMIT 1) AS jn_status,
           (SELECT expected_date FROM joining j WHERE j.application_id = a.id AND j.is_deleted = 0 ORDER BY j.created_at DESC LIMIT 1) AS jn_date
    FROM applications a
    JOIN candidates c ON c.id = a.candidate_id AND c.is_deleted = 0
    JOIN vacancies v ON v.id = a.vacancy_id AND v.is_deleted = 0 AND v.status NOT IN ('Closed','Closed Internally','Cancelled')
    LEFT JOIN users u ON u.id = v.assigned_recruiter_id
    WHERE a.is_deleted = 0 AND a.status IN ('Sourced','Screening','Shortlisted','Interview','Offered')
      ${vacancyId ? 'AND a.vacancy_id = ?' : ''}
    ORDER BY v.company, v.title, c.full_name`, vacancyId ? [vacancyId] : []);
  const now = Date.now();
  return rows.map((r) => {
    const p = pendingWith(r);
    const days = Math.max(0, Math.floor((now - new Date(String(r.updated_at || r.created_at).replace(' ', 'T') + 'Z').getTime()) / 86400000));
    return { ...r, pending_who: p.who, pending_what: p.what, pending_group: p.group, days_in_stage: Number.isFinite(days) ? days : 0 };
  });
}
module.exports = { pendingWith, loadPipeline };
