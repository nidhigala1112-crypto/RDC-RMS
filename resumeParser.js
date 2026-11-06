// Reads a resume (PDF, DOCX or TXT) and pulls out the fields we can find with
// reasonable confidence, so a recruiter reviews them instead of typing them.
// This is rule-based, not AI: contact details are very reliable, name and
// experience are usually right, and company / designation are best-effort.

const mammoth = require('mammoth');


// Reads a text-based PDF with pdfjs-dist, rebuilding lines from each text item's
// vertical position so "Name", "Email: ..." etc. come out on their own lines.
let pdfjsLib = null;
function loadPdfjs() {
  if (pdfjsLib) return pdfjsLib;
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {}; // pdfjs prints harmless "cannot polyfill canvas" notices when loaded in Node
  try { pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js'); } finally { console.log = log; console.warn = warn; }
  return pdfjsLib;
}

async function extractPdfText(buffer) {
  const pdfjs = loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer), useSystemFonts: true, disableFontFace: true, verbosity: 0
  }).promise;
  let out = '';
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let lastY = null;
      for (const item of content.items) {
        const y = item.transform[5];
        if (lastY !== null) out += Math.abs(y - lastY) > 2 ? '\n' : ' ';
        out += item.str;
        lastY = y;
      }
      out += '\n';
    }
  } finally {
    await doc.destroy();
  }
  return out;
}

async function extractText(buffer, fileName = '') {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdf')) return extractPdfText(buffer);
  if (lower.endsWith('.docx')) {
    const out = await mammoth.extractRawText({ buffer });
    return out.value || '';
  }
  if (lower.endsWith('.txt')) return buffer.toString('utf8');
  if (lower.endsWith('.doc')) {
    try { const WordExtractor = require('word-extractor'); const doc = await new WordExtractor().extract(buffer); return doc.getBody() || ''; }
    catch (e) { throw new Error('This old Word (.doc) file could not be read — save it as .docx or PDF and try again.'); }
  }
  throw new Error('Upload a PDF, DOCX, DOC or TXT resume.');
}

const CITIES = ['Mumbai', 'Navi Mumbai', 'Thane', 'Pune', 'Delhi', 'New Delhi', 'Gurgaon', 'Gurugram', 'Noida', 'Ghaziabad', 'Faridabad',
  'Bengaluru', 'Bangalore', 'Hyderabad', 'Chennai', 'Kolkata', 'Ahmedabad', 'Surat', 'Vadodara', 'Rajkot', 'Jaipur', 'Lucknow', 'Kanpur',
  'Nagpur', 'Nashik', 'Aurangabad', 'Indore', 'Bhopal', 'Raipur', 'Bhubaneswar', 'Visakhapatnam', 'Coimbatore', 'Kochi', 'Chandigarh',
  'Ludhiana', 'Patna', 'Ranchi', 'Guwahati', 'Dehradun', 'Goa', 'Mysuru', 'Mangaluru', 'Vapi', 'Bharuch', 'Dahej', 'Panvel', 'Kalyan'];

const DEGREES = [
  ['MBA', /\bM\.?\s?B\.?\s?A\b/i], ['PGDM', /\bPGDM\b/i], ['PGDBM', /\bPGDBM\b/i], ['MSW', /\bM\.?\s?S\.?\s?W\b/i],
  ['M.Tech', /\bM\.?\s?Tech\b/i], ['B.Tech', /\bB\.?\s?Tech\b/i], ['B.E.', /\bB\.?\s?E\b\.?(?=\s*[\(\-\,]|\s+(?:in|civil|mechanical|electrical|chemical|computer))/i],
  ['M.Com', /\bM\.?\s?Com\b/i], ['B.Com', /\bB\.?\s?Com\b/i], ['BBA', /\bB\.?\s?B\.?\s?A\b/i], ['MCA', /\bMCA\b/i], ['BCA', /\bBCA\b/i],
  ['M.Sc', /\bM\.?\s?Sc\b/i], ['B.Sc', /\bB\.?\s?Sc\b/i], ['M.A.', /\bM\.\s?A\.\B|\bMaster of Arts\b/i], ['B.A.', /\bB\.\s?A\.\B|\bBachelor of Arts\b/i],
  ['LLB', /\bLL\.?\s?B\b/i], ['LLM', /\bLL\.?\s?M\b/i], ['CA', /\bChartered Accountant\b/i], ['PhD', /\bPh\.?\s?D\b/i],
  ['Diploma', /\bDiploma\b/i], ['ITI', /\bITI\b/], ['HSC', /\bHSC\b/]
];

const SKILLS = [
  'recruitment', 'talent acquisition', 'sourcing', 'end-to-end recruitment', 'campus hiring', 'bulk hiring', 'lateral hiring', 'headhunting',
  'onboarding', 'induction', 'employee engagement', 'employee relations', 'industrial relations', 'payroll', 'compensation', 'benefits',
  'performance management', 'learning and development', 'training', 'hrbp', 'hris', 'hrms', 'sap', 'sap hr', 'successfactors', 'workday',
  'labour laws', 'labor laws', 'statutory compliance', 'contract labour', 'pf', 'esic', 'gratuity', 'factories act', 'posh', 'attendance',
  'excel', 'advanced excel', 'power bi', 'tableau', 'sql', 'python', 'tally', 'ms office', 'powerpoint', 'erp',
  'sales', 'business development', 'key account management', 'b2b', 'channel sales', 'negotiation', 'cold calling', 'lead generation', 'crm',
  'marketing', 'digital marketing', 'seo', 'brand management', 'finance', 'accounting', 'gst', 'taxation', 'audit', 'budgeting', 'mis', 'costing',
  'procurement', 'purchase', 'vendor management', 'supply chain', 'logistics', 'warehouse', 'inventory', 'import', 'export',
  'production', 'plant operations', 'plant management', 'manufacturing', 'batching plant', 'ready mix concrete', 'rmc', 'concrete', 'admixtures',
  'quality control', 'quality assurance', 'qa', 'qc', 'iso 9001', 'iso 14001', 'iso 45001', 'lean', 'six sigma', 'kaizen', '5s', 'tpm', 'oee',
  'maintenance', 'preventive maintenance', 'mechanical', 'electrical', 'civil', 'instrumentation', 'autocad', 'project management', 'safety', 'ehs', 'hse',
  'r&d', 'research and development', 'laboratory', 'testing', 'chemistry', 'mineral', 'silicon', 'polymer',
  'leadership', 'team management', 'stakeholder management', 'communication', 'problem solving', 'strategic planning', 'it support', 'networking', 'java', 'javascript', 'react', 'node.js'
];

const DESIGNATION_WORDS = /\b(manager|executive|engineer|officer|head|lead|analyst|supervisor|associate|director|specialist|consultant|coordinator|chemist|technician|president|vp|assistant|trainee|intern|partner|recruiter|hrbp|operator)\b/i;
const COMPANY_WORDS = /\b(ltd|limited|pvt|private|inc|llp|corp|corporation|industries|solutions|technologies|group|enterprises|services|company|co\.|infra|cement|concrete|chemicals)\b/i;
const HEADING = /^(summary|profile|objective|experience|work experience|professional experience|employment|employment history|education|educational qualifications?|academics?|skills|key skills|technical skills|core competencies|projects|achievements|certifications?|personal details|declaration|references|interests)\s*:?\s*$/i;

function normalizeMobile(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function parseResumeText(rawText) {
  const text = String(rawText || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const found = {};

  // Email
  const email = text.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/);
  if (email) found.email = email[0].toLowerCase();

  // Date of birth: only when labelled (DOB / D.O.B / Date of Birth / Born) — a bare date could be a job or degree date
  {
    const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    const lab = text.match(/(?:d\.?\s?o\.?\s?b\.?|date\s+of\s+birth|birth\s*date|born(?:\s+on)?)\s*[:\-\u2013]?\s*([^\n]{0,40})/i);
    if (lab) {
      const s2 = lab[1]; let y, mo, dd, mm;
      if ((mm = s2.match(/(\d{1,2})(?:st|nd|rd|th)?[\s\/.\-]+(\d{1,2})[\s\/.\-]+((?:19|20)?\d{2})\b/))) { dd = +mm[1]; mo = +mm[2]; y = +mm[3]; }
      else if ((mm = s2.match(/(\d{1,2})(?:st|nd|rd|th)?[\s\-,.]*(?:of\s+)?([A-Za-z]{3})[a-z]*[\s\-,.]+((?:19|20)\d{2})/))) { dd = +mm[1]; mo = MON[mm[2].toLowerCase()]; y = +mm[3]; }
      else if ((mm = s2.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+((?:19|20)\d{2})/))) { mo = MON[mm[1].toLowerCase()]; dd = +mm[2]; y = +mm[3]; }
      if (y !== undefined && y < 100) y += y > 30 ? 1900 : 2000;
      if (y && mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31 && y >= 1950 && y <= new Date().getFullYear() - 14) found.date_of_birth = `${y}-${String(mo).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    }
  }
  // Mobile (Indian mobile numbers: 10 digits starting 6-9, optional +91 / spaces / hyphens)
  const mobileRe = /(?:(?:\+|00)?91[\s\-.]*)?0?\(?([6-9](?:[\s\-.]?\d){9})\)?(?!\d)/g;
  let m;
  while ((m = mobileRe.exec(text)) !== null) {
    const num = m[1].replace(/\D/g, '');
    if (num.length === 10) { found.mobile = num; break; }
  }

  // LinkedIn
  const li = text.match(/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|pub)\/[A-Za-z0-9\-_%]+\/?/i);
  if (li) found.linkedin_url = /^https?:/i.test(li[0]) ? li[0] : `https://${li[0]}`;

  // Name: first short, letters-only line near the top that isn't a heading or contact line
  for (const line of lines.slice(0, 10)) {
    const clean = line.replace(/^(name|resume|curriculum vitae|cv)\s*[:\-]\s*/i, '').trim();
    if (!clean || /@|\d|http|www\.|resume|curriculum|vitae|\bcv\b|profile|address|mobile|phone|email/i.test(clean)) continue;
    if (HEADING.test(clean)) continue;
    const words = clean.split(/\s+/);
    if (words.length >= 2 && words.length <= 4 && words.every((w) => /^[A-Za-z.'\-]+$/.test(w))) {
      const nm = clean.replace(/^(?:mr|mrs|ms|miss|dr|prof|shri|smt|sri|er)\.?\s+/i, '').trim();
      found.full_name = nm === nm.toUpperCase() ? titleCase(nm) : nm;
      break;
    }
  }

  // Location: first known city in the top of the document, else anywhere
  // contact lines (email / phone / address) anywhere in the first 12 lines, plus the first 3 lines; the city that appears EARLIEST wins
  const head = lines.slice(0, 12).filter((l, i) => i < 3 || /@|\d{5}|location|address|city|\|/i.test(l) || (l.length < 50 && !/\b(?:19|20)\d{2}\b|universit|college|institut|school|b\.?\s?tech|\bmba\b|b\.?\s?com|diploma/i.test(l) && CITIES.some((c) => new RegExp(`\\b${c}\\b`, 'i').test(l)))).join(' ');
  const cityHit = (src) => {
    let best = null;
    for (const c of CITIES) { const m = new RegExp(`\\b${c}\\b`, 'i').exec(src); if (m && (!best || m.index < best.idx || (m.index === best.idx && c.length > best.c.length))) best = { c, idx: m.index }; }
    return best && best.c;
  };
  const labelled = text.match(/^(?:current\s+)?(?:location|city)\s*[:\-]\s*(.+)$/im);
  const city = (labelled && cityHit(labelled[1])) || cityHit(head);
  if (city) found.current_location = city === 'Bangalore' ? 'Bengaluru' : city;

  // Total experience in years
  const exp = text.match(/(\d{1,2}(?:\.\d{1,2})?)\s*\+?\s*(?:years?|yrs?)(?:\s+of)?(?:\s+(?:total|overall|relevant|work|professional))?\s+(?:of\s+)?experience/i)
    || text.match(/experience\s*(?:of|:|-)?\s*(\d{1,2}(?:\.\d{1,2})?)\s*\+?\s*(?:years?|yrs?)/i);
  if (exp) found.total_experience = parseFloat(exp[1]);

  // Notice period → days
  const np = text.match(/notice\s*period\s*[:\-]?\s*(immediate(?:ly)?|(\d{1,3})\s*(days?|weeks?|months?))/i);
  if (np) {
    if (/immediate/i.test(np[1])) found.notice_period = 0;
    else {
      const n = parseInt(np[2], 10);
      found.notice_period = /month/i.test(np[3]) ? n * 30 : /week/i.test(np[3]) ? n * 7 : n;
    }
  }

  // CTC (labelled values only; assumes LPA)
  const ctcNum = (label) => {
    const r = text.match(new RegExp(`${label}[^\\n\\d]{0,25}(\\d{1,3}(?:\\.\\d{1,2})?)\\s*(?:lpa|lakhs?|lacs?|l\\.?p\\.?a)`, 'i'));
    return r ? parseFloat(r[1]) : null;
  };
  const cur = ctcNum('(?:current|present|existing)\\s*(?:ctc|salary|compensation)');
  const expd = ctcNum('(?:expected|expecting)\\s*(?:ctc|salary|compensation)');
  if (cur !== null) found.current_ctc = cur;
  if (expd !== null) found.expected_ctc = expd;

  // Qualification
  const quals = [];
  for (const [label, re] of DEGREES) if (re.test(text) && !quals.includes(label)) quals.push(label);
  if (quals.length) found.qualification = quals.slice(0, 3).join(', ');

  // Skills: known keywords, plus anything listed under a "Skills" heading
  const lowerText = text.toLowerCase();
  const skills = [];
  const addSkill = (s) => {
    const k = s.trim().replace(/^[•\-\*·▪●]\s*/, '');
    if (k && k.length <= 40 && !skills.some((x) => x.toLowerCase() === k.toLowerCase())) skills.push(k);
  };
  const skillsIdx = lines.findIndex((l) => /^(key |technical |core )?(skills|competenc(?:ies|y)|core competencies)\s*:?\s*$/i.test(l));
  if (skillsIdx >= 0) {
    for (const l of lines.slice(skillsIdx + 1, skillsIdx + 12)) {
      if (HEADING.test(l)) break;
      l.split(/[,|;•·▪●]/).forEach(addSkill);
    }
  }
  for (const kw of SKILLS) {
    const re = new RegExp(`(^|[^a-z0-9])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
    if (re.test(lowerText)) addSkill(kw.length <= 4 ? kw.toUpperCase() : titleCase(kw));
  }
  if (skills.length) found.skills = skills.slice(0, 25);

  // Current designation / company. Only filled when we are confident: an explicit label,
  // or a first experience line shaped like "Title | Company | dates" (or "Title at Company").
  // Otherwise left blank — a wrong value is worse than an empty field.
  const labelled2 = (re) => { const m = text.match(re); return m ? m[1].trim().replace(/\s{2,}.*$/, '') : ''; };
  const lbCompany = labelled2(/^(?:current\s+)?(?:company|organi[sz]ation|employer)\s*[:\-]\s*(.{2,70})$/im);
  const lbDesig = labelled2(/^(?:current\s+)?(?:designation|job title|position|role)\s*[:\-]\s*(.{2,60})$/im);
  if (lbCompany) found.current_company = lbCompany;
  if (lbDesig) found.current_designation = lbDesig;


  // ---- Second pass: things the simple rules above miss ----
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
  const NOW = new Date();
  const parseDate = (s, isEnd) => {
    s = String(s).trim().toLowerCase();
    if (/^(present|current|till date|to date|now|ongoing|date)$/.test(s)) return NOW.getFullYear() * 12 + NOW.getMonth();
    const my = s.match(/^([a-z]{3,9})\.?,?\s*'?(\d{2,4})$/);
    if (my && MONTHS[my[1].slice(0, 4) === 'sept' ? 'sept' : my[1].slice(0, 3)] !== undefined) { let y = +my[2]; if (y < 100) y += 2000; return y * 12 + MONTHS[my[1].slice(0, 4) === 'sept' ? 'sept' : my[1].slice(0, 3)]; }
    const ym = s.match(/^(\d{1,2})[\/\-](\d{4})$/); if (ym) return +ym[2] * 12 + (+ym[1] - 1);
    const y = s.match(/^(\d{4})$/); if (y) return +y[1] * 12 + (isEnd ? 11 : 0);
    return null;
  };
  const RANGE = /((?:[A-Za-z]{3,9}\.?,?\s*'?\d{2,4})|(?:\d{1,2}[\/\-]\d{4})|(?:\d{4}))\s*(?:-|–|—|to|till)\s*((?:[A-Za-z]{3,9}\.?,?\s*'?\d{2,4})|(?:\d{1,2}[\/\-]\d{4})|(?:\d{4})|present|current|till date|to date|now|ongoing)/gi;
  const SECTION_END = /^(education|educational|academics?|qualifications?|academic|skills?|key skills|technical|certifications?|projects?|personal|declaration|achievements?|interests?|hobbies|references?|languages?|awards?|training)\b/i;
  const EXP_START = /^(work |professional |employment |career )?(experience|history|summary)|^employment( history)?|^work history|^career (history|profile)|^work experience/i;
  const expIdx2 = lines.findIndex((l) => EXP_START.test(l) && l.length < 45 && !/summary|profile$/i.test(l));
  let expLines = [];
  if (expIdx2 >= 0) {
    for (const l of lines.slice(expIdx2 + 1)) { if (SECTION_END.test(l) && l.length < 45) break; expLines.push(l); }
  }
  const spans = [];
  for (const l of expLines) {
    let r; RANGE.lastIndex = 0;
    while ((r = RANGE.exec(l)) !== null) {
      const a = parseDate(r[1], false), b = parseDate(r[2], true);
      if (a !== null && b !== null && b >= a && b - a < 12 * 45) spans.push([a, b + (/^\d{4}$/.test(r[2]) ? 0 : 1)]);
    }
  }
  const hasLabelledExp = found.total_experience !== undefined;
  if (!hasLabelledExp && spans.length) {
    spans.sort((x, y) => x[0] - y[0]);
    let months = 0, [cs, ce] = spans[0];
    for (const [s, e] of spans.slice(1)) { if (s <= ce) ce = Math.max(ce, e); else { months += ce - cs; cs = s; ce = e; } }
    months += ce - cs;
    found.total_experience = Math.round((months / 12) * 2) / 2;
  }
  if (found.total_experience === undefined && /\bfresher\b|\bfresh graduate\b|no (?:prior )?(?:work )?experience/i.test(text)) found.total_experience = 0;

  // Current employer / designation from the most recent job entry, in any of the usual layouts:
  //   "Title | Company | dates"   "Title, Company - City (dates)"   or  three lines: Company / Title / dates
  if (!found.current_company || !found.current_designation) {
    const cityRe = new RegExp(`^(?:${CITIES.join('|')})(?:,\\s*[A-Za-z ]+)?$`, 'i');
    const clean = (s) => s.replace(RANGE, '').replace(/\(\s*\)/g, '').replace(/\(.*?\)/g, '').replace(/[\s,\-–—|@:]+$/, '').replace(/^[\s,\-–—|@•·▪●*]+/, '').trim();
    const isDes = (x) => DESIGNATION_WORDS.test(x) && !COMPANY_WORDS.test(x);
    const isCom = (x) => COMPANY_WORDS.test(x);
    const dateRe = /\d{4}|present|current|till date/i;
    const block = [];
    for (const l of expLines.slice(0, 8)) {
      if (l.length > 130) continue;
      block.push(l);
      if (dateRe.test(l) && RANGE.test(l)) { RANGE.lastIndex = 0; break; }
      RANGE.lastIndex = 0;
      if (block.length >= 4) break;
    }
    let des = '', com = '';
    const joined = block.map(clean).filter(Boolean);
    // single-line entry: split on | , at @ and spaced dashes, then drop city fragments
    if (joined.length === 1 || (joined.length >= 1 && /[|@]|\sat\s|,/.test(block[block.length - 1]) && isDes(joined[joined.length - 1].split(/\s*[|,@]\s*|\s+at\s+/)[0]))) {
      const line = joined[joined.length - 1];
      const parts = line.split(/\s*\|\s*|\s+at\s+|\s+@\s+|\s*,\s*|\s+[–—]\s+|\s+-\s+(?=[A-Z])/).map(clean).filter((x) => x && !cityRe.test(x));
      // re-join a designation split by a dash ("Deputy Manager - Human Resources")
      let di = parts.findIndex(isDes);
      if (di >= 0) {
        des = parts[di];
        if (parts[di + 1] && !isCom(parts[di + 1]) && !isDes(parts[di + 1]) && parts[di + 1].split(/\s+/).length <= 3 && parts[di + 2] && isCom(parts[di + 2])) des = `${parts[di]} - ${parts[di + 1]}`;
      }
      com = parts.find((x) => x !== des && !des.includes(x) && (isCom(x) || /^[A-Z][\w&.'-]*(\s+[A-Z][\w&.'-]*){0,4}$/.test(x)) && !DESIGNATION_WORDS.test(x)) || '';
    } else {
      // multi-line entry: a designation line and a company line, any order
      const cand = joined.filter((x) => !dateRe.test(x) || x.length > 6);
      des = cand.find(isDes) || '';
      com = cand.find((x) => x !== des && (isCom(x) || (/^[A-Z]/.test(x) && !isDes(x)))) || '';
      com = com.replace(/\s*,\s*[A-Za-z ]+$/, (m) => (cityRe.test(m.replace(/^\s*,\s*/, '')) ? '' : m));
    }
    if (des && com) { if (!found.current_designation) found.current_designation = des; if (!found.current_company) found.current_company = com; }
  }

  // Salary and notice written in other ways: "CTC: Rs. 8,50,000", "12 L", "Immediate joiner"
  const money = (label) => {
    const r = text.match(new RegExp(`${label}[^\\n\\d]{0,30}(?:rs\\.?|inr|₹)?\\s*(\\d{1,3}(?:,\\d{2,3})+|\\d+(?:\\.\\d+)?)\\s*(lpa|lakhs?|lacs?|l\\b|lpm|per annum|p\\.?a\\.?)?`, 'i'));
    if (!r) return null;
    let n = parseFloat(r[1].replace(/,/g, '')); if (!(n > 0)) return null;
    if (n >= 100000) n = n / 100000;           // full rupees -> lakhs
    else if (/lpm/i.test(r[2] || '')) n = (n * 12) / 100000;
    return n > 0 && n < 500 ? Math.round(n * 100) / 100 : null;
  };
  if (found.current_ctc === undefined) { const v = money('(?:current|present|existing)\\s*(?:ctc|salary|compensation|package)'); if (v !== null) found.current_ctc = v; }
  if (found.expected_ctc === undefined) { const v = money('(?:expected|expecting)\\s*(?:ctc|salary|compensation|package)'); if (v !== null) found.expected_ctc = v; }
  if (found.notice_period === undefined && /immediate(?:ly)?\s+(?:joiner|joining|available)|can join immediately/i.test(text)) found.notice_period = 0;

  return found;
}

module.exports = { extractText, parseResumeText, normalizeMobile };
