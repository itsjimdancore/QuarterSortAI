export type QuarterId = 'Q1' | 'Q2' | 'Q3' | 'Q4';

export type MonthName =
  | 'July'
  | 'August'
  | 'September'
  | 'October'
  | 'November'
  | 'December'
  | 'January'
  | 'February'
  | 'March'
  | 'April'
  | 'May'
  | 'June';

export type FileCategory =
  | 'Documents'
  | 'Images'
  | 'Videos'
  | 'Audio'
  | 'Archives'
  | 'Folders'
  | 'Executables'
  | 'Other';

export type ClassificationSource =
  | 'EmbeddedMetadata'
  | 'Filename'
  | 'ContentOCR'
  | 'FolderAnalysis'
  | 'ModifiedDate'
  | 'CreatedDate';

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export type OcrEngine = 'tesseract' | 'rapidocr' | 'docx' | 'pdf-text';

export interface QuarterClassification {
  quarter: QuarterId;
  month: MonthName;
  monthNumber: number;
  financialYear: string;
  year: number;
  effectiveDate: string;
  confidence: number;
  confidenceLevel: ConfidenceLevel;
  source: ClassificationSource;
  sourceDetails: string;
  needsReview: boolean;
  reasoning: string;
}

export interface FileMetadata {
  title?: string;
  author?: string;
  createdDate?: string;
  modifiedDate?: string;
  exifCamera?: string;
  exifResolution?: string;
  exifIso?: string;
  pdfPages?: number;
  wordWordCount?: number;
  excelSheetCount?: number;
  audioDuration?: string;
  videoResolution?: string;
  mimeType?: string;
}

export interface ScannedFile {
  id: string;
  name: string;
  path: string; // e.g. "/Finance/2025/July_Invoice_001.pdf"
  relativePath: string;
  folderPath: string; // e.g. "/Finance/2025"
  extension: string; // e.g. "pdf"
  size: number; // in bytes
  category: FileCategory;
  createdDate: Date;
  modifiedDate: Date;
  sha256: string;
  classification: QuarterClassification;
  metadata?: FileMetadata;
  handle?: FileSystemFileHandle | File;
  contentUrl?: string; // Blob URL if loaded
  textContent?: string; // Preview text content if extracted
  ocrEngine?: OcrEngine; // Which extractor produced textContent
  isDuplicate?: boolean;
  duplicateGroupHash?: string;
}

export interface FolderNode {
  id: string;
  name: string;
  path: string;
  parentPath: string | null;
  fileCount: number;
  subfolderCount: number;
  totalSize: number;
  modifiedDate: Date;
  quarterDistribution: Record<QuarterId, number>;
  categoryBreakdown: Record<FileCategory, number>;
}

export interface USBVolumeInfo {
  name: string;
  filesystem: string; // e.g. "FAT32", "exFAT", "NTFS"
  totalCapacityBytes: number;
  usedBytes: number;
  freeBytes: number;
  totalFiles: number;
  totalFolders: number;
  lastScanTimestamp: Date | null;
  scanDurationMs: number;
  readSpeedMBps: number;
  serialNumber: string;
  capacityEstimated?: boolean;
}

export interface PhysicalDisk {
  id: string; // e.g. "E:" on Windows or mount path on POSIX
  label: string | null;
  mountPoint: string | null;
  filesystem: string | null;
  totalCapacityBytes: number;
  freeBytes: number;
  driveType: 'removable' | 'fixed';
  /** true when capacity is estimated from the browser (no real server data) */
  capacityEstimated?: boolean;
}

export interface QuarterSummary {
  quarter: QuarterId;
  label: string; // e.g., "Q1 (Jul - Sep)"
  months: MonthName[];
  fileCount: number;
  totalSizeBytes: number;
  monthlyCounts: Record<MonthName, number>;
}

export interface DuplicateGroup {
  hash: string;
  files: ScannedFile[];
  totalSize: number;
  potentialSavingsBytes: number;
}

export interface FilterOptions {
  searchQuery: string;
  selectedQuarter: QuarterId | 'ALL';
  selectedMonth: MonthName | 'ALL';
  selectedCategory: FileCategory | 'ALL';
  dateFilterType: 'ALL' | 'TODAY' | 'YESTERDAY' | 'LAST_7' | 'LAST_30' | 'THIS_MONTH' | 'THIS_QUARTER' | 'CUSTOM' | 'EXACT';
  startDate?: string; // YYYY-MM-DD or DD/MM/YYYY
  endDate?: string;
  exactDate?: string;
  folderPath?: string;
  minSizeMB?: number;
  maxSizeMB?: number;
  extensionFilter?: string;
  onlyDuplicates?: boolean;
  onlyNeedsReview?: boolean;
  sortBy: 'name' | 'dateModified' | 'dateCreated' | 'size' | 'quarter' | 'fileCount';
  sortOrder: 'asc' | 'desc';
  viewMode: 'grid' | 'list' | 'compact' | 'largeIcons';
}

export interface AIInsightReport {
  summary: string;
  totalFolders: number;
  totalFiles: number;
  quarterBreakdown: Record<QuarterId, number>;
  categoryBreakdown: Record<FileCategory, number>;
  duplicateSavingsMB: number;
  anomalies: string[];
  recommendations: string[];
  largestFolder: string;
  mostActiveMonth: string;
  timestamp: string;
}

export interface WellFinding {
  id: string;
  severity: 'critical' | 'warning' | 'good';
  title: string;
  detail: string;
  recommendation: string;
}

export type WellAuditSectionKey =
  | 'quarterDistribution'
  | 'categoryBreakdown'
  | 'duplicates'
  | 'metadataIntegrity'
  | 'storageOptimization'
  | 'organizationalStructure';

export interface WellAuditSection {
  key: WellAuditSectionKey;
  title: string;
  status: 'pass' | 'warning' | 'fail';
  metric: string;
  summary: string;
}

export interface WellFindingsReport {
  summary: string;
  score: number;
  grade: string;
  complianceRating: string;
  riskAssessment: string;
  sections: WellAuditSection[];
  findings: WellFinding[];
  recommendations: string[];
  source: 'groq' | 'synthetic' | null;
  model?: string;
  timestamp: string;
}

export type DeviceKind = 'phone' | 'tablet' | 'desktop';

export interface ConnectedDevice {
  id: string;
  name: string;
  type: DeviceKind;
  os: string;
  browser: string;
  isCurrent: boolean;
  status: 'active' | 'linked' | 'signed-in' | 'offline';
  lastSeen: string; // ISO timestamp
  ipHint: string;
  detail: string;
}

export interface CyberScanLog {
  timestamp: string;
  type: 'INFO' | 'SCAN' | 'HASH' | 'QUARTER' | 'WARN' | 'SUCCESS';
  message: string;
}
