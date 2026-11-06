// Shared Gmail SMTP transporter, used by the weekly tracker and interview
// notification emails. Kept in one place so there's a single spot to swap
// providers later if needed.
const nodemailer = require('nodemailer');

function getTransporter() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error('Email isn\'t configured on this server yet — SMTP_USER / SMTP_PASS are missing from .env.');
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

// ---- Branded look for every outgoing email ----
// All emails go through sendMail, so the look is applied in one place: Calibri throughout (with
// Carlito/Arial fallbacks for devices that don't have it), a steel-blue header band with the
// hi-vis accent, a white card, and a quiet footer. Table-based so it renders in Outlook too.
const FONT = "Calibri, Carlito, 'Segoe UI', Arial, sans-serif";

function brandify(html) {
  return String(html || '')
    .replace(/font-family:\s*Arial,\s*sans-serif;?/gi, `font-family:${FONT};`)
    .replace(/margin:\s*0 auto;?/g, 'margin:0;')
    .replace(/#B0502C/gi, '#FFC72C')
    .replace(/font-size:\s*14px/gi, 'font-size:15px')
    .replace(/font-size:\s*13px/gi, 'font-size:14px')
    .replace(/color:\s*#1E2422/gi, 'color:#1E3A52');
}

function wrapEmail(inner) {
  const wide = /max-width:\s*(8\d\d|9\d\d)px/.test(inner);
  const width = wide ? 900 : 640;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body,table,td,p,div,span,a,li,h1,h2,h3{font-family:${FONT};} h2{font-size:20px;} h3{font-size:16px;} p{margin:0 0 12px 0;} a{color:#1E3A52;}</style></head>
<body style="margin:0; padding:0; background:#EEF1F4; font-family:${FONT};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF1F4; padding:24px 12px;">
 <tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:${width}px; font-family:${FONT};">
   <tr><td style="background:#1E3A52; padding:16px 24px; border-radius:10px 10px 0 0; border-bottom:4px solid #FFC72C;">
     <span style="display:inline-block; background:#FFC72C; color:#1E3A52; font-weight:bold; font-size:14px; letter-spacing:1px; padding:3px 8px; border-radius:4px; font-family:${FONT};">RDC</span>
     <span style="color:#ffffff; font-size:17px; font-weight:bold; margin-left:10px; font-family:${FONT}; vertical-align:middle;">RDC’s Recruitment Management System</span>
   </td></tr>
   <tr><td style="background:#ffffff; padding:26px 28px; font-family:${FONT}; font-size:15px; line-height:1.55; color:#23271F; border-left:1px solid #DDE3E8; border-right:1px solid #DDE3E8;">
     ${brandify(inner)}
   </td></tr>
   <tr><td style="background:#F7F8FA; padding:14px 28px; border:1px solid #DDE3E8; border-top:none; border-radius:0 0 10px 10px; font-family:${FONT}; font-size:12px; color:#7A8590;">
     RDC Concrete India Ltd · Human Resources<br>This is an automated message from RDC’s Recruitment Management System. Please reply to this email if you have any questions.
   </td></tr>
  </table>
 </td></tr>
</table></body></html>`;
}

const toText = (html) => String(html || '').replace(/<(style|head)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/(p|div|tr|h\d)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\n{3,}/g, '\n\n').trim();

async function sendMail({ to, subject, html, attachments, replyTo, cc, icalEvent, raw }) {
  const transporter = getTransporter();
  const finalHtml = raw ? html : wrapEmail(html);
  return transporter.sendMail({
    from: `"RDC's Recruitment Management System" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html: finalHtml,
    text: toText(finalHtml),
    attachments,
    ...(replyTo ? { replyTo } : {}),
    ...(cc ? { cc } : {}),
    ...(icalEvent ? { icalEvent } : {})
  });
}

module.exports = { sendMail, wrapEmail, FONT };
