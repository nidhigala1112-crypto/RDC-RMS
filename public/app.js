/* ==========================================================================
   RDC's Recruitment Management System — frontend
   Vanilla JS, no build step. Talks to the existing Express/session API.
   A single config-driven CRUD engine (ENTITIES) drives every list + form,
   so adding a new table to the tracker means adding a config block here,
   not writing a new page.
   ========================================================================== */
(() => {
  const API = '/api';

  /* ---------------- API helper ---------------- */
  async function api(path, opts = {}) {
    const isForm = opts.body instanceof FormData;
    const res = await fetch(API + path, {
      credentials: 'include',
      headers: isForm || !opts.body ? undefined : { 'Content-Type': 'application/json' },
      method: opts.method || 'GET',
      body: isForm || !opts.body ? opts.body : JSON.stringify(opts.body)
    });
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (res.status === 401 && state.user) {
      state.user = null;
      showLogin('Your session expired — please sign in again.');
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || res.statusText || 'Request failed');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function todayStr() { return new Date().toISOString().slice(0, 10); }

  function vacancyTat(vacancy) {
    const from = vacancy.date_received || vacancy.created_at;
    if (!from) return '—';
    const start = new Date(from);
    const end = vacancy.closed_at ? new Date(vacancy.closed_at) : new Date();
    const days = Math.max(Math.round((end - start) / (1000 * 60 * 60 * 24)), 0);
    return vacancy.closed_at ? `${days}` : `${days} (open)`;
  }

  /* ---------------- Relation label resolution ---------------- */
  const labelCache = {};
  function labelFor(table, rec) {
    if (!rec) return '';
    switch (table) {
      case 'clients': return rec.company_name || '—';
      case 'interviewers': return rec.name || '—';
      case 'signatories': return rec.name || '—';
      case 'vacancies': return [rec.vacancy_code, rec.title].filter(Boolean).join(' · ') || '—';
      case 'candidates': return [rec.full_name, rec.candidate_code ? `(${rec.candidate_code})` : ''].filter(Boolean).join(' ') || '—';
      case 'users': return rec.full_name || rec.username || '—';
      case 'jds': return rec.title || '—';
      default: return rec.name || rec.title || rec.id;
    }
  }
  async function resolveLabel(table, id) {
    if (!id) return '';
    labelCache[table] = labelCache[table] || {};
    if (labelCache[table][id] !== undefined) return labelCache[table][id];
    try {
      const rec = await api(`/${table}/${id}`);
      const label = labelFor(table, rec);
      labelCache[table][id] = label;
      return label;
    } catch {
      labelCache[table][id] = '—';
      return '—';
    }
  }

  /* ---------------- Tag styling ---------------- */
  const TAG_MAPS = {
    'vacancies.status': { Open: 'ok', 'On Hold': 'warn', Closed: 'neutral', 'Closed Internally': 'neutral', Cancelled: 'danger' },
    'vacancies.priority': { Urgent: 'danger', High: 'warn', Medium: 'info', Low: 'neutral' },
    'candidates.status': { Active: 'ok', Passive: 'neutral', Placed: 'info', 'Not Interested': 'neutral', Blacklisted: 'danger' },
    'candidates.stage': { Sourced: 'neutral', Screening: 'neutral', Shortlisted: 'info', Interview: 'warn', Offered: 'ok', Joined: 'ok', Rejected: 'danger', Withdrawn: 'neutral' },
    'interviews.app_stage': { Sourced: 'neutral', Screening: 'neutral', Shortlisted: 'info', Interview: 'warn', Offered: 'ok', Joined: 'ok', Rejected: 'danger', Withdrawn: 'neutral' },
    'offers.app_stage': { Sourced: 'neutral', Screening: 'neutral', Shortlisted: 'info', Interview: 'warn', Offered: 'ok', Joined: 'ok', Rejected: 'danger', Withdrawn: 'neutral' },
    'joining.app_stage': { Sourced: 'neutral', Screening: 'neutral', Shortlisted: 'info', Interview: 'warn', Offered: 'ok', Joined: 'ok', Rejected: 'danger', Withdrawn: 'neutral' },
    'assessments.app_stage': { Sourced: 'neutral', Screening: 'neutral', Shortlisted: 'info', Interview: 'warn', Offered: 'ok', Joined: 'ok', Rejected: 'danger', Withdrawn: 'neutral' },
    'applications.status': { Sourced: 'neutral', Screening: 'neutral', Shortlisted: 'info', Interview: 'warn', Offered: 'ok', Joined: 'ok', Rejected: 'danger', Withdrawn: 'neutral' },
    'applications.client_status': { 'Not Submitted': 'neutral', Submitted: 'info', 'Client Shortlisted': 'ok', 'Client Rejected': 'danger', 'On Hold': 'warn' },
    'assessments.status': { Pending: 'neutral', Sent: 'info', Completed: 'ok', 'Not Required': 'neutral' },
    'interviews.status': { Scheduled: 'info', Confirmed: 'ok', Completed: 'ok', 'No Show': 'danger', Cancelled: 'neutral', Rescheduled: 'warn' },
    'offers.status': { Draft: 'neutral', Sent: 'info', Negotiation: 'warn', Accepted: 'ok', Declined: 'danger', Withdrawn: 'neutral' },
    'joining.status': { Expected: 'info', Confirmed: 'ok', Joined: 'ok', Dropped: 'danger', Deferred: 'warn' },
    'users.role': { super_admin: 'info', hr_manager: 'info', recruiter: 'neutral', viewer: 'neutral' }
  };
  function tagHtml(entityTable, field, value) {
    if (value === null || value === undefined || value === '') return '<span class="text-muted">—</span>';
    const cls = (TAG_MAPS[`${entityTable}.${field}`] || {})[value] || 'neutral';
    return `<span class="tag tag-${cls}">${escapeHtml(String(value))}</span>`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------------- Entity configs ---------------- */
  const ENUM = {
    company: ['RDC Concrete India Limited', 'Ultrafine Mineral & Admixture Pvt. Limited', 'ROBO Silicon Pvt Ltd'],
    vacancyStatus: ['Open', 'On Hold', 'Closed', 'Closed Internally', 'Cancelled'],
    priority: ['Low', 'Medium', 'High', 'Urgent'],
    jobType: ['Retainer', 'Fixed Term', 'Off Role', 'Trainee', 'Full Time'],
    vacancyReason: ['New Position', 'Replacement', 'Additional Headcount', 'Backfill (transfer / promotion)', 'Other'],
    candidateStatus: ['Active', 'Passive', 'Placed', 'Not Interested', 'Blacklisted'],
    appStatus: ['Sourced', 'Screening', 'Shortlisted', 'Interview', 'Offered', 'Joined', 'Rejected', 'Withdrawn'],
    clientStatus: ['Not Submitted', 'Submitted', 'Client Shortlisted', 'Client Rejected', 'On Hold'],
    interviewType: ['Video', 'Phone', 'In-person', 'Panel'],
    interviewStatus: ['Scheduled', 'Confirmed', 'Completed', 'No Show', 'Cancelled', 'Rescheduled'],
    recommendation: ['Proceed', 'Hold', 'Reject'],
    hireType: ['On Roll', 'Off Roll', 'Fixed Term Contract', 'Retainer Contract'],
    offerStatus: ['Draft', 'Pending Approval', 'Changes Requested', 'Approved', 'Sent', 'Negotiation', 'Accepted', 'Declined', 'Withdrawn'],
    joiningStatus: ['Expected', 'Confirmed', 'Joined', 'Dropped', 'Deferred'],
    entityType: ['candidate', 'vacancy', 'client', 'application'],
    role: ['super_admin', 'hr_manager', 'recruiter', 'viewer']
  };

  const ENTITIES = {
    clients: {
      table: 'clients', title: 'Companies', singular: 'Company',
      exportUrl: '/clients/export',
      searchPlaceholder: 'Search company name, location…',
      note: 'These are your group companies, used to fill in details on generated Appointment Letters. Signatory name/designation appear on the letter\'s signature block for that company.',
      columns: [
        { key: 'company_name', label: 'Company' },
        { key: 'cin', label: 'CIN', mono: true },
        { key: 'phone', label: 'Phone', mono: true },
        { key: 'email', label: 'Email' },
        { key: 'signatory_name', label: 'Signatory' },
        { key: 'is_active', label: 'Active', type: 'bool' }
      ],
      fields: [
        { key: 'company_name', label: 'Company name', type: 'text', required: true },
        { key: 'registered_address', label: 'Registered address', type: 'textarea' },
        { key: 'cin', label: 'CIN', type: 'text' },
        { key: 'phone', label: 'Phone', type: 'text' },
        { key: 'email', label: 'Email', type: 'email' },
        { key: 'website', label: 'Website', type: 'text' },
        { key: 'signatory_name', label: 'Signatory name (for letters)', type: 'text' },
        { key: 'signatory_designation', label: 'Signatory designation', type: 'text' },
        { key: 'signatory_email', label: 'Authorized signatory email', type: 'email', hint: 'Offers for this company are sent here for approval and e-signature before the appointment letter goes to the candidate.' },
        { key: 'onboarding_form_link', label: 'Onboarding form link', type: 'text', hint: 'Optional and no longer needed — appointment-letter emails now carry the built-in onboarding form. This is only a fallback if the built-in form is ever unavailable.' },
        { key: 'contact_person', label: 'HR contact person', type: 'text' },
        { key: 'location', label: 'Location', type: 'text' },
        { key: 'account_owner_id', label: 'Account owner', type: 'relation', relation: 'users' },
        { key: 'notes', label: 'Notes', type: 'textarea' },
        { key: 'is_active', label: 'Active', type: 'bool', default: true }
      ]
    },
    interviewers: {
      table: 'interviewers', title: 'Interviewers', singular: 'Interviewer', writeRoles: ['super_admin', 'hr_manager'],
      searchPlaceholder: 'Search name, employee code, designation, city…',
      filters: [{ key: 'is_active', label: 'Active', options: ['1', '0'], optionLabels: ['Active', 'Inactive'] }],
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'employee_code', label: 'Emp. code', mono: true },
        { key: 'designation', label: 'Designation' },
        { key: 'city', label: 'City' },
        { key: 'email', label: 'Email' },
        { key: 'is_active', label: 'Active', type: 'bool' }
      ],
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'employee_code', label: 'Employee code', type: 'text' },
        { key: 'designation', label: 'Designation', type: 'text' },
        { key: 'company', label: 'Company', type: 'select', options: ENUM.company },
        { key: 'city', label: 'City', type: 'text' },
        { key: 'location', label: 'Plant / location', type: 'text', list: 'plant_locations' },
        { key: 'email', label: 'Email', type: 'email', hint: 'The interview invite and scorecard link are sent here. Enter once; it fills in automatically afterwards.' },
        { key: 'phone', label: 'Phone', type: 'text' },
        { key: 'is_active', label: 'Active', type: 'bool', default: true }
      ]
    },
    signatories: {
      table: 'signatories', title: 'Authorized Signatories', singular: 'Signatory', writeRoles: ['super_admin', 'hr_manager'],
      note: 'The people who approve and sign offers. When a recruiter presses "Send for approval" on an offer, they choose from this list (signatories for that offer\'s company, plus any marked "All companies").',
      searchPlaceholder: 'Search name, designation, email…',
      filters: [{ key: 'is_active', label: 'Active', options: ['1', '0'], optionLabels: ['Active', 'Inactive'] }],
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'designation', label: 'Designation' },
        { key: 'email', label: 'Email' },
        { key: 'company', label: 'For company', render: (r) => r.company || 'All companies' },
        { key: 'is_active', label: 'Active', type: 'bool' }
      ],
      fields: [
        { key: 'name', label: 'Name (as it appears on the letter)', type: 'text', required: true },
        { key: 'designation', label: 'Designation', type: 'text', hint: 'e.g. Director, Chief Human Resources Officer' },
        { key: 'email', label: 'Email', type: 'email', required: true, hint: 'The approval request and private signing link are sent here.' },
        { key: 'company', label: 'For company', type: 'select', options: ENUM.company, hint: 'Leave empty if this person can sign for any of the three companies.' },
        { key: 'is_active', label: 'Active', type: 'bool', default: true }
      ]
    },
    jds: {
      table: 'jds', title: 'Job Descriptions', singular: 'Job description',
      exportUrl: '/jds/export',
      searchPlaceholder: 'Search JD title, qualification…',
      filters: [{ key: 'company', label: 'Company', options: ENUM.company }],
      columns: [
        { key: 'title', label: 'Title' },
        { key: 'company', label: 'Company' },
        { key: 'qualification', label: 'Qualification' },
        { key: 'experience_min', label: 'Exp min' },
        { key: 'experience_max', label: 'Exp max' },
        { key: 'version', label: 'Version', mono: true }
      ],
      fields: [
        { key: 'title', label: 'Title', type: 'text', required: true },
        { key: 'company', label: 'Company', type: 'select', options: ENUM.company },
        { key: 'summary', label: 'Summary', type: 'textarea' },
        { key: 'responsibilities', label: 'Responsibilities', type: 'textarea' },
        { key: 'required_skills', label: 'Required skills (comma separated)', type: 'tags' },
        { key: 'preferred_skills', label: 'Preferred skills (comma separated)', type: 'tags' },
        { key: 'experience_min', label: 'Experience min (yrs)', type: 'number' },
        { key: 'experience_max', label: 'Experience max (yrs)', type: 'number' },
        { key: 'qualification', label: 'Qualification', type: 'text' },
        { key: 'other_requirements', label: 'Other requirements', type: 'textarea' }
      ]
    },
    vacancies: {
      table: 'vacancies', title: 'Vacancies', singular: 'Vacancy',
      searchPlaceholder: 'Search title, code, location…',
      exportUrl: '/vacancies/export',
      filters: [
        { key: 'company', label: 'Company', options: ENUM.company },
        { key: 'status', label: 'Status', options: ENUM.vacancyStatus },
        { key: 'priority', label: 'Priority', options: ENUM.priority }
      ],
      columns: [
        { key: 'vacancy_code', label: 'Code', mono: true },
        { key: 'title', label: 'Title' },
        { key: 'company', label: 'Company' },
        { key: 'location', label: 'Location' },
        { key: 'assigned_recruiter_id', label: 'Recruiter', type: 'relation', relation: 'users' },
        { key: 'priority', label: 'Priority', type: 'tag' },
        { key: 'positions_filled', label: 'Filled', mono: true, render: (r) => `${r.positions_filled}/${r.positions_required}` },
        { key: 'date_received', label: 'Date received', type: 'date' },
        { key: 'tat', label: 'TAT (days)', mono: true, render: (r) => vacancyTat(r) },
        { key: 'status', label: 'Status', type: 'tag' }
      ],
      fields: [
        { key: 'title', label: 'Title', type: 'text', required: true },
        { key: 'company', label: 'Company', type: 'select', options: ENUM.company, required: true },
        { key: 'received_from', label: 'Raised by (manager/department)', type: 'text', list: 'raised_by', hint: 'Pick from the list, or type a new one. Admins manage the list under Admin → Master lists.' },
        { key: 'date_received', label: 'Date received', type: 'date', required: true },
        { key: 'vacancy_reason', label: 'Reason for adding this vacancy', type: 'select', options: ENUM.vacancyReason, required: true, hint: 'Why is this position being raised?' },
        { key: 'reason_details', label: 'Reason details', type: 'text', hint: 'For a replacement: who is being replaced (name / code) and why they are leaving. For others: a line of justification, e.g. new line, expansion, approved budget.' },
        { key: 'location', label: 'Location (plant)', type: 'text', list: 'plant_locations' },
        { key: 'ctc_min', label: 'CTC min (LPA)', type: 'number' },
        { key: 'ctc_max', label: 'CTC max (LPA)', type: 'number' },
        { key: 'job_type', label: 'Job type', type: 'select', options: ENUM.jobType },
        { key: 'priority', label: 'Priority', type: 'select', options: ENUM.priority },
        { key: 'jd_id', label: 'Job description (JD)', type: 'relation', relation: 'jds', hint: 'Tagging a JD here lets the app score candidates against it once you link them via Applications.' },
        { key: 'positions_required', label: 'Positions required', type: 'number', default: 1 },
        { key: 'assigned_recruiter_id', label: 'Assigned recruiter', type: 'relation', relation: 'users', required: true, hint: 'Every application, interview and offer for this vacancy follows this recruiter.' },
        { key: 'status', label: 'Status', type: 'select', options: ENUM.vacancyStatus },
        { key: 'closure_reason', label: 'Closure reason', type: 'text' }
      ]
    },
    candidates: {
      table: 'candidates', title: 'Candidates', singular: 'Candidate',
      hasResumeParse: true,
      searchPlaceholder: 'Search name, code, email, mobile…',
      filters: [{ key: 'status', label: 'Status', options: ENUM.candidateStatus }],
      hasResumes: true,
      hasApplications: true,
      exportUrl: '/candidates/export',
      columns: [
        { key: 'candidate_code', label: 'Code', mono: true },
        { key: 'full_name', label: 'Name' },
        { key: 'mobile', label: 'Mobile', mono: true },
        { key: 'current_location', label: 'Location' },
        { key: 'current_company', label: 'Current co.' },
        { key: 'expected_ctc', label: 'Exp. CTC', mono: true },
        { key: 'stage', label: 'Pipeline stage', type: 'tag' },
        { key: 'status', label: 'Status', type: 'tag' }
      ],
      fields: [
        { key: 'full_name', label: 'Full name', type: 'text', required: true },
        { key: 'mobile', label: 'Mobile', type: 'text' },
        { key: 'email', label: 'Email', type: 'email' },
        { key: 'date_of_birth', label: 'Date of birth', type: 'date', hint: 'Used for the onboarding form, the candidate report and age checks.' },
        { key: 'link_vacancy_id', label: 'Vacancy applied for', type: 'relation', relation: 'vacancies', createOnly: true, hint: 'Pick the vacancy now and the candidate is linked to it straight away — no need to open the candidate again. The vacancy\'s recruiter is applied automatically.' },
        { key: 'current_location', label: 'Current location', type: 'text' },
        { key: 'address', label: 'Full postal address (for appointment letters)', type: 'textarea' },
        { key: 'preferred_location', label: 'Preferred location', type: 'text' },
        { key: 'total_experience', label: 'Total experience (yrs)', type: 'number' },
        { key: 'relevant_experience', label: 'Relevant experience (yrs)', type: 'number' },
        { key: 'current_company', label: 'Current company', type: 'text' },
        { key: 'current_designation', label: 'Current designation', type: 'text' },
        { key: 'current_ctc', label: 'Current CTC (LPA)', type: 'number' },
        { key: 'expected_ctc', label: 'Expected CTC (LPA)', type: 'number' },
        { key: 'notice_period', label: 'Notice period (days)', type: 'number' },
        { key: 'qualification', label: 'Qualification', type: 'text' },
        { key: 'skills', label: 'Skills (comma separated)', type: 'tags' },
        { key: 'source', label: 'Source', type: 'text' },
        { key: 'linkedin_url', label: 'LinkedIn URL', type: 'text' },
        { key: 'status', label: 'Status', type: 'select', options: ENUM.candidateStatus },
        { key: 'remarks', label: 'Remarks', type: 'textarea' },
        { key: 'tags', label: 'Tags (comma separated)', type: 'tags' },
        { key: 'next_action', label: 'Next action', type: 'text' },
        { key: 'next_action_due', label: 'Next action due', type: 'date' },
        { key: 'next_action_assigned_id', label: 'Next action owner', type: 'relation', relation: 'users' }
      ]
    },
    applications: {
      table: 'applications', title: 'Applications', singular: 'Application',
      exportUrl: '/applications/export',
      hasScoreBreakdown: true,
      note: 'The match score compares the candidate\'s skills, experience and qualification against the JD tagged to this vacancy. It only appears once that vacancy has a JD tagged to it.',
      filters: [
        { key: 'status', label: 'Status', options: ENUM.appStatus }
      ],
      columns: [
        { key: 'candidate_id', label: 'Candidate', type: 'relation', relation: 'candidates' },
        { key: 'vacancy_id', label: 'Vacancy', type: 'relation', relation: 'vacancies' },
        { key: 'match_score', label: 'Score', mono: true },
        { key: 'status', label: 'Status', type: 'tag' },
        { key: 'created_at', label: 'Created', type: 'date' }
      ],
      fields: [
        { key: 'candidate_id', label: 'Candidate', type: 'relation', relation: 'candidates', required: true },
        { key: 'vacancy_id', label: 'Vacancy', type: 'relation', relation: 'vacancies', required: true },
        { key: 'recruiter_id', label: 'Recruiter', type: 'relation', relation: 'users' },
        { key: 'status', label: 'Status', type: 'select', options: ENUM.appStatus },
        { key: 'manual_score', label: 'Manual score override', type: 'number' },
        { key: 'score_override_reason', label: 'Score override reason', type: 'text' },
        { key: 'rejection_reason', label: 'Rejection reason', type: 'text' }
      ]
    },
    interviews: {
      table: 'interviews', title: 'Interviews', singular: 'Interview',
      hasBulkRounds: true,
      hasScorecard: true,
      exportUrl: '/interviews/export',
      hasMeetLink: true,
      note: 'Saving a scheduled interview emails the candidate and recruiter the details, and emails the interviewer the same invite with their private scorecard link — nothing separate to send. For a panel, use "Add another interviewer" on the form: each one gets their own invite and scorecard link, and the candidate gets a single invite. Video interviews get a Google Meet link automatically if Google Calendar is connected. A calendar invite (.ics) is attached so it lands in each person\'s calendar — rescheduling updates it and cancelling removes it. A reminder goes out the day before.',
      filters: [{ key: 'status', label: 'Status', options: ENUM.interviewStatus }],
      columns: [
        { key: 'candidate_id', label: 'Candidate', type: 'relation', relation: 'candidates' },
        { key: 'vacancy_id', label: 'Vacancy', type: 'relation', relation: 'vacancies' },
        { key: 'round', label: 'Rd', mono: true },
        { key: 'interviewer', label: 'Interviewer', html: true, render: (r) => `${escapeHtml(r.interviewer || '—')}${r.panel_id ? ' <span class="tag tag-neutral" title="One interview with several interviewers; each has their own scorecard">Panel</span>' : ''}` },
        { key: 'type', label: 'Type' },
        { key: 'scheduled_date', label: 'Date', type: 'date' },
        { key: 'scheduled_time', label: 'Time', mono: true },
        { key: 'app_stage', label: 'Pipeline stage', type: 'tag' },
        { key: 'status', label: 'Status', type: 'tag' },
        { key: 'rating', label: 'Rating', mono: true }
      ],
      fields: [
        { key: 'candidate_id', label: 'Candidate', type: 'relation', relation: 'candidates', required: true },
        { key: 'vacancy_id', label: 'Vacancy', type: 'relation', relation: 'vacancies', required: true },
        { key: 'round', label: 'Round', type: 'number', default: 1 },
        { key: 'interviewer', label: 'Interviewer', type: 'text' },
        { key: 'interviewer_email', label: 'Interviewer email', type: 'email', hint: 'The invite and scorecard link are emailed here. Leave blank and the interviewer gets nothing — you would have to share the link yourself.' },
        { key: 'type', label: 'Type', type: 'select', options: ENUM.interviewType },
        { key: 'scheduled_date', label: 'Scheduled date', type: 'date' },
        { key: 'scheduled_time', label: 'Scheduled time', type: 'time' },
        { key: 'meeting_link', label: 'Meeting link', type: 'text' },
        { key: 'location', label: 'Location', type: 'text', list: 'interview_locations', hint: 'Pick a saved place and its full address is filled in (it goes into the invite). Admins manage these under Admin → Master lists.' },
        { key: 'status', label: 'Status', type: 'select', options: ENUM.interviewStatus },
        { key: 'feedback', label: 'Feedback', type: 'textarea' },
        { key: 'rating', label: 'Average rating (0–5)', type: 'number', hint: 'Filled in automatically from the scorecard once you score the criteria below.' },
        { key: 'recommendation', label: 'Recommendation', type: 'select', options: ENUM.recommendation },
        { key: 'hire_type', label: 'Hire as', type: 'select', options: ENUM.hireType, hint: 'Engagement type the interviewer recommends: On Roll, Off Roll, Fixed Term Contract or Retainer Contract.' }
      ]
    },
    offers: {
      table: 'offers', title: 'Offers', singular: 'Offer',
      exportUrl: '/offers/export',
      hasAppointmentLetter: true,
      note: 'Enter the Annual CTC and click "Calculate breakdown" to fill in the rest automatically (per RDC\'s official slab structure). Use "Send for approval" lower down: the company\'s Authorized Signatory reviews and e-signs it, and the signed Appointment Letter is then emailed to the candidate, the vacancy\'s assigned recruiter, and anyone listed below — once per offer.',
      filters: [{ key: 'status', label: 'Status', options: ENUM.offerStatus }],
      columns: [
        { key: 'candidate_id', label: 'Candidate', type: 'relation', relation: 'candidates' },
        { key: 'vacancy_id', label: 'Vacancy', type: 'relation', relation: 'vacancies' },
        { key: 'offered_ctc', label: 'Annual CTC (₹)', mono: true },
        { key: 'offer_date', label: 'Offer date', type: 'date' },
        { key: 'app_stage', label: 'Pipeline stage', type: 'tag' },
        { key: 'status', label: 'Status', type: 'tag' }
      ],
      fields: [
        { key: 'candidate_id', label: 'Candidate', type: 'relation', relation: 'candidates', required: true },
        { key: 'vacancy_id', label: 'Vacancy', type: 'relation', relation: 'vacancies', required: true },
        { key: 'offered_ctc', label: 'Annual CTC (₹)', type: 'number', required: true, hint: 'Enter the full annual CTC in rupees (e.g. 550000, not 5.5) — the button below fills in the breakdown.' },
        { key: 'basic_pay', label: 'Basic Pay (₹/month)', type: 'number' },
        { key: 'hra', label: 'House Rent Allowance (₹/month)', type: 'number' },
        { key: 'special_allowance', label: 'Special Allowance (₹/month)', type: 'number' },
        { key: 'lta', label: 'LTA (₹/month)', type: 'number' },
        { key: 'employer_pf', label: 'Employer PF Contribution (₹/month)', type: 'number' },
        { key: 'gratuity', label: 'Gratuity (₹/month)', type: 'number' },
        { key: 'variable_component', label: 'Variable (₹/month)', type: 'number' },
        { key: 'joining_bonus', label: 'Joining bonus', type: 'number' },
        { key: 'benefits', label: 'Benefits', type: 'textarea' },
        { key: 'offer_date', label: 'Offer date', type: 'date' },
        { key: 'valid_till', label: 'Valid till', type: 'date' },
        { key: 'expected_joining', label: 'Expected joining', type: 'date' },
        { key: 'additional_recipients', label: 'Additional stakeholder emails', type: 'text', hint: 'Comma-separated, e.g. finance@rdc.in, coo@rdc.in — these get the appointment letter too.' },
        { key: 'letter_remarks', label: 'Appendix A remarks (optional)', type: 'textarea', hint: 'Shown below the compensation table on the letter, e.g. "Variable will be paid twice a year based on KPI achievement." Leave blank for no note.' },
        { key: 'status', label: 'Status', type: 'select', options: ENUM.offerStatus }
      ]
    },
    joining: {
      table: 'joining', title: 'Joining', singular: 'Joining record',
      exportUrl: '/joining/export',
      hasOnboarding: true,
      filters: [{ key: 'status', label: 'Status', options: ENUM.joiningStatus }],
      columns: [
        { key: 'candidate_id', label: 'Candidate', type: 'relation', relation: 'candidates' },
        { key: 'vacancy_id', label: 'Vacancy', type: 'relation', relation: 'vacancies' },
        { key: 'expected_date', label: 'Expected', type: 'date' },
        { key: 'actual_date', label: 'Actual', type: 'date' },
        { key: 'app_stage', label: 'Pipeline stage', type: 'tag' },
        { key: 'status', label: 'Status', type: 'tag' }
      ],
      fields: [
        { key: 'candidate_id', label: 'Candidate', type: 'relation', relation: 'candidates', required: true },
        { key: 'vacancy_id', label: 'Vacancy', type: 'relation', relation: 'vacancies', required: true },
        { key: 'expected_date', label: 'Expected date', type: 'date', required: true },
        { key: 'actual_date', label: 'Actual date', type: 'date' },
        { key: 'status', label: 'Status', type: 'select', options: ENUM.joiningStatus },
        { key: 'offered_ctc', label: 'Offered CTC', type: 'number' },
        { key: 'joined_ctc', label: 'Joined CTC', type: 'number' },
        { key: 'joining_location', label: 'Joining location', type: 'text', list: 'plant_locations' },
        { key: 'reporting_manager', label: 'Reporting manager', type: 'text' },
        { key: 'documents_pending', label: 'Documents pending', type: 'text' },
        { key: 'drop_reason', label: 'Drop reason', type: 'text' }
      ],
      note: 'Marking a record “Joined” automatically updates the vacancy’s filled count, and closes it once fully staffed.'
    },
    assessments: {
      table: 'assessments', title: 'Assessments', singular: 'Assessment',
      exportUrl: '/assessments/export',
      externalLinks: true,
      hasImport: true,
      note: 'Plant PRO SRT and DISC are part of the interview process. Use the buttons above to open each tool, then record the candidate\'s result here so it sits alongside their interview feedback.',
      filters: [
        { key: 'assessment_type', label: 'Assessment', options: ['Plant PRO SRT', 'DISC'] },
        { key: 'status', label: 'Status', options: ['Pending', 'Sent', 'Completed', 'Not Required'] }
      ],
      columns: [
        { key: 'candidate_id', label: 'Candidate', type: 'relation', relation: 'candidates' },
        { key: 'vacancy_id', label: 'Vacancy', type: 'relation', relation: 'vacancies' },
        { key: 'assessment_type', label: 'Assessment' },
        { key: 'app_stage', label: 'Pipeline stage', type: 'tag' },
        { key: 'status', label: 'Status', type: 'tag' },
        { key: 'assessment_date', label: 'Date', type: 'date' },
        { key: 'score', label: 'Score / Result' }
      ],
      fields: [
        { key: 'candidate_id', label: 'Candidate', type: 'relation', relation: 'candidates', required: true },
        { key: 'vacancy_id', label: 'Vacancy', type: 'relation', relation: 'vacancies' },
        { key: 'assessment_type', label: 'Assessment', type: 'select', options: ['Plant PRO SRT', 'DISC'], required: true },
        { key: 'status', label: 'Status', type: 'select', options: ['Pending', 'Sent', 'Completed', 'Not Required'] },
        { key: 'assessment_date', label: 'Date completed', type: 'date' },
        { key: 'score', label: 'Score / result', type: 'text', hint: 'For example a score, or a DISC style such as "D/I".' },
        { key: 'result_summary', label: 'Summary', type: 'textarea' },
        { key: 'report_link', label: 'Report link', type: 'text', hint: 'Paste the link to the full report from the tool.' },
        { key: 'remarks', label: 'Remarks', type: 'textarea' }
      ]
    },
    followups: {
      table: 'followups', title: 'Follow-ups', singular: 'Follow-up',
      exportUrl: '/followups/export',
      searchPlaceholder: 'Search notes, regarding…',
      filters: [
        { key: 'entity_type', label: 'Type', options: ENUM.entityType },
        { key: 'completed', label: 'Status', options: ['false', 'true'], optionLabels: ['Open', 'Completed'] }
      ],
      columns: [
        { key: 'entity_type', label: 'Type' },
        { key: 'entity_name', label: 'Regarding' },
        { key: 'note', label: 'Note', wrap: true },
        { key: 'due_date', label: 'Due', type: 'date' },
        { key: 'assigned_to', label: 'Assigned to', type: 'relation', relation: 'users' },
        { key: 'completed', label: 'Done', type: 'bool' }
      ],
      fields: [
        { key: 'entity_type', label: 'Regarding type', type: 'select', options: ENUM.entityType, required: true },
        { key: 'entity_type', label: 'Regarding type', type: 'select', options: ENUM.entityType, required: true },
        { key: 'entity_name', label: 'Regarding (name/label)', type: 'text' },
        { key: 'note', label: 'Note', type: 'textarea', required: true },
        { key: 'due_date', label: 'Due date', type: 'date', required: true },
        { key: 'assigned_to', label: 'Assigned to', type: 'relation', relation: 'users' },
        { key: 'completed', label: 'Completed', type: 'bool' }
      ]
    },
    users: {
      table: 'users', title: 'Users', singular: 'User', writeRoles: ['super_admin'],
      exportUrl: '/users/export',
      searchPlaceholder: 'Search name, username, email…',
      filters: [{ key: 'role', label: 'Role', options: ENUM.role }],
      columns: [
        { key: 'full_name', label: 'Name' },
        { key: 'username', label: 'Username', mono: true },
        { key: 'role', label: 'Role', type: 'tag' },
        { key: 'email', label: 'Email' },
        { key: 'is_active', label: 'Active', type: 'bool' }
      ],
      fields: [
        { key: 'full_name', label: 'Full name', type: 'text', required: true },
        { key: 'username', label: 'Username', type: 'text', required: true },
        { key: 'role', label: 'Role', type: 'select', options: ENUM.role, required: true },
        { key: 'email', label: 'Email', type: 'email' },
        { key: 'phone', label: 'Phone', type: 'text' },
        { key: 'password', label: 'Password', type: 'password', requiredOnCreate: true, hint: 'Leave blank to keep the current password.' },
        { key: 'is_active', label: 'Active', type: 'bool', default: true }
      ]
    }
  };
  // followups had an accidental duplicate field above; clean it up.
  ENTITIES.followups.fields = ENTITIES.followups.fields.filter((f, i, arr) =>
    arr.findIndex((x) => x.key === f.key) === i
  );

  /* ---------------- Icons + avatars ---------------- */
  const ICONS = {
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    filetext: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 13H8"/><path d="M16 17H8"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
    award: '<circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/>',
    mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
    userplus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    building: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01"/>',
    file: '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z"/><path d="M14 2v6h6"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    chart: '<path d="M3 3v18h18"/><path d="M18 17V9M13 17V5M8 17v-3"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'
  };
  function icon(name, size = 18) {
    return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  }
  // Round initials badge; the tint is picked from the name so a person keeps the same colour everywhere.
  function avatarHtml(name, size = 28) {
    const clean = String(name || '').replace(/\(.*$/, '').trim();
    const parts = clean.split(/\s+/).filter(Boolean);
    const initials = ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
    let h = 0; for (const ch of clean) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `<span class="avatar av-${h % 6}" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px" aria-hidden="true">${escapeHtml(initials)}</span>`;
  }
  const personHtml = (label) => `<span class="person">${avatarHtml(label)}<span>${escapeHtml(label)}</span></span>`;

  /* ---------------- Navigation ---------------- */
  const NAV = [
    { group: 'Overview', items: [{ key: 'dashboard', label: 'Dashboard', icon: 'dashboard' }, { key: 'help', label: 'How to use this', icon: 'help' }] },
    { group: 'Pipeline', items: [
      { key: 'vacancies', label: 'Vacancies', icon: 'briefcase' },
      { key: 'candidates', label: 'Candidates', icon: 'users' },
      { key: 'applications', label: 'Applications', icon: 'filetext' },
      { key: 'interviews', label: 'Interviews', icon: 'calendar' },
      { key: 'scorecards', label: 'Scorecards', icon: 'clipboard' },
      { key: 'assessments', label: 'Assessments', icon: 'award' },
      { key: 'offers', label: 'Offers', icon: 'mail', roles: ['super_admin', 'hr_manager', 'recruiter'] },
      { key: 'joining', label: 'Joining', icon: 'userplus' },
      { key: 'onboarding', label: 'Onboarding', icon: 'clipboard', roles: ['super_admin', 'hr_manager', 'recruiter'] },
      { key: 'followups', label: 'Follow-ups', icon: 'bell', roles: ['super_admin', 'hr_manager', 'recruiter'] }
    ] },
    { group: 'Setup', items: [
      { key: 'clients', label: 'Companies', icon: 'building', roles: ['super_admin', 'hr_manager'] },
      { key: 'jds', label: 'Job Descriptions', icon: 'file' },
      { key: 'interviewers', label: 'Interviewers', icon: 'users', roles: ['super_admin', 'hr_manager', 'recruiter'] }
    ] },
    { group: 'Admin', items: [
      { key: 'users', label: 'Users', icon: 'shield', roles: ['super_admin'] },
      { key: 'master-lists', label: 'Master lists', icon: 'list', roles: ['super_admin', 'hr_manager'] },
      { key: 'signatories', label: 'Signatories', icon: 'shield', roles: ['super_admin', 'hr_manager'] },
      { key: 'reports', label: 'Reports', icon: 'chart', roles: ['super_admin', 'hr_manager'] },
      { key: 'email-templates', label: 'Email templates', icon: 'mail', roles: ['super_admin', 'hr_manager'] },
      { key: 'settings', label: 'Settings', icon: 'settings', roles: ['super_admin', 'hr_manager'] },
      { key: 'audit-log', label: 'Audit Log', icon: 'list', roles: ['super_admin', 'hr_manager'] }
    ] }
  ];

  /* ---------------- Global state ---------------- */
  const state = { user: null, listState: {}, tools: { srt: 'https://hr.rdcc.ai/srt/admin', disc: 'https://hr.rdcc.ai/disc/admin' } };
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function canWrite(entityKey) {
    if (!state.user) return false;
    if (state.user.role === 'viewer') return false;
    const cfg = ENTITIES[entityKey];
    if (cfg && cfg.writeRoles) return cfg.writeRoles.includes(state.user.role);
    return true;
  }

  /* ---------------- Toast ---------------- */
  let toastTimer = null;
  function toast(message, isError = false, ms = 3200) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.toggle('error', isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  /* ---------------- Login / auth ---------------- */
  function showLogin(message) {
    $('#app-shell').hidden = true;
    $('#login-screen').hidden = false;
    if (message) {
      $('#login-error').textContent = message;
      $('#login-error').hidden = false;
    }
  }

  function showApp() {
    $('#login-screen').hidden = true;
    $('#app-shell').hidden = false;
    $('#sidebar-user-chip').innerHTML = `${escapeHtml(state.user.full_name)}<span class="role">${escapeHtml(state.user.role.replace('_', ' '))}</span>`;
    $('#topbar-role').innerHTML = `${avatarHtml(state.user.full_name, 26)}<span>${escapeHtml(state.user.full_name)}<span class="role-sub">${escapeHtml(state.user.role.replace('_', ' '))}</span></span>`;
    renderNav();
    api('/tools').then((t) => { state.tools = t; }).catch(() => { /* keep defaults */ });
  }

  async function checkSession() {
    try {
      const res = await api('/auth/me');
      if (res.user) {
        state.user = res.user;
        showApp();
        navigate(location.hash.replace('#/', '') || 'dashboard');
        return;
      }
    } catch { /* not logged in */ }
    showLogin();
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#login-username').value.trim();
    const password = $('#login-password').value;
    $('#login-error').hidden = true;
    try {
      const res = await api('/auth/login', { method: 'POST', body: { username, password } });
      state.user = res.user;
      $('#login-form').reset();
      showApp();
      navigate('dashboard');
    } catch (err) {
      $('#login-error').textContent = err.message || 'Invalid credentials';
      $('#login-error').hidden = false;
    }
  });

  $('#logout-btn').addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    state.user = null;
    location.hash = '';
    showLogin();
  });

  /* ---------------- Nav rendering / routing ---------------- */
  function renderNav() {
    const wrap = $('#nav-groups');
    wrap.innerHTML = '';
    for (const group of NAV) {
      const visibleItems = group.items.filter((i) => !i.roles || i.roles.includes(state.user.role));
      if (!visibleItems.length) continue;
      const label = document.createElement('div');
      label.className = 'nav-group-label';
      label.textContent = group.group;
      wrap.appendChild(label);
      for (const item of visibleItems) {
        const el = document.createElement('div');
        el.className = 'nav-item';
        el.dataset.route = item.key;
        el.innerHTML = `<span class="nav-icon">${icon(item.icon)}</span><span class="nav-label">${escapeHtml(item.label)}</span>`;
        if (item.tool) {
          el.addEventListener('click', () => window.open(state.tools[item.tool], '_blank', 'noopener'));
        } else {
          el.addEventListener('click', () => { location.hash = `#/${item.key}`; });
        }
        wrap.appendChild(el);
      }
    }
  }

  function setActiveNav(route) {
    $$('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.route === route));
  }

  window.addEventListener('hashchange', () => {
    if (state.user) navigate(location.hash.replace('#/', '') || 'dashboard');
  });

  async function navigate(route) {
    state.route = route;
    setActiveNav(route);
    closeDrawer();
    const content = $('#content');
    content.innerHTML = '<div class="empty-state">Loading…</div>';
    const navItem = NAV.flatMap((g) => g.items).find((i) => i.key === route);
    if (navItem && navItem.roles && !navItem.roles.includes(state.user.role)) {
      content.innerHTML = `<div class="empty-state"><h3>Not available</h3><p>This section isn't part of your role.</p></div>`;
      return;
    }
    try {
      if (route === 'help') return renderHelp();
      if (route === 'scorecards') return renderScorecards();
      if (route === 'onboarding') return renderOnboarding();
      if (route === 'master-lists') return renderMasterLists();
      if (route === 'dashboard') return renderDashboard();
      if (route === 'settings') return renderSettings();
      if (route === 'reports') return renderReports();
      if (route === 'email-templates') return renderEmailTemplates();
      if (route === 'audit-log') return renderAuditLog();
      if (ENTITIES[route]) {
        await renderListPage(route);
        if (state.pendingAction) { const fn = state.pendingAction; state.pendingAction = null; fn(); }
        return;
      }
      content.innerHTML = `<div class="empty-state"><h3>Not found</h3><p>That page doesn't exist.</p></div>`;
    } catch (err) {
      content.innerHTML = `<div class="empty-state"><h3>Couldn't load this page</h3><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  /* ================================================================
     DASHBOARD
     ================================================================ */
  // Dashboard tiles go to the matching tab (optionally pre-filtered) or open the list behind the number.
  function goWithFilter(route, filters) {
    state.listState[route] = { page: 1, pageSize: 25, q: '', filters: filters || {} };
    if (location.hash === `#/${route}`) navigate(route); else location.hash = `#/${route}`; // keeps the address bar and the nav in step
  }

  function openDrill(title, headers, rows, { onRow, note } = {}) {
    const body = openModal(title, `
      ${note ? `<p class="text-muted" style="margin-top:0">${note}</p>` : ''}
      ${rows.length ? `<div style="max-height:60vh; overflow:auto"><table class="data-table" style="table-layout:auto"><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r, i) => `<tr data-i="${i}" ${onRow ? 'style="cursor:pointer"' : ''}>${r.cells.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<div class="empty-row">Nothing here right now.</div>'}
      <div class="modal-actions"><button type="button" class="btn btn-ghost" id="drill-close">Close</button></div>`, { wide: true });
    $('#drill-close').addEventListener('click', closeModal);
    if (onRow) $$('#modal-overlay tbody tr').forEach((tr) => tr.addEventListener('click', () => { const r = rows[+tr.dataset.i]; closeModal(); onRow(r); }));
  }

  async function renderDashboard() {
    const [stats, tat, followupsRes, appsRes, pipeline] = await Promise.all([
      api('/dashboard'),
      api('/dashboard/tat'),
      api('/followups?completed=false&pageSize=50'),
      api('/applications?pageSize=6'),
      api('/dashboard/pipeline')
    ]);

    const today = todayStr();
    const followups = followupsRes.data;
    const overdue = followups.filter((f) => f.due_date && f.due_date < today);
    const dueToday = followups.filter((f) => f.due_date === today);
    const upcoming = followups.filter((f) => f.due_date > today);

    const statusCounts = {};
    (stats.application_statuses || []).forEach((s) => { statusCounts[s.status] = s.count; });
    const PIPE_STAGES = ['Sourced', 'Screening', 'Shortlisted', 'Interview', 'Offered', 'Joined'];
    const pipelineTotal = PIPE_STAGES.reduce((n, s) => n + (statusCounts[s] || 0), 0);
    const hour = new Date().getHours();
    const firstName = String(state.user.full_name || '').split(/\s+/)[0];
    const generic = /^(super|admin)$/i.test(firstName);
    const greeting = `Good ${hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}${firstName && !generic ? ', ' + escapeHtml(firstName) : ''}`;

    // who the open candidates are waiting on
    const GROUPS = ['Recruiter', 'Interview', 'Interviewer', 'Hiring manager', 'Authorized signatory', 'Candidate'];
    const byGroup = {}; pipeline.forEach((p) => { (byGroup[p.pending_group] = byGroup[p.pending_group] || []).push(p); });

    const tile = (attrs, iconName, value, label, cls = '') => `<button type="button" class="stat-tile tile-link" ${attrs}><span class="tile-icon">${icon(iconName, 20)}</span><div class="stat-value ${cls}">${value}</div><div class="stat-label">${label}</div><span class="tile-go">Open →</span></button>`;
    const mini = (attrs, label, big, small, sub = '', cls = '') => `<button type="button" class="mini-tile tile-link ${cls}" ${attrs}><div class="mt-label">${escapeHtml(label)}</div><div class="mt-big">${big}${small ? `<small>${small}</small>` : ''}</div>${sub ? `<div class="mt-sub">${sub}</div>` : ''}<span class="tile-go">Open →</span></button>`;

    const dsec = (title, hint, inner) => `<section class="dash-sec"><div class="dash-sec-head"><h3>${title}</h3>${hint ? `<span>${hint}</span>` : ''}</div>${inner}</section>`;
    const grid = (inner) => `<div class="tile-grid">${inner}</div>`;
    const tatGroup = (title, group, rows) => rows.length ? `<h4 class="dash-sub">${title}</h4>${grid(rows.map((r) => mini(`data-tat="${group}" data-v="${escapeHtml(r.label)}"`, r.label, r.avg_days, 'days', `${r.closed} closed`)).join(''))}` : '';
    const rejected = (statusCounts.Rejected || 0) + (statusCounts.Withdrawn || 0);

    $('#content').innerHTML = `
      <div class="page-header">
        <div>
          <h1>${greeting}</h1>
          <div class="sub">${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} · Across RDC Concrete, UMAPL &amp; ROBO Silicon · click any tile to open it</div>
        </div>
        <div class="brand-logos" aria-label="Group companies">
          <div class="logo-tile" title="RDC Concrete"><img src="/logos/rdc.png" alt="RDC Concrete"></div>
          <div class="logo-tile" title="Ultrafine Mineral &amp; Admixtures"><img src="/logos/ultrafine.png" alt="Ultrafine"></div>
          <div class="logo-tile" title="ROBO Silicon"><img src="/logos/robo.png" alt="ROBO Silicon"></div>
        </div>
      </div>

      ${dsec('At a glance', '', grid([
        tile('data-go="vacancies" data-filter=\'{"status":"Open"}\'', 'briefcase', stats.open_vacancies, 'Open vacancies'),
        tile('data-go="candidates"', 'users', stats.candidates, 'Candidates in system'),
        tile('data-go="interviews" data-filter=\'{"status":"Scheduled,Confirmed"}\'', 'calendar', stats.upcoming_interviews, 'Upcoming interviews', 'accent'),
        tile('data-go="offers" data-filter=\'{"status":"Draft,Pending Approval,Changes Requested,Approved,Sent,Negotiation,Accepted"}\'', 'mail', stats.active_offers, 'Active offers', 'accent'),
        tile('data-go="joining" data-filter=\'{"status":"Expected,Confirmed"}\'', 'userplus', stats.joining_expected, 'Joining expected'),
        tile('data-go="followups" data-filter=\'{"completed":"false"}\'', 'bell', stats.overdue_followups, 'Overdue follow-ups', stats.overdue_followups ? 'warn' : '')
      ].join('')))}

      ${dsec('Hiring pipeline', pipelineTotal ? `${pipelineTotal} active application${pipelineTotal === 1 ? '' : 's'}` : 'No applications yet', grid(
        PIPE_STAGES.map((st, i) => mini(`data-go="applications" data-filter='{"status":"${st}"}'`, st, statusCounts[st] || 0, '', '', `stage st-${i}`)).join('') +
        mini('data-go="applications" data-filter=\'{"status":"Rejected,Withdrawn"}\'', 'Rejected / withdrawn', rejected, '', '', 'stage st-x')))}

      ${dsec('Candidates in pipeline — pending with', `${pipeline.length} open candidate${pipeline.length === 1 ? '' : 's'} · click a tile to see who`, grid(
        GROUPS.map((g) => mini(`data-pend="${g}"`, g === 'Interview' ? 'Interview scheduled' : 'With ' + g.toLowerCase().replace('authorized signatory', 'Authorized signatory'), (byGroup[g] || []).length, '', g === 'Recruiter' ? 'next action is yours' : '', (byGroup[g] || []).length && ['Interviewer', 'Hiring manager', 'Authorized signatory'].includes(g) ? 'accent' : '')).join('')))}

      ${dsec('Follow-ups needing attention', 'click a tile to see them', grid(
        mini('data-fu="overdue"', 'Overdue', overdue.length, '', 'past their due date', overdue.length ? 'warn' : '') +
        mini('data-fu="today"', 'Due today', dueToday.length, '', 'to do today', dueToday.length ? 'accent' : '') +
        mini('data-fu="upcoming"', 'Coming up', upcoming.length, '', 'due later') +
        mini('data-go="followups" data-filter=\'{"completed":"false"}\'', 'All open follow-ups', followups.length, '', 'open the Follow-ups tab')))}

      ${dsec('Time to close (TAT)', tat.overall.closed ? `Average days from the date the vacancy was received to closed · click a tile to see those vacancies` : 'No closed vacancies yet',
        tat.overall.closed ? grid(mini('data-go="vacancies" data-filter=\'{"status":"Closed,Closed Internally"}\'', 'Overall average', tat.overall.avg_days, 'days', `${tat.overall.closed} closed vacanc${tat.overall.closed === 1 ? "y" : "ies"}`)) + tatGroup('By company', 'company', tat.byCompany) + tatGroup('By recruiter', 'recruiter', tat.byRecruiter) + tatGroup('By location', 'location', tat.byLocation)
          : '<div class="empty-tile">Tiles appear here once a vacancy has been closed.</div>')}

      ${dsec(`Open for more than ${tat.threshold} days`, tat.aging.length ? `${tat.aging.length} vacanc${tat.aging.length === 1 ? 'y' : 'ies'}` : '',
        tat.aging.length ? grid(tat.aging.slice(0, 11).map((v) => mini(`data-vac="${v.id}"`, v.title, v.days_open, 'days', `${escapeHtml([v.company, v.location].filter(Boolean).join(' · '))}<br>${escapeHtml(v.recruiter || 'No recruiter')} · ${v.remaining} to fill`, 'warn')).join('') + (tat.aging.length > 11 ? mini('data-go="vacancies" data-filter=\'{"status":"Open"}\'', `+ ${tat.aging.length - 11} more`, '→', '', 'see all open vacancies') : ''))
          : `<div class="empty-tile">No vacancy has been open longer than ${tat.threshold} days.</div>`)}

      ${dsec('Recent applications', '', appsRes.data.length ? grid(appsRes.data.map((a) => `<button type="button" class="mini-tile tile-link" data-app="${a.id}"><div class="mt-label rel-cell" data-table="candidates" data-id="${a.candidate_id || ''}">…</div><div class="mt-sub rel-cell" data-table="vacancies" data-id="${a.vacancy_id || ''}">…</div><div style="margin-top:8px">${tagHtml('applications', 'status', a.status)}</div></button>`).join('') + mini('data-go="applications"', 'View all', '→', '', 'open Applications')) : '<div class="empty-tile">No applications yet.</div>')}
    `;
    hydrateRelationCells($('#content'));

    const personRow = (p) => ({ cells: [`<strong>${escapeHtml(p.candidate || '—')}</strong><div class="text-muted" style="font-size:12px">${escapeHtml(p.candidate_code || '')}</div>`, escapeHtml(p.vacancy || '—'), escapeHtml(p.recruiter || '—'), tagHtml('applications', 'status', p.status), `<strong>${escapeHtml(p.pending_who)}</strong><div class="text-muted" style="font-size:12px">${escapeHtml(p.pending_what)}</div>`, p.days_in_stage], id: p.candidate_id });
    const content = $('#content');
    content.onclick = async (e) => {
      const el = e.target.closest('[data-go],[data-pend],[data-tat],[data-vac],[data-fu],[data-app]');
      if (!el || !content.contains(el)) return;
      if (el.dataset.go) return goWithFilter(el.dataset.go, el.dataset.filter ? JSON.parse(el.dataset.filter) : {});
      if (el.dataset.app) return openEditDrawer('applications', el.dataset.app);
      if (el.dataset.vac) return openEditDrawer('vacancies', el.dataset.vac);
      if (el.dataset.pend) {
        const g = el.dataset.pend;
        return openDrill(g === 'Interview' ? 'Interviews coming up' : `Pending with ${g.toLowerCase()}`, ['Candidate', 'Vacancy', 'Recruiter', 'Stage', 'Pending with', 'Days'], (byGroup[g] || []).map(personRow),
          { onRow: (r) => openEditDrawer('candidates', r.id), note: 'Click a candidate to open the record. Days = time since the last update.' });
      }
      if (el.dataset.fu) {
        const k = el.dataset.fu; const list = k === 'overdue' ? overdue : k === 'today' ? dueToday : upcoming;
        return openDrill(k === 'overdue' ? 'Overdue follow-ups' : k === 'today' ? 'Due today' : 'Coming up', ['Note', 'Regarding', 'Due'],
          list.map((f) => ({ cells: [escapeHtml(f.note || ''), escapeHtml([f.entity_type, f.entity_name].filter(Boolean).join(' · ')), escapeHtml(f.due_date || '')] })), { onRow: () => goWithFilter('followups', { completed: 'false' }), note: 'Click a row to open the Follow-ups tab.' });
      }
      if (el.dataset.tat) {
        const rows = await api(`/dashboard/closed?group=${encodeURIComponent(el.dataset.tat)}&value=${encodeURIComponent(el.dataset.v)}`);
        return openDrill(`Closed vacancies — ${el.dataset.v}`, ['Vacancy', 'Company', 'Location', 'Recruiter', 'Days to close'],
          rows.map((v) => ({ cells: [`${escapeHtml(v.vacancy_code || '')} ${escapeHtml(v.title)}`, escapeHtml(v.company || '—'), escapeHtml(v.location || '—'), escapeHtml(v.recruiter || '—'), `<strong>${v.days}</strong>`], id: v.id })), { onRow: (r) => openEditDrawer('vacancies', r.id) });
      }
    };
  }

  function hydrateRelationCells(root) {
    $$('.rel-cell', root).forEach(async (cell) => {
      const { table, id } = cell.dataset;
      const label = await resolveLabel(table, id);
      if ((table === 'candidates' || table === 'users') && id && label && label !== '—') cell.innerHTML = personHtml(label);
      else cell.textContent = label;
    });
  }

  /* ================================================================
     GENERIC LIST PAGE
     ================================================================ */
  function getListState(key) {
    if (!state.listState[key]) {
      state.listState[key] = { page: 1, pageSize: 25, q: '', filters: {} };
    }
    return state.listState[key];
  }

  async function renderListPage(key) {
    const cfg = ENTITIES[key];
    const ls = getListState(key);
    const writable = canWrite(key);

    $('#content').innerHTML = `
      <div class="page-header">
        <div>
          <h1>${escapeHtml(cfg.title)}</h1>
        </div>
        <div style="display:flex; gap:10px">
          ${cfg.externalLinks ? `<a class="btn btn-ghost" style="text-decoration:none" href="${escapeHtml(state.tools.srt)}" target="_blank" rel="noopener">Open Plant PRO SRT ↗</a><a class="btn btn-ghost" style="text-decoration:none" href="${escapeHtml(state.tools.disc)}" target="_blank" rel="noopener">Open DISC ↗</a>` : ''}
          ${cfg.exportUrl ? `<button class="btn btn-ghost" id="export-btn">Export to Excel</button>` : ''}
          ${cfg.hasBulkRounds && writable ? `<button class="btn btn-ghost" id="bulk-rounds-btn">+ Add Multiple Rounds</button>` : ''}
          ${cfg.hasResumeParse ? `<button class="btn btn-ghost" id="consolidated-btn">Consolidated report</button>` : ''}
          ${cfg.hasResumeParse && writable ? `<button class="btn btn-ghost" id="bulk-resume-btn">Upload many resumes</button><button class="btn btn-ghost" id="resume-parse-btn">Add from resume</button>` : ''}
          ${cfg.hasImport && writable ? `<button class="btn btn-ghost" id="import-results-btn">Import results</button>` : ''}
          ${writable ? `<button class="btn btn-primary" id="add-btn">+ Add ${escapeHtml(cfg.singular)}</button>` : ''}
        </div>
      </div>
      <div class="panel">
        <div class="filter-bar">
          ${cfg.searchPlaceholder ? `<input type="text" class="grow" id="list-q" placeholder="${escapeHtml(cfg.searchPlaceholder)}" value="${escapeHtml(ls.q)}">` : ''}
          ${(() => { const sf = (cfg.filters || []).find((f) => f.key === 'status' && f.options.length <= 9 && !f.optionLabels); return sf ? `<div class="pills" id="status-pills"><button type="button" class="pill${!ls.filters.status ? ' on' : ''}" data-v="">All</button>${ls.filters.status && !sf.options.includes(ls.filters.status) ? `<button type="button" class="pill on" data-v="${escapeHtml(ls.filters.status)}">${escapeHtml(String(ls.filters.status).split(',').join(' + ').slice(0, 40))}</button>` : ''}${sf.options.map((o) => `<button type="button" class="pill${ls.filters.status === o ? ' on' : ''}" data-v="${escapeHtml(o)}">${escapeHtml(o)}</button>`).join('')}</div>` : ''; })()}
          ${(cfg.filters || []).map((f) => `
            <select id="filter-${f.key}" data-key="${f.key}"${f.key === 'status' && f.options.length <= 9 && !f.optionLabels ? ' class="sel-hidden"' : ''}>
              <option value="">${escapeHtml(f.label)}: all</option>
              ${ls.filters[f.key] && !f.options.includes(ls.filters[f.key]) ? `<option value="${escapeHtml(ls.filters[f.key])}" selected>${escapeHtml(f.label)}: ${escapeHtml(String(ls.filters[f.key]).split(',').join(' + ').slice(0, 60))}</option>` : ''}
              ${f.options.map((opt, i) => `<option value="${escapeHtml(opt)}" ${ls.filters[f.key] === opt ? 'selected' : ''}>${escapeHtml((f.optionLabels && f.optionLabels[i]) || opt)}</option>`).join('')}
            </select>
          `).join('')}
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr>${cfg.columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('')}${writable ? '<th></th>' : ''}</tr></thead>
            <tbody id="list-tbody"><tr><td colspan="${cfg.columns.length + 1}" class="empty-row">Loading…</td></tr></tbody>
          </table>
        </div>
        <div class="table-foot">
          <span id="list-count"></span>
          <div class="pager" id="list-pager"></div>
        </div>
      </div>
    `;

    if (writable) $('#add-btn').addEventListener('click', () => openCreateDrawer(key));
    if (cfg.hasBulkRounds && writable) $('#bulk-rounds-btn').addEventListener('click', openBulkRoundsDrawer);
    if (cfg.hasResumeParse && writable) { $('#resume-parse-btn').addEventListener('click', openResumeParseDrawer); $('#bulk-resume-btn').addEventListener('click', openBulkResumes); }
    if (cfg.hasResumeParse) $('#consolidated-btn').addEventListener('click', openConsolidatedReport);
    if (cfg.hasImport && writable) $('#import-results-btn').addEventListener('click', openAssessmentImport);
    if (cfg.exportUrl) {
      $('#export-btn').addEventListener('click', () => {
        const params = new URLSearchParams();
        if (ls.q) params.set('q', ls.q);
        for (const [k, v] of Object.entries(ls.filters)) if (v) params.set(k, v);
        const qs = params.toString();
        window.location.href = `${API}${cfg.exportUrl}${qs ? '?' + qs : ''}`;
      });
    }

    const qInput = $('#list-q');
    if (qInput) {
      let debounce;
      qInput.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => { ls.q = qInput.value.trim(); ls.page = 1; loadList(key); }, 300);
      });
    }
    (cfg.filters || []).forEach((f) => {
      const sel = $(`#filter-${f.key}`);
      sel.addEventListener('change', () => { ls.filters[f.key] = sel.value; ls.page = 1; loadList(key); });
    });
    // Quick status pills drive the (hidden) status dropdown, so filtering is one click.
    const pills = $('#status-pills');
    if (pills) {
      const sel = $('#filter-status');
      pills.querySelectorAll('.pill').forEach((p) => p.addEventListener('click', () => {
        sel.value = p.dataset.v; sel.dispatchEvent(new Event('change'));
        pills.querySelectorAll('.pill').forEach((x) => x.classList.toggle('on', x === p));
      }));
    }

    await loadList(key);
  }

  async function loadList(key) {
    const cfg = ENTITIES[key];
    const ls = getListState(key);
    const params = new URLSearchParams();
    params.set('page', ls.page);
    params.set('pageSize', ls.pageSize);
    if (ls.q) params.set('q', ls.q);
    for (const [k, v] of Object.entries(ls.filters)) if (v) params.set(k, v);

    const res = await api(`/${cfg.table}?${params.toString()}`);
    const tbody = $('#list-tbody');
    const writable = canWrite(key);

    if (!res.data.length) {
      tbody.innerHTML = `<tr><td colspan="${cfg.columns.length + 1}"><div class="empty-state"><div class="empty-icon">${icon('inbox', 28)}</div><h3>No ${escapeHtml(cfg.title.toLowerCase())} found</h3><p>${(ls.q || Object.values(ls.filters).some(Boolean)) ? 'Nothing matches the search or filters. Clear them to see everything.' : (writable ? `Add the first one with the button at the top right.` : 'Nothing has been added yet.')}</p></div></td></tr>`;
    } else {
      tbody.innerHTML = res.data.map((row) => `
        <tr data-id="${row.id}">
          ${cfg.columns.map((c) => `<td class="${c.wrap ? 'wrap' : ''} ${c.mono ? 'mono' : ''}">${renderCell(cfg, c, row)}</td>`).join('')}
          ${writable ? `<td><div class="row-actions">${key === 'applications' ? `<button class="link-btn nx-btn" data-id="${row.id}">Next step ▾</button>` : ''}<button class="link-btn del-btn" data-id="${row.id}">Delete</button></div></td>` : ''}
        </tr>
      `).join('');
      hydrateRelationCells(tbody);

      $$('tr[data-id]', tbody).forEach((tr) => {
        tr.addEventListener('click', (e) => {
          if (e.target.classList.contains('del-btn') || e.target.classList.contains('nx-btn')) return;
          openEditDrawer(key, tr.dataset.id);
        });
      });
      $$('.nx-btn', tbody).forEach((btn) => btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openNextMenu(btn, res.data.find((r) => r.id === btn.dataset.id));
      }));
      if (writable) {
        $$('.del-btn', tbody).forEach((btn) => {
          btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!confirm(`Delete this ${cfg.singular.toLowerCase()}? This can be restored from the database if needed, but not from this screen.`)) return;
            try {
              await api(`/${cfg.table}/${btn.dataset.id}`, { method: 'DELETE' });
              toast(`${cfg.singular} deleted.`);
              loadList(key);
            } catch (err) { toast(err.message, true); }
          });
        });
      }
    }

    const total = res.total;
    const totalPages = Math.max(1, Math.ceil(total / ls.pageSize));
    $('#list-count').textContent = total === 0 ? 'No records' : `${total} record${total === 1 ? '' : 's'} · page ${ls.page} of ${totalPages}`;
    $('#list-pager').innerHTML = `
      <button id="pg-prev" ${ls.page <= 1 ? 'disabled' : ''}>&larr; Prev</button>
      <button id="pg-next" ${ls.page >= totalPages ? 'disabled' : ''}>Next &rarr;</button>
    `;
    $('#pg-prev')?.addEventListener('click', () => { ls.page -= 1; loadList(key); });
    $('#pg-next')?.addEventListener('click', () => { ls.page += 1; loadList(key); });
  }

  // "Next step ▾" on each application row: opens the form for that candidate and vacancy already filled in.
  function closeNextMenu() { $('#nx-menu')?.remove(); }
  document.addEventListener('click', closeNextMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNextMenu(); });
  function openNextMenu(btn, app) {
    closeNextMenu();
    if (!app) return;
    const prefill = { candidate_id: app.candidate_id, vacancy_id: app.vacancy_id, application_id: app.id };
    const items = [['Schedule interview', 'interviews'], ['Record assessment', 'assessments'], ['Create offer', 'offers'], ['Add joining', 'joining']]
      .filter(([, k]) => canWrite(k)).map(([label, k]) => ({ label, run: () => goAndOpen(k, () => openCreateDrawer(k, prefill)) }));
    if (canWrite('applications')) {
      if (items.length) items.push({ divider: true });
      items.push({ label: 'Send email…', run: () => openEmailComposer(app, 'status_update') });
      if (!['Rejected', 'Withdrawn', 'Joined'].includes(app.status)) {
        const late = (STAGE_ORDER[app.status] ?? 0) >= STAGE_ORDER.Interview;
        items.push({ label: 'Reject and send email…', danger: true, run: () => openEmailComposer(app, late ? 'rejection_interview' : 'rejection_screening') });
      }
    }
    if (!items.length) return;
    const m = document.createElement('div');
    m.className = 'nx-menu'; m.id = 'nx-menu';
    m.innerHTML = items.map((it, n) => (it.divider ? '<div class="nx-div"></div>' : `<button type="button" data-n="${n}"${it.danger ? ' class="danger"' : ''}>${escapeHtml(it.label)}</button>`)).join('');
    const r = btn.getBoundingClientRect();
    m.style.top = `${Math.min(r.bottom + 4, window.innerHeight - 20 - items.length * 38)}px`; m.style.left = `${Math.max(8, r.right - 210)}px`;
    document.body.appendChild(m);
    m.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      closeNextMenu();
      items[Number(b.dataset.n)].run();
    });
  }

  function renderCell(cfg, col, row) {
    if (col.render) { const out = String(col.render(row)); return col.html ? out : escapeHtml(out); }
    const value = row[col.key];
    if (col.key === 'full_name' && (cfg.table === 'candidates' || cfg.table === 'users') && value) return personHtml(value);
    if (col.type === 'relation') return `<span class="rel-cell" data-table="${col.relation}" data-id="${value || ''}">${value ? '…' : '—'}</span>`;
    if (col.type === 'tag') return tagHtml(cfg.table, col.key, value);
    if (col.type === 'bool') return value ? '<span class="tag tag-ok">Yes</span>' : '<span class="tag tag-neutral">No</span>';
    if (col.type === 'date') return escapeHtml(value ? String(value).slice(0, 16).replace('T', ' ') : '—');
    if (Array.isArray(value)) return escapeHtml(value.join(', ') || '—');
    return escapeHtml(value === null || value === undefined || value === '' ? '—' : String(value));
  }

  /* ================================================================
     DRAWER (create / edit forms)
     ================================================================ */
  let drawerCtx = null; // { key, id, cfg }

  let bulkRoundsMode = false;
  let resumeParseMode = false;
  let pendingResumeFile = null; // resume used to pre-fill a new candidate; attached on save
  function closeDrawer() {
    $('#drawer').hidden = true;
    $('#drawer-backdrop').hidden = true;
    $('#drawer-form').reset();
    $('#drawer-error').hidden = true;
    drawerCtx = null;
    bulkRoundsMode = false;
    resumeParseMode = false;
    pendingResumeFile = null;
  }
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-cancel').addEventListener('click', closeDrawer);
  $('#drawer-backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal-overlay') && !$('#drawer-backdrop').hidden) closeDrawer(); });

  function openCreateDrawer(key, prefill = {}) {
    bulkRoundsMode = false;
    // a recruiter adding a vacancy is its recruiter unless they pick someone else
    if (key === 'interviews' && !prefill.type) prefill = { ...prefill, type: 'Video' };
    if (key === 'vacancies' && state.user && state.user.role === 'recruiter' && !prefill.assigned_recruiter_id) prefill = { ...prefill, assigned_recruiter_id: state.user.id };
    drawerCtx = { key, id: null, cfg: ENTITIES[key] };
    $('#drawer-title').textContent = `Add ${drawerCtx.cfg.singular}`;
    buildDrawerFields(drawerCtx.cfg, prefill);
    openDrawerEl();
  }

  // Lets a recruiter create several interview rounds for one candidate +
  // vacancy at once (e.g. Round 1, Round 2, Technical Test), instead of
  // adding each round as a fully separate interview one at a time. Each
  // round created is still a normal interview record afterward — its own
  // date, feedback, and rating are filled in individually like any other.
  function openBulkRoundsDrawer() {
    bulkRoundsMode = true;
    drawerCtx = null;
    relPickers.length = 0;
    $('#drawer-title').textContent = 'Add Multiple Rounds';
    const wrap = $('#drawer-fields');
    wrap.innerHTML = '';
    wrap.appendChild(buildFieldEl({ key: 'bulk_candidate', label: 'Candidate', type: 'relation', relation: 'candidates', required: true }, {}));
    wrap.appendChild(buildFieldEl({ key: 'bulk_vacancy', label: 'Vacancy', type: 'relation', relation: 'vacancies', required: true }, {}));
    wrap.appendChild(buildFieldEl({ key: 'bulk_round_count', label: 'Number of rounds', type: 'number', default: 2 }, {}));
    wrap.appendChild(buildFieldEl({ key: 'bulk_type', label: 'Type (applies to all rounds)', type: 'select', options: ENUM.interviewType }, {}));
    wrap.appendChild(buildFieldEl({ key: 'bulk_interviewer', label: 'Interviewer (applies to all rounds, optional)', type: 'text' }, {}));
    wrap.appendChild(buildFieldEl({ key: 'bulk_interviewer_email', label: 'Interviewer email (optional)', type: 'email' }, {}));
    const hint = document.createElement('div');
    hint.className = 'field-hint';
    hint.textContent = 'Creates that many round records (Round 1, Round 2, ...) for this candidate and vacancy, each ready for its own date and feedback afterward.';
    wrap.appendChild(hint);
    openDrawerEl();
  }

  async function handleBulkRoundsSubmit() {
    const candidateId = $('#field-bulk_candidate').value;
    const vacancyId = $('#field-bulk_vacancy').value;
    const count = parseInt($('#field-bulk_round_count').value, 10) || 0;
    const type = $('#field-bulk_type').value;
    const interviewer = $('#field-bulk_interviewer').value;
    const interviewerEmail = $('#field-bulk_interviewer_email').value;
    $('#drawer-error').hidden = true;

    if (!candidateId || !vacancyId) {
      $('#drawer-error').textContent = 'Select a candidate and a vacancy first.';
      $('#drawer-error').hidden = false;
      return;
    }
    if (count < 1 || count > 20) {
      $('#drawer-error').textContent = 'Enter a number of rounds between 1 and 20.';
      $('#drawer-error').hidden = false;
      return;
    }

    try {
      for (let round = 1; round <= count; round++) {
        const body = { candidate_id: candidateId, vacancy_id: vacancyId, round };
        if (type) body.type = type;
        if (interviewer) body.interviewer = interviewer;
        if (interviewerEmail) body.interviewer_email = interviewerEmail;
        await api('/interviews', { method: 'POST', body });
      }
      toast(`${count} interview round${count === 1 ? '' : 's'} added.`);
      closeDrawer();
      loadList('interviews');
    } catch (err) {
      $('#drawer-error').textContent = err.message;
      $('#drawer-error').hidden = false;
    }
  }

  async function openEditDrawer(key, id) {
    bulkRoundsMode = false;
    const cfg = ENTITIES[key];
    let record;
    try {
      record = await api(`/${cfg.table}/${id}`);
    } catch (err) {
      toast(err.message, true); return;
    }
    drawerCtx = { key, id, cfg };
    $('#drawer-title').textContent = `Edit ${cfg.singular}`;
    await buildDrawerFields(cfg, record);
    if (cfg.hasResumes) await renderResumeSection(id);
    if (cfg.hasApplications) await renderApplicationsSection(id);
    if (cfg.hasApplications) { await renderNextStepSection(id); renderCandidateReportSection(id); }
    if (key === 'vacancies') renderCloseOutSection(id, record);
    if (cfg.hasScoreBreakdown) await renderScoreSection(id, record);
    if (cfg.hasScorecard) { renderScorecardSection(record); renderScorecardLinkSection(id, record); }
    if (cfg.hasAppointmentLetter) { renderOfferApprovalSection(id, record); renderAppointmentLetterSection(id); }
    if (cfg.hasMeetLink) renderMeetLinkSection(id, record);
    if (cfg.hasOnboarding) renderOnboardingSection(record);
    openDrawerEl();
  }

  function openDrawerEl() {
    $('#drawer-save').textContent = resumeParseMode ? 'Read resume' : 'Save';
    $('#drawer').hidden = false;
    $('#drawer-backdrop').hidden = false;
    $('#drawer-error').hidden = true;
    const writable = bulkRoundsMode ? true : canWrite(drawerCtx.key);
    $('#drawer-save').style.display = writable ? '' : 'none';
    $$('#drawer-fields input, #drawer-fields select, #drawer-fields textarea').forEach((el) => { el.disabled = !writable; });
  }

  async function buildDrawerFields(cfg, record) {
    relPickers.length = 0;
    const wrap = $('#drawer-fields');
    wrap.innerHTML = '';
    if (cfg.note) {
      const hint = document.createElement('div');
      hint.className = 'field-hint';
      hint.textContent = cfg.note;
      wrap.appendChild(hint);
    }
    for (const f of cfg.fields) {
      if (f.createOnly && drawerCtx && drawerCtx.id !== null) continue;
      wrap.appendChild(buildFieldEl(f, record));
      if (cfg.table === 'offers' && f.key === 'offered_ctc') {
        wrap.appendChild(buildCtcCalculatorButton());
      }
    }
    if (cfg.table === 'offers') wireCtcBalancing();
    if (cfg.table === 'candidates') wireDuplicateCheck(drawerCtx && drawerCtx.id);
    // Resolve relation field initial labels once inputs exist
    for (const f of cfg.fields) {
      if (f.type === 'relation' && record[f.key]) {
        const input = $(`#relinput-${f.key}`);
        if (input) input.value = await resolveLabel(f.relation, record[f.key]);
      }
    }
    if (cfg.table === 'interviews') { buildPanelBox(record); showMeetHint(); }
    wirePickLists();
    if (drawerCtx && drawerCtx.id === null && AUTOFILL_TABLES.includes(cfg.table)) wireAutofill(cfg.table);
  }

  // Admin-managed pick-lists (plant locations, raised by, interview locations) as suggestions on the matching fields.
  function wirePickLists() {
    if ($$('[data-list]').length) {
    api('/lists').then((L) => {
      $$('[data-list]').forEach((inp) => {
        const key = inp.dataset.list; const items = L[key] || []; if (!items.length) return;
        const dl = document.createElement('datalist'); dl.id = 'dl-' + key;
        dl.innerHTML = items.map((x) => (typeof x === 'string' ? `<option value="${escapeHtml(x)}">` : `<option value="${escapeHtml(x.value)}">`)).join('');
        document.getElementById(dl.id)?.remove(); inp.after(dl);
      });
    }).catch(() => {});
  }
  }


  /* ---------------- Auto-fill: enter the candidate once ---------------- */
  const AUTOFILL_TABLES = ['interviews', 'offers', 'joining', 'assessments'];

  // Once a candidate is chosen, fills in the vacancy and the details we already know, but only into
  // fields that are still empty — anything the recruiter typed is never overwritten.
  function wireAutofill(table) {
    const candEl = $('#field-candidate_id');
    const vacEl = $('#field-vacancy_id');
    if (!candEl) return;
    let data = null;
    const note = document.createElement('div');
    note.className = 'field-hint autofill-note';
    note.hidden = true;
    $('#drawer-fields').prepend(note);

    const setPlain = (key, value) => {
      const el = $(`#field-${key}`);
      if (!el || value === undefined || value === null || value === '') return false;
      if (el.value !== '' && !(key === 'round' && el.value === '1')) return false;
      el.value = value; return true;
    };
    const setRel = async (key, relation, id) => {
      const hid = $(`#field-${key}`); const inp = $(`#relinput-${key}`);
      if (!hid || !id || hid.value) return false;
      hid.value = id; if (inp) inp.value = await resolveLabel(relation, id);
      return true;
    };

    async function apply() {
      if (!data) return;
      const filled = [];
      const apps = data.applications;
      // Vacancy: keep what is already chosen; otherwise take the candidate's most recent active application.
      if (vacEl && !vacEl.value && apps.length && await setRel('vacancy_id', 'vacancies', apps[0].vacancy_id)) {
        filled.push(apps.length > 1 ? `vacancy (most recent of ${apps.length} active — change it if this is for another role)` : 'vacancy');
      }
      const vid = vacEl ? vacEl.value : '';
      const app = apps.find((x) => x.vacancy_id === vid);
      if (table === 'interviews') {
        const prev = data.interviews.filter((i) => i.vacancy_id === vid);
        if (prev.length) {
          const next = Math.max(...prev.map((i) => parseFloat(i.round) || 0)) + 1;
          if (setPlain('round', next)) filled.push(`round ${next}`);
          const last = prev[0];
          if (setPlain('interviewer', last.interviewer) | setPlain('interviewer_email', last.interviewer_email)) filled.push('interviewer from the last round');
          setPlain('type', last.type);
        }
      }
      if (table === 'assessments') {
        const done = (data.assessments || []).filter((x) => x.vacancy_id === vid).map((x) => x.assessment_type);
        const next = ['Plant PRO SRT', 'DISC'].find((t) => !done.includes(t));
        if (next && setPlain('assessment_type', next)) filled.push(`type (${next} — not recorded yet)`);
        if (setPlain('status', 'Pending')) filled.push('status');
        if (app && setPlain('application_id', app.id)) { /* linked silently */ }
      }
      if (table === 'offers') {
        if (setPlain('offer_date', new Date().toISOString().slice(0, 10))) filled.push('offer date');
        const days = parseInt(data.candidate.notice_period, 10);
        if (days > 0) {
          const d = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
          if (setPlain('expected_joining', d)) filled.push(`expected joining (today + ${days}-day notice)`);
        }
        const hintHost = $('#field-offered_ctc')?.closest('label');
        if (hintHost && data.candidate.expected_ctc && !hintHost.querySelector('.ctc-expect')) {
          const h = document.createElement('span'); h.className = 'field-hint ctc-expect';
          h.textContent = `Candidate expects ${data.candidate.expected_ctc} LPA.`; hintHost.appendChild(h);
        }
      }
      if (table === 'joining') {
        const offer = data.offers.find((o) => o.vacancy_id === vid) || data.offers[0];
        if (offer) {
          if (await setRel('offer_id', 'offers', offer.id)) filled.push('offer');
          if (setPlain('offered_ctc', offer.offered_ctc)) filled.push('offered CTC');
          if (setPlain('expected_date', offer.expected_joining)) filled.push('expected date');
        }
        if (app && setPlain('joining_location', app.vacancy_location)) filled.push('joining location');
        const nd = parseInt(data.candidate.notice_period, 10);
        if (nd > 0 && setPlain('expected_date', new Date(Date.now() + nd * 86400000).toISOString().slice(0, 10))) filled.push(`expected date (today + ${nd}-day notice)`);
      }
      if (filled.length) {
        note.textContent = `Filled in from ${data.candidate.full_name}'s record: ${filled.join(', ')}. Check and change anything that isn't right.`;
        note.hidden = false;
      }
    }

    async function load() {
      const id = candEl.value;
      if (!id) { data = null; return; }
      try { data = await api(`/candidates/${id}/autofill`); } catch { data = null; return; }
      await apply();
    }
    candEl.addEventListener('change', async () => {
      // a new candidate invalidates the vacancy that was filled for the previous one
      if (vacEl && vacEl.dataset.auto) { vacEl.value = ''; const vi = $('#relinput-vacancy_id'); if (vi) vi.value = ''; }
      await load();
      if (vacEl && vacEl.value) vacEl.dataset.auto = '1';
    });
    vacEl?.addEventListener('change', () => { delete vacEl.dataset.auto; apply(); });
    if (candEl.value) load();
    else setTimeout(() => $('#relinput-candidate_id')?.focus(), 80);

    // Interviewers used before: typing a name suggests them, and picking one fills in their email.
    if (table === 'interviews') {
      api('/interviewer-suggestions').then((r) => {
        const nameEl = $('#field-interviewer'); const mailEl = $('#field-interviewer_email');
        if (!nameEl || !r.data.length) return;
        const dl = document.createElement('datalist'); dl.id = 'dl-interviewers';
        dl.innerHTML = r.data.map((x) => `<option value="${escapeHtml(x.name)}">${escapeHtml([x.designation, x.city, x.email].filter(Boolean).join(' · '))}</option>`).join('');
        nameEl.setAttribute('list', 'dl-interviewers'); nameEl.after(dl);
        const fillMail = () => {
          const m = r.data.find((x) => x.name.toLowerCase() === nameEl.value.trim().toLowerCase());
          if (m && m.email && mailEl && !mailEl.value) mailEl.value = m.email;
        };
        nameEl.addEventListener('input', fillMail); nameEl.addEventListener('change', fillMail);
      }).catch(() => {});
    }
  }

  // Keeps "Special Allowance" as the live balancing figure on the Offers
  // form: whenever the Annual CTC or any other monthly component changes,
  // Special Allowance is recalculated so everything still sums to the CTC
  // exactly — the same role it plays in RDC's source slab spreadsheet.
  function wireCtcBalancing() {
    const componentKeys = ['basic_pay', 'hra', 'lta', 'employer_pf', 'gratuity', 'variable_component'];
    setTimeout(() => {
      const ctcInput = $('#field-offered_ctc');
      const specialInput = $('#field-special_allowance');
      if (!ctcInput || !specialInput) return;

      function recalcSpecialAllowance() {
        const annualCtc = parseFloat(ctcInput.value);
        if (!annualCtc) return; // nothing to balance against yet
        const monthlyCtc = annualCtc / 12;
        const sumOthers = componentKeys.reduce((sum, key) => sum + (parseFloat($(`#field-${key}`)?.value) || 0), 0);
        specialInput.value = Math.round(monthlyCtc - sumOthers);
      }

      ctcInput.addEventListener('input', recalcSpecialAllowance);
      for (const key of componentKeys) {
        $(`#field-${key}`)?.addEventListener('input', recalcSpecialAllowance);
      }
    }, 0);
  }

  // A button shown right under the Annual CTC field on the Offers form —
  // fills in the six breakdown fields (Basic, HRA, Special Allowance, LTA,
  // PF, Gratuity, Variable) from RDC's official slab structure, so the
  // recruiter only has to type one number.
  function buildCtcCalculatorButton() {
    const wrapper = document.createElement('div');
    wrapper.className = 'field';
    wrapper.style.marginTop = '-6px';
    wrapper.innerHTML = `<button type="button" id="calc-ctc-btn" class="btn btn-ghost btn-sm" style="align-self:flex-start">Calculate breakdown from CTC</button>
      <span class="field-hint">Fills in Basic/HRA/Special Allowance/LTA/PF/Gratuity/Variable below automatically. You can still adjust any of them afterward.</span>`;
    setTimeout(() => {
      $('#calc-ctc-btn')?.addEventListener('click', async () => {
        const ctcInput = $('#field-offered_ctc');
        const ctc = parseFloat(ctcInput?.value);
        if (!ctc || ctc <= 0) { toast('Enter the Annual CTC amount first.', true); return; }
        const btn = $('#calc-ctc-btn');
        const original = btn.textContent;
        btn.textContent = 'Calculating…';
        btn.disabled = true;
        try {
          const breakdown = await api('/ctc-breakdown', { method: 'POST', body: { ctc } });
          for (const [key, value] of Object.entries(breakdown)) {
            const input = $(`#field-${key}`);
            if (input) input.value = value;
          }
          toast('Breakdown calculated — review before saving.');
        } catch (err) {
          toast(err.message, true);
        } finally {
          btn.textContent = original;
          btn.disabled = false;
        }
      });
    }, 0);
    return wrapper;
  }

  function buildFieldEl(f, record) {
    const wrapper = document.createElement('label');
    wrapper.className = 'field' + (f.type === 'bool' ? ' field-checkbox' : '');
    const isCreate = drawerCtx.id === null;
    const val = record ? record[f.key] : undefined;

    if (f.type === 'bool') {
      const checked = val === undefined ? !!f.default : !!val;
      wrapper.innerHTML = `<input type="checkbox" id="field-${f.key}" ${checked ? 'checked' : ''}><span>${escapeHtml(f.label)}</span>`;
      return wrapper;
    }

    let inputHtml = '';
    if (f.type === 'select') {
      inputHtml = `<select id="field-${f.key}">
        <option value="">${f.required ? 'Select…' : '—'}</option>
        ${f.options.map((o) => `<option value="${escapeHtml(o)}" ${val === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}
      </select>`;
    } else if (f.type === 'textarea') {
      inputHtml = `<textarea id="field-${f.key}">${escapeHtml(val || '')}</textarea>`;
    } else if (f.type === 'tags') {
      const joined = Array.isArray(val) ? val.join(', ') : '';
      inputHtml = `<input type="text" id="field-${f.key}" value="${escapeHtml(joined)}" placeholder="e.g. Excel, Recruitment, HRMS">`;
    } else if (f.type === 'relation') {
      inputHtml = `
        <div style="position:relative">
          <input type="text" id="relinput-${f.key}" placeholder="Type to search…" autocomplete="off">
          <input type="hidden" id="field-${f.key}" value="${val || ''}">
          <div class="search-results" id="reldrop-${f.key}" hidden></div>
        </div>`;
    } else if (f.type === 'password') {
      inputHtml = `<input type="password" id="field-${f.key}" autocomplete="new-password" placeholder="${isCreate ? '' : 'Leave blank to keep current'}">`;
    } else {
      const type = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'time' ? 'time' : f.type === 'email' ? 'email' : 'text';
      const value = val === undefined || val === null ? (f.default !== undefined ? f.default : '') : val;
      inputHtml = `<input type="${type}" id="field-${f.key}" value="${escapeHtml(value)}" ${type === 'number' ? 'step="any"' : ''} ${f.list ? `data-list="${f.list}" list="dl-${f.list}" autocomplete="off"` : ''}>`;
    }

    const requiredNow = f.required || (f.requiredOnCreate && isCreate);
    wrapper.innerHTML = `<span>${escapeHtml(f.label)}${requiredNow ? ' *' : ''}</span>${inputHtml}${f.hint ? `<span class="field-hint">${escapeHtml(f.hint)}</span>` : ''}`;

    if (f.type === 'relation') {
      // wire search-as-you-type after innerHTML is attached to `wrapper` (event delegation on document works too,
      // but we bind directly once appended by the caller — see setTimeout(0) fallback below).
      setTimeout(() => wireRelationPicker(f), 0);
    }
    return wrapper;
  }

  const relPickers = [];
  document.addEventListener('click', (e) => {
    for (const { input, drop } of relPickers) {
      if (drop && !drop.hidden && !drop.contains(e.target) && e.target !== input) drop.hidden = true;
    }
  });

  function wireRelationPicker(f) {
    const input = $(`#relinput-${f.key}`);
    const hidden = $(`#field-${f.key}`);
    const drop = $(`#reldrop-${f.key}`);
    if (!input) return;
    relPickers.push({ input, drop });
    let debounce;
    input.addEventListener('input', () => {
      hidden.value = '';
      clearTimeout(debounce);
      const q = input.value.trim();
      if (!q) { drop.hidden = true; return; }
      debounce = setTimeout(async () => {
        try {
          const res = await api(`/${f.relation}?q=${encodeURIComponent(q)}&pageSize=8`);
          if (!res.data.length) {
            drop.innerHTML = '<div class="search-empty">No matches</div>';
          } else {
            drop.innerHTML = res.data.map((r) => `<div class="search-result-item" data-id="${r.id}" data-label="${escapeHtml(labelFor(f.relation, r))}">${escapeHtml(labelFor(f.relation, r))}</div>`).join('');
          }
          drop.hidden = false;
        } catch { drop.hidden = true; }
      }, 250);
    });
    // In the Interview / Assessment / Offer / Joining forms, an empty candidate box offers the people
    // currently in the pipeline, so choosing someone is one click instead of typing their name.
    const suggestCandidates = f.relation === 'candidates' && drawerCtx && !drawerCtx.id && AUTOFILL_TABLES.includes(drawerCtx.key);
    input.addEventListener('focus', async () => {
      if (suggestCandidates && !input.value.trim() && !hidden.value) {
        try {
          const r = await api('/candidates/in-pipeline');
          if (r.data.length) {
            drop.innerHTML = '<div class="search-caption">In your pipeline — pick one, or type to search</div>' + r.data.map((c) => `<div class="search-result-item" data-id="${c.id}" data-label="${escapeHtml(labelFor('candidates', c))}">${escapeHtml(labelFor('candidates', c))}</div>`).join('');
            drop.hidden = false; return;
          }
        } catch { /* fall through to normal behaviour */ }
      }
      if (drop.innerHTML) drop.hidden = false;
    });
    drop.addEventListener('click', (e) => {
      const item = e.target.closest('.search-result-item');
      if (!item) return;
      hidden.value = item.dataset.id;
      input.value = item.dataset.label;
      drop.hidden = true;
      hidden.dispatchEvent(new Event('change'));
    });
  }

  // Video interviews get a Google Meet link when the invite is saved — say so, or warn when Google is not connected.
  async function showMeetHint() {
    const lab = $('#field-type') && $('#field-type').closest('label');
    if (!lab) return;
    let on = false; try { on = (await api('/google/status')).connected; } catch { /* leave the hint out */ }
    const h = document.createElement('span'); h.className = 'field-hint';
    h.textContent = on ? 'Video: a Google Meet link is created automatically when you save, and sent in the invites.' : 'Video: Google Calendar is not connected, so no Meet link can be created — paste your own link below, or ask the Super Admin to connect Google (Settings → Google Calendar).';
    if (!on) h.style.color = '#B0502C';
    lab.appendChild(h);
  }

  // More than one interviewer on the same interview. Each extra interviewer gets their own invite, resume and private
  // scorecard link; the candidate gets one invite listing the panel.
  async function buildPanelBox(record) {
    const anchor = $('#field-interviewer_email') && $('#field-interviewer_email').closest('label');
    if (!anchor) return;
    const box = document.createElement('div');
    box.id = 'panel-box'; box.className = 'panel-box';
    anchor.after(box);
    if (record && record.panel_role === 'member') {
      box.innerHTML = '<div class="field-hint">This interviewer is part of a panel. Date, time, link, location and status are managed on the main interview and are copied here when it is saved.</div>';
      box.dataset.member = '1';
      return;
    }
    let people = [];
    try { people = (await api('/interviewer-suggestions')).data || []; } catch { people = []; }
    if (!Array.isArray(people)) people = [];
    const rows = (record && record.panel) || [];
    box.innerHTML = `<div class="panel-head"><strong>Additional interviewers</strong><span class="field-hint">Each one gets the invite, the resume and their own scorecard link. Leave empty for a single interviewer.</span></div>
      <div id="panel-rows"></div><button type="button" class="btn btn-ghost btn-sm" id="panel-add">+ Add another interviewer</button>
      <datalist id="dl-panel">${people.map((p) => `<option value="${escapeHtml(p.name)}">`).join('')}</datalist>`;
    const host = $('#panel-rows', box);
    const add = (m = {}) => {
      const row = document.createElement('div'); row.className = 'panel-row';
      row.innerHTML = `<input type="text" class="pn-name" list="dl-panel" placeholder="Interviewer name" value="${escapeHtml(m.name || '')}" autocomplete="off">
        <input type="email" class="pn-email" placeholder="Email" value="${escapeHtml(m.email || '')}">
        ${m.scored ? '<span class="tag tag-ok" title="Their scorecard is already in, so they cannot be removed">Scored</span>' : '<button type="button" class="btn btn-ghost btn-sm pn-del" title="Remove">✕</button>'}`;
      const nameEl = $('.pn-name', row); const mailEl = $('.pn-email', row);
      nameEl.addEventListener('change', () => { const p = people.find((x) => (x.name || '').toLowerCase() === nameEl.value.trim().toLowerCase()); if (p && p.email && !mailEl.value) mailEl.value = p.email; });
      const del = $('.pn-del', row); if (del) del.addEventListener('click', () => row.remove());
      if (m.scored) { nameEl.readOnly = true; mailEl.readOnly = true; }
      host.appendChild(row);
    };
    rows.forEach(add);
    $('#panel-add', box).addEventListener('click', () => { add(); const last = host.lastElementChild; if (last) $('.pn-name', last).focus(); });
  }
  function collectPanel() {
    const box = $('#panel-box'); if (!box || box.dataset.member) return undefined;
    return $$('.panel-row', box).map((r) => ({ name: $('.pn-name', r).value.trim(), email: $('.pn-email', r).value.trim() })).filter((m) => m.name || m.email);
  }

  function collectFormValues(cfg) {
    const values = {};
    for (const f of cfg.fields) {
      const el = $(`#field-${f.key}`);
      if (!el) continue;
      if (f.type === 'bool') { values[f.key] = el.checked; continue; }
      if (f.type === 'tags') {
        values[f.key] = el.value.split(',').map((s) => s.trim()).filter(Boolean);
        continue;
      }
      if (f.type === 'password') {
        if (el.value) values[f.key] = el.value;
        continue;
      }
      if (f.type === 'number') {
        if (el.value !== '') values[f.key] = parseFloat(el.value);
        continue;
      }
      if (el.value !== '') values[f.key] = el.value;
    }
    return values;
  }

  $('#drawer-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (bulkRoundsMode) { await handleBulkRoundsSubmit(); return; }
    if (resumeParseMode) { await handleResumeParseSubmit(); return; }
    if (!drawerCtx || !canWrite(drawerCtx.key)) return;
    const { key, id, cfg } = drawerCtx;
    const values = collectFormValues(cfg);
    if (key === 'interviews' && $('#scorecard-box')) values.scorecard = collectScorecard();
    if (key === 'interviews') { const pn = collectPanel(); if (pn !== undefined) values.panel = pn; }
    const resumeFile = (key === 'candidates' && !id) ? pendingResumeFile : null;
    $('#drawer-error').hidden = true;
    try {
      let saved;
      if (id) {
        saved = await api(`/${cfg.table}/${id}`, { method: 'PUT', body: values });
        toast(`${cfg.singular} updated.${saved && saved._auto && saved._auto.length ? ' Also done automatically: ' + saved._auto.join('; ') + '.' : ''}`, false, saved && saved._auto && saved._auto.length ? 6500 : 3200);
      } else {
        const created = await api(`/${cfg.table}`, { method: 'POST', body: values });
        saved = created;
        if (resumeFile && created && created.id) {
          const fd = new FormData(); fd.append('resume', resumeFile);
          try { await api(`/candidates/${created.id}/resumes`, { method: 'POST', body: fd }); }
          catch (e) { toast('Candidate saved, but the resume could not be attached — upload it from the candidate record.', true); }
        }
        toast(`${cfg.singular} added.${saved && saved._auto && saved._auto.length ? ' Also done automatically: ' + saved._auto.join('; ') + '.' : ''}`, false, saved && saved._auto && saved._auto.length ? 6500 : 3200);
      }
      closeDrawer();
      if (ENTITIES[key]) loadList(key);
      if (key === 'vacancies' && CLOSED_VACANCY.includes(values.status)) offerCloseOut((saved && saved.id) || id, values.title || (saved && saved.title));
    } catch (err) {
      $('#drawer-error').textContent = err.message;
      $('#drawer-error').hidden = false;
    }
  });

  /* ---------------- Match score breakdown (applications only) ---------------- */
  const SCORE_LABELS = { mandatory: 'Mandatory skills', preferred: 'Preferred skills', experience: 'Experience range', qualification: 'Qualification' };

  async function renderScoreSection(applicationId, record) {
    const wrap = $('#drawer-fields');
    const box = document.createElement('div');
    box.className = 'field';
    box.id = 'score-section';
    wrap.appendChild(box);
    renderScoreBox(box, applicationId, record);
  }

  function renderScoreBox(box, applicationId, record) {
    const breakdown = record.score_breakdown && typeof record.score_breakdown === 'object' ? record.score_breakdown : null;
    const writable = canWrite('applications');
    const hasScore = record.match_score !== null && record.match_score !== undefined;

    if (!hasScore) {
      box.innerHTML = `<span>Match score</span>
        <div class="text-muted" style="font-size:13px">No score yet — this candidate's vacancy needs a JD tagged to it first (set it on the vacancy).</div>
        ${writable ? `<button type="button" id="recalc-score-btn" class="btn btn-ghost btn-sm" style="margin-top:6px;align-self:flex-start">Check for a score now</button>` : ''}`;
    } else {
      const rows = breakdown ? Object.entries(breakdown).map(([key, v]) => `
        <div class="list-row" style="padding:6px 0">
          <span>${escapeHtml(SCORE_LABELS[key] || key)}</span>
          <span class="mono">${v.score}% <span class="text-muted">(weight ${v.weight})</span></span>
        </div>`).join('') : '';
      box.innerHTML = `<span>Match score</span>
        <div style="font-size:22px; font-family:var(--font-mono); font-weight:600; color:var(--steel-light); margin:4px 0">${record.match_score}%</div>
        ${rows}
        ${writable ? `<button type="button" id="recalc-score-btn" class="btn btn-ghost btn-sm" style="margin-top:6px;align-self:flex-start">Recalculate</button>` : ''}`;
    }

    box.querySelector('#recalc-score-btn')?.addEventListener('click', async () => {
      try {
        const updated = await api(`/applications/${applicationId}/recalculate-score`, { method: 'POST' });
        renderScoreBox(box, applicationId, updated);
        toast('Match score recalculated.');
      } catch (err) { toast(err.message, true); }
    });
  }

  /* ---------------- Generate Meet Link (interviews only) ---------------- */
  function renderMeetLinkSection(interviewId, record) {
    const wrap = $('#drawer-fields');
    const resendBox = document.createElement('div');
    resendBox.className = 'field';
    resendBox.innerHTML = `<span>Notifications</span>
      <button type="button" id="resend-confirmation-btn" class="btn btn-ghost btn-sm" style="margin-top:6px;align-self:flex-start">Resend confirmation email</button>
      <span class="field-hint">Emails the candidate, interviewer, and assigned recruiter with the current details — use this any time, e.g. after a manual change that didn't trigger it automatically.</span>`;
    wrap.appendChild(resendBox);
    $('#resend-confirmation-btn').addEventListener('click', async () => {
      const btn = $('#resend-confirmation-btn');
      const original = btn.textContent;
      btn.textContent = 'Sending…';
      btn.disabled = true;
      try {
        await api(`/interviews/${interviewId}/resend-confirmation`, { method: 'POST' });
        toast('Confirmation email resent.');
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.textContent = original;
        btn.disabled = false;
      }
    });

    const box = document.createElement('div');
    box.className = 'field';
    box.id = 'meet-link-box';
    wrap.appendChild(box);
    renderMeetLinkBox(box, interviewId, record);
  }

  function renderMeetLinkBox(box, interviewId, record) {
    const hasLink = !!record.meeting_link;
    box.innerHTML = `<span>Google Meet</span>
      ${hasLink ? `<div style="font-size:13px"><a href="${escapeHtml(record.meeting_link)}" target="_blank">${escapeHtml(record.meeting_link)}</a></div>` : '<div class="text-muted" style="font-size:13px">No meeting link yet.</div>'}
      <button type="button" id="meet-link-btn" class="btn btn-ghost btn-sm" style="margin-top:6px;align-self:flex-start">${hasLink ? 'Regenerate' : 'Generate'} Meet Link</button>
      <span class="field-hint">Needs Google Calendar connected (Settings) and a scheduled date saved on this interview.</span>`;

    $('#meet-link-btn').addEventListener('click', async () => {
      const btn = $('#meet-link-btn');
      const original = btn.textContent;
      btn.textContent = 'Generating…';
      btn.disabled = true;
      try {
        const res = await api(`/interviews/${interviewId}/generate-meet-link`, { method: 'POST' });
        record.meeting_link = res.meeting_link;
        const linkInput = $('#field-meeting_link');
        if (linkInput) linkInput.value = res.meeting_link;
        renderMeetLinkBox(box, interviewId, record);
        toast('Meet link generated.');
      } catch (err) {
        toast(err.message, true);
        btn.textContent = original;
        btn.disabled = false;
      }
    });
  }

  /* ---------------- Appointment letter download (offers only) ---------------- */
  // Approval of the offer by the company's Authorized Signatory (e-signature), before the letter reaches the candidate.
  function renderOfferApprovalSection(offerId, record) {
    const wrap = $('#drawer-fields');
    const box = document.createElement('div');
    box.className = 'field';
    const st = record.status;
    const when = (d) => (d ? new Date(String(d).replace(' ', 'T') + 'Z').toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
    let line = '<span class="text-muted">Not sent for approval yet.</span>';
    if (st === 'Pending Approval') line = `<span class="tag tag-warn">Waiting for signatory</span> sent to <strong>${escapeHtml(record.approval_requested_to || '')}</strong> ${escapeHtml(when(record.approval_requested_at))}`;
    else if (st === 'Changes Requested') line = `<span class="tag tag-danger">Changes requested</span> ${escapeHtml(record.approval_note || '')}`;
    else if (record.approved_by_name && record.approval_decision === 'approved') line = `<span class="tag tag-ok">Approved and signed</span> by <strong>${escapeHtml(record.approved_by_name)}</strong> ${escapeHtml(when(record.approved_at))}`;
    const canSend = canWrite('offers') && ['Draft', 'Changes Requested', 'Pending Approval'].includes(st);
    box.innerHTML = `<span>Approval by Authorized Signatory</span>
      <div style="font-size:13.5px; margin-top:4px">${line}</div>
      ${canSend ? `<div style="margin-top:8px"><label class="field" style="margin-bottom:8px"><span>Authorized Signatory</span><select id="signatory-pick"><option value="">Loading…</option></select></label><button type="button" class="btn btn-primary btn-sm" id="send-approval-btn">${st === 'Pending Approval' ? 'Send the reminder / new link' : 'Send for approval'}</button></div>` : ''}
      <span class="field-hint">Save the offer first (CTC and breakdown). The signatory gets a private link to review, sign and approve; the signed appointment letter then goes to the candidate automatically.</span>`;
    wrap.appendChild(box);
    const pick = $('#signatory-pick', box);
    if (pick) {
      api(`/offers/${offerId}/signatories`).then((r) => {
        pick.innerHTML = r.options.length
          ? `<option value="">Select who approves this offer…</option>` + r.options.map((o) => `<option value="${o.id}" ${o.id === r.default_id ? 'selected' : ''}>${escapeHtml(o.name)}${o.designation ? ' — ' + escapeHtml(o.designation) : ''} (${escapeHtml(o.email)})</option>`).join('')
          : '<option value="">No signatory set up for this company</option>';
      }).catch(() => { pick.innerHTML = '<option value="">Could not load signatories</option>'; });
    }
    $('#send-approval-btn')?.addEventListener('click', async () => {
      if (pick && !pick.value) { toast('Choose the Authorized Signatory first.', true); return; }
      const btn = $('#send-approval-btn'); btn.disabled = true; btn.textContent = 'Sending…';
      try {
        const r = await api(`/offers/${offerId}/send-for-approval`, { method: 'POST', body: { signatory_id: pick ? pick.value : undefined } });
        toast(`Sent to ${r.to} for approval.`);
        closeDrawer(); if (state.route) navigate(state.route);
      } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = 'Send for approval'; }
    });
  }

  // Upload a letter prepared outside the system (PDF / Word / image) and send that to the candidate instead.
  async function renderManualLetterBox(offerId) {
    const wrap = $('#drawer-fields');
    const box = document.createElement('div');
    box.className = 'field';
    wrap.appendChild(box);
    let rec = {};
    try { rec = await api(`/offers/${offerId}`); } catch { /* shows as not uploaded */ }
    const has = !!rec.manual_letter_name;
    const writable = canWrite('offers');
    box.innerHTML = `<span>Upload your own letter</span>
      <div style="margin-top:6px; font-size:13.5px">${has ? `<span class="tag tag-ok">Uploaded</span> <a href="#" id="ml-dl">${escapeHtml(rec.manual_letter_name)}</a>` : '<span class="text-muted">Nothing uploaded — the system-generated letter is used.</span>'}</div>
      ${writable ? `<div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap">
        <input type="file" id="ml-file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" hidden>
        <button type="button" class="btn btn-ghost btn-sm" id="ml-pick">${has ? 'Replace file' : 'Upload letter'}</button>
        ${has ? '<button type="button" class="btn btn-primary btn-sm" id="ml-send">Send this letter to candidate</button><button type="button" class="btn btn-ghost btn-sm" id="ml-del">Remove</button>' : ''}
      </div>` : ''}
      <span class="field-hint">For letters you made yourself (PDF, Word or image, up to 10 MB). "Send" emails exactly this file to the candidate, the recruiter and the additional recipients, with the onboarding form link. It does not need signatory approval.</span>`;
    $('#ml-dl')?.addEventListener('click', async (e) => {
      e.preventDefault();
      const r = await fetch(`${API}/offers/${offerId}/manual-letter`, { credentials: 'include' });
      if (!r.ok) return toast('Could not download the file.', true);
      const u = URL.createObjectURL(await r.blob()); const a = document.createElement('a'); a.href = u; a.download = rec.manual_letter_name; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(u);
    });
    $('#ml-pick')?.addEventListener('click', () => $('#ml-file').click());
    $('#ml-file')?.addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const fd = new FormData(); fd.append('letter', f);
      try {
        const r = await fetch(`${API}/offers/${offerId}/manual-letter`, { method: 'POST', body: fd, credentials: 'include' });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(out.error || 'Upload failed.');
        toast('Letter uploaded.'); box.remove(); renderManualLetterBox(offerId);
      } catch (err) { toast(err.message, true); }
    });
    $('#ml-del')?.addEventListener('click', async () => {
      if (!confirm('Remove the uploaded letter?')) return;
      try { await api(`/offers/${offerId}/manual-letter`, { method: 'DELETE' }); box.remove(); renderManualLetterBox(offerId); } catch (err) { toast(err.message, true); }
    });
    $('#ml-send')?.addEventListener('click', async () => {
      if (!confirm('Email the uploaded letter to the candidate now?')) return;
      const b = $('#ml-send'); b.disabled = true; b.textContent = 'Sending…';
      try { const r = await api(`/offers/${offerId}/send-manual-letter`, { method: 'POST', body: {} }); toast(`Sent to ${r.recipients.join(', ')}`); }
      catch (err) { toast(err.message, true); }
      finally { b.disabled = false; b.textContent = 'Send this letter to candidate'; }
    });
  }

  function renderAppointmentLetterSection(offerId) {
    const wrap = $('#drawer-fields');
    const box = document.createElement('div');
    box.className = 'field';
    box.innerHTML = `<span>Appointment letter</span>
      <div style="display:flex; gap:8px; margin-top:6px">
        <button type="button" id="letter-btn" class="btn btn-primary btn-sm">Download (.docx)</button>
        <button type="button" id="resend-letter-btn" class="btn btn-ghost btn-sm">Email it now</button>
      </div>
      <span class="field-hint">Needs: a Company set on the vacancy, and a matching record in Companies (for the letterhead/signatory). It is sent automatically when the Authorized Signatory approves the offer; use "Email it now" to resend any time.</span>`;
    wrap.appendChild(box);
    renderManualLetterBox(offerId);

    $('#resend-letter-btn').addEventListener('click', async () => {
      const btn = $('#resend-letter-btn');
      const original = btn.textContent;
      btn.textContent = 'Sending…';
      btn.disabled = true;
      try {
        const res = await api(`/offers/${offerId}/resend-appointment-letter`, { method: 'POST' });
        toast(`Sent to ${res.recipients.join(', ')}`);
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.textContent = original;
        btn.disabled = false;
      }
    });

    $('#letter-btn').addEventListener('click', async () => {
      const btn = $('#letter-btn');
      const originalText = btn.textContent;
      btn.textContent = 'Generating…';
      btn.disabled = true;
      try {
        const res = await fetch(`${API}/offers/${offerId}/appointment-letter`, { credentials: 'include' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Could not generate the letter.');
        }
        const blob = await res.blob();
        const disposition = res.headers.get('Content-Disposition') || '';
        const match = disposition.match(/filename="(.+)"/);
        const filename = match ? match[1] : 'Appointment Letter.docx';
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.textContent = originalText;
        btn.disabled = false;
      }
    });
  }



  /* ---------------- Resume parsing + duplicate detection ---------------- */
  function openResumeParseDrawer() {
    bulkRoundsMode = false;
    resumeParseMode = true;
    drawerCtx = { key: 'candidates', id: null, cfg: ENTITIES.candidates };
    relPickers.length = 0;
    $('#drawer-title').textContent = 'Add candidate from resume';
    const wrap = $('#drawer-fields');
    wrap.innerHTML = `
      <div class="field-hint">Upload a PDF, DOCX or TXT resume. The details found in it — name, email, mobile, experience, skills and more — will fill the new candidate form for you to check. The resume is attached to the candidate when you save.</div>
      <label class="field"><span>Resume file</span><input type="file" id="resume-parse-file" accept=".pdf,.doc,.docx,.txt"></label>
      <div class="field-hint">Scanned or image-only PDFs can't be read — enter those manually.</div>`;
    openDrawerEl();
  }

  async function handleResumeParseSubmit() {
    const file = $('#resume-parse-file').files[0];
    const errBox = $('#drawer-error');
    errBox.hidden = true;
    if (!file) { errBox.textContent = 'Choose a resume file first.'; errBox.hidden = false; return; }
    const btn = $('#drawer-save');
    btn.disabled = true; btn.textContent = 'Reading…';
    try {
      const fd = new FormData(); fd.append('resume', file);
      const res = await api('/candidates/parse-resume', { method: 'POST', body: fd });
      closeDrawer();
      openCreateDrawer('candidates', res.fields);
      pendingResumeFile = file;
      const count = Object.keys(res.fields).length;
      const banner = document.createElement('div');
      banner.className = 'parse-banner';
      banner.innerHTML = count
        ? `<strong>Filled ${count} field${count === 1 ? '' : 's'} from ${escapeHtml(file.name)}.</strong> Please check them before saving — company and designation in particular are best guesses. The resume will be attached when you save.`
        : `<strong>Nothing could be read from ${escapeHtml(file.name)}.</strong> Fill in the details manually — the resume will still be attached when you save.`;
      $('#drawer-fields').insertBefore(banner, $('#drawer-fields').firstChild);
    } catch (err) {
      errBox.textContent = err.message; errBox.hidden = false;
    } finally {
      btn.disabled = false;
      if (resumeParseMode) btn.textContent = 'Read resume';
    }
  }

  function renderDuplicateWarning(box, matches) {
    if (!matches.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.className = 'dup-warning';
    box.innerHTML = `<strong>This candidate may already exist.</strong> Saving is blocked while the same email or mobile is on another record.` + matches.map((m) => `
      <div class="dup-row"><span><strong>${escapeHtml(m.full_name)}</strong> (${escapeHtml(m.candidate_code || '')}) — same ${escapeHtml(m.matched_on)}${m.current_company ? ' · ' + escapeHtml(m.current_company) : ''}</span>
      <button type="button" class="btn btn-ghost btn-sm" data-dup="${m.id}">Open existing</button></div>`).join('');
    box.querySelectorAll('[data-dup]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.dup;
      closeDrawer();
      goAndOpen('candidates', () => openEditDrawer('candidates', id));
    }));
  }

  function wireDuplicateCheck(excludeId) {
    const wrap = $('#drawer-fields');
    const box = document.createElement('div');
    box.id = 'dup-box'; box.hidden = true;
    wrap.insertBefore(box, wrap.firstChild);
    const check = async () => {
      const email = ($('#field-email') || {}).value || '';
      const mobile = ($('#field-mobile') || {}).value || '';
      if (!email.trim() && !mobile.trim()) { renderDuplicateWarning(box, []); return; }
      try {
        const r = await api(`/candidates/check-duplicate?email=${encodeURIComponent(email.trim())}&mobile=${encodeURIComponent(mobile.trim())}${excludeId ? '&exclude=' + excludeId : ''}`);
        renderDuplicateWarning(box, r.duplicates || []);
      } catch { /* the server still blocks real duplicates on save */ }
    };
    ['#field-email', '#field-mobile'].forEach((sel) => { const el = $(sel); if (el) el.addEventListener('change', check); });
    setTimeout(check, 0);
  }

  /* ---------------- Interview scorecard ---------------- */
  const SCORECARD_CRITERIA = [
    ['knowledge', 'Role knowledge & skills'],
    ['experience', 'Relevant experience'],
    ['problem_solving', 'Problem solving'],
    ['communication', 'Communication'],
    ['leadership', 'Leadership & team handling'],
    ['culture', 'Attitude & culture fit'],
    ['learnability', 'Learnability'],
    ['energy', 'Energy and Enthusiasm'],
    ['selling', 'Selling Skills', true],
    ['overall', 'Overall']
  ];
  const SCORE_WORDS = { 1: 'Poor', 2: 'Below par', 3: 'Meets the bar', 4: 'Strong', 5: 'Outstanding' };

  function scorecardAverage(scores) {
    // "Overall" is the interviewer's own impression; the Average is worked out from the other scores.
    let v = Object.entries(scores).filter(([k, n]) => k !== 'overall' && n >= 1 && n <= 5).map(([, n]) => n);
    if (!v.length && scores.overall >= 1) v = [scores.overall];
    return v.length ? Math.round((v.reduce((x, y) => x + y, 0) / v.length) * 10) / 10 : null;
  }

  function renderScorecardSection(record) {
    const wrap = $('#drawer-fields');
    const sc = record.scorecard && typeof record.scorecard === 'object' ? record.scorecard : {};
    const scores = { ...(sc.scores || {}) };
    const writable = canWrite('interviews');
    const box = document.createElement('div');
    box.className = 'field scorecard'; box.id = 'scorecard-box';
    box.innerHTML = `
      <div class="sc-head"><span>Interview scorecard</span><div class="sc-overall">Average <strong id="sc-overall">—</strong> / 5</div></div>
      <div class="field-hint">Score each criterion from 1 (poor) to 5 (outstanding). Skip any that didn't come up — they're left out of the average.</div>
      ${SCORECARD_CRITERIA.map(([k, label, salesOnly]) => `
        <div class="sc-row" ${salesOnly ? `data-sales-only="1" ${scores[k] ? '' : 'hidden'}` : ''}><div class="sc-label">${label}</div>
        <div class="sc-btns" data-crit="${k}">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="sc-btn${scores[k] === n ? ' on' : ''}" data-score="${n}" title="${SCORE_WORDS[n]}" ${writable ? '' : 'disabled'}>${n}</button>`).join('')}</div></div>`).join('')}
      <div class="sc-assess" id="sc-assess"><div class="sc-assess-title">Assessments</div><div class="text-muted" style="font-size:13px">Loading…</div></div>
      <label class="field"><span>Strengths</span><textarea id="sc-strengths" ${writable ? '' : 'disabled'}>${escapeHtml(sc.strengths || '')}</textarea></label>
      <label class="field"><span>Concerns</span><textarea id="sc-concerns" ${writable ? '' : 'disabled'}>${escapeHtml(sc.concerns || '')}</textarea></label>`;
    // place it just above the Feedback field so scoring reads top to bottom
    const feedback = $('#field-feedback');
    const anchor = feedback ? feedback.closest('.field') : null;
    if (anchor) wrap.insertBefore(box, anchor); else wrap.appendChild(box);

    const refresh = () => {
      const avg = scorecardAverage(currentScores());
      $('#sc-overall').textContent = avg === null ? '—' : avg.toFixed(1);
      if (avg !== null && $('#field-rating')) $('#field-rating').value = avg;
    };
    box.querySelectorAll('.sc-btns').forEach((row) => {
      row.querySelectorAll('.sc-btn').forEach((b) => b.addEventListener('click', () => {
        const wasOn = b.classList.contains('on');
        row.querySelectorAll('.sc-btn').forEach((x) => x.classList.remove('on'));
        if (!wasOn) b.classList.add('on');
        refresh();
      }));
    });
    refresh();
    showSellingForSales(record, box);
    fillScorecardAssessments(record, writable);
  }

  // "Selling Skills" is only asked for sales candidates (vacancy or job description is a sales role).
  async function showSellingForSales(record, box) {
    try {
      const v = record.vacancy_id ? await api(`/vacancies/${record.vacancy_id}`) : null;
      let jd = null; if (v && v.jd_id) jd = await api(`/jds/${v.jd_id}`);
      const sales = /\b(sales|selling|business development|business manager|business head|bd|marketing)\b/i.test(`${v ? v.title : ''} ${jd ? jd.title : ''}`);
      if (sales) box.querySelectorAll('[data-sales-only]').forEach((r) => { r.hidden = false; });
    } catch { /* leave hidden */ }
  }

  // Shows the candidate's Plant PRO SRT / DISC results inside the interview scorecard.
  async function fillScorecardAssessments(record, writable) {
    const el = $('#sc-assess');
    if (!el) return;
    let list = [];
    try {
      list = (await api(`/assessments?candidate_id=${record.candidate_id}&pageSize=50`)).data
        .filter((a) => !a.vacancy_id || a.vacancy_id === record.vacancy_id);
    } catch { /* leave empty */ }
    const latest = {};
    list.forEach((a) => { if (!latest[a.assessment_type]) latest[a.assessment_type] = a; });
    const rows = ['Plant PRO SRT', 'DISC'].map((type) => {
      const a = latest[type];
      if (!a) return `<div class="sc-assess-row"><strong>${type}</strong><span class="text-muted">Not recorded yet</span></div>`;
      const result = a.score ? escapeHtml(a.score) : '<span class="text-muted">no score entered</span>';
      return `<div class="sc-assess-row"><strong>${type}</strong><span>${tagHtml('assessments', 'status', a.status)} ${result}</span>
        ${a.result_summary ? `<div class="sc-assess-note">${escapeHtml(a.result_summary)}</div>` : ''}
        ${a.report_link ? `<a href="${escapeHtml(a.report_link)}" target="_blank" rel="noopener" style="font-size:12.5px">Open report ↗</a>` : ''}</div>`;
    }).join('');
    el.innerHTML = `<div class="sc-assess-title">Assessments</div>${rows}
      ${writable ? `<button type="button" class="btn btn-ghost btn-sm" id="sc-add-assess" style="align-self:flex-start">Record or update an assessment</button>` : ''}`;
    const btn = $('#sc-add-assess');
    if (btn) btn.addEventListener('click', () => {
      closeDrawer();
      goAndOpen('assessments', () => openCreateDrawer('assessments', { candidate_id: record.candidate_id, vacancy_id: record.vacancy_id }));
    });
  }


  /* ---------------- Interviewer scorecard link ---------------- */
  function renderScorecardLinkSection(interviewId, record) {
    const writable = canWrite('interviews');
    const box = document.createElement('div');
    box.className = 'field sc-link-box'; box.id = 'sc-link-box';
    const submitted = record.scorecard_submitted_at
      ? `<div class="sc-link-status"><span class="tag tag-ok">Submitted</span> by the interviewer on ${escapeHtml(String(record.scorecard_submitted_at).slice(0, 16).replace('T', ' '))} (UTC) — scores below are theirs.</div>` : '';
    box.innerHTML = `<div class="sc-assess-title">Interviewer scorecard link</div>
      <div class="field-hint">Send the interviewer a private link so they can fill in this scorecard themselves — no login needed. It works for 30 days.</div>
      ${submitted}
      <div id="sc-link-out"></div>
      ${writable ? `<div id="sc-link-actions"><button type="button" class="btn btn-ghost btn-sm" id="sc-link-make">${record.scorecard_token_expires && record.scorecard_token_expires > new Date().toISOString() ? 'Show link' : 'Create link'}</button></div>` : ''}`;
    const wrap = $('#drawer-fields');
    const anchor = $('#scorecard-box');
    if (anchor) wrap.insertBefore(box, anchor); else wrap.appendChild(box);
    const make = $('#sc-link-make');
    if (!make) return;

    const show = (data) => {
      const local = /^https?:\/\/(localhost|127\.|192\.168\.|10\.)/i.test(data.url);
      $('#sc-link-out').innerHTML = `
        <input type="text" readonly id="sc-link-url" value="${escapeHtml(data.url)}" style="width:100%; padding:9px 11px; border:1px solid var(--line-strong); border-radius:8px; font-size:13px; background:var(--slab)">
        <div class="field-hint" style="margin-top:6px">Expires ${escapeHtml(new Date(data.expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }))}.${local ? ' <strong>This address only works on the computer running the tracker.</strong> Set <code>APP_BASE_URL</code> in <code>.env</code> to the address your team uses, once the tracker is hosted.' : ''}</div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px">
          <button type="button" class="btn btn-ghost btn-sm" id="sc-link-copy">Copy link</button>
          <button type="button" class="btn btn-ghost btn-sm" id="sc-link-email">Email to interviewer</button>
          <button type="button" class="btn btn-ghost btn-sm" id="sc-link-new">Make a new link</button>
        </div>`;
      $('#sc-link-actions').hidden = true;
      $('#sc-link-copy').addEventListener('click', async () => {
        const input = $('#sc-link-url');
        try { await navigator.clipboard.writeText(input.value); toast('Link copied.'); }
        catch { input.select(); document.execCommand('copy'); toast('Link copied.'); }
      });
      $('#sc-link-email').addEventListener('click', async () => {
        const b = $('#sc-link-email'); b.disabled = true;
        try { const r = await api(`/interviews/${interviewId}/scorecard-link/email`, { method: 'POST', body: {} }); toast(`Link emailed to ${r.to}.`); }
        catch (err) { toast(err.message, true); }
        finally { b.disabled = false; }
      });
      $('#sc-link-new').addEventListener('click', async () => {
        if (!confirm('Make a new link? The old link will stop working.')) return;
        try { show(await api(`/interviews/${interviewId}/scorecard-link`, { method: 'POST', body: { regenerate: true } })); toast('New link created — the old one no longer works.'); }
        catch (err) { toast(err.message, true); }
      });
    };
    make.addEventListener('click', async () => {
      make.disabled = true;
      try { show(await api(`/interviews/${interviewId}/scorecard-link`, { method: 'POST', body: {} })); }
      catch (err) { toast(err.message, true); make.disabled = false; }
    });
  }

  function currentScores() {
    const scores = {};
    $$('#scorecard-box .sc-btns').forEach((row) => {
      const on = row.querySelector('.sc-btn.on');
      if (on) scores[row.dataset.crit] = parseInt(on.dataset.score, 10);
    });
    return scores;
  }

  function collectScorecard() {
    return { scores: currentScores(), strengths: $('#sc-strengths').value.trim(), concerns: $('#sc-concerns').value.trim() };
  }

  /* ---------------- Scorecards review page ---------------- */
  async function renderScorecards() {
    const vacancies = (await api('/vacancies?pageSize=100')).data;
    $('#content').innerHTML = `
      <div class="page-header"><div><h1>Scorecards</h1><div class="sub">Compare how candidates scored across interview rounds</div></div></div>
      <div class="panel">
        <div class="filter-bar">
          <select id="sc-vacancy"><option value="">All vacancies</option>${vacancies.map((v) => `<option value="${v.id}">${escapeHtml(v.vacancy_code || '')} · ${escapeHtml(v.title)}</option>`).join('')}</select>
          <label style="display:flex; gap:6px; align-items:center; font-size:13px"><input type="checkbox" id="sc-only-scored" checked> Only interviews that have been scored</label>
        </div>
        <div class="table-wrap" id="sc-table"></div>
      </div>
      <div class="field-hint" style="margin-top:10px">Click a row to open that interview. For an Excel version with all scores, use Admin → Reports → Interviews.</div>`;
    const load = async () => {
      const vid = $('#sc-vacancy').value;
      const onlyScored = $('#sc-only-scored').checked;
      let rows = await api(`/scorecards${vid ? '?vacancy_id=' + vid : ''}`);
      rows = rows.map((r) => ({ ...r, scores: (r.scorecard && r.scorecard.scores) || {} }));
      if (onlyScored) rows = rows.filter((r) => Object.keys(r.scores).length || (r.rating !== null && r.rating !== undefined && r.rating !== ''));
      // rank candidates by their average rating across rounds
      const byCand = new Map();
      rows.forEach((r) => {
        const k = `${r.candidate_id}|${r.vacancy_id}`;
        if (!byCand.has(k)) byCand.set(k, []);
        byCand.get(k).push(r);
      });
      const groups = [...byCand.values()].map((g) => {
        const rated = g.map((r) => Number(r.rating)).filter((n) => n > 0);
        return { rows: g.sort((a, b) => (a.round || 0) - (b.round || 0)), avg: rated.length ? rated.reduce((x, y) => x + y, 0) / rated.length : -1 };
      }).sort((a, b) => b.avg - a.avg);
      const recTag = (r) => r ? `<span class="tag tag-${r === 'Proceed' ? 'ok' : r === 'Reject' ? 'danger' : 'warn'}">${escapeHtml(r)}</span>` : '<span class="text-muted">—</span>';
      const assessChips = (list) => ['Plant PRO SRT', 'DISC'].map((type) => {
        const x = list.find((a) => a.assessment_type === type);
        const short = type === 'Plant PRO SRT' ? 'SRT' : 'DISC';
        if (!x) return `<span class="tag tag-neutral" title="${type}: not recorded">${short} —</span>`;
        const label = x.status === 'Completed' ? `${short} ${escapeHtml(x.score || 'done')}` : `${short} ${escapeHtml(x.status.toLowerCase())}`;
        return `<span class="tag tag-${x.status === 'Completed' ? 'ok' : 'warn'}" title="${escapeHtml(type + (x.result_summary ? ': ' + x.result_summary : ''))}">${label}</span>`;
      }).join('');
      const cell = (n) => n ? `<span class="sc-heat sc-heat-${n}">${n}</span>` : '<span class="text-muted">—</span>';
      const body = groups.map((g) => g.rows.map((r, i) => `
        <tr data-id="${r.id}">
          <td>${i === 0 ? `<strong>${escapeHtml(r.candidate || '')}</strong><div class="text-muted" style="font-size:12px">${escapeHtml(r.vacancy || '')}${g.rows.length > 1 && g.avg > 0 ? ` · average ${g.avg.toFixed(1)}` : ''}</div><div class="sc-chips">${assessChips(r.assessments || [])}</div>` : ''}</td>
          <td>Round ${r.round || 1}</td><td>${escapeHtml(r.interviewer || '—')}</td>
          <td style="text-align:center"><strong>${r.rating ? Number(r.rating).toFixed(1) : '—'}</strong></td>
          <td class="sc-verd">${recTag(r.recommendation)}</td>
          <td class="sc-hire">${r.hire_type ? `<span class="tag tag-info">${escapeHtml(r.hire_type)}</span>` : '<span class="text-muted">—</span>'}</td>
          ${SCORECARD_CRITERIA.map(([k]) => `<td class="sc-score">${cell(r.scores[k])}</td>`).join('')}
        </tr>`).join('')).join('');
      const SHORT = { knowledge: 'Knowledge', experience: 'Experience', problem_solving: 'Problem solving', communication: 'Communication', leadership: 'Leadership', culture: 'Culture fit', learnability: 'Learnability', energy: 'Energy', selling: 'Selling', overall: 'Overall' };
      $('#sc-table').innerHTML = groups.length ? `<table class="data-table sc-table"><thead><tr><th class="sc-c-cand">Candidate</th><th class="sc-c-round">Round</th><th class="sc-c-int">Interviewer</th><th class="sc-c-all" style="text-align:center">Average</th><th class="sc-c-verd">Verdict</th><th class="sc-c-hire">Hire as</th>${SCORECARD_CRITERIA.map(([k, l]) => `<th class="sc-c-crit" title="${l}">${SHORT[k]}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`
        : '<div class="empty-state"><h3>No scorecards yet</h3><p>Open an interview, score the criteria, and it will show up here.</p></div>';
      $$('#sc-table tbody tr').forEach((tr) => tr.addEventListener('click', () => goAndOpen('interviews', () => openEditDrawer('interviews', tr.dataset.id))));
    };
    $('#sc-vacancy').addEventListener('change', load);
    $('#sc-only-scored').addEventListener('change', load);
    await load();
  }

  /* ---------------- "Next step" guide (candidate record) ---------------- */
  // Moves to another page, then runs `fn` once it has loaded (so the drawer
  // opens on the right list and refreshes it after saving).
  function goAndOpen(route, fn) {
    state.pendingAction = fn;
    if (location.hash === `#/${route}`) { navigate(route); } else { location.hash = `#/${route}`; }
  }

  async function renderNextStepSection(candidateId) {
    const wrap = $('#drawer-fields');
    const box = document.createElement('div');
    box.className = 'field';
    box.classList.add('next-step-box');
    box.innerHTML = '<span>Next step</span><div class="text-muted" style="font-size:13px">Checking progress…</div>';
    wrap.insertBefore(box, wrap.firstChild);
    const writable = canWrite('candidates');

    const q = (t) => api(`/${t}?candidate_id=${candidateId}&pageSize=100`).then((r) => r.data).catch(() => []);
    const [apps, interviews, offers, joinings, assessments] = await Promise.all([
      q('applications'), q('interviews'), q('offers'), q('joining'), q('assessments')
    ]);
    const active = apps.filter((x) => !['Rejected', 'Withdrawn'].includes(x.status));
    const rows = [];
    const btn = (id, label) => writable ? `<button type="button" class="btn btn-primary btn-sm" data-ns="${id}">${label}</button>` : '';
    const actions = {};
    let n = 0;
    const act = (fn) => { const id = `ns${n++}`; actions[id] = fn; return id; };

    if (!active.length) {
      rows.push(`<div class="list-row" style="padding:6px 0"><div>Not tagged to any vacancy yet.</div>
        ${btn(act(() => { const el = $('#relinput-link_vacancy'); if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); } }), 'Link to a vacancy')}</div>`);
    }
    for (const app of active) {
      const v = app.vacancy_id;
      const vLabel = `<span class="rel-cell" data-table="vacancies" data-id="${v}">…</span>`;
      const ints = interviews.filter((i) => i.vacancy_id === v && i.status !== 'Cancelled');
      const pending = ints.find((i) => ['Scheduled', 'Confirmed', 'Rescheduled'].includes(i.status));
      const offer = offers.find((o) => o.vacancy_id === v && !['Declined', 'Withdrawn'].includes(o.status));
      const hadOffer = offers.some((o) => o.vacancy_id === v);
      const join = joinings.find((j) => j.vacancy_id === v);
      const prefill = { candidate_id: candidateId, vacancy_id: v, application_id: app.id };
      let text; let button = '';
      if (join && join.status === 'Joined') {
        text = 'Joined — all done. ✓';
      } else if (join && ['Dropped', 'Deferred'].includes(join.status)) {
        text = `Joining ${join.status.toLowerCase()}.`;
        button = btn(act(() => goAndOpen('joining', () => openEditDrawer('joining', join.id))), 'Open joining');
      } else if (join) {
        text = `Joining ${join.status.toLowerCase()} — update the date or mark as Joined on the day.`;
        button = btn(act(() => goAndOpen('joining', () => openEditDrawer('joining', join.id))), 'Open joining');
      } else if (offer && ['Accepted'].includes(offer.status)) {
        text = `Offer ${offer.status.toLowerCase()} — record the joining details.`;
        button = btn(act(() => goAndOpen('joining', () => openCreateDrawer('joining', { ...prefill, offer_id: offer.id, expected_date: offer.expected_joining }))), 'Add joining');
      } else if (offer) {
        text = offer.status === 'Draft' || offer.status === 'Changes Requested' ? `Offer is ${offer.status.toLowerCase()} — open it and press Send for approval to send it to the Authorized Signatory.`
          : offer.status === 'Pending Approval' ? 'Offer is waiting for the Authorized Signatory to approve and sign.'
          : `Offer is ${offer.status.toLowerCase()} — update it as the candidate responds.`;
        button = btn(act(() => goAndOpen('offers', () => openEditDrawer('offers', offer.id))), 'Open offer');
      } else if (pending) {
        text = `Round ${pending.round || 1} interview ${pending.status.toLowerCase()}${pending.scheduled_date ? ' for ' + pending.scheduled_date : ''} — add feedback once done.`;
        button = btn(act(() => goAndOpen('interviews', () => openEditDrawer('interviews', pending.id))), 'Add feedback');
      } else if (ints.length) {
        text = hadOffer ? 'Previous offer didn\'t go ahead — create a new one if needed.' : 'Interviews done — decide: make an offer or reject.';
        button = btn(act(() => goAndOpen('offers', () => openCreateDrawer('offers', prefill))), 'Create offer');
      } else {
        text = 'Shortlisted? Schedule the first interview.';
        button = btn(act(() => goAndOpen('interviews', () => openCreateDrawer('interviews', prefill))), 'Schedule interview');
      }
      let extra = '';
      if (ints.length && !assessments.some((s) => s.vacancy_id === v) && !(join && join.status === 'Joined')) {
        extra = btn(act(() => goAndOpen('assessments', () => openCreateDrawer('assessments', prefill))), 'Record assessment').replace('btn-primary', 'btn-ghost');
      }
      rows.push(`<div class="list-row" style="padding:8px 0; align-items:flex-start; gap:12px">
        <div><div style="font-weight:600">${vLabel}</div><div class="text-muted" style="font-size:13px">${escapeHtml(text)}</div></div>
        <div style="display:flex; gap:6px; flex-shrink:0">${extra}${button}</div></div>`);
    }
    box.innerHTML = `<span>Next step</span>${rows.join('')}`;
    hydrateRelationCells(box);
    box.querySelectorAll('[data-ns]').forEach((b) => b.addEventListener('click', () => actions[b.dataset.ns]()));
  }

  /* ================================================================
     MODAL (small centred dialog used by the tools below)
     ================================================================ */
  function closeModal() { $('#modal-overlay')?.remove(); }
  function openModal(title, bodyHtml, { wide = false } = {}) {
    closeModal();
    const ov = document.createElement('div');
    ov.className = 'modal-overlay'; ov.id = 'modal-overlay';
    ov.innerHTML = `<div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="modal-head"><h3>${escapeHtml(title)}</h3><button type="button" class="modal-x" aria-label="Close">×</button></div>
      <div class="modal-body">${bodyHtml}</div></div>`;
    document.body.appendChild(ov);
    ov.querySelector('.modal-x').addEventListener('click', closeModal);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeModal(); });
    return ov.querySelector('.modal-body');
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  const STAGE_ORDER = { Sourced: 0, Screening: 1, Shortlisted: 2, Interview: 3, Offered: 4 };
  const CLOSED_VACANCY = ['Closed', 'Closed Internally', 'Cancelled'];

  /* ================================================================
     EMAIL COMPOSER — one-click candidate emails from templates
     ================================================================ */
  async function openEmailComposer(app, presetKey) {
    let templates;
    try { templates = await api('/email-templates'); } catch (err) { toast(err.message, true); return; }
    const body = openModal('Email the candidate', `
      <label class="field"><span>Template</span><select id="em-template">${templates.map((t) => `<option value="${t.key}">${escapeHtml(t.name)}</option>`).join('')}</select></label>
      <label class="field"><span>To</span><input type="email" id="em-to" placeholder="candidate@example.com"></label>
      <label class="field"><span>Subject</span><input type="text" id="em-subject"></label>
      <label class="field"><span>Message</span><textarea id="em-body" rows="11"></textarea></label>
      <div class="field-hint" id="em-hint"></div>
      <div class="modal-error" id="em-error" hidden></div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" id="em-cancel">Cancel</button><button type="button" class="btn btn-primary" id="em-send">Send email</button></div>`, { wide: true });
    let current = null;
    const load = async (key) => {
      $('#em-error').hidden = true;
      try {
        current = await api('/email-templates/render', { method: 'POST', body: { template: key, application_id: app.id, candidate_id: app.candidate_id, vacancy_id: app.vacancy_id } });
      } catch (err) { $('#em-error').textContent = err.message; $('#em-error').hidden = false; return; }
      $('#em-to').value = current.to || ''; $('#em-subject').value = current.subject; $('#em-body').value = current.body;
      const hints = [];
      if (!current.to) hints.push('This candidate has no email address on file — type one above.');
      if (current.set_status && current.set_status !== current.current_status) hints.push(`Sending will also set the application to <strong>${escapeHtml(current.set_status)}</strong>.`);
      if (/\[\[/.test(current.body)) hints.push('Replace anything in [[double brackets]] before sending.');
      $('#em-hint').innerHTML = hints.join(' ');
    };
    $('#em-template').value = presetKey && templates.some((t) => t.key === presetKey) ? presetKey : templates[0].key;
    $('#em-template').addEventListener('change', (e) => load(e.target.value));
    $('#em-cancel').addEventListener('click', closeModal);
    $('#em-send').addEventListener('click', async () => {
      const b = $('#em-send'); b.disabled = true; b.textContent = 'Sending…'; $('#em-error').hidden = true;
      try {
        const r = await api('/email-templates/send', { method: 'POST', body: { ...current, template: $('#em-template').value, to: $('#em-to').value, subject: $('#em-subject').value, body: $('#em-body').value } });
        closeModal();
        toast(`Email sent to ${r.to}${r.statusChanged ? ` — application set to ${r.statusChanged}` : ''}.`, false, 4500);
        if (state.route === 'applications') loadList('applications');
      } catch (err) { $('#em-error').textContent = err.message; $('#em-error').hidden = false; b.disabled = false; b.textContent = 'Send email'; }
    });
    await load($('#em-template').value);
  }

  /* ================================================================
     CLOSE OUT A VACANCY — tell the remaining applicants the position is closed
     ================================================================ */
  async function offerCloseOut(vacancyId, title) {
    let open = [];
    try {
      const r = await api(`/applications?vacancy_id=${vacancyId}&pageSize=100`);
      open = r.data.filter((a) => !['Joined', 'Rejected', 'Withdrawn'].includes(a.status));
    } catch { return; }
    if (!open.length) return;
    const body = openModal('Applicants still open', `
      <p style="margin-top:0"><strong>${escapeHtml(title || 'This vacancy')}</strong> is closed, but <strong>${open.length}</strong> application${open.length === 1 ? ' is' : 's are'} still open.</p>
      <p class="text-muted">Close them out now? Each person is marked Rejected (reason: position closed), and can be sent the standard “position closed” email so nobody is left waiting.</p>
      <div class="modal-error" id="co-error" hidden></div>
      <div class="modal-actions" style="flex-wrap:wrap">
        <button type="button" class="btn btn-ghost" id="co-skip">Leave as is</button>
        <button type="button" class="btn btn-ghost" id="co-quiet">Close out, no email</button>
        <button type="button" class="btn btn-primary" id="co-mail">Close out and email them</button>
      </div>`);
    const run = (send) => async () => {
      $$('.modal-actions button', body).forEach((b) => { b.disabled = true; });
      try {
        const r = await api(`/vacancies/${vacancyId}/close-out`, { method: 'POST', body: { send_emails: send } });
        closeModal();
        let msg = `${r.rejected} applicant${r.rejected === 1 ? '' : 's'} closed out${send ? `, ${r.emailed} emailed` : ''}.`;
        if (send && r.noEmail) msg += ` ${r.noEmail} had no email address.`;
        if (r.emailNotConfigured) msg += ' Email isn\'t set up on this server, so no emails were sent.';
        toast(msg, !!r.failed.length, 6000);
      } catch (err) { $('#co-error').textContent = err.message; $('#co-error').hidden = false; $$('.modal-actions button', body).forEach((b) => { b.disabled = false; }); }
    };
    $('#co-skip').addEventListener('click', closeModal);
    $('#co-quiet').addEventListener('click', run(false));
    $('#co-mail').addEventListener('click', run(true));
  }

  // On an already-closed vacancy, a standing button in its record lets you do the same later.
  function renderCloseOutSection(vacancyId, record) {
    if (!CLOSED_VACANCY.includes(record.status) || !canWrite('applications')) return;
    const box = document.createElement('div');
    box.className = 'field';
    box.innerHTML = `<span>Open applicants</span><div class="field-hint">This vacancy is closed. If anyone is still in the pipeline for it, you can close them out in one go.</div>
      <button type="button" class="btn btn-ghost btn-sm" id="closeout-btn" style="align-self:flex-start">Close out remaining applicants…</button>`;
    $('#drawer-fields').appendChild(box);
    $('#closeout-btn').addEventListener('click', () => { closeDrawer(); offerCloseOut(vacancyId, record.title); });
  }

  /* ================================================================
     EMAIL TEMPLATES (admin page)
     ================================================================ */
  async function renderEmailTemplates() {
    const list = await api('/email-templates');
    const LEGEND = ['candidate_name', 'first_name', 'role', 'company', 'location', 'recruiter_name', 'recruiter_email'];
    $('#content').innerHTML = `
      <div class="page-header"><div><h1>Email templates</h1><div class="sub">The wording recruiters get when they send a candidate email from Applications → Next step ▾</div></div></div>
      <div class="panel"><div class="panel-body pad">
        <div style="margin-bottom:6px"><strong>Fields filled in automatically:</strong> ${LEGEND.map((k) => `<code class="chip-code">{{${k}}}</code>`).join(' ')}</div>
        <div class="text-muted" style="font-size:13px">Anything written as <code class="chip-code">[[like this]]</code> is a gap the recruiter must fill in before the email can be sent. Replies go to the recruiter who sends it.</div>
      </div></div>
      <div class="panel"><div class="panel-body pad" id="ase-box"><div class="text-muted">Loading…</div></div></div>
      <div id="tpl-list">${list.map((t) => `
        <div class="panel tpl" data-key="${t.key}"><div class="panel-body pad">
          <div style="display:flex; justify-content:space-between; gap:12px; align-items:baseline; flex-wrap:wrap">
            <h3 style="margin:0">${escapeHtml(t.name)}</h3>
            <span class="text-muted" style="font-size:12.5px">${t.set_status ? `Also sets the application to <strong>${escapeHtml(t.set_status)}</strong>` : 'Does not change the application stage'}</span>
          </div>
          <label class="field"><span>Subject</span><input type="text" class="tpl-subject" value="${escapeHtml(t.subject)}"></label>
          <label class="field"><span>Message</span><textarea class="tpl-body" rows="9">${escapeHtml(t.body)}</textarea></label>
          <div style="display:flex; gap:8px"><button class="btn btn-primary btn-sm tpl-save">Save</button><button class="btn btn-ghost btn-sm tpl-reset">Restore original wording</button></div>
        </div></div>`).join('')}</div>`;
    (async () => {
      const host = $('#ase-box'); let r; try { r = await api('/status-emails'); } catch (e) { host.textContent = e.message; return; }
      const mayEdit = state.user && ['super_admin', 'hr_manager'].includes(state.user.role);
      host.innerHTML = `<h3 style="margin:0 0 4px">Emails sent automatically when a candidate's status changes</h3>
        <div class="text-muted" style="font-size:13px; margin-bottom:10px">Tick a status and the candidate is emailed (recruiter in copy) the moment their application moves to it — from any screen, by hand or automatically. Each candidate gets at most one email per status. Interview invites, offers and appointment letters already have their own emails.</div>
        ${r.rules.map((x) => `<label class="check-row" style="display:flex; gap:10px; align-items:flex-start; margin:6px 0"><input type="checkbox" data-ase="${x.status}" ${r.config[x.status] ? 'checked' : ''} ${mayEdit ? '' : 'disabled'}><span><strong>${escapeHtml(x.label)}</strong><br><span class="text-muted" style="font-size:12.5px">${escapeHtml(x.hint)}</span></span></label>`).join('')}`;
      $$('[data-ase]', host).forEach((cb) => cb.addEventListener('change', async () => {
        try { await api('/status-emails', { method: 'PUT', body: { [cb.dataset.ase]: cb.checked } }); toast('Saved.'); } catch (e) { toast(e.message, true); cb.checked = !cb.checked; }
      }));
    })();
    $$('.tpl').forEach((box) => {
      const key = box.dataset.key;
      box.querySelector('.tpl-save').addEventListener('click', async () => {
        try { await api(`/email-templates/${key}`, { method: 'PUT', body: { subject: box.querySelector('.tpl-subject').value, body: box.querySelector('.tpl-body').value } }); toast('Template saved.'); }
        catch (err) { toast(err.message, true); }
      });
      box.querySelector('.tpl-reset').addEventListener('click', async () => {
        if (!confirm('Replace this template with the original wording?')) return;
        try { await api(`/email-templates/${key}`, { method: 'PUT', body: { reset: true } }); toast('Original wording restored.'); renderEmailTemplates(); }
        catch (err) { toast(err.message, true); }
      });
    });
  }

  /* ================================================================
     ASSESSMENT RESULTS — import from the portal's Excel/CSV export
     ================================================================ */
  function openAssessmentImport() {
    const body = openModal('Import assessment results', `
      <p class="text-muted" style="margin-top:0">Upload the results file exported from the Plant PRO SRT or DISC portal (Excel or CSV). Each row is matched to a candidate by email or mobile, and you see exactly what will change before anything is saved.</p>
      <div class="field-row">
        <label class="field" style="flex:1"><span>Which test is in the file?</span><select id="ai-type"><option value="">Detect from the file</option><option>Plant PRO SRT</option><option>DISC</option></select></label>
        <label class="field" style="flex:2"><span>File</span><input type="file" id="ai-file" accept=".xlsx,.xls,.csv"></label>
      </div>
      <div class="modal-error" id="ai-error" hidden></div>
      <div id="ai-preview"></div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" id="ai-cancel">Close</button><button type="button" class="btn btn-primary" id="ai-go">Preview</button></div>`, { wide: true });
    let rows = [];
    $('#ai-cancel').addEventListener('click', closeModal);
    const err = (m) => { $('#ai-error').textContent = m; $('#ai-error').hidden = !m; };
    const preview = async () => {
      err('');
      const f = $('#ai-file').files[0]; if (!f) { err('Choose the file first.'); return; }
      const fd = new FormData(); fd.append('file', f); fd.append('assessment_type', $('#ai-type').value);
      const b = $('#ai-go'); b.disabled = true; b.textContent = 'Reading…';
      try {
        const r = await api('/assessments/import', { method: 'POST', body: fd });
        rows = r.rows;
        const good = rows.filter((x) => x.match);
        $('#ai-preview').innerHTML = `
          <div style="margin:10px 0 6px"><strong>${good.length}</strong> of ${r.total} row${r.total === 1 ? '' : 's'} matched a candidate${rows.length < r.total ? ` (showing the first ${rows.length})` : ''}.</div>
          <div class="table-wrap" style="max-height:300px; overflow:auto"><table class="data-table"><thead><tr><th style="width:7%">Row</th><th style="width:25%">In the file</th><th style="width:13%">Test</th><th style="width:10%">Score</th><th style="width:15%">Result</th><th>What will happen</th></tr></thead><tbody>
          ${rows.map((x) => `<tr><td class="mono">${x.row}</td><td>${escapeHtml(x.name || x.email || x.mobile || x.candidate_code)}<div class="text-muted" style="font-size:12px">${escapeHtml(x.email || x.mobile || '')}</div></td><td>${escapeHtml(x.assessment_type || '—')}</td><td>${escapeHtml(x.score || '—')}</td><td>${escapeHtml(x.result_summary || '—')}</td>
            <td>${x.match ? `<span class="tag tag-ok">${x.match.action === 'updated' ? 'Updates' : 'Adds to'} ${escapeHtml(x.match.name)}</span>` : `<span class="tag tag-danger" title="${escapeHtml(x.error || '')}">Skipped — ${escapeHtml(x.error || 'no match')}</span>`}</td></tr>`).join('')}
          </tbody></table></div>`;
        b.disabled = false;
        if (good.length) {
          b.textContent = `Save ${good.length} result${good.length === 1 ? '' : 's'}`;
          b.onclick = async () => {
            b.disabled = true; b.textContent = 'Saving…';
            try {
              const s = await api('/assessments/import/apply', { method: 'POST', body: { rows: good } });
              closeModal(); toast(`${s.updated + s.created} result${s.updated + s.created === 1 ? '' : 's'} saved (${s.updated} completed existing records, ${s.created} new).${s.failed.length ? ` ${s.failed.length} failed.` : ''}`, !!s.failed.length, 5000);
              if (state.route === 'assessments') loadList('assessments');
            } catch (e) { err(e.message); b.disabled = false; }
          };
        } else { b.textContent = 'Preview'; b.onclick = preview; }
      } catch (e) { err(e.message); b.disabled = false; b.textContent = 'Preview'; }
    };
    $('#ai-go').onclick = preview;
  }



  /* ================================================================
     MASTER LISTS (Admin) — plant locations, raised by, interview locations, interviewers
     ================================================================ */
  const ML_TABS = [['plant_locations', 'Plant locations'], ['raised_by', 'Vacancy raised by'], ['interview_locations', 'Interview locations'], ['interviewers', 'Interviewers']];
  async function renderMasterLists(tab) {
    tab = tab || state.mlTab || 'plant_locations'; state.mlTab = tab;
    $('#content').innerHTML = `
      <div class="page-header"><div><h1>Master lists</h1><div class="sub">The lists behind the dropdown suggestions on vacancies, interviews and joining. Changes show up in the forms straight away.</div></div></div>
      <div class="panel"><div class="filter-bar"><div class="pills" id="ml-tabs">${ML_TABS.map(([k, l]) => `<button type="button" class="pill${k === tab ? ' on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div></div>
      <div class="panel-body pad" id="ml-body">Loading…</div></div>`;
    $$('#ml-tabs .pill').forEach((b) => b.addEventListener('click', () => renderMasterLists(b.dataset.tab)));
    if (tab === 'interviewers') return renderMlInterviewers();
    let L; try { L = await api(`/master-lists/${tab}`); } catch (e) { $('#ml-body').textContent = e.message; return; }
    const host = $('#ml-body');
    host.innerHTML = `
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:12px">
        <button class="btn btn-primary btn-sm" id="ml-add">+ Add ${escapeHtml(L.nameLabel.toLowerCase())}</button>
        <input type="file" id="ml-file" accept=".xlsx,.xls,.csv" hidden>
        <button class="btn btn-ghost btn-sm" id="ml-import">Import from Excel</button>
        <span class="text-muted" style="font-size:12.5px">Excel: first column ${escapeHtml(L.nameLabel.toLowerCase())}${L.hasDetail ? ', second column the full address' : ''}. Existing entries are kept.</span>
      </div>
      ${L.rows.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>${escapeHtml(L.nameLabel)}</th>${L.hasDetail ? `<th>${escapeHtml(L.detailLabel)}</th>` : ''}<th>Used in</th><th>Status</th><th></th></tr></thead><tbody>
        ${L.rows.map((r) => `<tr data-id="${r.id}"><td><strong>${escapeHtml(r.name)}</strong></td>${L.hasDetail ? `<td style="white-space:normal; min-width:200px">${escapeHtml(r.detail || '—')}</td>` : ''}<td style="white-space:nowrap">${r.used} record${r.used === 1 ? '' : 's'}</td>
          <td>${r.is_active ? '<span class="tag tag-ok">In dropdown</span>' : '<span class="tag tag-neutral">Hidden</span>'}</td>
          <td style="text-align:right; white-space:nowrap"><button class="btn btn-ghost btn-sm" data-edit="${r.id}">Edit</button> <button class="btn btn-ghost btn-sm" data-toggle="${r.id}">${r.is_active ? 'Hide' : 'Show'}</button> <button class="btn btn-ghost btn-sm" data-del="${r.id}" style="color:var(--danger)">Delete</button></td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty-state"><h3>Nothing here yet</h3><p>Add the first entry, or import a list from Excel.</p></div>'}
      <div class="field-hint" style="margin-top:10px">Hidden or deleted entries stop appearing as suggestions. Records that already use them keep what was saved; renaming here does not rewrite old records.</div>`;
    const byId = Object.fromEntries(L.rows.map((r) => [r.id, r]));
    const form = (row) => {
      const body = openModal(row ? `Edit ${L.nameLabel.toLowerCase()}` : `Add ${L.nameLabel.toLowerCase()}`, `
        <label class="field"><span>${escapeHtml(L.nameLabel)}</span><input type="text" id="mlf-name" maxlength="120" value="${escapeHtml(row ? row.name : '')}"></label>
        ${L.hasDetail ? `<label class="field"><span>${escapeHtml(L.detailLabel)}</span><textarea id="mlf-detail" maxlength="300" placeholder="Building, street, area, city, PIN">${escapeHtml(row ? row.detail || '' : '')}</textarea><span class="field-hint">Included in the interview invite so the candidate knows where to go.</span></label>` : ''}
        <label class="check-row"><input type="checkbox" id="mlf-active" ${!row || row.is_active ? 'checked' : ''}> Show in dropdowns</label>
        <div class="modal-actions"><button class="btn btn-ghost" id="mlf-cancel">Cancel</button><button class="btn btn-primary" id="mlf-save">Save</button></div>`);
      $('#mlf-cancel').addEventListener('click', closeModal);
      $('#mlf-name').focus();
      $('#mlf-save').addEventListener('click', async () => {
        const payload = { name: $('#mlf-name').value, is_active: $('#mlf-active').checked, ...(L.hasDetail ? { detail: $('#mlf-detail').value } : {}) };
        try { await api(row ? `/master-lists/${tab}/${row.id}` : `/master-lists/${tab}`, { method: row ? 'PUT' : 'POST', body: payload }); closeModal(); toast('Saved.'); renderMasterLists(tab); }
        catch (e) { toast(e.message, true); }
      });
    };
    $('#ml-add').addEventListener('click', () => form(null));
    $$('[data-edit]', host).forEach((b) => b.addEventListener('click', () => form(byId[b.dataset.edit])));
    $$('[data-toggle]', host).forEach((b) => b.addEventListener('click', async () => { const r = byId[b.dataset.toggle]; try { await api(`/master-lists/${tab}/${r.id}`, { method: 'PUT', body: { is_active: !r.is_active } }); renderMasterLists(tab); } catch (e) { toast(e.message, true); } }));
    $$('[data-del]', host).forEach((b) => b.addEventListener('click', async () => { const r = byId[b.dataset.del]; if (!confirm(`Delete "${r.name}" from this list?${r.used ? ` ${r.used} record(s) already use it and will keep it.` : ''}`)) return; try { await api(`/master-lists/${tab}/${r.id}`, { method: 'DELETE' }); renderMasterLists(tab); } catch (e) { toast(e.message, true); } }));
    $('#ml-import').addEventListener('click', () => $('#ml-file').click());
    $('#ml-file').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return; const fd = new FormData(); fd.append('file', f);
      try { const r = await api(`/master-lists/${tab}/import`, { method: 'POST', body: fd }); toast(`${r.added} added, ${r.updated} updated, ${r.skipped} already there.`); renderMasterLists(tab); } catch (err) { toast(err.message, true); }
    });
  }

  async function renderMlInterviewers() {
    const host = $('#ml-body');
    let n = 0; try { const r = await api('/interviewers?pageSize=1'); n = r.total ?? (r.pagination && r.pagination.total) ?? 0; } catch { /* count is optional */ }
    host.innerHTML = `
      <p style="margin-top:0">The interviewer directory${n ? ` (${n} people)` : ''} feeds the name and email suggestions when you schedule an interview. Only admins can add or change entries.</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center">
        <button class="btn btn-primary btn-sm" id="mli-open">Open the Interviewers list (add / edit)</button>
        <input type="file" id="mli-file" accept=".xlsx,.xls,.csv" hidden>
        <button class="btn btn-ghost btn-sm" id="mli-import">Import / update from Excel</button>
      </div>
      <div class="field-hint" style="margin-top:8px">Excel columns (first row = headings): Employee Code, Name, Designation, City, Company, Location, Email, Phone. People are matched on employee code, otherwise on name; matches are updated, the rest are added. Blank cells never wipe existing details.</div>`;
    $('#mli-open').addEventListener('click', () => { location.hash = '#/interviewers'; });
    $('#mli-import').addEventListener('click', () => $('#mli-file').click());
    $('#mli-file').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return; const fd = new FormData(); fd.append('file', f);
      try { const r = await api('/interviewers/import', { method: 'POST', body: fd }); toast(`${r.added} added, ${r.updated} updated, ${r.skipped} skipped.`); renderMlInterviewers(); } catch (err) { toast(err.message, true); }
    });
  }

  /* ================================================================
     ONBOARDING — candidate form (replaces the Google form) + HRMS hand-over
     ================================================================ */
  const obDate = (d) => { if (!d) return ''; const x = new Date(d); return isNaN(x) ? String(d) : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
  const obDebounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const OB_STATUS_TAG = { Invited: 'neutral', 'In Progress': 'warn', Submitted: 'info', Verified: 'ok' };
  const obTag = (s) => `<span class="tag tag-${OB_STATUS_TAG[s] || 'neutral'}">${escapeHtml(s || '—')}</span>`;
  const hrmsTag = (r) => r.hrms_status === 'Sent' ? `<span class="tag tag-ok" title="${escapeHtml(r.hrms_pushed_at || '')}">Sent to HRMS</span>`
    : r.hrms_status === 'Failed' ? `<span class="tag tag-danger" title="${escapeHtml(r.hrms_error || '')}">HRMS failed</span>`
    : ['Submitted', 'Verified'].includes(r.status) ? '<span class="tag tag-warn">Ready for HRMS</span>' : '<span class="text-muted">—</span>';

  async function downloadBlob(url, fallback) {
    const r = await fetch(API + url, { credentials: 'include' });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Download failed.'); }
    const cd = r.headers.get('Content-Disposition') || ''; const m = cd.match(/filename="(.+?)"/);
    const u = URL.createObjectURL(await r.blob()); const a = document.createElement('a'); a.href = u; a.download = m ? m[1] : fallback; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(u);
  }
  async function copyText(t) { try { await navigator.clipboard.writeText(t); } catch { const i = document.createElement('input'); i.value = t; document.body.appendChild(i); i.select(); document.execCommand('copy'); i.remove(); } }

  async function renderOnboarding() {
    $('#content').innerHTML = `
      <div class="page-header"><div><h1>Onboarding</h1><div class="sub">Candidates fill their joining form and upload documents here; once they join, it all goes to the HRMS</div></div>
        ${canWrite('offers') ? '<div class="header-actions"><button class="btn btn-primary" id="ob-new">+ Send form to a candidate</button></div>' : ''}</div>
      <div class="panel">
        <div class="filter-bar">
          <input type="text" class="grow" id="ob-q" placeholder="Search candidate, vacancy, company…">
          <select id="ob-status"><option value="">All statuses</option>${['Invited', 'In Progress', 'Submitted', 'Verified', 'Ready for HRMS'].map((s) => `<option>${s}</option>`).join('')}</select>
        </div>
        <div class="table-wrap" id="ob-table"></div>
      </div>
      <div class="field-hint" style="margin-top:10px">Sent automatically with the appointment letter. When a Joining record is marked <strong>Joined</strong> with a date, the details and documents are sent to the HRMS (set up in Settings → HRMS hand-over). Click a row to review.</div>`;
    const load = async () => {
      const q = $('#ob-q').value.trim(), st = $('#ob-status').value;
      const rows = await api(`/onboarding?${new URLSearchParams({ ...(q ? { q } : {}), ...(st ? { status: st } : {}) })}`);
      $('#ob-table').innerHTML = rows.length ? `<table class="data-table"><thead><tr><th>Candidate</th><th>Vacancy</th><th>Joining</th><th>Form</th><th>Documents</th><th>HRMS</th></tr></thead><tbody>${rows.map((r) => `
        <tr data-id="${r.id}" style="cursor:pointer">
          <td><strong>${escapeHtml(r.candidate || '—')}</strong><div class="text-muted" style="font-size:12px">${escapeHtml(r.candidate_code || '')}</div></td>
          <td>${escapeHtml(r.vacancy || '—')}<div class="text-muted" style="font-size:12px">${escapeHtml(r.company || '')}</div></td>
          <td>${escapeHtml(obDate(r.actual_date || r.expected_date) || '—')}<div class="text-muted" style="font-size:12px">${escapeHtml(r.joining_status || '')}</div></td>
          <td>${obTag(r.status)}</td>
          <td>${r.doc_count} <span class="text-muted">(${r.required_docs} required)</span></td>
          <td>${hrmsTag(r)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty-state"><h3>No onboarding forms yet</h3><p>They are created when an appointment letter is sent, or press “Send form to a candidate”.</p></div>';
      $$('#ob-table tbody tr').forEach((tr) => tr.addEventListener('click', () => openOnboardingDetail(tr.dataset.id, load)));
    };
    $('#ob-q').addEventListener('input', obDebounce(load, 250));
    $('#ob-status').addEventListener('change', load);
    $('#ob-new')?.addEventListener('click', () => openOnboardingInvite(load));
    await load();
  }

  async function openOnboardingInvite(after) {
    let people = [];
    try { people = await api('/onboarding-invitees'); } catch (e) { return toast(e.message, true); }
    const body = openModal('Send onboarding form', people.length ? `
      <p class="text-muted" style="margin-top:0">Pick a candidate who has an offer or a joining record. They get a private link by email; you can also copy it.</p>
      <label class="field"><span>Candidate</span><select id="obi-who">${people.map((p, i) => `<option value="${i}">${escapeHtml(p.candidate)} — ${escapeHtml(p.vacancy || '')}${p.company ? ' (' + escapeHtml(p.company) + ')' : ''}</option>`).join('')}</select></label>
      <div style="display:flex; gap:8px; margin-top:12px"><button class="btn btn-primary" id="obi-send">Email the form link</button><button class="btn btn-ghost" id="obi-copy">Just create & copy link</button></div>`
      : '<p class="text-muted">Everyone with an offer or joining record already has a form. New ones are created automatically when an appointment letter is sent.</p>');
    if (!people.length) return;
    const go = async (send) => {
      const p = people[+$('#obi-who').value];
      try {
        const r = await api('/onboarding/invite', { method: 'POST', body: { candidate_id: p.candidate_id, vacancy_id: p.vacancy_id, offer_id: p.offer_id, send } });
        if (send) toast(`Form link emailed to ${r.sent_to}.`); else { await copyText(r.url); toast('Link copied.'); }
        closeModal(); after && after();
      } catch (e) { toast(e.message, true); }
    };
    $('#obi-send').addEventListener('click', () => go(true));
    $('#obi-copy').addEventListener('click', () => go(false));
  }

  async function openOnboardingDetail(id, after) {
    let d; try { d = await api(`/onboarding/${id}`); } catch (e) { return toast(e.message, true); }
    const submitted = ['Submitted', 'Verified'].includes(d.status);
    const v = d.values || {};
    const mask = (k, val) => (val && ['aadhaar', 'bank_account'].includes(k) ? val : val);
    const secs = d.sections.map((s) => {
      const rows = s.fields.filter((f) => f.type !== 'checkbox' || v[f.key]).map((f) => `<tr><td style="color:var(--muted); width:42%; padding:4px 10px 4px 0">${escapeHtml(f.label)}</td><td>${f.type === 'checkbox' ? 'Yes' : escapeHtml(mask(f.key, v[f.key]) || '—')}</td></tr>`).join('');
      return `<details ${submitted ? 'open' : ''} style="margin-bottom:8px"><summary style="cursor:pointer; font-weight:600; padding:4px 0">${escapeHtml(s.title)}</summary><table style="width:100%; font-size:13.5px">${rows}</table></details>`;
    }).join('');
    const label = Object.fromEntries(d.doc_types.map((t) => [t.key, t.label]));
    const have = new Set(d.docs.map((x) => x.doc_type));
    const missing = d.doc_types.filter((t) => t.required && !have.has(t.key));
    const body = openModal(`Onboarding — ${d.candidate || ''}`, `
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:10px">${obTag(d.status)} ${hrmsTag(d)}
        <span class="text-muted" style="font-size:13px">${escapeHtml(d.vacancy || '')}${d.company ? ' · ' + escapeHtml(d.company) : ''}${d.joining ? ' · joining ' + escapeHtml(obDate(d.joining.actual_date || d.joining.expected_date) || '') + ' (' + escapeHtml(d.joining.status) + ')' : ''}</span></div>
      ${d.hrms_status === 'Failed' ? `<div class="sc-note" style="background:#FBE0DE;border-color:#EBB6B3;color:#A8302B">HRMS hand-over failed: ${escapeHtml(d.hrms_error || '')}</div>` : ''}
      ${d.hrms_status === 'Sent' ? `<div class="sc-note" style="background:#DDF1EA;border-color:#A9D8C6;color:#176B53">Sent to the HRMS on ${escapeHtml(d.hrms_pushed_at || '')}.</div>` : ''}
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px">
        ${d.status === 'Submitted' ? '<button class="btn btn-primary btn-sm" id="obd-verify">Mark verified</button>' : ''}
        ${d.status === 'Verified' && d.hrms_status !== 'Sent' ? '<button class="btn btn-ghost btn-sm" id="obd-reopen">Reopen for candidate</button>' : ''}
        ${submitted && d.hrms_status !== 'Sent' ? `<button class="btn btn-${d.status === 'Verified' ? 'primary' : 'ghost'} btn-sm" id="obd-push">${d.hrms_status === 'Failed' ? 'Retry send to HRMS' : 'Send to HRMS now'}</button>` : ''}
        ${submitted ? '<button class="btn btn-ghost btn-sm" id="obd-zip">Download package (.zip)</button>' : ''}
        <button class="btn btn-ghost btn-sm" id="obd-send">Email link to candidate</button>
        <button class="btn btn-ghost btn-sm" id="obd-copy">Copy link</button>
      </div>
      ${submitted ? '' : '<p class="text-muted" style="font-size:13px">The candidate has not submitted the form yet. Anything below is a saved draft.</p>'}
      ${d.submitted_at ? `<p class="text-muted" style="font-size:13px; margin-top:0">Submitted ${escapeHtml(d.submitted_at)}${d.verified_by ? ` · verified by ${escapeHtml(d.verified_by)} ${escapeHtml(d.verified_at || '')}` : ''}</p>` : ''}
      <h4 style="margin:12px 0 6px">Documents (${d.docs.length})</h4>
      ${missing.length ? `<div class="field-hint" style="color:#A8302B">Missing: ${missing.map((m) => escapeHtml(m.label)).join(', ')}</div>` : ''}
      <div>${d.docs.length ? d.docs.map((x) => `<div style="padding:4px 0; font-size:13.5px"><span class="text-muted">${escapeHtml(label[x.doc_type] || x.doc_type)}:</span> <a href="#" data-doc="${x.id}" data-name="${escapeHtml(x.file_name)}">${escapeHtml(x.file_name)}</a></div>`).join('') : '<span class="text-muted">No documents uploaded yet.</span>'}</div>
      <h4 style="margin:16px 0 6px">Details</h4>${secs}`, { wide: true });
    body.querySelectorAll('[data-doc]').forEach((a) => a.addEventListener('click', async (e) => { e.preventDefault(); try { await downloadBlob(`/onboarding/${id}/docs/${a.dataset.doc}`, a.dataset.name); } catch (er) { toast(er.message, true); } }));
    const act = (sel, fn) => body.querySelector(sel)?.addEventListener('click', async (e) => { const b = e.currentTarget; b.disabled = true; try { await fn(); } catch (er) { toast(er.message, true); b.disabled = false; } });
    act('#obd-verify', async () => { const r = await api(`/onboarding/${id}/verify`, { method: 'POST', body: {} }); toast(r.hrms && r.hrms.sent ? 'Verified — sent to the HRMS.' : 'Marked verified.'); closeModal(); after && after(); });
    act('#obd-reopen', async () => { await api(`/onboarding/${id}/reopen`, { method: 'POST', body: {} }); toast('Reopened — the candidate can edit again.'); closeModal(); after && after(); });
    act('#obd-push', async () => { const r = await api(`/onboarding/${id}/push-hrms`, { method: 'POST', body: {} }); toast(`Sent to the HRMS (${r.documents} documents).`); closeModal(); after && after(); });
    act('#obd-zip', async () => { await downloadBlob(`/onboarding/${id}/package`, 'Onboarding.zip'); body.querySelector('#obd-zip').disabled = false; });
    act('#obd-send', async () => { const r = await api(`/onboarding/${id}/link`, { method: 'POST', body: { send: true } }); toast(`Link emailed to ${r.sent_to}.`); body.querySelector('#obd-send').disabled = false; });
    act('#obd-copy', async () => { const r = await api(`/onboarding/${id}/link`, { method: 'POST', body: {} }); await copyText(r.url); toast('Link copied.'); body.querySelector('#obd-copy').disabled = false; });
  }

  // On a Joining record: where the onboarding form stands, with the quick actions.
  async function renderOnboardingSection(record) {
    const wrap = $('#drawer-fields');
    const box = document.createElement('div'); box.className = 'field'; wrap.appendChild(box);
    let d = null;
    try { d = await api(`/onboarding/by-candidate/${record.candidate_id}?vacancy_id=${encodeURIComponent(record.vacancy_id || '')}`); } catch { /* not allowed for this role */ box.remove(); return; }
    const draw = () => {
      box.innerHTML = `<span>Onboarding form &amp; HRMS</span>
        <div style="margin-top:6px; font-size:13.5px">${d ? `${obTag(d.status)} ${hrmsTag(d)}` : '<span class="text-muted">Not sent to the candidate yet.</span>'}</div>
        <div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap">
          ${d ? '<button type="button" class="btn btn-ghost btn-sm" id="obs-open">Review form</button>' : ''}
          <button type="button" class="btn btn-${d ? 'ghost' : 'primary'} btn-sm" id="obs-send">${d ? 'Email the link again' : 'Email the onboarding form'}</button>
        </div>
        <span class="field-hint">When this record is set to Joined with an actual joining date, the candidate's details and documents are sent to the HRMS automatically (once the form is submitted).</span>`;
      $('#obs-open')?.addEventListener('click', () => openOnboardingDetail(d.id));
      $('#obs-send').addEventListener('click', async () => {
        try { const r = await api('/onboarding/invite', { method: 'POST', body: { candidate_id: record.candidate_id, vacancy_id: record.vacancy_id, offer_id: record.offer_id, send: true } }); toast(`Form link emailed to ${r.sent_to}.`); d = await api(`/onboarding/${r.id}`); draw(); }
        catch (e) { toast(e.message, true); }
      });
    };
    draw();
  }

  // Settings → HRMS hand-over
  async function renderHrmsPanel() {
    const host = $('#hrms-panel'); if (!host) return;
    const isSuper = state.user.role === 'super_admin';
    let c; try { c = await api('/onboarding/hrms-config'); } catch (e) { host.textContent = e.message; return; }
    const dis = isSuper ? '' : 'disabled';
    host.innerHTML = `
      <p class="text-muted" style="margin-top:0">When a candidate is marked <strong>Joined</strong> with a joining date, their onboarding details and documents are posted to your HRMS. Give the HRMS team the address below to receive it; they will tell you the sign-in type. If your HRMS needs different field names, send us its import format and the payload can be matched to it. Until this is on, use <strong>Download package</strong> on the Onboarding screen to upload manually.</p>
      <label class="check-row"><input type="checkbox" id="hr-enabled" ${c.enabled ? 'checked' : ''} ${dis}> Send to the HRMS</label>
      <label class="check-row"><input type="checkbox" id="hr-auto" ${c.auto_push ? 'checked' : ''} ${dis}> Send automatically when the candidate is Joined (otherwise use the “Send to HRMS now” button)</label>
      <label class="check-row"><input type="checkbox" id="hr-ver" ${c.require_verified ? 'checked' : ''} ${dis}> Wait for HR to mark the form Verified first</label>
      <label class="field"><span>HRMS address (receives a POST)</span><input type="text" id="hr-url" value="${escapeHtml(c.url || '')}" placeholder="https://hrms.example.com/api/employees/onboard" ${dis}></label>
      <div class="field-row">
        <label class="field" style="flex:1"><span>Sign-in type</span><select id="hr-auth" ${dis}>${[['none', 'None'], ['bearer', 'Bearer token'], ['header', 'API key in a header'], ['basic', 'Username:password']].map(([k, l]) => `<option value="${k}" ${c.auth_type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field" style="flex:1"><span>Header name (API key type)</span><input type="text" id="hr-hdr" value="${escapeHtml(c.auth_header || '')}" ${dis}></label>
        <label class="field" style="flex:2"><span>Token / key / user:password ${c.has_secret ? '(saved — leave blank to keep)' : ''}</span><input type="password" id="hr-secret" autocomplete="new-password" placeholder="${c.has_secret ? '••••••••' : ''}" ${dis}></label>
      </div>
      <label class="field"><span>How documents are sent</span><select id="hr-docs" ${dis}>${[['base64', 'Inside the JSON (base64) — most common'], ['multipart', 'As file attachments (multipart form)'], ['none', 'Do not send files, details only']].map(([k, l]) => `<option value="${k}" ${c.docs_mode === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${isSuper ? '<button class="btn btn-primary btn-sm" id="hr-save">Save</button>' : '<div class="field-hint">Only a Super Admin can change this.</div>'}
      <details style="margin-top:14px"><summary style="cursor:pointer; font-weight:600">What the HRMS receives</summary>
        <div class="code-box" style="margin-top:8px">POST &lt;your address&gt;   Content-Type: application/json
{
  "event": "candidate_joined",
  "candidate_code": "CAN-0042",
  "job": { "company", "designation", "location", "employment_type", "date_of_joining", "reporting_manager", "offered_ctc", "recruiter" },
  "employee": { "personal": {…}, "contact": {…}, "address": { "current", "permanent" },
                "identity": { "pan", "aadhaar", "uan", "esic", "passport" }, "bank": {…},
                "education": {…}, "previous_employment": {…}, "nominee": {…} },
  "documents": [ { "type": "pan", "file_name", "mime_type", "content_base64" }, … ]
}
Any 2xx reply counts as received. Anything else is kept as "failed" and retried every hour (5 tries).</div></details>`;
    $('#hr-save')?.addEventListener('click', async () => {
      try {
        await api('/onboarding/hrms-config', { method: 'PUT', body: { enabled: $('#hr-enabled').checked, auto_push: $('#hr-auto').checked, require_verified: $('#hr-ver').checked, url: $('#hr-url').value, auth_type: $('#hr-auth').value, auth_header: $('#hr-hdr').value, auth_value: $('#hr-secret').value, docs_mode: $('#hr-docs').value } });
        toast('HRMS settings saved.'); renderHrmsPanel();
      } catch (e) { toast(e.message, true); }
    });
  }

  /* ================================================================
     PORTAL INTEGRATION panel (Settings) — API key + how to post results
     ================================================================ */
  async function renderIntegrationPanel() {
    const host = $('#integration-panel');
    if (!host) return;
    const isSuper = state.user.role === 'super_admin';
    let st = { has_key: false };
    try { st = await api('/integrations/status'); } catch { /* keep default */ }
    const url = `${location.origin}/api/integrations/assessment-result`;
    host.innerHTML = `
      <p class="text-muted" style="margin-top:0">Lets the Plant PRO SRT / DISC portal send a candidate's result straight into the tracker, so nobody retypes scores. It needs a key (like a password for the portal) — hand the details below to whoever maintains hr.rdcc.ai. Until that is set up, use <strong>Assessments → Import results</strong> with the portal's Excel export.</p>
      <div style="margin-bottom:10px"><span class="tag ${st.has_key ? 'tag-ok' : 'tag-neutral'}">${st.has_key ? 'Key created' : 'No key yet'}</span>${st.updated_at && st.has_key ? ` <span class="text-muted" style="font-size:12.5px">last changed ${escapeHtml(st.updated_at)}</span>` : ''}</div>
      ${isSuper ? `<button class="btn btn-primary btn-sm" id="int-key-btn">${st.has_key ? 'Make a new key (the old one stops working)' : 'Create key'}</button>` : '<div class="field-hint">Only a Super Admin can create the key.</div>'}
      <div id="int-key-show"></div>
      <details style="margin-top:14px"><summary style="cursor:pointer; font-weight:600">What to give the portal team</summary>
        <div class="code-box" style="margin-top:8px">POST ${escapeHtml(url)}
Header:  X-API-Key: &lt;the key&gt;
Body (JSON):
{
  "email": "candidate@example.com",      (or "mobile", or "candidate_code")
  "assessment_type": "DISC",             ("DISC" or "Plant PRO SRT")
  "score": "D 72 / I 55",
  "result_summary": "Dominant–Influencer",
  "report_link": "https://hr.rdcc.ai/…",
  "assessment_date": "2026-11-05"
}
Several at once:  { "results": [ {…}, {…} ] }  (up to 200)</div>
        <div class="field-hint">The candidate must already exist in the tracker. A pending/sent assessment of that type is completed; otherwise a new record is added to their latest application. This address only works where the tracker can be reached from the portal — once it is hosted.</div>
      </details>
      <hr style="margin:18px 0; border:0; border-top:1px solid var(--line)">
      <h4 style="margin:0 0 6px">Or: let the tracker fetch results from the portal</h4>
      <p class="text-muted" style="margin-top:0">Every hour the tracker asks the portal for the result of each assessment marked Pending or Sent, and fills it in once the candidate has finished. The portal team must give you the address to read a result and an access key. Use <code>{email}</code>, <code>{mobile}</code> or <code>{candidate_code}</code> in the address where the candidate goes.</p>
      <div id="pp-box" class="text-muted">Loading…</div>`;
    loadPortalPull(isSuper);
    $('#int-key-btn')?.addEventListener('click', async () => {
      if (st.has_key && !confirm('Make a new key? Anything using the old key stops working until you give it the new one.')) return;
      try {
        const r = await api('/integrations/api-key', { method: 'POST', body: {} });
        $('#int-key-show').innerHTML = `<div class="key-reveal"><div style="font-weight:600; margin-bottom:6px">Copy this key now — it will not be shown again</div><div style="display:flex; gap:8px"><input type="text" id="int-key" readonly value="${escapeHtml(r.key)}" style="flex:1; font-family:var(--font-mono)"><button class="btn btn-ghost btn-sm" id="int-key-copy">Copy</button></div></div>`;
        $('#int-key').select();
        $('#int-key-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(r.key); } catch { $('#int-key').select(); document.execCommand('copy'); } toast('Key copied.'); });
        $('#int-key-btn').textContent = 'Make a new key (the old one stops working)'; st.has_key = true;
      } catch (e) { toast(e.message, true); }
    });
  }

  async function loadPortalPull(isSuper) {
    const box = $('#pp-box'); if (!box) return;
    let c; try { c = await api('/integrations/portal-pull'); } catch (e) { box.textContent = e.message; return; }
    const v = (k) => escapeHtml(c[k] || '');
    const dis = isSuper ? '' : 'disabled';
    const last = c.last ? `Last check ${escapeHtml(new Date(c.last.at).toLocaleString())}: ${c.last.checked} checked, ${c.last.completed} completed, ${c.last.waiting} still waiting${c.last.errors && c.last.errors.length ? ' · ' + escapeHtml(c.last.errors.join('; ')) : ''}.` : 'Not checked yet.';
    box.className = '';
    box.innerHTML = `
      <label class="check-row"><input type="checkbox" id="pp-enabled" ${c.enabled ? 'checked' : ''} ${dis}> Fetch results automatically every hour</label>
      <div class="field-row">
        <label class="field" style="flex:1"><span>Plant PRO SRT result address</span><input type="text" id="pp-srt" value="${v('srt_url')}" placeholder="https://hr.rdcc.ai/api/srt/result?email={email}" ${dis}></label>
        <label class="field" style="flex:1"><span>DISC result address</span><input type="text" id="pp-disc" value="${v('disc_url')}" placeholder="https://hr.rdcc.ai/api/disc/result?email={email}" ${dis}></label>
      </div>
      <div class="field-row">
        <label class="field" style="flex:1"><span>Access key name (header)</span><input type="text" id="pp-hdr" value="${v('auth_header')}" ${dis}></label>
        <label class="field" style="flex:2"><span>Access key ${c.has_secret ? '(saved — leave blank to keep)' : ''}</span><input type="password" id="pp-secret" autocomplete="new-password" placeholder="${c.has_secret ? '••••••••' : 'Given by the portal team'}" ${dis}></label>
      </div>
      <details><summary style="cursor:pointer; font-weight:600">Field names in the portal's reply</summary>
        <div class="field-hint">Open one result in your browser or ask the portal team, then type where each value is. Use dots for nested values, e.g. <code>data.score</code>.</div>
        <div class="field-row">
          <label class="field"><span>Score</span><input type="text" id="pp-score" value="${v('score_path')}" ${dis}></label>
          <label class="field"><span>Result / summary</span><input type="text" id="pp-sum" value="${v('summary_path')}" ${dis}></label>
          <label class="field"><span>Report link</span><input type="text" id="pp-rep" value="${v('report_path')}" ${dis}></label>
          <label class="field"><span>Completed date</span><input type="text" id="pp-date" value="${v('date_path')}" ${dis}></label>
        </div>
        <div class="field-row">
          <label class="field"><span>Reply wrapper (optional)</span><input type="text" id="pp-res" value="${v('results_path')}" placeholder="e.g. data" ${dis}></label>
          <label class="field"><span>Status field (optional)</span><input type="text" id="pp-stat" value="${v('status_path')}" placeholder="e.g. status" ${dis}></label>
          <label class="field"><span>Status values meaning finished</span><input type="text" id="pp-ok" value="${v('completed_values')}" ${dis}></label>
        </div>
        <div class="field-hint">If no status field is given, a result counts as finished as soon as the score is present.</div>
      </details>
      <div style="margin-top:10px">${isSuper ? '<button class="btn btn-primary btn-sm" id="pp-save">Save</button>' : ''}
        <button class="btn btn-ghost btn-sm" id="pp-test">Test (changes nothing)</button>
        <button class="btn btn-ghost btn-sm" id="pp-run">Check now and update</button></div>
      <div class="field-hint" id="pp-last" style="margin-top:8px">${last}</div>`;
    const read = () => ({ enabled: $('#pp-enabled').checked, srt_url: $('#pp-srt').value, disc_url: $('#pp-disc').value, auth_header: $('#pp-hdr').value, auth_value: $('#pp-secret').value,
      score_path: $('#pp-score').value, summary_path: $('#pp-sum').value, report_path: $('#pp-rep').value, date_path: $('#pp-date').value, results_path: $('#pp-res').value, status_path: $('#pp-stat').value, completed_values: $('#pp-ok').value });
    $('#pp-save')?.addEventListener('click', async () => {
      try { await api('/integrations/portal-pull', { method: 'PUT', body: read() }); toast('Saved.'); loadPortalPull(isSuper); } catch (e) { toast(e.message, true); }
    });
    const check = (dry) => async () => {
      try {
        if (isSuper) await api('/integrations/portal-pull', { method: 'PUT', body: read() });
        const r = await api('/integrations/portal-pull/run', { method: 'POST', body: { dry } });
        $('#pp-last').innerHTML = `${dry ? 'Test' : 'Checked'}: ${r.checked} assessment(s) looked up, ${r.completed} ${dry ? 'ready to fill in' : 'completed'}, ${r.waiting} not finished yet.${r.errors && r.errors.length ? ' <span style="color:var(--danger,#b3261e)">' + escapeHtml(r.errors.join('; ')) + '</span>' : ''}`;
      } catch (e) { toast(e.message, true); }
    };
    $('#pp-test').addEventListener('click', check(true));
    $('#pp-run').addEventListener('click', check(false));
  }

  /* ================================================================
     BULK RESUME UPLOAD
     ================================================================ */
  async function openBulkResumes() {
    let vacancies = [];
    try { vacancies = (await api('/vacancies?pageSize=100')).data.filter((v) => !CLOSED_VACANCY.includes(v.status)); } catch { /* optional */ }
    const body = openModal('Upload many resumes at once', `
      <p class="text-muted" style="margin-top:0">Drop up to 100 resumes (PDF, DOCX or TXT). Each one becomes a candidate with the details read from it; people already in the system are recognised by email or mobile and not added twice. Scanned images can't be read — those are listed so you can add them by hand.</p>
      <div class="field-row">
        <label class="field" style="flex:2"><span>Tag them to a vacancy (optional)</span><select id="bu-vac"><option value="">Don't tag to a vacancy</option>${vacancies.map((v) => `<option value="${v.id}">${escapeHtml([v.vacancy_code, v.title, v.location].filter(Boolean).join(' · '))}</option>`).join('')}</select></label>
        <label class="field" style="flex:1"><span>Source</span><input type="text" id="bu-source" value="Bulk upload" placeholder="Naukri, LinkedIn…"></label>
      </div>
      <label class="dropzone" id="bu-drop"><input type="file" id="bu-files" multiple accept=".pdf,.doc,.docx,.txt" hidden><div><strong>Choose resumes</strong> or drop them here</div><div class="text-muted" id="bu-count" style="font-size:13px">No files chosen</div></label>
      <div class="field-hint">Tagging to a vacancy also calculates each candidate's match score against its Job Description.</div>
      <div class="modal-error" id="bu-error" hidden></div>
      <div id="bu-progress"></div><div id="bu-results"></div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" id="bu-close">Close</button><button type="button" class="btn btn-primary" id="bu-go" disabled>Upload</button></div>`, { wide: true });
    let files = [];
    const setFiles = (list) => {
      files = Array.from(list).filter((f) => /\.(pdf|docx|txt)$/i.test(f.name)).slice(0, 100);
      const skipped = list.length - files.length;
      $('#bu-count').textContent = files.length ? `${files.length} file${files.length === 1 ? '' : 's'} ready${skipped > 0 ? ` (${skipped} skipped — only PDF, DOCX or TXT, up to 100)` : ''}` : 'No files chosen';
      $('#bu-go').disabled = !files.length; $('#bu-go').textContent = files.length ? `Upload ${files.length}` : 'Upload';
    };
    $('#bu-files').addEventListener('change', (e) => setFiles(e.target.files));
    const dz = $('#bu-drop');
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
    dz.addEventListener('drop', (e) => setFiles(e.dataTransfer.files));
    $('#bu-close').addEventListener('click', closeModal);
    $('#bu-go').addEventListener('click', async () => {
      const go = $('#bu-go');
      if (go.dataset.done) { closeModal(); return; }
      go.disabled = true; $('#bu-error').hidden = true; $('#bu-files').disabled = true;
      const all = []; const BATCH = 8;
      try {
        for (let i = 0; i < files.length; i += BATCH) {
          $('#bu-progress').innerHTML = `<div class="bar"><div style="width:${Math.round((i / files.length) * 100)}%"></div></div><div class="text-muted" style="font-size:13px">Reading resumes… ${Math.min(i + BATCH, files.length)} of ${files.length}</div>`;
          const fd = new FormData();
          files.slice(i, i + BATCH).forEach((f) => fd.append('resumes', f, f.name));
          fd.append('vacancy_id', $('#bu-vac').value); fd.append('source', $('#bu-source').value);
          const r = await api('/candidates/bulk-upload', { method: 'POST', body: fd });
          all.push(...r.results);
        }
      } catch (e) { $('#bu-error').textContent = `Stopped part-way: ${e.message}. What was already processed is shown below and is saved.`; $('#bu-error').hidden = false; }
      const n = (s) => all.filter((x) => x.status === s).length;
      $('#bu-progress').innerHTML = `<div class="bu-summary"><span class="tag tag-ok">${n('created')} added</span> <span class="tag tag-warn">${n('duplicate')} already in the system</span> <span class="tag ${n('failed') ? 'tag-danger' : 'tag-neutral'}">${n('failed')} need manual entry</span></div>`;
      const label = { created: ['tag-ok', 'Added'], duplicate: ['tag-warn', 'Already exists'], failed: ['tag-danger', 'Not added'] };
      const sorted = [...all].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
      $('#bu-results').innerHTML = `<div class="table-wrap" style="max-height:320px; overflow:auto; margin-top:10px"><table class="data-table"><thead><tr><th style="width:24%">File</th><th>Result</th><th style="width:11%">Match</th><th style="width:11%"></th></tr></thead><tbody>${sorted.map((x) => `
        <tr><td>${escapeHtml(x.file)}</td><td><span class="tag ${label[x.status][0]}">${label[x.status][1]}</span><div class="text-muted" style="font-size:12.5px">${escapeHtml(x.message)}</div></td>
        <td class="mono">${x.score !== null && x.score !== undefined && x.status === 'created' ? escapeHtml(x.score) + '%' : '—'}</td>
        <td>${x.candidate ? `<button class="link-btn bu-open" data-id="${x.candidate.id}">Open</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
      $$('.bu-open').forEach((b) => b.addEventListener('click', () => { closeModal(); goAndOpen('candidates', () => openEditDrawer('candidates', b.dataset.id)); }));
      go.textContent = 'Done'; go.disabled = false; go.dataset.done = '1';
      if (state.route === 'candidates') loadList('candidates');
      if (n('created')) toast(`${n('created')} candidate${n('created') === 1 ? '' : 's'} added.`);
    });
  }

  /* ---------------- "How to use this" page ---------------- */
  function renderHelp() {
    const step = (n, title, where, body) => `
      <div class="panel" style="margin-bottom:12px"><div class="panel-body pad">
        <div style="display:flex; gap:14px; align-items:flex-start">
          <div style="background:var(--hivis); color:var(--ink); width:30px; height:30px; border-radius:9px; font-family:var(--font-head); display:flex; align-items:center; justify-content:center; font-weight:600; flex-shrink:0">${n}</div>
          <div><div style="font-weight:600">${title} <span class="text-muted" style="font-weight:400; font-size:12px">· ${where}</span></div>
          <div style="font-size:13px; margin-top:4px; line-height:1.5">${body}</div></div>
        </div></div></div>`;
    $('#content').innerHTML = `
      <div class="page-header"><div><h1>How to use this</h1><div class="sub">A hire from start to finish, in the order things happen</div></div></div>
      ${step(1, 'Raise the vacancy', 'Vacancies → + Add Vacancy', 'Fill in the title, company, location, who raised it, priority and positions required, then assign a recruiter — they get an email automatically. Tag a Job Description so candidates can be scored.')}
      ${step(2, 'Add candidates', 'Candidates → Add from resume, or Upload many resumes', 'Have a pile of resumes? Use <strong>Upload many resumes</strong>, pick the vacancy, and drop them all in — each becomes a candidate, is tagged to the vacancy and scored. People already in the system are recognised and not added twice. Upload a PDF or DOCX resume and the form fills in for you — name, mobile, email, experience, skills and more. Check it, then save; the resume is attached automatically. A candidate is treated as a duplicate if the email or mobile number is already on another record, and the app will show you that record instead of letting you add a second one.')}
      ${step(3, 'Tag the candidate to a vacancy', 'Open the candidate → Next step', 'The <strong>Next step</strong> box at the top of every candidate record always shows what to do now and gives you a button for it. Start with "Link to a vacancy".')}
      ${step(4, 'Interviews', 'Next step → Schedule interview', 'Pick the type, date and time. A calendar invite (.ics) is attached to the email so it lands in Outlook or Google Calendar. For Video interviews a Google Meet link is created and one email goes to the candidate, interviewer and recruiter, with a reminder the day before. Changed the time? Saving re-sends it. Use <em>Resend confirmation</em> any time. After the interview, open it and score the <strong>scorecard</strong> (1–5 per criterion) — the overall rating is worked out for you. Or press <em>Create link</em> in the scorecard section to send the interviewer a private link so they fill it in themselves. The interviewer also gets the candidate’s resume (attached to their email and downloadable from the scorecard page) and picks the recommended engagement: On Roll, Off Roll, Fixed Term Contract or Retainer Contract. Compare everyone side by side on the <strong>Scorecards</strong> page. For several rounds at once use <em>+ Add Multiple Rounds</em> on the Interviews page.')}
      ${step(5, 'Assessments', 'Next step → Record assessment', 'Open Plant PRO SRT or DISC from the buttons on the Assessments page, then record the result here so it sits with the interview feedback.')}
      ${step(6, 'Offer and appointment letter', 'Next step → Create offer', 'Type the Annual CTC and press <em>Calculate breakdown</em> — all components fill in automatically. Review, save, then press <strong>Send for approval</strong>: the company’s Authorized Signatory gets a private link to review and e-sign. Once they approve, the signed appointment letter is emailed to the candidate, recruiter and any extra addresses you add. Made the letter yourself? Use <strong>Upload your own letter</strong> in the same offer and press <em>Send this letter to candidate</em> — no signatory approval needed.')}
      ${step(7, 'Joining and onboarding', 'Next step → Add joining · Onboarding', 'Record the expected date. The appointment-letter email already carries the candidate’s private <strong>onboarding form</strong> link (personal, address, PAN/Aadhaar, bank, nominee details and documents) — track it on the <strong>Onboarding</strong> page. Mark the joining <strong>Joined</strong> with the actual date: the details and documents are sent to your HRMS automatically (Settings → HRMS hand-over), or use <em>Download package</em> to upload them by hand. When all positions are filled the vacancy closes by itself and its turnaround time is captured.')}
      ${step(8, 'Follow progress', 'Dashboard · Reports · Monday email', 'The Dashboard shows time-to-close and vacancies open for too long. Admin → Reports builds Excel reports with the columns you choose. The weekly tracker email goes out every Monday.')}
      ${step(9, 'What happens by itself', 'No clicks needed', 'Scheduling an interview moves the application to Interview. Sending or accepting an offer moves it to Offered; an accepted offer creates the joining record; a declined offer marks the candidate Withdrawn. Marking Joined sets the candidate to Placed and counts the vacancy as filled. When you close a vacancy you are offered to reject the remaining applicants with a polite email. Follow-up reminders and tasks are created by the server every hour. Anything that happened automatically is shown after you save.')}
      ${step(11, 'Reports and downloads', 'Candidate record · Candidates → Consolidated report', 'Open a candidate and use <em>Candidate report</em> to download a Word file or print it as PDF. For everyone at once (or one vacancy / company / date range), use <strong>Consolidated report</strong> to get an Excel file. Custom column reports are under Admin → Reports.')}
      ${step(10, 'Emails to candidates', 'Candidate → Next step → Send email…', 'One-click rejection, shortlist, documents-needed and assessment-invite emails from ready templates (edit them under Admin → Email templates). Replies go to you.')}
      <div class="panel"><div class="panel-body pad" style="font-size:13px; line-height:1.6">
        <strong>Good habits</strong><br>
        • Update a record's status as things happen — the dashboard, reports and Monday email all read from it.<br>
        • Pick from the dropdowns instead of typing where one is offered; typed variations split your reports.<br>
        • Closed Internally = filled from within the company. Cancelled = no longer needed. Both stop the clock.<br>
        • Stuck? Open the candidate and look at <strong>Next step</strong>.
      </div></div>`;
  }

  /* ---------------- Applications mini-section (candidates only) ---------------- */
  async function renderApplicationsSection(candidateId) {
    const wrap = $('#drawer-fields');
    const box = document.createElement('div');
    box.className = 'field';
    const writable = canWrite('candidates');
    box.innerHTML = `<span>Vacancies this candidate is tagged to</span>
      <div id="app-list" class="text-muted" style="font-size:13px">Loading…</div>
      ${writable ? `<div style="margin-top:8px">${buildFieldEl({ key: 'link_vacancy', label: 'Link to a vacancy', type: 'relation', relation: 'vacancies' }, {}).outerHTML}</div>
      <button type="button" id="link-vacancy-btn" class="btn btn-ghost btn-sm" style="margin-top:6px;align-self:flex-start">Link to vacancy</button>` : ''}`;
    wrap.appendChild(box);

    async function refreshApplications() {
      const res = await api(`/applications?candidate_id=${candidateId}&pageSize=50`);
      const listEl = $('#app-list');
      if (!res.data.length) { listEl.textContent = 'Not tagged to any vacancy yet.'; return; }
      listEl.innerHTML = '';
      for (const a of res.data) {
        const row = document.createElement('div');
        row.style.marginBottom = '6px';
        row.innerHTML = `<span class="rel-cell" data-table="vacancies" data-id="${a.vacancy_id}">…</span>
          &nbsp;${tagHtml('applications', 'status', a.status)}
          ${a.match_score !== null && a.match_score !== undefined ? `<span class="text-muted"> · ${a.match_score}% match</span>` : ''}`;
        listEl.appendChild(row);
      }
      hydrateRelationCells(listEl);
    }
    await refreshApplications();

    const linkBtn = $('#link-vacancy-btn');
    if (linkBtn) {
      linkBtn.addEventListener('click', async () => {
        const vacancyId = $('#field-link_vacancy').value;
        if (!vacancyId) { toast('Search for and select a vacancy first.', true); return; }
        try {
          await api('/applications', { method: 'POST', body: { candidate_id: candidateId, vacancy_id: vacancyId } });
          toast('Candidate tagged to vacancy.');
          $('#relinput-link_vacancy').value = '';
          $('#field-link_vacancy').value = '';
          await refreshApplications();
        } catch (err) { toast(err.message, true); }
      });
    }
  }

  /* ---------------- Resume mini-section (candidates only) ---------------- */
  // One candidate's full report: Word file, or a print-ready page (Print / Save as PDF).
  function renderCandidateReportSection(candidateId) {
    const wrap = $('#drawer-fields');
    const box = document.createElement('div');
    box.className = 'field';
    box.innerHTML = `<span>Candidate report</span>
      <div class="field-hint" style="margin-top:0">Profile, applications, interview scorecards, assessments, offer and joining in one document.</div>
      <div style="display:flex; gap:8px; margin-top:6px">
        <a class="btn btn-ghost btn-sm" style="text-decoration:none" href="/api/candidates/${candidateId}/report">Download Word</a>
        <a class="btn btn-ghost btn-sm" style="text-decoration:none" href="/api/candidates/${candidateId}/report?format=html" target="_blank" rel="noopener">Print / PDF</a>
      </div>`;
    wrap.appendChild(box);
  }

  // Consolidated Excel across candidates: everyone, or one vacancy / company / date range.
  async function openConsolidatedReport() {
    let vacancies = [];
    try { vacancies = (await api('/vacancies?pageSize=100')).data; } catch { /* optional */ }
    const body = openModal('Consolidated candidate report', `
      <p class="text-muted" style="margin-top:0">One Excel file with every candidate: profile, vacancy, stage, who it is pending with, interview averages, SRT / DISC, offer and joining — plus separate sheets for interview scores and assessments. Leave the filters empty for everyone.</p>
      <div class="field-row">
        <label class="field" style="flex:2"><span>Vacancy</span><select id="cr-vac"><option value="">All vacancies</option>${vacancies.map((v) => `<option value="${v.id}">${escapeHtml([v.vacancy_code, v.title, v.location].filter(Boolean).join(' · '))}</option>`).join('')}</select></label>
        <label class="field" style="flex:2"><span>Company</span><select id="cr-co"><option value="">All companies</option>${ENUM.company.map((c) => `<option>${escapeHtml(c)}</option>`).join('')}</select></label>
      </div>
      <div class="field-row">
        <label class="field"><span>From date</span><input type="date" id="cr-from"></label>
        <label class="field"><span>To date</span><input type="date" id="cr-to"></label>
      </div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" id="cr-close">Close</button><button type="button" class="btn btn-primary" id="cr-go">Download Excel</button></div>`);
    $('#cr-close').addEventListener('click', closeModal);
    $('#cr-go').addEventListener('click', () => {
      const q = new URLSearchParams();
      [['vacancy_id', '#cr-vac'], ['company', '#cr-co'], ['from', '#cr-from'], ['to', '#cr-to']].forEach(([k, sel]) => { const v = $(sel).value; if (v) q.set(k, v); });
      window.location.href = '/api/reports/consolidated?' + q.toString();
      closeModal();
    });
  }

  async function renderResumeSection(candidateId) {
    const wrap = $('#drawer-fields');
    const box = document.createElement('div');
    box.className = 'field';
    box.innerHTML = `<span>Resumes</span><div id="resume-list" class="text-muted" style="font-size:13px">Loading…</div>
      ${canWrite('candidates') ? `<input type="file" id="resume-file" style="margin-top:6px">
      <button type="button" id="resume-upload-btn" class="btn btn-ghost btn-sm" style="margin-top:6px;align-self:flex-start">Upload resume</button>` : ''}`;
    wrap.appendChild(box);

    async function refreshResumes() {
      const resumes = await api(`/candidates/${candidateId}/resumes`);
      const listEl = $('#resume-list');
      if (!resumes.length) { listEl.textContent = 'No resumes uploaded yet.'; return; }
      listEl.innerHTML = resumes.map((r) => `<div style="margin-bottom:4px">
        <a href="${API}/resumes/${r.id}/download" target="_blank">${escapeHtml(r.file_name)}</a>
        <span class="text-muted"> v${r.version} · ${r.is_current ? 'current' : 'superseded'}</span>
      </div>`).join('');
    }
    await refreshResumes();

    const uploadBtn = $('#resume-upload-btn');
    if (uploadBtn) {
      uploadBtn.addEventListener('click', async () => {
        const fileInput = $('#resume-file');
        if (!fileInput.files.length) { toast('Choose a file first.', true); return; }
        const fd = new FormData();
        fd.append('resume', fileInput.files[0]);
        try {
          await api(`/candidates/${candidateId}/resumes`, { method: 'POST', body: fd });
          toast('Resume uploaded.');
          fileInput.value = '';
          await refreshResumes();
        } catch (err) { toast(err.message, true); }
      });
    }
  }

  /* ================================================================
     SETTINGS
     ================================================================ */
  /* ---------------- Reports (admin picks the columns) ---------------- */
  async function renderReports() {
    const catalogue = await api('/reports/catalogue');
    const store = {
      get(k) { try { return JSON.parse(localStorage.getItem('report-cols-' + k) || 'null'); } catch { return null; } },
      set(k, v) { try { localStorage.setItem('report-cols-' + k, JSON.stringify(v)); } catch { /* ignore */ } }
    };
    $('#content').innerHTML = `
      <div class="page-header"><div><h1>Reports</h1><div class="sub">Choose a report, tick the columns you need, then preview or download it as Excel</div></div><button class="btn btn-ghost" id="rp-consolidated">Consolidated candidate report</button></div>
      <div class="panel"><div class="panel-body pad">
        <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:14px; margin-bottom:16px;">
          <label class="field"><span>Report</span><select id="rp-type">${catalogue.map((r) => `<option value="${r.key}">${escapeHtml(r.label)}</option>`).join('')}</select></label>
          <label class="field"><span>Status (optional)</span><input type="text" id="rp-status" placeholder="e.g. Open"></label>
          <label class="field"><span>From date (optional)</span><input type="date" id="rp-from"></label>
          <label class="field"><span>To date (optional)</span><input type="date" id="rp-to"></label>
        </div>
        <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
          <strong style="font-size:13px">Columns</strong>
          <button class="btn btn-ghost btn-sm" id="rp-all">Select all</button>
          <button class="btn btn-ghost btn-sm" id="rp-none">Clear</button>
        </div>
        <div id="rp-cols" style="display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:6px 16px; margin-bottom:18px;"></div>
        <button class="btn btn-ghost" id="rp-preview">Preview</button>
        <button class="btn btn-primary" id="rp-download" style="margin-left:8px">Download Excel</button>
        <div class="field-hint" style="margin-top:8px">Columns appear in the report in the order shown here. The date filter uses the created date (offer date for offers, interview date for interviews, tentative DOJ for joinings).</div>
      </div></div>
      <div class="panel" id="rp-result" hidden><div class="panel-head"><h3 id="rp-count"></h3></div><div class="table-wrap" id="rp-table"></div></div>
    `;
    $('#rp-consolidated').addEventListener('click', openConsolidatedReport);
    const typeSel = $('#rp-type');
    const colsBox = $('#rp-cols');
    const current = () => catalogue.find((r) => r.key === typeSel.value);
    const selected = () => [...colsBox.querySelectorAll('input:checked')].map((i) => i.value);

    function drawCols() {
      const rep = current();
      const saved = store.get(rep.key);
      colsBox.innerHTML = rep.columns.map((c) => `
        <label style="display:flex; gap:8px; align-items:center; font-size:13px;">
          <input type="checkbox" value="${c.key}" ${(saved ? saved.includes(c.key) : true) ? 'checked' : ''}> ${escapeHtml(c.label)}
        </label>`).join('');
      colsBox.querySelectorAll('input').forEach((i) => i.addEventListener('change', () => store.set(rep.key, selected())));
    }
    drawCols();
    typeSel.addEventListener('change', () => { drawCols(); $('#rp-result').hidden = true; });
    $('#rp-all').addEventListener('click', () => { colsBox.querySelectorAll('input').forEach((i) => { i.checked = true; }); store.set(typeSel.value, selected()); });
    $('#rp-none').addEventListener('click', () => { colsBox.querySelectorAll('input').forEach((i) => { i.checked = false; }); store.set(typeSel.value, selected()); });

    const payload = () => ({
      report: typeSel.value,
      columns: selected(),
      status: $('#rp-status').value.trim(),
      from: $('#rp-from').value,
      to: $('#rp-to').value
    });

    $('#rp-preview').addEventListener('click', async () => {
      try {
        const { headers, rows } = await api('/reports/run', { method: 'POST', body: payload() });
        $('#rp-result').hidden = false;
        $('#rp-count').textContent = `${rows.length} row${rows.length === 1 ? '' : 's'}`;
        const shown = rows.slice(0, 200);
        $('#rp-table').innerHTML = `<table class="data-table"><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${
          shown.length ? shown.map((r) => `<tr>${r.map((v) => `<td>${escapeHtml(String(v))}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headers.length}" style="text-align:center">No records match.</td></tr>`
        }</tbody></table>${rows.length > shown.length ? `<div class="field-hint" style="padding:10px">Showing the first ${shown.length} rows — the Excel download has all ${rows.length}.</div>` : ''}`;
      } catch (err) { toast(err.message, true); }
    });

    $('#rp-download').addEventListener('click', async () => {
      try {
        const res = await fetch(API + '/reports/download', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload())
        });
        if (!res.ok) {
          let msg = 'Download failed';
          try { msg = (await res.json()).error || msg; } catch { /* no body */ }
          throw new Error(msg);
        }
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${typeSel.value}-report-${new Date().toISOString().slice(0, 10)}.xlsx`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      } catch (err) { toast(err.message, true); }
    });
  }

  async function renderSettings() {
    const rows = await api('/settings');
    const editable = ['super_admin', 'hr_manager'].includes(state.user.role);
    const isSuperAdmin = state.user.role === 'super_admin';
    const googleStatus = await api('/google/status');
    $('#content').innerHTML = `
      <div class="page-header"><div><h1>Settings</h1><div class="sub">Scoring weights, SLA thresholds, email &amp; Google Calendar</div></div></div>
      <div class="panel">
        <div class="panel-head"><h3>Google Calendar (for Meet links)</h3></div>
        <div class="panel-body pad">
          <p class="text-muted" style="margin-top:0">Needed for the "Generate Meet Link" button on interviews. Connecting uses one Google account for the whole team.</p>
          <div id="google-status" style="margin-bottom:10px">
            <span class="tag ${googleStatus.connected ? 'tag-ok' : 'tag-neutral'}">${googleStatus.connected ? 'Connected' : 'Not connected'}</span>
          </div>
          ${isSuperAdmin ? `<button class="btn btn-primary btn-sm" id="google-connect-btn">${googleStatus.connected ? 'Reconnect' : 'Connect'} Google Calendar</button>
          ${googleStatus.connected ? `<button class="btn btn-ghost btn-sm" id="google-disconnect-btn" style="margin-left:8px">Disconnect</button>` : ''}` : '<p class="field-hint">Only a Super Admin can connect or disconnect this.</p>'}
        </div>
      </div>
      ${editable ? `<div class="panel">
        <div class="panel-head"><h3>Automatic reminders</h3></div>
        <div class="panel-body pad">
          <p class="text-muted" style="margin-top:0">Checks every hour (emails only go out between 8am and 7pm). It creates tasks on the <strong>Follow-ups</strong> page for the recruiter, and ticks them off by itself when the work is done:</p>
          <ul class="text-muted" style="margin:0 0 12px 18px; padding:0; line-height:1.7">
            <li><strong>Interviews:</strong> feedback or scorecard not in — the interviewer is nudged 1 and 3 days after, with their scorecard link</li>
            <li><strong>Assessments:</strong> still Pending (not sent) or Sent but not completed after 2 days</li>
            <li><strong>Offers:</strong> no response after 3 days, validity ending in 2 days, or lapsed</li>
            <li><strong>Joining:</strong> 3 days and 1 day before (documents, onboarding form), and when the date passes with no outcome</li>
          </ul>
          <label class="check-row"><input type="checkbox" id="rem-enabled"> Automatic reminders are on</label>
          <label class="check-row"><input type="checkbox" id="rem-cand"> Also email candidates (assessment, offer and joining reminders)</label>
          <div class="field-hint" style="margin:2px 0 12px">Each recruiter also gets one digest email a day. Interviewers are always nudged about scorecards when reminders are on. Nobody is emailed twice for the same reminder.</div>
          <button class="btn btn-ghost btn-sm" id="rem-preview">Preview what's due now</button>
          <button class="btn btn-primary btn-sm" id="rem-run" style="margin-left:8px">Run now</button>
          <div id="rem-result" style="margin-top:12px"></div>
        </div>
      </div>` : ''}
      ${editable ? `<div class="panel">
        <div class="panel-head"><h3>HRMS hand-over (onboarding)</h3></div>
        <div class="panel-body pad" id="hrms-panel">Loading…</div>
      </div>` : ''}
      ${editable ? `<div class="panel">
        <div class="panel-head"><h3>Assessment results from the portal</h3></div>
        <div class="panel-body pad" id="integration-panel">Loading…</div>
      </div>` : ''}
      <div class="panel">
        <div class="panel-head"><h3>Weekly Position Tracker email</h3></div>
        <div class="panel-body pad">
          <p class="text-muted" style="margin-top:0">Sends automatically every Monday morning (while the app is running), with vacancies in progress and upcoming joinings. Set recipients in "email_recipients" below — a comma-free JSON list like <code>["you@rdc.in","boss@rdc.in"]</code>.</p>
          ${editable ? `<button class="btn btn-primary btn-sm" id="send-tracker-btn">Send Now</button>` : ''}
        </div>
      </div>
      <div class="panel"><div class="settings-grid" id="settings-grid"></div></div>
    `;

    if (isSuperAdmin) {
      $('#google-connect-btn').addEventListener('click', () => {
        const popup = window.open(`${API}/google/auth`, 'google-connect', 'width=520,height=650');
        const onMsg = (e) => {
          if (e.data === 'google-connected') {
            toast('Google Calendar connected.');
            window.removeEventListener('message', onMsg);
            renderSettings();
          }
        };
        window.addEventListener('message', onMsg);
      });
      $('#google-disconnect-btn')?.addEventListener('click', async () => {
        try {
          await api('/google/disconnect', { method: 'POST' });
          toast('Google Calendar disconnected.');
          renderSettings();
        } catch (err) { toast(err.message, true); }
      });
    }

    if (editable) {
      $('#send-tracker-btn').addEventListener('click', async () => {
        const btn = $('#send-tracker-btn');
        const original = btn.textContent;
        btn.textContent = 'Sending…';
        btn.disabled = true;
        try {
          const res = await api('/tracker/send-now', { method: 'POST' });
          toast(`Sent to ${res.recipients.join(', ')}`);
        } catch (err) {
          toast(err.message, true);
        } finally {
          btn.textContent = original;
          btn.disabled = false;
        }
      });
    }

    if (editable) {
      const val = (k) => { const r = rows.find((x) => x.key === k); return r && !['false', '0', 'no', 'off'].includes(String(r.value).toLowerCase()); };
      $('#rem-enabled').checked = val('reminders_enabled');
      $('#rem-cand').checked = val('reminders_candidate_emails');
      const save = (key, el) => el.addEventListener('change', async () => {
        try { await api(`/settings/${key}`, { method: 'PUT', body: { value: el.checked ? 'true' : 'false' } }); toast('Saved.'); }
        catch (err) { toast(err.message, true); el.checked = !el.checked; }
      });
      save('reminders_enabled', $('#rem-enabled')); save('reminders_candidate_emails', $('#rem-cand'));
      const show = (r) => {
        const kindLabel = { candidate: 'Candidate', interviewer: 'Interviewer', digest: 'Recruiter digest' };
        const parts = [];
        if (r.note) parts.push(`<div class="field-hint">${escapeHtml(r.note)}</div>`);
        parts.push(`<div><strong>${r.dry ? 'Would create' : 'Created'} ${r.tasksCreated.length} follow-up task${r.tasksCreated.length === 1 ? '' : 's'}</strong>${r.tasksResolved ? ` · ${r.tasksResolved} ${r.dry ? 'would be ' : ''}closed (work already done)` : ''} · ${r.tasksOpen} open in total</div>`);
        if (r.tasksCreated.length) parts.push(`<ul class="text-muted" style="margin:6px 0 10px 18px; padding:0">${r.tasksCreated.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`);
        const sent = r.emails.filter((e) => !e.held);
        parts.push(`<div><strong>${r.dry ? 'Would email' : 'Emailed'} ${sent.length}</strong>${r.emails.length - sent.length ? ` · ${r.emails.length - sent.length} on hold` : ''}${r.failed.length ? ` · <span style="color:var(--danger)">${r.failed.length} failed</span>` : ''}</div>`);
        if (r.emails.length) parts.push(`<ul class="text-muted" style="margin:6px 0 0 18px; padding:0">${r.emails.map((e) => `<li>${escapeHtml(kindLabel[e.kind] || e.kind)} · ${escapeHtml(e.to)} — ${escapeHtml(e.subject)}${e.held ? ' <em>(on hold)</em>' : ''}</li>`).join('')}</ul>`);
        if (r.failed.length) parts.push(`<ul style="margin:6px 0 0 18px; padding:0; color:var(--danger)">${r.failed.map((e) => `<li>${escapeHtml(e.to)} — ${escapeHtml(e.error)}</li>`).join('')}</ul>`);
        if (r.dry && !$('#rem-cand').checked) parts.push('<div class="field-hint" style="margin-top:8px">Candidate emails are switched off, so only tasks, interviewer nudges and digests are counted above.</div>');
        $('#rem-result').innerHTML = parts.join('');
      };
      const go = (dry) => async () => {
        const b = $(dry ? '#rem-preview' : '#rem-run'); const t = b.textContent; b.disabled = true; b.textContent = 'Working…';
        try { show(await api(`/reminders/run${dry ? '?dry=1' : ''}`, { method: 'POST', body: {} })); }
        catch (err) { toast(err.message, true); }
        finally { b.disabled = false; b.textContent = t; }
      };
      $('#rem-preview').addEventListener('click', go(true)); $('#rem-run').addEventListener('click', go(false));
    }

    if (editable) { renderIntegrationPanel(); renderHrmsPanel(); }
    const grid = $('#settings-grid');
    grid.innerHTML = rows.filter((r) => !['reminders_enabled', 'reminders_candidate_emails'].includes(r.key)).map((row) => {
      const isObj = typeof row.value === 'object' && row.value !== null;
      const displayValue = isObj ? JSON.stringify(row.value) : row.value;
      return `<div class="setting-item">
        <label>${escapeHtml(row.key.replace(/_/g, ' '))}</label>
        <input type="text" data-key="${row.key}" value="${escapeHtml(displayValue)}" ${editable ? '' : 'disabled'}>
        ${editable ? `<div class="save-hint">Updated ${escapeHtml(row.updated_at || '')} &middot; press Enter to save</div>` : ''}
      </div>`;
    }).join('');

    if (editable) {
      $$('input[data-key]', grid).forEach((input) => {
        input.addEventListener('keydown', async (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          let value = input.value;
          try { value = JSON.parse(value); } catch { /* keep as plain string */ }
          try {
            await api(`/settings/${input.dataset.key}`, { method: 'PUT', body: { value } });
            toast('Setting saved.');
          } catch (err) { toast(err.message, true); }
        });
      });
    }
  }

  /* ================================================================
     AUDIT LOG
     ================================================================ */
  async function renderAuditLog() {
    const rows = await api('/audit-logs');
    $('#content').innerHTML = `
      <div class="page-header"><div><h1>Audit Log</h1><div class="sub">Most recent 500 actions</div></div></div>
      <div class="panel"><div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>When</th><th>User</th><th>Action</th><th>Entity</th></tr></thead>
          <tbody>
            ${rows.map((r) => `<tr>
              <td class="mono">${escapeHtml(r.created_at)}</td>
              <td>${escapeHtml(r.user_name || '—')}</td>
              <td>${escapeHtml(r.action)}</td>
              <td>${escapeHtml(r.entity_type)}${r.entity_id ? ' · ' + escapeHtml(String(r.entity_id).slice(0, 8)) : ''}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div></div>
    `;
  }

  /* ================================================================
     GLOBAL SEARCH
     ================================================================ */
  const searchInput = $('#global-search');
  const searchResults = $('#global-search-results');
  let searchDebounce;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    const q = searchInput.value.trim();
    if (!q) { searchResults.hidden = true; return; }
    searchDebounce = setTimeout(async () => {
      try {
        const res = await api(`/search?q=${encodeURIComponent(q)}`);
        renderGlobalSearch(res);
      } catch { searchResults.hidden = true; }
    }, 250);
  });
  document.addEventListener('click', (e) => {
    if (!searchResults.contains(e.target) && e.target !== searchInput) searchResults.hidden = true;
  });

  function renderGlobalSearch(res) {
    const groups = [
      { key: 'candidates', label: 'Candidates', table: 'candidates' },
      { key: 'vacancies', label: 'Vacancies', table: 'vacancies' },
      { key: 'clients', label: 'Companies', table: 'clients' }
    ];
    const total = groups.reduce((n, g) => n + (res[g.key] || []).length, 0);
    if (!total) {
      searchResults.innerHTML = '<div class="search-empty">No matches</div>';
      searchResults.hidden = false;
      return;
    }
    searchResults.innerHTML = groups.map((g) => {
      const items = res[g.key] || [];
      if (!items.length) return '';
      return `<div class="search-group-label">${g.label}</div>` + items.map((item) => `
        <div class="search-result-item" data-table="${g.table}" data-id="${item.id}">
          <span>${escapeHtml(labelFor(g.table, item))}</span>
        </div>`).join('');
    }).join('');
    searchResults.hidden = false;
    $$('.search-result-item', searchResults).forEach((el) => {
      el.addEventListener('click', () => {
        searchResults.hidden = true;
        searchInput.value = '';
        location.hash = `#/${el.dataset.table}`;
        setTimeout(() => openEditDrawer(el.dataset.table, el.dataset.id), 150);
      });
    });
  }

  /* ---------------- Boot ---------------- */
  checkSession();
})();
