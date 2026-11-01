// Client for the Python OCR fallback (api/ocr.py). Only called when the
// in-browser tesseract.js result is weak. Every failure resolves to null so the
// caller silently keeps the browser result.

export interface ServerOcrResult {
  text: string;
  confidence: number;
}

/** Vercel rejects request bodies over ~4.5 MB; the function enforces 4 MB. */
export const SERVER_OCR_MAX_BYTES = 4 * 1024 * 1024;
const SERVER_OCR_TIMEOUT_MS = 20_000;
/** Independent of the OCR batch size so a large scan can't flood the function. */
const SERVER_OCR_MAX_CONCURRENT = 2;

const OCR_ENDPOINT = `${import.meta.env.VITE_OCR_API_URL ?? ''}/api/ocr`;

let active = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < SERVER_OCR_MAX_CONCURRENT) {
    active++;
    return;
  }
  // The releasing caller hands its slot straight to us, so `active` is unchanged.
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

function isServerOcrResult(value: unknown): value is ServerOcrResult {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.text === 'string' && typeof v.confidence === 'number';
}

export async function serverOcr(blob: Blob, fileName = 'page.jpg'): Promise<ServerOcrResult | null> {
  if (blob.size === 0 || blob.size > SERVER_OCR_MAX_BYTES) return null;

  await acquire();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVER_OCR_TIMEOUT_MS);
  const started = performance.now();
  try {
    const form = new FormData();
    form.append('file', blob, fileName);
    const res = await fetch(OCR_ENDPOINT, { method: 'POST', body: form, signal: controller.signal });
    if (!res.ok) {
      console.info(`[ocr] server fallback HTTP ${res.status} for ${fileName}; keeping browser result`);
      return null;
    }
    const data: unknown = await res.json();
    if (!isServerOcrResult(data)) return null;
    console.info(
      `[ocr] server fallback (rapidocr) ${fileName}: ${data.text.length} chars, ` +
        `confidence ${data.confidence.toFixed(1)}, ${Math.round(performance.now() - started)} ms`
    );
    return { text: data.text, confidence: data.confidence };
  } catch {
    console.info(`[ocr] server fallback unavailable for ${fileName}; keeping browser result`);
    return null;
  } finally {
    clearTimeout(timer);
    release();
  }
}
