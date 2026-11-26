from __future__ import annotations

import logging
import random
import re
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

from curl_cffi import requests as cf_requests
from selectolax.lexbor import LexborHTMLParser

from scraper.adapters.base import BaseAdapter
from scraper.models import JobPayload, SourceConfig
from scraper.normalizer import (
    compute_dedupe_hash,
    detect_category,
    detect_employment_type,
    detect_work_mode,
    is_turkey_location,
    normalize_city,
)

logger = logging.getLogger(__name__)

SEARCH_ENDPOINT = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
IMPERSONATIONS = ["chrome124", "chrome120", "chrome116", "safari17_0"]


def _parse_relative_time(text: str | None, fallback_date: str | None) -> datetime | None:
    """LinkedIn kartındaki '2 hours ago', '35 minutes ago', 'Just now' metninden gerçek UTC zaman üretir."""
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


class LinkedInGuestAdapter(BaseAdapter):
    """
    LinkedIn'in herkese açık guest arama API'sinden doğrudan veri çeker:
    - Dinamik sayfalama (start += gelen kart sayısı -> hiç ilan atlamaz)
    - Tek istekte gerçek şirket logoları (media.licdn.com) ve gerçek yayın saatleri
    - 429 hız sınırında akıllı bekleme (exponential backoff) ve oturum yenileme
    - En yeniden eskiye sıralı (sortBy=DD) artımlı tarama
    """

    def fetch_jobs(
        self,
        source: SourceConfig,
        existing_external_ids: set[str] | None = None,
    ) -> list[JobPayload]:
        location = source.config.get("location", "Turkey")
        hours_old = int(source.config.get("hours_old", 24))
        max_jobs_per_term = int(source.config.get("max_jobs_per_term", 250))
        turkey_only = bool(source.config.get("turkey_only", True))
        delay_min = float(source.config.get("delay_min_sec", 2.0))
        delay_max = float(source.config.get("delay_max_sec", 3.8))
        max_429_retries = int(source.config.get("max_429_retries", 2))
        search_terms: list[str] = source.config.get("search_terms") or ["", "staj"]

        existing = existing_external_ids or set()
        collected: list[JobPayload] = []
        seen_in_run: set[str] = set()
        tpr_seconds = hours_old * 3600

        imp_idx = 0
        session = cf_requests.Session(impersonate=IMPERSONATIONS[imp_idx])
        headers = {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9,tr-TR;q=0.8,tr;q=0.7",
        }

        request_count = 0
        for term in search_terms:
            term_label = term or "<tüm-sektörler>"
            start = 0
            term_collected = 0
            consecutive_existing = 0

            while term_collected < max_jobs_per_term and start < 975:
                if request_count > 0:
                    time.sleep(random.uniform(delay_min, delay_max))
                request_count += 1

                params: dict[str, str | int] = {
                    "location": location,
                    "f_TPR": f"r{tpr_seconds}",
                    "sortBy": "DD",
                    "start": start,
                }
                if term:
                    params["keywords"] = term

                url = f"{SEARCH_ENDPOINT}?{urlencode(params)}"
                resp = None

                for attempt in range(max_429_retries + 1):
                    try:
                        resp = session.get(url, headers=headers, timeout=20)
                    except Exception as exc:
                        logger.warning("[linkedin] İstek hatası (%s, start=%d): %s", term_label, start, exc)
                        resp = None
                        break

                    if resp.status_code != 429:
                        break

                    if attempt < max_429_retries:
                        wait_s = random.uniform(10.0, 16.0) * (attempt + 1)
                        logger.warning(
                            "[linkedin] 429 (%s, start=%d) — %.1f sn beklenip tekrar deneniyor (%d/%d)...",
                            term_label,
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
                            "[linkedin] 429 devam ediyor (%s, start=%d) — bu terim %d ilanla tamamlandı.",
                            term_label,
                            start,
                            term_collected,
                        )

                if resp is None or resp.status_code != 200 or not resp.text.strip():
                    break

                tree = LexborHTMLParser(resp.text)
                cards = tree.css("li")
                if not cards:
                    break

                # Dinamik sayfa ilerletme: LinkedIn kaç kart döndürdüyse tam o kadar ilerle
                start += len(cards)

                page_added = 0
                stop_term = False
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
                    if not external_id or external_id in seen_in_run:
                        continue
                    seen_in_run.add(external_id)

                    if turkey_only and loc_str and not is_turkey_location(loc_str):
                        continue

                    logo_url = _extract_logo_url(card)
                    time_text = time_node.text(strip=True) if time_node else None
                    time_dt_attr = time_node.attributes.get("datetime") if time_node else None
                    posted_at = _parse_relative_time(time_text, time_dt_attr)
                    city = normalize_city(loc_str)

                    if external_id in existing:
                        consecutive_existing += 1
                    else:
                        consecutive_existing = 0

                    collected.append(
                        JobPayload(
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
                            work_mode=detect_work_mode(loc_str, title),
                            employment_type=detect_employment_type(title),
                            category=detect_category(title),
                            department=None,
                            posted_at=posted_at,
                        )
                    )
                    page_added += 1
                    term_collected += 1

                    if consecutive_existing >= 15:
                        logger.info(
                            "[linkedin] '%s' mevcut ilanlara ulaştı, artımlı tarama durduruldu.",
                            term_label,
                        )
                        stop_term = True
                        break

                logger.info(
                    "[linkedin] %s: bu sayfada +%d ilan (terim toplamı: %d)",
                    term_label,
                    page_added,
                    term_collected,
                )

                if stop_term or page_added == 0:
                    break

        return collected
