import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

function htmlToCleanMarkdown(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    // 1) Önce satır sonu ve blok sınırlarını dönüştür (<strong> içindeki <br>/<p> kaybolmasın)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/(ul|ol)>/gi, "\n\n")
    .replace(/<(p|div|section)[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section)>/gi, "\n\n")
    .replace(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi, (_m, inner: string) => {
      const clean = inner.replace(/<[^>]+>/g, "").trim();
      return clean ? `\n\n### ${clean}\n\n` : "";
    })
    // 2) <strong>/<b> içindeki her satırı ayrı ayrı koyu yap
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => {
      const stripped = inner.replace(/<[^>]+>/g, "");
      return stripped
        .split("\n")
        .map((ln) => {
          const lead = /^\s/.test(ln) ? " " : "";
          const trail = /\s$/.test(ln) ? " " : "";
          const clean = ln.trim();
          return clean ? `${lead}**${clean}**${trail}` : "";
        })
        .join("\n");
    })
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractLinkedInDescription(html: string): string | null {
  const marker = /class="[^"]*show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
  const match = html.match(marker);
  if (match && match[1]) {
    const cleaned = htmlToCleanMarkdown(match[1]);
    if (cleaned.length > 20) return cleaned;
  }

  const fallback = /class="[^"]*description__text[^"]*"[^>]*>([\s\S]*?)<\/section>/i;
  const fbMatch = html.match(fallback);
  if (fbMatch && fbMatch[1]) {
    const cleaned = htmlToCleanMarkdown(fbMatch[1]);
    if (cleaned.length > 20) return cleaned;
  }

  return null;
}

interface LinkedInMeta {
  seniority?: string;
  employmentType?: string;
  workMode?: string;
  industries?: string;
  jobFunction?: string;
  applicants?: string;
}

const CRITERIA_TR_MAP: Record<string, string> = {
  "full-time": "Tam Zamanlı",
  "part-time": "Yarı Zamanlı",
  internship: "Staj",
  stajyer: "Staj",
  staj: "Staj",
  contract: "Sözleşmeli",
  temporary: "Geçici",
  "entry level": "Başlangıç Seviyesi",
  associate: "Uzman Yardımcısı / Associate",
  "mid-senior level": "Orta - Kıdemli Seviye",
  director: "Direktör",
  executive: "Üst Düzey Yönetici",
  "not applicable": "Belirtilmemiş",
};

function translateCriteria(val: string): string {
  const key = val.trim().toLowerCase();
  return CRITERIA_TR_MAP[key] || val.trim();
}

function extractLinkedInMeta(html: string, description: string | null): LinkedInMeta {
  const meta: LinkedInMeta = {};
  const itemRegex =
    /<li[^>]*description__job-criteria-item[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>[\s\S]*?<\/li>/gi;

  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(html)) !== null) {
    const label = m[1].replace(/<[^>]+>/g, "").trim().toLocaleLowerCase("tr-TR");
    const value = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!value) continue;

    if (label.includes("seniority") || label.includes("kıdem")) {
      meta.seniority = translateCriteria(value);
    } else if (
      label.includes("employment") ||
      label.includes("istihdam") ||
      label.includes("stihdam")
    ) {
      meta.employmentType = translateCriteria(value);
    } else if (label.includes("industr") || label.includes("sektör")) {
      meta.industries = value;
    } else if (label.includes("function") || label.includes("işlev")) {
      meta.jobFunction = value;
    }
  }

  const appMatch = html.match(/(\d+\+?\s*(?:applicants|başvuru))/i);
  if (appMatch) {
    meta.applicants = appMatch[1].replace(/applicants/i, "başvuru").trim();
  }

  return meta;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createClient();
  if (!supabase) {
    return NextResponse.json({ description: null, meta: null }, { status: 200 });
  }

  const { data: job, error } = await supabase
    .from("jobs")
    .select("id, source_platform, external_id, description")
    .eq("id", id)
    .maybeSingle();

  if (error || !job) {
    return NextResponse.json({ description: null, meta: null }, { status: 404 });
  }

  // LinkedIn dışındaki kaynaklarda veritabanındaki açıklamayı döndür
  if (job.source_platform !== "linkedin" || !job.external_id) {
    return NextResponse.json({ description: job.description || null, meta: null, cached: true });
  }

  const numericId = String(job.external_id).replace(/^li-/, "").trim();
  if (!/^\d+$/.test(numericId)) {
    return NextResponse.json({ description: job.description || null, meta: null });
  }

  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  ];

  try {
    let resp: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 1200 * attempt));
      }
      resp = await fetch(
        `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${numericId}`,
        {
          headers: {
            "User-Agent": userAgents[attempt % userAgents.length],
            "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
          },
          cache: "no-store",
        }
      );
      if (resp.ok) break;
      if (resp.status !== 429 && resp.status < 500) break;
    }

    if (!resp || !resp.ok) {
      return NextResponse.json({ description: job.description || null, meta: null });
    }

    const html = await resp.text();
    const description = extractLinkedInDescription(html) || job.description || null;
    const meta = extractLinkedInMeta(html, description);

    // Sunucu ortamında SUPABASE_SERVICE_ROLE_KEY tanımlıysa açıklamayı veritabanına cache'le
    if (
      description &&
      !job.description &&
      process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY
    ) {
      const admin = createAdminClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
      );
      await admin.from("jobs").update({ description }).eq("id", job.id);
    }

    return NextResponse.json({ description, meta, cached: false });
  } catch {
    return NextResponse.json({ description: job.description || null, meta: null });
  }
}
