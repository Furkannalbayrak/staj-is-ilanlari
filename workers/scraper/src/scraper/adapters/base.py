from __future__ import annotations

from abc import ABC, abstractmethod

from scraper.models import JobPayload, SourceConfig


class BaseAdapter(ABC):
    """Tüm ATS, özel kurumsal ve portal adapter'larının ortak arayüzü."""

    @abstractmethod
    def fetch_jobs(
        self,
        source: SourceConfig,
        existing_external_ids: set[str] | None = None,
    ) -> list[JobPayload]:
        """Kaynaktan ilanları çeker ve standart JobPayload listesi döndürür."""
        raise NotImplementedError
