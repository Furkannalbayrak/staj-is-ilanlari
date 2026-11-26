from __future__ import annotations

import json
import logging
import random
import re
import time
from datetime import datetime, timezone
from urllib.parse import urljoin

from curl_cffi import requests as cf_requests
from selectolax.lexbor import LexborHTMLParser

from scraper.adapters.base import BaseAdapter
from scraper.models import JobPayload, SourceConfig
from scraper.normalizer import (
    compute_dedupe_hash,
    detect_category,
    detect_employment_type,
    detect_work_mode,
    normalize_city,
    strip_html,
)

logger = logging.getLogger(__name__)

BASE_URL = "https://www.youthall.com"
LIST_URLS = [
    "https://www.youthall.com/tr/is-ilanlari/",
]


def _fetch_detail_jsonld(
    session: cf_requests.Session, url: str
) -> tuple[datetime | None, str | None]:
    """
    Youthall ilan detay sayfasındaki Schema.org JobPosting JSON-LD'den
    gerçek `datePosted` ve tam `description` bilgisini çeker.
    """
    try:
        resp = session.get(url, timeout=15, allow_redirects=True)
        if resp.status_code != 200 or not resp.text:
            return None, None

        tree = LexborHTMLParser(resp.text)
        for script in tree.css("script"):
            if script.attributes.get("type") != "application/ld+json":
                continue
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

                posted_at = None
                raw_date = item.get("datePosted")
                if isinstance(raw_date, str) and len(raw_date) >= 10:
                    try:
                        if "T" in raw_date:
                            posted_at = datetime.fromisoformat(raw_date.replace("Z", "+00:00"))
                        else:
                            posted_at = datetime.strptime(raw_date[:10], "%Y-%m-%d").replace(
                                tzinfo=timezone.utc
                            )
                    except ValueError:
                        posted_at = None

                full_desc = strip_html(item.get("description"))
                return posted_at, full_desc
    except Exception as exc:
        logger.debug("[youthall] Detay JSON-LD okunamadı (%s): %s", url, exc)
    return None, None


class YouthallAdapter(BaseAdapter):
    """
    Youthall (is-ilanlari) için izole portal adapter'ı.
    - Liste sayfasından aktif ilanları, şirket logolarını ve son başvuru tarihlerini alır.
    - Detay sayfasındaki JSON-LD'den gerçek yayın tarihi (datePosted) ve tam açıklamayı çeker.
    """

    def fetch_jobs(
        self,
        source: SourceConfig,
        existing_external_ids: set[str] | None = None,
    ) -> list[JobPayload]:
        max_pages = int(source.config.get("max_pages", 10))
        delay_min = float(source.config.get("delay_min_sec", 0.6))
        delay_max = float(source.config.get("delay_max_sec", 1.2))
        list_urls: list[str] = source.config.get("list_urls") or LIST_URLS

        session = cf_requests.Session(impersonate="chrome124")
        collected: list[JobPayload] = []
        seen_ids: set[str] = set()

        req_idx = 0
        for base_list_url in list_urls:
            section_name = base_list_url.rstrip("/").split("/")[-1]
            for page in range(1, max_pages + 1):
                if req_idx > 0:
                    time.sleep(random.uniform(delay_min, delay_max))
                req_idx += 1

                url = base_list_url if page == 1 else f"{base_list_url}?page={page}"
                resp = session.get(url, timeout=25, allow_redirects=True)
                if resp.status_code != 200 or not resp.text.strip():
                    break

                tree = LexborHTMLParser(resp.text)
                cards = [a for a in tree.css("a") if a.css_first(".jobs-body")]
                if not cards:
                    break

                page_new = 0
                for card in cards:
                    href = (card.attributes.get("href") or "").strip()
                    if not href:
                        continue
                    apply_url = urljoin(BASE_URL, href).split("?")[0]

                    slug_part = apply_url.rstrip("/").split("/")[-1]
                    ext_id = f"yt-{re.sub(r'[^a-zA-Z0-9_-]', '', slug_part)}"
                    if not slug_part or ext_id in seen_ids:
                        continue
                    seen_ids.add(ext_id)

                    title_node = card.css_first(".jobs-content-title h5, .jobs-content-title")
                    title = re.sub(r"\s+", " ", title_node.text(strip=True)) if title_node else ""
                    if not title:
                        continue

                    logo_node = card.css_first("img.jobs-content-logo")
                    company_logo_url = None
                    company_name = ""
                    if logo_node:
                        src = (logo_node.attributes.get("src") or "").strip()
                        if src.startswith("http"):
                            company_logo_url = src
                        alt = (logo_node.attributes.get("alt") or "").strip()
                        company_name = re.sub(r"\s+logo$", "", alt, flags=re.IGNORECASE).strip()

                    if not company_name:
                        cover_img = card.css_first(".jobs-cover img")
                        if cover_img:
                            cover_alt = (cover_img.attributes.get("alt") or "").strip()
                            if " - " in cover_alt:
                                company_name = cover_alt.split(" - ", 1)[0].strip()

                    if not company_name:
                        parts = [p for p in apply_url.replace(BASE_URL, "").split("/") if p]
                        company_name = parts[1].replace("-", " ").title() if len(parts) >= 2 else "Youthall"

                    desc_node = card.css_first(".jobs-content-desc")
                    summary_text = re.sub(r"\s+", " ", desc_node.text(strip=True)) if desc_node else ""

                    emp_tag = ""
                    deadline_tag = ""
                    loc_tag = ""
                    for tag in card.css(".jobs-tag"):
                        tag_text = re.sub(r"\s+", " ", tag.text(strip=True)).replace("+", "").strip()
                        if tag.css_first(".fa-briefcase"):
                            emp_tag = tag_text
                        elif tag.css_first(".fa-clock"):
                            deadline_tag = tag_text
                        elif tag.css_first(".fa-map-marker-alt"):
                            loc_tag = tag_text

                    # Detay sayfasından gerçek yayın tarihi (datePosted) ve tam açıklamayı çek
                    time.sleep(random.uniform(0.15, 0.35))
                    posted_at, full_desc = _fetch_detail_jsonld(session, apply_url)

                    desc_parts = []
                    if deadline_tag:
                        desc_parts.append(f"Son başvuru tarihi: {deadline_tag}")
                    if full_desc:
                        desc_parts.append(full_desc)
                    elif summary_text:
                        desc_parts.append(summary_text)
                    description = "\n\n".join(desc_parts) or None

                    city = normalize_city(loc_tag)
                    emp_type = detect_employment_type(title, emp_tag)

                    collected.append(
                        JobPayload(
                            company_name=company_name,
                            company_logo_url=company_logo_url,
                            source_platform="youthall",
                            external_id=ext_id,
                            dedupe_hash=compute_dedupe_hash(company_name, title, city),
                            title=title,
                            description=description,
                            apply_url=apply_url,
                            location=loc_tag or "Türkiye",
                            city=city,
                            work_mode=detect_work_mode(loc_tag, title, emp_tag),
                            employment_type=emp_type,
                            category=detect_category(title, full_desc[:400] if full_desc else summary_text),
                            department=None,
                            posted_at=posted_at,
                        )
                    )
                    page_new += 1

                logger.info(
                    "[youthall/%s] Sayfa %d: +%d ilan (toplam: %d)",
                    section_name,
                    page,
                    page_new,
                    len(collected),
                )
                if page_new == 0:
                    break

        return collected
