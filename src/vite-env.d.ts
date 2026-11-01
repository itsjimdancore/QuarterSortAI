/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Python OCR fallback. Empty = same origin (/api/ocr). */
  readonly VITE_OCR_API_URL?: string;
  /** Set to "false" to disable the server OCR fallback entirely. */
  readonly VITE_SERVER_OCR_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
