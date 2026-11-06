// Computes the Basic/HRA/Special Allowance/LTA/Employer PF/Gratuity/Variable
// breakdown from a single annual CTC figure, following RDC's official
// FY26-27 CTC slab structure (source: CTC_Slab_-_FY26-27.xlsx, sheet "NEw").
// Verified against all three of that sheet's worked examples (₹5.5L, ₹16L,
// ₹22L CTC) — every component matches to the rupee.
//
// Special Allowance is always the balancing figure: CTC minus every other
// component, so the total exactly equals the CTC entered. This mirrors the
// source spreadsheet, which computes it the same way (there, as a manually
// solved-for value; here, as an explicit formula) rather than a fixed %.
function round(n) {
  return Math.round(n);
}

function calculateCtcBreakdown(annualCtc) {
  const ctc = Number(annualCtc);
  if (!ctc || ctc <= 0) throw new Error('Enter a valid annual CTC amount greater than zero');

  const basic = round(ctc * 0.35);
  const hra = round(basic * 0.60);
  const gratuity = round(basic * 0.0481);

  let lta, pf, variable;
  if (ctc <= 1350000) {
    // Slab 1: up to ₹13.5L — PF is the statutory-minimum flat amount (12% of
    // the ₹15,000/month PF wage ceiling); no LTA or Variable at this level.
    lta = 0;
    pf = 21600;
    variable = 0;
  } else if (ctc <= 2000000) {
    // Slab 2: ₹13.5L to ₹20L
    lta = 30000;
    pf = round(basic * 0.12);
    variable = round(basic * 0.12);
  } else {
    // Slab 3: ₹20L and above — Variable is 10% of CTC here, not of Basic.
    lta = 50000;
    pf = round(basic * 0.12);
    variable = round(ctc * 0.10);
  }

  const specialAllowance = ctc - basic - hra - lta - pf - gratuity - variable;
  const toMonthly = (annual) => round(annual / 12);

  return {
    annual: { basic_pay: basic, hra, special_allowance: specialAllowance, lta, employer_pf: pf, gratuity, variable_component: variable },
    monthly: {
      basic_pay: toMonthly(basic),
      hra: toMonthly(hra),
      special_allowance: toMonthly(specialAllowance),
      lta: toMonthly(lta),
      employer_pf: toMonthly(pf),
      gratuity: toMonthly(gratuity),
      variable_component: toMonthly(variable)
    }
  };
}

module.exports = { calculateCtcBreakdown };
