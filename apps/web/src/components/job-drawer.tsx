"use client";

import { useEffect } from "react";
import {
  Bookmark,
  Building2,
  Calendar,
  ExternalLink,
  Globe,
  MapPin,
  Tag,
  X,
} from "lucide-react";
import {
  CATEGORY_LABELS,
  EMPLOYMENT_TYPE_LABELS,
  SOURCE_PLATFORM_LABELS,
  WORK_MODE_LABELS,
  type Job,
} from "@/types/database";
import { cn, formatJobDateTr } from "@/lib/utils";
import { CompanyAvatar } from "@/components/company-avatar";

interface JobDrawerProps {
  job: Job | null;
  isSaved: boolean;
  onClose: () => void;
  onToggleSave: (jobId: string) => void;
}

export function JobDrawer({ job, isSaved, onClose, onToggleSave }: JobDrawerProps) {
  useEffect(() => {
    if (!job) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [job, onClose]);

  if (!job) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-zinc-950/40 backdrop-blur-[1px] transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Slide-over panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={job.title}
        className="relative z-10 flex h-full w-full max-w-xl flex-col border-l border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
      >
        {/* Drawer Header */}
        <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-6 py-5 dark:border-zinc-800">
          <div className="flex min-w-0 items-start gap-3">
            <CompanyAvatar name={job.company_name} logoUrl={job.company_logo_url} size="md" />
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                <Building2 className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{job.company_name}</span>
                <span>·</span>
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[11px] font-medium",
                    job.source_platform === "direct"
                      ? "bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300"
                      : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                  )}
                >
                  {SOURCE_PLATFORM_LABELS[job.source_platform]}
                </span>
              </div>
              <h2 className="text-lg font-semibold leading-snug text-zinc-950 dark:text-zinc-50">
                {job.title}
              </h2>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Kapat"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Metadata Badges */}
        <div className="flex flex-wrap gap-2 border-b border-zinc-200 bg-zinc-50/70 px-6 py-3.5 text-xs dark:border-zinc-800 dark:bg-zinc-900/40">
          <span className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
            <MapPin className="h-3.5 w-3.5 text-zinc-400" />
            {job.city || job.location || "Türkiye"}
          </span>
          <span className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2.5 py-1 font-medium text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
            {EMPLOYMENT_TYPE_LABELS[job.employment_type]}
          </span>
          {job.work_mode !== "unknown" && (
            <span className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
              <Globe className="h-3.5 w-3.5 text-zinc-400" />
              {WORK_MODE_LABELS[job.work_mode]}
            </span>
          )}
          <span className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
            <Tag className="h-3.5 w-3.5 text-zinc-400" />
            {CATEGORY_LABELS[job.category]}
          </span>
          <span className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
            <Calendar className="h-3.5 w-3.5 text-zinc-400" />
            {formatJobDateTr(job.posted_at, job.first_seen_at).label}
          </span>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {job.department && (
            <p className="mb-4 text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Departman: {job.department}
            </p>
          )}

          {job.description ? (
            <div className="whitespace-pre-line text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
              {job.description}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-zinc-300 p-5 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
              Bu ilan için özet açıklama kaynak sitede yer almıyor. Tüm detayları ve başvuru
              koşullarını görmek için aşağıdaki <strong>Başvur</strong> butonundan şirketin
              resmi sayfasına geçebilirsiniz.
            </div>
          )}
        </div>

        {/* Sticky Drawer Footer CTA */}
        <div className="flex items-center justify-between gap-3 border-t border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-950">
          <button
            type="button"
            onClick={() => onToggleSave(job.id)}
            className={cn(
              "inline-flex h-10 items-center gap-2 rounded-md border px-4 text-sm font-medium transition-colors",
              isSaved
                ? "border-blue-600 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-950/50 dark:text-blue-300"
                : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            )}
          >
            <Bookmark className={cn("h-4 w-4", isSaved && "fill-current")} />
            {isSaved ? "Kaydedildi" : "Kaydet"}
          </button>

          <a
            href={job.apply_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-md bg-blue-700 px-5 text-sm font-medium text-white transition-colors hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500"
          >
            Başvur
            <ExternalLink className="h-4 w-4" />
          </a>
        </div>
      </aside>
    </div>
  );
}
