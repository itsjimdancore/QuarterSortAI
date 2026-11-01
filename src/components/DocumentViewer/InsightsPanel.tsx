import React from 'react';
import { ScannedFile } from '../../types';
import { DocumentInsights } from '../../lib/documentInsights';
import { formatSize, formatDate } from '../../lib/format';
import { Info, Sparkles, FileWarning } from 'lucide-react';

interface InsightsPanelProps {
  file: ScannedFile;
  insights: DocumentInsights | null;
  insightsLoading: boolean;
  aiUnavailable: boolean;
}

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <span className="text-[0.5625rem] font-bold uppercase tracking-wider text-slate-400 block mb-0.5">{label}</span>
      <span className={`text-[0.6875rem] font-semibold text-slate-800 dark:text-slate-200 break-words ${mono ? 'font-mono text-[0.625rem]' : ''}`}>
        {value || '—'}
      </span>
    </div>
  );
}

export const InsightsPanel: React.FC<InsightsPanelProps> = ({ file, insights, insightsLoading, aiUnavailable }) => {
  return (
    <div className="p-4 space-y-4 overflow-y-auto text-xs">
      {/* Document properties */}
      <section>
        <h4 className="font-extrabold text-slate-900 dark:text-slate-100 text-[0.6875rem] uppercase tracking-wider mb-2 flex items-center gap-1.5">
          <Info className="w-3.5 h-3.5 text-emerald-500" /> Document Properties
        </h4>
        <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 rounded-xl border border-slate-200 dark:border-slate-800 p-3 bg-slate-50 dark:bg-slate-900">
          <Field label="File Name" value={file.name} />
          <Field label="File Size" value={formatSize(file.size)} mono />
          <Field label="Created" value={formatDate(file.createdDate)} />
          <Field label="Modified" value={formatDate(file.modifiedDate)} />
          <Field label="Type" value={`.${file.extension.toUpperCase()}`} />
          <Field label="Category" value={file.category} />
          <Field
            label="OCR Status"
            value={
              <>
                {insights?.ocrStatus || (file.textContent ? 'Text available' : 'Not run')}
                {file.ocrEngine && (
                  <span className="ml-1 font-mono text-[0.5625rem] font-normal text-slate-400">· {file.ocrEngine}</span>
                )}
              </>
            }
          />
          <div className="col-span-2">
            <span className="text-[0.5625rem] font-bold uppercase tracking-wider text-slate-400 block mb-0.5">Classification Confidence</span>
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${file.classification.confidence >= 0.85 ? 'bg-emerald-500' : file.classification.confidence >= 0.6 ? 'bg-amber-500' : 'bg-red-500'}`}
                  style={{ width: `${Math.round(file.classification.confidence * 100)}%` }}
                />
              </div>
              <span className="text-[0.625rem] font-bold font-mono text-slate-700 dark:text-slate-300">
                {(file.classification.confidence * 100).toFixed(0)}%
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* AI Insights */}
      <section>
        <h4 className="font-extrabold text-slate-900 dark:text-slate-100 text-[0.6875rem] uppercase tracking-wider mb-2 flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-amber-500" /> Document Insights
        </h4>
        {insightsLoading ? (
          <div className="flex items-center gap-2 text-slate-400 text-xs py-4">
            <div className="h-3.5 w-3.5 rounded-full border-2 border-slate-500 border-t-amber-400 animate-spin" />
            Extracting insights...
          </div>
        ) : insights ? (
          <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 rounded-xl border border-slate-200 dark:border-slate-800 p-3 bg-slate-50 dark:bg-slate-900">
            <Field label="Effective Date" value={insights.effectiveDate} />
            <Field label="Quarter" value={insights.quarter} />
            <Field label="Month" value={insights.month} />
            <Field label="Pages" value={insights.pages || '—'} mono />
            <Field label="Words" value={insights.words?.toLocaleString() || '—'} mono />
            <Field label="Author" value={insights.author} />
            <div className="col-span-2">
              <Field label="Document Type" value={insights.documentType} />
            </div>
            <Field label="Confidence" value={`${(insights.confidence * 100).toFixed(0)}%`} mono />

            {insights.keywords.length > 0 && (
              <div className="col-span-2">
                <span className="text-[0.5625rem] font-bold uppercase tracking-wider text-slate-400 block mb-1.5">Keywords</span>
                <div className="flex flex-wrap gap-1.5">
                  {insights.keywords.map((k) => (
                    <span key={k} className="text-[0.625rem] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                      {k}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {insights.relatedDocuments.length > 0 && (
              <div className="col-span-2">
                <span className="text-[0.5625rem] font-bold uppercase tracking-wider text-slate-400 block mb-1.5">Related Documents</span>
                <div className="space-y-1">
                  {insights.relatedDocuments.map((r) => (
                    <div key={r.path} className="text-[0.625rem] font-mono text-slate-600 dark:text-slate-300 truncate" title={r.path}>
                      {r.name}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="text-xs text-slate-400 rounded-xl border border-slate-200 dark:border-slate-800 p-3 bg-slate-50 dark:bg-slate-900">
            {aiUnavailable ? 'AI insights unavailable (no Groq key).' : 'No insights available for this file.'}
          </div>
        )}
      </section>
    </div>
  );
};
