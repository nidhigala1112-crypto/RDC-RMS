// database.js — SQLite schema + seed data for Recruitment ATS
// Uses async sqlite3 package (no C++ build tools needed)
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads', 'resumes');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new sqlite3.Database(path.join(DATA_DIR, 'recruitment.db'));

// Enable WAL mode and foreign keys
db.serialize(() => {
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
});

// ─── Promisified helpers ───────────────────────────────────────────────────────
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) {
    if (err) reject(err);
    else resolve({ lastID: this.lastID, changes: this.changes });
  });
});

const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => {
    if (err) reject(err);
    else resolve(row);
  });
});

const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => {
    if (err) reject(err);
    else resolve(rows);
  });
});

// ─── Schema Init ──────────────────────────────────────────────────────────────
async function initSchema() {
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'recruiter',
      email TEXT,
      phone TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      company_name TEXT NOT NULL,
      contact_person TEXT,
      email TEXT,
      phone TEXT,
      industry TEXT,
      location TEXT,
      registered_address TEXT,
      cin TEXT,
      website TEXT,
      signatory_name TEXT,
      signatory_designation TEXT,
      account_owner_id TEXT REFERENCES users(id),
      billing_details TEXT,
      notes TEXT,
      is_active INTEGER DEFAULT 1,
      is_deleted INTEGER DEFAULT 0,
      deleted_at TEXT,
      deleted_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      created_by TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS jds (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT,
      responsibilities TEXT,
      required_skills TEXT DEFAULT '[]',
      preferred_skills TEXT DEFAULT '[]',
      experience_min REAL,
      experience_max REAL,
      qualification TEXT,
      other_requirements TEXT,
      version INTEGER DEFAULT 1,
      parent_id TEXT,
      is_archived INTEGER DEFAULT 0,
      is_deleted INTEGER DEFAULT 0,
      deleted_at TEXT,
      deleted_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      created_by TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS interviewers (
      id TEXT PRIMARY KEY,
      employee_code TEXT,
      name TEXT NOT NULL,
      designation TEXT,
      city TEXT,
      company TEXT,
      location TEXT,
      email TEXT,
      phone TEXT,
      is_active INTEGER DEFAULT 1,
      is_deleted INTEGER DEFAULT 0,
      deleted_at TEXT,
      deleted_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      created_by TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS auto_email_log (
      id TEXT PRIMARY KEY,
      application_id TEXT,
      status TEXT,
      to_email TEXT,
      sent_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS signatories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      designation TEXT,
      email TEXT,
      company TEXT,
      is_active INTEGER DEFAULT 1,
      is_deleted INTEGER DEFAULT 0,
      deleted_at TEXT,
      deleted_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      created_by TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS vacancies (
      id TEXT PRIMARY KEY,
      vacancy_code TEXT UNIQUE,
      title TEXT NOT NULL,
      company TEXT,
      client_id TEXT REFERENCES clients(id),
      received_from TEXT,
      date_received TEXT NOT NULL,
      ctc_min REAL,
      ctc_max REAL,
      location TEXT,
      job_type TEXT DEFAULT 'Full-time',
      priority TEXT DEFAULT 'Medium',
      jd_id TEXT,
      jd_version INTEGER,
      positions_required INTEGER DEFAULT 1,
      positions_filled INTEGER DEFAULT 0,
      assigned_recruiter_id TEXT,
      assigned_recruiter_notified_id TEXT,
      account_owner_id TEXT,
      status TEXT DEFAULT 'Open',
      closure_reason TEXT,
      closed_at TEXT,
      is_deleted INTEGER DEFAULT 0,
      deleted_at TEXT,
      deleted_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      created_by TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
      candidate_code TEXT UNIQUE,
      full_name TEXT NOT NULL,
      mobile TEXT,
      email TEXT,
      current_location TEXT,
      address TEXT,
      preferred_location TEXT,
      total_experience REAL,
      relevant_experience REAL,
      current_company TEXT,
      current_designation TEXT,
      current_ctc REAL,
      expected_ctc REAL,
      notice_period INTEGER,
      qualification TEXT,
      skills TEXT DEFAULT '[]',
      source TEXT,
      linkedin_url TEXT,
      status TEXT DEFAULT 'Active',
      date_added TEXT DEFAULT (date('now')),
      last_contacted TEXT,
      remarks TEXT,
      tags TEXT DEFAULT '[]',
      next_action TEXT,
      next_action_due TEXT,
      next_action_assigned_id TEXT,
      is_deleted INTEGER DEFAULT 0,
      deleted_at TEXT,
      deleted_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      created_by TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS resumes (
      id TEXT PRIMARY KEY,
      candidate_id TEXT REFERENCES candidates(id),
      version INTEGER DEFAULT 1,
      file_name TEXT,
      file_size INTEGER,
      file_path TEXT,
      mime_type TEXT,
      extracted_text TEXT,
      parsed_data TEXT DEFAULT '{}',
      parsing_confidence REAL DEFAULT 0,
      upload_date TEXT DEFAULT (datetime('now')),
      uploaded_by TEXT,
      is_current INTEGER DEFAULT 1
    )`,
    `CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      candidate_id TEXT REFERENCES candidates(id),
      vacancy_id TEXT REFERENCES vacancies(id),
      recruiter_id TEXT,
      jd_id TEXT,
      jd_version INTEGER,
      match_score REAL,
      manual_score REAL,
      score_override_reason TEXT,
      score_breakdown TEXT DEFAULT '{}',
      score_version TEXT DEFAULT 'v1.0',
      score_weights TEXT DEFAULT '{}',
      score_calculated_at TEXT,
      status TEXT DEFAULT 'Sourced',
      rejection_reason TEXT,
      submitted_to_client INTEGER DEFAULT 0,
      client_submission_date TEXT,
      client_feedback TEXT,
      client_feedback_date TEXT,
      client_feedback_by TEXT,
      client_status TEXT DEFAULT 'Not Submitted',
      client_remarks TEXT,
      is_deleted INTEGER DEFAULT 0,
      deleted_at TEXT,
      deleted_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS interviews (
      id TEXT PRIMARY KEY,
      application_id TEXT,
      candidate_id TEXT,
      vacancy_id TEXT,
      round INTEGER DEFAULT 1,
      interviewer TEXT,
      interviewer_email TEXT,
      type TEXT DEFAULT 'Video',
      scheduled_date TEXT,
      scheduled_time TEXT,
      meeting_link TEXT,
      google_event_id TEXT,
      confirmation_sent INTEGER DEFAULT 0,
      reminder_sent INTEGER DEFAULT 0,
      location TEXT,
      status TEXT DEFAULT 'Scheduled',
      feedback TEXT,
      scorecard TEXT DEFAULT '{}',
      rating REAL,
      recommendation TEXT,
      is_deleted INTEGER DEFAULT 0,
      deleted_at TEXT,
      deleted_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      created_by TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS offers (
      id TEXT PRIMARY KEY,
      application_id TEXT,
      candidate_id TEXT,
      vacancy_id TEXT,
      offered_ctc REAL,
      fixed_component REAL,
      variable_component REAL,
      basic_pay REAL,
      hra REAL,
      special_allowance REAL,
      lta REAL,
      employer_pf REAL,
      gratuity REAL,
      additional_recipients TEXT,
      letter_remarks TEXT,
      letter_sent INTEGER DEFAULT 0,
      joining_bonus REAL,
      benefits TEXT,
      offer_date TEXT,
      valid_till TEXT,
      expected_joining TEXT,
      status TEXT DEFAULT 'Draft',
      is_deleted INTEGER DEFAULT 0,
      deleted_at TEXT,
      deleted_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      created_by TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS onboarding (
      id TEXT PRIMARY KEY,
      candidate_id TEXT,
      vacancy_id TEXT,
      offer_id TEXT,
      token TEXT,
      token_expires TEXT,
      status TEXT DEFAULT 'Invited',
      data TEXT DEFAULT '{}',
      invited_at TEXT,
      submitted_at TEXT,
      verified_by TEXT,
      verified_at TEXT,
      hrms_status TEXT,
      hrms_pushed_at TEXT,
      hrms_response TEXT,
      hrms_error TEXT,
      hrms_attempts INTEGER DEFAULT 0,
      is_deleted INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS onboarding_docs (
      id TEXT PRIMARY KEY,
      onboarding_id TEXT NOT NULL,
      doc_type TEXT,
      file_name TEXT,
      file_path TEXT,
      mime_type TEXT,
      file_size INTEGER,
      uploaded_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS joining (
      id TEXT PRIMARY KEY,
      offer_id TEXT,
      application_id TEXT,
      candidate_id TEXT,
      vacancy_id TEXT,
      expected_date TEXT,
      actual_date TEXT,
      status TEXT DEFAULT 'Expected',
      offered_ctc REAL,
      joined_ctc REAL,
      joining_location TEXT,
      reporting_manager TEXT,
      documents_pending TEXT,
      drop_reason TEXT,
      is_deleted INTEGER DEFAULT 0,
      deleted_at TEXT,
      deleted_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      created_by TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY,
      entity_type TEXT,
      entity_id TEXT,
      action TEXT,
      old_value TEXT,
      new_value TEXT,
      performed_by TEXT,
      performed_by_name TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS communications (
      id TEXT PRIMARY KEY,
      candidate_id TEXT,
      date TEXT DEFAULT (date('now')),
      type TEXT,
      direction TEXT DEFAULT 'Outbound',
      subject TEXT,
      notes TEXT,
      follow_up_date TEXT,
      is_deleted INTEGER DEFAULT 0,
      deleted_at TEXT,
      deleted_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      created_by TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS assessments (
      id TEXT PRIMARY KEY,
      candidate_id TEXT,
      vacancy_id TEXT,
      application_id TEXT,
      assessment_type TEXT,
      status TEXT DEFAULT 'Pending',
      assessment_date TEXT,
      score TEXT,
      result_summary TEXT,
      report_link TEXT,
      remarks TEXT,
      is_deleted INTEGER DEFAULT 0,
      deleted_at TEXT,
      deleted_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      created_by TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS email_templates (
      key TEXT PRIMARY KEY,
      name TEXT,
      subject TEXT,
      body TEXT,
      set_status TEXT,
      reject_reason TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      updated_by TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS reminder_log (
      key TEXT PRIMARY KEY,
      kind TEXT,
      detail TEXT,
      sent_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS followups (
      id TEXT PRIMARY KEY,
      entity_type TEXT,
      entity_id TEXT,
      entity_name TEXT,
      note TEXT,
      due_date TEXT,
      assigned_to TEXT,
      completed INTEGER DEFAULT 0,
      completed_at TEXT,
      is_deleted INTEGER DEFAULT 0,
      deleted_at TEXT,
      deleted_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      created_by TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      entity_type TEXT,
      entity_id TEXT,
      content TEXT,
      tags TEXT DEFAULT '[]',
      is_deleted INTEGER DEFAULT 0,
      deleted_at TEXT,
      deleted_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      created_by TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      user_name TEXT,
      action TEXT,
      entity_type TEXT,
      entity_id TEXT,
      changes TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS oauth_tokens (
      provider TEXT PRIMARY KEY,
      refresh_token TEXT,
      access_token TEXT,
      expiry_date INTEGER,
      connected_by TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS master_lists (
      id TEXT PRIMARY KEY,
      list_key TEXT NOT NULL,
      name TEXT NOT NULL,
      detail TEXT,
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      updated_by TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS vacancy_requirement_history (
      id TEXT PRIMARY KEY,
      vacancy_id TEXT,
      changed_field TEXT,
      old_value TEXT,
      new_value TEXT,
      changed_by TEXT,
      changed_at TEXT DEFAULT (datetime('now'))
    )`,
    // Indexes
    `CREATE INDEX IF NOT EXISTS idx_candidates_email ON candidates(email)`,
    `CREATE INDEX IF NOT EXISTS idx_candidates_mobile ON candidates(mobile)`,
    `CREATE INDEX IF NOT EXISTS idx_applications_candidate ON applications(candidate_id)`,
    `CREATE INDEX IF NOT EXISTS idx_applications_vacancy ON applications(vacancy_id)`,
    `CREATE INDEX IF NOT EXISTS idx_activities_entity ON activities(entity_type, entity_id)`,
    `CREATE INDEX IF NOT EXISTS idx_resumes_candidate ON resumes(candidate_id)`,
    `CREATE INDEX IF NOT EXISTS idx_interviews_application ON interviews(application_id)`,
    `CREATE INDEX IF NOT EXISTS idx_followups_due ON followups(due_date, completed)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id)`
  ];

  for (const sql of tables) {
    await dbRun(sql);
  }

  await migrate();
}

// ─── Migrations ───────────────────────────────────────────────────────────────
// `CREATE TABLE IF NOT EXISTS` above only helps on a brand-new database — it does
// nothing for a database that already exists with an older schema (e.g. yours,
// once you've already been using the app). This adds any new columns to an
// existing table without touching a single row of data already in it.
async function migrate() {
  const alterations = [
    ['vacancies', 'company', 'TEXT'],
    ['followups', 'auto_key', 'TEXT'],
    ['jds', 'company', 'TEXT'],
    ['clients', 'signatory_email', 'TEXT'],
    ['offers', 'manual_letter_name', 'TEXT'],
    ['offers', 'manual_letter_path', 'TEXT'],
    ['offers', 'manual_letter_mime', 'TEXT'],
    ['offers', 'manual_letter_uploaded_at', 'TEXT'],
    ['offers', 'approval_token', 'TEXT'],
    ['offers', 'approval_token_expires', 'TEXT'],
    ['offers', 'approval_requested_at', 'TEXT'],
    ['offers', 'approval_requested_to', 'TEXT'],
    ['offers', 'approval_decision', 'TEXT'],
    ['offers', 'approval_note', 'TEXT'],
    ['offers', 'approved_by_name', 'TEXT'],
    ['offers', 'approved_at', 'TEXT'],
    ['offers', 'approval_signature', 'TEXT'],
    ['offers', 'approval_ip', 'TEXT'],
    ['offers', 'approval_agent', 'TEXT'],
    ['offers', 'approval_hash', 'TEXT'],
    ['vacancies', 'closed_at', 'TEXT'],
    ['vacancies', 'assigned_recruiter_notified_id', 'TEXT'],
    ['candidates', 'address', 'TEXT'],
    ['candidates', 'date_of_birth', 'TEXT'],
    ['offers', 'basic_pay', 'REAL'],
    ['offers', 'hra', 'REAL'],
    ['offers', 'special_allowance', 'REAL'],
    ['offers', 'lta', 'REAL'],
    ['offers', 'employer_pf', 'REAL'],
    ['offers', 'gratuity', 'REAL'],
    ['offers', 'additional_recipients', 'TEXT'],
    ['offers', 'letter_remarks', 'TEXT'],
    ['offers', 'letter_sent', 'INTEGER DEFAULT 0'],
    ['clients', 'registered_address', 'TEXT'],
    ['clients', 'cin', 'TEXT'],
    ['clients', 'website', 'TEXT'],
    ['clients', 'signatory_name', 'TEXT'],
    ['clients', 'signatory_designation', 'TEXT'],
    ['interviews', 'interviewer_email', 'TEXT'],
    ['interviews', 'panel_id', 'TEXT'],
    ['offers', 'signatory_name', 'TEXT'],
    ['offers', 'signatory_designation', 'TEXT'],
    ['offers', 'signatory_email', 'TEXT'],
    ['vacancies', 'vacancy_reason', 'TEXT'],
    ['vacancies', 'reason_details', 'TEXT'],
    ['interviews', 'google_event_id', 'TEXT'],
    ['interviews', 'confirmation_sent', 'INTEGER DEFAULT 0'],
    ['interviews', 'reminder_sent', 'INTEGER DEFAULT 0'],
    ['interviews', 'scorecard_token', 'TEXT'],
    ['interviews', 'scorecard_token_expires', 'TEXT'],
    ['interviews', 'hire_type', 'TEXT'],
    ['interviews', 'scorecard_submitted_at', 'TEXT'],
    ['clients', 'onboarding_form_link', 'TEXT'],
    ['jds', 'deleted_by', 'TEXT'],
    ['applications', 'deleted_by', 'TEXT'],
    ['interviews', 'deleted_by', 'TEXT'],
    ['offers', 'deleted_by', 'TEXT'],
    ['joining', 'deleted_by', 'TEXT'],
    ['communications', 'deleted_by', 'TEXT'],
    ['followups', 'deleted_by', 'TEXT'],
    ['notes', 'deleted_by', 'TEXT']
  ];
  for (const [table, column, type] of alterations) {
    const columns = await dbAll(`PRAGMA table_info(${table})`);
    if (!columns.some((c) => c.name === column)) {
      console.log(`🔧 Migrating: adding ${table}.${column} column...`);
      await dbRun(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  // Add any settings keys introduced after your database was first created.
  const newSettingsKeys = [['weekly_tracker_last_sent', ''], ['onboarding_form_link', ''], ['srt_url', 'https://hr.rdcc.ai/srt/admin'], ['disc_url', 'https://hr.rdcc.ai/disc/admin'], ['reminders_enabled', 'true'], ['reminders_candidate_emails', 'false'], ['integration_api_key_hash', '']];
  for (const [key, defaultValue] of newSettingsKeys) {
    const existing = await dbGet('SELECT key FROM settings WHERE key = ?', [key]);
    if (!existing) {
      console.log(`🔧 Migrating: adding "${key}" setting...`);
      await dbRun('INSERT INTO settings (key, value) VALUES (?, ?)', [key, defaultValue]);
    }
  }

  // One-time seed of the three real companies into the (repurposed) clients/companies
  // table, but only if none of them already exist — never runs again once you've
  // edited or added company records yourself.
  const existingCompanies = await dbGet(
    `SELECT COUNT(*) AS n FROM clients WHERE company_name IN (?, ?, ?)`,
    ['RDC Concrete India Limited', 'Ultrafine Mineral & Admixture Pvt. Limited', 'ROBO Silicon Pvt Ltd']
  );
  if (existingCompanies.n === 0) {
    console.log('🔧 Migrating: seeding the three company records...');
    await dbRun(
      `INSERT INTO clients (id, company_name, registered_address, cin, phone, email, website, signatory_name, signatory_designation, is_active) VALUES (?,?,?,?,?,?,?,?,?,1)`,
      [uuidv4(), 'RDC Concrete India Limited', '7th Floor, ThaneOne Corporate IT Park, Ghodbunder Road, Kapurbawdi, Thane West - 400 610.', 'U74999MH1993PTC172842', '+91 22 - 6789 6789', 'wecare@rdc.in', 'www.rdcconcrete.com', 'Dr. KS Bhoon', 'Chief Operating & Technology Officer']
    );
    await dbRun(
      `INSERT INTO clients (id, company_name, registered_address, cin, phone, email, website, is_active) VALUES (?,?,?,?,?,?,?,1)`,
      [uuidv4(), 'Ultrafine Mineral & Admixture Pvt. Limited', '7th Floor, ThaneOne Corporate IT Park, Ghodbunder Road, Kapurbawdi, Thane West - 400 610.', '27AACCU5797P1ZB', '+91 99201 56789', 'sales@ultrafine.in', 'www.ultrafine.in']
    );
    await dbRun(
      `INSERT INTO clients (id, company_name, registered_address, cin, phone, email, website, is_active) VALUES (?,?,?,?,?,?,?,1)`,
      [uuidv4(), 'ROBO Silicon Pvt Ltd', 'DIL Complex, 702, 7th Floor, Thane One, Ghodbunder Road, Majiwade, Thane, Maharashtra, India - 400610.', 'U26100MH1999PTC447681', '+91-22-67896789', 'robosand@rdc.in', 'www.robo.co.in']
    );
  }

  // The RDC Authorized Signatory (Chief Operating & Technology Officer) — fill in his email once if it is still blank.
  await dbRun("UPDATE clients SET signatory_email = 'ksbhoon@rdc.in' WHERE company_name = 'RDC Concrete India Limited' AND (signatory_email IS NULL OR signatory_email = '')");
}

// ─── Activity & Audit Helpers ─────────────────────────────────────────────────
async function logActivity(entityType, entityId, action, oldVal, newVal, userId, userName) {
  await dbRun(
    `INSERT INTO activities (id,entity_type,entity_id,action,old_value,new_value,performed_by,performed_by_name) VALUES (?,?,?,?,?,?,?,?)`,
    [uuidv4(), entityType, entityId, action, oldVal || null, newVal || null, userId || null, userName || 'System']
  );
}

async function logAudit(userId, userName, action, entityType, entityId, changes) {
  await dbRun(
    `INSERT INTO audit_logs (id,user_id,user_name,action,entity_type,entity_id,changes) VALUES (?,?,?,?,?,?,?)`,
    [uuidv4(), userId, userName, action, entityType, entityId, JSON.stringify(changes || {})]
  );
}

// ─── Code Generator ───────────────────────────────────────────────────────────
async function nextCode(prefix, table, codeCol) {
  const row = await dbGet(
    `SELECT ${codeCol} FROM ${table} WHERE ${codeCol} LIKE ? ORDER BY ${codeCol} DESC LIMIT 1`,
    [`${prefix}-%`]
  );
  if (!row) return `${prefix}-00001`;
  const num = parseInt(row[codeCol].split('-')[1], 10) + 1;
  return `${prefix}-${String(num).padStart(5, '0')}`;
}

// ─── JSON helpers ─────────────────────────────────────────────────────────────
function parseJsonFields(row, fields) {
  if (!row) return row;
  for (const f of fields) {
    if (row[f] !== undefined && row[f] !== null) {
      try { row[f] = JSON.parse(row[f]); } catch { row[f] = []; }
    }
  }
  return row;
}

// ─── Seed Data ────────────────────────────────────────────────────────────────
async function seed() {
  const existing = await dbGet('SELECT id FROM users LIMIT 1');
  if (existing) return;

  console.log('🌱 Seeding initial data...');

  const adminId = uuidv4();
  const adminHash = await bcrypt.hash('admin123', 10);
  const recHash = await bcrypt.hash('recruiter123', 10);

  await dbRun(`INSERT INTO users (id,full_name,username,password_hash,role,email) VALUES (?,?,?,?,?,?)`,
    [adminId, 'Super Admin', 'admin', adminHash, 'super_admin', 'admin@company.com']);

  const rec1Id = uuidv4(), rec2Id = uuidv4(), rec3Id = uuidv4();
  await dbRun(`INSERT INTO users (id,full_name,username,password_hash,role,email) VALUES (?,?,?,?,?,?)`,
    [rec1Id, 'Priya Mehta', 'priya', recHash, 'recruiter', 'priya@company.com']);
  await dbRun(`INSERT INTO users (id,full_name,username,password_hash,role,email) VALUES (?,?,?,?,?,?)`,
    [rec2Id, 'Heet Shah', 'heet', recHash, 'recruiter', 'heet@company.com']);
  await dbRun(`INSERT INTO users (id,full_name,username,password_hash,role,email) VALUES (?,?,?,?,?,?)`,
    [rec3Id, 'Rahul Nair', 'rahul', recHash, 'hr_manager', 'rahul@company.com']);

  const jd1 = uuidv4(), jd2 = uuidv4(), jd3 = uuidv4();
  await dbRun(`INSERT INTO jds (id,title,summary,responsibilities,required_skills,preferred_skills,experience_min,experience_max,qualification,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [jd1,'HR Manager','Lead HR operations','Recruitment, payroll, compliance, employee relations',
     JSON.stringify(['HR Management','Recruitment','Payroll','Compliance','Labour Laws']),
     JSON.stringify(['SAP HR','HRMS','Industrial Relations']),5,8,'MBA HR / MSW',adminId]);
  await dbRun(`INSERT INTO jds (id,title,summary,responsibilities,required_skills,preferred_skills,experience_min,experience_max,qualification,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [jd2,'HRBP','Strategic HR partner','Talent management, performance management, culture building',
     JSON.stringify(['Talent Acquisition','Performance Management','HR Analytics','Change Management']),
     JSON.stringify(['OD Consulting','HRIS','Executive Coaching']),6,10,'MBA HR',adminId]);
  await dbRun(`INSERT INTO jds (id,title,summary,responsibilities,required_skills,preferred_skills,experience_min,experience_max,qualification,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [jd3,'TA Specialist','End-to-end recruitment','Sourcing, screening, interviews, offers',
     JSON.stringify(['Recruitment','Sourcing','LinkedIn Recruiter','ATS','Interviewing']),
     JSON.stringify(['Boolean Search','Campus Recruitment','Employer Branding']),2,5,'Any Graduate / MBA HR',adminId]);

  const vac1=uuidv4(),vac2=uuidv4(),vac3=uuidv4(),vac4=uuidv4();
  await dbRun(`INSERT INTO vacancies (id,vacancy_code,title,company,received_from,date_received,ctc_min,ctc_max,location,priority,jd_id,jd_version,positions_required,assigned_recruiter_id,status,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [vac1,'VAC-00001','HR Manager','RDC Concrete India Limited','Nikhil Sharma','2026-08-10',15,20,'Mumbai','High',jd1,1,2,rec1Id,'Open',adminId]);
  await dbRun(`INSERT INTO vacancies (id,vacancy_code,title,company,received_from,date_received,ctc_min,ctc_max,location,priority,jd_id,jd_version,positions_required,assigned_recruiter_id,status,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [vac2,'VAC-00002','HRBP','Ultrafine Mineral & Admixture Pvt. Limited','Sunita Patel','2026-08-20',20,28,'Pune','Urgent',jd2,1,1,rec2Id,'Open',adminId]);
  await dbRun(`INSERT INTO vacancies (id,vacancy_code,title,company,received_from,date_received,ctc_min,ctc_max,location,priority,jd_id,jd_version,positions_required,assigned_recruiter_id,status,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [vac3,'VAC-00003','TA Specialist','RDC Concrete India Limited','Nikhil Sharma','2026-09-01',8,12,'Mumbai','Medium',jd3,1,3,rec1Id,'Open',adminId]);
  await dbRun(`INSERT INTO vacancies (id,vacancy_code,title,company,received_from,date_received,ctc_min,ctc_max,location,priority,jd_id,jd_version,positions_required,assigned_recruiter_id,status,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [vac4,'VAC-00004','HR Executive','ROBO Silicon Pvt Ltd','Dinesh Kapoor','2026-09-03',5,8,'Delhi','Low',jd1,1,1,rec3Id,'Open',adminId]);

  const can1=uuidv4(),can2=uuidv4(),can3=uuidv4(),can4=uuidv4(),can5=uuidv4();
  const candidates = [
    [can1,'CAN-00001','Rahul Sharma','9876500001','rahul.sharma@email.com','Mumbai','Mumbai',7,7,'Delta Corp','HR Manager',14,18,30,'MBA HR',JSON.stringify(['HR Management','Recruitment','Payroll','Compliance','Labour Laws']),'Naukri','Active',JSON.stringify(['High Potential','Client Preferred']),adminId],
    [can2,'CAN-00002','Sneha Iyer','9876500002','sneha.iyer@email.com','Pune','Pune',8,6,'Omega Pharma','HRBP',18,25,60,'MBA HR',JSON.stringify(['Talent Acquisition','Performance Management','HR Analytics','HRIS']),'LinkedIn','Active',JSON.stringify(['Immediate Joiner']),adminId],
    [can3,'CAN-00003','Vikram Joshi','9876500003','vikram.joshi@email.com','Mumbai','Mumbai, Pune',4,4,'Nexus IT','TA Specialist',9,12,30,'BMS',JSON.stringify(['Recruitment','Sourcing','LinkedIn Recruiter','ATS']),'Employee Referral','Active',JSON.stringify([]),adminId],
    [can4,'CAN-00004','Anjali Desai','9876500004','anjali.desai@email.com','Delhi','Delhi',6,5,'Bright Solutions','HR Generalist',10,15,45,'MSW',JSON.stringify(['Recruitment','Payroll','Compliance','Industrial Relations']),'Naukri','Active',JSON.stringify(['Good Communication']),adminId],
    [can5,'CAN-00005','Karan Mehta','9876500005','karan.mehta@email.com','Mumbai','Mumbai',3,3,'StartHub','HR Executive',6,9,15,'MBA HR',JSON.stringify(['Recruitment','Sourcing','Excel','HRMS']),'LinkedIn','Active',JSON.stringify(['Immediate Joiner']),adminId],
  ];
  for (const c of candidates) {
    await dbRun(`INSERT INTO candidates (id,candidate_code,full_name,mobile,email,current_location,preferred_location,total_experience,relevant_experience,current_company,current_designation,current_ctc,expected_ctc,notice_period,qualification,skills,source,status,tags,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, c);
  }

  const app1=uuidv4(),app2=uuidv4(),app3=uuidv4(),app4=uuidv4(),app5=uuidv4();
  // Scores are intentionally left blank here — server.js calculates real ones
  // against the actual scoring engine right after seeding, so the demo data
  // shows a genuine example of the match-scoring feature rather than a
  // hand-typed placeholder number.
  const apps = [
    [app1,can1,vac1,rec1Id,jd1,1,'Interview','Client Shortlisted'],
    [app2,can2,vac2,rec2Id,jd2,1,'Shortlisted','Submitted'],
    [app3,can3,vac3,rec1Id,jd3,1,'Screening','Not Submitted'],
    [app4,can4,vac4,rec3Id,jd1,1,'Sourced','Not Submitted'],
    [app5,can1,vac3,rec1Id,jd3,1,'Shortlisted','Not Submitted'],
  ];
  for (const a of apps) {
    await dbRun(`INSERT INTO applications (id,candidate_id,vacancy_id,recruiter_id,jd_id,jd_version,status,client_status) VALUES (?,?,?,?,?,?,?,?)`, a);
  }

  const int1 = uuidv4();
  await dbRun(`INSERT INTO interviews (id,application_id,candidate_id,vacancy_id,round,interviewer,type,scheduled_date,scheduled_time,status,scorecard,rating,recommendation,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [int1,app1,can1,vac1,1,'Nikhil Sharma','Video','2026-09-08','11:00','Completed',JSON.stringify({technical:4,communication:4,experience:5,culture_fit:4,overall:4.2}),4.2,'Proceed',adminId]);

  const tomorrow = new Date(Date.now()+86400000).toISOString().split('T')[0];
  const today = new Date().toISOString().split('T')[0];
  await dbRun(`INSERT INTO followups (id,entity_type,entity_id,entity_name,note,due_date,assigned_to,created_by) VALUES (?,?,?,?,?,?,?,?)`,
    [uuidv4(),'candidate',can2,'Sneha Iyer','Call candidate regarding interview slot',tomorrow,rec2Id,rec2Id]);
  await dbRun(`INSERT INTO followups (id,entity_type,entity_id,entity_name,note,due_date,assigned_to,created_by) VALUES (?,?,?,?,?,?,?,?)`,
    [uuidv4(),'vacancy',vac2,'HRBP - XYZ Manufacturing','Follow up with client on candidate feedback',today,rec2Id,adminId]);

  const defaultSettings = [
    ['scoring_weights', JSON.stringify({mandatory:50,experience:20,qualification:10,preferred:10,industry:10})],
    ['score_version', 'v1.0'],
    ['sla_no_candidate_days', '3'],
    ['sla_feedback_pending_hours', '24'],
    ['sla_joining_alert_days', '7'],
    ['sla_vacancy_critical_days', '30'],
    ['email_recipients', '[]'],
    ['weekly_tracker_last_sent', ''],
    ['onboarding_form_link', ''],
    ['srt_url', 'https://hr.rdcc.ai/srt/admin'],
    ['disc_url', 'https://hr.rdcc.ai/disc/admin'],
    ['reminders_enabled', 'true'],
    ['reminders_candidate_emails', 'false'],
    ['integration_api_key_hash', ''],
    ['backup_reminder_days', '7'],
    ['last_backup_at', ''],
    ['synonyms', JSON.stringify({
      'talent acquisition': ['recruitment','ta','sourcing'],
      'hrms': ['human resource management system','hris','hr software'],
      'ms excel': ['excel','microsoft excel'],
      'performance management': ['pms','performance appraisal'],
      'industrial relations': ['ir','labour relations'],
      'learning and development': ["l&d","training","training and development"]
    })]
  ];
  for (const [k,v] of defaultSettings) {
    await dbRun(`INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)`, [k,v]);
  }

  await logActivity('candidate',can1,'Candidate Added',null,'Profile created',adminId,'Super Admin');
  await logActivity('application',app1,'Status Changed','Sourced','Interview',rec1Id,'Priya Mehta');
  await logActivity('application',app2,'Submitted to Client',null,'2026-09-03',rec2Id,'Heet Shah');
  await logActivity('interview',int1,'Interview Completed',null,'Rating: 4.2/5',adminId,'Super Admin');

  console.log('✅ Seed data loaded. Default login: admin / admin123');
  console.log('   Other logins: priya/recruiter123, heet/recruiter123, rahul/recruiter123');
}

// ─── Initialize ───────────────────────────────────────────────────────────────
async function initialize() {
  await initSchema();
  await seed();
  // one signatory per company already on file becomes an entry in the Authorized Signatories list
  try {
    for (const c of await dbAll("SELECT company_name, signatory_name, signatory_designation, signatory_email FROM clients WHERE COALESCE(signatory_email, '') != ''")) {
      if (!(await dbGet('SELECT id FROM signatories WHERE LOWER(email) = LOWER(?) AND is_deleted = 0', [c.signatory_email]))) {
        await dbRun('INSERT INTO signatories (id, name, designation, email, company) VALUES (?,?,?,?,?)', [require('uuid').v4(), c.signatory_name || c.signatory_email, c.signatory_designation || 'Authorised Signatory', c.signatory_email, c.company_name]);
      }
    }
  } catch (e) { console.warn('⚠️  Signatories not pre-filled:', e.message); }
  // applications follow their vacancy's recruiter wherever it was left blank
  try { await dbRun("UPDATE applications SET recruiter_id = (SELECT v.assigned_recruiter_id FROM vacancies v WHERE v.id = applications.vacancy_id) WHERE (recruiter_id IS NULL OR recruiter_id = '') AND vacancy_id IN (SELECT id FROM vacancies WHERE COALESCE(assigned_recruiter_id, '') != '')"); } catch (e) { console.warn('⚠️  Recruiter back-fill skipped:', e.message); }
  try { await require('./masterLists').seedFromExisting({ dbAll, dbGet, dbRun }); } catch (e) { console.warn('⚠️  Master lists not pre-filled:', e.message); }
}

module.exports = { db, dbRun, dbGet, dbAll, nextCode, logActivity, logAudit, parseJsonFields, initialize, UPLOADS_DIR };
