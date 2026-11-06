// Admin-managed pick-lists: plant locations, "vacancy raised by" (managers / departments) and interview
// locations with their full address. Super Admin and HR Manager edit them on Admin -> Master lists; the vacancy,
// interview and joining forms then suggest these values so everyone types the same spelling.
// Renaming or switching off an entry never changes records that already used it.
const { v4: uuidv4 } = require('uuid');
const XLSX = require('xlsx');

const LISTS = {
  plant_locations: { title: 'Plant locations', hasDetail: false, nameLabel: 'Location' },
  raised_by: { title: 'Vacancy raised by', hasDetail: false, nameLabel: 'Manager / department' },
  interview_locations: { title: 'Interview locations', hasDetail: true, nameLabel: 'Place', detailLabel: 'Full address' }
};
const KEYS = Object.keys(LISTS);
const clip = (v, n) => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

function check(key) { if (!LISTS[key]) { const e = new Error('Unknown list.'); e.status = 404; throw e; } }

// What the forms use: active entries only.
async function forForms({ dbAll }) {
  const rows = await dbAll("SELECT list_key, name, detail FROM master_lists WHERE is_active = 1 ORDER BY list_key, sort_order, LOWER(name)");
  const out = { plant_locations: [], raised_by: [], interview_locations: [] };
  for (const r of rows) {
    if (r.list_key === 'interview_locations') out.interview_locations.push({ name: r.name, detail: r.detail || '', value: r.detail ? `${r.name} — ${r.detail}` : r.name });
    else if (out[r.list_key]) out[r.list_key].push(r.name);
  }
  return out;
}

async function usage({ dbGet }, key, name) {
  const like = (s) => String(s).replace(/[%_]/g, (m) => '\\' + m);
  const n = async (sql, p) => (await dbGet(sql, p)).n;
  if (key === 'plant_locations') return (await n("SELECT COUNT(*) AS n FROM vacancies WHERE is_deleted = 0 AND LOWER(location) = LOWER(?)", [name])) + (await n("SELECT COUNT(*) AS n FROM joining WHERE is_deleted = 0 AND LOWER(joining_location) = LOWER(?)", [name]));
  if (key === 'raised_by') return n("SELECT COUNT(*) AS n FROM vacancies WHERE is_deleted = 0 AND LOWER(received_from) = LOWER(?)", [name]);
  return n("SELECT COUNT(*) AS n FROM interviews WHERE is_deleted = 0 AND LOWER(location) LIKE LOWER(?) ESCAPE '\\'", [like(name) + '%']);
}

async function list(db, key) {
  check(key);
  const rows = await db.dbAll('SELECT id, name, detail, is_active, sort_order, updated_at FROM master_lists WHERE list_key = ? ORDER BY LOWER(name)', [key]);
  for (const r of rows) r.used = await usage(db, key, r.name);
  return { ...LISTS[key], key, rows };
}

async function add(db, key, { name, detail, is_active = true }) {
  check(key);
  name = clip(name, 120); detail = LISTS[key].hasDetail ? clip(detail, 300) : '';
  if (!name) throw new Error(`${LISTS[key].nameLabel} is required.`);
  if (await db.dbGet('SELECT id FROM master_lists WHERE list_key = ? AND LOWER(name) = LOWER(?)', [key, name])) throw new Error(`"${name}" is already in this list.`);
  const id = uuidv4();
  await db.dbRun('INSERT INTO master_lists (id, list_key, name, detail, is_active) VALUES (?,?,?,?,?)', [id, key, name, detail, is_active ? 1 : 0]);
  return id;
}

async function update(db, key, id, { name, detail, is_active }) {
  check(key);
  const cur = await db.dbGet('SELECT * FROM master_lists WHERE id = ? AND list_key = ?', [id, key]);
  if (!cur) { const e = new Error('Entry not found.'); e.status = 404; throw e; }
  const nm = name === undefined ? cur.name : clip(name, 120);
  if (!nm) throw new Error(`${LISTS[key].nameLabel} is required.`);
  if (nm.toLowerCase() !== cur.name.toLowerCase() && await db.dbGet('SELECT id FROM master_lists WHERE list_key = ? AND LOWER(name) = LOWER(?) AND id != ?', [key, nm, id])) throw new Error(`"${nm}" is already in this list.`);
  const dt = LISTS[key].hasDetail ? (detail === undefined ? cur.detail : clip(detail, 300)) : '';
  const act = is_active === undefined ? cur.is_active : (is_active ? 1 : 0);
  await db.dbRun("UPDATE master_lists SET name = ?, detail = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?", [nm, dt, act, id]);
}

async function remove(db, key, id) {
  check(key);
  await db.dbRun('DELETE FROM master_lists WHERE id = ? AND list_key = ?', [id, key]);
}

// Excel / CSV: first column = name, second column = address (interview locations). A header row is skipped.
async function importSheet(db, key, buffer) {
  check(key);
  let rows;
  try { const wb = XLSX.read(buffer, { type: 'buffer' }); rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' }); } catch { throw new Error('Could not read that file. Use .xlsx or .csv.'); }
  const HEAD = /^(name|location|place|plant|plant location|raised by|manager|department|manager \/ department|interview location)$/i;
  let added = 0, skipped = 0, updated = 0;
  for (const [i, r] of rows.entries()) {
    const name = clip(r[0], 120); if (!name) continue;
    if (i === 0 && HEAD.test(name)) continue;
    const detail = clip(r[1], 300);
    const ex = await db.dbGet('SELECT id, detail FROM master_lists WHERE list_key = ? AND LOWER(name) = LOWER(?)', [key, name]);
    if (ex) {
      if (LISTS[key].hasDetail && detail && detail !== ex.detail) { await db.dbRun("UPDATE master_lists SET detail = ?, updated_at = datetime('now') WHERE id = ?", [detail, ex.id]); updated++; } else skipped++;
    } else { await add(db, key, { name, detail }); added++; }
  }
  return { added, updated, skipped };
}

// Interviewers: Employee Code | Name | Designation | City | Company | Location | Email | Phone. Matches on employee code, else on name.
async function importInterviewers(db, buffer) {
  let rows;
  try { const wb = XLSX.read(buffer, { type: 'buffer' }); rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' }); } catch { throw new Error('Could not read that file. Use .xlsx or .csv.'); }
  const norm = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [String(k).toLowerCase().replace(/[^a-z]/g, ''), v]));
  const pick = (o, ...ks) => { for (const k of ks) if (o[k] !== undefined && String(o[k]).trim() !== '') return clip(o[k], 160); return ''; };
  let added = 0, updated = 0, skipped = 0;
  for (const raw of rows) {
    const o = norm(raw);
    const name = pick(o, 'name', 'employeename', 'fullname'); if (!name) { skipped++; continue; }
    const rec = { code: pick(o, 'employeecode', 'empcode', 'code', 'employeeid'), designation: pick(o, 'designation', 'title'), city: pick(o, 'city'), company: pick(o, 'company', 'entity'),
      location: pick(o, 'location', 'plant', 'plantlocation'), email: pick(o, 'email', 'emailid', 'mail').toLowerCase(), phone: pick(o, 'phone', 'mobile', 'contact') };
    if (rec.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rec.email)) rec.email = '';
    let ex = rec.code ? await db.dbGet('SELECT id FROM interviewers WHERE employee_code = ? AND is_deleted = 0', [rec.code]) : null;
    if (!ex) ex = await db.dbGet('SELECT id FROM interviewers WHERE LOWER(name) = LOWER(?) AND is_deleted = 0', [name]);
    if (ex) {
      await db.dbRun(`UPDATE interviewers SET name = ?, employee_code = COALESCE(NULLIF(?, ''), employee_code), designation = COALESCE(NULLIF(?, ''), designation), city = COALESCE(NULLIF(?, ''), city),
        company = COALESCE(NULLIF(?, ''), company), location = COALESCE(NULLIF(?, ''), location), email = COALESCE(NULLIF(?, ''), email), phone = COALESCE(NULLIF(?, ''), phone), updated_at = datetime('now') WHERE id = ?`,
        [name, rec.code, rec.designation, rec.city, rec.company, rec.location, rec.email, rec.phone, ex.id]);
      updated++;
    } else {
      await db.dbRun('INSERT INTO interviewers (id, employee_code, name, designation, city, company, location, email, phone) VALUES (?,?,?,?,?,?,?,?,?)',
        [uuidv4(), rec.code || null, name, rec.designation || null, rec.city || null, rec.company || null, rec.location || null, rec.email || null, rec.phone || null]);
      added++;
    }
  }
  return { added, updated, skipped };
}

// One-time start-up fill from what is already in the system, so nothing has to be typed again.
async function seedFromExisting({ dbAll, dbGet, dbRun }) {
  if (await dbGet("SELECT key FROM settings WHERE key = 'master_lists_seeded'")) return;
  const addAll = async (key, values, detailFor) => {
    const seen = new Set();
    for (const v of values) { const name = clip(v, 120); if (!name || seen.has(name.toLowerCase())) continue; seen.add(name.toLowerCase());
      if (!(await dbGet('SELECT id FROM master_lists WHERE list_key = ? AND LOWER(name) = LOWER(?)', [key, name]))) await dbRun('INSERT INTO master_lists (id, list_key, name, detail) VALUES (?,?,?,?)', [uuidv4(), key, name, (detailFor && detailFor(name)) || '']); }
  };
  const col = async (sql) => (await dbAll(sql)).map((r) => r.v);
  await addAll('plant_locations', [...await col("SELECT DISTINCT location AS v FROM vacancies WHERE is_deleted = 0 AND location IS NOT NULL AND TRIM(location) != ''"),
    ...await col("SELECT DISTINCT location AS v FROM interviewers WHERE is_deleted = 0 AND location IS NOT NULL AND TRIM(location) != ''"),
    ...await col("SELECT DISTINCT joining_location AS v FROM joining WHERE is_deleted = 0 AND joining_location IS NOT NULL AND TRIM(joining_location) != ''")]);
  await addAll('raised_by', await col("SELECT DISTINCT received_from AS v FROM vacancies WHERE is_deleted = 0 AND received_from IS NOT NULL AND TRIM(received_from) != ''"));
  await addAll('interview_locations', ['Head Office, Thane', ...await col("SELECT DISTINCT location AS v FROM interviews WHERE is_deleted = 0 AND location IS NOT NULL AND TRIM(location) != ''")],
    (n) => (n === 'Head Office, Thane' ? '7th Floor, ThaneOne Corporate IT Park, Ghodbunder Road, Kapurbawdi, Thane West - 400 610' : ''));
  await dbRun("INSERT INTO settings (key, value) VALUES ('master_lists_seeded', '1')");
}

module.exports = { LISTS, KEYS, forForms, list, add, update, remove, importSheet, importInterviewers, seedFromExisting };
