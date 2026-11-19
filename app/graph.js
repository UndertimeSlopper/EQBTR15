// Frequency-response plot (SVG, log frequency axis) with a hover readout.

const SVG = 'http://www.w3.org/2000/svg';
const F_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const fLabel = (f) => (f >= 1000 ? `${f / 1000}k` : `${f}`);

export class ResponseGraph {
  constructor(container, { height = 320, errorHeight = 90 } = {}) {
    this.container = container;
    this.height = height;
    this.errorHeight = errorHeight;
    this.series = [];
    this.svg = document.createElementNS(SVG, 'svg');
    this.svg.setAttribute('class', 'graph');
    this.svg.setAttribute('role', 'img');
    this.svg.setAttribute('aria-label', 'Frequency response');
    container.append(this.svg);
    this.readout = document.createElement('div');
    this.readout.className = 'graph-readout';
    container.append(this.readout);
    this.svg.addEventListener('pointermove', (e) => this._hover(e));
    this.svg.addEventListener('pointerleave', () => this._hover(null));
    new ResizeObserver(() => this.render()).observe(container);
  }

  // series: [{ id, label, freqs, db, cls, error?: bool }]
  set(series) { this.series = series.filter(Boolean); this.render(); }

  render() {
    const width = Math.max(320, this.container.clientWidth);
    const main = this.series.filter((s) => !s.error);
    const errs = this.series.filter((s) => s.error);
    const totalH = this.height + (errs.length ? this.errorHeight + 18 : 0);
    const m = { l: 40, r: 12, t: 10, b: 22 };
    this.svg.setAttribute('viewBox', `0 0 ${width} ${totalH}`);
    this.svg.setAttribute('height', totalH);
    this.svg.replaceChildren();
    this.geom = { width, m, x0: m.l, x1: width - m.r };
    const x = (f) => m.l + (Math.log10(f / 20) / 3) * (width - m.l - m.r);
    this.x = x;

    // Main panel range.
    let lo = Infinity, hi = -Infinity;
    for (const s of main) for (const v of s.db) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!Number.isFinite(lo)) { lo = -12; hi = 6; }
    const step = hi - lo > 24 ? 6 : 3;
    lo = Math.floor((lo - 1) / step) * step;
    hi = Math.ceil((hi + 1) / step) * step;
    if (hi - lo < 12) { const mid = (hi + lo) / 2; lo = Math.floor((mid - 6) / step) * step; hi = lo + 12; }
    const panel = { top: m.t, bottom: this.height - m.b, lo, hi, step };
    this._panel(panel, x, width, main, 'dB');
    this.panels = [panel];

    if (errs.length) {
      let emax = 1;
      for (const s of errs) for (const v of s.db) emax = Math.max(emax, Math.abs(v));
      emax = Math.min(12, emax);
      const estep = emax <= 2 ? 1 : emax <= 6 ? 2 : 4;
      emax = Math.ceil(emax / estep) * estep;
      const ep = { top: this.height + 8, bottom: totalH - m.b, lo: -emax, hi: emax, step: estep };
      this._panel(ep, x, width, errs, 'error');
      this.panels.push(ep);
    }
  }

  _panel(p, x, width, series, unit) {
    const { m } = this.geom;
    const y = (v) => p.top + (p.hi - v) / (p.hi - p.lo) * (p.bottom - p.top);
    p.y = y;
    const g = el('g', { class: 'axes' });
    for (let v = p.lo; v <= p.hi + 1e-9; v += p.step) {
      g.append(el('line', { x1: m.l, x2: width - m.r, y1: y(v), y2: y(v), class: v === 0 ? 'zero' : 'grid' }));
      const t = el('text', { x: m.l - 6, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' });
      t.textContent = v > 0 ? `+${v}` : `${v}`;
      g.append(t);
    }
    for (const f of F_TICKS) {
      g.append(el('line', { x1: x(f), x2: x(f), y1: p.top, y2: p.bottom, class: 'grid' }));
    }
    // Frequency labels only under the lowest panel.
    const isLast = unit === 'error' || !this.series.some((s) => s.error);
    if (isLast) {
      for (const f of F_TICKS) {
        const t = el('text', { x: x(f), y: p.bottom + 15, class: 'tick', 'text-anchor': 'middle' });
        t.textContent = fLabel(f);
        g.append(t);
      }
    }
    const lab = el('text', { x: m.l + 6, y: p.top + 14, class: 'panel-label' });
    lab.textContent = unit === 'error' ? 'Difference from target (dB)' : '';
    g.append(lab);
    this.svg.append(g);
    for (const s of series) {
      let d = '';
      for (let i = 0; i < s.freqs.length; i++) {
        const f = s.freqs[i];
        if (f < 20 || f > 20000) continue;
        const v = Math.max(p.lo - 50, Math.min(p.hi + 50, s.db[i]));
        d += `${d ? 'L' : 'M'}${x(f).toFixed(1)},${y(v).toFixed(1)}`;
      }
      const path = el('path', { d, class: `curve ${s.cls ?? ''}` });
      const clip = `clip-${unit}`;
      this.svg.append(path);
      path.setAttribute('clip-path', `url(#${clip})`);
      if (!this.svg.querySelector(`#${clip}`)) {
        const defs = el('defs', {});
        const cp = el('clipPath', { id: clip });
        cp.append(el('rect', { x: m.l, y: p.top, width: width - m.l - m.r, height: p.bottom - p.top }));
        defs.append(cp);
        this.svg.prepend(defs);
      }
    }
  }

  _hover(e) {
    this.svg.querySelector('.cursor')?.remove();
    if (!e || !this.series.length || !this.geom) { this.readout.textContent = ''; return; }
    const r = this.svg.getBoundingClientRect();
    const px = (e.clientX - r.left) * (this.geom.width / r.width);
    const { x0, x1 } = this.geom;
    if (px < x0 || px > x1) { this.readout.textContent = ''; return; }
    const f = 20 * Math.pow(10, 3 * (px - x0) / (x1 - x0));
    const line = el('line', { x1: px, x2: px, y1: 0, y2: 2000, class: 'cursor' });
    this.svg.append(line);
    const parts = [`${f >= 1000 ? (f / 1000).toFixed(2) + ' kHz' : f.toFixed(0) + ' Hz'}`];
    for (const s of this.series) {
      const v = interp(s.freqs, s.db, f);
      if (v != null) parts.push(`${s.label}: ${v > 0 ? '+' : ''}${v.toFixed(1)} dB`);
    }
    this.readout.textContent = parts.join('   ·   ');
  }
}

function interp(freqs, db, f) {
  if (!freqs.length || f < freqs[0] || f > freqs[freqs.length - 1]) return null;
  let lo = 0, hi = freqs.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (freqs[mid] <= f) lo = mid; else hi = mid; }
  const t = freqs[hi] === freqs[lo] ? 0 : Math.log(f / freqs[lo]) / Math.log(freqs[hi] / freqs[lo]);
  return db[lo] + t * (db[hi] - db[lo]);
}

function el(name, attrs) {
  const e = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
