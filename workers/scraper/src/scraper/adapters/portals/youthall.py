from __future__ import annotations

import json
import logging
import random
import re
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urljoin

from curl_cffi import requests as cf_requests
from selectolax.lexbor import LexborHTMLParser

from scraper.adapters.base import BaseAdapter
from scraper.models import EmploymentType, JobPayload, SourceConfig, WorkMode
from scraper.normalizer import (
    compute_dedupe_hash,
    detect_category,
    detect_employment_type,
    fold_tr,
    normalize_city,
    strip_html,
)

logger = logging.getLogger(__name__)

BASE_URL = "https://www.youthall.com"
LIST_URLS = [
    "https://www.youthall.com/tr/is-ilanlari/",
]

_WORK_MODE_WORDS = {
    "ofisten",
    "ofis",
    "yerinde",
    "onsite",
    "on site",
    "hibrit",
    "hybrid",
    "online",
    "remote",
    "uzaktan",
    "evden",
}


def _parse_locations_and_work_mode(
    locations_text: str | None,
    jsonld_cities: list[str],
) -> tuple[str | None, str | None, WorkMode]:
    """
    Youthall 'Çalışma Lokasyonları' ve JSON-LD jobLocation listesini 3 net kuralla ayırır:
      - Çalışma modeli kelimeleri (Ofisten/Hibrit/Online/Remote) -> work_mode
      - Gerçek şehirler -> city & location
        * 0 şehir -> (None, None)
        * 1 şehir -> (şehir, şehir)
        * 2-10 şehir -> (ana TR şehri, 'Şehir1, Şehir2, ...')
        * >10 şehir -> ('Türkiye Geneli', 'Türkiye Geneli')
    """
    has_onsite = False
    has_remote = False
    has_hybrid = False
    extra_plus_count = 0
    cities: list[str] = []
    seen_city_fold: set[str] = set()

    def _add_city(raw: str) -> None:
        nonlocal has_onsite, has_remote, has_hybrid, extra_plus_count
        token = re.sub(r"\s+", " ", raw).strip()
        if not token:
            return
        low = fold_tr(token)

        # "+78 şehir daha" veya "+2 more" ifadelerini sayaca ekle
        m_plus = re.search(r"\+\s*(\d+)", token)
        if m_plus and ("sehir" in low or "city" in low or "more" in low or "daha" in low):
            extra_plus_count = max(extra_plus_count, int(m_plus.group(1)))
            return

        if low in ("hibrit", "hybrid"):
            has_hybrid = True
            return
        if low in ("online", "remote", "uzaktan", "evden"):
            has_remote = True
            return
        if low in ("ofisten", "ofis", "yerinde", "onsite", "on site"):
            has_onsite = True
            return

        if low in _WORK_MODE_WORDS:
            return

        canonical = normalize_city(token) or token
        c_fold = fold_tr(canonical)
        if c_fold and c_fold not in seen_city_fold:
            seen_city_fold.add(c_fold)
            cities.append(canonical)

    if locations_text:
        for part in re.split(r"[,/|·\n]+", locations_text):
            _add_city(part)

    for jc in jsonld_cities:
        _add_city(jc)

    # 2) Çalışma modeli kararı
    if has_hybrid or (has_onsite and has_remote):
        work_mode: WorkMode = "hybrid"
    elif has_remote:
        work_mode = "remote"
    elif has_onsite:
        work_mode = "onsite"
    else:
        work_mode = "unknown"

    # 3) Şehir sayısı kararı
    total_cities = max(len(cities), len(cities) + extra_plus_count if len(jsonld_cities) <= len(cities) else len(jsonld_cities))
    if total_cities > 10:
        return "Türkiye Geneli", "Türkiye Geneli", work_mode
    if not cities:
        return None, None, work_mode
    if len(cities) == 1:
        return cities[0], cities[0], work_mode

    # 2-10 şehir: ana şehir olarak İstanbul varsa İstanbul, yoksa ilk Türkiye şehri
    tr_cities = [c for c in cities if normalize_city(c) is not None]
    if "İstanbul" in tr_cities:
        primary_city = "İstanbul"
    elif tr_cities:
        primary_city = tr_cities[0]
    else:
        primary_city = cities[0]

    # Ana şehri başa alarak tam listeyi location'da sakla
    ordered = [primary_city] + [c for c in cities if c != primary_city]
    location_full = ", ".join(ordered)
    return primary_city, location_full, work_mode


def _parse_employment_type(ilan_turu: str | None) -> tuple[EmploymentType, str | None]:
    """
    Youthall 'İlan Türü' / 'Type' alanını hiç bozmadan çevirir:
      - Stajyer/Intern -> ('internship', None)
      - Full Time/Tam Zamanlı -> ('full_time', None)
      - Part Time/Yarı Zamanlı -> ('part_time', None)
      - Yeni Mezun/New Graduate -> ('new_grad', None)
      - Gönüllü, Dönemsel, Proje Bazlı vb. -> ('unknown', birebir gerçek etiket)
    """
    if not ilan_turu:
        return "unknown", None

    low = fold_tr(ilan_turu)
    if any(k in low for k in ("staj", "intern")):
        return "internship", None
    if any(k in low for k in ("yeni mezun", "new grad", "graduate")):
        return "new_grad", None
    if any(k in low for k in ("yari zamanli", "part time")):
        return "part_time", None
    if any(k in low for k in ("tam zamanli", "full time")):
        return "full_time", None
    if any(k in low for k in ("sozlesmeli", "contract")):
        return "contract", None

    # Gönüllü, Dönemsel, Proje Bazlı vb. -> birebir kendi gerçek adıyla sakla
    return "unknown", ilan_turu.strip()


def _fetch_detail_data(session: cf_requests.Session, url: str) -> dict[str, Any]:
    out: dict[str, Any] = {
        "title": None,
        "posted_at": None,
        "description": None,
        "department": None,
        "ilan_turu": None,
        "locations_text": None,
        "jsonld_cities": [],
        "deadline": None,
        "salary": None,
    }
    try:
        resp = session.get(url, timeout=15, allow_redirects=True)
        if resp.status_code != 200 or not resp.text:
            return out

        tree = LexborHTMLParser(resp.text)

        # 1) Sağ bilgi kutusu (.jd-facts__row) - hem Türkçe hem İngilizce destekli
        for row in tree.css(".jd-facts__row"):
            parts = [
                re.sub(r"\s+", " ", p).strip()
                for p in row.text(separator="||", strip=True).split("||")
                if p.strip()
            ]
            if len(parts) < 2:
                continue
            label = fold_tr(parts[0])
            value = ", ".join(parts[1:]).strip()
            if not value:
                continue
            if "departman" in label or "department" in label or "job function" in label:
                out["department"] = value
            elif "ilan turu" in label or label == "type" or "job type" in label:
                out["ilan_turu"] = value
            elif "son basvuru" in label or "deadline" in label:
                out["deadline"] = value
            elif "maas" in label or "salary" in label:
                out["salary"] = value
            elif "calisma lokasyon" in label or "working location" in label or "location" in label:
                out["locations_text"] = value

        # 2) Schema.org JobPosting JSON-LD
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

                if isinstance(item.get("title"), str) and item["title"].strip():
                    out["title"] = item["title"].strip()

                raw_date = item.get("datePosted")
                if isinstance(raw_date, str) and len(raw_date) >= 10:
                    try:
                        if "T" in raw_date:
                            out["posted_at"] = datetime.fromisoformat(
                                raw_date.replace("Z", "+00:00")
                            )
                        else:
                            out["posted_at"] = datetime.strptime(
                                raw_date[:10], "%Y-%m-%d"
                            ).replace(tzinfo=timezone.utc)
                    except ValueError:
                        pass

                # Çoklu şehir listesi (JSON-LD jobLocation)
                jlocs = item.get("jobLocation")
                if isinstance(jlocs, dict):
                    jlocs = [jlocs]
                if isinstance(jlocs, list):
                    for loc_obj in jlocs:
                        if not isinstance(loc_obj, dict):
                            continue
                        addr = loc_obj.get("address") or {}
                        if isinstance(addr, dict):
                            loc_name = addr.get("addressLocality") or addr.get("addressRegion")
                            if isinstance(loc_name, str) and loc_name.strip():
                                out["jsonld_cities"].append(loc_name.strip())

                out["description"] = strip_html(item.get("description"))
                break
    except Exception as exc:
        logger.debug("[youthall] Detay okunamadı (%s): %s", url, exc)
    return out


class YouthallAdapter(BaseAdapter):
    """
    Youthall (is-ilanlari) için izole portal adapter'ı.
    - Tüm uç senaryoları (0 şehir / 1 şehir / 2-10 şehir / Türkiye Geneli,
      Online / Hibrit / Ofisten, Gönüllü / Dönemsel / Proje Bazlı / Staj / Tam Zamanlı)
      %100 gerçek detay verisinden ayrıştırır.
    """

    def fetch_jobs(
        self,
        source: SourceConfig,
        existing_external_ids: set[str] | None = None,
    ) -> list[JobPayload]:
        max_pages = int(source.config.get("max_pages", 10))
        delay_min = float(source.config.get("delay_min_sec", 0.5))
        delay_max = float(source.config.get("delay_max_sec", 1.0))
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
                    card_title = (
                        re.sub(r"\s+", " ", title_node.text(strip=True)) if title_node else ""
                    )

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
                        company_name = (
                            parts[1].replace("-", " ").title() if len(parts) >= 2 else "Youthall"
                        )

                    desc_node = card.css_first(".jobs-content-desc")
                    summary_text = (
                        re.sub(r"\s+", " ", desc_node.text(strip=True)) if desc_node else ""
                    )

                    card_emp_tag = ""
                    card_deadline_tag = ""
                    card_loc_tag = ""
                    for tag in card.css(".jobs-tag"):
                        tag_text = re.sub(r"\s+", " ", tag.text(strip=True)).replace("+", "").strip()
                        if tag.css_first(".fa-briefcase"):
                            card_emp_tag = tag_text
                        elif tag.css_first(".fa-clock"):
                            card_deadline_tag = tag_text
                        elif tag.css_first(".fa-map-marker-alt"):
                            card_loc_tag = tag_text

                    # Detay sayfasından tüm gerçek alanları çek
                    time.sleep(random.uniform(0.15, 0.35))
                    detail = _fetch_detail_data(session, apply_url)

                    title = detail["title"] or card_title
                    if not title:
                        continue

                    real_ilan_turu = detail["ilan_turu"] or card_emp_tag
                    real_deadline = detail["deadline"] or card_deadline_tag
                    real_salary = detail["salary"]
                    full_desc = detail["description"]

                    # 1) Şehir & Çalışma modeli ayrımı (3 kural)
                    city, location_str, work_mode = _parse_locations_and_work_mode(
                        detail["locations_text"] or card_loc_tag,
                        detail["jsonld_cities"],
                    )

                    # 2) İlan Türü (Gönüllü, Dönemsel, Proje Bazlı vb. dahil birebir gerçek)
                    emp_type, work_schedule = _parse_employment_type(real_ilan_turu)
                    if emp_type == "unknown" and not work_schedule:
                        emp_type = detect_employment_type(title)

                    meta_lines = []
                    if real_deadline:
                        meta_lines.append(f"**Son başvuru tarihi:** {real_deadline}")
                    if real_salary:
                        meta_lines.append(f"**Maaş:** {real_salary}")

                    desc_parts = []
                    if meta_lines:
                        desc_parts.append("\n".join(meta_lines))
                    if full_desc:
                        desc_parts.append(full_desc)
                    elif summary_text:
                        desc_parts.append(summary_text)
                    description = "\n\n".join(desc_parts) or None

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
                            location=location_str,
                            city=city,
                            work_mode=work_mode,
                            employment_type=emp_type,
                            work_schedule=work_schedule,
                            category=detect_category(
                                title,
                                detail["department"],
                                full_desc[:400] if full_desc else summary_text,
                            ),
                            department=detail["department"],
                            posted_at=detail["posted_at"],
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
