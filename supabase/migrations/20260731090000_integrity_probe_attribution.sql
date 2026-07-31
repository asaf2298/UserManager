-- Integrity probe attribution.
--
-- The subtitle-sync worker already resolves a TorBox CDN locator and runs
-- ffprobe against the real file for every sync job (worker/media-intelligence/
-- subtitleWorker.mjs). Whether that probe succeeds or fails is direct evidence
-- for the `integrity` trust metric (lib/providerTrust.js), which has been fully
-- built out since the media-intelligence migration but never fed. These columns
-- let a sighting -> sync job -> probe result chain carry the provider identity
-- needed to attribute that evidence.
--
-- All columns are nullable: existing rows and existing readers are unaffected.

alter table public.personal_stream_sightings
  add column if not exists provider_family text,
  add column if not exists stratum text;

alter table public.personal_subtitle_sync_jobs
  add column if not exists provider_id text,
  add column if not exists provider_family text,
  add column if not exists stratum text;
