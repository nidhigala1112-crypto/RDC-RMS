// Interviewer's scorecard page — opened from a secret link, no login.
(function () {
  const token = location.pathname.split('/').filter(Boolean).pop();
  const root = document.getElementById('root');
  const CRITERIA = [
    ['knowledge', 'Role knowledge & skills', 'Depth of technical or functional knowledge for the role'],
    ['experience', 'Relevant experience', 'How well their past work matches what the role needs'],
    ['problem_solving', 'Problem solving', 'How they approach and structure problems'],
    ['communication', 'Communication', 'Clarity, listening and how they present themselves'],
    ['leadership', 'Leadership & team handling', 'Managing people, ownership, influencing others'],
    ['culture', 'Attitude & culture fit', 'Motivation, values, openness to feedback'],
    ['learnability', 'Learnability', 'How quickly they pick up new things and respond to feedback'],
    ['energy', 'Energy and Enthusiasm', 'Drive, positivity and interest in the role'],
    ['selling', 'Selling Skills', 'Prospecting, negotiation and closing ability (sales candidates only)', true],
    ['overall', 'Overall', 'Your overall impression of the candidate']
  ];
  const WORDS = { 1: 'Poor', 2: 'Below par', 3: 'Meets the bar', 4: 'Strong', 5: 'Outstanding' };
  let state = { scores: {}, recommendation: '', hire_type: '' };
  const HIRE_TYPES = ['On Roll', 'Off Roll', 'Fixed Term Contract', 'Retainer Contract'];

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (d) => { if (!d) return ''; const x = new Date(d); return isNaN(x) ? d : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
  const avg = () => { const v = Object.values(state.scores); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null; };

  function showMessage(title, text) {
    root.innerHTML = `<div class="sc-card sc-msg"><h1>${esc(title)}</h1><p class="sc-meta">${esc(text)}</p></div>`;
  }

  function render(d) {
    state = { scores: { ...(d.scorecard.scores || {}) }, recommendation: d.recommendation || '', hire_type: d.hire_type || '' };
    root.innerHTML = `
      <div class="sc-card">
        <h1>${esc(d.candidate || 'Candidate')}</h1>
        <div class="sc-meta"><strong>${esc(d.vacancy)}</strong>${d.company ? ' · ' + esc(d.company) : ''}</div>
        <div class="sc-meta" style="margin-top:4px">Round ${esc(d.round)}${d.scheduled_date ? ' · ' + esc(fmtDate(d.scheduled_date)) : ''}${d.interviewer ? ' · Interviewer: ' + esc(d.interviewer) : ''}</div>
        ${d.resume_name ? `<div style="margin-top:12px"><a class="btn btn-ghost" id="resume-link" href="/api/public/scorecard/${token}/resume" download>📄 Download resume — ${esc(d.resume_name)}</a></div>` : '<div class="sc-meta" style="margin-top:8px">No resume is on file for this candidate.</div>'}
      </div>
      ${d.submitted_at ? `<div class="sc-note">You already submitted this scorecard. You can change your answers and submit again until the link expires on ${esc(fmtDate(d.expires_at))}.</div>` : ''}
      <div class="sc-card">
        <div class="sc-section-title">How did the candidate do?</div>
        <div class="sc-scale">Score each from 1 (poor) to 5 (outstanding). Skip anything that didn't come up. Tap a selected score again to clear it.</div>
        ${CRITERIA.filter((c) => !c[3] || d.is_sales).map(([k, name, hint]) => `
          <div class="sc-crit"><div class="sc-crit-top">
            <div><div class="sc-crit-name">${name}</div><div class="sc-crit-hint">${hint}</div></div>
            <div class="sc-btns" data-crit="${k}">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="sc-btn${state.scores[k] === n ? ' on' : ''}" data-score="${n}" title="${WORDS[n]}" aria-label="${name}: ${n} – ${WORDS[n]}">${n}</button>`).join('')}</div>
          </div></div>`).join('')}
        <div class="sc-overall-line"><span class="sc-meta">Average</span><span><strong id="overall">—</strong> / 5</span></div>
      </div>
      <div class="sc-card">
        <div class="sc-section-title">Your recommendation</div>
        <div class="sc-reco" id="reco">${['Proceed', 'Hold', 'Reject'].map((v) => `<button type="button" data-v="${v}" class="${state.recommendation === v ? 'on' : ''}">${v}</button>`).join('')}</div>
        <div class="sc-section-title" style="margin-top:18px">Hire as</div>
        <div class="sc-scale">If you recommend hiring, what kind of engagement should it be?</div>
        <div class="sc-reco" id="hire">${HIRE_TYPES.map((v) => `<button type="button" data-v="${v}" class="${state.hire_type === v ? 'on' : ''}">${v}</button>`).join('')}</div>
        <label class="sc-label" for="strengths">Strengths</label>
        <textarea id="strengths" maxlength="2000" placeholder="What stood out positively?">${esc(d.scorecard.strengths)}</textarea>
        <label class="sc-label" for="concerns">Concerns</label>
        <textarea id="concerns" maxlength="2000" placeholder="Anything that worries you, or needs checking?">${esc(d.scorecard.concerns)}</textarea>
        <label class="sc-label" for="feedback">Other comments <span class="sc-meta" style="font-weight:400">(optional)</span></label>
        <textarea id="feedback" maxlength="5000">${esc(d.feedback)}</textarea>
        <div id="err" class="login-error" hidden style="margin-top:14px"></div>
        <button type="button" id="submit" class="btn btn-primary btn-block" style="margin-top:16px; padding:13px; font-size:15px">Submit scorecard</button>
      </div>
      <div class="sc-foot">This link is private to you and expires on ${esc(fmtDate(d.expires_at))}.</div>`;

    const refresh = () => { const a = avg(); document.getElementById('overall').textContent = a === null ? '—' : a.toFixed(1); };
    refresh();
    root.querySelectorAll('.sc-btns').forEach((row) => row.querySelectorAll('.sc-btn').forEach((b) => b.addEventListener('click', () => {
      const k = row.dataset.crit, n = parseInt(b.dataset.score, 10);
      if (state.scores[k] === n) delete state.scores[k]; else state.scores[k] = n;
      row.querySelectorAll('.sc-btn').forEach((x) => x.classList.toggle('on', parseInt(x.dataset.score, 10) === state.scores[k]));
      refresh();
    })));
    root.querySelectorAll('#reco button').forEach((b) => b.addEventListener('click', () => {
      state.recommendation = state.recommendation === b.dataset.v ? '' : b.dataset.v;
      root.querySelectorAll('#reco button').forEach((x) => x.classList.toggle('on', x.dataset.v === state.recommendation));
    }));
    root.querySelectorAll('#hire button').forEach((b) => b.addEventListener('click', () => {
      state.hire_type = state.hire_type === b.dataset.v ? '' : b.dataset.v;
      root.querySelectorAll('#hire button').forEach((x) => x.classList.toggle('on', x.dataset.v === state.hire_type));
    }));
    document.getElementById('submit').addEventListener('click', async () => {
      const err = document.getElementById('err'); err.hidden = true;
      const btn = document.getElementById('submit'); btn.disabled = true; btn.textContent = 'Submitting…';
      try {
        const res = await fetch('/api/public/scorecard/' + token, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scores: state.scores, recommendation: state.recommendation, hire_type: state.hire_type,
            strengths: document.getElementById('strengths').value, concerns: document.getElementById('concerns').value,
            feedback: document.getElementById('feedback').value
          })
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error || 'Something went wrong — please try again.');
        root.innerHTML = `<div class="sc-card sc-msg"><h1>Thank you${d.interviewer ? ', ' + esc(d.interviewer.split(' ')[0]) : ''}</h1>
          <p class="sc-meta">Your scorecard for <strong>${esc(d.candidate)}</strong> has been recorded${out.rating ? ` (average ${Number(out.rating).toFixed(1)} / 5)` : ''}. The recruiter has been told.</p>
          <button type="button" id="edit" class="btn btn-ghost" style="margin-top:14px">Change my answers</button></div>`;
        document.getElementById('edit').addEventListener('click', load);
      } catch (e) {
        err.textContent = e.message; err.hidden = false; btn.disabled = false; btn.textContent = 'Submit scorecard';
      }
    });
  }

  async function load() {
    try {
      const res = await fetch('/api/public/scorecard/' + token);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) return showMessage(res.status === 410 ? 'This link has expired' : 'This link isn\'t valid', d.error || 'Please ask the recruiter for a new link.');
      render(d);
    } catch (e) { showMessage('Couldn\'t load the scorecard', 'Check your connection and try again.'); }
  }
  load();
})();
