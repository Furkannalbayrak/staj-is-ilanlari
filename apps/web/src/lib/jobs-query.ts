import type { SupabaseClient } from "@supabase/supabase-js";
import { expandQueryTerms, foldTr } from "@/lib/search-synonyms";
import type {
  EmploymentType,
  Job,
  JobCategory,
  SourcePlatform,
  WorkMode,
} from "@/types/database";

export const PAGE_SIZE = 50;

const VALID_EMPLOYMENT_TYPES = new Set<EmploymentType>([
  "full_time",
  "part_time",
  "internship",
  "new_grad",
  "contract",
  "unknown",
]);

const VALID_WORK_MODES = new Set<WorkMode>(["onsite", "hybrid", "remote", "unknown"]);

const VALID_CATEGORIES = new Set<JobCategory>([
  "software",
  "data_ai",
  "electronics",
  "mechanical",
  "industrial",
  "finance",
  "marketing",
  "design",
  "product",
  "hr",
  "operations",
  "sales",
  "other",
]);

const VALID_SOURCES = new Set<SourcePlatform>([
  "direct",
  "linkedin",
  "indeed",
  "kariyernet",
  "youthall",
  "techcareer",
  "toptalent",
  "secretcv",
  "elemannet",
]);

/**
 * ASCII (katlanmış) Türkçe kelimelerin veritabanındaki gerçek Türkçe karşılıkları.
 * PostgreSQL ILIKE, 'i' ile 'ı' veya 's' ile 'ş' harflerini eşleştirmediği için
 * kullanıcı "yazilim" yazdığında "Yazılım" ilanlarını da bulmasını sağlar.
 */
const ASCII_TO_TR_VARIANTS: Record<string, string[]> = {
  yazilim: ["yazılım"],
  "yazilim muhendisi": ["yazılım mühendisi", "yazılım"],
  "yazilim gelistirici": ["yazılım geliştirici", "yazılım"],
  muhendis: ["mühendis"],
  muhendisi: ["mühendisi"],
  "makine muhendisi": ["makine mühendisi"],
  "elektrik elektronik": ["elektrik elektronik", "elektrik-elektronik"],
  "endustri muhendisi": ["endüstri mühendisi", "endüstri"],
  endustri: ["endüstri"],
  uretim: ["üretim"],
  "ucak muhendisi": ["uçak mühendisi", "uçak"],
  havacilik: ["havacılık"],
  "siber guvenlik": ["siber güvenlik", "güvenlik"],
  "bilgi guvenligi": ["bilgi güvenliği"],
  "urun yoneticisi": ["ürün yöneticisi", "ürün"],
  "urun yonetimi": ["ürün yönetimi"],
  tasarim: ["tasarım"],
  tasarimci: ["tasarımcı"],
  "insan kaynaklari": ["insan kaynakları"],
  "ise alim": ["işe alım"],
  satis: ["satış"],
  "is gelistirme": ["iş geliştirme"],
  gomulu: ["gömülü"],
  donanim: ["donanım"],
  "uzun donem": ["uzun dönem"],
  "aday muhendis": ["aday mühendis"],
  istanbul: ["İstanbul"],
  izmir: ["İzmir"],
  eskisehir: ["Eskişehir"],
  diyarbakir: ["Diyarbakır"],
  sanliurfa: ["Şanlıurfa"],
  mugla: ["Muğla"],
  aydin: ["Aydın"],
  tekirdag: ["Tekirdağ"],
};

export interface JobFilters {
  q: string;
  city: string;
  type: EmploymentType | "all";
  mode: WorkMode | "all";
  category: JobCategory | "all";
  source: SourcePlatform | "all";
  page: number;
}

export interface PaginatedJobsResult {
  jobs: Job[];
  totalCount: number;
  page: number;
  totalPages: number;
  pageSize: number;
}

function getParam(
  raw: URLSearchParams | Record<string, string | string[] | undefined>,
  key: string
): string {
  if (raw instanceof URLSearchParams) {
    return (raw.get(key) || "").trim();
  }
  const val = raw[key];
  if (Array.isArray(val)) return (val[0] || "").trim();
  return (val || "").trim();
}

export function parseJobFilters(
  raw: URLSearchParams | Record<string, string | string[] | undefined>
): JobFilters {
  const q = getParam(raw, "q").slice(0, 120);
  const cityRaw = getParam(raw, "city");
  const typeRaw = getParam(raw, "type") as EmploymentType;
  const modeRaw = getParam(raw, "mode") as WorkMode;
  const catRaw = getParam(raw, "category") as JobCategory;
  const srcRaw = getParam(raw, "source") as SourcePlatform;
  const pageRaw = parseInt(getParam(raw, "page"), 10);

  return {
    q,
    city: cityRaw && cityRaw !== "all" ? cityRaw : "all",
    type: VALID_EMPLOYMENT_TYPES.has(typeRaw) ? typeRaw : "all",
    mode: VALID_WORK_MODES.has(modeRaw) ? modeRaw : "all",
    category: VALID_CATEGORIES.has(catRaw) ? catRaw : "all",
    source: VALID_SOURCES.has(srcRaw) ? srcRaw : "all",
    page: Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
  };
}

export function buildJobSearchParams(filters: JobFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.city !== "all") params.set("city", filters.city);
  if (filters.type !== "all") params.set("type", filters.type);
  if (filters.mode !== "all") params.set("mode", filters.mode);
  if (filters.category !== "all") params.set("category", filters.category);
  if (filters.source !== "all") params.set("source", filters.source);
  if (filters.page > 1) params.set("page", String(filters.page));
  return params;
}

function sanitizeIlike(term: string): string {
  return term
    .replace(/[,()%*\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function expandTurkishVariants(term: string): string[] {
  const out = new Set<string>();
  const clean = sanitizeIlike(term);
  if (clean) out.add(clean);

  const folded = foldTr(term);
  if (folded && folded !== clean.toLowerCase()) {
    out.add(folded);
  }
  const directVariants = ASCII_TO_TR_VARIANTS[folded];
  if (directVariants) {
    for (const v of directVariants) out.add(v);
  }
  return Array.from(out);
}

export async function queryJobs(
  supabase: SupabaseClient,
  filters: JobFilters
): Promise<PaginatedJobsResult> {
  const from = (filters.page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let query = supabase
    .from("jobs")
    .select("*", { count: "exact" })
    .eq("is_active", true);

  if (filters.city !== "all") {
    query = query.eq("city", filters.city);
  }
  if (filters.type !== "all") {
    query = query.eq("employment_type", filters.type);
  }
  if (filters.mode !== "all") {
    query = query.eq("work_mode", filters.mode);
  }
  if (filters.category !== "all") {
    query = query.eq("category", filters.category);
  }
  if (filters.source !== "all") {
    query = query.eq("source_platform", filters.source);
  }

  const rawQ = filters.q.trim();
  if (rawQ) {
    const expanded = expandQueryTerms(rawQ);
    if (expanded.synonyms.length > 0) {
      // TR <-> EN eşanlamlı genişletilmiş arama (tek OR grubu)
      const clauses: string[] = [];
      const seen = new Set<string>();

      const addTerm = (term: string, includeCompanyAndCity: boolean) => {
        const safe = sanitizeIlike(term);
        if (!safe || safe.length < 2) return;
        const key = `${safe.toLowerCase()}:${includeCompanyAndCity ? "full" : "td"}`;
        if (seen.has(key)) return;
        seen.add(key);

        clauses.push(`title.ilike.%${safe}%`);
        clauses.push(`department.ilike.%${safe}%`);
        if (includeCompanyAndCity) {
          clauses.push(`company_name.ilike.%${safe}%`);
          clauses.push(`city.ilike.%${safe}%`);
        }
      };

      for (const variant of expandTurkishVariants(rawQ)) {
        addTerm(variant, true);
      }
      for (const syn of expanded.synonyms.slice(0, 12)) {
        for (const variant of expandTurkishVariants(syn).slice(0, 2)) {
          addTerm(variant, false);
        }
      }

      if (clauses.length > 0) {
        query = query.or(clauses.join(","));
      }
    } else {
      // Genel arama: her kelime (en fazla 4 kelime) başlık/şirket/şehir/departmanda geçmeli (AND)
      const words = rawQ
        .split(/\s+/)
        .map(sanitizeIlike)
        .filter((w) => w.length >= 2)
        .slice(0, 4);

      for (const word of words) {
        const clauses: string[] = [];
        for (const variant of expandTurkishVariants(word)) {
          const safe = sanitizeIlike(variant);
          if (!safe) continue;
          clauses.push(`title.ilike.%${safe}%`);
          clauses.push(`company_name.ilike.%${safe}%`);
          clauses.push(`city.ilike.%${safe}%`);
          clauses.push(`department.ilike.%${safe}%`);
        }
        if (clauses.length > 0) {
          query = query.or(clauses.join(","));
        }
      }
    }
  }

  const { data, count, error } = await query
    .order("posted_at", { ascending: false, nullsFirst: false })
    .order("first_seen_at", { ascending: false })
    .range(from, to);

  if (error) {
    console.error("[queryJobs] Supabase sorgu hatası:", error.message);
    return {
      jobs: [],
      totalCount: 0,
      page: filters.page,
      totalPages: 1,
      pageSize: PAGE_SIZE,
    };
  }

  const totalCount = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  // URL'de toplam sayfa sayısından büyük bir ?page= geldiyse son geçerli sayfayı çek
  if (totalCount > 0 && filters.page > totalPages) {
    return queryJobs(supabase, { ...filters, page: totalPages });
  }

  return {
    jobs: (data as Job[]) || [],
    totalCount,
    page: filters.page,
    totalPages,
    pageSize: PAGE_SIZE,
  };
}

export async function fetchAvailableCities(
  supabase: SupabaseClient,
  includeCity?: string
): Promise<string[]> {
  const { data } = await supabase
    .from("jobs")
    .select("city")
    .eq("is_active", true)
    .not("city", "is", null)
    .order("first_seen_at", { ascending: false })
    .limit(1000);

  const set = new Set<string>();
  for (const row of data || []) {
    if (typeof row.city === "string" && row.city.trim()) {
      set.add(row.city.trim());
    }
  }
  if (includeCity && includeCity !== "all") {
    set.add(includeCity);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, "tr"));
}
