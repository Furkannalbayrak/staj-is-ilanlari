from __future__ import annotations

import json
import re
from urllib.parse import urljoin

from curl_cffi import requests as cf_requests
from selectolax.lexbor import LexborHTMLParser as HTMLParser

from scraper.adapters.base import BaseAdapter
from scraper.models import JobPayload, SourceConfig
from scraper.normalizer import (
    compute_dedupe_hash,
    detect_category,
    detect_employment_type,
    detect_work_mode,
    normalize_city,
)


class BaykarAdapter(BaseAdapter):
    """
    Baykar Teknoloji (kariyer.baykartech.com) için izole kurumsal adapter.
    Öncelik sırası: 1) JSON-LD (Schema.org JobPosting) -> 2) Temiz HTML kart ayrıştırma.
    """

    def fetch_jobs(
        self,
        source: SourceConfig,
        existing_external_ids: set[str] | None = None,
    ) -> list[JobPayload]:
        base_url = source.config.get("base_url", "https://kariyer.baykartech.com").rstrip("/")
        list_url = f"{base_url}/tr/open-positions/"

        resp = cf_requests.get(
            list_url,
            impersonate="chrome124",
            timeout=25,
            allow_redirects=True,
        )
        resp.raise_for_status()
        html = resp.text

        jobs = self._parse_json_ld(source, base_url, html)
        if jobs:
            return jobs

        return self._parse_html_cards(source, base_url, html)

    def _parse_json_ld(self, source: SourceConfig, base_url: str, html: str) -> list[JobPayload]:
        tree = HTMLParser(html)
        jobs: list[JobPayload] = []

        for script in tree.css('script[type="application/ld+json"]'):
            raw = script.text(strip=True)
            if not raw:
                continue
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue

            items = data if isinstance(data, list) else [data]
            for item in items:
                if not isinstance(item, dict) or item.get("@type") != "JobPosting":
                    continue
                title = (item.get("title") or "").strip()
                apply_url = item.get("url") or base_url
                if not title:
                    continue

                ext_id = re.sub(r"[^a-zA-Z0-9_-]", "", apply_url.rstrip("/").split("/")[-1]) or title[:40]
                loc_obj = item.get("jobLocation") or {}
                if isinstance(loc_obj, list) and loc_obj:
                    loc_obj = loc_obj[0]
                addr = (loc_obj.get("address") or {}) if isinstance(loc_obj, dict) else {}
                location = addr.get("addressLocality") or addr.get("addressRegion") or "İstanbul"
                city = normalize_city(location) or "İstanbul"

                jobs.append(
                    JobPayload(
                        company_name=source.name,
                        source_platform="direct",
                        external_id=f"{source.slug}:{ext_id}",
                        dedupe_hash=compute_dedupe_hash(source.name, title, city),
                        title=title,
                        description=item.get("description"),
                        apply_url=urljoin(base_url, apply_url),
                        location=location,
                        city=city,
                        work_mode=detect_work_mode(location, title),
                        employment_type=detect_employment_type(title, str(item.get("employmentType") or "")),
                        category=detect_category(title),
                        department=item.get("occupationalCategory"),
                    )
                )
        return jobs

    def _parse_html_cards(self, source: SourceConfig, base_url: str, html: str) -> list[JobPayload]:
        tree = HTMLParser(html)
        jobs: list[JobPayload] = []
        seen_urls: set[str] = set()

        # Baykar kariyer sayfasındaki pozisyon bağlantılarını yakala
        for anchor in tree.css('a[href*="/open-positions/"], a[href*="/basvuru/"], a[href*="/ilan/"]'):
            href = (anchor.attributes.get("href") or "").strip()
            if not href or href.rstrip("/").endswith("/open-positions"):
                continue

            full_url = urljoin(base_url, href)
            if full_url in seen_urls:
                continue
            seen_urls.add(full_url)

            # Başlık ve departman bilgisini kart içinden veya link metninden çıkar
            title_node = anchor.css_first("h1, h2, h3, h4, h5, .title, .position-title")
            title = (title_node.text(strip=True) if title_node else anchor.text(strip=True))
            title = re.sub(r"\s+", " ", title).strip()
            if not title or len(title) < 3:
                continue

            slug_part = full_url.rstrip("/").split("/")[-1]
            ext_id = re.sub(r"[^a-zA-Z0-9_-]", "", slug_part) or str(abs(hash(full_url)))

            location = "İstanbul"
            city = normalize_city(title) or "İstanbul"

            jobs.append(
                JobPayload(
                    company_name=source.name,
                    source_platform="direct",
                    external_id=f"{source.slug}:{ext_id}",
                    dedupe_hash=compute_dedupe_hash(source.name, title, city),
                    title=title,
                    description=None,
                    apply_url=full_url,
                    location=location,
                    city=city,
                    work_mode=detect_work_mode(title, location),
                    employment_type=detect_employment_type(title),
                    category=detect_category(title),
                    department=None,
                )
            )

        return jobs
