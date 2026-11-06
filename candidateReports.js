// Downloadable reports:
//   - one candidate's full report (Word .docx, or a print-ready page that can be saved as PDF)
//   - a consolidated Excel report across candidates (optionally one vacancy / company / date range)
const XLSX = require('xlsx');
const docx = require('docx');
const { loadPipeline } = require('./pipeline');
const { average } = require('./scorecardCriteria');

const CRITERIA = [['knowledge', 'Role knowledge & skills'], ['experience', 'Relevant experience'], ['problem_solving', 'Problem solving'],
  ['communication', 'Communication'], ['leadership', 'Leadership & team handling'], ['culture', 'Attitude & culture fit'],
  ['learnability', 'Learnability'], ['energy', 'Energy and Enthusiasm'], ['selling', 'Selling Skills'], ['overall', 'Overall']];

const parse = (raw) => { try { const c = JSON.parse(raw || '{}'); return c && typeof c === 'object' ? c : {}; } catch { return {}; } };
const money = (n) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString('en-IN'));
const d10 = (d) => (d ? String(d).slice(0, 10) : '');
const dash = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));

async function candidateData({ dbAll, dbGet }, id) {
  const c = await dbGet('SELECT * FROM candidates WHERE id = ? AND is_deleted = 0', [id]);
  if (!c) return null;
  const applications = await dbAll(`SELECT a.*, v.title AS vacancy, v.company, v.location, v.vacancy_code, v.job_type, u.full_name AS recruiter
    FROM applications a LEFT JOIN vacancies v ON v.id = a.vacancy_id LEFT JOIN users u ON u.id = v.assigned_recruiter_id
    WHERE a.candidate_id = ? AND a.is_deleted = 0 ORDER BY a.created_at`, [id]);
  const interviews = (await dbAll(`SELECT i.*, v.title AS vacancy FROM interviews i LEFT JOIN vacancies v ON v.id = i.vacancy_id
    WHERE i.candidate_id = ? AND i.is_deleted = 0 AND i.status != 'Cancelled' ORDER BY i.vacancy_id, i.round`, [id]))
    .map((i) => ({ ...i, card: parse(i.scorecard) }));
  const assessments = await dbAll(`SELECT s.*, v.title AS vacancy FROM assessments s LEFT JOIN vacancies v ON v.id = s.vacancy_id
    WHERE s.candidate_id = ? AND s.is_deleted = 0 ORDER BY s.created_at`, [id]);
  const offers = await dbAll(`SELECT o.*, v.title AS vacancy FROM offers o LEFT JOIN vacancies v ON v.id = o.vacancy_id
    WHERE o.candidate_id = ? AND o.is_deleted = 0 ORDER BY o.created_at`, [id]);
  const joinings = await dbAll(`SELECT j.*, v.title AS vacancy FROM joining j LEFT JOIN vacancies v ON v.id = j.vacancy_id
    WHERE j.candidate_id = ? AND j.is_deleted = 0 ORDER BY j.created_at`, [id]);
  const pipe = (await loadPipeline(dbAll)).filter((p) => p.candidate_id === id);
  return { c, applications, interviews, assessments, offers, joinings, pipe };
}

/* ---------- concise one-page candidate report (shared by the print page and the Word file) ---------- */
const STAGES = ['Sourced', 'Screening', 'Shortlisted', 'Interview', 'Offered', 'Joined'];
const nice = (d) => { if (!d) return ''; const x = new Date(d); return isNaN(x) ? String(d) : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
const lakh = (n) => (n === null || n === undefined || n === '' ? '—' : `₹ ${Number(n)} L`);

function model(d) {
  const { c } = d;
  const rank = (a) => { const i = STAGES.indexOf(a.status); return i < 0 ? -1 : i; };
  const apps = [...d.applications].sort((x, y) => rank(y) - rank(x) || String(y.created_at).localeCompare(String(x.created_at)));
  const main = apps[0] || null;
  const pend = main ? d.pipe.find((x) => x.application_id === main.id) : null;
  const skills = (() => { try { const v = JSON.parse(c.skills || '[]'); return Array.isArray(v) ? v : String(c.skills || '').split(','); } catch { return String(c.skills || '').split(','); } })().map((x) => String(x).trim()).filter(Boolean).slice(0, 12);

  const sumScores = {}; const cnt = {};
  const ivs = d.interviews.map((i) => { const sc = (i.card && i.card.scores) || {}; for (const [k, v] of Object.entries(sc)) { if (v >= 1 && v <= 5) { sumScores[k] = (sumScores[k] || 0) + v; cnt[k] = (cnt[k] || 0) + 1; } } return i; });
  const params = CRITERIA.filter(([k]) => cnt[k]).map(([k, label]) => ({ label, value: Math.round((sumScores[k] / cnt[k]) * 10) / 10 }));
  const rated = ivs.filter((i) => i.rating !== null && i.rating !== undefined && i.rating !== '');
  const ivAvg = rated.length ? Math.round((rated.reduce((n, i) => n + Number(i.rating), 0) / rated.length) * 10) / 10 : null;
  const multiVac = new Set(ivs.map((i) => i.vacancy)).size > 1;
  const clip = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const strengths = ivs.map((i) => clip(i.card && i.card.strengths)).filter(Boolean);
  const concerns = ivs.map((i) => clip(i.card && i.card.concerns)).filter(Boolean);

  const tiles = [
    [c.total_experience !== null && c.total_experience !== undefined && c.total_experience !== '' ? `${c.total_experience} yrs` : '—', c.relevant_experience ? `Experience (${c.relevant_experience} relevant)` : 'Experience'],
    [lakh(c.current_ctc), 'Current CTC'], [lakh(c.expected_ctc), 'Expected CTC'],
    [c.notice_period !== null && c.notice_period !== undefined && c.notice_period !== '' ? `${c.notice_period} days` : '—', 'Notice period'],
    [main && main.match_score !== null && main.match_score !== undefined && main.match_score !== '' ? `${Math.round(main.match_score)} %` : '—', 'JD match'],
    [ivAvg !== null ? `${ivAvg} / 5` : '—', 'Interview average']
  ].filter(([v]) => v !== '—'); // tiles with nothing to show are left out
  const dobTxt = c.date_of_birth ? (() => { const dt = new Date(c.date_of_birth + 'T00:00:00Z'); if (isNaN(dt)) return ''; const age = Math.floor((Date.now() - dt.getTime()) / 31557600000); return `${dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })} (${age} yrs)`; })() : '';
  const kvContact = [['Mobile', c.mobile], ['Email', c.email], ['Date of birth', dobTxt], ['Location', [c.current_location, c.preferred_location ? `prefers ${c.preferred_location}` : ''].filter(Boolean).join(' (') + (c.current_location && c.preferred_location ? ')' : '')], ['Source', c.source]].filter(([, v]) => v);
  const kvBack = [['Now', [c.current_designation, c.current_company].filter(Boolean).join(', ')], ['Education', c.qualification]].filter(([, v]) => v);
  const assess = d.assessments.map((a) => `${a.assessment_type} — ${a.status === 'Completed' ? (a.score || a.result_summary || 'done') : String(a.status || '').toLowerCase()}`);
  const offerLines = [
    ...d.offers.map((o) => `${o.vacancy || 'Offer'}: ${o.offered_ctc ? `₹ ${money(o.offered_ctc)} CTC` : ''} · ${o.status}${o.offer_date ? ' · offered ' + nice(o.offer_date) : ''}${o.expected_joining ? ' · expected joining ' + nice(o.expected_joining) : ''}${o.approved_by_name ? ' · approved by ' + o.approved_by_name : ''}`.replace(/^(.*?): ·/, '$1:')),
    ...d.joinings.map((j) => `Joining (${j.vacancy || ''}): ${j.status}${j.actual_date ? ' on ' + nice(j.actual_date) : j.expected_date ? ' · expected ' + nice(j.expected_date) : ''}${j.joining_location ? ' · ' + j.joining_location : ''}`)
  ];
  return { c, main, apps, pend, skills, tiles, kvContact, kvBack, ivs, multiVac, params, strengths, concerns, assess, offerLines,
    subtitle: [c.candidate_code, main && main.vacancy, main && main.company, main && main.location, main && main.recruiter ? 'Recruiter: ' + main.recruiter : ''].filter(Boolean).join(' · '),
    status: main ? main.status : c.status };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const heat = (v) => (v >= 4 ? 'h4' : v >= 3 ? 'h3' : 'h2');
const verdictClass = (v) => (v === 'Proceed' ? 'ok' : v === 'Reject' ? 'bad' : 'warn');

function candidateHtml(d) {
  const m = model(d);
  const curIdx = m.main ? STAGES.indexOf(m.main.status) : -1;
  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const sec = (title, inner) => inner ? `<h2>${esc(title)}</h2>${inner}` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Candidate report — ${esc(m.c.full_name)}</title>
<style>
@page{size:A4;margin:12mm}*{box-sizing:border-box}
body{font-family:Calibri,Carlito,Arial,sans-serif;color:#1E2422;font-size:12px;line-height:1.35;max-width:820px;margin:18px auto;padding:0 16px}
.top{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #FFC72C;padding-bottom:8px;gap:12px}
h1{margin:0;font-size:23px;color:#1E3A52}.sub{color:#5C6A66;font-size:12px;margin-top:2px}
.pill{display:inline-block;background:#E3ECF4;color:#1E3A52;font-weight:700;padding:3px 10px;border-radius:99px;font-size:11px;white-space:nowrap}
.tiles{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin:10px 0}
.t{border:1px solid #D9DEE2;border-top:3px solid #1E3A52;border-radius:8px;padding:7px 9px}.t b{display:block;font-size:17px;color:#1E3A52}.t span{color:#6E7169;font-size:10.5px}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#1E3A52;margin:13px 0 5px;border-bottom:1px solid #D9DEE2;padding-bottom:2px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}.kv{display:grid;grid-template-columns:auto 1fr;gap:2px 10px}.kv i{font-style:normal;color:#6E7169}
.chip{display:inline-block;background:#F1F4F6;border-radius:5px;padding:1px 7px;margin:0 3px 3px 0;font-size:11px}
.flow{display:flex;margin:4px 0}.flow div{flex:1;text-align:center;padding:5px 2px;font-size:11px;background:#EEF1F4;color:#6E7169;border-right:2px solid #fff}
.flow div.done{background:#B8C9D8;color:#1E3A52}.flow div.now{background:#1E3A52;color:#fff;font-weight:700}
table{border-collapse:collapse;width:100%}th{background:#F1F4F6;text-align:left;font-size:11px;color:#5C6A66}th,td{border:1px solid #D9DEE2;padding:4px 7px;vertical-align:top}
.h{display:inline-block;border-radius:5px;padding:1px 6px;font-weight:700;margin:0 2px 3px 0;font-size:11px}.h4{background:#DDF1EA;color:#176B53}.h3{background:#FCEFD2;color:#8F5700}.h2{background:#FBE0DE;color:#A8302B}
.ok{color:#176B53;font-weight:700}.warn{color:#8F5700;font-weight:700}.bad{color:#A8302B;font-weight:700}
.note{background:#F7F8FA;border-left:3px solid #FFC72C;padding:6px 9px;margin-top:5px}
.foot{margin-top:14px;color:#9A9C92;font-size:10px;border-top:1px solid #D9DEE2;padding-top:5px;display:flex;justify-content:space-between;align-items:center}
button{padding:7px 14px;font-size:13px}@media print{.noprint{display:none}body{margin:0;padding:0;max-width:none}}
</style></head><body>
<div class="top"><div><h1>${esc(m.c.full_name)}</h1><div class="sub">${esc(m.subtitle)}</div></div><div style="text-align:right"><span class="pill">${esc(m.status || '—')}</span><div class="noprint" style="margin-top:6px"><button onclick="window.print()">Print / Save as PDF</button></div></div></div>
<div class="tiles">${m.tiles.map(([v, l]) => `<div class="t"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('')}</div>
<div class="two"><div>${sec('Contact', m.kvContact.length ? `<div class="kv">${m.kvContact.map(([k, v]) => `<i>${esc(k)}</i><span>${esc(v)}</span>`).join('')}</div>` : '')}</div>
<div>${sec('Background', (m.kvBack.length || m.skills.length) ? `<div class="kv">${m.kvBack.map(([k, v]) => `<i>${esc(k)}</i><span>${esc(v)}</span>`).join('')}${m.skills.length ? `<i>Skills</i><span>${m.skills.map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</span>` : ''}</div>` : '')}</div></div>
${sec('Where they are now', m.main ? `<div class="flow">${STAGES.map((s, i) => `<div class="${i === curIdx ? 'now' : i < curIdx ? 'done' : ''}">${s}</div>`).join('')}</div>
<div>${curIdx < 0 ? `Status: <b>${esc(m.main.status)}</b>. ` : ''}${m.pend ? `Pending with: <b>${esc(m.pend.pending_who)}</b>${m.pend.pending_what ? ' — ' + esc(m.pend.pending_what) : ''}${m.pend.days_in_stage !== undefined ? ` (${esc(m.pend.days_in_stage)} day${m.pend.days_in_stage === 1 ? '' : 's'})` : ''}` : ''}${m.apps.length > 1 ? `<div style="margin-top:3px;color:#5C6A66">Also considered for: ${m.apps.slice(1).map((a) => esc(`${a.vacancy || ''} (${a.status})`)).join('; ')}</div>` : ''}</div>` : '<div style="color:#6E7169">Not linked to a vacancy yet.</div>')}
${sec('Interviews', m.ivs.length ? `<table><tr>${m.multiVac ? '<th>Vacancy</th>' : ''}<th>Round</th><th>Interviewer</th><th>Date</th><th style="text-align:center">Average</th><th>Verdict</th><th>Hire as</th></tr>
${m.ivs.map((i) => `<tr>${m.multiVac ? `<td>${esc(i.vacancy || '')}</td>` : ''}<td>${esc(i.round || 1)}</td><td>${esc(dash(i.interviewer))}</td><td>${esc(nice(i.scheduled_date) || (i.status || '—'))}</td><td style="text-align:center"><b>${i.rating ? esc(Number(i.rating).toFixed(1)) : '—'}</b></td><td class="${verdictClass(i.recommendation)}">${esc(dash(i.recommendation))}</td><td>${esc(dash(i.hire_type))}</td></tr>`).join('')}</table>
${m.params.length ? `<div style="margin-top:6px">Parameter averages${m.ivs.length > 1 ? ' (all rounds)' : ''}: ${m.params.map((p) => `<span class="h ${heat(p.value)}">${esc(p.label)} ${p.value}</span>`).join(' ')}</div>` : ''}
${(m.strengths.length || m.concerns.length) ? `<div class="note">${m.strengths.length ? `<b>Strengths:</b> ${esc(m.strengths.join(' · '))}` : ''}${m.strengths.length && m.concerns.length ? '<br>' : ''}${m.concerns.length ? `<b>Concerns:</b> ${esc(m.concerns.join(' · '))}` : ''}</div>` : ''}` : '')}
<div class="two"><div>${sec('Assessments', m.assess.length ? m.assess.map((x) => `<span class="chip">${esc(x)}</span>`).join('') : '')}</div><div>${sec('Offer & joining', m.offerLines.map((x) => `<div>${esc(x)}</div>`).join(''))}</div></div>
${m.c.remarks ? sec('Recruiter’s note', `<div class="note">${esc(m.c.remarks)}</div>`) : ''}
<div class="foot"><span>Generated ${today} · RDC’s Recruitment Management System · Confidential</span></div>
</body></html>`;
}

async function candidateDocx(d) {
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType, AlignmentType } = docx;
  const m = model(d);
  const F = 'Calibri';
  const run = (text, o = {}) => new TextRun({ text: String(text ?? ''), font: F, size: o.size || 20, bold: !!o.bold, color: o.color });
  const para = (children, o = {}) => new Paragraph({ spacing: { before: o.before ?? 40, after: o.after ?? 40 }, children: Array.isArray(children) ? children : [children], ...(o.border ? { border: o.border } : {}), ...(o.align ? { alignment: o.align } : {}) });
  const h2 = (t) => para(run(t.toUpperCase(), { bold: true, size: 19, color: '1E3A52' }), { before: 200, after: 60, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D9DEE2', space: 1 } } });
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const thin = { style: BorderStyle.SINGLE, size: 4, color: 'D9DEE2' };
  const cell = (children, o = {}) => new TableCell({ children: Array.isArray(children) ? children : [children], width: o.w ? { size: o.w, type: WidthType.PERCENTAGE } : undefined,
    shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill, color: 'auto' } : undefined,
    borders: o.plain ? { top: none, bottom: none, left: none, right: none } : { top: thin, bottom: thin, left: thin, right: thin },
    margins: { top: 50, bottom: 50, left: 90, right: 90 } });
  const kids = [];
  kids.push(para([run(m.c.full_name, { bold: true, size: 44, color: '1E3A52' }), run(`   ${m.status || ''}`, { bold: true, size: 20, color: '1E3A52' })], { after: 0 }));
  kids.push(para(run(m.subtitle, { size: 20, color: '5C6A66' }), { after: 60, border: { bottom: { style: BorderStyle.SINGLE, size: 18, color: 'FFC72C', space: 4 } } }));
  if (m.tiles.length) kids.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: m.tiles.map(([v, l]) => cell([para(run(v, { bold: true, size: 28, color: '1E3A52' }), { after: 0 }), para(run(l, { size: 16, color: '6E7169' }), { before: 0, after: 0 })], { w: Math.floor(100 / m.tiles.length) })) })] }));
  const kvCell = (rows) => cell(rows.map(([k, v]) => para([run(k + ':  ', { color: '6E7169' }), run(v)], { before: 20, after: 20 })), { plain: true, w: 50 });
  if (m.kvContact.length || m.kvBack.length || m.skills.length) {
    kids.push(h2('Contact & background'));
    kids.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: [kvCell(m.kvContact.length ? m.kvContact : [['', '']]), kvCell([...m.kvBack, ...(m.skills.length ? [['Skills', m.skills.join(', ')]] : [])])] })] }));
  }
  kids.push(h2('Where they are now'));
  if (m.main) {
    const cur = STAGES.indexOf(m.main.status);
    kids.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: STAGES.map((s, i) => cell(para(run(s, { size: 17, bold: i === cur, color: i === cur ? 'FFFFFF' : i < cur ? '1E3A52' : '6E7169' }), { align: AlignmentType.CENTER }), { w: 16, fill: i === cur ? '1E3A52' : i < cur ? 'B8C9D8' : 'EEF1F4' })) })] }));
    const lines = [];
    if (cur < 0) lines.push(run(`Status: ${m.main.status}. `));
    if (m.pend) { lines.push(run('Pending with: ')); lines.push(run(m.pend.pending_who, { bold: true })); if (m.pend.pending_what) lines.push(run(' — ' + m.pend.pending_what)); }
    if (lines.length) kids.push(para(lines));
    if (m.apps.length > 1) kids.push(para(run('Also considered for: ' + m.apps.slice(1).map((a) => `${a.vacancy || ''} (${a.status})`).join('; '), { color: '5C6A66', size: 18 })));
  } else kids.push(para(run('Not linked to a vacancy yet.', { color: '6E7169' })));
  if (m.ivs.length) {
    kids.push(h2('Interviews'));
    const head = [...(m.multiVac ? ['Vacancy'] : []), 'Round', 'Interviewer', 'Date', 'Average', 'Verdict', 'Hire as'];
    kids.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
      new TableRow({ children: head.map((h) => cell(para(run(h, { bold: true, size: 18, color: '5C6A66' })), { fill: 'F1F4F6' })) }),
      ...m.ivs.map((i) => {
        const vc = i.recommendation === 'Proceed' ? '176B53' : i.recommendation === 'Reject' ? 'A8302B' : i.recommendation ? '8F5700' : undefined;
        const txt = (v, o = {}) => cell(para(run(v, { size: 19, ...o })));
        return new TableRow({ children: [...(m.multiVac ? [txt(i.vacancy || '')] : []), txt(i.round || 1), txt(dash(i.interviewer)), txt(nice(i.scheduled_date) || i.status || '—'),
          txt(i.rating ? Number(i.rating).toFixed(1) : '—', { bold: true }), txt(dash(i.recommendation), { bold: true, color: vc }), txt(dash(i.hire_type))] });
      })] }));
    if (m.params.length) kids.push(para([run(`Parameter averages${m.ivs.length > 1 ? ' (all rounds)' : ''}:  `, { color: '5C6A66' }), ...m.params.map((p) => run(`${p.label} ${p.value}    `, { bold: true, color: p.value >= 4 ? '176B53' : p.value >= 3 ? '8F5700' : 'A8302B', size: 19 }))], { before: 80 }));
    if (m.strengths.length) kids.push(para([run('Strengths: ', { bold: true }), run(m.strengths.join(' · '))]));
    if (m.concerns.length) kids.push(para([run('Concerns: ', { bold: true }), run(m.concerns.join(' · '))]));
  }
  if (m.assess.length) { kids.push(h2('Assessments')); kids.push(para(run(m.assess.join('   |   ')))); }
  if (m.offerLines.length) { kids.push(h2('Offer & joining')); m.offerLines.forEach((x) => kids.push(para(run(x)))); }
  if (m.c.remarks) { kids.push(h2('Recruiter’s note')); kids.push(para(run(m.c.remarks))); }
  kids.push(para(run(`Generated ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} · RDC’s Recruitment Management System · Confidential`, { size: 16, color: '9A9C92' }), { before: 240 }));
  return Packer.toBuffer(new Document({ styles: { default: { document: { run: { font: F, size: 20 } } } }, sections: [{ properties: { page: { margin: { top: 680, bottom: 680, left: 760, right: 760 } } }, children: kids }] }));
}

/* ---------- consolidated Excel ---------- */

// Assessment report for one candidate: every assessment on record (type, date, status, score, summary, link),
// as a Word file for the onboarding package. Returns null when the candidate has no assessment.
async function assessmentDocx(d) {
  const list = (d.assessments || []).filter((a) => a);
  if (!list.length) return null;
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType } = docx;
  const F = 'Calibri';
  const run = (text, o = {}) => new TextRun({ text: String(text ?? ''), font: F, size: o.size || 21, bold: !!o.bold, color: o.color });
  const para = (children, o = {}) => new Paragraph({ spacing: { before: o.before ?? 40, after: o.after ?? 40 }, children: Array.isArray(children) ? children : [children], ...(o.border ? { border: o.border } : {}) });
  const thin = { style: BorderStyle.SINGLE, size: 4, color: 'D9DEE2' };
  const cell = (text, o = {}) => new TableCell({ children: [para(run(text, { bold: o.bold, color: o.color }))], width: { size: o.w, type: WidthType.PERCENTAGE },
    shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill, color: 'auto' } : undefined, borders: { top: thin, bottom: thin, left: thin, right: thin }, margins: { top: 60, bottom: 60, left: 100, right: 100 } });
  const kids = [para(run('Assessment report', { bold: true, size: 40, color: '1E3A52' }), { after: 0 }),
    para(run(`${d.c.full_name}${d.c.candidate_code ? ' (' + d.c.candidate_code + ')' : ''}`, { size: 24, color: '5C6A66' }), { after: 80, border: { bottom: { style: BorderStyle.SINGLE, size: 18, color: 'FFC72C', space: 4 } } })];
  for (const a of list) {
    kids.push(para(run(`${a.assessment_type || 'Assessment'}${a.vacancy ? ' — ' + a.vacancy : ''}`, { bold: true, size: 24, color: '1E3A52' }), { before: 220, after: 60 }));
    const rows = [['Status', a.status], ['Date', a.assessment_date], ['Score', a.score], ['Result summary', a.result_summary], ['Report link', a.report_link], ['Remarks', a.remarks]].filter(([, v]) => v);
    kids.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: rows.map(([k, v]) => new TableRow({ children: [cell(k, { w: 24, bold: true, fill: 'F3F5F4', color: '1E3A52' }), cell(v, { w: 76 })] })) }));
  }
  kids.push(para(run(`Generated from RDC's Recruitment Management System on ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.`, { size: 17, color: '8A948F' }), { before: 240 }));
  return Packer.toBuffer(new Document({ sections: [{ properties: { page: { margin: { top: 900, bottom: 900, left: 1000, right: 1000 } } }, children: kids }] }));
}

async function consolidatedXlsx({ dbAll }, { vacancy_id, company, from, to } = {}) {
  const pipe = new Map((await loadPipeline(dbAll)).map((p) => [p.application_id, p]));
  const where = ['c.is_deleted = 0']; const params = [];
  if (vacancy_id) { where.push('a.vacancy_id = ?'); params.push(vacancy_id); }
  if (company) { where.push('v.company = ?'); params.push(company); }
  if (from) { where.push('date(COALESCE(a.created_at, c.created_at)) >= date(?)'); params.push(from); }
  if (to) { where.push('date(COALESCE(a.created_at, c.created_at)) <= date(?)'); params.push(to); }
  const needApp = vacancy_id || company;
  const rows = await dbAll(`
    SELECT c.*, a.id AS app_id, a.status AS app_status, a.match_score, v.id AS vid, v.title AS vacancy, v.vacancy_code, v.company, v.job_type, u.full_name AS recruiter
    FROM candidates c
    ${needApp ? 'JOIN' : 'LEFT JOIN'} applications a ON a.candidate_id = c.id AND a.is_deleted = 0
    LEFT JOIN vacancies v ON v.id = a.vacancy_id
    LEFT JOIN users u ON u.id = v.assigned_recruiter_id
    WHERE ${where.join(' AND ')} ORDER BY c.full_name, v.title`, params);
  const iv = await dbAll(`SELECT i.*, c.full_name AS candidate, v.title AS vacancy FROM interviews i LEFT JOIN candidates c ON c.id = i.candidate_id LEFT JOIN vacancies v ON v.id = i.vacancy_id WHERE i.is_deleted = 0 AND i.status != 'Cancelled' ORDER BY c.full_name, i.round`);
  const ass = await dbAll(`SELECT s.*, c.full_name AS candidate, v.title AS vacancy FROM assessments s LEFT JOIN candidates c ON c.id = s.candidate_id LEFT JOIN vacancies v ON v.id = s.vacancy_id WHERE s.is_deleted = 0 ORDER BY c.full_name`);
  const off = await dbAll(`SELECT o.*, v.title AS vacancy FROM offers o LEFT JOIN vacancies v ON v.id = o.vacancy_id WHERE o.is_deleted = 0 ORDER BY o.created_at`);
  const jn = await dbAll(`SELECT j.*, v.title AS vacancy FROM joining j LEFT JOIN vacancies v ON v.id = j.vacancy_id WHERE j.is_deleted = 0 ORDER BY j.created_at`);
  const keep = new Set(rows.map((r) => r.id)); const keepApp = new Set(rows.map((r) => r.app_id).filter(Boolean));

  const lastIv = (cid, vid) => iv.filter((i) => i.candidate_id === cid && (!vid || i.vacancy_id === vid)).pop();
  const latestA = (cid, type) => ass.filter((a) => a.candidate_id === cid && a.assessment_type === type).pop();
  const summary = [['Candidate Code', 'Name', 'Mobile', 'Email', 'Date of Birth', 'Current Location', 'Total Exp (yrs)', 'Current Company', 'Current Designation', 'Current CTC (LPA)', 'Expected CTC (LPA)', 'Notice (days)', 'Source',
    'Vacancy', 'Company', 'Type of Employment', 'Recruiter', 'Stage', 'Pending With', 'Match %', 'Rounds Done', 'Latest Average', 'Latest Recommendation', 'Plant PRO SRT', 'DISC', 'Offer Status', 'Offered CTC (₹)', 'Joining Status', 'Expected DOJ']];
  for (const r of rows) {
    const li = lastIv(r.id, r.vid); const p = pipe.get(r.app_id);
    const o = off.filter((x) => (r.vid ? x.vacancy_id === r.vid : true) && x.candidate_id === r.id).pop();
    const j = jn.filter((x) => (r.vid ? x.vacancy_id === r.vid : true) && x.candidate_id === r.id).pop();
    const srt = latestA(r.id, 'Plant PRO SRT'); const disc = latestA(r.id, 'DISC');
    summary.push([r.candidate_code, r.full_name, r.mobile, r.email, r.date_of_birth || '', r.current_location, r.total_experience, r.current_company, r.current_designation, r.current_ctc, r.expected_ctc, r.notice_period, r.source,
      r.vacancy ? `${r.vacancy_code ? r.vacancy_code + ' · ' : ''}${r.vacancy}` : '', r.company, r.job_type, r.recruiter, r.app_status || r.status, p ? `${p.pending_who}${p.pending_what ? ' – ' + p.pending_what : ''}` : '', r.match_score ?? '',
      iv.filter((i) => i.candidate_id === r.id && (!r.vid || i.vacancy_id === r.vid) && ['Completed'].includes(i.status)).length, li && li.rating !== null ? li.rating : '', li ? li.recommendation || '' : '',
      srt ? (srt.score || srt.status) : '', disc ? (disc.score || disc.status) : '', o ? o.status : '', o ? o.offered_ctc : '', j ? j.status : '', j ? d10(j.expected_date) : '']);
  }
  const ivSheet = [['Candidate', 'Vacancy', 'Round', 'Interviewer', 'Date', 'Status', ...CRITERIA.map(([, l]) => l), 'Average', 'Recommendation', 'Hire as', 'Strengths', 'Concerns']];
  iv.filter((i) => keep.has(i.candidate_id)).forEach((i) => { const c = parse(i.scorecard); const sc = c.scores || {};
    ivSheet.push([i.candidate, i.vacancy, i.round, i.interviewer, d10(i.scheduled_date), i.status, ...CRITERIA.map(([k]) => sc[k] ?? ''), i.rating ?? '', i.recommendation || '', i.hire_type || '', c.strengths || '', c.concerns || '']); });
  const asSheet = [['Candidate', 'Vacancy', 'Assessment', 'Status', 'Date', 'Score / Result', 'Summary', 'Report Link']];
  ass.filter((a) => keep.has(a.candidate_id)).forEach((a) => asSheet.push([a.candidate, a.vacancy, a.assessment_type, a.status, d10(a.assessment_date), a.score, a.result_summary, a.report_link]));
  const wb = XLSX.utils.book_new();
  for (const [name, data] of [['Candidates', summary], ['Interview scores', ivSheet], ['Assessments', asSheet]]) {
    const sh = XLSX.utils.aoa_to_sheet(data); sh['!cols'] = data[0].map(() => ({ wch: 20 })); XLSX.utils.book_append_sheet(wb, sh, name);
  }
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), count: rows.length };
}

module.exports = { candidateData, candidateHtml, candidateDocx, assessmentDocx, consolidatedXlsx };
