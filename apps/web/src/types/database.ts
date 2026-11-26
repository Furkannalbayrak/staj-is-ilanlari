export type SourcePlatform = "direct" | "linkedin" | "indeed" | "kariyernet" | "youthall";
export type WorkMode = "onsite" | "hybrid" | "remote" | "unknown";
export type EmploymentType =
  | "full_time"
  | "part_time"
  | "internship"
  | "new_grad"
  | "contract"
  | "unknown";
export type JobCategory =
  | "software"
  | "data_ai"
  | "electronics"
  | "mechanical"
  | "industrial"
  | "finance"
  | "marketing"
  | "design"
  | "product"
  | "hr"
  | "operations"
  | "sales"
  | "other";

export interface Company {
  id: string;
  slug: string;
  name: string;
  logo_url: string | null;
  careers_url: string | null;
  source_type: "corporate" | "portal";
  ats_type: string;
  is_active: boolean;
}

export interface Job {
  id: string;
  company_id: string | null;
  company_name: string;
  company_logo_url: string | null;
  source_platform: SourcePlatform;
  external_id: string;
  dedupe_hash: string;
  title: string;
  description: string | null;
  apply_url: string;
  location: string | null;
  city: string | null;
  work_mode: WorkMode;
  employment_type: EmploymentType;
  work_schedule: string | null;
  category: JobCategory;
  department: string | null;
  is_active: boolean;
  posted_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export interface AlertRule {
  id: string;
  user_id: string;
  user_email: string | null;
  name: string;
  keywords: string[];
  cities: string[];
  employment_types: EmploymentType[];
  work_modes: WorkMode[];
  categories: JobCategory[];
  company_ids: string[];
  channel: "email" | "telegram" | "both";
  telegram_chat_id: string | null;
  is_active: boolean;
  last_notified_at: string | null;
  created_at: string;
}

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  internship: "Staj",
  new_grad: "Yeni Mezun",
  full_time: "Tam Zamanlı",
  part_time: "Yarı Zamanlı",
  contract: "Sözleşmeli",
  unknown: "",
};

export const WORK_MODE_LABELS: Record<WorkMode, string> = {
  remote: "Uzaktan",
  hybrid: "Hibrit",
  onsite: "Ofis / Yerinde",
  unknown: "Belirtilmemiş",
};

export const CATEGORY_LABELS: Record<JobCategory, string> = {
  software: "Yazılım",
  data_ai: "Veri & Yapay Zeka",
  electronics: "Elektrik / Elektronik",
  mechanical: "Makine & Havacılık",
  industrial: "Endüstri & Üretim",
  product: "Ürün Yönetimi",
  design: "Tasarım",
  finance: "Finans & Muhasebe",
  marketing: "Pazarlama",
  hr: "İnsan Kaynakları",
  sales: "Satış & İş Geliştirme",
  operations: "Operasyon",
  other: "Diğer",
};

export const SOURCE_PLATFORM_LABELS: Record<SourcePlatform, string> = {
  direct: "Resmi Kariyer",
  linkedin: "LinkedIn",
  indeed: "Indeed",
  kariyernet: "Kariyer.net",
  youthall: "Youthall",
};
