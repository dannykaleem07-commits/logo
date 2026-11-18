/* Photo labelling editor: draw, move, resize and caption damage boxes. Works with AI-generated labels too.
   Keyboard: "New box" places a box; on the photo, arrow keys move the selected box and Shift+arrows resize it (with Ctrl in
   bigger steps), 1–9 or [ and ] choose a box, Enter edits its text (Enter in the text goes back to the photo), and Delete
   removes it. */
(function () {
  'use strict';
  const C = window.Core;
  const COLOURS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#2d8ae0', '#af52de', '#ffffff'];
  const COLOUR_NAMES = { '#ff3b30': 'red', '#ff9500': 'orange', '#ffcc00': 'yellow', '#34c759': 'green', '#2d8ae0': 'blue', '#af52de': 'purple', '#ffffff': 'white' };
  const QUICK = ['Scratch', 'Scuff', 'Scoring', 'Paint transfer', 'Dent', 'Crease', 'Deformation', 'Crack', 'Broken', 'Misaligned', 'Deflated tyre', 'Kerbed wheel', 'Gap / flush'];
  const DEFAULT_COLOUR = '#ff3b30';
  // keyboard steps, as fractions of the photo: arrow keys move or resize by 1%, with Ctrl by 5%; a box is never smaller than 1%
  const STEP = 0.01, BIG_STEP = 0.05, MIN_SIZE = 0.01;
  const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const r4 = (v) => Math.round(v * 10000) / 10000;
  const clamp = (v, lo, hi) => Math.min(Math.max(lo, hi), Math.max(lo, v));
  const pct = (v) => Math.round(v * 100) + '%';
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
    let made = 0; // boxes placed with "New box", so that several in a row do not cover each other exactly

    const body = document.createElement('div');
    // the photo takes focus when the editor opens (data-autofocus): the arrow keys work on the selected box straight away
    body.innerHTML = `
      <div class="lab">
        <div><div class="labStage" style="display:inline-block" tabindex="0" role="application" aria-label="Photo with damage label boxes" aria-describedby="labKeys" data-autofocus><img src="${C.esc(photo.dataUrl)}" alt=""></div>
          <p class="hint" id="labKeys">Drag on the photo to draw a box. Drag a box to move it; drag its corner to resize. Delete removes the selected box. Keyboard: New box adds a box; on the photo, arrow keys move the selected box and Shift+arrows resize it (Ctrl for bigger steps), 1–9 or [ ] choose a box, and Enter edits its text.</p>
          <div class="srOnly" aria-live="polite" data-say></div></div>
        <div>
          <div class="row" style="margin-bottom:8px"><b class="grow">Labels</b><button class="btn sm" data-act="newbox">+ New box</button><button class="btn sm danger" data-act="clear">Clear all</button></div>
          <div class="lablist"></div>
          <div class="hint" style="margin:8px 0 4px">Quick labels (apply to selected box)</div>
          <div class="row" style="gap:4px" data-quick>${QUICK.map((q) => `<button class="btn sm" data-q="${q}">${q}</button>`).join('')}</div>
          <div class="row" style="margin-top:14px"><button class="btn primary grow" data-act="save">Save labels</button><button class="btn" data-act="cancel">Cancel</button></div>
        </div>
      </div>`;
    // refused while another window is open; with unsaved boxes, closing it (×, Escape, backdrop, Back) asks first
    if (!openModal('Label damage — ' + (photo.title || 'photograph'), body, { isDirty: dirty })) return;
    const stage = body.querySelector('.labStage');
    const list = body.querySelector('.lablist');
    const sayBox = body.querySelector('[data-say]');
    // spoken feedback for keyboard changes (screen readers); nothing is shown
    const say = (text) => { sayBox.textContent = text; };
    const describe = (i) => { const l = labels[i]; return l ? `Box ${i + 1} of ${labels.length}, ${l.text || 'no text'}: ${pct(l.x)} from the left, ${pct(l.y)} from the top, ${pct(l.w)} wide, ${pct(l.h)} high.` : 'No box selected.'; };

    // a control in the list keeps focus when the list is rebuilt (a colour, show or delete pressed from the keyboard)
    const focusKey = (a) => {
      const d = a.dataset || {};
      if (d.col) return `[data-col="${d.col}"][data-i="${d.i}"]`;
      if (d.del != null) return `[data-del="${d.del}"]`;
      if (d.hide != null) return `[data-hide="${d.hide}"]`;
      if (d.f) return `[data-f="${d.f}"][data-i="${d.i}"]`;
      return '';
    };
    let restoring = false; // focus put back by draw(): it does not change the selection
    function draw() {
      const a = document.activeElement;
      const back = !drag && a && list.contains(a) ? focusKey(a) : '';
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
      list.innerHTML = labels.length ? labels.map((l, i) => {
        const n = i + 1, col = colourOf(l).toLowerCase();
        return `
        <div class="it${i === sel ? ' sel' : ''}" data-i="${i}">
          <div class="row" style="gap:6px"><b>${n}.</b><input data-f="text" data-i="${i}" value="${C.esc(l.text)}" class="grow" style="width:auto" aria-label="Label ${n} text">
          ${l.ai ? '<span class="badge ai">AI</span>' : ''}${preExisting(l) ? '<span class="badge">pre-existing</span>' : ''}</div>
          ${l.detail ? `<div class="hint" style="margin-top:4px">${C.esc(l.detail)}</div>` : ''}
          <div class="row" style="margin-top:6px"><div class="swatches">${COLOURS.map((c) => `<button title="${c}" data-col="${c}" data-i="${i}" style="background:${c}" aria-label="Colour ${COLOUR_NAMES[c]} for label ${n}" aria-pressed="${col === c}"></button>`).join('')}</div>
          <label class="hint" style="margin-left:auto"><input type="checkbox" data-hide="${i}" ${l.hidden ? '' : 'checked'} style="width:auto" aria-label="Show label ${n}"> show</label>
          <button class="btn sm danger" data-del="${i}" aria-label="Delete label ${n}">✕</button></div>
        </div>`;
      }).join('') : '<div class="hint">No labels yet. Draw a box on the photo.</div>';
      if (back) {
        restoring = true;
        try { (list.querySelector(back) || stage).focus(); } finally { restoring = false; }
      }
    }

    // highlight a label without rebuilding the list, so a click on 'show', a field or a button still reaches its target
    function select(i) {
      sel = i;
      list.querySelectorAll('.it').forEach((n) => n.classList.toggle('sel', +n.dataset.i === sel));
      stage.querySelectorAll('.bx').forEach((n) => n.classList.toggle('sel', +n.dataset.i === sel));
    }
    function focusText(i) { const inp = list.querySelector(`input[data-f="text"][data-i="${i}"]`); if (inp) { inp.focus(); inp.select(); } }
    // "New box": a default box in the middle of the photo, selected, with the photo focused so the arrow keys place it
    function addBox() {
      const off = (made++ % 5) * 0.04;
      labels.push({ x: r4(0.35 + off), y: r4(0.4 + off), w: 0.3, h: 0.2, text: 'Damage', colour: DEFAULT_COLOUR, ai: false });
      sel = labels.length - 1;
      draw();
      stage.focus();
      say(`New box added. ${describe(sel)} Arrow keys move it, Shift and arrow keys resize it, Enter edits its text.`);
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
          setTimeout(() => focusText(sel), 0);
        }
      }
      drag = null;
      draw();
    });
    // keyboard editing on the focused photo (Delete is handled below, as it is for the mouse)
    stage.addEventListener('keydown', (e) => {
      if (e.altKey || e.metaKey || drag) return;
      const k = e.key;
      if (/^[1-9]$/.test(k) && !e.ctrlKey) {
        e.preventDefault();
        const i = +k - 1;
        if (i < labels.length) { select(i); say(describe(i)); } else say(`There ${labels.length === 1 ? 'is 1 box' : `are ${labels.length} boxes`}.`);
        return;
      }
      if ((k === ']' || k === '[') && labels.length) {
        e.preventDefault();
        const n = labels.length;
        select(sel < 0 ? (k === ']' ? 0 : n - 1) : (sel + (k === ']' ? 1 : n - 1)) % n);
        say(describe(sel));
        return;
      }
      if (k === 'Enter' && sel >= 0) { e.preventDefault(); focusText(sel); return; }
      const dir = ARROWS[k];
      if (!dir) return;
      e.preventDefault(); // the arrow keys never scroll the window while the photo has focus
      const l = labels[sel];
      if (!l) { say('No box selected. Use New box to add one.'); return; }
      const s = e.ctrlKey ? BIG_STEP : STEP;
      if (e.shiftKey) { // resize from the top-left corner, as the corner handle does
        l.w = r4(clamp(l.w + dir[0] * s, MIN_SIZE, 1 - l.x));
        l.h = r4(clamp(l.h + dir[1] * s, MIN_SIZE, 1 - l.y));
      } else {
        l.x = r4(clamp(l.x + dir[0] * s, 0, 1 - l.w));
        l.y = r4(clamp(l.y + dir[1] * s, 0, 1 - l.h));
      }
      draw();
      say(describe(sel));
    });

    body.addEventListener('input', (e) => {
      if (e.target.dataset.f === 'text') {
        labels[+e.target.dataset.i].text = e.target.value;
        const tg = stage.querySelector(`.bx[data-i="${e.target.dataset.i}"] .tg`);
        if (tg) tg.textContent = `${+e.target.dataset.i + 1}. ${e.target.value}`;
      }
    });
    // Enter in a label's text goes back to the photo, where the arrow keys move that box
    body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.dataset.f === 'text' && !e.isComposing) { e.preventDefault(); select(+e.target.dataset.i); stage.focus(); say(describe(sel)); }
    });
    body.addEventListener('focusin', (e) => { if (restoring) return; const it = e.target.closest('.it'); if (it && +it.dataset.i !== sel) select(+it.dataset.i); });
    body.addEventListener('change', (e) => {
      if (e.target.dataset.hide != null) { labels[+e.target.dataset.hide].hidden = !e.target.checked; draw(); }
    });
    body.addEventListener('click', (e) => {
      const t = e.target;
      if (t.dataset.col) { labels[+t.dataset.i].colour = t.dataset.col; draw(); return; }
      if (t.dataset.del != null) { labels.splice(+t.dataset.del, 1); sel = Math.min(sel, labels.length - 1); draw(); say(`Label removed. ${labels.length} left.`); return; }
      if (t.dataset.q) { if (sel >= 0) { labels[sel].text = t.dataset.q; draw(); } return; }
      if (t.dataset.act === 'newbox') { addBox(); return; }
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
        say(`Box removed. ${labels.length} left.`);
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
