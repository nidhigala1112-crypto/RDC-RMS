// Loads the RMC standard job descriptions once. Safe to restart: it never adds a title that
// already exists, and runs only once, so a JD you later delete or edit is left alone.
const { v4: uuidv4 } = require('uuid');
const KEY = 'standard_jds_2026_loaded';

const COMPANY = 'RDC Concrete India Limited';

async function load({ dbGet, dbRun }) {
  // Keep the standard JDs under RDC Concrete, including if they were loaded before this field existed.
  for (const j of require('./standard_jds_2026.json')) {
    await dbRun('UPDATE jds SET company = ? WHERE company IS NULL AND is_deleted = 0 AND lower(title) = lower(?)', [COMPANY, j.title]);
  }
  if (await dbGet('SELECT key FROM settings WHERE key = ?', [KEY])) return 0;
  const jds = require('./standard_jds_2026.json');
  let added = 0;
  for (const j of jds) {
    const dup = await dbGet('SELECT id FROM jds WHERE is_deleted = 0 AND lower(title) = lower(?)', [j.title]);
    if (dup) continue;
    await dbRun(`INSERT INTO jds (id,title,company,summary,responsibilities,required_skills,preferred_skills,experience_min,experience_max,qualification,other_requirements)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [uuidv4(), j.title, COMPANY, j.summary, j.responsibilities, JSON.stringify(j.required_skills), '[]', j.experience_min, j.experience_max, j.qualification, j.other_requirements]);
    added++;
  }
  await dbRun('INSERT INTO settings (key,value) VALUES (?,?)', [KEY, new Date().toISOString()]);
  if (added) console.log(`Added ${added} standard job descriptions.`);
  return added;
}
module.exports = { load };
