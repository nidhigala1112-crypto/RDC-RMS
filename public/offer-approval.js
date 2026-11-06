// Authorized Signatory's page: review the offer, then approve + sign, or ask for changes. Opened from a secret link.
(function () {
  const token = location.pathname.split('/').filter(Boolean).pop();
  const root = document.getElementById('root');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (d) => { if (!d) return ''; const x = new Date(String(d).replace(' ', 'T') + (String(d).includes('T') ? '' : 'Z')); return isNaN(x) ? d : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
  const msg = (title, text) => { root.innerHTML = `<div class="sc-card sc-msg"><h1>${esc(title)}</h1><p class="sc-meta">${esc(text)}</p></div>`; };

  function render(d) {
    if (d.state !== 'pending') {
      return msg(d.state === 'approved' ? 'Already approved' : d.state === 'changes' ? 'Changes were requested' : 'This offer is closed',
        d.state === 'approved' ? `Approved and signed by ${d.decided_by || 'the signatory'}${d.decided_at ? ' on ' + fmt(d.decided_at) : ''}. Thank you.` : d.state === 'changes' ? `The recruiter has been told${d.note ? ': ' + d.note : ''}.` : 'Nothing more to do here.');
    }
    if (d.expired) return msg('This link has expired', 'Ask the recruiter to send the offer for approval again.');
    root.innerHTML = `
      <div class="sc-card">
        <h1>${esc(d.candidate || 'Candidate')}</h1>
        <div class="sc-meta"><strong>${esc(d.position || '')}</strong>${d.company ? ' · ' + esc(d.company) : ''}</div>
        <div class="sc-meta" style="margin-top:4px">${d.requested_by ? 'Requested by ' + esc(d.requested_by) : ''}${d.requested_at ? ' · ' + esc(fmt(d.requested_at)) : ''}</div>
        <table class="oa-table">${d.rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td><strong>${esc(v)}</strong></td></tr>`).join('')}</table>
        <a href="/api/public/offer-approval/${token}/letter" style="font-size:13.5px">Read the appointment letter (Word) ↓</a>
      </div>
      <div class="sc-card">
        <div class="sc-section-title">Approve and sign</div>
        <label class="sc-label" for="oa-name">Your full name</label>
        <input type="text" id="oa-name" value="${esc(d.signatory || '')}" autocomplete="name">
        <label class="sc-label">Your signature <span class="sc-meta" style="font-weight:400">(draw with mouse or finger — optional, your typed name is used if left blank)</span></label>
        <canvas id="oa-pad" class="oa-pad" width="600" height="150"></canvas>
        <button type="button" class="btn btn-ghost btn-sm" id="oa-clear" style="margin-top:6px">Clear signature</button>
        <label style="display:flex; gap:10px; align-items:flex-start; margin-top:14px; font-size:14px; cursor:pointer"><input type="checkbox" id="oa-consent" style="margin-top:3px">
          <span>I have reviewed this offer and approve it. I understand that my typed name${'' } and signature will be applied electronically to the appointment letter, and that the time and my device details are recorded.</span></label>
        <div id="oa-err" class="login-error" hidden style="margin-top:12px"></div>
        <div class="oa-actions"><button type="button" class="btn btn-primary" id="oa-approve">Approve and sign</button></div>
      </div>
      <div class="sc-card">
        <div class="sc-section-title">Need something changed?</div>
        <textarea id="oa-note" maxlength="1500" placeholder="Tell the recruiter what should change (CTC, joining date, designation…)"></textarea>
        <div class="oa-actions"><button type="button" class="btn btn-ghost" id="oa-changes">Request changes</button></div>
      </div>
      <div class="sc-foot">This link is private to you and valid until ${esc(fmt(d.expires_at))}. ${d.designation ? esc(d.designation) : ''}</div>`;

    // signature pad
    const cv = document.getElementById('oa-pad'); const ctx = cv.getContext('2d');
    ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#10244A';
    let drawing = false; let inked = false;
    const pos = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height]; };
    cv.addEventListener('pointerdown', (e) => { drawing = true; cv.setPointerCapture(e.pointerId); const [x, y] = pos(e); ctx.beginPath(); ctx.moveTo(x, y); });
    cv.addEventListener('pointermove', (e) => { if (!drawing) return; const [x, y] = pos(e); ctx.lineTo(x, y); ctx.stroke(); inked = true; });
    ['pointerup', 'pointercancel'].forEach((ev) => cv.addEventListener(ev, () => { drawing = false; }));
    document.getElementById('oa-clear').addEventListener('click', () => { ctx.clearRect(0, 0, cv.width, cv.height); inked = false; });

    const send = async (body, btn, label) => {
      const err = document.getElementById('oa-err'); err.hidden = true; btn.disabled = true; btn.textContent = 'Please wait…';
      try {
        const res = await fetch('/api/public/offer-approval/' + token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error || 'Something went wrong — please try again.');
        msg(body.decision === 'approve' ? 'Approved — thank you' : 'Thank you — the recruiter has been told', body.decision === 'approve' ? 'The appointment letter with your signature is being sent to the candidate. The recruiter has been informed.' : 'They will update the offer and send it to you again.');
      } catch (e) { err.textContent = e.message; err.hidden = false; btn.disabled = false; btn.textContent = label; }
    };
    document.getElementById('oa-approve').addEventListener('click', (e) => send({ decision: 'approve', name: document.getElementById('oa-name').value, consent: document.getElementById('oa-consent').checked, signature: inked ? cv.toDataURL('image/png') : null }, e.currentTarget, 'Approve and sign'));
    document.getElementById('oa-changes').addEventListener('click', (e) => send({ decision: 'changes', name: document.getElementById('oa-name').value, note: document.getElementById('oa-note').value }, e.currentTarget, 'Request changes'));
  }

  (async () => {
    try {
      const res = await fetch('/api/public/offer-approval/' + token); const d = await res.json().catch(() => ({}));
      if (!res.ok) return msg(res.status === 410 ? 'This link has expired' : "This link isn't valid", d.error || 'Please ask the recruiter for a new link.');
      render(d);
    } catch { msg("Couldn't load the offer", 'Check your connection and try again.'); }
  })();
})();
