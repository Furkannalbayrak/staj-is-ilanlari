-- =============================================================================
-- Türkiye İş ve Staj İlanı Platformu (MVP) - Supabase PostgreSQL Şeması + RLS
-- Bu dosyanın tamamını Supabase Dashboard -> SQL Editor içinde çalıştırın.
-- =============================================================================

-- Gerekli uzantılar
create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- 1. COMPANIES (Kurumsal Şirketler ve Büyük Portallar)
-- -----------------------------------------------------------------------------
create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  logo_url text,
  careers_url text,
  source_type text not null check (source_type in ('corporate', 'portal')),
  ats_type text not null check (
    ats_type in (
      'lever',
      'greenhouse',
      'workday',
      'successfactors',
      'peoplise',
      'smartrecruiters',
      'custom',
      'portal'
    )
  ),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_companies_slug on public.companies (slug);
create index if not exists idx_companies_is_active on public.companies (is_active);

-- -----------------------------------------------------------------------------
-- 2. JOBS (Standartlaştırılmış İş ve Staj İlanları)
-- -----------------------------------------------------------------------------
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies (id) on delete set null,
  company_name text not null,
  company_logo_url text,
  source_platform text not null check (
    source_platform in ('direct', 'linkedin', 'indeed', 'kariyernet')
  ),
  external_id text not null,
  dedupe_hash text not null,

  title text not null,
  description text,
  apply_url text not null,

  location text,
  city text,
  work_mode text not null default 'unknown' check (
    work_mode in ('onsite', 'hybrid', 'remote', 'unknown')
  ),
  employment_type text not null default 'full_time' check (
    employment_type in ('full_time', 'part_time', 'internship', 'new_grad', 'contract')
  ),
  category text not null default 'other' check (
    category in (
      'software',
      'data_ai',
      'electronics',
      'mechanical',
      'industrial',
      'finance',
      'marketing',
      'design',
      'product',
      'hr',
      'operations',
      'sales',
      'other'
    )
  ),
  department text,

  is_active boolean not null default true,
  posted_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  closed_at timestamptz,

  -- Katman 1: Aynı kaynaktan aynı ilanın tekrar eklenmesini engeller
  constraint uq_jobs_source_external unique (source_platform, external_id),
  -- Katman 2: Çapraz kaynak kopya ilanları (şirket + başlık + şehir) engeller
  constraint uq_jobs_dedupe_hash unique (dedupe_hash)
);

-- Arama ve filtreleme için performans indeksleri
create index if not exists idx_jobs_active_posted
  on public.jobs (is_active, posted_at desc nulls last, first_seen_at desc);
create index if not exists idx_jobs_city on public.jobs (city) where is_active = true;
create index if not exists idx_jobs_employment_type on public.jobs (employment_type) where is_active = true;
create index if not exists idx_jobs_work_mode on public.jobs (work_mode) where is_active = true;
create index if not exists idx_jobs_category on public.jobs (category) where is_active = true;
create index if not exists idx_jobs_company_id on public.jobs (company_id) where is_active = true;
create index if not exists idx_jobs_last_seen on public.jobs (source_platform, last_seen_at);

-- Tam metin arama (başlık + şirket + lokasyon)
create index if not exists idx_jobs_fts on public.jobs
  using gin (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(company_name, '') || ' ' || coalesce(city, ''))
  );

-- -----------------------------------------------------------------------------
-- 3. SAVED_JOBS (Kullanıcıların Kaydettiği İlanlar)
-- -----------------------------------------------------------------------------
create table if not exists public.saved_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  job_id uuid not null references public.jobs (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint uq_saved_jobs_user_job unique (user_id, job_id)
);

create index if not exists idx_saved_jobs_user on public.saved_jobs (user_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 4. ALERTS (Kullanıcı İlan Alarmları - Resend E-posta / Telegram)
-- -----------------------------------------------------------------------------
create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  user_email text, -- E-posta bildirimleri için kullanıcının oturum e-postası
  name text not null,
  keywords text[] not null default '{}',
  cities text[] not null default '{}',
  employment_types text[] not null default '{}',
  work_modes text[] not null default '{}',
  categories text[] not null default '{}',
  company_ids uuid[] not null default '{}',
  channel text not null default 'email' check (channel in ('email', 'telegram', 'both')),
  telegram_chat_id text,
  is_active boolean not null default true,
  last_notified_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_alerts_user on public.alerts (user_id, created_at desc);
create index if not exists idx_alerts_active on public.alerts (is_active) where is_active = true;

-- -----------------------------------------------------------------------------
-- 5. SCRAPE_RUNS ("Son güncelleme: X dk önce" ve adapter sağlık izleme)
-- -----------------------------------------------------------------------------
create table if not exists public.scrape_runs (
  id uuid primary key default gen_random_uuid(),
  source_slug text not null,
  status text not null check (status in ('success', 'failed', 'partial')),
  jobs_fetched integer not null default 0,
  jobs_inserted integer not null default 0,
  jobs_updated integer not null default 0,
  jobs_deactivated integer not null default 0,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz not null default now()
);

create index if not exists idx_scrape_runs_finished
  on public.scrape_runs (finished_at desc);
create index if not exists idx_scrape_runs_source
  on public.scrape_runs (source_slug, finished_at desc);

-- =============================================================================
-- ROW LEVEL SECURITY (RLS) POLİTİKALARI
-- Not: Python worker Supabase SERVICE_ROLE_KEY kullandığı için RLS'yi aşar.
-- İstemciden (anon / authenticated) ilanlara yazma tamamen kapalıdır.
-- =============================================================================

alter table public.companies enable row level security;
alter table public.jobs enable row level security;
alter table public.saved_jobs enable row level security;
alter table public.alerts enable row level security;
alter table public.scrape_runs enable row level security;

-- COMPANIES: Herkes okuyabilir, istemci yazamaz
drop policy if exists "companies_select_public" on public.companies;
create policy "companies_select_public"
  on public.companies for select
  to anon, authenticated
  using (true);

-- JOBS: Herkes aktif ilanları okuyabilir, istemci yazamaz
drop policy if exists "jobs_select_public" on public.jobs;
create policy "jobs_select_public"
  on public.jobs for select
  to anon, authenticated
  using (true);

-- SCRAPE_RUNS: Herkes son güncelleme bilgisini okuyabilir, istemci yazamaz
drop policy if exists "scrape_runs_select_public" on public.scrape_runs;
create policy "scrape_runs_select_public"
  on public.scrape_runs for select
  to anon, authenticated
  using (true);

-- SAVED_JOBS: Sadece giriş yapmış kullanıcı kendi kayıtlarını görür/yönetir
drop policy if exists "saved_jobs_select_own" on public.saved_jobs;
create policy "saved_jobs_select_own"
  on public.saved_jobs for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "saved_jobs_insert_own" on public.saved_jobs;
create policy "saved_jobs_insert_own"
  on public.saved_jobs for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "saved_jobs_delete_own" on public.saved_jobs;
create policy "saved_jobs_delete_own"
  on public.saved_jobs for delete
  to authenticated
  using (auth.uid() = user_id);

-- ALERTS: Sadece giriş yapmış kullanıcı kendi alarmlarını görür/yönetir
drop policy if exists "alerts_select_own" on public.alerts;
create policy "alerts_select_own"
  on public.alerts for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "alerts_insert_own" on public.alerts;
create policy "alerts_insert_own"
  on public.alerts for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "alerts_update_own" on public.alerts;
create policy "alerts_update_own"
  on public.alerts for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "alerts_delete_own" on public.alerts;
create policy "alerts_delete_own"
  on public.alerts for delete
  to authenticated
  using (auth.uid() = user_id);

-- =============================================================================
-- ROL YETKİLERİ (GRANT)
-- =============================================================================
grant usage on schema public to anon, authenticated, service_role;

grant select on public.companies, public.jobs, public.scrape_runs to anon, authenticated;
grant select, insert, delete on public.saved_jobs to authenticated;
grant select, insert, update, delete on public.alerts to authenticated;

grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
