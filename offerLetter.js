// Generates a company-branded Appointment Letter (.docx) for an Offer record,
// following the structure and standard clauses of RDC Group's own template
// (11 numbered clauses + an Appendix A compensation table), with the correct
// letterhead, signatory, and figures swapped in per company/candidate/offer.
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, Header, Footer, ImageRun, Table, TableRow,
  TableCell, WidthType, AlignmentType, BorderStyle, ShadingType, VerticalAlign
} = require('docx');

const ASSETS_DIR = path.join(__dirname, 'assets', 'letterheads');

// Real pixel dimensions of the source letterhead images, used to keep each one's
// aspect ratio correct when it's scaled down to fit the page width.
const LETTERHEAD_CONFIG = {
  'RDC Concrete India Limited': {
    header: 'rdc-header.png', headerNativeSize: [793, 164],
    footer: 'rdc-footer.jpeg', footerType: 'jpg', footerNativeSize: [1813, 207],
    signature: 'rdc-signature.png', signatureNativeSize: [265, 125]
  },
  'Ultrafine Mineral & Admixture Pvt. Limited': {
    header: 'ultrafine-header.png', headerNativeSize: [1644, 475],
    footer: 'ultrafine-footer.png', footerType: 'png', footerNativeSize: [1644, 334],
    signature: null
  },
  'ROBO Silicon Pvt Ltd': {
    header: 'robo-header.png', headerNativeSize: [1653, 500],
    footer: 'robo-footer.png', footerType: 'png', footerNativeSize: [1653, 389],
    signature: null
  }
};

function scaledSize([w, h], targetWidth) {
  return { width: targetWidth, height: Math.round((h / w) * targetWidth) };
}

function money(n) {
  if (n === null || n === undefined || n === '') return '';
  return Math.round(Number(n)).toLocaleString('en-IN');
}

function firstName(fullName) {
  return (fullName || '').trim().split(/\s+/)[0] || '';
}

function formatDate(d) {
  const date = d ? new Date(d) : new Date();
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function p(text, opts = {}) {
  return new Paragraph({
    spacing: { after: opts.after ?? 160 },
    alignment: opts.align,
    children: [new TextRun({ text, bold: !!opts.bold, underline: opts.underline ? {} : undefined })]
  });
}

// A clause paragraph that starts with a bold label (e.g. "1.", "(a)") followed
// by normal-weight body text, matching the template's own layout.
function clause(label, text, opts = {}) {
  return new Paragraph({
    spacing: { after: opts.after ?? 160 },
    indent: opts.indent ? { left: opts.indent } : undefined,
    children: [
      new TextRun({ text: label ? `${label} ` : '', bold: true }),
      new TextRun({ text })
    ]
  });
}

function compRow(label, monthly, annual, opts = {}) {
  const cellOpts = { verticalAlign: VerticalAlign.CENTER, margins: { top: 80, bottom: 80, left: 100, right: 100 } };
  const shading = opts.total ? { fill: 'F0EEE7', type: ShadingType.CLEAR } : undefined;
  const bold = !!opts.total;
  return new TableRow({
    children: [
      new TableCell({ ...cellOpts, width: { size: 4500, type: WidthType.DXA }, shading, children: [new Paragraph({ children: [new TextRun({ text: label, bold })] })] }),
      new TableCell({ ...cellOpts, width: { size: 2500, type: WidthType.DXA }, shading, children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: money(monthly), bold })] })] }),
      new TableCell({ ...cellOpts, width: { size: 2500, type: WidthType.DXA }, shading, children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: money(annual), bold })] })] })
    ]
  });
}

async function buildAppointmentLetterDocx({ candidate, vacancy, offer, company }) {
  const cfg = LETTERHEAD_CONFIG[vacancy.company];
  if (!cfg) throw new Error(`No letterhead configured for company "${vacancy.company}"`);

  const headerBuf = fs.readFileSync(path.join(ASSETS_DIR, cfg.header));
  const footerBuf = fs.readFileSync(path.join(ASSETS_DIR, cfg.footer));
  const headerSize = scaledSize(cfg.headerNativeSize, 620);
  const footerSize = scaledSize(cfg.footerNativeSize, 620);

  const header = new Header({
    children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
      new ImageRun({ data: headerBuf, type: cfg.header.endsWith('.jpeg') || cfg.header.endsWith('.jpg') ? 'jpg' : 'png', transformation: headerSize })
    ] })]
  });
  const footer = new Footer({
    children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
      new ImageRun({ data: footerBuf, type: cfg.footerType, transformation: footerSize })
    ] })]
  });

  const basic = offer.basic_pay || 0;
  const hra = offer.hra || 0;
  const special = offer.special_allowance || 0;
  const lta = offer.lta || 0;
  const pf = offer.employer_pf || 0;
  const gratuity = offer.gratuity || 0;
  const variable = offer.variable_component || 0;
  const ctcMonthly = basic + hra + special + lta + pf + gratuity;
  const totalMonthly = ctcMonthly + variable;

  const addressLines = (candidate.address || candidate.current_location || '').split(/\r?\n|,\s*/).filter(Boolean);

  const body = [
    p(formatDate(offer.offer_date), { bold: true, after: 300 }),
    p(`Mr./Ms. ${candidate.full_name},`, { bold: true, after: 60 }),
    ...(addressLines.length ? addressLines.map((line) => p(line, { after: 60 })) : [p('', { after: 60 })]),
    p('', { after: 200 }),
    p('Sub.: APPOINTMENT LETTER', { bold: true, underline: true, after: 240 }),
    p(`Dear ${firstName(candidate.full_name)},`, { after: 240 }),
    p('With reference to your application and subsequent interview you had with us, we have pleasure in offering you an appointment in our Company on terms and conditions mentioned herein below:', { after: 280 }),

    clause('1.', `DESIGNATION : ${vacancy.title}`),
    clause('2.', `PLACE OF POSTING : ${vacancy.location || 'As advised by the Company'}`),
    clause('3.', 'Your compensation is attached as Appendix A.'),
    clause('4. (a)', 'You will be eligible for gratuity as per the Payment of Gratuity Act.'),
    clause('(b)', 'You will be covered under a Personal Accident Insurance for yourself and Mediclaim insurance scheme for self, spouse and children as per the Company policy (subject to a maximum of three dependents).', { indent: 360 }),
    clause('5. (a)', 'You will be on probation for a period of six months, from the date of your joining and after satisfactory completion of probationary period, you will be confirmed in the services of the company.'),
    clause('(b)', 'In the event of your performance and progress during the probation period is not found to be satisfactory, your probation period is liable to be extended for such period as determined by the company.', { indent: 360 }),
    clause('(c)', 'In case your performance and progress is not found to be satisfactory either during probation period or extended probation period, you will be relieved from the services of the Company without giving any notice or without assigning any reason.', { indent: 360 }),
    clause('(d)', 'All rewards and increments will be based purely on your performance on the job and your contribution to the company.', { indent: 360 }),

    clause('6.', 'LEAVE', { after: 60 }),
    p('You will be entitled to leaves as per the Leave Rules of the Company applicable to your cadre. However, paid leaves are granted after confirmation as per the normal practice followed by the Company. Moreover, leave will be granted as per the convenience and exigencies of work in the Company.'),

    clause('7.', 'PLACE OF WORK', { after: 60 }),
    p('Notwithstanding your initial posting, your services are transferable at any location place of work as per requirement of the Company.'),
    p('The Company reserves the right to transfer your services either partly or wholly to its holding or associate Companies.'),

    clause('8.', 'MEDICAL FITNESS', { after: 60 }),
    p('Your term of appointment is subject to your having been found medically fit, for which purpose you are required to undergo medical examination after joining by company appointed doctor.'),

    clause('9. (a)', 'You shall retire on attaining the age of 58 years unless specifically required by the company in writing to continue in service beyond this age.'),
    clause('(b)', 'In case of physical or mental disability or continued ill health. Continued ill health means your absence from duty on account of sickness for 15 days on different occasions in a month and 180 days on different occasions in a year.', { indent: 360 }),

    clause('10. (a)', "It is expected that you will have long association with our Company yet this appointment is terminable by giving three month's notice OR three month's notice pay (Basic + HRA) on either side. During probation period, your services can be terminated without giving any notice. However, notice period from the employee will be one month during probation period. Any employee involved in integrity issues or against whom a complaint has been filed in a police station will be terminated without notice or wages in lieu."),
    clause('(b)', 'It is expected that you will act with necessary sophistication and work as per the guidelines given by your superiors.', { indent: 360 }),
    clause('(c)', 'You will be covered by rules & regulations and HR policies applicable to your staff category as given in the HR Manual. You are expected to read this manual on joining.', { indent: 360 }),
    clause('(d)', 'You will not engage directly/indirectly or serve any other business whatsoever other than that of this company.', { indent: 360 }),
    clause('(e)', "It is expected from a person holding a responsible position like yours that honesty and commitment should prevail over hard work. It also goes without saying that you will maintain utmost confidentiality regarding the affairs of the Company and shall not divulge any such information which may be prejudicial to the interest of the Company.", { indent: 360 }),
    clause('(f)', 'In respect of matters which are not specifically covered by this letter, you will be governed by the service rules of the Company, which will be in force from time to time.', { indent: 360 }),
    clause('(g)', 'You are required to submit true copies of the certificates along with originals for verification at the time of joining:', { indent: 360, after: 80 }),
    ...['Latest passport size photograph', 'Age proof', 'Address proof', 'Qualification certificates', 'Experience certificate of last employment', 'PAN card', 'Aadhar card'].map((item, i) =>
      p(`${i + 1}. ${item}`, { after: 40 })
    ),

    p('', { after: 120 }),
    clause('11.', 'JOINING:', { after: 60 }),
    p('It is expected that you will take up your assignment within one month from the date of this letter.'),
    p('Please sign the duplicate copy of this letter as a token of your acceptance and return the same to us.', { after: 280 }),
    p(`We welcome you to ${shortCompanyName(vacancy.company)} and look forward to a long association with us.`, { after: 320 }),

    p('Yours Faithfully,', { after: 40 }),
    p(`For ${vacancy.company}`, { bold: true, after: cfg.signature ? 20 : 500 })
  ];

  // the signatory picked for this offer (else the company's default); the stored signature image belongs to the default one only
  const signer = { name: offer.signatory_name || company.signatory_name, designation: offer.signatory_designation || company.signatory_designation };
  const isDefaultSigner = !offer.signatory_email || !company.signatory_email || offer.signatory_email.toLowerCase() === company.signatory_email.toLowerCase();
  const signedBy = offer.approval_signature || offer.approved_by_name;
  if (offer.approval_signature) {
    // Signature drawn by the Authorized Signatory when approving this offer
    try {
      const png = Buffer.from(String(offer.approval_signature).split(',')[1], 'base64');
      body.push(new Paragraph({ children: [new ImageRun({ data: png, type: 'png', transformation: { width: 150, height: 70 } })] }));
    } catch { /* fall through to the name below */ }
  } else if (offer.approved_by_name) {
    body.push(new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: offer.approved_by_name, italics: true, size: 36, font: 'Segoe Script' })] }));
  } else if (cfg.signature && isDefaultSigner) {
    const sigBuf = fs.readFileSync(path.join(ASSETS_DIR, cfg.signature));
    const sigSize = scaledSize(LETTERHEAD_CONFIG[vacancy.company].signatureNativeSize, 150);
    body.push(new Paragraph({ children: [new ImageRun({ data: sigBuf, type: 'png', transformation: sigSize })] }));
  }

  body.push(
    p(signer.name || '_______________________', { bold: true, after: 20 }),
    p(signer.designation || 'Authorised Signatory', { after: signedBy ? 40 : 600 })
  );
  if (signedBy && offer.approved_at) {
    const when = new Date(String(offer.approved_at).replace(' ', 'T') + 'Z').toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    body.push(new Paragraph({ spacing: { after: 600 }, children: [new TextRun({ text: `Electronically approved and signed by ${offer.approved_by_name || signer.name} on ${when} IST` + (offer.approval_hash ? ` · Ref ${String(offer.approval_hash).slice(0, 10).toUpperCase()}` : ''), size: 16, color: '6E7169' })] }));
  }

  // Appendix A — compensation table, on its own page
  body.push(new Paragraph({ pageBreakBefore: true, alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: [new TextRun({ text: `Appendix A: ${candidate.full_name}`, bold: true })] }));

  const headerCellOpts = { shading: { fill: '1E2422', type: ShadingType.CLEAR }, verticalAlign: VerticalAlign.CENTER, margins: { top: 80, bottom: 80, left: 100, right: 100 } };
  const headerText = (t) => new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: t, bold: true, color: 'FFFFFF' })] });

  const componentRows = [
    ['Basic Pay', basic],
    ['House Rent Allowance', hra],
    ['Special Allowance', special],
    ['LTA', lta],
    ['Employer PF Contribution', pf],
    ['Gratuity', gratuity]
  ].filter(([, monthly]) => monthly); // drop rows that are 0, null, or undefined

  const table = new Table({
    width: { size: 9500, type: WidthType.DXA },
    columnWidths: [4500, 2500, 2500],
    rows: [
      new TableRow({ children: [
        new TableCell({ ...headerCellOpts, width: { size: 4500, type: WidthType.DXA }, children: [headerText('Particulars')] }),
        new TableCell({ ...headerCellOpts, width: { size: 2500, type: WidthType.DXA }, children: [headerText('Amount (Rs./month)')] }),
        new TableCell({ ...headerCellOpts, width: { size: 2500, type: WidthType.DXA }, children: [headerText('Amount (Rs./annum)')] })
      ] }),
      ...componentRows.map(([label, monthly]) => compRow(label, monthly, monthly * 12)),
      compRow('CTC', ctcMonthly, ctcMonthly * 12, { total: true }),
      ...(variable ? [compRow('Variable', variable, variable * 12)] : []),
      compRow('Total CTC', totalMonthly, totalMonthly * 12, { total: true })
    ]
  });
  body.push(table);
  if (offer.letter_remarks) {
    for (const line of offer.letter_remarks.split(/\r?\n/).filter((l) => l.trim())) {
      body.push(p(line, { after: 40 }));
    }
  }

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          margin: { top: 2500, bottom: 2200, left: 1100, right: 1100, header: 300, footer: 300 }
        }
      },
      headers: { default: header },
      footers: { default: footer },
      children: body
    }]
  });

  return Packer.toBuffer(doc);
}

function shortCompanyName(fullName) {
  if (!fullName) return 'the Company';
  if (fullName.includes('RDC')) return 'RDC';
  if (fullName.includes('Ultrafine')) return 'Ultrafine';
  if (fullName.includes('ROBO')) return 'ROBO';
  return fullName.split(' ')[0];
}

module.exports = { buildAppointmentLetterDocx, LETTERHEAD_CONFIG };
