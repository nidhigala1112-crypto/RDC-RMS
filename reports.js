// Custom reports: the admin picks a report type and which columns to include,
// then previews it on screen or downloads it as Excel. Each report is a base
// query (with the joins that turn IDs into names) plus a catalogue of columns.

const REPORTS = {
  vacancies: {
    label: 'Vacancies',
    from: `vacancies t
      LEFT JOIN users ru ON ru.id = t.assigned_recruiter_id`,
    where: 't.is_deleted = 0',
    dateField: 't.created_at',
    statusField: 't.status',
    order: 't.created_at DESC',
    columns: [
      ['vacancy_code', 'Vacancy Code', 't.vacancy_code'],
      ['title', 'Vacancy', 't.title'],
      ['company', 'Company', 't.company'],
      ['location', 'Location', 't.location'],
      ['job_type', 'Job Type', 't.job_type'],
      ['vacancy_reason', 'Reason for Vacancy', 't.vacancy_reason'],
      ['reason_details', 'Reason Details', 't.reason_details'],
      ['priority', 'Priority', 't.priority'],
      ['received_from', 'Raised By', 't.received_from'],
      ['date_received', 'Date Raised', 't.date_received'],
      ['recruiter', 'Assigned Recruiter', 'ru.full_name'],
      ['ctc_min', 'CTC Min', 't.ctc_min'],
      ['ctc_max', 'CTC Max', 't.ctc_max'],
      ['positions_required', 'Positions Required', 't.positions_required'],
      ['positions_filled', 'Positions Filled', 't.positions_filled'],
      ['positions_remaining', 'Positions Remaining', 'MAX(COALESCE(t.positions_required,0) - COALESCE(t.positions_filled,0), 0)'],
      ['status', 'Status', 't.status'],
      ['closure_reason', 'Closure Reason', 't.closure_reason'],
      ['created_at', 'Created On', 't.created_at'],
      ['closed_at', 'Closed On', 't.closed_at'],
      ['tat_days', 'TAT (days)', `CAST(ROUND(julianday(COALESCE(t.closed_at, date('now'))) - julianday(COALESCE(NULLIF(t.date_received,''), t.created_at))) AS INTEGER)`]
    ]
  },
  candidates: {
    label: 'Candidates',
    from: 'candidates t',
    where: 't.is_deleted = 0',
    dateField: 't.created_at',
    statusField: 't.status',
    order: 't.created_at DESC',
    columns: [
      ['candidate_code', 'Candidate Code', 't.candidate_code'],
      ['full_name', 'Name', 't.full_name'],
      ['mobile', 'Mobile', 't.mobile'],
      ['email', 'Email', 't.email'],
      ['date_of_birth', 'Date of Birth', 't.date_of_birth'],
      ['current_location', 'Current Location', 't.current_location'],
      ['preferred_location', 'Preferred Location', 't.preferred_location'],
      ['total_experience', 'Total Experience', 't.total_experience'],
      ['relevant_experience', 'Relevant Experience', 't.relevant_experience'],
      ['current_company', 'Current Company', 't.current_company'],
      ['current_designation', 'Current Designation', 't.current_designation'],
      ['current_ctc', 'Current CTC', 't.current_ctc'],
      ['expected_ctc', 'Expected CTC', 't.expected_ctc'],
      ['notice_period', 'Notice Period', 't.notice_period'],
      ['qualification', 'Qualification', 't.qualification'],
      ['source', 'Source', 't.source'],
      ['status', 'Status', 't.status'],
      ['date_added', 'Date Added', 't.date_added'],
      ['remarks', 'Remarks', 't.remarks']
    ]
  },
  applications: {
    label: 'Applications (candidate pipeline)',
    from: `applications t
      LEFT JOIN candidates c ON c.id = t.candidate_id
      LEFT JOIN vacancies v ON v.id = t.vacancy_id
      LEFT JOIN users ru ON ru.id = t.recruiter_id`,
    where: 't.is_deleted = 0',
    dateField: 't.created_at',
    statusField: 't.status',
    order: 't.created_at DESC',
    columns: [
      ['candidate', 'Candidate', 'c.full_name'],
      ['mobile', 'Mobile', 'c.mobile'],
      ['email', 'Email', 'c.email'],
      ['vacancy', 'Vacancy', 'v.title'],
      ['company', 'Company', 'v.company'],
      ['location', 'Location', 'v.location'],
      ['recruiter', 'Recruiter', 'ru.full_name'],
      ['match_score', 'Match Score', 't.match_score'],
      ['manual_score', 'Manual Score', 't.manual_score'],
      ['status', 'Status', 't.status'],
      ['rejection_reason', 'Rejection Reason', 't.rejection_reason'],
      ['created_at', 'Applied On', 't.created_at']
    ]
  },
  interviews: {
    label: 'Interviews',
    from: `interviews t
      LEFT JOIN candidates c ON c.id = t.candidate_id
      LEFT JOIN vacancies v ON v.id = t.vacancy_id`,
    where: 't.is_deleted = 0',
    dateField: 't.scheduled_date',
    statusField: 't.status',
    order: 't.scheduled_date DESC',
    columns: [
      ['candidate', 'Candidate', 'c.full_name'],
      ['mobile', 'Mobile', 'c.mobile'],
      ['vacancy', 'Vacancy', 'v.title'],
      ['company', 'Company', 'v.company'],
      ['round', 'Round', 't.round'],
      ['interviewer', 'Interviewer', 't.interviewer'],
      ['interviewer_email', 'Interviewer Email', 't.interviewer_email'],
      ['type', 'Type', 't.type'],
      ['scheduled_date', 'Date', 't.scheduled_date'],
      ['scheduled_time', 'Time', 't.scheduled_time'],
      ['meeting_link', 'Meeting Link', 't.meeting_link'],
      ['status', 'Status', 't.status'],
      ['rating', 'Average Rating', 't.rating'],
      ['sc_knowledge', 'Score: Role Knowledge', `json_extract(t.scorecard, '$.scores.knowledge')`],
      ['sc_experience', 'Score: Relevant Experience', `json_extract(t.scorecard, '$.scores.experience')`],
      ['sc_problem_solving', 'Score: Problem Solving', `json_extract(t.scorecard, '$.scores.problem_solving')`],
      ['sc_communication', 'Score: Communication', `json_extract(t.scorecard, '$.scores.communication')`],
      ['sc_learnability', 'Score: Learnability', `json_extract(t.scorecard, '$.scores.learnability')`],
      ['sc_energy', 'Score: Energy and Enthusiasm', `json_extract(t.scorecard, '$.scores.energy')`],
      ['sc_selling', 'Score: Selling Skills', `json_extract(t.scorecard, '$.scores.selling')`],
      ['sc_overall', 'Score: Overall', `json_extract(t.scorecard, '$.scores.overall')`],
      ['sc_leadership', 'Score: Leadership', `json_extract(t.scorecard, '$.scores.leadership')`],
      ['sc_culture', 'Score: Attitude & Culture Fit', `json_extract(t.scorecard, '$.scores.culture')`],
      ['srt_result', 'Plant PRO SRT: Score / Result', `(SELECT a.score FROM assessments a WHERE a.is_deleted = 0 AND a.candidate_id = t.candidate_id AND a.assessment_type = 'Plant PRO SRT' AND (a.vacancy_id IS NULL OR a.vacancy_id = '' OR a.vacancy_id = t.vacancy_id) ORDER BY a.created_at DESC LIMIT 1)`],
      ['srt_status', 'Plant PRO SRT: Status', `(SELECT a.status FROM assessments a WHERE a.is_deleted = 0 AND a.candidate_id = t.candidate_id AND a.assessment_type = 'Plant PRO SRT' AND (a.vacancy_id IS NULL OR a.vacancy_id = '' OR a.vacancy_id = t.vacancy_id) ORDER BY a.created_at DESC LIMIT 1)`],
      ['disc_result', 'DISC: Score / Result', `(SELECT a.score FROM assessments a WHERE a.is_deleted = 0 AND a.candidate_id = t.candidate_id AND a.assessment_type = 'DISC' AND (a.vacancy_id IS NULL OR a.vacancy_id = '' OR a.vacancy_id = t.vacancy_id) ORDER BY a.created_at DESC LIMIT 1)`],
      ['disc_status', 'DISC: Status', `(SELECT a.status FROM assessments a WHERE a.is_deleted = 0 AND a.candidate_id = t.candidate_id AND a.assessment_type = 'DISC' AND (a.vacancy_id IS NULL OR a.vacancy_id = '' OR a.vacancy_id = t.vacancy_id) ORDER BY a.created_at DESC LIMIT 1)`],
      ['sc_strengths', 'Strengths', `json_extract(t.scorecard, '$.strengths')`],
      ['sc_concerns', 'Concerns', `json_extract(t.scorecard, '$.concerns')`],
      ['recommendation', 'Recommendation', 't.recommendation'],
      ['hire_type', 'Hire as (On Roll / Off Roll / FTC / Retainer)', 't.hire_type'],
      ['feedback', 'Feedback', 't.feedback']
    ]
  },
  offers: {
    label: 'Offers',
    from: `offers t
      LEFT JOIN candidates c ON c.id = t.candidate_id
      LEFT JOIN vacancies v ON v.id = t.vacancy_id`,
    where: 't.is_deleted = 0',
    dateField: 't.offer_date',
    statusField: 't.status',
    order: 't.created_at DESC',
    columns: [
      ['candidate', 'Candidate', 'c.full_name'],
      ['mobile', 'Mobile', 'c.mobile'],
      ['vacancy', 'Vacancy', 'v.title'],
      ['company', 'Company', 'v.company'],
      ['location', 'Location', 'v.location'],
      ['offered_ctc', 'Offered CTC', 't.offered_ctc'],
      ['fixed_component', 'Fixed', 't.fixed_component'],
      ['variable_component', 'Variable', 't.variable_component'],
      ['joining_bonus', 'Joining Bonus', 't.joining_bonus'],
      ['offer_date', 'Offer Date', 't.offer_date'],
      ['valid_till', 'Valid Till', 't.valid_till'],
      ['expected_joining', 'Expected Joining', 't.expected_joining'],
      ['status', 'Status', 't.status'],
      ['letter_sent', 'Appointment Letter Sent', `CASE WHEN t.letter_sent = 1 THEN 'Yes' ELSE 'No' END`]
    ]
  },
  assessments: {
    label: 'Assessments (Plant PRO SRT / DISC)',
    from: `assessments t
      LEFT JOIN candidates c ON c.id = t.candidate_id
      LEFT JOIN vacancies v ON v.id = t.vacancy_id`,
    where: 't.is_deleted = 0',
    dateField: 't.assessment_date',
    statusField: 't.status',
    order: 't.created_at DESC',
    columns: [
      ['candidate', 'Candidate', 'c.full_name'],
      ['mobile', 'Mobile', 'c.mobile'],
      ['vacancy', 'Vacancy', 'v.title'],
      ['company', 'Company', 'v.company'],
      ['assessment_type', 'Assessment', 't.assessment_type'],
      ['status', 'Status', 't.status'],
      ['assessment_date', 'Date', 't.assessment_date'],
      ['score', 'Score / Result', 't.score'],
      ['result_summary', 'Summary', 't.result_summary'],
      ['report_link', 'Report Link', 't.report_link'],
      ['remarks', 'Remarks', 't.remarks']
    ]
  },
  joining: {
    label: 'Joinings',
    from: `joining t
      LEFT JOIN candidates c ON c.id = t.candidate_id
      LEFT JOIN vacancies v ON v.id = t.vacancy_id`,
    where: 't.is_deleted = 0',
    dateField: 't.expected_date',
    statusField: 't.status',
    order: 't.expected_date ASC',
    columns: [
      ['candidate', 'Name', 'c.full_name'],
      ['designation', 'Designation', 'v.title'],
      ['company', 'Company', 'v.company'],
      ['location', 'Location', `COALESCE(NULLIF(t.joining_location, ''), v.location)`],
      ['expected_date', 'Tentative DOJ', 't.expected_date'],
      ['actual_date', 'Actual DOJ', 't.actual_date'],
      ['mobile', 'Contact No.', 'c.mobile'],
      ['email', 'Email', 'c.email'],
      ['status', 'Status', 't.status'],
      ['offered_ctc', 'Offered CTC', 't.offered_ctc'],
      ['joined_ctc', 'Joined CTC', 't.joined_ctc'],
      ['reporting_manager', 'Reporting Manager', 't.reporting_manager'],
      ['documents_pending', 'Documents Pending', 't.documents_pending'],
      ['drop_reason', 'Drop Reason', 't.drop_reason']
    ]
  }
};

function catalogue() {
  return Object.entries(REPORTS).map(([key, r]) => ({
    key,
    label: r.label,
    columns: r.columns.map(([k, label]) => ({ key: k, label }))
  }));
}

// Runs a report. `columns` is the ordered list of column keys the admin ticked.
async function runReport(dbAll, { report, columns, status, from, to }) {
  const def = REPORTS[report];
  if (!def) throw new Error('Unknown report type.');
  const byKey = new Map(def.columns.map((c) => [c[0], c]));
  const chosen = (Array.isArray(columns) ? columns : []).filter((k) => byKey.has(k));
  if (!chosen.length) throw new Error('Pick at least one column for the report.');

  // Only whitelisted expressions from REPORTS are ever put into the SQL text.
  const select = chosen.map((k, i) => `${byKey.get(k)[2]} AS c${i}`).join(', ');
  const clauses = [def.where];
  const params = [];
  if (status) { clauses.push(`${def.statusField} = ?`); params.push(status); }
  if (from) { clauses.push(`date(${def.dateField}) >= date(?)`); params.push(from); }
  if (to) { clauses.push(`date(${def.dateField}) <= date(?)`); params.push(to); }

  const raw = await dbAll(`SELECT ${select} FROM ${def.from} WHERE ${clauses.join(' AND ')} ORDER BY ${def.order}`, params);
  const headers = chosen.map((k) => byKey.get(k)[1]);
  const rows = raw.map((r) => chosen.map((_, i) => (r[`c${i}`] === null || r[`c${i}`] === undefined ? '' : r[`c${i}`])));
  return { headers, rows };
}

module.exports = { catalogue, runReport, REPORTS };
