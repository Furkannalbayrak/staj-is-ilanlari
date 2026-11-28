"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark,
  Building2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Filter,
  Globe,
  Layers,
  Loader2,
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
import {
  buildJobSearchParams,
  PAGE_SIZE,
  type JobFilters,
  type PaginatedJobsResult,
} from "@/lib/jobs-query";
import { expandQueryTerms, scoreJobSearchMatch } from "@/lib/search-synonyms";
import { cn, formatJobDateTr, formatRelativeTimeTr, hasSupabaseEnv } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { JobDrawer } from "@/components/job-drawer";
import { CompanyAvatar } from "@/components/company-avatar";
import { CustomSelect } from "@/components/custom-select";

const DEFAULT_FILTERS: JobFilters = {
  q: "",
  city: "all",
  type: "all",
  mode: "all",
  category: "all",
  source: "all",
  page: 1,
};

interface JobBoardProps {
  serverSide?: boolean;
  initialJobs: Job[];
  initialTotalCount?: number;
  initialPage?: number;
  initialTotalPages?: number;
  initialFilters?: JobFilters;
  availableCities?: string[];
  initialSavedIds: string[];
  lastUpdatedAt: string | null;
  userId: string | null;
  emptyReason?: "no_env" | "no_jobs";
}

const SOURCE_BADGE_STYLES: Record<SourcePlatform, string> = {
  direct:
    "border-blue-200/80 bg-blue-50 text-blue-700 dark:border-blue-800/70 dark:bg-blue-950/60 dark:text-blue-300",
  linkedin:
    "border-sky-200/80 bg-sky-50 text-sky-700 dark:border-sky-800/70 dark:bg-sky-950/60 dark:text-sky-300",
  youthall:
    "border-indigo-200/80 bg-indigo-50 text-indigo-700 dark:border-indigo-800/70 dark:bg-indigo-950/60 dark:text-indigo-300",
  indeed:
    "border-blue-200/70 bg-blue-50/70 text-blue-800 dark:border-blue-800/60 dark:bg-blue-950/50 dark:text-blue-300",
  techcareer:
    "border-emerald-200/80 bg-emerald-50 text-emerald-700 dark:border-emerald-800/70 dark:bg-emerald-950/60 dark:text-emerald-300",
  secretcv:
    "border-amber-200/80 bg-amber-50 text-amber-800 dark:border-amber-800/70 dark:bg-amber-950/50 dark:text-amber-300",
  elemannet:
    "border-teal-200/80 bg-teal-50 text-teal-700 dark:border-teal-800/70 dark:bg-teal-950/60 dark:text-teal-300",
  kariyernet:
    "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
  toptalent:
    "border-cyan-200/80 bg-cyan-50 text-cyan-800 dark:border-cyan-800/70 dark:bg-cyan-950/60 dark:text-cyan-300",
};

const WORK_MODE_CHIP_STYLES: Record<WorkMode, string> = {
  remote:
    "border-emerald-200/80 bg-emerald-50 text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/50 dark:text-emerald-300",
  hybrid:
    "border-amber-200/80 bg-amber-50 text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/50 dark:text-amber-300",
  onsite:
    "border-slate-200 bg-slate-100/90 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
  unknown: "",
};

function formatCardLocation(
  city: string | null,
  location: string | null,
  sourcePlatform: SourcePlatform
): string | null {
  if (!city && !location) return null;
  if (
    (sourcePlatform === "youthall" ||
      sourcePlatform === "elemannet" ||
      sourcePlatform === "secretcv") &&
    location &&
    location.includes(",")
  ) {
    const parts = location
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 1) {
      const primary = city || parts[0];
      return `${primary} +${parts.length - 1} şehir`;
    }
  }
  return city || location;
}

export function JobBoard({
  serverSide = false,
  initialJobs,
  initialTotalCount,
  initialPage = 1,
  initialTotalPages,
  initialFilters = DEFAULT_FILTERS,
  availableCities: availableCitiesProp,
  initialSavedIds,
  lastUpdatedAt,
  userId,
  emptyReason,
}: JobBoardProps) {
  const [serverJobs, setServerJobs] = useState<Job[]>(initialJobs);
  const [serverTotalCount, setServerTotalCount] = useState<number>(
    initialTotalCount ?? initialJobs.length
  );
  const [currentPage, setCurrentPage] = useState<number>(initialPage);
  const [serverTotalPages, setServerTotalPages] = useState<number>(
    initialTotalPages ?? Math.max(1, Math.ceil((initialTotalCount ?? initialJobs.length) / PAGE_SIZE))
  );

  const [searchInput, setSearchInput] = useState<string>(initialFilters.q);
  const [debouncedSearch, setDebouncedSearch] = useState<string>(initialFilters.q);
  const [selectedCity, setSelectedCity] = useState<string>(initialFilters.city);
  const [selectedEmployment, setSelectedEmployment] = useState<EmploymentType | "all">(
    initialFilters.type
  );
  const [selectedWorkMode, setSelectedWorkMode] = useState<WorkMode | "all">(
    initialFilters.mode
  );
  const [selectedCategory, setSelectedCategory] = useState<JobCategory | "all">(
    initialFilters.category
  );
  const [selectedSource, setSelectedSource] = useState<SourcePlatform | "all">(
    initialFilters.source
  );

  const [isLoading, setIsLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(() => new Set(initialSavedIds));
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  const isFirstRender = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  const availableCities = useMemo(() => {
    if (availableCitiesProp) return availableCitiesProp;
    const set = new Set<string>();
    for (const j of initialJobs) {
      if (j.city) set.add(j.city);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "tr"));
  }, [availableCitiesProp, initialJobs]);

  // Arama kutusunu 280ms debounce et (sunucu taraflı modda her tuşta sorgu atmayı önler)
  useEffect(() => {
    if (searchInput === debouncedSearch) return;
    if (!serverSide) {
      setCurrentPage(1);
      setDebouncedSearch(searchInput);
      return;
    }
    const timer = setTimeout(() => {
      setCurrentPage(1);
      setDebouncedSearch(searchInput);
    }, 280);
    return () => clearTimeout(timer);
  }, [searchInput, debouncedSearch, serverSide]);

  const fetchPage = useCallback(async (filters: JobFilters) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setFetchError(null);

    const params = buildJobSearchParams(filters);
    const qs = params.toString();
    const nextUrl = qs ? `/?${qs}` : "/";
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", nextUrl);
    }

    try {
      const res = await fetch(`/api/jobs${qs ? `?${qs}` : ""}`, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as PaginatedJobsResult;
      setServerJobs(data.jobs);
      setServerTotalCount(data.totalCount);
      setServerTotalPages(data.totalPages);
      setCurrentPage(data.page);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setFetchError("İlanlar yüklenirken geçici bir bağlantı hatası oluştu.");
    } finally {
      if (abortRef.current === controller) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!serverSide) return;
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (emptyReason === "no_env") return;

    fetchPage({
      q: debouncedSearch,
      city: selectedCity,
      type: selectedEmployment,
      mode: selectedWorkMode,
      category: selectedCategory,
      source: selectedSource,
      page: currentPage,
    });
  }, [
    serverSide,
    debouncedSearch,
    selectedCity,
    selectedEmployment,
    selectedWorkMode,
    selectedCategory,
    selectedSource,
    currentPage,
    emptyReason,
    fetchPage,
  ]);

  // Client-side filtreleme (/saved sayfası için)
  const clientFiltered = useMemo(() => {
    if (serverSide) return [];
    const expanded = expandQueryTerms(debouncedSearch);
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
    serverSide,
    initialJobs,
    debouncedSearch,
    selectedCity,
    selectedEmployment,
    selectedWorkMode,
    selectedCategory,
    selectedSource,
  ]);

  const totalCount = serverSide ? serverTotalCount : clientFiltered.length;
  const totalPages = serverSide
    ? serverTotalPages
    : Math.max(1, Math.ceil(clientFiltered.length / PAGE_SIZE));
  const safePage = Math.max(1, Math.min(currentPage, totalPages));
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const jobs = serverSide
    ? serverJobs
    : clientFiltered.slice(pageStart, pageStart + PAGE_SIZE);

  function goToPage(page: number) {
    const next = Math.max(1, Math.min(page, totalPages));
    if (next === currentPage) return;
    setCurrentPage(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const activeFilterCount = [
    selectedCity !== "all",
    selectedEmployment !== "all",
    selectedWorkMode !== "all",
    selectedCategory !== "all",
    selectedSource !== "all",
    Boolean(searchInput.trim()),
  ].filter(Boolean).length;

  function clearFilters() {
    setSearchInput("");
    setDebouncedSearch("");
    setSelectedCity("all");
    setSelectedEmployment("all");
    setSelectedWorkMode("all");
    setSelectedCategory("all");
    setSelectedSource("all");
    setCurrentPage(1);
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
    <div className="space-y-2.5">
      <div className="flex items-center justify-between border-b border-slate-100 pb-2 dark:border-slate-800">
        <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-800 dark:text-slate-200">
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-blue-50 text-blue-700 dark:bg-blue-950/70 dark:text-blue-300">
            <Filter className="h-3 w-3" />
          </span>
          Filtreler
        </span>
        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={clearFilters}
            className="rounded-md bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700 transition-colors hover:bg-blue-100 dark:bg-blue-950/60 dark:text-blue-300 dark:hover:bg-blue-900/60"
          >
            Temizle ({activeFilterCount})
          </button>
        )}
      </div>

      {/* Arama */}
      <div>
        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Anahtar Kelime
        </label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Pozisyon, şirket..."
            className={cn(
              "h-8.5 w-full rounded-lg border pl-8 pr-7 text-xs transition-all placeholder:text-slate-400 focus:border-blue-600 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600/15 dark:focus:border-blue-500 dark:focus:bg-slate-900",
              searchInput.trim()
                ? "border-blue-300 bg-blue-50/30 font-medium text-slate-900 dark:border-blue-700 dark:bg-blue-950/30 dark:text-slate-50"
                : "border-slate-200 bg-slate-50/80 text-slate-900 hover:border-slate-300 dark:border-slate-700/80 dark:bg-slate-800/70 dark:text-slate-50"
            )}
          />
          {searchInput && (
            <button
              type="button"
              aria-label="Aramayı temizle"
              onClick={() => setSearchInput("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-slate-200"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* Çalışma Tipi (Hızlı Pill'ler) */}
      <div className="border-t border-slate-100 pt-2.5 dark:border-slate-800/80">
        <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          İlan Türü
        </label>
        <div className="flex flex-wrap gap-1.5">
          {(["all", "internship", "new_grad", "full_time", "part_time", "contract"] as const).map((type) => {
            const active = selectedEmployment === type;
            return (
              <button
                key={type}
                type="button"
                onClick={() => {
                  setCurrentPage(1);
                  setSelectedEmployment(type);
                }}
                className={cn(
                  "rounded-md border px-2 py-1 text-xs font-medium transition-all",
                  active
                    ? "border-blue-700 bg-blue-700 text-white shadow-xs dark:border-blue-600 dark:bg-blue-600"
                    : "border-slate-200 bg-slate-50/70 text-slate-700 hover:border-blue-300 hover:bg-white hover:text-blue-700 dark:border-slate-700/80 dark:bg-slate-800/60 dark:text-slate-300 dark:hover:border-blue-700 dark:hover:text-blue-300"
                )}
              >
                {type === "all" ? "Tümü" : EMPLOYMENT_TYPE_LABELS[type]}
              </button>
            );
          })}
        </div>
      </div>

      {/* Şehir */}
      <div className="border-t border-slate-100 pt-2.5 dark:border-slate-800/80">
        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Şehir
        </label>
        <CustomSelect
          value={selectedCity}
          onChange={(val) => {
            setCurrentPage(1);
            setSelectedCity(val);
          }}
          icon={<MapPin className="h-3.5 w-3.5" />}
          searchable
          searchPlaceholder="Şehir ara..."
          isActive={selectedCity !== "all"}
          options={[
            { value: "all", label: "Tüm Şehirler" },
            ...availableCities.map((city) => ({ value: city, label: city })),
          ]}
        />
      </div>

      {/* Kategori / Alan */}
      <div>
        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Alan / Kategori
        </label>
        <CustomSelect
          value={selectedCategory}
          onChange={(val) => {
            setCurrentPage(1);
            setSelectedCategory(val as JobCategory | "all");
          }}
          icon={<Layers className="h-3.5 w-3.5" />}
          searchable
          searchPlaceholder="Alan ara..."
          isActive={selectedCategory !== "all"}
          options={[
            { value: "all", label: "Tüm Alanlar" },
            ...(Object.entries(CATEGORY_LABELS) as [JobCategory, string][]).map(
              ([key, label]) => ({ value: key, label })
            ),
          ]}
        />
      </div>

      {/* Çalışma Modeli */}
      <div className="border-t border-slate-100 pt-2.5 dark:border-slate-800/80">
        <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Çalışma Modeli
        </label>
        <div className="flex flex-wrap gap-1.5">
          {(["all", "remote", "hybrid", "onsite"] as const).map((mode) => {
            const active = selectedWorkMode === mode;
            const activeStyle =
              mode === "remote"
                ? "border-emerald-600 bg-emerald-600 text-white shadow-xs"
                : mode === "hybrid"
                  ? "border-amber-600 bg-amber-600 text-white shadow-xs"
                  : mode === "onsite"
                    ? "border-slate-800 bg-slate-800 text-white shadow-xs dark:border-slate-200 dark:bg-slate-200 dark:text-slate-900"
                    : "border-blue-700 bg-blue-700 text-white shadow-xs dark:border-blue-600 dark:bg-blue-600";
            return (
              <button
                key={mode}
                type="button"
                onClick={() => {
                  setCurrentPage(1);
                  setSelectedWorkMode(mode);
                }}
                className={cn(
                  "rounded-md border px-2 py-1 text-xs font-medium transition-all",
                  active
                    ? activeStyle
                    : "border-slate-200 bg-slate-50/70 text-slate-700 hover:border-blue-300 hover:bg-white hover:text-blue-700 dark:border-slate-700/80 dark:bg-slate-800/60 dark:text-slate-300 dark:hover:border-blue-700 dark:hover:text-blue-300"
                )}
              >
                {mode === "all" ? "Tümü" : WORK_MODE_LABELS[mode]}
              </button>
            );
          })}
        </div>
      </div>

      {/* Kaynak */}
      <div className="border-t border-slate-100 pt-2.5 dark:border-slate-800/80">
        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Kaynak
        </label>
        <CustomSelect
          value={selectedSource}
          onChange={(val) => {
            setCurrentPage(1);
            setSelectedSource(val as SourcePlatform | "all");
          }}
          icon={<Globe className="h-3.5 w-3.5" />}
          isActive={selectedSource !== "all"}
          dropUp
          options={[
            { value: "all", label: "Tüm Kaynaklar" },
            { value: "direct", label: "Resmi Kariyer", dotClass: "bg-blue-600" },
            { value: "linkedin", label: "LinkedIn", dotClass: "bg-sky-500" },
            { value: "indeed", label: "Indeed", dotClass: "bg-blue-800" },
            { value: "youthall", label: "Youthall", dotClass: "bg-indigo-500" },
            { value: "techcareer", label: "Techcareer.net", dotClass: "bg-emerald-500" },
            { value: "secretcv", label: "Secretcv", dotClass: "bg-amber-500" },
            { value: "elemannet", label: "Eleman.net", dotClass: "bg-teal-500" },
          ]}
        />
      </div>
    </div>
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[264px_minmax(0,1fr)]">
        {/* Desktop Sol Filtre Paneli */}
        <aside className="hidden lg:block">
          <div className="sticky top-[4.5rem] rounded-xl border border-slate-200/90 bg-white p-3.5 shadow-[0_1px_3px_rgba(15,23,42,0.05)] dark:border-slate-800 dark:bg-slate-900">
            {filterPanel}
          </div>
        </aside>

        {/* Sağ Tek Sütun İlan Akışı */}
        <section className="min-w-0">
          {/* Üst Bilgi Çubuğu: Son Güncelleme + Toplam Sayı + Mobil Filtre */}
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200/90 bg-white px-4 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center gap-2.5">
              <h1 className="text-base font-bold tracking-tight text-slate-900 dark:text-slate-50">
                Aktif İlanlar
              </h1>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-700 px-2.5 py-0.5 text-xs font-semibold text-white shadow-xs dark:bg-blue-600">
                {isLoading && <Loader2 className="h-3 w-3 animate-spin text-white" />}
                {totalCount.toLocaleString("tr-TR")}
              </span>
            </div>

            <div className="flex items-center gap-3">
              <div className="inline-flex items-center gap-1.5 rounded-full border border-slate-200/80 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                <Clock className="h-3.5 w-3.5 text-slate-400" />
                <span>Son güncelleme: {formatRelativeTimeTr(lastUpdatedAt)}</span>
              </div>

              <button
                type="button"
                onClick={() => setMobileFiltersOpen((v) => !v)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 lg:hidden dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Filtrele
                {activeFilterCount > 0 && ` (${activeFilterCount})`}
              </button>
            </div>
          </div>

          {/* Mobil Filtre Paneli */}
          {mobileFiltersOpen && (
            <div className="mb-5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm lg:hidden dark:border-slate-800 dark:bg-slate-900">
              <div className="mb-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => setMobileFiltersOpen(false)}
                  className="text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              {filterPanel}
            </div>
          )}

          {/* Bağlantı Hatası Bandı */}
          {fetchError && (
            <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
              <span>{fetchError}</span>
              <button
                type="button"
                onClick={() =>
                  fetchPage({
                    q: debouncedSearch,
                    city: selectedCity,
                    type: selectedEmployment,
                    mode: selectedWorkMode,
                    category: selectedCategory,
                    source: selectedSource,
                    page: currentPage,
                  })
                }
                className="shrink-0 font-semibold underline"
              >
                Tekrar Dene
              </button>
            </div>
          )}

          {/* İlan Kartları (Tek Sütun, Hızlı Taranabilir) */}
          {jobs.length === 0 && !isLoading ? (
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
                    Filtreleri gevşetebilir veya farklı bir anahtar kelime deneyebilirsiniz.
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
              <div
                className={cn(
                  "space-y-2.5 transition-opacity",
                  isLoading && "opacity-60"
                )}
              >
                {jobs.map((job) => {
                  const isSaved = savedIds.has(job.id);
                  const isSelected = selectedJob?.id === job.id;
                  const locLabel = formatCardLocation(
                    job.city,
                    job.location,
                    job.source_platform
                  );
                  return (
                    <article
                      key={job.id}
                      onClick={() => setSelectedJob(job)}
                      className={cn(
                        "group flex cursor-pointer items-center justify-between gap-4 rounded-xl border bg-white px-5 py-4 transition-all dark:bg-slate-900",
                        isSelected
                          ? "border-blue-600 bg-blue-50/40 ring-1 ring-blue-600/20 shadow-sm dark:border-blue-500 dark:bg-blue-950/30"
                          : "border-slate-200/90 shadow-[0_1px_2px_rgba(15,23,42,0.04)] hover:border-blue-300 hover:shadow-[0_4px_14px_rgba(29,78,216,0.08)] dark:border-slate-800 dark:hover:border-blue-700/70"
                      )}
                    >
                      <div className="flex min-w-0 flex-1 items-start gap-3.5">
                        <CompanyAvatar
                          name={job.company_name}
                          logoUrl={job.company_logo_url}
                          size="md"
                        />

                        <div className="min-w-0 flex-1 space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="inline-flex items-center gap-1 text-xs font-semibold text-slate-700 dark:text-slate-300">
                              <Building2 className="h-3.5 w-3.5 text-slate-400" />
                              {job.company_name}
                            </span>
                            <span
                              className={cn(
                                "rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
                                SOURCE_BADGE_STYLES[job.source_platform]
                              )}
                            >
                              {SOURCE_PLATFORM_LABELS[job.source_platform]}
                            </span>
                            {job.employment_type === "internship" && (
                              <span className="rounded-md bg-blue-700 px-2 py-0.5 text-[11px] font-semibold text-white dark:bg-blue-600">
                                Staj
                              </span>
                            )}
                          </div>

                          <h2 className="truncate text-[15px] font-semibold text-slate-900 transition-colors group-hover:text-blue-700 dark:text-slate-50 dark:group-hover:text-blue-400">
                            {job.title}
                          </h2>

                          <div className="flex flex-wrap items-center gap-1.5 text-xs">
                            {locLabel && (
                              <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                                <MapPin className="h-3 w-3 text-slate-500 dark:text-slate-400" />
                                {locLabel}
                              </span>
                            )}
                            {job.employment_type !== "unknown" &&
                              job.employment_type !== "internship" && (
                                <span
                                  className={cn(
                                    "rounded-md border px-2 py-0.5 font-medium",
                                    job.employment_type === "new_grad"
                                      ? "border-cyan-200/80 bg-cyan-50 text-cyan-800 dark:border-cyan-800/60 dark:bg-cyan-950/50 dark:text-cyan-300"
                                      : "border-slate-200/80 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800/80 dark:text-slate-300"
                                  )}
                                >
                                  {EMPLOYMENT_TYPE_LABELS[job.employment_type]}
                                </span>
                              )}
                            {job.work_schedule &&
                              job.work_schedule !==
                                EMPLOYMENT_TYPE_LABELS[job.employment_type] && (
                                <span className="rounded-md border border-slate-200/80 bg-slate-50 px-2 py-0.5 font-medium text-slate-700 dark:border-slate-700 dark:bg-slate-800/80 dark:text-slate-300">
                                  {job.work_schedule}
                                </span>
                              )}
                            {job.work_mode !== "unknown" && (
                              <span
                                className={cn(
                                  "rounded-md border px-2 py-0.5 font-medium",
                                  WORK_MODE_CHIP_STYLES[job.work_mode]
                                )}
                              >
                                {WORK_MODE_LABELS[job.work_mode]}
                              </span>
                            )}
                            {job.category !== "other" && (
                              <span className="px-1.5 py-0.5 text-slate-500 dark:text-slate-400">
                                {CATEGORY_LABELS[job.category]}
                              </span>
                            )}
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
                          className="hidden text-xs font-medium text-slate-500 sm:inline dark:text-slate-400"
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
                            "flex h-8 w-8 items-center justify-center rounded-lg border transition-colors",
                            isSaved
                              ? "border-blue-600 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-950/60 dark:text-blue-300"
                              : "border-slate-200 bg-slate-50 text-slate-400 hover:border-blue-300 hover:bg-blue-50/50 hover:text-blue-700 dark:border-slate-700 dark:bg-slate-800 dark:hover:border-blue-700 dark:hover:text-blue-300"
                          )}
                        >
                          <Bookmark className={cn("h-4 w-4", isSaved && "fill-current")} />
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>

              {/* Sunucu Taraflı Sayfalama (50 ilan / sayfa) */}
              {totalPages > 1 && (
                <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs font-medium text-slate-600 dark:text-slate-400">
                    {(pageStart + 1).toLocaleString("tr-TR")}–
                    {Math.min(pageStart + PAGE_SIZE, totalCount).toLocaleString("tr-TR")} /{" "}
                    {totalCount.toLocaleString("tr-TR")} ilan
                  </p>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={safePage <= 1 || isLoading}
                      onClick={() => goToPage(safePage - 1)}
                      className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 shadow-xs transition-colors hover:border-blue-300 hover:text-blue-700 disabled:pointer-events-none disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-blue-700"
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
                              <span className="px-1 text-xs text-slate-400">…</span>
                            )}
                            <button
                              type="button"
                              disabled={isLoading}
                              onClick={() => goToPage(p)}
                              className={cn(
                                "inline-flex h-8 min-w-8 items-center justify-center rounded-lg border px-2 text-xs font-semibold shadow-xs transition-colors disabled:opacity-60",
                                p === safePage
                                  ? "border-blue-700 bg-blue-700 text-white dark:border-blue-600 dark:bg-blue-600"
                                  : "border-slate-200 bg-white text-slate-700 hover:border-blue-300 hover:text-blue-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-blue-700"
                              )}
                            >
                              {p}
                            </button>
                          </span>
                        );
                      })}

                    <button
                      type="button"
                      disabled={safePage >= totalPages || isLoading}
                      onClick={() => goToPage(safePage + 1)}
                      className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 shadow-xs transition-colors hover:border-blue-300 hover:text-blue-700 disabled:pointer-events-none disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-blue-700"
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
