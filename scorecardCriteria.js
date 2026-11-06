// One list of scorecard parameters shared by the server. (The two browser pages keep a matching copy.)
//  - "Selling skills" applies to sales candidates only.
//  - "Overall" is the interviewer's own overall impression; "Average" is worked out from the other scores.
const KEYS = ['knowledge', 'experience', 'problem_solving', 'communication', 'leadership', 'culture', 'learnability', 'energy', 'selling', 'overall'];
const SALES_RE = /\b(sales|selling|business development|business manager|business head|\bbd\b|marketing)\b/i;

const isSalesRole = (...titles) => titles.some((t) => SALES_RE.test(String(t || '')));

// Average of everything except the interviewer's "Overall"; falls back to "Overall" if that is all there is.
function average(scores) {
  const vals = Object.entries(scores || {}).filter(([k, v]) => k !== 'overall' && v >= 1 && v <= 5).map(([, v]) => v);
  const pool = vals.length ? vals : (scores && scores.overall >= 1 ? [scores.overall] : []);
  return pool.length ? Math.round((pool.reduce((a, b) => a + b, 0) / pool.length) * 10) / 10 : null;
}
module.exports = { KEYS, isSalesRole, average };
