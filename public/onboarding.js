// Candidate's onboarding form — opened from a private link, no login.
(function () {
  const token = location.pathname.split('/').filter(Boolean).pop();
  const root = document.getElementById('root');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (d) => { if (!d) return ''; const x = new Date(d); return isNaN(x) ? d : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }); };
  const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  let D = null; let values = {}; let declaration = false; let docs = []; let errors = {};

  const msg = (title, text) => { root.innerHTML = `<div class="ob-card ob-msg"><h1>${esc(title)}</h1><p class="ob-meta">${esc(text)}</p></div>`; };

  function fieldHtml(f) {
    const v = values[f.key];
    const bad = errors[f.key] ? ' bad' : '';
    const req = f.required ? ' <span class="req">*</span>' : '';
    const dis = D.locked ? ' disabled' : '';
    if (f.type === 'checkbox') return `<div class="ob-f wide"><label class="ob-check"><input type="checkbox" data-k="${f.key}" ${v ? 'checked' : ''}${dis}> ${esc(f.label)}</label></div>`;
    let input;
    if (f.type === 'select') input = `<select data-k="${f.key}"${dis}><option value="">Select…</option>${f.options.map((o) => `<option ${v === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    else if (f.type === 'textarea') input = `<textarea data-k="${f.key}" maxlength="500"${dis}>${esc(v)}</textarea>`;
    else input = `<input data-k="${f.key}" type="${f.type === 'date' ? 'date' : f.type === 'email' ? 'email' : 'text'}" ${f.type === 'tel' ? 'inputmode="numeric" maxlength="13"' : ''} value="${esc(v)}" autocomplete="off"${dis}>`;
    return `<label class="ob-f${f.type === 'textarea' ? ' wide' : ''}${bad}" data-wrap="${f.key}"><span>${esc(f.label)}${req}</span>${input}${f.hint ? `<span class="ob-hint">${esc(f.hint)}</span>` : ''}${errors[f.key] ? `<span class="ob-err">${esc(errors[f.key])}</span>` : ''}</label>`;
  }

  function docHtml(t) {
    const mine = docs.filter((d) => d.doc_type === t.key);
    const bad = errors['doc_' + t.key];
    return `<div class="ob-doc" data-doc="${t.key}">
      <div class="ob-doc-top"><div><div class="ob-doc-name">${esc(t.label)}${t.required ? ' <span class="req" style="color:#C93C37">*</span>' : ''}</div>${bad ? `<div class="ob-err">${esc(bad)}</div>` : ''}</div>
      ${D.locked || mine.length >= D.max_per_type ? '' : `<span><input type="file" hidden data-up="${t.key}" accept=".pdf,.jpg,.jpeg,.png"><button type="button" class="btn btn-ghost btn-sm" data-pick="${t.key}">${mine.length ? 'Add another' : 'Upload'}</button></span>`}</div>
      <div class="ob-files">${mine.map((d) => `<div class="ob-file">✓ ${esc(d.file_name)} <span class="ob-hint">${fmtSize(d.file_size)}</span>${D.locked ? '' : `<button type="button" data-rm="${d.id}">Remove</button>`}</div>`).join('')}</div>
    </div>`;
  }

  const visible = (f) => !(f.unless && values[f.unless]);

  function progress() {
    const req = D.sections.flatMap((s) => s.fields).filter((f) => f.required && f.type !== 'checkbox' && visible(f));
    const done = req.filter((f) => values[f.key]).length;
    const reqDocs = D.doc_types.filter((t) => t.required);
    const docDone = reqDocs.filter((t) => docs.some((d) => d.doc_type === t.key)).length;
    const total = req.length + reqDocs.length;
    return total ? Math.round(((done + docDone) / total) * 100) : 0;
  }

  function render(keepScroll) {
    const y = window.scrollY;
    const sections = D.sections.map((s) => `<div class="ob-card"><h2>${esc(s.title)}</h2>${s.note ? `<p class="ob-note">${esc(s.note)}</p>` : ''}<div class="ob-grid">${s.fields.filter(visible).map(fieldHtml).join('')}</div></div>`).join('');
    const banner = D.locked ? '<div class="ob-banner ok">HR has verified your details, so this form is now locked. If something needs correcting, please contact HR.</div>'
      : D.submitted_at ? `<div class="ob-banner ok">You submitted this form on ${esc(fmtDate(D.submitted_at))}. You can still change anything below and submit again until HR verifies it.</div>`
      : '<div class="ob-banner info">Fill this in at your own pace — use <strong>Save & continue later</strong> and come back to the same link. Fields marked <span style="color:#C93C37">*</span> are required.</div>';
    const errCount = Object.keys(errors).length;
    root.innerHTML = `
      <div class="ob-card">
        <h1>Welcome, ${esc((D.candidate || '').split(' ')[0] || 'there')}</h1>
        <div class="ob-meta"><strong>${esc(D.position)}</strong>${D.company ? ' · ' + esc(D.company) : ''}${D.location ? ' · ' + esc(D.location) : ''}</div>
        ${D.joining_date ? `<div class="ob-meta" style="margin-top:4px">Date of joining: <strong>${esc(fmtDate(D.joining_date))}</strong></div>` : ''}
        <div class="ob-prog"><div id="prog" style="width:${progress()}%"></div></div>
      </div>
      ${banner}
      ${errCount ? `<div class="ob-banner bad">Please fix the ${errCount} highlighted item${errCount > 1 ? 's' : ''} below, then submit again.</div>` : ''}
      ${sections}
      <div class="ob-card"><h2>Documents</h2><p class="ob-note">PDF, JPG or PNG, up to 8 MB each. A clear phone photo is fine.</p>${D.doc_types.map(docHtml).join('')}</div>
      <div class="ob-card ${errors.declaration ? '' : ''}"><label class="ob-check"><input type="checkbox" id="decl" ${declaration ? 'checked' : ''}${D.locked ? ' disabled' : ''}> I declare that the information and documents provided are true and correct, and I understand that any false information can lead to cancellation of my appointment.</label>${errors.declaration ? `<div class="ob-err" style="margin-top:6px">${esc(errors.declaration)}</div>` : ''}</div>
      ${D.locked ? '' : `<div class="ob-bar"><button type="button" class="btn btn-ghost" id="save">Save & continue later</button><button type="button" class="btn btn-primary" id="submit">Submit form</button></div>`}
      <div class="ob-meta" style="text-align:center; margin-top:10px; font-size:12.5px">This link is private to you and works until ${esc(fmtDate(D.expires_at))}. Your details are used only for your employment records.</div>`;
    bind();
    if (keepScroll) window.scrollTo(0, y);
  }

  function collect() {
    root.querySelectorAll('[data-k]').forEach((el) => { values[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; });
    const d = document.getElementById('decl'); if (d) declaration = d.checked;
  }
  const api = async (method, url, body) => {
    const r = await fetch(url, { method, headers: body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(out.error || 'Something went wrong — please try again.'); e.errors = out.errors; throw e; }
    return out;
  };

  function toast(text, bad) {
    const t = document.createElement('div');
    t.textContent = text; t.style.cssText = `position:fixed;left:50%;bottom:84px;transform:translateX(-50%);background:${bad ? '#A8302B' : '#1E3A52'};color:#fff;padding:10px 18px;border-radius:8px;z-index:50;font-size:14px;max-width:90%`;
    document.body.appendChild(t); setTimeout(() => t.remove(), 3500);
  }

  function bind() {
    root.querySelectorAll('[data-k]').forEach((el) => el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
      collect();
      if (el.dataset.k === 'same_address') render(true);
      else { const p = document.getElementById('prog'); if (p) p.style.width = progress() + '%'; }
    }));
    root.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => root.querySelector(`[data-up="${b.dataset.pick}"]`).click()));
    root.querySelectorAll('[data-up]').forEach((inp) => inp.addEventListener('change', async () => {
      const f = inp.files[0]; if (!f) return; collect();
      const fd = new FormData(); fd.append('file', f);
      try { const out = await api('POST', `/api/public/onboarding/${token}/docs/${inp.dataset.up}`, fd); docs = out.docs; delete errors['doc_' + inp.dataset.up]; render(true); toast('Uploaded.'); }
      catch (e) { toast(e.message, true); }
    }));
    root.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', async () => {
      collect();
      try { const out = await api('DELETE', `/api/public/onboarding/${token}/docs/${b.dataset.rm}`); docs = out.docs; render(true); } catch (e) { toast(e.message, true); }
    }));
    const save = document.getElementById('save');
    if (save) save.addEventListener('click', async () => {
      collect(); save.disabled = true; save.textContent = 'Saving…';
      try { await api('PUT', `/api/public/onboarding/${token}`, { values, declaration }); toast('Saved. You can close this page and return to the same link any time.'); }
      catch (e) { toast(e.message, true); }
      save.disabled = false; save.textContent = 'Save & continue later';
    });
    const sub = document.getElementById('submit');
    if (sub) sub.addEventListener('click', async () => {
      collect(); sub.disabled = true; sub.textContent = 'Submitting…';
      try {
        await api('POST', `/api/public/onboarding/${token}/submit`, { values, declaration });
        msg('Thank you!', 'Your onboarding form and documents have been received. HR will review them — there is nothing more you need to do here. You can reopen this link to change anything until HR verifies it.');
        const b = document.createElement('button'); b.className = 'btn btn-ghost'; b.style.marginTop = '14px'; b.textContent = 'View / change my answers';
        b.onclick = () => { errors = {}; load(); }; root.firstElementChild.appendChild(b);
      } catch (e) {
        errors = e.errors || {}; sub.disabled = false; sub.textContent = 'Submit form';
        if (!e.errors) toast(e.message, true);
        else { render(); const first = root.querySelector('.ob-f.bad, .ob-err'); if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      }
    });
  }

  async function load() {
    try {
      const r = await fetch('/api/public/onboarding/' + token);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return msg(r.status === 410 ? 'This link has expired' : "This link isn't valid", d.error || 'Please ask HR for a new link.');
      D = d; values = { ...d.values }; declaration = !!d.declaration; docs = d.docs || []; render();
    } catch { msg("Couldn't load the form", 'Check your connection and try again.'); }
  }
  load();
})();
