<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ik.imagekit.io/jimdanliveurl/quartersortai.png" />
</div>

<div align="center">

# QuarterSort AI

**Intelligent USB Document Explorer & Financial Quarter Classifier**

A full-stack scan pipeline that indexes a USB drive in the browser, hashes every file (SHA-256), classifies each one into a financial quarter via a prioritized inference chain, persists the index to IndexedDB, and serves Gemini-powered audit reports from an Express backend.

</div>

View your app in AI Studio: https://ai.studio/apps/67189208-ea77-4a75-be78-9c8e14bf4335

---

## Table of Contents

- [Overview](#overview)
- [Design Goals](#design-goals)
- [System Architecture](#system-architecture)
- [Data Flow: A Scan in Detail](#data-flow-a-scan-in-detail)
- [Core Data Models](#core-data-models)
- [Engines](#engines)
  - [scannerEngine — the scan loop](#scannerengine--the-scan-loop)
  - [quarterEngine — classification chain](#quarterengine--classification-chain)
  - [ocrEngine — content extraction](#ocrengine--content-extraction)
  - [diskMatch — root to physical disk](#diskmatch--root-to-physical-disk)
- [Backend & API Contracts](#backend--api-contracts)
- [Persistence Layer](#persistence-layer)
- [UI / State Architecture](#ui--state-architecture)
- [Performance & Concurrency Notes](#performance--concurrency-notes)
- [Error Handling & Edge Cases](#error-handling--edge-cases)
- [Security Model](#security-model)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [Extending the Codebase](#extending-the-codebase)
- [Known Limitations](#known-limitations)

---

## Overview

QuarterSort AI solves a boring, recurring problem: **what's actually on this USB drive, and where does each file belong in the fiscal year?**

The system is a single Node process (Express + Vite) that serves a React SPA and a small API. Scanning itself happens entirely in the browser via the File System Access API, so the OS never sees the drive mounted at a fixed path and no file contents are ever transmitted. Each scanned file gets:

1. A **SHA-256 content hash** (content-addressed identity / duplicate detection).
2. A **financial-quarter classification** resolved from the strongest available signal.
3. A category inferred from its extension.

The result is streamed to the UI (batch-by-batch progress), persisted to IndexedDB, and then explored through quarter dashboards, a filterable folder tree, analytics charts, and an optional Gemini AI audit report.

---

## Design Goals

The implementation is shaped by four explicit constraints:

| Goal | Implication in code |
|---|---|
| **Zero-upload privacy** | All hashing, classification, and duplicate detection run client-side (`src/lib/*`). The backend only ever receives aggregate summary metrics. |
| **Read-only by design** | The scanner only reads `FileSystemFileHandle`s; there is no write path anywhere in the scan pipeline. |
| **Graceful degradation** | No `GEMINI_API_KEY` → deterministic synthetic report; no File System Access API → demo dataset; no disk match → user picks the drive or keeps estimates. |
| **Dev/prod parity** | One Express server serves both Vite middleware (dev) and the static `dist/` bundle (prod) on port `5454`. |

---

## System Architecture

```
┌────────────────────────────── BROWSER (React SPA) ──────────────────────────────┐
│                                                                                 │
│  LandingPage ──► App.tsx ──► CyberScannerModal (streaming scan console)        │
│                    │                                                            │
│      scanFileList / scanUSBDirectoryHandle  (File System Access read-only)     │
│                    ▼                                                            │
│       scannerEngine ──► quarterEngine   (classification inference chain)       │
│           │   └──────► ocrEngine       (Tesseract.js / PDF.js / Mammoth)       │
│           │   └──────► diskMatch       (scanned root → physical disk)          │
│                    ▼                                                            │
│       IndexedDB: scanned_files · volume_info · ai_insights                     │
│                                                                                 │
│       [Views: Quarter Summary · Explorer · Photo Gallery · Duplicate Center    │
│        USB Overview · Analytics & Trends · AI Audit Report]                   │
└───────────────┬─────────────────────────────────────────────┬───────────────────┘
                │ fetch('/api/...')                            │ execute (read-only)
                ▼                                              ▼
┌──────────────────────────────────────┐     ┌───────────────────────────────────┐
│  Express server  (0.0.0.0:5454)      │     │  Host OS                          │
│  /api/health        GET              │     │  win32: PowerShell / WMIC         │
│  /api/disk-stats    GET              │     │  posix: df -P / lsblk -J          │
│  /api/ai-insights   POST             │     └───────────────────────────────────┘
│  /api/document-insights POST         │
│  Vite middleware (dev)               │
│  static dist/  + SPA fallback (prod) │
└───────────────┬──────────────────────┘
                │ only when GEMINI_API_KEY is set
                ▼
        Google Gemini API  (gemini-3.6-flash, JSON output)
```

**Two process boundaries worth calling out**

- The **scan pipeline is browser-local**; the async work is not delegatable to the server because the source of truth (the File handles) lives in the browser tab.
- The **API surface is intentionally thin** — it exists for Gemini calls and host-side disk introspection, not for data storage.

---

## Data Flow: A Scan in Detail

Triggered from `App.tsx` → `triggerFileInputFallback()` (or the FileSystemDirectoryHandle path in `scanUSBDirectoryHandle`).

1. **User gesture opens a picker.** A hidden `<input webkitdirectory multiple>` is clicked; the browser grants access to the chosen folder. `App.tsx` keeps the `FileList`, sets `isScanning`, and calls `scanFileList(files, onProgress, { enableOCR })`.
2. **Recursive walk.** `scannerEngine` iterates the flat `FileList` (or walks the directory handle tree), skipping entries matched by `IGNORE_DIRECTORIES` (`$RECYCLE.BIN`, `System Volume Information`, `node_modules`, dot-prefixed dirs, `Thumbs.db`, macOS staging files, …).
3. **Per-file processing.** For each file:
   - extension → `getFileCategory()` (Documents / Images / Videos / Audio / Archives / Executables / Other),
   - `classifyFileQuarter(name, folderPath, modifiedDate, createdDate)` → `QuarterClassification`,
   - SHA-256 digest (`computeFileHash`),
   - assembled into a `ScannedFile` and pushed to the working array.
4. **Progress streaming.** Every 10th file, `onProgress` is invoked with a snapshot (`filesBatch: [...scannedFiles]`, counters, current folder/file, log stream). `App.tsx` forwards this to the `<CyberScannerModal>` — the UI never polls; it renders what the callback pushed.
5. **Duplicate pass.** Files are grouped by hash; any group with >1 member gets `isDuplicate = true` + `duplicateGroupHash`.
6. **Optional OCR pass** (`enableOCR`). `ocrEngine` batches processable files (images, PDF, DOCX) through Tesseract/mammoth/PDF.js; successes **re-run classification** with real content (`file.classification` is mutated in place).
7. **Volume info synthesis.** `scannerEngine` estimates capacity (bucket function on total bytes) and fabricates filesystem/serial fields, all flagged `capacityEstimated: true`.
8. **Disk reconciliation.** `diskMatch.matchPhysicalDisk()` compares the scanned root name against `/api/disk-stats` results (drives fetched with a 10 s abort timeout). Exact label match wins, then partial. If matched, real capacity/free-space replace the estimates; otherwise the user picks a drive in `<DriveConfirmModal>` or keeps estimates.
9. **Persistence.** `saveScannedIndexToDB(files, volumeInfo)` writes to IndexedDB (stripping non-serializable `handle`s).

> The scan is a **single streaming transaction**: progress is reported in batches, but state isn't "committed" until the final `onProgress(isComplete: true)` and the IndexedDB write.

---

## Core Data Models

All types live in `src/types/index.ts`.

### `ScannedFile` — the unit of work

```ts
interface ScannedFile {
  id: string;            // `${sha256.slice(0,16)}_${ordinal}` — stable per file
  path / relativePath / folderPath; // virtual tree position
  extension; size; category;
  createdDate; modifiedDate;  // Date (re-wrapped on IndexedDB restore)
  sha256: string;             // content-addressed identity
  classification: QuarterClassification;
  metadata?: FileMetadata;    // title, author, dates, EXIF, page/sheet counts…
  handle?: FileSystemFileHandle | File;  // NOT persisted to IndexedDB
  contentUrl?; textContent?;  // lazily materialized preview artifacts
  isDuplicate?; duplicateGroupHash?;
}
```

Historical note: `sha256` is content-addressed *sampling* for files > 10 MB (only the first 1 MB is digested — a deliberate speed/accuracy tradeoff discussed in [Performance](#performance--concurrency-notes)).

### `QuarterClassification` — the classifier's contract

```ts
interface QuarterClassification {
  quarter: QuarterId;         // 'Q1' | 'Q2' | 'Q3' | 'Q4'
  month: MonthName; monthNumber: number;
  financialYear: string;      // e.g. "FY 2025-2026" (July-start fiscal year)
  year: number; effectiveDate: string;  // "YYYY-MM-01"
  confidence: number;
  confidenceLevel: 'high' | 'medium' | 'low';  // >=0.85 / >=0.60 / else
  source: ClassificationSource;    // who decided, for auditability
  sourceDetails: string;           // human-readable evidence
  needsReview: boolean;            // `confidence < 0.60`
  reasoning: string;
}
```

`source` doubles as an **audit trail**: the UI can show *why* a file landed in Q3 (e.g. `FolderAnalysis` from `/Finance/2026/March`) rather than trusting a black box.

### `USBVolumeInfo` — the device envelope

Name, filesystem, capacity/used/free bytes, total files/folders, scan timestamps, read speed, serial — with `capacityEstimated?: boolean` signalling that values were synthesized by the scanner rather than read from the host.

Fiscal-year convention enforced everywhere: `Q1 = Jul–Sep`, `Q2 = Oct–Dec`, `Q3 = Jan–Mar`, `Q4 = Apr–Jun` (`MONTH_QUARTER_MAP` in `quarterEngine.ts`).

---

## Engines

### scannerEngine — the scan loop

`src/lib/scannerEngine.ts` — `scanFileList()` (input fallback) and `scanUSBDirectoryHandle()` (File System Access) share the same shape: `(source, onProgress, options) → { files, volumeInfo }`.

Key implementation details:

- **Hashing** (`computeFileHash`): files ≤ 10 MB digest fully; larger files digest a 1 MB head slice (constant-time-ish regardless of drive size). Zero-byte files return the canonical SHA-256 of the empty input. A `hash_fb_…` fallback string (name+size+mtime, padded to 64 hex chars) is used if `crypto.subtle` throws.
- **Directory exclusions** (`IGNORE_DIRECTORIES`): a static set of system/recycle/package/tooling folder names plus dotfile rules — prevents polluting the index and the analytics.
- **Log discipline**: hash & classification logs are emitted every 10th file / >1 MB file; the handle-based walker caps its ring buffer at 200 entries. Folders count as they are entered, feeding `totalFolders`.
- **Batch reporting**: progress snapshots spread `scannedFiles` (`filesBatch`), so the UI gets incremental population instead of one giant mutation at the end.

### quarterEngine — classification chain

`src/lib/quarterEngine.ts` — exports `classifyFileQuarter()`, the quarter/month calendars, and the metadata extractors.

Classification resolves the **first non-null** result from a fixed priority ladder (the strongest signals win):

| P | Source | Confidence | Evidence |
|---|--------|-----------|----------|
| 1 | `EmbeddedMetadata` | 1.00 | `dcterms:created` from DOCX/XLSX core.xml, PDF `CreationDate` |
| 2 | `Filename` | 0.80–0.95 | ISO `2026-07-10`, `DD/MM/YYYY`, month names, `Q1 2026`, `FY26` |
| 3 | `ContentOCR` | 0.90 | Dates in extracted text (see `pickBestDate`) |
| 4 | `FolderAnalysis` | 0.70–0.75 | Year + month inferred from path segments |
| 5 | `ModifiedDate` | 0.60 | mtime fallback |
| 6 | `CreatedDate` | 0.50 | ctime last resort |

- **Date parsing** (`findAllDates`) is regex-driven (ISO, MDY, DMY, ambiguous month-first, month-name+year, `Q<1-4>` quarter tokens, `FYxx`) then dedup'd and ranked — unambiguous matches before ambiguous, most recent year first.
- **Ambiguity handling** (`pickBestDate`): candidates near priority keywords (`Invoice Date`, `Statement Date`, …) beat lexically earlier dates; dates co-located with junk keywords (`Date of Birth`, `Expiry`, `Phone`, `Ref#`, …) are filtered out. This is what keeps an OCR'd birthdate from hijacking an invoice's quarter.
- **Metadata extraction**: DOCX/XLSX are parsed *without* unzipping — the binary stream is scanned for the `docProps/core.xml` blob and tags are pulled via string delimiters (`extractMetadataFromDocx`/`XLSX`); PDF uses `pdfDoc.info` + `D:YYYYMMDD` decoding. All wrapped in try/catch → `{}` on any failure, forcing the chain down to the next source.

### ocrEngine — content extraction

`src/lib/ocrEngine.ts` — gated behind the landing-page **OCR toggle** (minuscule cost of entry was a deliberate choice: it dynamically imports ~4 MB of Tesseract only when enabled).

- Processed extensions: `jpg/jpeg/png/tiff/tif/bmp/heic/docx/pdf`.
- **Batching**: concurrent batches of 4 files (`BATCH_SIZE`) — enough parallelism to hide I/O, bounded to avoid saturating the tab.
- **Per-format strategy**: images → `tesseract.js recognize()`; DOCX → `mammoth.extractRawText()` + embedded-date from core.xml; PDF → `pdfjs-dist` (first 10 pages, worker from CDN).
- **Re-classification**: any file that yields text or an embedded date re-enters `classifyFileQuarter()` with content evidence, upgrading the source confidence. This is the biggest accuracy lever for scanned paper documents.

### diskMatch — root to physical disk

`src/lib/diskMatch.ts` — `matchPhysicalDisk(disks, scannerRootName)`.

- Normalizes the root folder name and prefers **removable** drives for candidates (falls back to all drives).
- Exact label match → partial substring match → `null` (prompts manual selection).

---

## Backend & API Contracts

`server.ts` — Express on `0.0.0.0:5454`; JSON body limit `10mb`; the Gemini client is constructed server-side (fallback placeholder key, but API calls are **gated on the real env var**).

| Endpoint | Method | Behavior |
|---|---|---|
| `/api/health` | GET | `{ status, service, geminiConfigured }` — deploy canary |
| `/api/disk-stats` | GET | Host disk introspection (see below); aborts in client after 10 s |
| `/api/ai-insights` | POST | `{ summaryData }` → Gemini `gemini-3.6-flash` with `responseMimeType: application/json`, expecting `{ summary, anomalies[], recommendations[], complianceRating, duplicateSavingsAdvice }`. **Synthetic deterministic fallback** if no key. |
| `/api/document-insights` | POST | `{ fileName, text, metadata, classification }` → Gemini → `{ documentType, effectiveDate, author, keywords, summary }`. Synthetic fallback does stop-word-filtered keyword frequency analysis. |

**Disk introspection** is platform-branching:

- `win32`: `Get-CimInstance Win32_LogicalDisk` (PowerShell) with a **WMIC CSV fallback**; keeps `DriveType` 2 (removable) and 3 (fixed) — so USB keys are prioritized by the matcher.
- POSIX: `df -P -B1` enriched with `lsblk -J` labels/serials; treats `/media`, `/mnt`, `/run/media` mountpoints as removable.

**Deployment dual-mode**: `NODE_ENV !== 'production'` mounts the Vite middleware (`middlewareMode`, SPA); otherwise Express serves the `dist/` build with a `*` SPA fallback. `npm run build` emits both `dist/` (Vite) and `dist/server.cjs` (esbuild-node bundle).

---

## Persistence Layer

`src/lib/indexedDB.ts` — database `QuarterSortDB` v1, three object stores:

| Store | Key | Indexes |
|---|---|---|
| `scanned_files` | `id` (unique) | `path` (unique), `folderPath`, `classification.quarter`, `category`, `sha256` |
| `volume_info` | `id` (`'current_volume'`) | — |
| `ai_insights` | `id` (`'latest_insight'`) | — |

Serialization notes worth knowing:

- **`handle` is stripped** before writes (DOM handles are not structured-cloneable) — persisted files can't be re-hashed or re-read without a fresh scan, by design.
- **Dates are re-wrapped** on load (`new Date(...)`), because IndexedDB round-trips `Date` through a plain-object form and naive restore produces invalid ranges elsewhere.
- The `path` unique index guarantees folder-position integrity at write time.

---

## UI / State Architecture

`App.tsx` is the single source of state; everything else is a controlled view.

- **App-level state cluster**: `scannedFiles`, `volumeInfo`, `activeTab`, `filterOptions`, `scanProgress`, plus modal visibility flags (`showConnectConfirm`, `showReplaceConfirm`, `isDriveConfirmOpen`, `previewFile`).
- **Scan semantics**: connecting with an existing index intercepted by `<USBReplaceConfirmModal>` (explicit "replace current drive?" guard) — scanning is a destructive local action.
- **Landing vs app**: `scannedFiles.length === 0` renders `<LandingPage>` (connect / demo / OCR toggle); otherwise the full shell (Navbar + Sidebar + views). "Go home" clears files *and* IndexedDB (`clearScannedIndexFromDB`).
- **Navigation**: 7 views switch on `activeTab` (see sidebar), filters are *derived* — the Folder Explorer receives `filterOptions` and recomputes; the Question of duplicate/photos counts is badge metadata passed into `<Sidebar>`.
- **Preview & command palette**: file preview is a modal bound to `previewFile`; `<CommandPalette>` (Ctrl/Cmd+K) navigates tabs/quarters and opens files by fuzzy search.
- **Browser font-size scaling**: All text uses `rem` units (base: body `0.875rem` = 14px) so the UI scales when users change their browser's default font size. Hardcoded `px` font sizes were converted across ~25 component files, CSS strings, and inline styles. Fixed-layout constants (`PAGE_W`/`PAGE_H` for page simulation, canvas `fontSize` for the Matrix rain, `IntersectionObserver` rootMargin) intentionally remain in `px` as they are not font-related.

---

## Performance & Concurrency Notes

- **Hashing is O(1)-ish** for files > 10 MB (sampled head slice), capping total scan cost on big media drives.
- **OCR is bounded**: dynamic import, batch-of-4 parallelism, max 10 PDF pages — no worker pool, no unbounded page scans.
- **Progress snapshots are `[...spread]` copies** sent every 10 files — O(n²) total copy cost across the scan. Fine for thousands of files; a `structuredClone`/chunked batch would be the upgrade path for very large drives.
- **Log buffers are capped** (200) in the handle walker to keep the scanning console smooth.
- Disk introspection runs with exec timeouts (`powershell` 15 s, `df`/`lsblk` 10 s) and a client-side 10 s abort so a hung host command can't wedge the connect flow.

---

## Error Handling & Edge Cases

| Failure mode | Handling |
|---|---|
| `crypto.subtle` unavailable / file read error | Deterministic `hash_fb_<name>_<size>_<mtime>` fallback (padded to 64 chars) so downstream grouping never crashes |
| Read error on a file during traversal | `WARN` log entry, file skipped, scan continues |
| Disk introspection fails (both CIM and WMIC) | Endpoint returns `{ success: false, disks: [] }`; client logs and proceeds with estimated volume |
| Gemini call fails / malformed JSON / key absent | Synthetic report path — contract-shaped response is guaranteed (schema parity with the real model) |
| Scan started while index exists | `<USBReplaceConfirmModal>` guard rail |
| IndexedDB unavailable | `console.warn` + in-memory lifecycle continues |

---

## Security Model

| Concern | Posture |
|---|---|
| File contents | Never leave the browser tab except as content *text* sent to document-insights — which is gated and truncates to 6,000 chars |
| Files on disk | Read-only handles; no write path |
| Network | Only `/api/*` same-origin calls; Gemini calls carry aggregate summary metrics, not files |
| Storage | IndexedDB local-only; `handle`s stripped before persistence |
| Secrets | `GEMINI_API_KEY` lives in `.env` (gitignored) or AI Studio Secrets — never bundled |
| Host introspection | Read-only PowerShell/WMIC/`df`/`lsblk` queries with timeouts |

---

## Tech Stack

**Frontend** — React 19 · TypeScript 5.8 · Vite 6 · Tailwind CSS v4 (`@tailwindcss/vite`) · `motion` · `recharts` · `lucide-react` / `@iconscout/react-unicons` · `pdfjs-dist` · `mammoth` · `docx-preview` · `pptx-browser` · `xlsx` · `word-extractor` · `jszip` · `tesseract.js` · `canvas-confetti`

**Backend** — Express 4 · `@google/genai` · `dotenv` · build via Vite + esbuild, run via `tsx`

---

## Getting Started

### Prerequisites

- **Node.js** (v18+)
- A Chromium-based browser (Chrome/Edge) for real-drive scanning via the File System Access API; other browsers can use the **demo dataset**.
- *(Optional)* A **Gemini API key** for AI audit + document insights.

### Environment Variables

Copy `.env.example` → `.env`:

```bash
GEMINI_API_KEY="YOUR_GEMINI_API_KEY"
APP_URL="http://localhost:5454"
```

`GEMINI_API_KEY` enables live Gemini reports; without it the API returns the synthetic fallback. AI Studio users can inject the key at runtime via the **Secrets** panel instead of a local `.env`.

### Run

```bash
npm install
npm run dev        # Express + Vite on http://localhost:5454
```

### Production build / lint

```bash
npm run build      # vite build && esbuild → dist/ + dist/server.cjs
npm start          # node dist/server.cjs (serves dist/ + SPA fallback)
npm run lint       # tsc --noEmit
```

Other scripts: `npm run preview` (Vite preview), `npm run clean`.

### Local OCR fallback testing

Browser OCR (tesseract.js) always runs first. When its result is weak (under 25 chars, mostly non-alphanumeric, or confidence under 60), or a PDF has no real text layer, the image or the first 2 rendered PDF pages are sent to `POST /api/ocr` (`api/ocr.py`, RapidOCR on ONNX Runtime). **Files leave the device only when this fallback runs.** To turn it off, set `VITE_SERVER_OCR_ENABLED=false`.

Requires Python 3.12 or 3.13.

```bash
# 1. Python OCR service (terminal 1)
python -m venv .venv
# Windows: .venv\Scripts\activate    macOS/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt          # runtime deps + uvicorn, pytest, httpx
uvicorn api.ocr:app --reload --port 8000

# 2. App (terminal 2). In dev, server.ts proxies /api/ocr* to localhost:8000
npm run dev                                  # http://localhost:5454

# Checks
curl http://localhost:5454/api/ocr/health    # {"ok":true}
python -m pytest tests -q
```

`OCR_DEV_TARGET` overrides the proxy target (default `http://localhost:8000`). If the Python service isn't running, the proxy returns 502 and the app keeps the browser OCR result.

**With `vercel dev`:** run `vercel link` once, then `vercel dev` with the venv activated. Vercel serves `api/ocr.py` itself, so you don't need uvicorn. The Express dev proxy is not involved there.

To confirm which engine ran: open DevTools → Console and filter `[ocr]`. A weak result logs `weak tesseract result…`, and a fallback logs `server fallback (rapidocr)…`. Network tab: a `POST /api/ocr` request appears only when the fallback ran. The document viewer's **OCR Status** field shows the engine (`tesseract`, `rapidocr`, `pdf-text`, `docx`).

---

## Extending the Codebase

- **Add a view** — new `TabId` in `Sidebar.tsx`, render branch in `App.tsx` `<main>`. State stays in `App.tsx`; views stay pure.
- **Tune classification** — `quarterEngine.ts`: add regexes to `findAllDates`, keywords to `DATE_PRIORITY_KEYWORDS` / `IGNORE_KEYWORDS`, or confidence thresholds in `buildClassification`.
- **Add a file format to OCR** — extend `CONTENT_EXTS` in `ocrEngine.ts` and add a branch in the per-format strategy switch.
- **New AI capability** — mirror the `/api/ai-insights` pattern: strict `responseMimeType: application/json` prompt contract + a parity-shaped synthetic fallback.
- **Verify** — `npm run lint` (type-check); manual smoke test on the Demo dataset; disk-stats check via `curl localhost:5454/api/disk-stats`.

---

## Known Limitations

- Real scanning requires the File System Access API (Chromium only).
- Large-file hashing is sampled (first 1 MB), so hashes are not full-content digests for files > 10 MB — true byte-exact identity is traded for scan speed.
- Progress snapshots spread full arrays; very large drives (10k+ files) may hit memory/copy pressure (see [Performance](#performance--concurrency-notes)).
- AI quality depends on the Gemini model + key; synthetic fallback is deterministic, not generative.
- OCR dynamically loads ~4 MB of Tesseract and slows scans — intended to be opt-in.
- Persisted scans drop their `handle`s, so re-hashing/re-reading requires a fresh scan.
- Font-size scaling is fully supported via `rem` units; at very large browser font sizes (>120%), some dense data tables and tight stat cards may wrap or require scrolling.