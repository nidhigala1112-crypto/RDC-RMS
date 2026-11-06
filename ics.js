// Builds iCalendar (.ics) events for interviews so the invite lands in Outlook / Google / Apple calendars with
// an Accept button — whether or not Google Calendar is connected to the tracker. Times are treated as India
// Standard Time. The event UID is fixed per interview and SEQUENCE grows with each send, so a reschedule
// UPDATES the existing calendar entry and a cancellation removes it, instead of creating duplicates.
const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

function fold(line) {
  const out = []; let rest = line;
  while (Buffer.byteLength(rest) > 74) {
    let cut = 74; while (Buffer.byteLength(rest.slice(0, cut)) > 74) cut -= 1;
    out.push(rest.slice(0, cut)); rest = ' ' + rest.slice(cut);
  }
  out.push(rest);
  return out.join('\r\n');
}

function localStamp(dateStr, timeStr, addMinutes = 0) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  const [hh, mm] = String(timeStr || '00:00').split(':').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, hh || 0, (mm || 0) + addMinutes));
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}00`;
}

// opts: { interview, candidate, vacancy, method: 'REQUEST'|'CANCEL', attendees: [{name,email}], organizerEmail, minutes }
function buildInterviewIcs({ interview, candidate, vacancy, method = 'REQUEST', attendees = [], organizerEmail, minutes = 60 }) {
  if (!interview || !interview.scheduled_date || !interview.scheduled_time) return null;
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const title = `Interview — ${candidate?.full_name || 'Candidate'}${vacancy?.title ? ' (' + vacancy.title + ')' : ''}`;
  const lines = [];
  if (interview.meeting_link) lines.push(`Meeting link: ${interview.meeting_link}`);
  lines.push(`Round: ${interview.round || 1}`);
  if (interview.interviewer) lines.push(`Interviewer: ${interview.interviewer}`);
  if (vacancy?.company) lines.push(`Company: ${vacancy.company}`);
  const cancel = method === 'CANCEL';
  const ev = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RDC Recruitment Management System//EN', 'CALSCALE:GREGORIAN', `METHOD:${method}`,
    'BEGIN:VTIMEZONE', 'TZID:Asia/Kolkata', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0530', 'TZOFFSETTO:+0530', 'TZNAME:IST', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT',
    `UID:interview-${interview.id}@rdc-recruitment`,
    `DTSTAMP:${stamp}`,
    `SEQUENCE:${Math.floor(now.getTime() / 60000)}`,
    `DTSTART;TZID=Asia/Kolkata:${localStamp(interview.scheduled_date, interview.scheduled_time)}`,
    `DTEND;TZID=Asia/Kolkata:${localStamp(interview.scheduled_date, interview.scheduled_time, minutes)}`,
    `SUMMARY:${esc((cancel ? 'CANCELLED: ' : '') + title)}`,
    `DESCRIPTION:${esc(lines.join('\n'))}`,
    `STATUS:${cancel ? 'CANCELLED' : 'CONFIRMED'}`
  ];
  const where = interview.meeting_link || interview.location;
  if (where) ev.push(`LOCATION:${esc(where)}`);
  if (interview.meeting_link) ev.push(`URL:${interview.meeting_link}`);
  if (organizerEmail) ev.push(`ORGANIZER;CN=RDC Recruitment:mailto:${organizerEmail}`);
  for (const a of attendees) if (a && a.email) ev.push(`ATTENDEE;CN=${esc(a.name || a.email)};ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:${a.email}`);
  if (!cancel) ev.push('BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', 'DESCRIPTION:Interview in 30 minutes', 'END:VALARM');
  ev.push('END:VEVENT', 'END:VCALENDAR');
  return ev.map(fold).join('\r\n') + '\r\n';
}

module.exports = { buildInterviewIcs };
