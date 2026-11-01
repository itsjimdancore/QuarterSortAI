import React, { useCallback, useEffect, useRef, useState } from 'react';
import { readFileBlob } from '../../lib/blob';
import { extractDocxComments, extractDocxHeadings, countWords } from '../../lib/docxMeta';
import { applySearchHighlights, collectMatchElements, scrollElementIntoView } from '../../lib/domSearch';
import { useActivePage } from '../../hooks/useActivePage';
import { ViewerRenderProps } from './types';
import { PRINT_PAGE_CSS } from '../../lib/printSupport';
import { applyTextboxSpecs, placeTextboxes, preprocessDocx } from '../../lib/docxTextboxes';

export const DocxRenderer: React.FC<ViewerRenderProps> = (props) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [baseSize, setBaseSize] = useState<{ w: number; h: number } | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const matchesRef = useRef<HTMLElement[]>([]);
  const searchQueryRef = useRef(props.searchQuery);

  const { activePage, goToPage, rescan } = useActivePage(containerRef, 'section.docx.qso-docx-page');

  const applySearch = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const wrapper = container.querySelector('.docx-wrapper') as HTMLElement | null;
    if (!wrapper) return;
    const count = applySearchHighlights(wrapper, searchQueryRef.current);
    matchesRef.current = collectMatchElements(wrapper);
    props.onMatchCount(count);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    searchQueryRef.current = props.searchQuery;
    applySearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.searchQuery]);

  useEffect(() => {
    if (props.activeMatch < 1 || matchesRef.current.length === 0) return;
    const container = containerRef.current;
    if (!container) return;
    const el = matchesRef.current[Math.min(props.activeMatch - 1, matchesRef.current.length - 1)];
    scrollElementIntoView(el, container);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.activeMatch]);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const blob = await readFileBlob(props.file);
        if (!blob) {
          throw new Error('No .docx binary available. This file only has cached text preview data.');
        }
        if (!container) return;
        container.innerHTML = '';

        const styleHost = document.createElement('div');
        styleHost.id = 'qso-docx-styles';
        document.body.appendChild(styleHost);

        const { renderAsync, parseAsync, renderDocument } = await import('docx-preview');
        const options = {
          className: 'docx',
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: false,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          renderComments: true,
          renderChanges: false,
        };

        // Text boxes/shapes get Word-like rendering; any failure falls back to
        // plain docx-preview so the document still displays.
        let rendered = false;
        try {
          const prepared = await preprocessDocx(blob);
          if (prepared) {
            const doc = await parseAsync(prepared.blob, options);
            applyTextboxSpecs(doc, prepared.specs);
            const nodes = await renderDocument(doc, options);
            if (cancelled) return;
            styleHost.innerHTML = '';
            container.innerHTML = '';
            for (const n of nodes) (n.nodeName === 'STYLE' ? styleHost : container).appendChild(n);
            placeTextboxes(container, prepared.specs);
            rendered = true;
          }
        } catch (textboxErr) {
          console.warn('[docx] text box rendering failed; using default renderer', textboxErr);
        }
        if (!rendered) await renderAsync(blob, container, styleHost, options);

        if (cancelled) return;

        const pages = Array.from(container.querySelectorAll('section.docx')) as HTMLElement[];
        pages.forEach((p) => p.classList.add('qso-docx-page'));
        props.onPageCount(pages.length);

        if (pages.length > 0) {
          const first = pages[0] as HTMLElement;
          setBaseSize({ w: first.clientWidth, h: first.clientHeight });
        }

        const text = container.textContent || '';
        props.onWordCount(countWords(text));
        props.onTextExtracted(text.slice(0, 20000));

        // attach TOC anchors
        const toc = await extractDocxHeadings(blob);
        props.onToc(toc);
        for (const item of toc) {
          const target = (Array.from(container.querySelectorAll('section.docx p')) as HTMLElement[]).find(
            (p) => (p.textContent || '').trim() === item.text
          );
          if (target) target.dataset.qsoToc = item.id;
        }

        // comments
        const comments = await extractDocxComments(blob);
        props.onComments(comments);

        rescan();
        applySearch();
        setLoading(false);
      } catch (e: any) {
        if (!cancelled) {
          setError(e.message || 'Failed to render document');
          setLoading(false);
        }
      }
    };
    load();
    return () => {
      cancelled = true;
      if (container) container.innerHTML = '';
      document.getElementById('qso-docx-styles')?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.file]);

  // fit-to-width / fit-to-page scale
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !baseSize) return;
    const compute = () => {
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      if (props.scaleMode === 'fitWidth') {
        setFitScale(Math.max(0.25, (cw - 48) / baseSize.w));
      } else if (props.scaleMode === 'fitPage') {
        const sx = (cw - 48) / baseSize.w;
        const sy = (ch - 48) / baseSize.h;
        setFitScale(Math.max(0.2, Math.min(sx, sy)));
      }
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(container);
    return () => ro.disconnect();
  }, [props.scaleMode, baseSize, containerRef]);

  const effectiveScale = props.scaleMode === 'custom' ? props.scale : fitScale;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const wrapper = container.querySelector('.docx-wrapper') as HTMLElement | null;
    if (wrapper) wrapper.style.zoom = String(effectiveScale);
  }, [effectiveScale]);

  useEffect(() => {
    props.onPageChange(activePage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePage]);

  useEffect(() => {
    props.registerNav(goToPage);
    return () => props.registerNav(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goToPage]);

  useEffect(() => {
    props.registerTocNav?.((item) => {
      const container = containerRef.current;
      if (!container) return;
      const el = container.querySelector(`[data-qso-toc="${item.id}"]`) as HTMLElement | null;
      if (!el) return;
      const target = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      container.scrollTo({ top: target, behavior: 'smooth' });
    });
    return () => props.registerTocNav?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    props.registerPrint?.(() => {
      const container = containerRef.current;
      if (!container) return null;
      const wrapper = container.querySelector('.docx-wrapper');
      if (!wrapper) return null;
      const libCss = document.getElementById('qso-docx-styles')?.textContent || '';
      const html = `<div class="docx-wrapper">${wrapper.innerHTML}</div>`;
      return { title: props.file.name, html, css: `${PRINT_PAGE_CSS}\n${libCss}` };
    });
    return () => props.registerPrint?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative flex-1 overflow-hidden">
      <div ref={containerRef} className="absolute inset-0 overflow-y-auto overflow-x-hidden" />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-100/80 dark:bg-slate-900/60">
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <div className="h-4 w-4 rounded-full border-2 border-slate-600 border-t-emerald-500 animate-spin" />
            Rendering Word document...
          </div>
        </div>
      )}
      {error && !loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-100/80 dark:bg-slate-900/60">
          <div className="text-center text-slate-500 max-w-md px-4">
            <p className="text-sm font-semibold text-amber-500 mb-1">Word preview unavailable</p>
            <p className="text-xs text-slate-400">{error}</p>
          </div>
        </div>
      )}
    </div>
  );
};
