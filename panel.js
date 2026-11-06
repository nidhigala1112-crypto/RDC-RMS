// Interview panels: one interview with several interviewers.
// Each interviewer gets their own interview record (so each has a private scorecard link, a score and a
// verdict), and the records of one panel share a panel_id. The first ("main") record has id = panel_id and
// owns the shared details (date, time, link, location, status); the others copy them. Only the main record
// emails the candidate and recruiter; each panel member gets their own invite with their own scorecard link.
const { v4: uuidv4 } = require('uuid');

const SHARED = ['application_id', 'candidate_id', 'vacancy_id', 'round', 'type', 'scheduled_date', 'scheduled_time', 'meeting_link', 'location', 'status'];
const clean = (v, n) => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const hasScore = (r) => r.rating !== null && r.rating !== undefined && r.rating !== '' || (r.scorecard && r.scorecard !== '{}' && r.scorecard !== 'null' && r.scorecard !== '');

function parsePanel(input) {
  let list = input;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = []; } }
  if (!Array.isArray(list)) return [];
  const out = []; const seen = new Set();
  for (const m of list) {
    const name = clean(m && m.name, 120); let email = clean(m && m.email, 160).toLowerCase();
    if (!name && !email) continue;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { const e = new Error(`"${email}" is not a valid email address.`); e.status = 400; throw e; }
    if (!name) { const e = new Error('Each additional interviewer needs a name.'); e.status = 400; throw e; }
    const key = email || name.toLowerCase(); if (seen.has(key)) continue; seen.add(key);
    out.push({ name, email });
  }
  return out;
}

// Records of the panel this interview belongs to (main record first).
async function members(db, interview) {
  if (!interview.panel_id) return [];
  return db.dbAll('SELECT id, interviewer, interviewer_email, rating, scorecard, status FROM interviews WHERE panel_id = ? AND is_deleted = 0 ORDER BY (id = panel_id) DESC, created_at', [interview.panel_id]);
}

// For the form: the additional interviewers of a main record.
async function forForm(db, interview) {
  if (!interview.panel_id) return { panel: [], panel_role: 'none' };
  if (interview.panel_id !== interview.id) return { panel: [], panel_role: 'member', panel_main_id: interview.panel_id };
  const rows = (await members(db, interview)).filter((r) => r.id !== interview.id);
  return { panel: rows.map((r) => ({ id: r.id, name: r.interviewer || '', email: r.interviewer_email || '', scored: !!hasScore(r) })), panel_role: 'main' };
}

// Called after the main record is created or saved. `notify(id, values, existing)` is the normal scheduling
// notifier, so new members get their invite and existing members hear about reschedules and cancellations.
async function apply(db, mainId, rawPanel, { userId, notify, silent = false }) {
  const main = await db.dbGet('SELECT * FROM interviews WHERE id = ? AND is_deleted = 0', [mainId]);
  if (!main) return;
  if (main.panel_id && main.panel_id !== main.id) return; // a panel member cannot own a panel
  const wanted = rawPanel === undefined ? null : parsePanel(rawPanel);
  const existing = main.panel_id ? (await members(db, main)).filter((r) => r.id !== main.id) : [];
  if (wanted === null && !existing.length) return;

  if (!main.panel_id && wanted && wanted.length) { await db.dbRun('UPDATE interviews SET panel_id = ? WHERE id = ?', [main.id, main.id]); main.panel_id = main.id; }

  // keep every member's shared details in step with the main record, telling them if the time changed or it was cancelled
  for (const r of existing) {
    const before = await db.dbGet('SELECT * FROM interviews WHERE id = ?', [r.id]);
    const change = {}; for (const k of SHARED) if ((before[k] || '') !== (main[k] || '')) change[k] = main[k];
    if (Object.keys(change).length) {
      const keepStatus = ['Completed', 'No Show'].includes(before.status) && main.status !== 'Cancelled';
      if (keepStatus) delete change.status;
      if (Object.keys(change).length) {
        await db.dbRun(`UPDATE interviews SET ${Object.keys(change).map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, [...Object.values(change), r.id]);
        if (!silent) { r.told = true; try { await notify(r.id, change, before); } catch (e) { console.warn('⚠️  Panel update email not sent:', e.message); } }
      }
    }
  }
  // members created before the main invite went out (a new panel interview) get their first invite now
  if (!silent) {
    const mainNow = await db.dbGet('SELECT confirmation_sent, status FROM interviews WHERE id = ?', [main.id]);
    if (mainNow && mainNow.confirmation_sent) {
      for (const r of existing) {
        if (r.told) continue;
        const m = await db.dbGet('SELECT * FROM interviews WHERE id = ?', [r.id]);
        if (m && !m.confirmation_sent && ['Scheduled', 'Confirmed'].includes(m.status)) { try { await notify(m.id, { status: m.status, scheduled_date: m.scheduled_date, scheduled_time: m.scheduled_time }, null); } catch (e) { console.warn('⚠️  Panel invite not sent:', e.message); } }
      }
    }
  }
  if (wanted === null) return;

  // add new members
  for (const m of wanted) {
    const match = existing.find((r) => (m.email && (r.interviewer_email || '').toLowerCase() === m.email) || (r.interviewer || '').toLowerCase() === m.name.toLowerCase());
    if (match) { if ((match.interviewer || '') !== m.name || (match.interviewer_email || '') !== m.email) await db.dbRun("UPDATE interviews SET interviewer = ?, interviewer_email = ?, updated_at = datetime('now') WHERE id = ?", [m.name, m.email || null, match.id]); match.keep = true; continue; }
    const fresh = await db.dbGet('SELECT * FROM interviews WHERE id = ?', [main.id]);
    const id = uuidv4();
    await db.dbRun(`INSERT INTO interviews (id, application_id, candidate_id, vacancy_id, round, interviewer, interviewer_email, type, scheduled_date, scheduled_time, meeting_link, location, status, panel_id, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, fresh.application_id, fresh.candidate_id, fresh.vacancy_id, fresh.round, m.name, m.email || null, fresh.type, fresh.scheduled_date, fresh.scheduled_time, fresh.meeting_link, fresh.location, fresh.status, main.panel_id, userId || fresh.created_by || null]);
    if (!silent) try { await notify(id, { status: fresh.status, scheduled_date: fresh.scheduled_date, scheduled_time: fresh.scheduled_time }, null); } catch (e) { console.warn('⚠️  Panel invite not sent:', e.message); }
  }
  // remove members dropped from the list — unless they have already scored (that feedback is kept)
  for (const r of existing) {
    if (r.keep) continue;
    if (hasScore(r)) continue;
    await db.dbRun("UPDATE interviews SET is_deleted = 1, updated_at = datetime('now') WHERE id = ?", [r.id]);
    const before = await db.dbGet('SELECT * FROM interviews WHERE id = ?', [r.id]);
    if (before.confirmation_sent && main.status !== 'Cancelled') { try { await notify(r.id, { status: 'Cancelled' }, { ...before, status: 'Scheduled' }); } catch { /* best effort */ } }
  }
  // if the last member was removed, the record is a plain single interview again
  const left = (await members(db, main)).filter((r) => r.id !== main.id);
  if (!left.length) await db.dbRun('UPDATE interviews SET panel_id = NULL WHERE id = ?', [main.id]);
}

// Names of everyone on the panel (for the candidate's email).
async function names(db, interview) {
  const rows = await members(db, interview);
  return rows.map((r) => r.interviewer).filter(Boolean);
}

module.exports = { apply, forForm, names, members, parsePanel };
