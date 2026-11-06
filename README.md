# RDC's Recruitment Management System

A small full-stack Applicant Tracking System (Node/Express/SQLite backend +
a plain HTML/CSS/JS frontend) for tracking clients, vacancies, candidates,
applications, interviews, offers, and joining across RDC Concrete, UMAPL and
ROBO Silicon.

## Setup

```bash
npm install
cp .env.example .env   # then edit SESSION_SECRET before deploying anywhere shared
npm start               # or: npm run dev (auto-restart via nodemon)
```

The server seeds a local SQLite database (`data/recruitment.db`) with demo
data on first run and prints the seeded login credentials to the console.
**Change those passwords immediately if this ever runs anywhere but your own
machine** — see "Known limitations" below.

Open `http://localhost:3000`.

## Project layout

```
server.js       Express app: routes, auth, generic CRUD engine
database.js     SQLite schema, migrations/seed data, small DB helpers
public/         Frontend — index.html, styles.css, app.js (no build step)
data/           SQLite database files (gitignored — created on first run)
```

## Pending — waiting on your input

A few requested changes aren't in this build yet, because they need
specifics from you first:
- **Dropdowns for "Raised By" and "Interviewer"** on vacancies/interviews —
  needs the list of names (and emails, for Interviewer) you'll provide.
- **Location and Function dropdowns on vacancies** — needs your lists (you
  said you'd share both).

## What's new in this pass

- **Vacancy Job Type options replaced** with Retainer, Fixed Term, Off Role,
  Trainee, Full Time (previously Full-time/Part-time/Contract/Internship).
- **"Closed Internally" added as a vacancy status** — counts toward TAT
  tracking and the Excel export the same way Closed/Cancelled do.
- **"Account Owner" removed from vacancies** (redundant with Assigned
  Recruiter). Still present on Companies, where it means something
  different.
- **Applications: Client Status/Client Feedback removed** — this is an
  internal-only tool now, so those client-facing fields didn't fit.
- **Auto-email when a recruiter is assigned to a vacancy.** Fires once per
  assignment — reassigning to someone new sends a fresh email, but other
  edits to the vacancy won't re-trigger it to the same recruiter.
- **Bulk-add interview rounds.** The Interviews screen has a new "+ Add
  Multiple Rounds" button — pick a candidate and vacancy, say how many
  rounds, and it creates that many round placeholders at once (Round 1,
  Round 2, ...), each ready for its own date and feedback afterward. This
  also meant relaxing "Scheduled Date" from required to optional on
  interviews generally, since a placeholder round doesn't have one yet.

- **Special Allowance now auto-balances live** on the Offers form. Change
  the Annual CTC, or manually adjust Basic/HRA/LTA/PF/Gratuity/Variable
  after using "Calculate breakdown," and Special Allowance instantly
  recalculates so everything still sums to the CTC exactly — no need to
  re-run the calculator after a manual tweak. (You may occasionally see it
  land ±₹1 off what "Calculate breakdown" would give from scratch — an
  unavoidable side effect of rounding whole rupees at each step, not a bug.)

- **Appointment letter email now uses your exact wording** — congratulations
  message, designation/location/company, document checklist, and the
  "cannot join without these documents" note, with the .docx still attached.
  Each company has its own onboarding form: open Companies, pick the company
  and paste its **Onboarding form link**. The email uses the link of the
  company the vacancy belongs to. If a company has no link, the old single
  `onboarding_form_link` in Settings is used as a fallback, and if that is
  blank too the line is simply omitted.

- **Appendix A table hides zero/blank line items.** If a component like LTA
  or Variable comes out to ₹0 (e.g. lower CTC slabs that don't include
  them), that row no longer appears on the letter at all — only CTC and
  Total CTC always show.
- **Appendix A remarks are now free text**, not a fixed sentence. The old
  hardcoded "Variable shall be paid as per Company policy..." line is gone;
  there's a new "Appendix A remarks" field on the offer where you can write
  whatever's relevant for that specific offer (or leave it blank for none).
  Supports multiple lines.

- **CTC auto-calculation.** The Offers form now asks for a single "Annual
  CTC (₹)" figure — click "Calculate breakdown from CTC" and it fills in
  Basic Pay, HRA, Special Allowance, LTA, Employer PF, Gratuity, and
  Variable automatically, following RDC's official FY26-27 CTC slab
  structure (three bands: up to ₹13.5L, ₹13.5L–₹20L, and ₹20L+, each with
  its own formula — see `ctcCalculator.js`). Every field stays editable
  afterward for exceptions. Verified against all three worked examples in
  the slab sheet you provided — matches to the rupee.

- **Critical fix: a broken request could crash the whole server.** Deleting
  almost any record besides a Client, Vacancy, or Candidate (Job
  Descriptions, Applications, Interviews, Offers, Joining, Communications,
  Follow-ups, Notes) hit a missing database column and took the entire
  server down for everyone. Fixed the missing columns everywhere, and — more
  importantly — added a safety net so no future bug like this can ever crash
  the server again; it now returns a clean error instead.
- **Auto-email the Appointment Letter on offer approval.** Setting an
  offer's status to the new "Approved" option automatically generates the
  letter and emails it (as a real .docx attachment) to the candidate, the
  vacancy's assigned recruiter, and anyone listed in the offer's new
  "Additional stakeholder emails" field — once per offer. A "Email it now"
  button lets you resend at any time afterward.
- **Interview confirmation re-sends on reschedule.** Editing an interview's
  date or time now automatically sends an "Interview Rescheduled" email
  (previously, only the very first save ever sent anything). A "Resend
  confirmation email" button also covers any other situation where you want
  to notify people again.
- **One combined email for scheduling + Meet link.** If Google Calendar is
  connected, scheduling a Video interview now generates the Meet link and
  sends a single email with everything, instead of two separate emails.
  Recipients are the candidate, interviewer, and the vacancy's assigned
  recruiter.

- **Google Meet link generation for interviews.** Open an interview and
  click "Generate Meet Link" to create a real Google Calendar event with an
  auto-generated Meet link, saved straight into that interview's Meeting
  Link field. Requires a one-time Google Calendar connection — see setup
  below.
- **Automatic interview emails.** Scheduling or editing an interview emails
  the candidate and the interviewer (if their email addresses are on file)
  with the date, time, location/link, and interviewer — once per interview,
  so later edits like feedback or rating don't re-send it. A reminder email
  goes out automatically the day before, to both, as long as the server is
  running that day (see the "server needs to be running" caveat under the
  Weekly Tracker section above — the same limitation applies here).
  "Interviewer" stayed a free-text field rather than becoming a user
  picker, so there's also a separate "Interviewer email" field — this is
  the address the reminder actually goes to.
  **Setup required:** the same `SMTP_USER` / `SMTP_PASS` in `.env` as the
  Weekly Tracker email (see above) — if you've already set that up, these
  emails work with no extra steps.

**Google Calendar one-time setup** (needed only for the Meet Link button —
the automatic interview emails work without it, using plain SMTP):
1. Go to [console.cloud.google.com](https://console.cloud.google.com) and
   create a project (or use an existing one).
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** → User type **External** →
   fill in the required fields → under **Test users**, add the Gmail
   account you'll connect in step 5.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   → Application type **Web application** → under **Authorized redirect
   URIs** add `http://localhost:3000/api/google/oauth/callback` (change
   the port if you run this on a different one). Copy the **Client ID**
   and **Client Secret** into `.env` as `GOOGLE_CLIENT_ID` /
   `GOOGLE_CLIENT_SECRET`.
5. Start the app, log in as a super_admin, go to **Settings**, and click
   **Connect Google Calendar** — sign in with the same Google account from
   step 3 and approve access.

- **Interviewer scorecard link.** Open an interview → "Interviewer scorecard
  link" → Create link. Share it (Copy link, or "Email to interviewer" if the
  interview has an interviewer email) and the interviewer fills in the
  six-criteria scorecard, strengths, concerns, a Proceed/Hold/Reject
  recommendation and comments on a simple mobile-friendly page — no login.
  Their answers land on the interview, the overall rating is calculated, the
  interview is marked Completed (if it was still scheduled), and the
  vacancy's recruiter gets an email. The link is a long random address valid
  for 30 days, can be reused to edit answers until it expires, and "Make a new
  link" instantly kills the old one. The page shows only the candidate's name,
  role, company, round and date — no contact or salary details.
  **Important:** the link uses the address in `APP_BASE_URL` (in `.env`), or
  the address you're browsing from. While the tracker runs only on your own
  computer (`localhost:3000`) the link works only on that computer — set
  `APP_BASE_URL` once the tracker is hosted where interviewers can reach it.
- **Resume parsing.** On the Candidates page, "Add from resume" reads a PDF,
  DOCX or TXT resume and fills in the new-candidate form — name, email,
  mobile, location, experience, qualification, skills, notice period and
  (when labelled) current/expected CTC, plus a best guess at current company
  and designation. Always check the result before saving; the resume file is
  attached automatically. It is rule-based, not AI, and works best on
  conventional resumes. Scanned (image-only) PDFs and old .doc files can't be
  read.
- **Duplicate detection.** A candidate is a duplicate when another record has
  the same email (any capitalisation) or the same mobile number (last 10
  digits, so +91, spaces and hyphens don't matter). The form warns as soon as
  you type, with an "Open existing" button, and the server refuses to save a
  duplicate. Existing duplicates already in your data aren't touched — they
  only block you if you change their email or mobile to match another record.
- **Interview scorecard.** Open an interview to score six criteria from 1 to
  5 (role knowledge, relevant experience, problem solving, communication,
  leadership, attitude/culture fit) and note strengths and concerns. Criteria
  you skip are left out; the overall rating is the average and fills the
  rating field automatically. The new Scorecards page compares candidates
  side by side (filter by vacancy), and the scores are columns in Admin →
  Reports → Interviews. The candidate's Plant PRO SRT and DISC results (status,
  score/result, summary, report link) appear inside the interview scorecard
  and as chips on the Scorecards page, and as columns in the Interviews
  report. They are shown next to the 1–5 average, not mixed into it, since
  they use different scales.
- **New look.** Fresh visual design: steel-blue sidebar with a hi-vis yellow
  marker, rounded cards, pill-shaped status tags, a split-screen sign-in page,
  and a layout that works on a phone. Fonts load from Google Fonts, so the
  computer needs internet access to show them (it falls back to system fonts
  otherwise).
- **Next step guide.** Open any candidate and a "Next step" box at the top
  shows where they are for each vacancy (not yet interviewed, interview
  pending, ready for an offer, offer approved, joining) with a button for the
  next action — Schedule interview, Add feedback, Create offer, Add joining.
  The button takes you to the right page with the candidate and vacancy
  already filled in.
- **How to use this.** A one-page walkthrough of a hire from start to finish,
  in the sidebar under Overview.
- **Role-based menu.** Recruiters no longer see Companies or the Admin
  section; viewers also don't see Offers or Follow-ups. This only hides menu
  items and blocks the page — it is not a security boundary on the data
  itself.
- **Assessments (Plant PRO SRT and DISC).** A new Assessments page under
  Pipeline records, for each candidate, which assessment was taken, its
  status, date, score/result, summary and a link to the full report. "Open
  Plant PRO SRT" and "Open DISC" buttons open the tools on hr.rdcc.ai in a new tab. The tool links can be
  changed in Settings (`srt_url`, `disc_url`). Assessments are also available
  as a report in Admin → Reports and in the Excel export. This is a manual
  link — results are typed or pasted in; automatic sign-in and result sync
  with the portal isn't built yet.
- **TAT on the Dashboard.** Average days to close, by company, recruiter and
  location, plus a list of vacancies still open past the "sla vacancy
  critical days" setting (30 by default — change it in Settings and the
  dashboard follows). Counts Closed and Closed Internally vacancies; vacancies
  closed before closing dates were tracked are left out.
- **Reports (Admin → Reports).** Super Admins and HR Managers can pick a
  report (Vacancies, Candidates, Applications, Interviews, Offers or
  Joinings), tick exactly the columns they want, optionally filter by status
  and date range, then preview it on screen or download it as Excel. Your
  column choices are remembered in your browser for next time.
- **Weekly Recruitment Tracker email.** Every Monday morning (while the server
  is running), the app emails two tables to whoever's listed in Settings →
  `email_recipients`: (1) **Vacancies in Progress** — Vacancy, Company,
  Location, Priority, Raised By, Status, and Count (positions still left to
  fill); Closed, Closed Internally and Cancelled vacancies are left out; and
  (2) **Upcoming Joinings** — Name, Designation, Location, Tentative DOJ and
  Contact No., for candidates whose joining is Expected or Confirmed with a
  date of today or later. There's also a "Send Now" button in Settings for
  testing or sending on demand.
  **Setup required:** copy `.env.example` to `.env` and fill in `SMTP_USER`
  / `SMTP_PASS` with a Gmail account and an
  [App Password](https://myaccount.google.com/apppasswords) (not your
  regular Gmail password — you'll need 2-Step Verification turned on first).
  Without this, you'll get a clear error when you try to send rather than a
  silent failure.
  **Important caveat:** this only fires automatically if the server happens
  to be running at the time (or gets restarted on a Monday) — it's a local
  app, not a hosted server that runs 24/7. If your laptop is off on Monday
  morning, that week's email won't go out on its own; use "Send Now" to
  catch up, or leave the server running continuously if you want it fully
  hands-off.

- **Appointment Letter generation.** Open any Offer and click "Download
  Appointment Letter" to get a real, company-branded .docx — correct
  letterhead, correct signatory, and a compensation table (Appendix A) built
  from the monthly figures you enter on that offer. Uses your actual RDC/
  ROBO/Ultrafine letterheads and RDC's signature; ROBO and Ultrafine will
  show a blank signature line with "Authorised Signatory" until you add a
  signatory name/designation for them on the Companies screen (see below).
  The letter's clauses (probation, leave, notice period, etc.) are the
  standard wording from the template you provided — the same wording is
  used for all three companies, only the letterhead/company name/signatory
  differ. If any company needs different clause wording, that's a
  straightforward follow-up change to `offerLetter.js`.
- **Companies screen** (replaces the old "Clients" tab, which didn't fit an
  internal-hiring tool). Pre-seeded with your three real companies —
  registered address, CIN, and RDC's signatory — pulled from the letterheads
  you shared. Edit these any time; the Appointment Letter always uses
  whatever's currently saved here.
- **Vacancy "Raised By" and closure TAT.** The vacancy form's "Received
  from" field is now labeled "Raised by (manager/department)". Every
  vacancy list now shows when it was raised and a TAT (days) column —
  running total while open, final count once closed. This is also in the
  Vacancies Excel export.
- **Candidate address field**, used to fill in the appointment letter's
  recipient block.
- **Excel export on every tab**, not just Candidates — Vacancies, Companies,
  JDs, Applications, Interviews, Offers, Joining, Follow-ups, and Users
  (Users export never includes password hashes) all have an "Export to
  Excel" button now, respecting whatever search/filter is currently active.

### From the previous update

- **Company replaces Client on vacancies.** Creating/editing a vacancy now
  asks for "Company" as a required dropdown of exactly three options: RDC
  Concrete India Limited, Ultrafine Mineral & Admixture Pvt. Limited, ROBO
  Silicon Pvt Ltd. (The old `client_id`/external-clients relation still
  exists in the schema for backward compatibility, but is no longer shown
  in the vacancy form.) If you already had vacancies before this update, the
  migration adds the new column automatically without touching any existing
  data — see "Migrations" below.
- **JD ↔ Vacancy ↔ Candidate tagging, with a real match score.** A JD is
  tagged to a vacancy (the "Job description" field on the vacancy form).
  Tagging a candidate to that vacancy — either from the Applications screen,
  or directly from a candidate's "Vacancies this candidate is tagged to"
  section — now automatically calculates a percentage match score by
  comparing the candidate's skills, experience, and qualification against
  the JD's requirements. The breakdown (mandatory skills / preferred skills
  / experience range / qualification, each weighted per the Settings screen)
  shows on the application record, with a "Recalculate" button. Qualification
  matching is a simple text comparison, so treat it as a rough signal.
- **Excel export for candidates.** The Candidates screen has an "Export to
  Excel" button that downloads a real .xlsx with every candidate's profile
  fields and current status. If you've searched or filtered the list first,
  the export respects that — it only downloads what's currently shown.

## Migrations

Starting with this version, database schema changes to an *existing*
database (like one you've already been using) are handled by a small
`migrate()` step in `database.js`, which runs automatically every time the
server starts. It only ever adds new columns — it never deletes or
overwrites data. You don't need to do anything for this to happen; just
restart the server after updating the code.

## Earlier fixes (previous pass)

Starting from the original backend-only zip, this pass:

- **Built the frontend** (`public/`) — it didn't exist before. A single
  config-driven CRUD engine in `app.js` drives every list/create/edit screen
  from one `ENTITIES` config object, so adding a new table to the tracker
  means adding a config block, not a new page.
- **Added pagination, search and filtering** to every list endpoint
  (`GET /api/<table>?page=&pageSize=&q=&<field>=`) instead of returning
  whole tables.
- **Added a `/api/settings` route** (previously the `settings` table — scoring
  weights, SLA thresholds — had no API at all).
- **Fixed user deletion**: `DELETE /api/users/:id` now deactivates
  (`is_active = 0`) instead of hard-deleting, since other tables reference
  user ids (`clients.account_owner_id`, `created_by`, etc.) and a hard delete
  either breaks that foreign key or leaves it dangling.
- **Fixed a data leak**: `GET /api/users` was returning every column
  including the bcrypt `password_hash` to any logged-in user. Stripped.
- **Added input validation** (required fields, enum values, basic email
  format) so bad requests get a clear 400 instead of writing junk or
  throwing a raw SQL error.
- **Auto-sync vacancy fill counts**: marking a `joining` record "Joined" now
  recomputes that vacancy's `positions_filled` and auto-closes it once fully
  staffed, instead of `positions_filled` sitting unused forever.
- **Login rate limiting**: 5 failed attempts locks a username out for 15
  minutes (in-memory — see limitations).
- **Resume downloads** are now blocked for the `viewer` role.
- Retry-on-conflict for the `VAC-00001`/`CAN-00001` style code generator, to
  avoid a rare duplicate-code failure under concurrent inserts.

## Known limitations / things to revisit before wider rollout

- **Google Calendar is one shared connection for the whole app**, not
  per-user — whoever connects it in Settings, every Meet link gets created
  on that one Google account's calendar. There's no per-recruiter Google
  connection.
- **Interview and tracker emails depend on the server being on.** Both the
  Monday tracker and the day-before interview reminder are checked hourly
  while the app is running — if your laptop is off, that check just doesn't
  happen. Nothing catches up retroactively for a reminder that should have
  gone out while the server was off (unlike the tracker, there's no manual
  "send now" for a specific overdue interview reminder yet).

- **Login throttling is per-process, in-memory.** Fine for one small internal
  deployment; if this is ever run behind a load balancer with multiple
  instances, move it to a shared store.
- **No automated SLA/email alerts.** The `settings` table has SLA thresholds
  (`sla_no_candidate_days`, `sla_feedback_pending_hours`, ...) and an
  `email_recipients` list, but nothing currently reads them on a schedule —
  there's no cron/notification job. The Settings screen lets you edit the
  values; wiring up actual alerts is a separate piece of work.
- **Resume parsing still isn't built.** The match score now works from the
  candidate's profile fields (skills, experience, qualification) — it does
  not read the actual resume file. `resumes.extracted_text` / `parsed_data`
  columns exist in the schema for this, but nothing populates them yet.
  `archiver` and `unzipper` are also listed as dependencies but aren't used
  anywhere, which suggests bulk import/export was planned but not built.
- **Qualification matching is a simple text comparison** (does the JD's
  qualification text appear in the candidate's, or vice versa) — treat that
  part of the match score as a rough signal, not a precise measure.
- **Appointment Letter signatures aren't uploadable from the UI yet.** RDC's
  signature image is bundled as a default asset (from the template you
  provided); ROBO and Ultrafine will print a blank line + "Authorised
  Signatory" until they have one. Adding an upload field on the Companies
  screen for this is a reasonably small follow-up if you want it.
- **Appointment Letter clause wording is shared across all three
  companies** — only the letterhead, company name, and signatory change per
  company. If any of the three needs genuinely different terms (not just
  different branding), that needs a code change in `offerLetter.js`, not
  just a Settings/Companies edit.
- **`npm audit`** currently reports vulnerabilities in transitive
  install-time dependencies (mainly via `bcrypt`'s native-build toolchain).
  Run `npm audit` yourself and consider `npm audit fix` after testing —
  I didn't force any upgrades here since I couldn't fully verify bcrypt's
  native binary across platforms in this environment.
- **Multi-entity scale**: at 1,800–2,200 employees and multi-year recruiting
  history across three companies, keep an eye on whether the current
  SQLite file (single file, single writer) remains comfortable, or whether
  it's worth moving to Postgres once usage grows.

## Interface touches
- Sidebar icons, a greeting on the Dashboard, and a "Hiring pipeline" strip showing applications by stage (Sourced → Joined).
- Initials badges beside candidate and user names, and your name/role chip at the top right.
- One-click status pills above Applications, Vacancies and other lists that have a Status filter.
- Friendlier empty states that tell you whether to clear filters or add the first record.

## Interviewer gets the scorecard link in the invite
When an interview is scheduled (and on reschedule, Meet-link and day-before reminder emails), the interviewer receives their own copy of the invite with a **Fill in the scorecard** button. The candidate and recruiter get the normal invite without it — the link is never sent to the candidate. Interviewer emails need the interviewer's email on the interview. Set `APP_BASE_URL` in `.env` to the address interviewers can reach; until then the link points at localhost and only opens on this computer.

## Enter the candidate once
On Add Interview / Offer / Joining / Assessment, choose the candidate and the form fills the rest: the vacancy (their most recent active application — change it if needed), next round number, interviewer and type from the previous round, expected joining from notice period, joining location, and offered CTC from the offer. Only empty fields are filled; anything typed is kept. Records are linked to the candidate's application automatically.

## Less retyping
- **Scorecard link rides on the invite.** When an interview is saved, the interviewer's invite email contains their private scorecard link. The candidate's email never does. Needs the interviewer email filled in, and `APP_BASE_URL` set in `.env` once hosted (otherwise the link only opens on the server computer).
- **Pick, don't type.** In Interview / Assessment / Offer / Joining forms the Candidate box opens with people currently in the pipeline. Choose one and the vacancy is filled in.
- **Next step ▾ on every application row** opens Schedule interview / Record assessment / Create offer / Add joining already filled with that candidate and vacancy.
- **Smart defaults:** next interview round number, interviewer copied from the last round, assessment type not yet recorded, offer date, expected joining (today + notice period), joining location from the vacancy.
- **Interviewers are remembered:** type a name used before and their email fills in.

## Automatic follow-up reminders
Runs hourly (and when the server starts). Emails only go out between 8am and 7pm. Control it under **Settings → Automatic reminders**, where you can also *Preview what's due now* and *Run now*.

| Stage | What triggers it | What happens |
|---|---|---|
| Interview | Date passed, no scorecard/rating | Task for the recruiter; interviewer emailed 1 and 3 days later with their scorecard link |
| Assessment | Pending 1+ day / Sent 2+ days, not completed | Task for the recruiter; candidate emailed at 2 and 5 days (if candidate emails are on) |
| Offer | Sent/Approved/Negotiation for 3+ days; valid-till within 2 days; valid-till passed | Task; candidate emailed at 3 and 6 days and the day before expiry (if on) |
| Joining | 3 days before, 1 day before; date passed with no outcome | Candidate prep emails with the company onboarding form (if on); task when the date passes |

- Tasks appear on the **Follow-ups** page, assigned to the vacancy's recruiter, and **close themselves** when the work is done (scorecard in, offer accepted, joined...). Each recruiter also gets one digest email a day.
- Nobody is emailed twice for the same reminder.
- **Candidate emails are off by default.** Preview first, then tick "Also email candidates".
- Needs the server to be running (reminders can't fire while it's switched off) and `SMTP_USER` / `SMTP_PASS` in `.env`.

## Automatic stage updates
Forward-only; Rejected / Withdrawn / Joined are never overwritten.
- Interview scheduled -> application "Interview".
- Offer Sent / Negotiation / Approved / Accepted -> "Offered". Accepted also creates the joining record (expected joining date, or notice-period date, flagged as estimated). Declined -> "Withdrawn".
- Joining "Joined" -> application Joined, candidate Placed, vacancy filled count updated (auto-closes when full). "Dropped" -> Withdrawn.
- Scorecard recommendation (Proceed / Reject / Hold) creates a "Decision needed" follow-up task; it does not auto-reject.
- Closing a vacancy offers to reject remaining applicants with the "position closed" email.
Changes are shown after saving ("Also done automatically") and written to the audit log.

## Email templates
Admin -> Email templates (super_admin / hr_manager). Seven defaults: shortlisted, status update, rejection (after screening / after interview), position closed, documents needed, assessment invite. `{{variables}}` are filled automatically; any `[[placeholder]]` left in a draft blocks sending. Sent mails are logged in Communications; Reply-To is the recruiter.

## Calendar invites
Interview emails carry an .ics (METHOD REQUEST, IST, 60 minutes). Re-saving with a new time sends an update to the same event; setting status Cancelled sends a cancellation. The interviewer's copy includes the scorecard link; the candidate's never does.

## Assessment results from the portal (hr.rdcc.ai)
- Receiving endpoint: `POST /api/integrations/assessment-result` with header `X-API-Key: <key>` (or `Authorization: Bearer <key>`). Generate the key in Settings -> "Assessment results from the portal" (shown once; only a hash is stored). Candidate is matched by candidate_code, email or mobile.
- The portal side must be configured to call this endpoint, which needs the tracker hosted at a reachable URL (`APP_BASE_URL`).
- Meanwhile: Assessments -> Import results accepts Excel/CSV, shows a preview, then applies.

## Bulk resume upload
Candidates -> Upload many resumes: up to 100 files (PDF/DOCX/TXT, 10 MB each), optional vacancy, source defaults to "Bulk upload". Duplicates (email/mobile) are not re-added but are still tagged to the vacancy. Scanned images are listed for manual entry.

## Fetching assessment results from the portal (pull)
Settings -> "Assessment results from the portal" -> "Or: let the tracker fetch results". Needs from the portal team: (1) the address that returns one candidate's result (use `{email}`, `{mobile}` or `{candidate_code}` in it), (2) an access key and the header name it goes in, (3) the names of the fields in the reply (score, result, report link, date, and optionally a status field).
- Every hour (at :20) the tracker looks up each assessment that is Pending/Sent (created in the last 90 days). A 404 or "not finished" means wait; once finished, the record is completed.
- "Test" shows what would happen without changing anything; "Check now and update" does it immediately. Only a Super Admin can change the settings; the access key is never shown again after saving.
- Works with the portal's reply as JSON only. The tracker server must be able to reach the portal over the internet.

## Changes in this update (latest)

### Date of birth on the candidate
New **Date of birth** on the candidate form (checked: a real date, age 14–80). The resume reader fills it when the resume says DOB / Date of Birth / Born. It appears in the candidate report (with age), the Excel exports and the consolidated report, and pre-fills the onboarding form; a date of birth entered by the candidate on that form fills the record if it was empty.

### Fixes from recruiter testing
1. **Link a vacancy when adding the candidate.** The Add Candidate form has *Vacancy applied for*; the application is created at once (no second visit to the candidate).
2. **Resume parsing improved.** Reads PDF, DOCX, TXT and old .doc (run `npm install` once — adds `word-extractor`). Understands titles (Mr./Dr.), two-line and tabular job entries, date-range experience, labelled fields, Rs. salaries, "immediate joiner", and takes the location from the contact lines. Scanned (image-only) PDFs cannot be read — the app says so; type the details or upload a text PDF. Always review the filled fields.
3. **Recruiter follows the vacancy.** Assigned recruiter is mandatory on a vacancy (a recruiter adding one is pre-selected). Every application takes its vacancy's recruiter; changing the vacancy's recruiter moves its applications; blanks in old data are back-filled at start-up.
4. **Google Meet link on the first save.** A *Video* interview creates the Meet link before the first invite, so the invite already has it. If Google Calendar is not connected (Settings → Google Calendar) the screen says so after saving.
5. **Recruiter chooses the Authorized Signatory.** Admin → Signatories keeps the list (name, designation, email, company). On *Send for approval* the recruiter picks who approves; nothing is pre-selected when there is more than one.
6. **Statuses follow each other.** Interview scheduled → application *Interview*; scorecard submitted → interview *Completed*; offer sent → *Offered*; accepted → joining created; joined → *Joined* / candidate *Placed*; rejecting or withdrawing an application cancels its upcoming interviews (with emails) and withdraws unsent offers. Each change is written to the activity history and shown after saving.
7. **Emails when the status changes.** Admin → Email templates → "Emails sent automatically": Shortlisted, Rejected and Joined are on by default (Screening is off); the recruiter is in copy; one email per application and status; wording is the editable template.
8. **Onboarding ZIP** now contains `resume/` and `assessment-report/` (Word) next to the details and documents, plus a README.txt saying what is missing.

### Several interviewers on one interview
On the Interview form use **+ Add another interviewer** (name picks the email from the directory). Each interviewer gets their own invite, the resume and a private scorecard link, and scores separately; the Scorecards page and candidate report show everyone's score. The candidate and recruiter get one invite that lists the whole panel. Date, time, Meet link, location and status are managed on the main interview and copied to the others; rescheduling or cancelling emails every panel member. A panel member who has already scored cannot be removed.

### Reason for adding a vacancy
New mandatory **Reason for adding this vacancy** (New Position, Replacement, Additional Headcount, Backfill, Other) plus **Reason details** (e.g. who is being replaced). Available as report columns. Older vacancies stay blank.

### Dashboard logos
The RDC, Ultrafine and ROBO logos now sit at the right of the dashboard header.

### TAT now starts from "Date received"
Vacancy TAT, the dashboard time-to-close tiles, the "open for more than N days" alert and the Excel TAT column are all counted from the vacancy's **Date received** (falls back to the entry date if empty), to its first closure (or today if still open). Never negative.

### Master lists (Admin → Master lists)
Super Admin and HR Manager can add, edit, hide, delete and bulk-import (Excel/CSV) four lists: **Plant locations**, **Vacancy raised by**, **Interview locations** (name + full address) and **Interviewers**.
- The forms suggest these values as you type (Vacancy location and raised-by, Interview location, Joining location). Suggestions are not enforced; free text is still accepted.
- Picking an interview location puts its full address into the interview invite.
- Renaming or hiding an entry never rewrites old records.
- Only an admin can now add or edit Interviewers; recruiters can still pick them.
- First start fills the lists from existing data once.

- **Concise candidate report:** the individual report (Word and Print/PDF) is now a one-page summary: header with status, summary tiles (experience, CTCs, notice, JD match, interview average), contact and background, a stage strip with who the candidate is pending with, one interview table (average, verdict, Hire as) with parameter averages and strengths/concerns, assessments, and offer and joining. Empty items are left out. The consolidated Excel is unchanged.
- **Dashboard:** every section is now a grid of equal-sized clickable tiles (no wide bars or panels).
- **Name:** now "RDC's Recruitment Management System" everywhere.
- **Interviewer gets the resume + hire type:** the interviewer's invite email and scorecard email carry the candidate's current resume as an attachment (the candidate's own copy never does), and the scorecard page has a *Download resume* button that works only with the interviewer's private link. The scorecard now asks for **Hire as**: On Roll / Off Roll / Fixed Term Contract / Retainer Contract, next to Proceed / Hold / Reject. It shows on the interview, the Scorecards comparison, the recruiter's notification email and both Excel/Word reports.
- **Email look:** every email (interview, offer, reminders, weekly tracker, approvals, onboarding) is wrapped in one design in `mailer.js` — Calibri (Carlito/Arial fallback), RDC steel-blue header with the hi-vis accent, white card, footer, plus a plain-text version. Change the look in one place (`wrapEmail`).
- **Your own offer letter:** in an Offer, *Upload your own letter* (PDF, Word, image, 10 MB) and *Send this letter to candidate*. It goes to the candidate, the recruiter and the additional recipients with the onboarding link, and the offer becomes Sent. No signatory approval is needed for this route. Files are stored in `uploads/offer-letters/` (not publicly served).
- **Onboarding form (replaces the Google form):** a private link per candidate (30 days, no login) is created and put into the appointment-letter email automatically (or send it from **Onboarding → Send form to a candidate** / the Joining record). The candidate fills personal, contact, address, PAN/Aadhaar/UAN/ESIC, bank, education, previous employment and nominee details, uploads documents (photo, PAN, Aadhaar, 10th, last qualification, cancelled cheque, resignation, experience letters; PDF/JPG/PNG up to 8 MB, checked by content), saves a draft and submits. Formats are validated (PAN, Aadhaar, IFSC, mobile, PIN). HR reviews on the **Onboarding** page, marks it Verified, or downloads a ZIP (JSON + Excel + documents).
- **HRMS hand-over:** Settings → *HRMS hand-over*: the HRMS address, sign-in (none / bearer / header key / basic) and how documents travel (inside the JSON, as multipart files, or none). When a Joining record is **Joined with an actual date** and the form is submitted, the details and documents are POSTed to the HRMS automatically; if the form isn't in yet, it goes the moment it is submitted. A failure is shown on the record and retried every hour (5 tries); *Send to HRMS now* retries by hand; a record already sent is locked (no duplicates). Option: wait for HR to verify first. The payload format is documented in that Settings panel; if your HRMS needs other field names, give us its import format and we match it.
- **Privacy note:** the onboarding form collects Aadhaar, PAN and bank details. They are stored in the app's database and `uploads/onboarding/` on the server, readable only by signed-in HR/recruiter users. Host it on a protected server, restrict who gets recruiter access, and take regular backups. Keep this under your DPDP-Act data-protection policy.

## Earlier changes
- **Name:** the application is now the "RDC's Recruitment Management System" (screens, emails, calendar invites).
- **Scorecard:** new parameters Learnability, Energy and Enthusiasm, Selling Skills (shown only when the vacancy or its JD is a sales role: sales / business development / business manager / marketing) and Overall (the interviewer's own impression). The computed score is now called **Average** and is worked out from all scored parameters except "Overall" (it is used only if nothing else is scored).
- **Weekly email:** new "Candidates in Pipeline" table with who each is pending with (recruiter, interviewer, hiring manager, Authorized signatory, candidate); Recruiter column on the vacancies table; Type of Employment (the vacancy's job type) on Upcoming Joinings.
- **Reports:** candidate record -> Download Word / Print-PDF; Candidates page and Admin -> Reports -> Consolidated candidate report (Excel: candidates, interview scores, assessments; filter by vacancy, company, dates).
- **Offer approval and e-signature:** set the Authorized signatory email on Companies (RDC is pre-filled with ksbhoon@rdc.in, please verify). On an offer press *Send for approval*; the signatory gets a private link (7 days), reviews the offer, and approves + signs (drawn or typed name) or requests changes. On approval the offer becomes Approved, the signature and an approval stamp (name, time IST, reference) are placed on the appointment letter, and the letter is emailed to the candidate. Only a Super Admin can mark an offer Approved by hand. Name, time, IP address and a fingerprint of the figures are kept. This is an electronic signature with an audit trail, not a Class 3 DSC / Aadhaar eSign. Needs APP_BASE_URL set to an address the signatory can open.
- **Dashboard:** every tile opens its tab (pre-filtered where it applies); tables became tiles: pipeline stages, "pending with", TAT by company / recruiter / location, long-open vacancies, follow-ups, recent applications.
