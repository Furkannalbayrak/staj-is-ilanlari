from __future__ import annotations

import logging
import os
from typing import Any

import httpx

from scraper.db import Database
from scraper.normalizer import fold_tr

logger = logging.getLogger(__name__)

_TR_EN_SYNONYMS: list[tuple[str, ...]] = [
    ("yazilim muhendisi", "yazilim gelistirici", "yazilim", "software engineer", "software developer", "backend", "frontend", "fullstack"),
    ("staj", "stajyer", "intern", "internship", "working student", "aday muhendis"),
    ("yeni mezun", "new grad", "graduate", "junior", "entry level"),
    ("veri bilimi", "yapay zeka", "data scientist", "data engineer", "data analyst", "machine learning", "ai engineer"),
    ("makine muhendisi", "mechanical engineer", "mekatronik", "mechatronics"),
    ("elektrik elektronik", "electrical engineer", "electronics engineer", "embedded", "gomulu"),
    ("endustri muhendisi", "industrial engineer", "supply chain", "kalite", "uretim"),
    ("urun yoneticisi", "product manager", "product owner"),
    ("insan kaynaklari", "human resources", "hr", "recruiter", "talent acquisition"),
    ("pazarlama", "marketing", "growth"),
    ("finans", "muhasebe", "finance", "accounting"),
]


def _expand_keyword(kw: str) -> list[str]:
    norm = fold_tr(kw)
    if not norm:
        return []
    expanded = {norm}
    for group in _TR_EN_SYNONYMS:
        if any(norm == g or norm in g or g in norm for g in group):
            expanded.update(group)
    return list(expanded)


def _matches_alert(job: dict[str, Any], alert: dict[str, Any]) -> bool:
    cities: list[str] = alert.get("cities") or []
    if cities:
        job_city = fold_tr(job.get("city") or job.get("location"))
        if not any(fold_tr(c) == job_city for c in cities):
            return False

    emp_types: list[str] = alert.get("employment_types") or []
    if emp_types and job.get("employment_type") not in emp_types:
        return False

    work_modes: list[str] = alert.get("work_modes") or []
    if work_modes and job.get("work_mode") not in work_modes:
        return False

    categories: list[str] = alert.get("categories") or []
    if categories and job.get("category") not in categories:
        return False

    company_ids: list[str] = alert.get("company_ids") or []
    if company_ids and job.get("company_id") not in company_ids:
        return False

    keywords: list[str] = alert.get("keywords") or []
    if keywords:
        haystack = fold_tr(
            f"{job.get('title', '')} {job.get('company_name', '')} {job.get('department', '')}"
        )
        matched_any = False
        for kw in keywords:
            if not kw.strip():
                continue
            if any(term in haystack for term in _expand_keyword(kw)):
                matched_any = True
                break
        if not matched_any:
            return False

    return True


def _send_resend_email(to_email: str, alert_name: str, matched_jobs: list[dict[str, Any]]) -> None:
    api_key = os.getenv("RESEND_API_KEY")
    from_email = os.getenv("RESEND_FROM_EMAIL", "onboarding@resend.dev")
    if not api_key or not to_email:
        return

    items_html = "".join(
        f"""
        <li style="margin-bottom:12px;">
          <strong>{job['title']}</strong> — {job['company_name']}
          <br/>
          <span style="color:#64748b;font-size:13px;">
            {job.get('city') or job.get('location') or 'Türkiye'} · {job.get('employment_type')}
          </span>
          <br/>
          <a href="{job['apply_url']}" style="color:#1d4ed8;text-decoration:none;">İlana Başvur →</a>
        </li>
        """
        for job in matched_jobs[:15]
    )

    html = f"""
    <div style="font-family:Inter,system-ui,sans-serif;max-width:600px;margin:0 auto;color:#0f172a;">
      <h2 style="font-size:18px;margin-bottom:8px;">Yeni ilanlar bulundu: {alert_name}</h2>
      <p style="color:#475569;font-size:14px;">
        Kurduğun alarma uyan <strong>{len(matched_jobs)}</strong> yeni ilan eklendi:
      </p>
      <ul style="padding-left:18px;">{items_html}</ul>
    </div>
    """

    resp = httpx.post(
        "https://api.resend.com/emails",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={
            "from": from_email,
            "to": [to_email],
            "subject": f"[{len(matched_jobs)} Yeni İlan] {alert_name}",
            "html": html,
        },
        timeout=15.0,
    )
    resp.raise_for_status()


def _send_telegram(chat_id: str, alert_name: str, matched_jobs: list[dict[str, Any]]) -> None:
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not token or not chat_id:
        return

    lines = [f"🔔 *{alert_name}* ({len(matched_jobs)} yeni ilan)\n"]
    for job in matched_jobs[:10]:
        city = job.get("city") or job.get("location") or "Türkiye"
        lines.append(
            f"• *{job['title']}* — {job['company_name']} ({city})\n  {job['apply_url']}"
        )

    resp = httpx.post(
        f"https://api.telegram.org/bot{token}/sendMessage",
        json={
            "chat_id": chat_id,
            "text": "\n".join(lines),
            "parse_mode": "Markdown",
            "disable_web_page_preview": True,
        },
        timeout=15.0,
    )
    resp.raise_for_status()


def notify_for_new_jobs(db: Database, new_jobs: list[dict[str, Any]]) -> int:
    """Yeni eklenen ilanları aktif kullanıcı alarmlarıyla eşleştirip bildirim gönderir."""
    if not new_jobs:
        return 0

    alerts = db.get_active_alerts()
    if not alerts:
        return 0

    sent_count = 0
    for alert in alerts:
        matched = [job for job in new_jobs if _matches_alert(job, alert)]
        if not matched:
            continue

        channel = alert.get("channel", "email")
        alert_name = alert.get("name", "İlan Alarmı")
        try:
            if channel in ("email", "both") and alert.get("user_email"):
                _send_resend_email(alert["user_email"], alert_name, matched)
                sent_count += 1
            if channel in ("telegram", "both") and alert.get("telegram_chat_id"):
                _send_telegram(alert["telegram_chat_id"], alert_name, matched)
                sent_count += 1
            db.mark_alert_notified(alert["id"])
        except Exception as exc:
            logger.warning("Alarm bildirimi gönderilemedi (alert_id=%s): %s", alert["id"], exc)

    return sent_count
