/* Clickable top-view damage diagram. Front of the vehicle at the top; RH (driver, UK) on the right. */
(function () {
  'use strict';
  // id, label, svg shape, catalogue groups for the parts picker, side
  const ZONES = [
    ['FRONT', 'Front bumper', 'rect', [60, 12, 80, 22], ['Front end', 'Lighting', 'Cooling & A/C', 'Electrical & ADAS'], ''],
    ['BONNET', 'Bonnet', 'rect', [62, 36, 76, 70], ['Bonnet', 'Engine bay'], ''],
    ['LH_WING', 'LH front wing', 'rect', [40, 36, 20, 70], ['Front wing & arch', 'Lighting'], 'L'],
    ['RH_WING', 'RH front wing', 'rect', [140, 36, 20, 70], ['Front wing & arch', 'Lighting'], 'R'],
    ['SCREEN', 'Windscreen', 'rect', [62, 108, 76, 26], ['Glass', 'Electrical & ADAS'], ''],
    ['LH_MIRROR', 'LH mirror', 'rect', [22, 122, 16, 12], ['Mirrors'], 'L'],
    ['RH_MIRROR', 'RH mirror', 'rect', [162, 122, 16, 12], ['Mirrors'], 'R'],
    ['LH_FDOOR', 'LH front door', 'rect', [40, 136, 20, 70], ['Doors', 'Glass'], 'L'],
    ['RH_FDOOR', 'RH front door', 'rect', [140, 136, 20, 70], ['Doors', 'Glass'], 'R'],
    ['ROOF', 'Roof', 'rect', [62, 136, 76, 130], ['Roof', 'SRS / airbags', 'Interior'], ''],
    ['LH_RDOOR', 'LH rear door', 'rect', [40, 208, 20, 66], ['Doors', 'Glass'], 'L'],
    ['RH_RDOOR', 'RH rear door', 'rect', [140, 208, 20, 66], ['Doors', 'Glass'], 'R'],
    ['LH_SILL', 'LH sill', 'rect', [30, 136, 9, 138], ['Side & sill', 'Structural'], 'L'],
    ['RH_SILL', 'RH sill', 'rect', [161, 136, 9, 138], ['Side & sill', 'Structural'], 'R'],
    ['LH_QTR', 'LH rear quarter', 'rect', [40, 276, 20, 76], ['Rear quarter', 'Lighting'], 'L'],
    ['RH_QTR', 'RH rear quarter', 'rect', [140, 276, 20, 76], ['Rear quarter', 'Lighting'], 'R'],
    ['REARSCREEN', 'Rear screen', 'rect', [62, 268, 76, 22], ['Glass'], ''],
    ['TAILGATE', 'Tailgate / boot', 'rect', [62, 292, 76, 60], ['Tailgate / boot', 'Lighting'], ''],
    ['REAR', 'Rear bumper', 'rect', [60, 354, 80, 22], ['Rear end', 'Lighting'], ''],
    ['FL_WHEEL', 'LH front wheel', 'wheel', [24, 60, 14, 34], ['Wheels & tyres', 'Suspension & steering', 'Brakes'], 'L'],
    ['FR_WHEEL', 'RH front wheel', 'wheel', [162, 60, 14, 34], ['Wheels & tyres', 'Suspension & steering', 'Brakes'], 'R'],
    ['RL_WHEEL', 'LH rear wheel', 'wheel', [24, 290, 14, 34], ['Wheels & tyres', 'Suspension & steering', 'Brakes'], 'L'],
    ['RR_WHEEL', 'RH rear wheel', 'wheel', [162, 290, 14, 34], ['Wheels & tyres', 'Suspension & steering', 'Brakes'], 'R'],
    ['UNDER', 'Underbody / structure', 'rect', [84, 384, 32, 16], ['Underbody', 'Structural'], '']
  ].map((z) => ({ id: z[0], label: z[1], shape: z[2], r: z[3], groups: z[4], side: z[5] }));

  function svg(selected) {
    const sel = new Set(selected || []);
    const shapes = ZONES.map((z) => {
      const [x, y, w, h] = z.r;
      const on = sel.has(z.label) ? ' on' : '';
      const rx = z.shape === 'wheel' ? 5 : 4;
      const short = z.label.replace(/^(LH|RH) /, '').replace('front ', 'f. ').replace('rear ', 'r. ');
      const txt = z.shape === 'wheel' || w < 25
        ? ''
        : `<text x="${x + w / 2}" y="${y + h / 2 + 3}">${short}</text>`;
      return `<rect class="z ${z.shape === 'wheel' ? 'wheel' : ''}${on}" data-zone="${z.label}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"><title>${z.label}</title></rect>${txt}`;
    }).join('');
    return `<svg viewBox="0 0 200 410" role="img" aria-label="Vehicle damage diagram">
      <rect x="28" y="8" width="144" height="372" rx="34" fill="#f8fafc" stroke="#b7c2ce" stroke-width="1.5"/>
      ${shapes}
      <text x="100" y="6" style="font-weight:700">FRONT</text>
      <text x="12" y="210" transform="rotate(-90 12 210)" style="font-weight:700">LH (nearside)</text>
      <text x="190" y="210" transform="rotate(90 190 210)" style="font-weight:700">RH (offside)</text>
    </svg>`;
  }

  function byLabel(label) { return ZONES.find((z) => z.label === label); }

  window.Diagram = { ZONES, svg, byLabel };
})();
