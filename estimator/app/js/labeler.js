/* Photo labelling editor: draw, move, resize and caption damage boxes. Works with AI-generated labels too. */
(function () {
  'use strict';
  const C = window.Core;
  const COLOURS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#2d8ae0', '#af52de', '#ffffff'];
  const QUICK = ['Scratch', 'Scuff', 'Scoring', 'Paint transfer', 'Dent', 'Crease', 'Deformation', 'Crack', 'Broken', 'Misaligned', 'Deflated tyre', 'Kerbed wheel', 'Gap / flush'];
  const DEFAULT_COLOUR = '#ff3b30';
  // the label colour, validated as the report does it
  const colourOf = (l) => (window.Report && window.Report.safeColour ? window.Report.safeColour(l.colour, DEFAULT_COLOUR) : DEFAULT_COLOUR);
  // tag text: #fff or #111, whichever contrasts more with the label colour (the report's rule: yellow, white and orange get dark text)
  function inkFor(bg) {
    let h = bg.slice(1);
    if (h.length <= 4) h = h.split('').map((x) => x + x).join('');
    const lin = [0, 2, 4].map((i) => { const c = parseInt(h.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
    const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    return 1.05 / (L + 0.05) >= (L + 0.05) / 0.0556 ? '#fff' : '#111';
  }

  // onSave(labels, origins): origins[k] is the label that labels[k] was copied from when the editor opened (null for a new box),
  // so the app can keep labels that arrived meanwhile (a photo analysis finishing while the editor is open).
  function open(photo, onSave, openModal, closeModal) {
    const origin = new WeakMap();
    let labels = (Array.isArray(photo.labels) ? photo.labels : []).filter((l) => l && typeof l === 'object').map((l) => { const c = C.clone(l); origin.set(c, l); return c; });
    const start = JSON.stringify(labels);
    const dirty = () => JSON.stringify(labels) !== start;
    let sel = labels.length ? 0 : -1;

    const body = document.createElement('div');
    body.innerHTML = `
      <div class="lab">
        <div><div class="labStage" style="display:inline-block"><img src="${C.esc(photo.dataUrl)}" alt=""></div>
          <p class="hint">Drag on the photo to draw a box. Drag a box to move it; drag its corner to resize. Delete removes the selected box.</p></div>
        <div>
          <div class="row" style="margin-bottom:8px"><b class="grow">Labels</b><button class="btn sm danger" data-act="clear">Clear all</button></div>
          <div class="lablist"></div>
          <div class="hint" style="margin:8px 0 4px">Quick labels (apply to selected box)</div>
          <div class="row" style="gap:4px" data-quick>${QUICK.map((q) => `<button class="btn sm" data-q="${q}">${q}</button>`).join('')}</div>
          <div class="row" style="margin-top:14px"><button class="btn primary grow" data-act="save">Save labels</button><button class="btn" data-act="cancel">Cancel</button></div>
        </div>
      </div>`;
    // refused while another window is open; with unsaved boxes, closing it (×, backdrop, Back) asks first
    if (!openModal('Label damage — ' + (photo.title || 'photograph'), body, { isDirty: dirty })) return;
    const stage = body.querySelector('.labStage');
    const list = body.querySelector('.lablist');

    function draw() {
      stage.querySelectorAll('.bx').forEach((n) => n.remove());
      labels.forEach((l, i) => {
        const d = document.createElement('div');
        d.className = 'bx' + (i === sel ? ' sel' : '');
        d.dataset.i = i;
        const col = colourOf(l);
        d.style.cssText = `left:${l.x * 100}%;top:${l.y * 100}%;width:${l.w * 100}%;height:${l.h * 100}%;border-color:${col};${preExisting(l) ? 'border-style:dashed;' : ''}${l.hidden ? 'opacity:.35' : ''}`;
        d.innerHTML = `<div class="tg" style="background:${col};color:${inkFor(col)}">${i + 1}. ${C.esc(l.text)}</div><div class="hd" data-h="1"></div>`;
        stage.appendChild(d);
      });
      list.innerHTML = labels.length ? labels.map((l, i) => `
        <div class="it${i === sel ? ' sel' : ''}" data-i="${i}">
          <div class="row" style="gap:6px"><b>${i + 1}.</b><input data-f="text" data-i="${i}" value="${C.esc(l.text)}" class="grow" style="width:auto">
          ${l.ai ? '<span class="badge ai">AI</span>' : ''}${preExisting(l) ? '<span class="badge">pre-existing</span>' : ''}</div>
          ${l.detail ? `<div class="hint" style="margin-top:4px">${C.esc(l.detail)}</div>` : ''}
          <div class="row" style="margin-top:6px"><div class="swatches">${COLOURS.map((c) => `<button title="${c}" data-col="${c}" data-i="${i}" style="background:${c}"></button>`).join('')}</div>
          <label class="hint" style="margin-left:auto"><input type="checkbox" data-hide="${i}" ${l.hidden ? '' : 'checked'} style="width:auto"> show</label>
          <button class="btn sm danger" data-del="${i}">✕</button></div>
        </div>`).join('') : '<div class="hint">No labels yet. Draw a box on the photo.</div>';
    }

    // highlight a label without rebuilding the list, so a click on 'show', a field or a button still reaches its target
    function select(i) {
      sel = i;
      list.querySelectorAll('.it').forEach((n) => n.classList.toggle('sel', +n.dataset.i === sel));
      stage.querySelectorAll('.bx').forEach((n) => n.classList.toggle('sel', +n.dataset.i === sel));
    }

    function pt(e) {
      const r = stage.getBoundingClientRect();
      return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
    }
    let drag = null;
    stage.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      stage.setPointerCapture(e.pointerId);
      const p = pt(e);
      const bx = e.target.closest('.bx');
      if (e.target.dataset.h && bx) {
        sel = +bx.dataset.i; drag = { mode: 'resize', i: sel, start: p, orig: { ...labels[sel] } };
      } else if (bx) {
        sel = +bx.dataset.i; drag = { mode: 'move', i: sel, start: p, orig: { ...labels[sel] } };
      } else {
        labels.push({ x: p.x, y: p.y, w: 0, h: 0, text: 'Damage', colour: '#ff3b30' });
        sel = labels.length - 1; drag = { mode: 'new', i: sel, start: p };
      }
      draw();
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const p = pt(e);
      const l = labels[drag.i];
      if (drag.mode === 'new') {
        l.x = Math.min(p.x, drag.start.x); l.y = Math.min(p.y, drag.start.y);
        l.w = Math.abs(p.x - drag.start.x); l.h = Math.abs(p.y - drag.start.y);
      } else if (drag.mode === 'move') {
        l.x = Math.min(1 - l.w, Math.max(0, drag.orig.x + p.x - drag.start.x));
        l.y = Math.min(1 - l.h, Math.max(0, drag.orig.y + p.y - drag.start.y));
      } else {
        l.w = Math.max(0.01, Math.min(1 - l.x, drag.orig.w + p.x - drag.start.x));
        l.h = Math.max(0.01, Math.min(1 - l.y, drag.orig.h + p.y - drag.start.y));
      }
      draw();
    });
    stage.addEventListener('pointerup', () => {
      if (drag && drag.mode === 'new') {
        const l = labels[drag.i];
        if (l.w < 0.01 || l.h < 0.01) { labels.splice(drag.i, 1); sel = labels.length - 1; }
        else {
          l.ai = false;
          setTimeout(() => { const inp = list.querySelector(`input[data-f="text"][data-i="${sel}"]`); if (inp) { inp.focus(); inp.select(); } }, 0);
        }
      }
      drag = null;
      draw();
    });

    body.addEventListener('input', (e) => {
      if (e.target.dataset.f === 'text') {
        labels[+e.target.dataset.i].text = e.target.value;
        const tg = stage.querySelector(`.bx[data-i="${e.target.dataset.i}"] .tg`);
        if (tg) tg.textContent = `${+e.target.dataset.i + 1}. ${e.target.value}`;
      }
    });
    body.addEventListener('focusin', (e) => { const it = e.target.closest('.it'); if (it && +it.dataset.i !== sel) select(+it.dataset.i); });
    body.addEventListener('change', (e) => {
      if (e.target.dataset.hide != null) { labels[+e.target.dataset.hide].hidden = !e.target.checked; draw(); }
    });
    body.addEventListener('click', (e) => {
      const t = e.target;
      if (t.dataset.col) { labels[+t.dataset.i].colour = t.dataset.col; draw(); return; }
      if (t.dataset.del != null) { labels.splice(+t.dataset.del, 1); sel = Math.min(sel, labels.length - 1); draw(); return; }
      if (t.dataset.q) { if (sel >= 0) { labels[sel].text = t.dataset.q; draw(); } return; }
      if (t.dataset.act === 'clear') { if (confirm('Remove all labels from this photo?')) { labels = []; sel = -1; draw(); } return; }
      if (t.dataset.act === 'cancel') { if (!dirty() || confirm('Discard your changes to these labels?')) closeModal(); return; }
      if (t.dataset.act === 'save') { const out = labels, from = labels.map((l) => origin.get(l) || null); closeModal(); onSave(out, from); return; }
      const it = t.closest('.it');
      if (it) select(+it.dataset.i);
    });
    const keyh = (e) => {
      if (!document.body.contains(body)) { document.removeEventListener('keydown', keyh); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel >= 0 && document.activeElement.tagName !== 'INPUT') {
        labels.splice(sel, 1); sel = labels.length - 1; draw();
      }
    };
    document.addEventListener('keydown', keyh);
    draw();
  }

  // AI labels for damage it judged not accident-related are drawn dashed (as in the report)
  const preExisting = (l) => /^no/i.test(String(l.accidentRelated || ''));

  // Small read-only overlay used on thumbnails
  function overlay(labels) {
    return `<div class="ov">${(labels || []).filter((l) => !l.hidden).map((l, i) => { const col = colourOf(l); return `<div class="bx" style="left:${l.x * 100}%;top:${l.y * 100}%;width:${l.w * 100}%;height:${l.h * 100}%;border-color:${col}${preExisting(l) ? ';border-style:dashed' : ''}"></div><div class="tg" style="left:${l.x * 100}%;top:${l.y * 100}%;background:${col};color:${inkFor(col)}">${i + 1}. ${C.esc(l.text)}</div>`; }).join('')}</div>`;
  }

  window.Labeler = { open, overlay };
})();
