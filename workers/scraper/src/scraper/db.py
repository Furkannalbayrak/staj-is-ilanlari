from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from supabase import Client, create_client

from scraper.models import JobPayload, ScrapeResult, SourceConfig

logger = logging.getLogger(__name__)


class Database:
    """Supabase REST/PostgREST üzerinden doğrudan veritabanı işlemleri (ORM yok)."""

    def __init__(self, url: str | None = None, service_role_key: str | None = None) -> None:
        self.url = url or os.environ["SUPABASE_URL"]
        self.key = service_role_key or os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        self.client: Client = create_client(self.url, self.key)

    def ensure_company(self, source: SourceConfig) -> str:
        payload = {
            "slug": source.slug,
            "name": source.name,
            "logo_url": source.logo_url,
            "careers_url": source.careers_url,
            "source_type": source.source_type,
            "ats_type": source.ats_type,
            "is_active": source.enabled,
        }
        res = (
            self.client.table("companies")
            .upsert(payload, on_conflict="slug")
            .execute()
        )
        return res.data[0]["id"]

    def get_existing_external_ids(self, source_platform: str, limit: int = 2000) -> set[str]:
        """Artımlı (incremental) portal taramasında zaten kayıtlı ilanları erken durdurmak için çeker."""
        res = (
            self.client.table("jobs")
            .select("external_id")
            .eq("source_platform", source_platform)
            .order("first_seen_at", desc=True)
            .limit(limit)
            .execute()
        )
        return {row["external_id"] for row in (res.data or [])}

    def upsert_jobs(
        self,
        source: SourceConfig,
        company_id: str | None,
        jobs: list[JobPayload],
    ) -> tuple[list[dict[str, Any]], int]:
        """
        2 Katmanlı Idempotency & Deduplication:
          - Katman 1: (source_platform, external_id) eşleşiyorsa güncelle.
          - Katman 2: dedupe_hash eşleşiyorsa kurumsal ('direct') kaynağı portala tercih et.
        Dönüş: (yeni_eklenen_ilanlar, guncellenen_adet)
        """
        if not jobs:
            return [], 0

        now_iso = datetime.now(timezone.utc).isoformat()
        inserted_rows: list[dict[str, Any]] = []
        updated_count = 0

        # Tek çalışmada gelen listeyi kendi içinde dedupe_hash bazlı tekilleştir
        unique_by_hash: dict[str, JobPayload] = {}
        for job in jobs:
            if job.dedupe_hash not in unique_by_hash:
                unique_by_hash[job.dedupe_hash] = job
        deduped_jobs = list(unique_by_hash.values())

        # Mevcut dedupe_hash'leri topluca sorgula (N+1 sorgu önlenir)
        existing_by_hash: dict[str, dict[str, Any]] = {}
        hashes = [j.dedupe_hash for j in deduped_jobs]
        for i in range(0, len(hashes), 100):
            batch = hashes[i : i + 100]
            res = (
                self.client.table("jobs")
                .select("id, source_platform, external_id, dedupe_hash")
                .in_("dedupe_hash", batch)
                .execute()
            )
            for row in res.data or []:
                existing_by_hash[row["dedupe_hash"]] = row

        # Mevcut (source_platform, external_id) eşleşmelerini sorgula
        existing_by_ext: dict[tuple[str, str], dict[str, Any]] = {}
        by_platform: dict[str, list[str]] = {}
        for j in deduped_jobs:
            by_platform.setdefault(j.source_platform, []).append(j.external_id)
        for platform, ext_ids in by_platform.items():
            for i in range(0, len(ext_ids), 100):
                batch = ext_ids[i : i + 100]
                res = (
                    self.client.table("jobs")
                    .select("id, source_platform, external_id, dedupe_hash")
                    .eq("source_platform", platform)
                    .in_("external_id", batch)
                    .execute()
                )
                for row in res.data or []:
                    existing_by_ext[(row["source_platform"], row["external_id"])] = row

        to_insert: list[dict[str, Any]] = []

        for job in deduped_jobs:
            row_payload: dict[str, Any] = {
                "company_id": company_id if source.source_type == "corporate" else None,
                "company_name": job.company_name,
                "company_logo_url": job.company_logo_url or source.logo_url,
                "source_platform": job.source_platform,
                "external_id": job.external_id,
                "dedupe_hash": job.dedupe_hash,
                "title": job.title,
                "description": job.description,
                "apply_url": job.apply_url,
                "location": job.location,
                "city": job.city,
                "work_mode": job.work_mode,
                "employment_type": job.employment_type,
                "work_schedule": job.work_schedule,
                "category": job.category,
                "department": job.department,
                "is_active": True,
                "posted_at": job.posted_at.isoformat() if job.posted_at else None,
                "last_seen_at": now_iso,
                "closed_at": None,
            }

            # 1) Aynı kaynak + aynı external_id zaten varsa güncelle
            # Mevcut dolu description/work_schedule veya bilinen employment_type/work_mode'u asla boş/unknown ile ezme
            ext_match = existing_by_ext.get((job.source_platform, job.external_id))
            if ext_match:
                update_fields = {
                    k: v
                    for k, v in row_payload.items()
                    if k not in ("dedupe_hash",)
                    and not (k in ("description", "work_schedule", "company_logo_url", "posted_at") and v is None)
                    and not (k in ("employment_type", "work_mode") and v == "unknown")
                }
                self.client.table("jobs").update(update_fields).eq("id", ext_match["id"]).execute()
                updated_count += 1
                continue

            # 2) Farklı kaynaktan aynı dedupe_hash varsa öncelik kuralını uygula (direct > portal)
            hash_match = existing_by_hash.get(job.dedupe_hash)
            if hash_match:
                existing_is_direct = hash_match["source_platform"] == "direct"
                incoming_is_direct = job.source_platform == "direct"
                if existing_is_direct and not incoming_is_direct:
                    # Kurumsal kaynak zaten var -> sadece aktif tut, portal kaydını atla
                    self.client.table("jobs").update({"last_seen_at": now_iso, "is_active": True}).eq(
                        "id", hash_match["id"]
                    ).execute()
                    updated_count += 1
                else:
                    # Yeni gelen kurumsal kaynak (veya aynı öncelikte güncelleme) -> üzerine yaz
                    self.client.table("jobs").update(row_payload).eq("id", hash_match["id"]).execute()
                    updated_count += 1
                continue

            # 3) Tamamen yeni ilan
            to_insert.append(row_payload)

        # Yeni ilanları toplu ekle
        for i in range(0, len(to_insert), 50):
            batch = to_insert[i : i + 50]
            res = self.client.table("jobs").insert(batch).execute()
            inserted_rows.extend(res.data or [])

        return inserted_rows, updated_count

    def deactivate_stale_corporate_jobs(self, company_id: str, run_started_at: datetime) -> int:
        """
        Tam liste veren kurumsal kaynaklarda, son başarılı taramada görülmeyen
        eski ilanları pasife çeker.
        """
        cutoff = run_started_at.isoformat()
        now_iso = datetime.now(timezone.utc).isoformat()
        res = (
            self.client.table("jobs")
            .update({"is_active": False, "closed_at": now_iso})
            .eq("company_id", company_id)
            .eq("source_platform", "direct")
            .eq("is_active", True)
            .lt("last_seen_at", cutoff)
            .execute()
        )
        return len(res.data or [])

    def deactivate_stale_portal_jobs(self, source_platform: str, max_age_days: int = 30) -> int:
        """Artımlı çekilen büyük portallarda 30+ gündür görülmeyen ilanları pasife çeker."""
        cutoff = (datetime.now(timezone.utc) - timedelta(days=max_age_days)).isoformat()
        now_iso = datetime.now(timezone.utc).isoformat()
        res = (
            self.client.table("jobs")
            .update({"is_active": False, "closed_at": now_iso})
            .eq("source_platform", source_platform)
            .eq("is_active", True)
            .lt("last_seen_at", cutoff)
            .execute()
        )
        return len(res.data or [])

    def log_scrape_run(self, result: ScrapeResult) -> None:
        self.client.table("scrape_runs").insert(
            {
                "source_slug": result.source_slug,
                "status": result.status,
                "jobs_fetched": result.jobs_fetched,
                "jobs_inserted": result.jobs_inserted,
                "jobs_updated": result.jobs_updated,
                "jobs_deactivated": result.jobs_deactivated,
                "error_message": result.error_message,
                "started_at": result.started_at.isoformat(),
                "finished_at": result.finished_at.isoformat(),
            }
        ).execute()

    def get_active_alerts(self) -> list[dict[str, Any]]:
        res = self.client.table("alerts").select("*").eq("is_active", True).execute()
        return res.data or []

    def mark_alert_notified(self, alert_id: str) -> None:
        self.client.table("alerts").update(
            {"last_notified_at": datetime.now(timezone.utc).isoformat()}
        ).eq("id", alert_id).execute()

    def prune_old_data(
        self,
        closed_job_retention_days: int = 30,
        scrape_run_retention_days: int = 30,
    ) -> tuple[int, int]:
        """
        Veritabanının şişmesini önlemek için:
          - Kapanmasının (closed_at) üzerinden `closed_job_retention_days` gün geçmiş pasif ilanları siler.
          - `scrape_run_retention_days` günden eski tarama loglarını siler.
        """
        now = datetime.now(timezone.utc)
        job_cutoff = (now - timedelta(days=closed_job_retention_days)).isoformat()
        run_cutoff = (now - timedelta(days=scrape_run_retention_days)).isoformat()

        deleted_jobs = (
            self.client.table("jobs")
            .delete()
            .eq("is_active", False)
            .lt("closed_at", job_cutoff)
            .execute()
        )
        deleted_runs = (
            self.client.table("scrape_runs")
            .delete()
            .lt("finished_at", run_cutoff)
            .execute()
        )
        return len(deleted_jobs.data or []), len(deleted_runs.data or [])
