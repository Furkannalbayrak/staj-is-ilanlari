/**
 * Türkçe <-> İngilizce meslek, sektör ve ilan türü eşanlamlı arama motoru.
 * Kullanıcı "yazılım mühendisi" arattığında "Software Engineer", "Backend Developer"
 * gibi İngilizce ilanları da alaka sırasına göre bulur.
 */

const TR_MAP: Record<string, string> = {
  ç: "c",
  Ç: "c",
  ğ: "g",
  Ğ: "g",
  ı: "i",
  I: "i",
  İ: "i",
  ö: "o",
  Ö: "o",
  ş: "s",
  Ş: "s",
  ü: "u",
  Ü: "u",
};

export function foldTr(text: string): string {
  return text
    .replace(/[çÇğĞıIİöÖşŞüÜ]/g, (ch) => TR_MAP[ch] ?? ch)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SYNONYM_GROUPS: string[][] = [
  [
    "yazilim muhendisi",
    "yazilim gelistirici",
    "yazilim",
    "software engineer",
    "software developer",
    "software engineering",
    "backend",
    "frontend",
    "full stack",
    "fullstack",
    "developer",
    "programmer",
  ],
  [
    "staj",
    "stajyer",
    "intern",
    "internship",
    "working student",
    "aday muhendis",
    "long term",
    "uzun donem",
  ],
  [
    "yeni mezun",
    "new grad",
    "graduate",
    "junior",
    "entry level",
    "management trainee",
    "mt",
  ],
  [
    "veri bilimi",
    "veri bilimci",
    "veri muhendisi",
    "veri analisti",
    "yapay zeka",
    "data scientist",
    "data engineer",
    "data analyst",
    "machine learning",
    "ai engineer",
    "deep learning",
    "nlp",
    "llm",
  ],
  [
    "makine muhendisi",
    "makine",
    "mechanical engineer",
    "mechanical",
    "mekatronik",
    "mechatronics",
    "cad",
    "solidworks",
  ],
  [
    "elektrik elektronik",
    "elektronik muhendisi",
    "elektrik muhendisi",
    "electrical engineer",
    "electronics engineer",
    "embedded",
    "gomulu",
    "fpga",
    "pcb",
    "hardware",
    "donanim",
    "aviyonik",
    "avionics",
  ],
  [
    "endustri muhendisi",
    "endustri",
    "industrial engineer",
    "supply chain",
    "tedarik zinciri",
    "uretim",
    "production",
    "kalite",
    "quality",
  ],
  [
    "ucak muhendisi",
    "uzay muhendisi",
    "havacilik",
    "aerospace",
    "aerodinamik",
    "flight",
  ],
  [
    "siber guvenlik",
    "bilgi guvenligi",
    "cyber security",
    "cybersecurity",
    "security engineer",
    "infosec",
    "soc",
  ],
  [
    "devops",
    "bulut",
    "cloud engineer",
    "sre",
    "site reliability",
    "platform engineer",
    "sistem muhendisi",
    "system engineer",
  ],
  [
    "test muhendisi",
    "yazilim test",
    "qa engineer",
    "quality assurance",
    "automation engineer",
    "sdet",
  ],
  [
    "mobil",
    "mobile developer",
    "ios developer",
    "android developer",
    "flutter",
    "react native",
  ],
  [
    "urun yoneticisi",
    "urun yonetimi",
    "product manager",
    "product owner",
    "project manager",
    "proje yoneticisi",
  ],
  [
    "tasarim",
    "tasarimci",
    "ui ux",
    "ux designer",
    "ui designer",
    "product designer",
    "grafik",
    "graphic designer",
  ],
  [
    "insan kaynaklari",
    "ise alim",
    "human resources",
    "hr",
    "talent acquisition",
    "recruiter",
    "people",
  ],
  [
    "pazarlama",
    "dijital pazarlama",
    "marketing",
    "growth",
    "seo",
    "brand",
    "marka",
  ],
  [
    "finans",
    "muhasebe",
    "finance",
    "financial",
    "accounting",
    "audit",
    "denetim",
  ],
  [
    "satis",
    "is gelistirme",
    "sales",
    "business development",
    "account executive",
    "account manager",
  ],
  [
    "uzaktan",
    "evden",
    "remote",
    "hibrit",
    "hybrid",
  ],
];

/**
 * Kullanıcının arama sorgusunu TR <-> EN eşanlamlı terimlerle genişletir.
 */
export function expandQueryTerms(rawQuery: string): {
  exact: string;
  synonyms: string[];
  tokens: string[];
} {
  const exact = foldTr(rawQuery);
  if (!exact) return { exact: "", synonyms: [], tokens: [] };

  const synonymSet = new Set<string>();
  const tokens = exact.split(" ").filter((t) => t.length >= 2);

  for (const group of SYNONYM_GROUPS) {
    const matched = group.some(
      (term) =>
        exact === term ||
        exact.includes(term) ||
        term.includes(exact) ||
        (tokens.length > 0 && tokens.every((t) => term.includes(t)))
    );
    if (matched) {
      for (const term of group) {
        if (term !== exact) synonymSet.add(term);
      }
    }
  }

  return {
    exact,
    synonyms: Array.from(synonymSet),
    tokens,
  };
}

/**
 * Bir ilanın arama sorgusuyla eşleşme puanını döndürür (0 = eşleşmedi).
 * Birebir eşleşmeler en yüksek puanı, eşanlamlı eşleşmeler ikincil puanı alır.
 */
export function scoreJobSearchMatch(
  jobFields: { title: string; companyName: string; city: string | null; department: string | null },
  expanded: ReturnType<typeof expandQueryTerms>
): number {
  if (!expanded.exact) return 1;

  const titleFold = foldTr(jobFields.title);
  const companyFold = foldTr(jobFields.companyName);
  const metaFold = foldTr(`${jobFields.city || ""} ${jobFields.department || ""}`);
  const fullText = `${titleFold} ${companyFold} ${metaFold}`;

  // 1) Birebir ifade eşleşmesi
  if (titleFold.includes(expanded.exact)) return 100;
  if (companyFold.includes(expanded.exact)) return 90;
  if (fullText.includes(expanded.exact)) return 80;

  // 2) Tüm kelimeler geçiyor mu?
  if (expanded.tokens.length > 1 && expanded.tokens.every((t) => fullText.includes(t))) {
    return 70;
  }

  // 3) TR <-> EN eşanlamlı eşleşme
  for (const syn of expanded.synonyms) {
    if (titleFold.includes(syn)) return 50;
    if (metaFold.includes(syn)) return 35;
  }

  return 0;
}
