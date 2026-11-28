from __future__ import annotations

import json
import logging
import random
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urljoin

from curl_cffi import requests as cf_requests
from selectolax.lexbor import LexborHTMLParser

from scraper.adapters.base import BaseAdapter
from scraper.models import JobPayload, SourceConfig, WorkMode
from scraper.normalizer import (
    compute_dedupe_hash,
    detect_category,
    detect_employment_type,
    detect_work_mode,
    normalize_city,
    strip_html,
)

logger = logging.getLogger(__name__)

BASE_URL = "https://www.secretcv.com"
TRT = timezone(timedelta(hours=3))


def _parse_jobposting_jsonld(html: str) -> dict[str, Any] | None:
    tree = LexborHTMLParser(html)
    for sc in tree.css('script[type="application/ld+json"]'):
        raw = sc.text(strip=True)
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        items = data if isinstance(data, list) else [data]
        for item in items:
            if isinstance(item, dict) and item.get("@type") == "JobPosting":
                return item
    return None


def _extract_description_from_html(html: str) -> str | None:
    """
    Secretcv'nin JSON-LD description alanı tüm HTML'i silip tek düz paragraf veriyor.
    Gerçek sayfadaki <div class="cv-card content-job"> içindeki başlıkları, paragrafları
    ve <ul><li> madde işaretlerini koruyarak okunaklı Markdown açıklaması üretir.
    """
    tree = LexborHTMLParser(html)
    for box in tree.css("div.cv-card.content-job"):
        classes = (box.attributes.get("class") or "").lower()
        if "map-container" in classes:
            continue
        if not box.css_first("h2.cj-title") and not box.css_first("span.cj-title"):
            continue
        raw_box = box.html or ""
        if not raw_box:
            continue
        # Üstteki tekrar eden ilan başlığını (<h2 class="cj-title">) kaldır
        raw_box = re.sub(
            r'<h2[^>]*class="[^"]*cj-title[^"]*"[^>]*>[\s\S]*?</h2>',
            "",
            raw_box,
            count=1,
            flags=re.IGNORECASE,
        )
        # Bölüm başlıklarını (<span class="cj-title...">) <h3>'e çevir ki strip_html '### Başlık' yapsın
        raw_box = re.sub(
            r'<span[^>]*class="[^"]*cj-title[^"]*"[^>]*>([\s\S]*?)</span>',
            r"<h3>\1</h3>",
            raw_box,
            flags=re.IGNORECASE,
        )
        cleaned = strip_html(raw_box)
        if cleaned:
            cleaned = re.sub(
                r"\n+(?:İşe Başvur\s*\n+veya\s*\n+CV Oluştur(?:\s*\n+İlanı Şikayet Et)?|İlanı Şikayet Et)\s*$",
                "",
                cleaned,
                flags=re.IGNORECASE,
            ).strip()
        if cleaned and len(cleaned) >= 40:
            return cleaned
    return None


def _extract_logo_from_html(html: str) -> str | None:
    tree = LexborHTMLParser(html)
    for sel in ("img.company-logo", ".company-logo img", "img[src*='logo']", "img[src*='firma']"):
        img = tree.css_first(sel)
        if not img:
            continue
        src = (img.attributes.get("data-src") or img.attributes.get("src") or "").strip()
        if not src or "secretcv" in src.lower() and "logo" in src.lower() and "firma" not in src.lower():
            continue
        full = urljoin(BASE_URL, src)
        if full.startswith("https://") and not full.endswith(".svg"):
            return full
    return None


def _extract_city(job_location: Any) -> tuple[str | None, str | None]:
    cities: list[str] = []
    seen: set[str] = set()
    locs = job_location if isinstance(job_location, list) else ([job_location] if isinstance(job_location, dict) else [])
    for loc in locs:
        if not isinstance(loc, dict):
            continue
        addrs = loc.get("address")
        addr_list = addrs if isinstance(addrs, list) else ([addrs] if isinstance(addrs, dict) else [])
        for addr in addr_list:
            if not isinstance(addr, dict):
                continue
            cand = addr.get("addressRegion") or addr.get("addressLocality")
            if isinstance(cand, str) and cand.strip():
                c = normalize_city(cand)
                if c and c not in seen:
                    seen.add(c)
                    cities.append(c)
    if not cities:
        return None, None
    if len(cities) == 1:
        return cities[0], cities[0]
    if len(cities) > 10:
        return "Türkiye Geneli", "Türkiye Geneli"
    return cities[0], ", ".join(cities)


class SecretcvAdapter(BaseAdapter):
    """
    Secretcv (secretcv.com/is-ilanlari/) için izole artımlı portal adapter'ı.
    Sayfa sayfa (?sf=1..N) yeni ilanları tarar, sadece DB'de olmayan ilanların
    detay sayfasındaki Schema.org JobPosting JSON-LD verisini çeker.
    """

    def fetch_jobs(
        self,
        source: SourceConfig,
        existing_external_ids: set[str] | None = None,
    ) -> list[JobPayload]:
        max_pages = int(source.config.get("max_pages", 4))
        max_new_details = int(source.config.get("max_new_details", 60))
        existing = existing_external_ids or set()

        session = cf_requests.Session(impersonate="chrome124")
        headers = {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8",
        }

        jobs: list[JobPayload] = []
        seen_ids: set[str] = set()
        fetched_details = 0
        stop_all = False

        for page in range(1, max_pages + 1):
            if stop_all or fetched_details >= max_new_details:
                break
            if page > 1:
                time.sleep(random.uniform(0.5, 1.0))

            url = (
                f"{BASE_URL}/is-ilanlari/"
                if page == 1
                else f"{BASE_URL}/is-ilanlari/?sf={page}"
            )
            resp = session.get(url, headers=headers, timeout=20, allow_redirects=True)
            if resp.status_code != 200 or not resp.text:
                break

            tree = LexborHTMLParser(resp.text)
            detail_urls: list[str] = []
            for a in tree.css("a[href]"):
                href = (a.attributes.get("href") or "").strip()
                if not re.search(r"-is-ilanlari-\d+$", href):
                    continue
                full = urljoin(BASE_URL, href).split("?")[0]
                if full not in detail_urls:
                    detail_urls.append(full)

            if not detail_urls:
                break

            consecutive_existing = 0
            for detail_url in detail_urls:
                m = re.search(r"-is-ilanlari-(\d+)$", detail_url)
                if not m:
                    continue
                ext_id = f"scv-{m.group(1)}"
                if ext_id in seen_ids:
                    continue
                seen_ids.add(ext_id)

                if ext_id in existing:
                    consecutive_existing += 1
                    if consecutive_existing >= 15:
                        logger.info("[secretcv] Mevcut ilanlara ulaşıldı, artımlı tarama durduruldu.")
                        stop_all = True
                        break
                    continue
                consecutive_existing = 0

                if fetched_details >= max_new_details:
                    stop_all = True
                    break

                try:
                    time.sleep(random.uniform(0.2, 0.45))
                    dr = session.get(detail_url, headers=headers, timeout=15, allow_redirects=True)
                    fetched_details += 1
                    if dr.status_code != 200 or not dr.text:
                        continue

                    jp = _parse_jobposting_jsonld(dr.text)
                    if not jp:
                        continue

                    title = (jp.get("title") or jp.get("name") or "").strip()
                    org = jp.get("hiringOrganization") or {}
                    company_name = (org.get("name") or "").strip() if isinstance(org, dict) else ""
                    if not title or not company_name:
                        continue

                    logo = org.get("logo") if isinstance(org, dict) else None
                    company_logo_url = (
                        logo.strip()
                        if isinstance(logo, str) and logo.strip().startswith("http")
                        else _extract_logo_from_html(dr.text)
                    )

                    city, location_str = _extract_city(jp.get("jobLocation"))
                    emp_raw = jp.get("employmentType")
                    emp_str = " ".join(emp_raw) if isinstance(emp_raw, list) else str(emp_raw or "")
                    emp_type = detect_employment_type(title, emp_str)

                    loc_type = str(jp.get("jobLocationType") or "").upper()
                    work_mode: WorkMode = (
                        "remote"
                        if "TELECOMMUTE" in loc_type
                        else "unknown"
                    )

                    posted_at = None
                    raw_date = jp.get("datePosted")
                    if isinstance(raw_date, str) and raw_date.strip():
                        try:
                            dt = datetime.fromisoformat(raw_date.strip().replace("Z", "+00:00"))
                            posted_at = (
                                dt.astimezone(timezone.utc)
                                if dt.tzinfo
                                else dt.replace(tzinfo=TRT).astimezone(timezone.utc)
                            )
                        except ValueError:
                            posted_at = None

                    description = _extract_description_from_html(dr.text) or strip_html(
                        jp.get("description")
                    )

                    jobs.append(
                        JobPayload(
                            company_name=company_name,
                            company_logo_url=company_logo_url,
                            source_platform="secretcv",
                            external_id=ext_id,
                            dedupe_hash=compute_dedupe_hash(company_name, title, city),
                            title=title,
                            description=description,
                            apply_url=detail_url,
                            location=location_str,
                            city=city,
                            work_mode=work_mode,
                            employment_type=emp_type,
                            category=detect_category(title),
                            department=None,
                            posted_at=posted_at,
                        )
                    )
                except Exception as exc:
                    logger.debug("[secretcv] Detay okunamadı (%s): %s", detail_url, exc)

            logger.info("[secretcv] Sayfa %d tamamlandı (toplam yeni: %d)", page, len(jobs))

        return jobs
