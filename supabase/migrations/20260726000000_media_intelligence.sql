-- Master Media Intelligence: ranking trust loop, stream sightings, subtitle sync.
--
-- Design notes:
--   * All tables are service-role only. The Vercel handlers and the media worker
--     use SUPABASE_SERVICE_ROLE_KEY; anon/authenticated get no policies here, so
--     an anon key can neither read playable URLs nor forge trust observations.
--   * Observations are append-only with a unique source event, so a retried audit
--     cannot inflate a provider's record.
--   * Trust snapshots are immutable rows keyed by version: the request path reads
--     a published snapshot and never aggregates live data.
--   * media_mappings / media_workflows (Telegram bot) are untouched.

-- ---------------------------------------------------------------------------
-- 1. Ranking audit queue: candidates whose explicit claim can be falsified.
-- ---------------------------------------------------------------------------
create table if not exists public.personal_ranking_audit_queue (
  id                    uuid primary key default gen_random_uuid(),
  provider_id           text        not null,
  provider_family       text        not null,
  stratum               text        not null,
  info_hash             text        not null,
  claim_class           text        not null check (claim_class in ('cache_positive', 'queued')),
  claim_marker          text,
  evidence              jsonb       not null default '{}'::jsonb,
  inclusion_probability double precision not null check (inclusion_probability > 0 and inclusion_probability <= 1),
  model_version         text        not null,
  parser_version        text        not null,
  capability_version    text        not null,
  status                text        not null default 'queued'
                          check (status in ('queued', 'claimed', 'done', 'failed', 'skipped')),
  attempts              integer     not null default 0,
  last_error            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- One audit per claim per model version: repeated requests must not requeue work.
create unique index if not exists personal_raq_identity_idx
  on public.personal_ranking_audit_queue (provider_id, info_hash, claim_class, model_version);

create index if not exists personal_raq_pending_idx
  on public.personal_ranking_audit_queue (status, created_at)
  where status = 'queued';

-- ---------------------------------------------------------------------------
-- 2. Provider observations: append-only evidence.
-- ---------------------------------------------------------------------------
create table if not exists public.personal_provider_observations (
  id                    uuid primary key default gen_random_uuid(),
  provider_id           text        not null,
  provider_family       text        not null,
  stratum               text        not null,
  metric                text        not null check (metric in ('integrity', 'cache_claim')),
  outcome               boolean     not null,
  inclusion_probability double precision not null default 1
                          check (inclusion_probability > 0 and inclusion_probability <= 1),
  source                text        not null
                          check (source in ('torbox_checkcached', 'torbox_mylist', 'torbox_requestdl', 'controlled_probe')),
  candidate_key         text        not null,
  model_version         text        not null,
  observed_at           timestamptz not null default now()
);

-- Idempotency: the same source event can be replayed safely.
create unique index if not exists personal_ppo_event_idx
  on public.personal_provider_observations (provider_id, metric, candidate_key, source);

create index if not exists personal_ppo_aggregate_idx
  on public.personal_provider_observations (provider_id, stratum, metric, observed_at desc);

-- ---------------------------------------------------------------------------
-- 3. Trust snapshots: immutable, versioned, read by the request path.
-- ---------------------------------------------------------------------------
create table if not exists public.personal_provider_trust_snapshots (
  provider_id        text        not null,
  stratum            text        not null,
  metric             text        not null check (metric in ('integrity', 'cache_claim')),
  snapshot_version   text        not null,
  alpha              double precision not null,
  beta               double precision not null,
  effective_weight   double precision not null default 0,
  trust_lower_bound  double precision not null check (trust_lower_bound >= 0 and trust_lower_bound <= 1),
  model_version      text        not null,
  computed_at        timestamptz not null default now(),
  primary key (provider_id, stratum, metric, snapshot_version)
);

create index if not exists personal_ppts_lookup_idx
  on public.personal_provider_trust_snapshots (computed_at desc);

-- ---------------------------------------------------------------------------
-- 4. Stream sightings: short-lived map from offered rows to playable files.
-- ---------------------------------------------------------------------------
create table if not exists public.personal_stream_sightings (
  id              uuid primary key default gen_random_uuid(),
  content_type    text,
  content_id      text        not null,
  provider_id     text,
  release_cluster text,
  info_hash       text,
  file_idx        integer,
  video_hash      text,
  filename        text,
  video_size      bigint,
  torbox_id       bigint,
  torbox_file_id  integer,
  playable_url    text        not null,
  model_version   text,
  seen_at         timestamptz not null default now(),
  expires_at      timestamptz not null
);

-- Re-offering the same file refreshes the row instead of duplicating it.
create unique index if not exists personal_pss_identity_idx
  on public.personal_stream_sightings (content_id, playable_url);

create index if not exists personal_pss_hash_idx
  on public.personal_stream_sightings (content_id, video_hash);

create index if not exists personal_pss_name_size_idx
  on public.personal_stream_sightings (content_id, filename, video_size);

create index if not exists personal_pss_expiry_idx
  on public.personal_stream_sightings (expires_at);

-- ---------------------------------------------------------------------------
-- 5. Subtitle sync jobs.
-- ---------------------------------------------------------------------------
create table if not exists public.personal_subtitle_sync_jobs (
  id              uuid primary key default gen_random_uuid(),
  video_key       text        not null,
  content_type    text,
  content_id      text,
  sub_fingerprint text        not null,
  base_sub_url    text        not null,
  reference_slot  text        not null check (reference_slot in ('official', 'english')),
  playable_url    text,
  info_hash       text,
  file_idx        integer,
  status          text        not null default 'queued'
                    check (status in ('queued', 'running', 'done', 'failed')),
  fail_reason     text,
  attempts        integer     not null default 0,
  locked_at       timestamptz,
  locked_by       text,
  model_version   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  expires_at      timestamptz not null
);

-- At most one live job per (file, base subtitle, reference slot). Reselecting a
-- pending track must not create a second job.
create unique index if not exists personal_pssj_active_idx
  on public.personal_subtitle_sync_jobs (video_key, sub_fingerprint, reference_slot);

create index if not exists personal_pssj_claim_idx
  on public.personal_subtitle_sync_jobs (status, created_at)
  where status = 'queued';

create index if not exists personal_pssj_expiry_idx
  on public.personal_subtitle_sync_jobs (expires_at);

-- ---------------------------------------------------------------------------
-- 6. Subtitle sync results.
-- ---------------------------------------------------------------------------
create table if not exists public.personal_subtitle_sync (
  video_key       text        not null,
  sub_fingerprint text        not null,
  reference_slot  text        not null check (reference_slot in ('official', 'english')),
  ref_fingerprint text,
  synced_srt      text        not null,
  method          text        not null default 'embedded_alass',
  ref_lang        text,
  ref_track_index integer,
  cue_count       integer,
  model_version   text,
  created_at      timestamptz not null default now(),
  last_access_at  timestamptz not null default now(),
  expires_at      timestamptz not null default (now() + interval '90 days'),
  primary key (video_key, sub_fingerprint, reference_slot),
  -- Full feature-length SRTs are ~100 KB; 2 MiB is a generous safety valve that
  -- still prevents a pathological file from bloating the table.
  constraint personal_pss_srt_size check (octet_length(synced_srt) <= 2 * 1024 * 1024)
);

create index if not exists personal_ps_expiry_idx
  on public.personal_subtitle_sync (expires_at);

-- ---------------------------------------------------------------------------
-- 7. Row Level Security: deny by default, service role only.
-- ---------------------------------------------------------------------------
alter table public.personal_ranking_audit_queue        enable row level security;
alter table public.personal_provider_observations      enable row level security;
alter table public.personal_provider_trust_snapshots   enable row level security;
alter table public.personal_stream_sightings           enable row level security;
alter table public.personal_subtitle_sync_jobs         enable row level security;
alter table public.personal_subtitle_sync              enable row level security;

-- No policies are created for anon/authenticated on purpose: the service role
-- bypasses RLS, and every other role is denied. Playable URLs and trust data must
-- never be reachable with a publishable key.

-- ---------------------------------------------------------------------------
-- 8. Pre-existing tables flagged during planning.
--
-- personal_host_busy is written by the Telegram addon and read by the media
-- worker; both use the service role, so enabling RLS is safe here.
--
-- personal_titles is read by the ID resolver, which may still be configured with
-- SUPABASE_ANON_KEY. Enabling RLS therefore REQUIRES the read-only policy below,
-- or ID resolution stops returning rows.
-- ---------------------------------------------------------------------------
alter table public.personal_host_busy enable row level security;

alter table public.personal_titles enable row level security;

drop policy if exists personal_titles_read_only on public.personal_titles;
create policy personal_titles_read_only
  on public.personal_titles
  for select
  to anon, authenticated
  using (true);
