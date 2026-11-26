from __future__ import annotations

import logging
import math
import random
import time
from datetime import datetime, timezone
from typing import Any

from scraper.adapters.base import BaseAdapter
from scraper.models import JobPayload, SourceConfig, SourcePlatform
from scraper.normalizer import (
    compute_dedupe_hash,
    detect_category,
    detect_employment_type,
    detect_work_mode,
    is_turkey_location,
    normalize_city,
)

logger = logging.getLogger(__name__)


def _clean_str(val: Any) -> str | None:
    if val is None:
        return None
    if isinstance(val, float) and math.isnan(val):
        return None
    s = str(val).strip()
    return s if s and s.lower() != "nan" else None


class JobSpyPortalAdapter(BaseAdapter):
    """
    LinkedIn ve Indeed için python-jobspy tabanlı artımlı (son 24 saat) portal adapter'ı.
    - Ban / 429 riskini azaltmak için terimler arası rastgele bekleme (jitter) uygular.
    - Yalnızca son `hours_old` saatteki ilanları çeker ve mevcut ilanları görünce erken durur.
    - Türkiye dışı sızan ilanları `is_turkey_location` ile eler.
    - Seçenek A: Açıklamaları ekstra istek atmadan (linkedin_fetch_description=False) güvenli çeker.
    """

    def fetch_jobs(
        self,
        source: SourceConfig,
        existing_external_ids: set[str] | None = None,
    ) -> list[JobPayload]:
        from jobspy import scrape_jobs

        site_name: SourcePlatform = source.config.get("site_name", "linkedin")
        location = source.config.get("location", "Turkey")
        country_indeed = source.config.get("country_indeed", "Turkey")
        hours_old = int(source.config.get("hours_old", 24))
        results_wanted = int(source.config.get("results_wanted", 35))
        turkey_only = bool(source.config.get("turkey_only", True))
        delay_min = float(source.config.get("delay_min_sec", 4.0))
        delay_max = float(source.config.get("delay_max_sec", 7.0))
        search_terms: list[str] = source.config.get("search_terms") or ["staj", "mühendis"]

        existing = existing_external_ids or set()
        collected: list[JobPayload] = []
        seen_in_run: set[str] = set()

        for idx, term in enumerate(search_terms):
            if idx > 0 and delay_max > 0:
                sleep_sec = random.uniform(delay_min, delay_max)
                logger.info("[%s] Hız sınırı koruması: %.1f sn bekleniyor...", site_name, sleep_sec)
                time.sleep(sleep_sec)

            try:
                scrape_kwargs: dict[str, Any] = {
                    "site_name": [site_name],
                    "location": location,
                    "results_wanted": results_wanted,
                    "hours_old": hours_old,
                    "country_indeed": country_indeed,
                    "linkedin_fetch_description": False,
                }
                if term:
                    scrape_kwargs["search_term"] = term
                df = scrape_jobs(**scrape_kwargs)
            except Exception as exc:
                logger.warning("JobSpy terim hatası (%s / %s): %s", site_name, term or "<genel>", exc)
                continue

            if df is None or df.empty:
                continue

            consecutive_existing = 0
            for row in df.to_dict(orient="records"):
                external_id = _clean_str(row.get("id")) or _clean_str(row.get("job_url"))
                title = _clean_str(row.get("title"))
                company_name = _clean_str(row.get("company"))
                apply_url = _clean_str(row.get("job_url_direct")) or _clean_str(row.get("job_url"))

                if not external_id or not title or not company_name or not apply_url:
                    continue

                if external_id in seen_in_run:
                    continue
                seen_in_run.add(external_id)

                # Artımlı durdurma: art arda 5 zaten kayıtlı ilan görülürse bu terimi kes
                if external_id in existing:
                    consecutive_existing += 1
                    if consecutive_existing >= 5:
                        logger.info(
                            "[%s] '%s' için mevcut ilanlara ulaşıldı, artımlı tarama erken durduruldu.",
                            site_name,
                            term,
                        )
                        break
                    continue
                consecutive_existing = 0

                loc_str = _clean_str(row.get("location"))
                if turkey_only and loc_str and not is_turkey_location(loc_str):
                    continue

                city = normalize_city(loc_str)
                company_logo_url = _clean_str(row.get("company_logo"))
                is_remote = bool(row.get("is_remote")) if row.get("is_remote") is not None else False
                work_mode = "remote" if is_remote else detect_work_mode(loc_str, title)
                job_type = _clean_str(row.get("job_type"))
                description = _clean_str(row.get("description"))

                # Gerçek saat varsa saatle kaydet; sadece gün (date) varsa UTC midnight
                # olarak kaydedilir ve arayüz bunu sahte saat olmadan "Bugün/Dün" gösterir.
                posted_at = None
                raw_date = row.get("date_posted")
                if raw_date is not None and str(raw_date) != "NaT":
                    try:
                        if isinstance(raw_date, datetime):
                            posted_at = (
                                raw_date
                                if raw_date.tzinfo
                                else raw_date.replace(tzinfo=timezone.utc)
                            )
                        elif hasattr(raw_date, "year"):
                            posted_at = datetime(
                                raw_date.year, raw_date.month, raw_date.day, tzinfo=timezone.utc
                            )
                    except Exception:
                        posted_at = None

                collected.append(
                    JobPayload(
                        company_name=company_name,
                        company_logo_url=company_logo_url,
                        source_platform=site_name,
                        external_id=external_id,
                        dedupe_hash=compute_dedupe_hash(company_name, title, city),
                        title=title,
                        description=description,
                        apply_url=apply_url,
                        location=loc_str,
                        city=city,
                        work_mode=work_mode,
                        employment_type=detect_employment_type(title, job_type),
                        category=detect_category(title, description[:300] if description else None),
                        department=None,
                        posted_at=posted_at,
                    )
                )

        return collected
