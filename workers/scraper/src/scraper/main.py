from __future__ import annotations

import argparse
import logging
from datetime import datetime, timezone
from pathlib import Path

import yaml
from dotenv import load_dotenv

from scraper.adapters.ats.greenhouse import GreenhouseAdapter
from scraper.adapters.ats.lever import LeverAdapter
from scraper.adapters.base import BaseAdapter
from scraper.adapters.custom.baykar import BaykarAdapter
from scraper.adapters.portals.jobspy_portal import JobSpyPortalAdapter
from scraper.adapters.portals.linkedin import LinkedInGuestAdapter
from scraper.adapters.portals.youthall import YouthallAdapter
from scraper.db import Database
from scraper.models import ScrapeResult, SourceConfig
from scraper.notifier import notify_for_new_jobs

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
)
logger = logging.getLogger("scraper.main")

ADAPTER_REGISTRY: dict[str, type[BaseAdapter]] = {
    "ats.lever": LeverAdapter,
    "ats.greenhouse": GreenhouseAdapter,
    "custom.baykar": BaykarAdapter,
    "portals.linkedin": LinkedInGuestAdapter,
    "portals.youthall": YouthallAdapter,
    "portals.jobspy_portal": JobSpyPortalAdapter,
}


def load_sources(registry_path: Path) -> list[SourceConfig]:
    with registry_path.open("r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    return [SourceConfig(**item) for item in raw.get("sources") or []]


def run_pipeline(
    registry_path: Path,
    only_source: str | None = None,
    dry_run: bool = False,
) -> None:
    load_dotenv()
    sources = load_sources(registry_path)

    active_sources = [
        s for s in sources if s.enabled and (only_source is None or s.slug == only_source)
    ]
    if not active_sources:
        logger.warning("Çalıştırılacak aktif kaynak bulunamadı (filter=%s).", only_source)
        return

    db = None if dry_run else Database()
    all_new_jobs: list[dict] = []

    for source in active_sources:
        started_at = datetime.now(timezone.utc)
        adapter_cls = ADAPTER_REGISTRY.get(source.adapter)
        if not adapter_cls:
            logger.error("[%s] Bilinmeyen adapter: %s", source.slug, source.adapter)
            continue

        logger.info("▶ [%s] Başlatılıyor (%s)...", source.slug, source.adapter)
        try:
            company_id = db.ensure_company(source) if db else None
            existing_ids: set[str] | None = None
            if db and not source.full_sync:
                platform = source.config.get("site_name", source.slug)
                existing_ids = db.get_existing_external_ids(platform)

            adapter = adapter_cls()
            jobs = adapter.fetch_jobs(source, existing_external_ids=existing_ids)
            logger.info("  [%s] %d ilan çekildi.", source.slug, len(jobs))

            if dry_run:
                for sample in jobs[:5]:
                    logger.info(
                        "    • %s | %s | %s | %s | %s",
                        sample.company_name,
                        sample.title,
                        sample.city or "-",
                        sample.employment_type,
                        sample.category,
                    )
                continue

            assert db is not None
            inserted_rows, updated_count = db.upsert_jobs(source, company_id, jobs)
            all_new_jobs.extend(inserted_rows)

            deactivated_count = 0
            if source.full_sync and company_id and len(jobs) > 0:
                deactivated_count = db.deactivate_stale_corporate_jobs(company_id, started_at)
            elif not source.full_sync:
                platform = source.config.get("site_name", "linkedin")
                deactivated_count = db.deactivate_stale_portal_jobs(platform, max_age_days=30)

            finished_at = datetime.now(timezone.utc)
            result = ScrapeResult(
                source_slug=source.slug,
                status="success",
                jobs_fetched=len(jobs),
                jobs_inserted=len(inserted_rows),
                jobs_updated=updated_count,
                jobs_deactivated=deactivated_count,
                started_at=started_at,
                finished_at=finished_at,
            )
            db.log_scrape_run(result)
            logger.info(
                "✓ [%s] Tamamlandı: +%d yeni, ~%d güncellendi, -%d pasife çekildi.",
                source.slug,
                result.jobs_inserted,
                result.jobs_updated,
                result.jobs_deactivated,
            )
        except Exception as exc:
            finished_at = datetime.now(timezone.utc)
            logger.exception("✗ [%s] Hata oluştu (diğer kaynaklar devam edecek): %s", source.slug, exc)
            if db:
                db.log_scrape_run(
                    ScrapeResult(
                        source_slug=source.slug,
                        status="failed",
                        error_message=str(exc)[:1000],
                        started_at=started_at,
                        finished_at=finished_at,
                    )
                )

    if db and all_new_jobs:
        sent = notify_for_new_jobs(db, all_new_jobs)
        logger.info("🔔 %d yeni ilan için %d bildirim gönderildi.", len(all_new_jobs), sent)

    if db:
        try:
            pruned_jobs, pruned_runs = db.prune_old_data(
                closed_job_retention_days=30,
                scrape_run_retention_days=30,
            )
            if pruned_jobs or pruned_runs:
                logger.info(
                    "🧹 Otomatik temizlik: %d eski pasif ilan, %d eski tarama logu silindi.",
                    pruned_jobs,
                    pruned_runs,
                )
        except Exception as exc:
            logger.warning("Otomatik temizlik sırasında uyarı: %s", exc)


def cli() -> None:
    parser = argparse.ArgumentParser(description="Türkiye İş ve Staj İlanı Scraper Worker")
    parser.add_argument(
        "--registry",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "registry.yaml",
        help="registry.yaml dosya yolu",
    )
    parser.add_argument("--source", type=str, default=None, help="Sadece belirli bir source slug'ını çalıştır")
    parser.add_argument("--dry-run", action="store_true", help="Veritabanına yazmadan test et")
    args = parser.parse_args()
    run_pipeline(args.registry, only_source=args.source, dry_run=args.dry_run)


if __name__ == "__main__":
    cli()
