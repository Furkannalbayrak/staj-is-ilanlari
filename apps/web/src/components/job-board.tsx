"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bookmark,
  Building2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Filter,
  MapPin,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  CATEGORY_LABELS,
  EMPLOYMENT_TYPE_LABELS,
  SOURCE_PLATFORM_LABELS,
  WORK_MODE_LABELS,
  type EmploymentType,
  type Job,
  type JobCategory,
  type SourcePlatform,
  type WorkMode,
} from "@/types/database";
import { cn, formatJobDateTr, formatRelativeTimeTr, hasSupabaseEnv } from "@/lib/utils";
import { expandQueryTerms, scoreJobSearchMatch } from "@/lib/search-synonyms";
import { createClient } from "@/lib/supabase/client";
import { JobDrawer } from "@/components/job-drawer";
import { CompanyAvatar } from "@/components/company-avatar";

const PAGE_SIZE = 50;

interface JobBoardProps {
  initialJobs: Job[];
  initialSavedIds: string[];
  lastUpdatedAt: string | null;
  userId: string | null;
  emptyReason?: "no_env" | "no_jobs";
}

export function JobBoard({
  initialJobs,
  initialSavedIds,
  lastUpdatedAt,
  userId,
  emptyReason,
}: JobBoardProps) {
  const [search, setSearch] = useState("");
  const [selectedCity, setSelectedCity] = useState<string>("all");
  const [selectedEmployment, setSelectedEmployment] = useState<EmploymentType | "all">("all");
  const [selectedWorkMode, setSelectedWorkMode] = useState<WorkMode | "all">("all");
  const [selectedCategory, setSelectedCategory] = useState<JobCategory | "all">("all");
  const [selectedSource, setSelectedSource] = useState<SourcePlatform | "all">("all");
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(() => new Set(initialSavedIds));
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);

  const availableCities = useMemo(() => {
    const set = new Set<string>();
    for (const j of initialJobs) {
      if (j.city) set.add(j.city);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "tr"));
  }, [initialJobs]);

  const filteredJobs = useMemo(() => {
    const expanded = expandQueryTerms(search);
    const matched: { job: Job; score: number }[] = [];

    for (const job of initialJobs) {
      if (selectedCity !== "all" && job.city !== selectedCity) continue;
      if (selectedEmployment !== "all" && job.employment_type !== selectedEmployment) continue;
      if (selectedWorkMode !== "all" && job.work_mode !== selectedWorkMode) continue;
      if (selectedCategory !== "all" && job.category !== selectedCategory) continue;
      if (selectedSource !== "all" && job.source_platform !== selectedSource) continue;

      const score = scoreJobSearchMatch(
        {
          title: job.title,
          companyName: job.company_name,
          city: job.city,
          department: job.department,
        },
        expanded
      );
      if (score === 0) continue;
      matched.push({ job, score });
    }

    if (expanded.exact) {
      matched.sort((a, b) => b.score - a.score);
    }

    return matched.map((m) => m.job);
  }, [
    initialJobs,
    search,
    selectedCity,
    selectedEmployment,
    selectedWorkMode,
    selectedCategory,
    selectedSource,
  ]);

  useEffect(() => {
    setCurrentPage(1);
  }, [
    search,
    selectedCity,
    selectedEmployment,
    selectedWorkMode,
    selectedCategory,
    selectedSource,
  ]);

  const totalPages = Math.max(1, Math.ceil(filteredJobs.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const paginatedJobs = useMemo(
    () => filteredJobs.slice(pageStart, pageStart + PAGE_SIZE),
    [filteredJobs, pageStart]
  );

  function goToPage(page: number) {
    const next = Math.max(1, Math.min(page, totalPages));
    setCurrentPage(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const activeFilterCount = [
    selectedCity !== "all",
    selectedEmployment !== "all",
    selectedWorkMode !== "all",
    selectedCategory !== "all",
    selectedSource !== "all",
    Boolean(search.trim()),
  ].filter(Boolean).length;

  function clearFilters() {
    setSearch("");
    setSelectedCity("all");
    setSelectedEmployment("all");
    setSelectedWorkMode("all");
    setSelectedCategory("all");
    setSelectedSource("all");
  }

  async function handleToggleSave(jobId: string) {
    if (!userId) {
      if (!hasSupabaseEnv()) {
        alert("İlan kaydetmek için önce Supabase bağlantısını yapılandırın.");
        return;
      }
      const supabase = createClient();
      await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      });
      return;
    }

    const supabase = createClient();
    const currentlySaved = savedIds.has(jobId);

    // Optimistic update
    setSavedIds((prev) => {
      const next = new Set(prev);
      if (currentlySaved) next.delete(jobId);
      else next.add(jobId);
      return next;
    });

    if (currentlySaved) {
      const { error } = await supabase
        .from("saved_jobs")
        .delete()
        .eq("user_id", userId)
        .eq("job_id", jobId);
      if (error) {
        setSavedIds((prev) => new Set(prev).add(jobId));
      }
    } else {
      const { error } = await supabase
        .from("saved_jobs")
        .insert({ user_id: userId, job_id: jobId });
      if (error) {
        setSavedIds((prev) => {
          const next = new Set(prev);
          next.delete(jobId);
          return next;
        });
      }
    }
  }

  const filterPanel = (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          <Filter className="h-3.5 w-3.5" />
          Filtreler
        </span>
        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={clearFilters}
            className="text-xs font-medium text-blue-700 hover:underline dark:text-blue-400"
          >
            Temizle ({activeFilterCount})
          </button>
        )}
      </div>

      {/* Arama */}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
          Anahtar Kelime
        </label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-zinc-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Pozisyon, şirket..."
            className="h-9 w-full rounded-md border border-zinc-200 bg-white pl-8 pr-3 text-sm text-zinc-950 placeholder:text-zinc-400 focus:border-blue-600 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:border-blue-500"
          />
        </div>
      </div>

      {/* Çalışma Tipi (Hızlı Pill'ler) */}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
          İlan Türü
        </label>
        <div className="flex flex-wrap gap-1.5">
          {(["all", "internship", "new_grad", "full_time", "part_time"] as const).map((type) => {
            const active = selectedEmployment === type;
            return (
              <button
                key={type}
                type="button"
                onClick={() => setSelectedEmployment(type)}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                  active
                    ? "border-blue-700 bg-blue-700 text-white dark:border-blue-600 dark:bg-blue-600"
                    : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                )}
              >
                {type === "all" ? "Tümü" : EMPLOYMENT_TYPE_LABELS[type]}
              </button>
            );
          })}
        </div>
      </div>

      {/* Şehir */}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
          Şehir
        </label>
        <select
          value={selectedCity}
          onChange={(e) => setSelectedCity(e.target.value)}
          className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2.5 text-sm text-zinc-900 focus:border-blue-600 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
        >
          <option value="all">Tüm Şehirler</option>
          {availableCities.map((city) => (
            <option key={city} value={city}>
              {city}
            </option>
          ))}
        </select>
      </div>

      {/* Kategori / Alan */}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
          Alan / Kategori
        </label>
        <select
          value={selectedCategory}
          onChange={(e) => setSelectedCategory(e.target.value as JobCategory | "all")}
          className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2.5 text-sm text-zinc-900 focus:border-blue-600 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
        >
          <option value="all">Tüm Alanlar</option>
          {(Object.entries(CATEGORY_LABELS) as [JobCategory, string][]).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {/* Çalışma Modeli */}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
          Çalışma Modeli
        </label>
        <div className="flex flex-wrap gap-1.5">
          {(["all", "remote", "hybrid", "onsite"] as const).map((mode) => {
            const active = selectedWorkMode === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => setSelectedWorkMode(mode)}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                  active
                    ? "border-blue-700 bg-blue-700 text-white dark:border-blue-600 dark:bg-blue-600"
                    : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                )}
              >
                {mode === "all" ? "Tümü" : WORK_MODE_LABELS[mode]}
              </button>
            );
          })}
        </div>
      </div>

      {/* Kaynak */}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-zinc-700 dark:text-zinc-300">
          Kaynak
        </label>
        <select
          value={selectedSource}
          onChange={(e) => setSelectedSource(e.target.value as SourcePlatform | "all")}
          className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2.5 text-sm text-zinc-900 focus:border-blue-600 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
        >
          <option value="all">Tüm Kaynaklar</option>
          {(Object.entries(SOURCE_PLATFORM_LABELS) as [SourcePlatform, string][]).map(
            ([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            )
          )}
        </select>
      </div>
    </div>
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[260px_minmax(0,1fr)]">
        {/* Desktop Sol Filtre Paneli */}
        <aside className="hidden lg:block">
          <div className="sticky top-20 rounded-xl border border-zinc-200 bg-zinc-50/50 p-4 dark:border-zinc-800/80 dark:bg-zinc-900/30">
            {filterPanel}
          </div>
        </aside>

        {/* Sağ Tek Sütun İlan Akışı */}
        <section className="min-w-0">
          {/* Üst Bilgi Çubuğu: Son Güncelleme + Toplam Sayı + Mobil Filtre */}
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 pb-3 dark:border-zinc-800">
            <div className="flex items-center gap-3">
              <h1 className="text-base font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
                Aktif İlanlar
              </h1>
              <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                {filteredJobs.length}
              </span>
            </div>

            <div className="flex items-center gap-3">
              <div className="inline-flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                <span className="h-1.5 w-1.5 rounded-full bg-blue-600 dark:bg-blue-500" />
                <Clock className="h-3.5 w-3.5" />
                <span>Son güncelleme: {formatRelativeTimeTr(lastUpdatedAt)}</span>
              </div>

              <button
                type="button"
                onClick={() => setMobileFiltersOpen((v) => !v)}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 px-2.5 text-xs font-medium text-zinc-700 lg:hidden dark:border-zinc-800 dark:text-zinc-300"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Filtrele
                {activeFilterCount > 0 && ` (${activeFilterCount})`}
              </button>
            </div>
          </div>

          {/* Mobil Filtre Paneli */}
          {mobileFiltersOpen && (
            <div className="mb-5 rounded-xl border border-zinc-200 bg-zinc-50 p-4 lg:hidden dark:border-zinc-800 dark:bg-zinc-900/50">
              <div className="mb-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => setMobileFiltersOpen(false)}
                  className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              {filterPanel}
            </div>
          )}

          {/* İlan Kartları (Tek Sütun, Hızlı Taranabilir) */}
          {filteredJobs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-300 px-6 py-14 text-center dark:border-zinc-800">
              {emptyReason === "no_env" ? (
                <div className="mx-auto max-w-md space-y-2">
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    Supabase bağlantısı henüz yapılmadı
                  </p>
                  <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                    <code>apps/web/.env.local</code> dosyasına Supabase URL ve Anon Key
                    ekleyip <code>supabase/schema.sql</code> dosyasını çalıştırdıktan sonra
                    ilanlar burada otomatik listelenecek.
                  </p>
                </div>
              ) : (
                <div className="mx-auto max-w-md space-y-2">
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    Eşleşen ilan bulunamadı
                  </p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Filtreleri gevşetebilir veya Python scraper worker&apos;ını çalıştırarak
                    veritabanını güncelleyebilirsiniz.
                  </p>
                  {activeFilterCount > 0 && (
                    <button
                      type="button"
                      onClick={clearFilters}
                      className="mt-2 inline-flex h-8 items-center rounded-md bg-blue-700 px-3 text-xs font-medium text-white hover:bg-blue-800 dark:bg-blue-600"
                    >
                      Filtreleri Sıfırla
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:divide-zinc-800/80 dark:border-zinc-800 dark:bg-zinc-950">
                {paginatedJobs.map((job) => {
                  const isSaved = savedIds.has(job.id);
                  const isSelected = selectedJob?.id === job.id;
                  return (
                    <article
                      key={job.id}
                      onClick={() => setSelectedJob(job)}
                      className={cn(
                        "group flex cursor-pointer items-center justify-between gap-4 px-5 py-4 transition-colors",
                        isSelected
                          ? "bg-blue-50/60 dark:bg-blue-950/20"
                          : "hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                      )}
                    >
                      <div className="flex min-w-0 flex-1 items-start gap-3.5">
                        <CompanyAvatar
                          name={job.company_name}
                          logoUrl={job.company_logo_url}
                          size="md"
                        />

                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                              <Building2 className="h-3.5 w-3.5 text-zinc-400" />
                              {job.company_name}
                            </span>
                            <span
                              className={cn(
                                "rounded px-1.5 py-0.5 text-[11px] font-medium",
                                job.source_platform === "direct"
                                  ? "bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300"
                                  : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                              )}
                            >
                              {SOURCE_PLATFORM_LABELS[job.source_platform]}
                            </span>
                            {job.employment_type === "internship" && (
                              <span className="rounded bg-blue-700/10 px-1.5 py-0.5 text-[11px] font-semibold text-blue-700 dark:bg-blue-500/20 dark:text-blue-300">
                                Staj
                              </span>
                            )}
                          </div>

                          <h2 className="truncate text-[15px] font-semibold text-zinc-950 group-hover:text-blue-700 dark:text-zinc-50 dark:group-hover:text-blue-400">
                            {job.title}
                          </h2>

                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                            <span className="inline-flex items-center gap-1">
                              <MapPin className="h-3 w-3" />
                              {job.city || job.location || "Türkiye"}
                            </span>
                            <span>·</span>
                            <span>{EMPLOYMENT_TYPE_LABELS[job.employment_type]}</span>
                            {job.work_mode !== "unknown" && (
                              <>
                                <span>·</span>
                                <span>{WORK_MODE_LABELS[job.work_mode]}</span>
                              </>
                            )}
                            <span>·</span>
                            <span>{CATEGORY_LABELS[job.category]}</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-3">
                        <span
                          title={
                            job.posted_at
                              ? "İlan yayın tarihi"
                              : "Sisteme ilk eklenme zamanı"
                          }
                          className="hidden text-xs text-zinc-400 sm:inline"
                        >
                          {formatJobDateTr(job.posted_at, job.first_seen_at).label}
                        </span>
                        <button
                          type="button"
                          aria-label={isSaved ? "Kayıttan çıkar" : "İlanı kaydet"}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleToggleSave(job.id);
                          }}
                          className={cn(
                            "flex h-8 w-8 items-center justify-center rounded-md border transition-colors",
                            isSaved
                              ? "border-blue-600 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-950/50 dark:text-blue-300"
                              : "border-zinc-200 text-zinc-400 hover:border-zinc-300 hover:text-zinc-700 dark:border-zinc-800 dark:hover:border-zinc-700 dark:hover:text-zinc-200"
                          )}
                        >
                          <Bookmark className={cn("h-4 w-4", isSaved && "fill-current")} />
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>

              {/* Sayfalama (50 ilan / sayfa) */}
              {totalPages > 1 && (
                <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, filteredJobs.length)} /{" "}
                    {filteredJobs.length} ilan
                  </p>

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={safePage <= 1}
                      onClick={() => goToPage(safePage - 1)}
                      className="inline-flex h-8 items-center gap-1 rounded-md border border-zinc-200 px-2.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:pointer-events-none disabled:opacity-40 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                      Önceki
                    </button>

                    {Array.from({ length: totalPages }, (_, i) => i + 1)
                      .filter(
                        (p) =>
                          p === 1 ||
                          p === totalPages ||
                          Math.abs(p - safePage) <= 1
                      )
                      .map((p, idx, arr) => {
                        const prev = arr[idx - 1];
                        const showDots = prev && p - prev > 1;
                        return (
                          <span key={p} className="inline-flex items-center gap-1">
                            {showDots && (
                              <span className="px-1 text-xs text-zinc-400">…</span>
                            )}
                            <button
                              type="button"
                              onClick={() => goToPage(p)}
                              className={cn(
                                "inline-flex h-8 min-w-8 items-center justify-center rounded-md border px-2 text-xs font-medium transition-colors",
                                p === safePage
                                  ? "border-blue-700 bg-blue-700 text-white dark:border-blue-600 dark:bg-blue-600"
                                  : "border-zinc-200 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
                              )}
                            >
                              {p}
                            </button>
                          </span>
                        );
                      })}

                    <button
                      type="button"
                      disabled={safePage >= totalPages}
                      onClick={() => goToPage(safePage + 1)}
                      className="inline-flex h-8 items-center gap-1 rounded-md border border-zinc-200 px-2.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:pointer-events-none disabled:opacity-40 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
                    >
                      Sonraki
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {/* Sağdan Açılan Detay Çekmecesi */}
      <JobDrawer
        job={selectedJob}
        isSaved={selectedJob ? savedIds.has(selectedJob.id) : false}
        onClose={() => setSelectedJob(null)}
        onToggleSave={handleToggleSave}
      />
    </div>
  );
}
