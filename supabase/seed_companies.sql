-- =============================================================================
-- Başlangıç Şirket ve Portal Kayıtları (Seed)
-- schema.sql çalıştırıldıktan sonra opsiyonel olarak çalıştırılabilir.
-- Worker ayrıca registry.yaml içindeki şirketleri otomatik upsert eder.
-- =============================================================================

insert into public.companies (slug, name, careers_url, source_type, ats_type, is_active)
values
  ('insider', 'Insider', 'https://jobs.lever.co/useinsider', 'corporate', 'lever', true),
  ('baykar', 'Baykar Teknoloji', 'https://kariyer.baykartech.com', 'corporate', 'custom', true),
  ('linkedin', 'LinkedIn', 'https://www.linkedin.com/jobs', 'portal', 'portal', true),
  ('indeed', 'Indeed', 'https://tr.indeed.com', 'portal', 'portal', true)
on conflict (slug) do update set
  name = excluded.name,
  careers_url = excluded.careers_url,
  source_type = excluded.source_type,
  ats_type = excluded.ats_type,
  is_active = excluded.is_active;
