"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import {
  Bookmark,
  Building2,
  Calendar,
  ExternalLink,
  Globe,
  Loader2,
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
  onJobEnriched?: (jobId: string, patch: Partial<Job>) => void;
}

function renderInlineBold(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, idx) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={idx} className="font-semibold text-zinc-950 dark:text-zinc-50">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <Fragment key={idx}>{part}</Fragment>;
  });
}

function FormattedDescription({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let listItems: string[] = [];
  let keyIdx = 0;

  const flushList = () => {
    if (listItems.length === 0) return;
    blocks.push(
      <ul
        key={`ul-${keyIdx++}`}
        className="my-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300"
      >
        {listItems.map((item, i) => (
          <li key={i}>{renderInlineBold(item)}</li>
        ))}
      </ul>
    );
    listItems = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }

    if (line.startsWith("- ") || line.startsWith("• ")) {
      listItems.push(line.slice(2).trim());
      continue;
    }

    flushList();

    if (line.startsWith("### ")) {
      blocks.push(
        <h4
          key={`h-${keyIdx++}`}
          className="mt-4 mb-1.5 text-sm font-semibold text-zinc-950 dark:text-zinc-50"
        >
          {renderInlineBold(line.slice(4).trim())}
        </h4>
      );
      continue;
    }

    blocks.push(
      <p key={`p-${keyIdx++}`} className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
        {renderInlineBold(line)}
      </p>
    );
  }
  flushList();

  return <div className="space-y-1.5">{blocks}</div>;
}

interface LinkedInMeta {
  seniority?: string;
  employmentType?: string;
  workMode?: string;
  industries?: string;
  jobFunction?: string;
  applicants?: string;
}

export function JobDrawer({
  job,
  isSaved,
  onClose,
  onToggleSave,
  onJobEnriched,
}: JobDrawerProps) {
  const cacheRef = useRef<Map<string, { description: string | null; meta: LinkedInMeta | null }>>(
    new Map()
  );
  const [loadedDesc, setLoadedDesc] = useState<string | null>(null);
  const [loadedMeta, setLoadedMeta] = useState<LinkedInMeta | null>(null);
  const [loadingDesc, setLoadingDesc] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (!job) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [job, onClose]);

  useEffect(() => {
    if (!job) {
      setLoadedDesc(null);
      setLoadedMeta(null);
      setLoadingDesc(false);
      return;
    }

    if (cacheRef.current.has(job.id)) {
      const cached = cacheRef.current.get(job.id)!;
      setLoadedDesc(cached.description);
      setLoadedMeta(cached.meta);
      setLoadingDesc(false);
      return;
    }

    if (job.source_platform !== "linkedin") {
      setLoadedDesc(job.description);
      setLoadedMeta(null);
      setLoadingDesc(false);
      return;
    }

    let cancelled = false;
    setLoadedDesc(job.description);
    setLoadedMeta(null);
    setLoadingDesc(!job.description);

    fetch(`/api/jobs/${job.id}/description`)
      .then((res) => (res.ok ? res.json() : { description: null, meta: null }))
      .then((data: { description?: string | null; meta?: LinkedInMeta | null }) => {
        if (cancelled) return;
        const entry = {
          description: data.description ?? job.description ?? null,
          meta: data.meta ?? null,
        };
        // Sadece başarılı (dolu) sonuçları cache'le; anlık 429 hatalarını asla cache'leme
        if (entry.description) {
          cacheRef.current.set(job.id, entry);
        }
        setLoadedDesc(entry.description);
        setLoadedMeta(entry.meta);

        // Detaydan gerçek istihdam türü veya çalışma modeli geldiyse liste kartını da anında güncelle
        if (onJobEnriched && entry.meta) {
          const patch: Partial<Job> = {};
          const empMap: Record<string, Job["employment_type"]> = {
            "Tam Zamanlı": "full_time",
            "Yarı Zamanlı": "part_time",
            Staj: "internship",
            Sözleşmeli: "contract",
          };
          if (entry.meta.employmentType) {
            if (job.employment_type === "internship") {
              if (job.work_schedule !== entry.meta.employmentType) {
                patch.work_schedule = entry.meta.employmentType;
              }
            } else {
              const mapped = empMap[entry.meta.employmentType];
              if (mapped && mapped !== job.employment_type) {
                patch.employment_type = mapped;
              }
            }
          }
          if (entry.meta.workMode && job.work_mode === "unknown") {
            const wmMap: Record<string, Job["work_mode"]> = {
              Uzaktan: "remote",
              Hibrit: "hybrid",
              "Ofis / Yerinde": "onsite",
            };
            const mappedWm = wmMap[entry.meta.workMode];
            if (mappedWm) patch.work_mode = mappedWm;
          }
          if (Object.keys(patch).length > 0) {
            onJobEnriched(job.id, patch);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadedDesc(job.description);
          setLoadedMeta(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingDesc(false);
      });

    return () => {
      cancelled = true;
    };
  }, [job, retryNonce]);

  if (!job) return null;

  const displayDescription = job.description || loadedDesc;

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
        className="relative z-10 flex h-full w-full max-w-2xl flex-col border-l border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
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
          {(job.location || job.city) && (
            <span className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
              <MapPin className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
              {job.location || job.city}
            </span>
          )}
          {(() => {
            const baseLabel =
              job.employment_type !== "unknown"
                ? EMPLOYMENT_TYPE_LABELS[job.employment_type]
                : job.work_schedule || "";
            const realMetaType = loadedMeta?.employmentType || "";
            const effectiveLabel =
              job.employment_type !== "internship" && realMetaType
                ? realMetaType
                : baseLabel;
            const extraSchedule = job.work_schedule || realMetaType;
            const showExtraSchedule =
              job.employment_type === "internship" &&
              Boolean(extraSchedule) &&
              extraSchedule !== baseLabel;

            return (
              <>
                {effectiveLabel && (
                  <span className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2.5 py-1 font-medium text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
                    {effectiveLabel}
                  </span>
                )}
                {showExtraSchedule && (
                  <span className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1 font-medium text-blue-700 dark:border-blue-900 dark:bg-blue-950/50 dark:text-blue-300">
                    {extraSchedule}
                  </span>
                )}
              </>
            );
          })()}
          {job.work_mode !== "unknown" ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
              <Globe className="h-3.5 w-3.5 text-zinc-400" />
              {WORK_MODE_LABELS[job.work_mode]}
            </span>
          ) : loadedMeta?.workMode ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1 font-medium text-blue-700 dark:border-blue-900 dark:bg-blue-950/50 dark:text-blue-300">
              <Globe className="h-3.5 w-3.5" />
              {loadedMeta.workMode}
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
            <Tag className="h-3.5 w-3.5 text-zinc-400" />
            {CATEGORY_LABELS[job.category]}
          </span>
          <span className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
            <Calendar className="h-3.5 w-3.5 text-zinc-400" />
            {formatJobDateTr(job.posted_at, job.first_seen_at).label}
          </span>
          {loadedMeta?.seniority &&
            loadedMeta.seniority !== "Belirtilmemiş" &&
            loadedMeta.seniority !== "Geçerli Değil" && (
            <span className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
              {loadedMeta.seniority}
            </span>
          )}
          {loadedMeta?.applicants && (
            <span className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
              {loadedMeta.applicants}
            </span>
          )}
          {loadedMeta?.industries && (
            <span className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
              {loadedMeta.industries}
            </span>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {job.department && (
            <p className="mb-4 text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Departman: {job.department}
            </p>
          )}

          {loadingDesc ? (
            <div className="space-y-3 py-4">
              <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600" />
                İş ilanı detayları yükleniyor...
              </div>
              <div className="h-3 w-4/5 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
              <div className="h-3 w-full animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
              <div className="h-3 w-3/4 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
            </div>
          ) : displayDescription ? (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                İş İlanı Hakkında
              </h3>
              <FormattedDescription text={displayDescription} />
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-zinc-300 p-5 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
              <p>
                Bu ilan için açıklama metni şu an alınamadı. Tüm detayları ve başvuru koşullarını
                görmek için aşağıdaki <strong>Başvur</strong> butonundan şirketin resmi sayfasına
                geçebilirsiniz.
              </p>
              {job.source_platform === "linkedin" && (
                <button
                  type="button"
                  onClick={() => setRetryNonce((n) => n + 1)}
                  className="mt-3 inline-flex h-8 items-center rounded-md border border-zinc-300 bg-white px-3 text-xs font-medium text-zinc-800 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >
                  Tekrar Dene
                </button>
              )}
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
