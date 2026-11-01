// Word text boxes / shapes for the DOCX viewer.
//
// docx-preview always ignores the modern DrawingML text box (`wps`) and draws
// the legacy VML fallback as an SVG, which loses borders, fills, padding and
// positioning (and drops rounded boxes and groups entirely). This module:
//   1. preprocessDocx   — reads every text box/shape from the raw XML into a
//                         ShapeSpec and swaps it for a tiny VML marker that
//                         docx-preview parses (keeping the box's paragraphs).
//   2. applyTextboxSpecs — swaps each parsed marker for a plain <div> node.
//   3. placeTextboxes    — after render, styles each box and positions it on its
//                         page the way Word anchors it.

import JSZip from 'jszip';
import {
  attr, BodyLayout, bodyLayout, emuToPt, fillCss, find, geometry, kid, kids, lineStyle, LineStyle,
  loadTheme, PX_PER_PT, shadowCss, textColorFromStyle, Theme, vmlColor, vmlFraction, vmlLengthPt, vmlStyle,
} from './docxShapeStyle';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const V_NS = 'urn:schemas-microsoft-com:vml';
const MARKER_RE = /qso-txbx:(\d+)/;
const PART_RE = /^word\/(document|header\d*|footer\d*)\.xml$/;

type Wrap = 'none' | 'square' | 'tight' | 'through' | 'topAndBottom';

interface AxisPos {
  rel: string;
  align: string | null;
  offsetPt: number;
  /** wp14:pctPos*Offset, in 1/1000 of a percent. */
  pct: number | null;
}

interface SizeRel { rel: string; pct: number }

interface Anchor {
  inline: boolean;
  h: AxisPos;
  v: AxisPos;
  wrap: Wrap;
  wrapSide: string;
  behind: boolean;
  distPt: { t: number; r: number; b: number; l: number };
  extentPt: { w: number; h: number };
  sizeRelW: SizeRel | null;
  sizeRelH: SizeRel | null;
  zIndex: number;
  relativeHeight: number;
}

export interface ShapeSpec {
  kind: 'textbox' | 'shape' | 'picture' | 'line';
  anchor: Anchor;
  /** Shapes from one drawing (a group) share a key: one wrap spacer per group. */
  groupKey: string;
  isGroupChild: boolean;
  /** Position/size inside the drawing's extent, in pt. */
  xPt: number;
  yPt: number;
  wPt: number;
  hPt: number;
  rotationDeg: number;
  flipH: boolean;
  flipV: boolean;
  ellipse: boolean;
  /** Static CSS for the outer box (background, border, radius, shadow, colour). */
  box: Record<string, string>;
  line: LineStyle | null;
  body: BodyLayout | null;
  pictureRelId: string | null;
}

// ─────────────────────────── 1. Preprocess the DOCX ───────────────────────────

interface BuildCtx {
  doc: Document;
  theme: Theme;
  specs: ShapeSpec[];
  groupCounter: { n: number };
}

function parseXml(s: string): Document {
  return new DOMParser().parseFromString(s, 'application/xml');
}

function insideAlternateContent(el: Element): boolean {
  for (let p = el.parentElement; p; p = p.parentElement) if (p.localName === 'AlternateContent') return true;
  return false;
}

function shapeGraphic(drawing: Element): { container: Element; graphic: Element } | null {
  const container = kid(drawing, 'anchor') ?? kid(drawing, 'inline');
  const data = find(container, 'graphicData');
  const graphic = data?.firstElementChild;
  if (!container || !graphic || !['wsp', 'wgp', 'wpc'].includes(graphic.localName)) return null;
  return { container, graphic };
}

function textOf(el: Element | null): string | null {
  const t = el?.textContent?.trim();
  return t ? t : null;
}

function axis(pos: Element | null, defaultRel: string): AxisPos {
  const pctEl = find(pos, 'pctPosHOffset') ?? find(pos, 'pctPosVOffset');
  return {
    rel: attr(pos, 'relativeFrom') ?? defaultRel,
    align: textOf(find(pos, 'align')),
    offsetPt: emuToPt(textOf(find(pos, 'posOffset'))),
    pct: pctEl ? Number(textOf(pctEl)) : null,
  };
}

function sizeRel(el: Element | null, pctName: string): SizeRel | null {
  const pct = Number(textOf(find(el, pctName)) ?? 0);
  return el && pct > 0 ? { rel: attr(el, 'relativeFrom') ?? 'page', pct } : null;
}

function parseDrawingAnchor(container: Element): Anchor {
  const extent = kid(container, 'extent');
  const extentPt = { w: emuToPt(attr(extent, 'cx')), h: emuToPt(attr(extent, 'cy')) };
  const base: Anchor = {
    inline: container.localName === 'inline',
    h: { rel: 'column', align: null, offsetPt: 0, pct: null },
    v: { rel: 'paragraph', align: null, offsetPt: 0, pct: null },
    wrap: 'none', wrapSide: 'bothSides', behind: false,
    distPt: { t: 0, r: 0, b: 0, l: 0 }, extentPt,
    sizeRelW: null, sizeRelH: null, zIndex: 0,
    relativeHeight: Number(attr(container, 'relativeHeight') ?? 0),
  };
  if (base.inline) return base;

  if (attr(container, 'simplePos') === '1') {
    const sp = kid(container, 'simplePos');
    base.h = { rel: 'page', align: null, offsetPt: emuToPt(attr(sp, 'x')), pct: null };
    base.v = { rel: 'page', align: null, offsetPt: emuToPt(attr(sp, 'y')), pct: null };
  } else {
    base.h = axis(kid(container, 'positionH'), 'column');
    base.v = axis(kid(container, 'positionV'), 'paragraph');
  }
  for (const w of ['wrapSquare', 'wrapTight', 'wrapThrough', 'wrapTopAndBottom', 'wrapNone'] as const) {
    const el = kid(container, w);
    if (!el) continue;
    base.wrap = w === 'wrapSquare' ? 'square' : w === 'wrapTight' ? 'tight' : w === 'wrapThrough' ? 'through'
      : w === 'wrapTopAndBottom' ? 'topAndBottom' : 'none';
    base.wrapSide = attr(el, 'wrapText') ?? 'bothSides';
  }
  base.behind = attr(container, 'behindDoc') === '1';
  base.distPt = {
    t: emuToPt(attr(container, 'distT')), r: emuToPt(attr(container, 'distR')),
    b: emuToPt(attr(container, 'distB')), l: emuToPt(attr(container, 'distL')),
  };
  base.sizeRelW = sizeRel(kid(container, 'sizeRelH'), 'pctWidth');
  base.sizeRelH = sizeRel(kid(container, 'sizeRelV'), 'pctHeight');
  return base;
}

/** Maps a group's child coordinate space (EMU) into the drawing's extent (pt). */
interface GroupMap { ox: number; oy: number; sx: number; sy: number; cx0: number; cy0: number }

const point = (m: GroupMap, x: number, y: number) => ({ x: m.ox + (x - m.cx0) * m.sx, y: m.oy + (y - m.cy0) * m.sy });

function xfrmOf(spPr: Element | null) {
  const xfrm = kid(spPr, 'xfrm');
  const n = (el: Element | null, a: string) => Number(attr(el, a) ?? 0);
  return {
    x: n(kid(xfrm, 'off'), 'x'), y: n(kid(xfrm, 'off'), 'y'),
    cx: n(kid(xfrm, 'ext'), 'cx'), cy: n(kid(xfrm, 'ext'), 'cy'),
    chx: n(kid(xfrm, 'chOff'), 'x'), chy: n(kid(xfrm, 'chOff'), 'y'),
    chcx: n(kid(xfrm, 'chExt'), 'cx'), chcy: n(kid(xfrm, 'chExt'), 'cy'),
    rot: n(xfrm, 'rot') / 60000,
    flipH: attr(xfrm, 'flipH') === '1', flipV: attr(xfrm, 'flipV') === '1',
  };
}

interface Built { spec: ShapeSpec; txbxContent: Element | null }

function wspSpec(wsp: Element, rect: { x: number; y: number; w: number; h: number }, base: Omit<ShapeSpec, 'kind' | 'xPt' | 'yPt' | 'wPt' | 'hPt' | 'rotationDeg' | 'flipH' | 'flipV' | 'ellipse' | 'box' | 'line' | 'body' | 'pictureRelId'>, theme: Theme): Built {
  const spPr = kid(wsp, 'spPr');
  const styleEl = kid(wsp, 'style');
  const txbxContent = kid(kid(wsp, 'txbx'), 'txbxContent');
  const xf = xfrmOf(spPr);
  const geo = geometry(spPr);
  const line = lineStyle(spPr, styleEl, theme);
  const box: Record<string, string> = {};
  const kind: ShapeSpec['kind'] = geo.kind === 'line' ? 'line' : txbxContent ? 'textbox' : 'shape';
  if (kind !== 'line') {
    box.background = fillCss(spPr, styleEl, theme);
    box.border = line ? `${line.widthPt.toFixed(2)}pt ${line.style} ${line.color}` : 'none';
    if (geo.kind === 'roundRect') box.borderRadius = `${((geo.adj ?? 0.16667) * Math.min(rect.w, rect.h)).toFixed(2)}pt`;
    if (geo.kind === 'ellipse') box.borderRadius = '50%';
    const shadow = shadowCss(spPr, theme);
    if (shadow) box.boxShadow = shadow;
  }
  const color = textColorFromStyle(styleEl, theme);
  if (color) box.color = color;
  return {
    spec: {
      ...base, kind, xPt: rect.x, yPt: rect.y, wPt: rect.w, hPt: rect.h,
      rotationDeg: xf.rot, flipH: xf.flipH, flipV: xf.flipV, ellipse: geo.kind === 'ellipse',
      box, line, body: txbxContent ? bodyLayout(kid(wsp, 'bodyPr')) : null, pictureRelId: null,
    },
    txbxContent,
  };
}

function picSpec(pic: Element, rect: { x: number; y: number; w: number; h: number }, base: Omit<ShapeSpec, 'kind' | 'xPt' | 'yPt' | 'wPt' | 'hPt' | 'rotationDeg' | 'flipH' | 'flipV' | 'ellipse' | 'box' | 'line' | 'body' | 'pictureRelId'>): Built | null {
  const relId = attr(find(pic, 'blip'), 'embed');
  if (!relId) return null;
  const xf = xfrmOf(kid(pic, 'spPr'));
  return {
    spec: {
      ...base, kind: 'picture', xPt: rect.x, yPt: rect.y, wPt: rect.w, hPt: rect.h,
      rotationDeg: xf.rot, flipH: xf.flipH, flipV: xf.flipV, ellipse: false, box: {}, line: null, body: null, pictureRelId: relId,
    },
    txbxContent: null,
  };
}

function walkGroup(grp: Element, map: GroupMap, base: Parameters<typeof wspSpec>[2], theme: Theme, out: Built[]) {
  for (const c of Array.from(grp.children)) {
    const name = c.localName;
    if (name === 'wsp' || name === 'pic') {
      const xf = xfrmOf(kid(c, 'spPr'));
      const p = point(map, xf.x, xf.y);
      const rect = { x: p.x, y: p.y, w: xf.cx * map.sx, h: xf.cy * map.sy };
      const built = name === 'wsp' ? wspSpec(c, rect, base, theme) : picSpec(c, rect, base);
      if (built) out.push(built);
    } else if (name === 'grpSp' || name === 'wgp') {
      const xf = xfrmOf(kid(c, 'grpSpPr'));
      const p = point(map, xf.x, xf.y);
      walkGroup(c, {
        ox: p.x, oy: p.y,
        sx: map.sx * (xf.chcx ? xf.cx / xf.chcx : 1), sy: map.sy * (xf.chcy ? xf.cy / xf.chcy : 1),
        cx0: xf.chx, cy0: xf.chy,
      }, base, theme, out);
    }
  }
}

function markerPict(doc: Document, index: number, txbxContent: Element | null): Element {
  const pict = doc.createElementNS(W_NS, 'w:pict');
  const shape = doc.createElementNS(V_NS, 'v:shape');
  shape.setAttribute('style', `qso-txbx:${index}`);
  if (txbxContent) {
    const tb = doc.createElementNS(V_NS, 'v:textbox');
    tb.appendChild(txbxContent);
    shape.appendChild(tb);
  }
  pict.appendChild(shape);
  return pict;
}

function replaceWithMarkers(ctx: BuildCtx, target: Element, built: Built[]) {
  const parent = target.parentNode;
  if (!parent || built.length === 0) return;
  for (const b of built) {
    const index = ctx.specs.push(b.spec) - 1;
    parent.insertBefore(markerPict(ctx.doc, index, b.txbxContent), target);
  }
  parent.removeChild(target);
}

function handleDrawing(ctx: BuildCtx, drawing: Element, target: Element) {
  const sg = shapeGraphic(drawing);
  if (!sg) return;
  const anchor = parseDrawingAnchor(sg.container);
  const { w, h } = anchor.extentPt;
  const groupKey = `g${ctx.groupCounter.n++}`;
  const built: Built[] = [];
  const base = { anchor, groupKey, isGroupChild: sg.graphic.localName !== 'wsp' };

  if (sg.graphic.localName === 'wsp') {
    built.push(wspSpec(sg.graphic, { x: 0, y: 0, w, h }, base, ctx.theme));
  } else if (sg.graphic.localName === 'wgp') {
    const xf = xfrmOf(kid(sg.graphic, 'grpSpPr'));
    const ptPerEmu = 1 / 12700;
    walkGroup(sg.graphic, {
      ox: 0, oy: 0,
      sx: xf.chcx ? w / xf.chcx : ptPerEmu, sy: xf.chcy ? h / xf.chcy : ptPerEmu,
      cx0: xf.chx, cy0: xf.chy,
    }, base, ctx.theme, built);
  } else {
    // Drawing canvas: children use plain EMU offsets from the canvas origin.
    const ptPerEmu = 1 / 12700;
    walkGroup(sg.graphic, { ox: 0, oy: 0, sx: ptPerEmu, sy: ptPerEmu, cx0: 0, cy0: 0 }, base, ctx.theme, built);
  }
  replaceWithMarkers(ctx, target, built);
}

const VML_SHAPES = new Set(['shape', 'rect', 'roundrect', 'oval']);
const VML_HREL: Record<string, string> = {
  margin: 'margin', page: 'page', text: 'column', char: 'character',
  'left-margin-area': 'leftMargin', 'right-margin-area': 'rightMargin',
  'inner-margin-area': 'insideMargin', 'outer-margin-area': 'outsideMargin',
};
const VML_VREL: Record<string, string> = {
  margin: 'margin', page: 'page', text: 'paragraph', line: 'line',
  'top-margin-area': 'topMargin', 'bottom-margin-area': 'bottomMargin',
  'inner-margin-area': 'insideMargin', 'outer-margin-area': 'outsideMargin',
};

/** Legacy VML-only shape (older files with no DrawingML version). */
function handleVml(ctx: BuildCtx, pict: Element) {
  const shape = Array.from(pict.children).find((c) => VML_SHAPES.has(c.localName));
  if (!shape || kid(pict, 'group') || find(shape, 'imagedata') || find(shape, 'textpath')) return;
  const s = vmlStyle(attr(shape, 'style'));
  const textbox = kid(shape, 'textbox');
  const txbxContent = kid(textbox, 'txbxContent');
  const w = vmlLengthPt(s.width), h = vmlLengthPt(s.height);
  if (!txbxContent && attr(shape, 'filled') === 'f' && attr(shape, 'stroked') === 'f') return;

  const z = Number(s['z-index'] ?? 0);
  const wrapEl = kid(shape, 'wrap');
  const wrapType = attr(wrapEl, 'type');
  const halign = s['mso-position-horizontal'];
  const valign = s['mso-position-vertical'];
  const anchor: Anchor = {
    inline: s.position !== 'absolute',
    h: { rel: VML_HREL[s['mso-position-horizontal-relative'] ?? ''] ?? 'column', align: halign && halign !== 'absolute' ? halign : null, offsetPt: vmlLengthPt(s['margin-left'] ?? s.left), pct: null },
    v: { rel: VML_VREL[s['mso-position-vertical-relative'] ?? ''] ?? 'paragraph', align: valign && valign !== 'absolute' ? valign : null, offsetPt: vmlLengthPt(s['margin-top'] ?? s.top), pct: null },
    wrap: wrapType === 'square' || wrapType === 'tight' || wrapType === 'through' || wrapType === 'topAndBottom' ? wrapType : 'none',
    wrapSide: attr(wrapEl, 'side') ?? 'bothSides',
    behind: z < 0,
    distPt: {
      t: vmlLengthPt(s['mso-wrap-distance-top']), r: vmlLengthPt(s['mso-wrap-distance-right'], 9),
      b: vmlLengthPt(s['mso-wrap-distance-bottom']), l: vmlLengthPt(s['mso-wrap-distance-left'], 9),
    },
    extentPt: { w, h }, sizeRelW: null, sizeRelH: null, zIndex: 0, relativeHeight: Math.abs(z),
  };

  const box: Record<string, string> = {};
  box.background = attr(shape, 'filled') === 'f' || attr(shape, 'filled') === 'false' ? 'transparent' : vmlColor(attr(shape, 'fillcolor')) ?? '#ffffff';
  const stroked = attr(shape, 'stroked');
  if (stroked === 'f' || stroked === 'false') {
    box.border = 'none';
  } else {
    const dash = attr(kid(shape, 'stroke'), 'dashstyle') ?? 'solid';
    const style = dash === 'solid' ? 'solid' : /dot/i.test(dash) && !/dash/i.test(dash) ? 'dotted' : 'dashed';
    box.border = `${vmlLengthPt(attr(shape, 'strokeweight'), 0.75).toFixed(2)}pt ${style} ${vmlColor(attr(shape, 'strokecolor')) ?? '#000000'}`;
  }
  if (shape.localName === 'roundrect') box.borderRadius = `${(vmlFraction(attr(shape, 'arcsize'), 0.2) * Math.min(w, h)).toFixed(2)}pt`;
  if (shape.localName === 'oval') box.borderRadius = '50%';

  let body: BodyLayout | null = null;
  if (txbxContent) {
    const inset = (attr(textbox, 'inset') ?? '').split(',');
    const tb = vmlStyle(attr(textbox, 'style'));
    const anchorText = s['v-text-anchor'] ?? '';
    const flow = tb['layout-flow'] ?? '';
    body = {
      padPt: [vmlLengthPt(inset[1], 3.6), vmlLengthPt(inset[2], 7.2), vmlLengthPt(inset[3], 3.6), vmlLengthPt(inset[0], 7.2)],
      vAlign: anchorText.startsWith('middle') ? 'middle' : anchorText.startsWith('bottom') ? 'bottom' : 'top',
      writingMode: tb['mso-layout-flow-alt'] === 'bottom-to-top' ? 'vertical270' : flow.startsWith('vertical') ? 'vertical' : 'horizontal',
      noWrap: s['mso-wrap-style'] === 'none',
      autoFit: tb['mso-fit-shape-to-text'] === 't' || tb['mso-fit-shape-to-text'] === 'true',
    };
  }
  const flip = s.flip ?? '';
  const spec: ShapeSpec = {
    kind: txbxContent ? 'textbox' : 'shape', anchor, groupKey: `g${ctx.groupCounter.n++}`, isGroupChild: false,
    xPt: 0, yPt: 0, wPt: w, hPt: h, rotationDeg: Number(s.rotation?.replace(/fd$/, '') ?? 0) || 0,
    flipH: flip.includes('x'), flipV: flip.includes('y'), ellipse: shape.localName === 'oval', box, line: null, body, pictureRelId: null,
  };
  replaceWithMarkers(ctx, pict, [{ spec, txbxContent }]);
}

function processPart(ctx: BuildCtx) {
  const root = ctx.doc.documentElement;
  const before = ctx.specs.length;
  for (const el of Array.from(root.getElementsByTagName('*'))) {
    if (!root.contains(el)) continue; // removed along with an earlier shape's fallback
    if (el.localName === 'AlternateContent') {
      const drawing = find(kid(el, 'Choice'), 'drawing');
      if (drawing && shapeGraphic(drawing)) handleDrawing(ctx, drawing, el);
    } else if (el.localName === 'drawing' && !insideAlternateContent(el)) {
      handleDrawing(ctx, el, el);
    } else if (el.localName === 'pict' && !insideAlternateContent(el) && !MARKER_RE.test(attr(el.firstElementChild, 'style') ?? '')) {
      handleVml(ctx, el);
    }
  }
  return ctx.specs.length > before;
}

async function readXml(zip: JSZip, path: string): Promise<Document | null> {
  const s = await zip.file(path)?.async('string');
  return s ? parseXml(s) : null;
}

async function themePath(zip: JSZip): Promise<string> {
  const rels = await readXml(zip, 'word/_rels/document.xml.rels');
  const rel = Array.from(rels?.getElementsByTagName('Relationship') ?? []).find((r) => /\/theme$/.test(r.getAttribute('Type') ?? ''));
  const target = rel?.getAttribute('Target');
  return target ? `word/${target.replace(/^\.?\//, '')}` : 'word/theme/theme1.xml';
}

function assignZOrder(specs: ShapeSpec[]) {
  const anchors = Array.from(new Set(specs.map((s) => s.anchor))).sort((a, b) => a.relativeHeight - b.relativeHeight);
  anchors.forEach((a, i) => { a.zIndex = a.behind ? -1000 + i : 10 + i; });
}

/**
 * Returns a rewritten DOCX plus the shape specs, or null when the document has
 * no text boxes/shapes (the caller then renders the original file untouched).
 */
export async function preprocessDocx(blob: Blob): Promise<{ blob: Blob; specs: ShapeSpec[] } | null> {
  const zip = await JSZip.loadAsync(blob);
  const parts = Object.keys(zip.files).filter((p) => PART_RE.test(p));
  const theme = loadTheme(await readXml(zip, await themePath(zip)), await readXml(zip, 'word/settings.xml'));
  const specs: ShapeSpec[] = [];
  const groupCounter = { n: 0 };
  const serializer = new XMLSerializer();

  for (const path of parts) {
    const doc = await readXml(zip, path);
    if (!doc || doc.getElementsByTagName('parsererror').length) continue;
    if (processPart({ doc, theme, specs, groupCounter })) zip.file(path, serializer.serializeToString(doc));
  }
  if (specs.length === 0) return null;
  assignZOrder(specs);
  return { blob: await zip.generateAsync({ type: 'blob' }), specs };
}

// ─────────────────────────── 2. Swap parsed markers ───────────────────────────

interface DocNode {
  type?: string;
  children?: DocNode[];
  cssStyleText?: string;
  tagName?: string;
  [key: string]: unknown;
}

function foreignObjectChildren(node: DocNode): DocNode[] {
  for (const c of node.children ?? []) {
    if (c.tagName === 'foreignObject') return c.children ?? [];
    const hit = foreignObjectChildren(c);
    if (hit.length) return hit;
  }
  return [];
}

function swapMarkers(node: DocNode | undefined, specs: ShapeSpec[]) {
  const children = node?.children;
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    const m = c?.type === 'vmlPicture' ? MARKER_RE.exec(c.children?.[0]?.cssStyleText ?? '') : null;
    if (!m) { swapMarkers(c, specs); continue; }
    const index = Number(m[1]);
    const spec = specs[index];
    const content: DocNode[] = spec?.pictureRelId
      ? [{ type: 'image', src: spec.pictureRelId, cssStyle: { width: '100%', height: '100%', display: 'block' } }]
      : foreignObjectChildren(c);
    children[i] = {
      type: 'drawing', className: `qso-txbx qso-txbx-${index}`, cssStyle: {},
      children: [{ type: 'drawing', className: 'qso-txbx-inner', cssStyle: {}, children: content }],
    };
  }
}

/** Replace marker nodes in docx-preview's parsed document (from parseAsync). */
export function applyTextboxSpecs(wordDocument: { documentPart?: { body?: DocNode }; parts?: Array<{ rootElement?: DocNode }> }, specs: ShapeSpec[]) {
  swapMarkers(wordDocument.documentPart?.body, specs);
  for (const part of wordDocument.parts ?? []) swapMarkers(part.rootElement, specs);
}

// ─────────────────────────── 3. Place after render ───────────────────────────

interface Frame { start: number; len: number }

function offsetWithin(el: HTMLElement, ancestor: HTMLElement): { top: number; left: number } {
  let top = 0, left = 0;
  let n: HTMLElement | null = el;
  while (n && n !== ancestor) {
    top += n.offsetTop;
    left += n.offsetLeft;
    n = n.offsetParent as HTMLElement | null;
  }
  if (n === ancestor) return { top, left };
  const a = ancestor.getBoundingClientRect(), b = el.getBoundingClientRect();
  return { top: b.top - a.top, left: b.left - a.left };
}

function pagePadding(section: HTMLElement) {
  const cs = getComputedStyle(section);
  const width = section.offsetWidth;
  const minH = parseFloat(cs.minHeight);
  return {
    t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0,
    b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0,
    width, height: minH > 0 ? minH : section.offsetHeight,
  };
}

type Page = ReturnType<typeof pagePadding>;

function hFrame(rel: string, page: Page): Frame {
  switch (rel) {
    case 'page': return { start: 0, len: page.width };
    case 'leftMargin': case 'insideMargin': return { start: 0, len: page.l };
    case 'rightMargin': case 'outsideMargin': return { start: page.width - page.r, len: page.r };
    default: return { start: page.l, len: page.width - page.l - page.r }; // margin, column, character
  }
}

function vFrame(rel: string, page: Page, para: { top: number; height: number }): Frame {
  switch (rel) {
    case 'page': return { start: 0, len: page.height };
    case 'margin': return { start: page.t, len: page.height - page.t - page.b };
    case 'topMargin': case 'insideMargin': return { start: 0, len: page.t };
    case 'bottomMargin': case 'outsideMargin': return { start: page.height - page.b, len: page.b };
    default: return { start: para.top, len: para.height }; // paragraph, line
  }
}

function resolveAxis(pos: AxisPos, frame: Frame, size: number): number {
  if (pos.pct != null) return frame.start + (pos.pct / 100000) * frame.len;
  switch (pos.align) {
    case 'left': case 'top': case 'inside': return frame.start;
    case 'center': return frame.start + (frame.len - size) / 2;
    case 'right': case 'bottom': case 'outside': return frame.start + frame.len - size;
    default: return frame.start + pos.offsetPt * PX_PER_PT;
  }
}

function styleBox(el: HTMLElement, spec: ShapeSpec, wPx: number, hPx: number) {
  const inner = el.firstElementChild as HTMLElement | null;
  const s = el.style;
  s.margin = '0';
  s.textIndent = '0';
  s.boxSizing = 'border-box';

  if (spec.kind === 'line' && spec.line) {
    const flipped = spec.flipH !== spec.flipV;
    s.width = `${Math.hypot(wPx, hPx)}px`;
    s.height = '0';
    s.borderTop = `${spec.line.widthPt}pt ${spec.line.style} ${spec.line.color}`;
    s.transformOrigin = '0 0';
    s.transform = `rotate(${(flipped ? -1 : 1) * Math.atan2(hPx, wPx)}rad)`;
    if (inner) inner.style.display = 'none';
    return;
  }

  Object.assign(s, spec.box);
  // Flex so the inner content always fills the box (needed for vertical anchoring,
  // including auto-fit boxes whose height is only a minimum).
  s.display = spec.anchor.inline ? 'inline-flex' : 'flex';
  s.flexDirection = 'column';
  s.width = `${wPx}px`;
  const autoFit = spec.body?.autoFit ?? false;
  s.height = autoFit ? 'auto' : `${hPx}px`;
  s.minHeight = autoFit ? `${hPx}px` : '';
  s.overflow = autoFit ? 'visible' : 'hidden';
  const transforms: string[] = [];
  if (spec.rotationDeg) transforms.push(`rotate(${spec.rotationDeg}deg)`);
  // Word mirrors a flipped shape's outline but never its text.
  if (spec.kind !== 'textbox' && spec.flipH) transforms.push('scaleX(-1)');
  if (spec.kind !== 'textbox' && spec.flipV) transforms.push('scaleY(-1)');
  s.transform = transforms.join(' ');

  if (!inner) return;
  const i = inner.style;
  i.display = 'flex';
  i.flexDirection = 'column';
  i.boxSizing = 'border-box';
  i.width = '100%';
  i.flex = '1 1 auto';
  i.minHeight = '0';
  i.position = 'static';
  const b = spec.body;
  if (b) {
    // Word keeps an ellipse's text inside its inscribed rectangle (~14.6% in per side).
    const ex = spec.ellipse ? spec.wPt * 0.1464 : 0, ey = spec.ellipse ? spec.hPt * 0.1464 : 0;
    const [pt, pr, pb, pl] = b.padPt;
    i.padding = [pt + ey, pr + ex, pb + ey, pl + ex].map((p) => `${p.toFixed(2)}pt`).join(' ');
    i.justifyContent = b.vAlign === 'middle' ? 'center' : b.vAlign === 'bottom' ? 'flex-end' : 'flex-start';
    if (b.noWrap) i.whiteSpace = 'nowrap';
    if (b.writingMode !== 'horizontal') {
      i.writingMode = 'vertical-rl';
      if (b.writingMode === 'vertical270') i.transform = 'rotate(180deg)';
    }
  }
}

function makeSpacer(css: Partial<CSSStyleDeclaration>): HTMLElement {
  const d = document.createElement('span');
  d.className = 'qso-txbx-spacer';
  d.setAttribute('aria-hidden', 'true');
  Object.assign(d.style, { display: 'block', ...css });
  return d;
}

/** Reserve space in the anchor paragraph so text flows around the box like Word's wrapping. */
function insertWrapSpacers(
  para: HTMLElement, spec: ShapeSpec, page: Page, paraTop: number,
  box: { left: number; top: number; width: number; height: number },
) {
  const a = spec.anchor;
  const d = { t: a.distPt.t * PX_PER_PT, r: a.distPt.r * PX_PER_PT, b: a.distPt.b * PX_PER_PT, l: a.distPt.l * PX_PER_PT };
  const contentLeft = page.l, contentRight = page.width - page.r;
  let side: 'left' | 'right';
  let width: number;
  if (a.wrap === 'topAndBottom') {
    side = 'left';
    width = contentRight - contentLeft;
  } else {
    const center = box.left + box.width / 2;
    side = a.wrapSide === 'left' ? 'right' : a.wrapSide === 'right' ? 'left' : center < (contentLeft + contentRight) / 2 ? 'left' : 'right';
    width = side === 'left' ? box.left + box.width + d.r - contentLeft : contentRight - (box.left - d.l);
    width = Math.max(0, Math.min(contentRight - contentLeft, width));
  }
  const gap = box.top - d.t - paraTop;
  const height = box.height + d.t + d.b + Math.min(0, gap);
  if (width <= 0 || height <= 0) return;

  const spacers: HTMLElement[] = [];
  if (gap > 0) spacers.push(makeSpacer({ cssFloat: side, width: '0', height: `${gap}px` }));
  spacers.push(makeSpacer({ cssFloat: side, clear: gap > 0 ? side : 'none', width: `${width}px`, height: `${height}px` }));
  for (const sp of spacers.reverse()) para.insertBefore(sp, para.firstChild);
}

/** Style and position every text box rendered by docx-preview inside `container`. */
export function placeTextboxes(container: HTMLElement, specs: ShapeSpec[]) {
  for (const section of container.querySelectorAll<HTMLElement>('section.docx')) {
    section.style.position = 'relative';
    section.style.isolation = 'isolate';
  }

  // Take anchored boxes out of the text flow before measuring anything.
  const boxes = Array.from(container.querySelectorAll<HTMLElement>('.qso-txbx')).map((el) => {
    const m = /qso-txbx-(\d+)/.exec(el.className);
    const spec = m ? specs[Number(m[1])] : undefined;
    return { el, spec, para: el.parentElement?.closest('p') as HTMLElement | null, section: el.closest('section.docx') as HTMLElement | null };
  });
  for (const b of boxes) if (b.spec && !b.spec.anchor.inline) b.el.style.display = 'none';

  const sections = Array.from(container.querySelectorAll<HTMLElement>('section.docx'));
  const spacered = new Set<string>();
  boxes.forEach((b) => {
    const { el, spec, para, section } = b;
    if (!spec) return;
    const a = spec.anchor;
    const page = section ? pagePadding(section) : null;
    let wPx = spec.wPt * PX_PER_PT, hPx = spec.hPt * PX_PER_PT;
    if (page && !spec.isGroupChild && a.sizeRelW) wPx = (a.sizeRelW.pct / 100000) * hFrame(a.sizeRelW.rel, page).len;
    if (page && !spec.isGroupChild && a.sizeRelH) hPx = (a.sizeRelH.pct / 100000) * vFrame(a.sizeRelH.rel, page, { top: 0, height: 0 }).len;

    if (a.inline || !section || !page) {
      el.style.display = 'inline-block';
      el.style.verticalAlign = 'bottom';
      el.style.position = 'relative';
      styleBox(el, spec, wPx, hPx);
      return;
    }

    const paraPos = para ? offsetWithin(para, section) : { top: page.t, left: page.l };
    const paraBox = { top: paraPos.top, height: para?.offsetHeight ?? 0 };
    const groupW = spec.isGroupChild ? a.extentPt.w * PX_PER_PT : wPx;
    const groupH = spec.isGroupChild ? a.extentPt.h * PX_PER_PT : hPx;
    const originX = resolveAxis(a.h, hFrame(a.h.rel, page), groupW);
    const originY = resolveAxis(a.v, vFrame(a.v.rel, page, paraBox), groupH);
    const left = originX + spec.xPt * PX_PER_PT;
    const lineFlipped = spec.kind === 'line' && spec.flipH !== spec.flipV;
    const top = originY + spec.yPt * PX_PER_PT + (lineFlipped ? hPx : 0);

    // Header copies repeat per page, so wrap space is reserved once per group per page.
    const groupKey = `${spec.groupKey}@${sections.indexOf(section)}`;
    if (para && !a.behind && a.wrap !== 'none' && !spacered.has(groupKey)) {
      spacered.add(groupKey);
      insertWrapSpacers(para, spec, page, paraPos.top, { left: originX, top: originY, width: groupW, height: groupH });
    }

    section.appendChild(el);
    el.style.display = 'block';
    el.style.position = 'absolute';
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.zIndex = String(a.zIndex);
    styleBox(el, spec, wPx, hPx);
  });
}
