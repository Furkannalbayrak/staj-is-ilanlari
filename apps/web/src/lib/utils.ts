import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Gerçek saat/dakika içeren zaman damgaları için ("Son güncelleme: 12 dk önce" gibi).
 */
export function formatRelativeTimeTr(isoDate: string | null | undefined): string {
  if (!isoDate) return "Henüz güncellenmedi";
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return "Henüz güncellenmedi";

  const diffSeconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (diffSeconds < 60) return "Az önce";

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes} dk önce`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} sa önce`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays} gün önce`;

  return date.toLocaleDateString("tr-TR", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function isUtcMidnight(date: Date): boolean {
  return (
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0
  );
}

/**
 * İlan tarihini dürüstçe biçimlendirir:
 * - Kaynak gerçek saat bilgisi verdiyse ("2 sa önce") gösterir.
 * - Kaynak sadece takvim günü verdiyse (saat = 00:00 UTC, ör. LinkedIn) asla uydurma saat
 *   göstermez; bunun yerine "Bugün", "Dün" veya "24 Kas" yazar.
 * - Kaynak hiç tarih vermediyse "Sisteme eklenme: X dk önce" bilgisini gösterir.
 */
export function formatJobDateTr(
  postedAt: string | null | undefined,
  firstSeenAt: string
): { label: string; isExactTime: boolean } {
  if (postedAt) {
    const d = new Date(postedAt);
    if (!Number.isNaN(d.getTime())) {
      if (isUtcMidnight(d)) {
        const now = new Date();
        const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
        const postedUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
        const diffDays = Math.round((todayUtc - postedUtc) / 86_400_000);

        if (diffDays <= 0) return { label: "Bugün", isExactTime: false };
        if (diffDays === 1) return { label: "Dün", isExactTime: false };
        if (diffDays < 7) return { label: `${diffDays} gün önce`, isExactTime: false };
        return {
          label: d.toLocaleDateString("tr-TR", { day: "numeric", month: "short" }),
          isExactTime: false,
        };
      }
      return { label: formatRelativeTimeTr(postedAt), isExactTime: true };
    }
  }

  return { label: formatRelativeTimeTr(firstSeenAt), isExactTime: false };
}

export function hasSupabaseEnv(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
      !process.env.NEXT_PUBLIC_SUPABASE_URL.includes("YOUR_PROJECT_ID")
  );
}
