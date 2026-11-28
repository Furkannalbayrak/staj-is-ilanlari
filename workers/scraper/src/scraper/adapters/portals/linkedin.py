from __future__ import annotations

import logging
import random
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode

from curl_cffi import requests as cf_requests
from selectolax.lexbor import LexborHTMLParser

from scraper.adapters.base import BaseAdapter
from scraper.models import EmploymentType, JobPayload, SourceConfig, WorkMode
from scraper.normalizer import (
    compute_dedupe_hash,
    detect_category,
    detect_employment_type,
    detect_work_mode,
    detect_work_mode_from_description,
    is_turkey_location,
    normalize_city,
    strip_html,
)

logger = logging.getLogger(__name__)

SEARCH_ENDPOINT = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
DETAIL_ENDPOINT = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting"
IMPERSONATIONS = ["chrome124", "chrome120", "chrome116", "safari17_0"]

_SCHEDULE_TR_MAP: dict[str, str] = {
    "full-time": "Tam Zamanlı",
    "tam zamanlı": "Tam Zamanlı",
    "part-time": "Yarı Zamanlı",
    "yarı zamanlı": "Yarı Zamanlı",
    "internship": "Staj",
    "staj": "Staj",
    "stajyer": "Staj",
    "contract": "Sözleşmeli",
    "sözleşmeli": "Sözleşmeli",
    "temporary": "Geçici",
    "geçici": "Geçici",
}

_SCHEDULE_TO_EMP: dict[str, EmploymentType] = {
    "full-time": "full_time",
    "tam zamanlı": "full_time",
    "part-time": "part_time",
    "yarı zamanlı": "part_time",
    "internship": "internship",
    "staj": "internship",
    "stajyer": "internship",
    "contract": "contract",
    "sözleşmeli": "contract",
}


def _fetch_linkedin_detail(
    session: cf_requests.Session, numeric_id: str, max_retries: int = 3
) -> tuple[str | None, EmploymentType | None, str | None]:
    """
    Tekil LinkedIn ilanından gerçek istihdam türünü (Tam/Yarı Zamanlı/Sözleşmeli/Staj)
    ve tam ilan açıklamasını çeker. 429 gelirse bekleyip oturum yenileyerek tekrar dener.
    """
    cur_session = session
    for attempt in range(max_retries):
        try:
            if attempt > 0:
                time.sleep(random.uniform(3.5, 6.0) * attempt)
                cur_session = cf_requests.Session(
                    impersonate=IMPERSONATIONS[attempt % len(IMPERSONATIONS)]
                )
            resp = cur_session.get(
                f"{DETAIL_ENDPOINT}/{numeric_id}",
                headers={"Accept-Language": "en-US,en;q=0.9"},
                timeout=15,
            )
            if resp.status_code == 429:
                continue
            if resp.status_code != 200 or not resp.text:
                return None, None, None

            tree = LexborHTMLParser(resp.text)
            work_schedule = None
            real_emp_type: EmploymentType | None = None
            is_seniority_internship = False
            for li in tree.css("li.description__job-criteria-item"):
                h3 = li.css_first("h3")
                sp = li.css_first("span")
                if not h3 or not sp:
                    continue
                label = h3.text(strip=True).lower()
                val = sp.text(strip=True).lower()
                if "employment" in label or "istihdam" in label:
                    work_schedule = _SCHEDULE_TR_MAP.get(val, sp.text(strip=True))
                    real_emp_type = _SCHEDULE_TO_EMP.get(val)
                elif ("seniority" in label or "kıdem" in label) and val in ("internship", "staj", "stajyer"):
                    is_seniority_internship = True

            if is_seniority_internship:
                real_emp_type = "internship"

            desc_node = tree.css_first(".show-more-less-html__markup") or tree.css_first(
                ".description__text"
            )
            description = strip_html(desc_node.html) if desc_node and desc_node.html else None
            if description:
                description = re.sub(
                    r"(?:\n+(?:Show more|Show less|Daha fazla göster|Daha az göster))+\s*$",
                    "",
                    description,
                    flags=re.IGNORECASE,
                ).strip() or None
            return work_schedule, real_emp_type, description
        except Exception:
            if attempt == max_retries - 1:
                return None, None, None
    return None, None, None

# LinkedIn resmi f_WT (Work Type) kodları -> standart work_mode
WT_TO_WORK_MODE: dict[str, WorkMode] = {
    "1": "onsite",
    "2": "remote",
    "3": "hybrid",
}

# LinkedIn resmi f_JT (Job Type) kodları -> standart employment_type
JT_TO_EMP_TYPE: dict[str, EmploymentType] = {
    "F": "full_time",
    "P": "part_time",
    "I": "internship",
    "C": "contract",
}


def _parse_relative_time(text: str | None, fallback_date: str | None) -> datetime | None:
    now = datetime.now(timezone.utc)
    if text:
        low = text.strip().lower()
        if "just now" in low or "az önce" in low or "şimdi" in low:
            return now
        m = re.search(r"(\d+)\s*(minute|min|dakika|hour|hr|saat|day|gün|week|hafta)", low)
        if m:
            val = int(m.group(1))
            unit = m.group(2)
            if unit in ("minute", "min", "dakika"):
                return now - timedelta(minutes=val)
            if unit in ("hour", "hr", "saat"):
                return now - timedelta(hours=val)
            if unit in ("day", "gün"):
                return now - timedelta(days=val)
            if unit in ("week", "hafta"):
                return now - timedelta(weeks=val)

    if fallback_date:
        try:
            d = datetime.strptime(fallback_date.strip()[:10], "%Y-%m-%d")
            return d.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return None


def _extract_logo_url(card) -> str | None:
    img = card.css_first("img.artdeco-entity-image, img")
    if not img:
        return None
    url = (img.attributes.get("data-delayed-url") or img.attributes.get("src") or "").strip()
    if not url or not url.startswith("http"):
        return None
    if "static.licdn.com" in url or "ghost" in url.lower():
        return None
    return url


def _extract_job_id(card, href: str) -> str | None:
    urn = card.attributes.get("data-entity-urn") or ""
    m = re.search(r"jobPosting:(\d+)", urn)
    if m:
        return f"li-{m.group(1)}"
    m2 = re.search(r"-(\d{7,})(?:\?|$)", href)
    if m2:
        return f"li-{m2.group(1)}"
    m3 = re.search(r"/view/(\d+)", href)
    if m3:
        return f"li-{m3.group(1)}"
    return None


def heal_recent_unenriched_linkedin_jobs(db_client: Any, max_items: int = 15) -> int:
    """
    Son 72 saatte eklenmiş ama o anki 429 nedeniyle açıklaması veya çalışma türü
    eksik kalmış LinkedIn ilanlarını doğrudan ID'leriyle tamamlar (arama listesinde
    aşağı düşmüş olsalar bile yakalar).
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=72)).isoformat()
    res = (
        db_client.table("jobs")
        .select("id,external_id,description,employment_type,work_mode,work_schedule")
        .eq("source_platform", "linkedin")
        .eq("is_active", True)
        .gte("first_seen_at", cutoff)
        .or_("description.is.null,employment_type.eq.unknown")
        .order("first_seen_at", desc=True)
        .limit(max_items)
        .execute()
    )
    rows = res.data or []
    if not rows:
        return 0

    session = cf_requests.Session(impersonate=IMPERSONATIONS[0])
    healed = 0
    for row in rows:
        numeric_id = str(row.get("external_id") or "").replace("li-", "").strip()
        if not numeric_id.isdigit():
            continue
        time.sleep(random.uniform(0.5, 0.9))
        sched, real_emp, desc = _fetch_linkedin_detail(session, numeric_id, max_retries=3)
        patch: dict[str, Any] = {}
        if desc and not row.get("description"):
            patch["description"] = desc
        if real_emp and (row.get("employment_type") == "unknown" or real_emp == "internship"):
            patch["employment_type"] = real_emp
        if sched and sched != "Staj" and not row.get("work_schedule"):
            patch["work_schedule"] = sched
        if patch:
            db_client.table("jobs").update(patch).eq("id", row["id"]).execute()
            healed += 1
    if healed:
        logger.info("[linkedin] Self-healing: %d/%d eksik LinkedIn ilanı tamamlandı.", healed, len(rows))
    return healed


class LinkedInGuestAdapter(BaseAdapter):
    """
    LinkedIn'in herkese açık guest arama API'sinden doğrudan veri çeker:
    - f_WT (1=Ofis, 2=Uzaktan, 3=Hibrit) ve f_JT (I=Staj, P=Yarı Zamanlı) kırılımlarıyla
      sıfır ekstra istek atarak gerçek çalışma modeli ve istihdam türünü yakalar.
    - Dinamik sayfalama (start += gelen kart sayısı -> hiç ilan atlamaz).
    - Tek istekte gerçek şirket logoları ve gerçek yayın saatleri.
    - 429 hız sınırında akıllı bekleme (exponential backoff) ve oturum yenileme.
    """

    def fetch_jobs(
        self,
        source: SourceConfig,
        existing_external_ids: set[str] | None = None,
    ) -> list[JobPayload]:
        location = source.config.get("location", "Turkey")
        hours_old = int(source.config.get("hours_old", 24))
        default_max_jobs = int(source.config.get("max_jobs_per_query", 80))
        turkey_only = bool(source.config.get("turkey_only", True))
        delay_min = float(source.config.get("delay_min_sec", 2.0))
        delay_max = float(source.config.get("delay_max_sec", 3.8))
        max_429_retries = int(source.config.get("max_429_retries", 2))

        queries: list[dict[str, Any]] = source.config.get("queries") or [
            {"label": "uzaktan", "keywords": "", "f_WT": "2", "max_jobs": 80},
            {"label": "hibrit", "keywords": "", "f_WT": "3", "max_jobs": 80},
            {"label": "ofis", "keywords": "", "f_WT": "1", "max_jobs": 80},
            {"label": "staj", "keywords": "", "f_JT": "I", "max_jobs": 80},
        ]

        existing = existing_external_ids or set()
        collected_by_id: dict[str, JobPayload] = {}
        tpr_seconds = hours_old * 3600

        imp_idx = 0
        session = cf_requests.Session(impersonate=IMPERSONATIONS[imp_idx])
        headers = {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9,tr-TR;q=0.8,tr;q=0.7",
        }

        request_count = 0
        for q in queries:
            q_label = q.get("label") or q.get("keywords") or "<genel>"
            q_keywords = str(q.get("keywords") or "").strip()
            q_wt = str(q.get("f_WT") or "").strip()
            q_jt = str(q.get("f_JT") or "").strip()
            q_max = int(q.get("max_jobs", default_max_jobs))

            forced_work_mode: WorkMode | None = WT_TO_WORK_MODE.get(q_wt)
            forced_emp_type: EmploymentType | None = JT_TO_EMP_TYPE.get(q_jt)

            start = 0
            q_collected = 0
            consecutive_existing = 0

            while q_collected < q_max and start < 975:
                if request_count > 0:
                    time.sleep(random.uniform(delay_min, delay_max))
                request_count += 1

                params: dict[str, str | int] = {
                    "location": location,
                    "f_TPR": f"r{tpr_seconds}",
                    "sortBy": "DD",
                    "start": start,
                }
                if q_keywords:
                    params["keywords"] = q_keywords
                if q_wt:
                    params["f_WT"] = q_wt
                if q_jt:
                    params["f_JT"] = q_jt

                url = f"{SEARCH_ENDPOINT}?{urlencode(params)}"
                resp = None

                for attempt in range(max_429_retries + 1):
                    try:
                        resp = session.get(url, headers=headers, timeout=20)
                    except Exception as exc:
                        logger.warning("[linkedin] İstek hatası (%s, start=%d): %s", q_label, start, exc)
                        resp = None
                        break

                    if resp.status_code != 429:
                        break

                    if attempt < max_429_retries:
                        wait_s = random.uniform(10.0, 16.0) * (attempt + 1)
                        logger.warning(
                            "[linkedin] 429 (%s, start=%d) — %.1f sn beklenip tekrar deneniyor (%d/%d)...",
                            q_label,
                            start,
                            wait_s,
                            attempt + 1,
                            max_429_retries,
                        )
                        time.sleep(wait_s)
                        imp_idx = (imp_idx + 1) % len(IMPERSONATIONS)
                        session = cf_requests.Session(impersonate=IMPERSONATIONS[imp_idx])
                    else:
                        logger.warning(
                            "[linkedin] 429 devam ediyor (%s, start=%d) — bu dilim %d ilanla tamamlandı.",
                            q_label,
                            start,
                            q_collected,
                        )

                if resp is None or resp.status_code != 200 or not resp.text.strip():
                    break

                tree = LexborHTMLParser(resp.text)
                cards = tree.css("li")
                if not cards:
                    break

                start += len(cards)
                page_added = 0
                stop_query = False

                for li in cards:
                    card = li.css_first("div.base-card, div.job-search-card") or li
                    link_node = card.css_first("a.base-card__full-link, a.base-search-card--link")
                    title_node = card.css_first("h3.base-search-card__title")
                    company_node = card.css_first("h4.base-search-card__subtitle")
                    loc_node = card.css_first("span.job-search-card__location")
                    time_node = card.css_first("time")

                    if not link_node or not title_node or not company_node:
                        continue

                    href = (link_node.attributes.get("href") or "").split("?")[0].strip()
                    title = re.sub(r"\s+", " ", title_node.text(strip=True))
                    company_name = re.sub(r"\s+", " ", company_node.text(strip=True))
                    loc_str = re.sub(r"\s+", " ", loc_node.text(strip=True)) if loc_node else None

                    if not href or not title or not company_name:
                        continue

                    external_id = _extract_job_id(card, href)
                    if not external_id:
                        continue

                    if turkey_only and loc_str and not is_turkey_location(loc_str):
                        continue

                    # Aynı ilan başka bir sorgudan (ör. genel + staj) zaten geldiyse eksik alanları zenginleştir
                    if external_id in collected_by_id:
                        prev = collected_by_id[external_id]
                        if forced_emp_type == "internship":
                            prev.employment_type = "internship"
                        continue

                    logo_url = _extract_logo_url(card)
                    time_text = time_node.text(strip=True) if time_node else None
                    time_dt_attr = time_node.attributes.get("datetime") if time_node else None
                    posted_at = _parse_relative_time(time_text, time_dt_attr)
                    city = normalize_city(loc_str)

                    # LinkedIn guest API ne kart/detay HTML'inde ne de f_WT filtresinde gerçek
                    # çalışma modeli döndürür (f_WT parametresi guest endpoint'te yok sayılır).
                    # Yanlış/tahmini etiket basmamak için LinkedIn ilanlarında work_mode unknown bırakılır.
                    work_mode: WorkMode = "unknown"
                    detected_emp = detect_employment_type(title)
                    if forced_emp_type == "internship" or detected_emp == "internship":
                        emp_type: EmploymentType = "internship"
                    elif forced_emp_type:
                        emp_type = forced_emp_type
                    else:
                        emp_type = detected_emp

                    if external_id in existing:
                        consecutive_existing += 1
                    else:
                        consecutive_existing = 0

                    collected_by_id[external_id] = JobPayload(
                        company_name=company_name,
                        company_logo_url=logo_url,
                        source_platform="linkedin",
                        external_id=external_id,
                        dedupe_hash=compute_dedupe_hash(company_name, title, city),
                        title=title,
                        description=None,
                        apply_url=href,
                        location=loc_str,
                        city=city,
                        work_mode=work_mode,
                        employment_type=emp_type,
                        category=detect_category(title),
                        department=None,
                        posted_at=posted_at,
                    )
                    page_added += 1
                    q_collected += 1

                    # İlk zenginleştirme turlarında work_mode güncellemesi için 20'ye kadar izin ver
                    if consecutive_existing >= 20:
                        logger.info(
                            "[linkedin] '%s' mevcut ilanlara ulaştı, artımlı tarama durduruldu.",
                            q_label,
                        )
                        stop_query = True
                        break

                logger.info(
                    "[linkedin] %s: bu sayfada +%d ilan (dilim toplamı: %d)",
                    q_label,
                    page_added,
                    q_collected,
                )

                if stop_query or page_added == 0:
                    break

        # Yeni gelen ve daha önce detayı/türü eksik kalmış LinkedIn ilanlarını (en fazla 150 adet)
        # gerçek 'Tam Zamanlı / Yarı Zamanlı / Sözleşmeli / Staj' bilgisi ve tam açıklamasıyla zenginleştir
        enriched = 0
        enriched_new = 0
        enriched_backfill = 0
        max_enrich = int(source.config.get("max_detail_enrichment", 150))
        unenriched: set[str] = source.config.get("_unenriched_ids") or set()
        candidates = [
            (ext_id, job)
            for ext_id, job in collected_by_id.items()
            if ext_id not in existing or ext_id in unenriched
        ]
        # Önce YENİ ilanlara (ve kendi içinde stajlara), sonra önceki turlardan eksik kalanlara öncelik ver
        candidates.sort(
            key=lambda pair: (
                0 if pair[0] not in existing else 1,
                0 if pair[1].employment_type == "internship" else 1,
            )
        )

        for ext_id, job in candidates:
            if enriched >= max_enrich:
                break
            numeric_id = ext_id.replace("li-", "").strip()
            if not numeric_id.isdigit():
                continue
            time.sleep(random.uniform(0.5, 0.9))
            sched, real_emp, desc = _fetch_linkedin_detail(session, numeric_id, max_retries=3)
            if sched and sched != "Staj":
                job.work_schedule = sched
            if real_emp:
                # Staj ilanında staj türü korunsun (Tam/Yarı Zamanlı bilgisi work_schedule'da durur)
                if job.employment_type != "internship":
                    job.employment_type = real_emp
            if desc:
                job.description = desc
            enriched += 1
            if ext_id not in existing:
                enriched_new += 1
            else:
                enriched_backfill += 1

        if enriched:
            logger.info(
                "[linkedin] %d ilan zenginleştirildi (%d yeni + %d eski eksik).",
                enriched,
                enriched_new,
                enriched_backfill,
            )

        return list(collected_by_id.values())
