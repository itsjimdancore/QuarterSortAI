import { OcrEngine, ScannedFile } from '../types';
import { classifyFileQuarter, extractMetadataFromDocx, extractMetadataFromPDF } from './quarterEngine';
import { serverOcr, SERVER_OCR_MAX_BYTES, ServerOcrResult } from './serverOcr';
import type { PDFDocumentProxy } from 'pdfjs-dist';

// ── Server OCR fallback ──
// Browser OCR (tesseract.js) always runs first. When its result is weak, the
// image (or rendered scanned-PDF pages) is sent to the Python RapidOCR function.
// Privacy: files only leave the device when this fallback actually runs.
// Disable with VITE_SERVER_OCR_ENABLED=false in .env.
export const SERVER_OCR_ENABLED = import.meta.env.VITE_SERVER_OCR_ENABLED !== 'false';

// "Weak result" thresholds — any one of these triggers the fallback.
const WEAK_MIN_TEXT_LENGTH = 25;
const WEAK_MIN_ALNUM_RATIO = 0.5;
const WEAK_MIN_CONFIDENCE = 60;

// Upload preparation (keeps requests under the function's 4 MB limit).
const UPLOAD_MAX_SIDE_PX = 2000;
const UPLOAD_JPEG_QUALITY = 0.85;
const SCANNED_PDF_MAX_PAGES = 2;

const CONTENT_EXTS = new Set(['jpg', 'jpeg', 'png', 'tiff', 'tif', 'bmp', 'heic', 'docx', 'pdf']);

export interface OCRProgress {
  current: number;
  total: number;
  fileName: string;
}

interface ExtractResult {
  text: string;
  engine: OcrEngine;
}

function alnumCount(text: string): number {
  return (text.match(/[\p{L}\p{N}]/gu) || []).length;
}

/** True when an OCR result is too short, mostly garbage, or low-confidence. */
export function isWeakOcr(text: string, confidence?: number): boolean {
  const trimmed = text.trim();
  if (trimmed.length < WEAK_MIN_TEXT_LENGTH) return true;
  const nonSpace = trimmed.replace(/\s/g, '').length;
  if (nonSpace === 0 || alnumCount(trimmed) / nonSpace < WEAK_MIN_ALNUM_RATIO) return true;
  if (confidence !== undefined && confidence < WEAK_MIN_CONFIDENCE) return true;
  return false;
}

/**
 * Prefer the server result only if it is better: more meaningful (letter/digit)
 * text, or higher confidence without losing most of the text.
 */
function serverIsBetter(browserText: string, browserConfidence: number, server: ServerOcrResult): boolean {
  const serverChars = alnumCount(server.text);
  if (serverChars === 0) return false;
  const browserChars = alnumCount(browserText);
  if (serverChars > browserChars) return true;
  return server.confidence > browserConfidence && serverChars >= browserChars * 0.5;
}

async function readBlob(file: ScannedFile): Promise<Blob | null> {
  if (!file.handle) return null;
  try {
    if ('getFile' in file.handle) {
      return await (file.handle as FileSystemFileHandle).getFile();
    } else if (file.handle instanceof File) {
      return file.handle;
    }
  } catch {}
  return null;
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', UPLOAD_JPEG_QUALITY));
}

/** Downscale so the longest side is <= 2000 px and re-encode as JPEG. */
async function prepareImageForUpload(blob: Blob): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, UPLOAD_MAX_SIDE_PX / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#fff'; // flatten transparency (JPEG has no alpha)
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const jpeg = await canvasToJpeg(canvas);
    return jpeg && jpeg.size <= SERVER_OCR_MAX_BYTES ? jpeg : null;
  } catch {
    return null; // e.g. HEIC, which most browsers can't decode
  }
}

async function extractImageText(blob: Blob, fileName: string): Promise<ExtractResult> {
  const { recognize } = await import('tesseract.js');
  let text = '';
  let confidence = 0;
  try {
    const { data } = await recognize(blob, 'eng');
    text = data.text.trim();
    confidence = data.confidence;
  } catch {}

  if (!SERVER_OCR_ENABLED || !isWeakOcr(text, confidence)) {
    return { text, engine: 'tesseract' };
  }

  console.info(`[ocr] weak tesseract result for ${fileName} (${text.length} chars, confidence ${confidence.toFixed(1)}); trying server fallback`);
  const upload = await prepareImageForUpload(blob);
  const server = upload ? await serverOcr(upload, `${fileName}.jpg`) : null;
  if (server && serverIsBetter(text, confidence, server)) {
    return { text: server.text.trim(), engine: 'rapidocr' };
  }
  return { text, engine: 'tesseract' };
}

async function loadPdfjs() {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.2.108/pdf.worker.min.mjs';
  return pdfjsLib;
}

async function extractPdf(blob: Blob, fileName: string): Promise<ExtractResult> {
  let pdf: PDFDocumentProxy;
  try {
    const pdfjsLib = await loadPdfjs();
    pdf = await pdfjsLib.getDocument({ data: await blob.arrayBuffer() }).promise;
  } catch {
    return { text: '', engine: 'pdf-text' };
  }

  let text = '';
  try {
    const texts: string[] = [];
    for (let p = 1; p <= Math.min(pdf.numPages, 10); p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      texts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
    }
    text = texts.join('\n').trim();
  } catch {}

  if (!SERVER_OCR_ENABLED || !isWeakOcr(text)) {
    return { text, engine: 'pdf-text' };
  }

  // Likely a scanned PDF: render the first pages and OCR them on the server.
  console.info(`[ocr] weak PDF text for ${fileName} (${text.length} chars); rendering pages for server fallback`);
  const pageTexts: string[] = [];
  const confidences: number[] = [];
  try {
    for (let p = 1; p <= Math.min(pdf.numPages, SCANNED_PDF_MAX_PAGES); p++) {
      const page = await pdf.getPage(p);
      const base = page.getViewport({ scale: 1 });
      const scale = UPLOAD_MAX_SIDE_PX / Math.max(base.width, base.height);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvas, viewport }).promise;
      const jpeg = await canvasToJpeg(canvas);
      if (!jpeg || jpeg.size > SERVER_OCR_MAX_BYTES) continue;
      const result = await serverOcr(jpeg, `${fileName}-p${p}.jpg`);
      if (result && result.text.trim()) {
        pageTexts.push(result.text.trim());
        confidences.push(result.confidence);
      }
    }
  } catch {}

  if (pageTexts.length > 0) {
    const server: ServerOcrResult = {
      text: pageTexts.join('\n'),
      confidence: confidences.reduce((a, b) => a + b, 0) / confidences.length,
    };
    // pdf.js text has no confidence score, so only meaningful length decides here.
    if (alnumCount(server.text) > alnumCount(text)) {
      return { text: server.text, engine: 'rapidocr' };
    }
  }
  return { text, engine: 'pdf-text' };
}

export async function runOCR(
  files: ScannedFile[],
  onProgress?: (p: OCRProgress) => void
): Promise<void> {
  const toProcess = files.filter(f => CONTENT_EXTS.has(f.extension));
  if (toProcess.length === 0) return;

  const BATCH_SIZE = 4;

  for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
    const batch = toProcess.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (file) => {
      onProgress?.({ current: i + batch.indexOf(file), total: toProcess.length, fileName: file.name });
      const blob = await readBlob(file);
      if (!blob) return;
      let text = '';
      let engine: OcrEngine = 'tesseract';
      let embeddedDate: string | undefined;
      try {
        if (file.extension === 'docx') {
          const arrayBuffer = await blob.arrayBuffer();
          const { extractRawText } = await import('mammoth');
          const result = await extractRawText({ arrayBuffer });
          text = result.value.trim();
          engine = 'docx';
          const meta = extractMetadataFromDocx(arrayBuffer);
          embeddedDate = meta.createdDate || meta.modifiedDate;
        } else if (file.extension === 'pdf') {
          ({ text, engine } = await extractPdf(blob, file.name));
        } else {
          ({ text, engine } = await extractImageText(blob, file.name));
        }
        if (text || embeddedDate) {
          file.classification = classifyFileQuarter(
            file.name,
            file.folderPath || '/',
            file.modifiedDate,
            file.createdDate,
            embeddedDate,
            text
          );
          if (text) {
            file.textContent = text.slice(0, 10000);
            file.ocrEngine = engine;
          }
        }
      } catch {}
      onProgress?.({ current: i + batch.indexOf(file) + 1, total: toProcess.length, fileName: file.name });
    }));
  }
}
