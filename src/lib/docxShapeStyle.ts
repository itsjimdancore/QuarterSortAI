// Pure helpers that turn Word shape XML (DrawingML `wps` and legacy VML) into
// CSS values. Used by docxTextboxes.ts to render text boxes like Word does.

export const EMU_PER_PT = 12700;
export const PX_PER_PT = 96 / 72;

export function emuToPt(v: string | null | undefined, fallback = 0): number {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n / EMU_PER_PT : fallback;
}

// ── Namespace-agnostic XML access (Word files mix many prefixes) ──

export function kid(el: Element | null | undefined, name: string): Element | null {
  if (!el) return null;
  for (const c of Array.from(el.children)) if (c.localName === name) return c;
  return null;
}

export function kids(el: Element | null | undefined, name: string): Element[] {
  if (!el) return [];
  return Array.from(el.children).filter((c) => c.localName === name);
}

/** First descendant with this local name, ignoring anything inside mc:Fallback. */
export function find(el: Element | null | undefined, name: string): Element | null {
  if (!el) return null;
  for (const c of Array.from(el.children)) {
    if (c.localName === 'Fallback') continue;
    if (c.localName === name) return c;
    const hit = find(c, name);
    if (hit) return hit;
  }
  return null;
}

export function attr(el: Element | null | undefined, name: string): string | null {
  if (!el) return null;
  for (const a of Array.from(el.attributes)) if (a.localName === name) return a.value;
  return null;
}

function num(v: string | null | undefined, fallback: number): number {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ── Theme ──

export interface Theme {
  /** Scheme slot → hex (no #): dk1, lt1, dk2, lt2, accent1-6, hlink, folHlink. */
  colors: Record<string, string>;
  /** Document mapping, e.g. bg1 → lt1, tx1 → dk1. */
  mapping: Record<string, string>;
  /** Line widths (pt) from the theme's lnStyleLst, used by `a:lnRef idx`. */
  lineWidthsPt: number[];
}

const DEFAULT_MAPPING: Record<string, string> = {
  bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2',
  accent1: 'accent1', accent2: 'accent2', accent3: 'accent3',
  accent4: 'accent4', accent5: 'accent5', accent6: 'accent6',
  hlink: 'hlink', folHlink: 'folHlink',
};

const MAPPING_VALUE: Record<string, string> = {
  light1: 'lt1', dark1: 'dk1', light2: 'lt2', dark2: 'dk2',
  accent1: 'accent1', accent2: 'accent2', accent3: 'accent3', accent4: 'accent4',
  accent5: 'accent5', accent6: 'accent6', hyperlink: 'hlink', followedHyperlink: 'folHlink',
};

// Office 2013+ defaults, used when the file has no theme part.
const DEFAULT_COLORS: Record<string, string> = {
  dk1: '000000', lt1: 'FFFFFF', dk2: '44546A', lt2: 'E7E6E6',
  accent1: '4472C4', accent2: 'ED7D31', accent3: 'A5A5A5', accent4: 'FFC000',
  accent5: '5B9BD5', accent6: '70AD47', hlink: '0563C1', folHlink: '954F72',
};

export function loadTheme(themeDoc: Document | null, settingsDoc: Document | null): Theme {
  const colors = { ...DEFAULT_COLORS };
  const lineWidthsPt = [0.5, 1, 1.5];
  const root = themeDoc?.documentElement;
  const scheme = root ? find(root, 'clrScheme') : null;
  for (const slot of Array.from(scheme?.children ?? [])) {
    const c = slot.firstElementChild;
    const hex = c?.localName === 'sysClr' ? attr(c, 'lastClr') : attr(c, 'val');
    if (hex && /^[0-9a-f]{6}$/i.test(hex)) colors[slot.localName] = hex.toUpperCase();
  }
  const lnList = root ? find(root, 'lnStyleLst') : null;
  kids(lnList, 'ln').forEach((ln, i) => {
    const w = attr(ln, 'w');
    if (w) lineWidthsPt[i] = emuToPt(w);
  });

  const mapping = { ...DEFAULT_MAPPING };
  const map = settingsDoc ? find(settingsDoc.documentElement, 'clrSchemeMapping') : null;
  for (const a of Array.from(map?.attributes ?? [])) {
    const target = MAPPING_VALUE[a.value];
    if (target) mapping[a.localName] = target;
  }
  return { colors, mapping, lineWidthsPt };
}

// ── Colours ──

const PRESET: Record<string, string> = {
  black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF',
  yellow: 'FFFF00', gray: '808080', grey: '808080', silver: 'C0C0C0', navy: '000080',
  maroon: '800000', purple: '800080', teal: '008080', olive: '808000', lime: '00FF00',
  aqua: '00FFFF', cyan: '00FFFF', fuchsia: 'FF00FF', magenta: 'FF00FF', orange: 'FFA500',
  ltGray: 'D3D3D3', dkGray: 'A9A9A9', windowText: '000000', window: 'FFFFFF',
};

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h /= 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Resolve one DrawingML colour element (srgbClr, schemeClr, …) with modifiers. */
export function colorElementToCss(c: Element, theme: Theme, phColor?: string | null): string | null {
  let hex: string | null = null;
  switch (c.localName) {
    case 'srgbClr': hex = attr(c, 'val'); break;
    case 'sysClr': hex = attr(c, 'lastClr') ?? PRESET[attr(c, 'val') ?? ''] ?? null; break;
    case 'prstClr': hex = PRESET[attr(c, 'val') ?? ''] ?? null; break;
    case 'schemeClr': {
      const val = attr(c, 'val') ?? '';
      if (val === 'phClr') { hex = phColor ?? null; break; }
      hex = theme.colors[theme.mapping[val] ?? val] ?? null;
      break;
    }
    case 'scrgbClr': {
      const pct = (n: string) => Math.round(clamp01(num(attr(c, n), 0) / 100000) * 255);
      hex = [pct('r'), pct('g'), pct('b')].map((x) => x.toString(16).padStart(2, '0')).join('');
      break;
    }
    default: return null;
  }
  if (!hex || !/^#?[0-9a-f]{6}$/i.test(hex)) return null;

  let [r, g, b] = hexToRgb(hex);
  let alpha = 1;
  for (const m of Array.from(c.children)) {
    const v = num(attr(m, 'val'), 100000) / 100000;
    switch (m.localName) {
      case 'lumMod': case 'lumOff': case 'satMod': {
        const [h, s, l] = rgbToHsl(r, g, b);
        const nl = m.localName === 'lumMod' ? l * v : m.localName === 'lumOff' ? l + v : l;
        const ns = m.localName === 'satMod' ? s * v : s;
        [r, g, b] = hslToRgb(h, clamp01(ns), clamp01(nl));
        break;
      }
      case 'shade': r *= v; g *= v; b *= v; break;
      case 'tint': r += (255 - r) * (1 - v); g += (255 - g) * (1 - v); b += (255 - b) * (1 - v); break;
      case 'alpha': alpha = clamp01(v); break;
    }
  }
  const rgb = [r, g, b].map((x) => Math.round(Math.min(255, Math.max(0, x))));
  return alpha < 1 ? `rgba(${rgb.join(', ')}, ${alpha.toFixed(3)})` : `rgb(${rgb.join(', ')})`;
}

const COLOR_TAGS = new Set(['srgbClr', 'schemeClr', 'sysClr', 'prstClr', 'scrgbClr']);

export function firstColor(parent: Element | null, theme: Theme, phColor?: string | null): string | null {
  for (const c of Array.from(parent?.children ?? [])) {
    if (COLOR_TAGS.has(c.localName)) return colorElementToCss(c, theme, phColor);
  }
  return null;
}

/** Hex of a style-reference colour (lnRef/fillRef/fontRef) for phClr substitution. */
function refHex(ref: Element | null, theme: Theme): string | null {
  const css = firstColor(ref, theme);
  const m = css?.match(/rgba?\((\d+), (\d+), (\d+)/);
  return m ? [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('') : null;
}

// ── Fill / line / effects (DrawingML) ──

/** CSS background for a shape, or 'transparent'. */
export function fillCss(spPr: Element | null, styleEl: Element | null, theme: Theme): string {
  if (kid(spPr, 'noFill')) return 'transparent';
  const solid = kid(spPr, 'solidFill');
  if (solid) return firstColor(solid, theme) ?? 'transparent';
  const grad = kid(spPr, 'gradFill');
  if (grad) {
    const stops = kids(kid(grad, 'gsLst'), 'gs')
      .map((gs) => ({ pos: num(attr(gs, 'pos'), 0) / 1000, color: firstColor(gs, theme) }))
      .filter((s): s is { pos: number; color: string } => !!s.color)
      .sort((a, b) => a.pos - b.pos);
    if (stops.length) {
      const ang = num(attr(kid(grad, 'lin'), 'ang'), 0) / 60000;
      return `linear-gradient(${(ang + 90) % 360}deg, ${stops.map((s) => `${s.color} ${s.pos}%`).join(', ')})`;
    }
  }
  // No explicit fill: fall back to the shape style's fillRef.
  const fillRef = kid(styleEl, 'fillRef');
  if (fillRef && num(attr(fillRef, 'idx'), 0) > 0) return firstColor(fillRef, theme) ?? 'transparent';
  return 'transparent';
}

export interface LineStyle { widthPt: number; color: string; style: 'solid' | 'dashed' | 'dotted' | 'double' }

export function lineStyle(spPr: Element | null, styleEl: Element | null, theme: Theme): LineStyle | null {
  const ln = kid(spPr, 'ln');
  const lnRef = kid(styleEl, 'lnRef');
  const refIdx = num(attr(lnRef, 'idx'), 0);
  if (kid(ln, 'noFill')) return null;

  let color = firstColor(kid(ln, 'solidFill'), theme, refHex(lnRef, theme));
  if (!color && refIdx > 0) color = firstColor(lnRef, theme);
  if (!color) return null;

  let widthPt = attr(ln, 'w') != null ? emuToPt(attr(ln, 'w')) : refIdx > 0 ? theme.lineWidthsPt[refIdx - 1] ?? 0.75 : 0.75;
  if (widthPt <= 0) widthPt = 0.75;
  const dash = attr(kid(ln, 'prstDash'), 'val') ?? 'solid';
  const style: LineStyle['style'] =
    attr(ln, 'cmpd') === 'dbl' ? 'double' : dash === 'solid' ? 'solid' : /dot/i.test(dash) && !/dash/i.test(dash) ? 'dotted' : 'dashed';
  return { widthPt, color, style };
}

export function shadowCss(spPr: Element | null, theme: Theme): string | null {
  const sh = find(kid(spPr, 'effectLst'), 'outerShdw');
  if (!sh) return null;
  const color = firstColor(sh, theme) ?? 'rgba(0, 0, 0, 0.4)';
  const dist = emuToPt(attr(sh, 'dist'));
  const dir = (num(attr(sh, 'dir'), 0) / 60000) * (Math.PI / 180);
  const blur = emuToPt(attr(sh, 'blurRad'));
  return `${(dist * Math.cos(dir)).toFixed(2)}pt ${(dist * Math.sin(dir)).toFixed(2)}pt ${blur.toFixed(2)}pt ${color}`;
}

export function textColorFromStyle(styleEl: Element | null, theme: Theme): string | null {
  return firstColor(kid(styleEl, 'fontRef'), theme);
}

export type Geometry = 'rect' | 'roundRect' | 'ellipse' | 'line';

export function geometry(spPr: Element | null): { kind: Geometry; adj: number | null } {
  const prst = kid(spPr, 'prstGeom');
  const name = attr(prst, 'prst') ?? 'rect';
  const gd = kids(kid(prst, 'avLst'), 'gd').find((g) => attr(g, 'name') === 'adj');
  const fmla = attr(gd, 'fmla')?.match(/val\s+(-?\d+)/);
  const adj = fmla ? Number(fmla[1]) / 100000 : null;
  if (name === 'roundRect' || name === 'round2SameRect' || name === 'snipRoundRect') return { kind: 'roundRect', adj };
  if (name === 'ellipse') return { kind: 'ellipse', adj };
  if (name === 'line' || /^(straight|bent|curved)Connector/.test(name)) return { kind: 'line', adj };
  return { kind: 'rect', adj };
}

// ── Text body (wps:bodyPr) ──

export interface BodyLayout {
  padPt: [number, number, number, number]; // top right bottom left
  vAlign: 'top' | 'middle' | 'bottom';
  writingMode: 'horizontal' | 'vertical' | 'vertical270';
  noWrap: boolean;
  autoFit: boolean;
}

export function bodyLayout(bodyPr: Element | null): BodyLayout {
  const ins = (n: string, d: number) => (attr(bodyPr, n) != null ? emuToPt(attr(bodyPr, n)) : d);
  const anchor = attr(bodyPr, 'anchor');
  const vert = attr(bodyPr, 'vert') ?? 'horz';
  return {
    padPt: [ins('tIns', 3.6), ins('rIns', 7.2), ins('bIns', 3.6), ins('lIns', 7.2)],
    vAlign: anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : 'top',
    writingMode: vert === 'vert270' ? 'vertical270' : vert === 'horz' || vert === 'wordArtVertRtl' ? 'horizontal' : 'vertical',
    noWrap: attr(bodyPr, 'wrap') === 'none',
    autoFit: !!kid(bodyPr, 'spAutoFit'),
  };
}

// ── Legacy VML ──

export function vmlStyle(style: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (style ?? '').split(';')) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}

/** VML length (pt, in, cm, mm, px, emu or unitless px) → pt. */
export function vmlLengthPt(v: string | null | undefined, fallback = 0): number {
  if (!v) return fallback;
  const m = v.trim().match(/^(-?[\d.]+)\s*([a-z%]*)$/i);
  if (!m) return fallback;
  const n = Number(m[1]);
  switch (m[2].toLowerCase()) {
    case 'pt': return n;
    case 'in': return n * 72;
    case 'cm': return (n * 72) / 2.54;
    case 'mm': return (n * 72) / 25.4;
    case 'pc': return n * 12;
    case 'emu': return n / EMU_PER_PT;
    case 'px': case '': return n * 0.75;
    default: return fallback;
  }
}

/** VML colour like "#4f81bd [3204]", "white" or "black [3213]" → CSS. */
export function vmlColor(v: string | null | undefined): string | null {
  if (!v) return null;
  const token = v.trim().split(/\s+/)[0];
  if (/^#[0-9a-f]{6}$/i.test(token)) return token;
  if (/^#[0-9a-f]{3}$/i.test(token)) return token;
  const preset = PRESET[token] ?? PRESET[token.toLowerCase()];
  return preset ? `#${preset}` : null;
}

/** VML fraction: "10923f" (1/65536 units) or "0.1667". */
export function vmlFraction(v: string | null | undefined, fallback: number): number {
  if (!v) return fallback;
  if (v.endsWith('f')) return num(v.slice(0, -1), fallback * 65536) / 65536;
  return num(v, fallback);
}
