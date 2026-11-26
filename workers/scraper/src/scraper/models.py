from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

SourceType = Literal["corporate", "portal"]
AtsType = Literal[
    "lever",
    "greenhouse",
    "workday",
    "successfactors",
    "peoplise",
    "smartrecruiters",
    "custom",
    "portal",
]
SourcePlatform = Literal["direct", "linkedin", "indeed", "kariyernet", "youthall"]
WorkMode = Literal["onsite", "hybrid", "remote", "unknown"]
EmploymentType = Literal["full_time", "part_time", "internship", "new_grad", "contract", "unknown"]
JobCategory = Literal[
    "software",
    "data_ai",
    "electronics",
    "mechanical",
    "industrial",
    "finance",
    "marketing",
    "design",
    "product",
    "hr",
    "operations",
    "sales",
    "other",
]


class SourceConfig(BaseModel):
    slug: str
    name: str
    enabled: bool = True
    source_type: SourceType
    ats_type: AtsType
    adapter: str
    careers_url: str | None = None
    logo_url: str | None = None
    full_sync: bool = True
    config: dict[str, Any] = Field(default_factory=dict)


class JobPayload(BaseModel):
    company_name: str
    company_logo_url: str | None = None
    source_platform: SourcePlatform
    external_id: str
    dedupe_hash: str
    title: str
    description: str | None = None
    apply_url: str
    location: str | None = None
    city: str | None = None
    work_mode: WorkMode = "unknown"
    employment_type: EmploymentType = "unknown"
    work_schedule: str | None = None
    category: JobCategory = "other"
    department: str | None = None
    posted_at: datetime | None = None


class ScrapeResult(BaseModel):
    source_slug: str
    status: Literal["success", "failed", "partial"]
    jobs_fetched: int = 0
    jobs_inserted: int = 0
    jobs_updated: int = 0
    jobs_deactivated: int = 0
    error_message: str | None = None
    started_at: datetime
    finished_at: datetime
