/**
 * A small modal form builder shared by every admin screen.
 *
 *   openForm({
 *     title: 'Edit Movie',
 *     fields: [{ key, label, type, options, hint, required, ... }],
 *     values: { key: value },
 *     onSave: async (data) => { ... }        // throw to keep the modal open
 *   })
 *
 * Field types: text, textarea, number, date, datetime-local, password,
 *              select (options: [[value, label], ...]), checkbox, image.
 */

function openForm({ title, fields, values = {}, saveLabel = 'Save', onSave }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const inputFor = (f) => {
    const v = values[f.key] ?? f.default ?? '';
    const id = 'f_' + f.key;

    switch (f.type) {
      case 'textarea':
        return `<textarea id="${id}" rows="${f.rows || 3}" placeholder="${esc(f.placeholder || '')}">${esc(v)}</textarea>`;
      case 'select':
        return `<select id="${id}">${f.options.map(([val, lab]) =>
          `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>`;
      case 'checkbox':
        return `<label style="display:flex;gap:8px;align-items:center;color:var(--text);margin:0">
                  <input type="checkbox" id="${id}" ${v ? 'checked' : ''} style="width:auto">
                  <span>${esc(f.checkboxLabel || 'Yes')}</span></label>`;
      case 'image':
        return `
          <div class="img-pick">
            <div class="img-prev" id="${id}_prev" style="${v ? posterStyle(v) : ''}">${v ? '' : 'No image'}</div>
            <div class="fields">
              <input type="file" id="${id}_file" accept="image/png,image/jpeg,image/webp,image/gif">
              <div class="hint">Upload a PNG, JPG, WEBP or GIF (max 5 MB).</div>
              <input id="${id}" value="${esc(v)}" placeholder="/uploads/... or https://... or #1f3a5f,#5b8fb9" style="margin-top:10px">
              <div class="hint">Or paste an image URL, or two hex colours for a gradient placeholder.</div>
            </div>
          </div>`;
      default:
        return `<input type="${f.type || 'text'}" id="${id}" value="${esc(v)}"
                       placeholder="${esc(f.placeholder || '')}" ${f.step ? `step="${f.step}"` : ''}>`;
    }
  };

  backdrop.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <h3>${esc(title)}</h3>
        <button class="x-close" data-close title="Close">&times;</button>
      </div>
      <div class="modal-body">
        ${fields.map((f) => f.type === 'group'
          ? `<h3 style="margin:18px 0 10px;color:var(--brand);font-size:13px;letter-spacing:.6px;text-transform:uppercase">${esc(f.label)}</h3>`
          : `<div class="field" style="${f.width ? `max-width:${f.width}` : ''}">
               ${f.type === 'checkbox' ? '' : `<label>${esc(f.label)}${f.required ? ' *' : ''}</label>`}
               ${inputFor(f)}
               ${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}
             </div>`).join('')}
      </div>
      <div class="modal-foot">
        <button class="btn ghost" data-close>Cancel</button>
        <button class="btn" data-save>${esc(saveLabel)}</button>
      </div>
    </div>`;

  document.body.appendChild(backdrop);

  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  $$('[data-close]', backdrop).forEach((b) => b.addEventListener('click', close));

  /* live preview + upload for image fields */
  for (const f of fields.filter((x) => x.type === 'image')) {
    const url = $('#f_' + f.key, backdrop);
    const prev = $(`#f_${f.key}_prev`, backdrop);
    const file = $(`#f_${f.key}_file`, backdrop);

    const refresh = () => {
      prev.style.cssText = url.value ? posterStyle(url.value) : '';
      prev.textContent = url.value ? '' : 'No image';
    };
    url.addEventListener('input', refresh);

    file.addEventListener('change', async () => {
      const picked = file.files[0];
      if (!picked) return;
      if (picked.size > 5 * 1024 * 1024) { toast('Image is larger than 5 MB', 'err'); file.value = ''; return; }

      prev.textContent = 'Uploading...';
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Could not read that file'));
          reader.readAsDataURL(picked);
        });
        const r = await api('/api/admin/uploads', { method: 'POST', body: { data: dataUrl } });
        url.value = r.url;
        refresh();
        toast('Image uploaded', 'ok');
      } catch (err) {
        toast(err.message, 'err');
        refresh();
      }
      file.value = '';
    });
  }

  /* collect + save */
  const saveBtn = $('[data-save]', backdrop);
  saveBtn.addEventListener('click', async () => {
    const data = {};
    for (const f of fields) {
      if (f.type === 'group') continue;
      const el = $('#f_' + f.key, backdrop);
      data[f.key] = f.type === 'checkbox' ? el.checked
        : f.type === 'number' ? (el.value === '' ? null : Number(el.value))
        : el.value.trim();
      if (f.required && !data[f.key]) { toast(`${f.label} is required`, 'err'); el.focus(); return; }
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
      await onSave(data);
      close();
    } catch (err) {
      toast(err.message, 'err');
      saveBtn.disabled = false;
      saveBtn.textContent = saveLabel;
    }
  });

  const first = $('.modal-body input, .modal-body textarea, .modal-body select', backdrop);
  first?.focus();
}

/** Destructive actions all go through the styled dialog in app.js. */
const confirmAction = (message, title = 'Are you sure?') =>
  confirmDialog({ title, message, confirmLabel: 'Yes, continue' });
