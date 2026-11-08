-- PIXRA AI prototype schema
-- Run this whole file once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- It is safe to re-run (uses IF NOT EXISTS / ON CONFLICT).
--
-- Security model: the Node server uses the SERVICE ROLE key, which bypasses Row Level Security.
-- RLS is enabled with NO policies, so the public "anon" key cannot read or write anything.

create extension if not exists pgcrypto;  -- gen_random_uuid()

-- ---------------------------------------------------------------- customers
create table if not exists public.customers (
  id            uuid primary key default gen_random_uuid(),
  phone         text not null unique,            -- WhatsApp id, digits only, e.g. 919876543210
  name          text,                            -- WhatsApp profile name
  business_name text,                            -- remembered for returning customers
  logo_url      text,                            -- remembered for returning customers
  brand_colors  jsonb,                           -- e.g. ["#FF5500", "#111111"]
  simulated     boolean not null default false,  -- true = created by the /dev simulator (never sent via WhatsApp)
  channel       text not null default 'whatsapp' check (channel in ('whatsapp', 'web', 'dev', 'telegram')),
                                                 -- where replies go: WhatsApp, Telegram, the /demo web chat, or the dev simulator
  created_at    timestamptz not null default now()
);
-- for databases created before the channel column existed
alter table public.customers add column if not exists channel text not null default 'whatsapp';
alter table public.customers drop constraint if exists customers_channel_check;
alter table public.customers
  add constraint customers_channel_check check (channel in ('whatsapp', 'web', 'dev', 'telegram'));

-- ---------------------------------------------------------------- messages
create table if not exists public.messages (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references public.customers(id) on delete cascade,
  wa_message_id text unique,                     -- WhatsApp message id; unique = webhook dedup
  direction     text not null check (direction in ('in', 'out')),
  type          text not null default 'text',    -- text | image | audio | unsupported
  content       text,                            -- text, caption, or voice-note transcript
  media_url     text,                            -- stored image/poster URL, if any
  created_at    timestamptz not null default now()
);
create index if not exists messages_customer_created_idx on public.messages (customer_id, created_at);

-- ---------------------------------------------------------------- conversations
create table if not exists public.conversations (
  customer_id      uuid primary key references public.customers(id) on delete cascade,
  state            text not null default 'idle',  -- idle | collecting | confirming | in_production | delivered
  collected_fields jsonb not null default '{}'::jsonb,
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------- jobs
create table if not exists public.jobs (
  id                 uuid primary key default gen_random_uuid(),
  customer_id        uuid not null references public.customers(id) on delete cascade,
  status             text not null default 'collecting' check (status in (
                       'collecting', 'brief_confirmed', 'generating', 'qa_done', 'pending_review',
                       'approved', 'delivered', 'revision_requested', 'failed')),
  brief              jsonb not null default '{}'::jsonb,
  deadline           timestamptz,
  assigned_to        text,
  error              text,
  regen_note         text,                        -- reviewer note added to the next image prompt
  regen_provider     text,                        -- reviewer's provider choice for the next regenerate (huggingface | cloudflare)
  revision_request   text,                        -- customer's latest change request
  revision_count     integer not null default 0,
  delivered_asset_id uuid,
  attempts           integer not null default 0,  -- generation attempts (for retry/resume)
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists jobs_status_idx on public.jobs (status);
create index if not exists jobs_customer_idx on public.jobs (customer_id, created_at desc);

-- ---------------------------------------------------------------- assets (poster versions; never overwritten)
create table if not exists public.assets (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references public.jobs(id) on delete cascade,
  version        integer not null,
  image_url      text not null,
  background_url text,
  template       text,                          -- bold_top | centered_card | manual
  size           text,                          -- square | portrait
  source         text not null default 'ai',    -- ai | edit | manual
  qa_report      jsonb,
  background_provider  text,                  -- huggingface | cloudflare
  background_model     text,                  -- e.g. black-forest-labs/FLUX.1-schnell
  background_served_by text,                  -- HF inference provider (nscale, fal-ai, ...) or workers-ai
  background_note      text,                  -- fallback reason, e.g. "HF out of credits"
  created_at     timestamptz not null default now(),
  unique (job_id, version)
);

-- for databases created before these columns existed
alter table public.assets add column if not exists background_provider  text;
alter table public.assets add column if not exists background_model     text;
alter table public.assets add column if not exists background_served_by text;
alter table public.assets add column if not exists background_note      text;
alter table public.jobs   add column if not exists regen_provider       text;

-- ---------------------------------------------------------------- reviews (admin actions)
create table if not exists public.reviews (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references public.jobs(id) on delete cascade,
  asset_id   uuid references public.assets(id) on delete set null,
  reviewer   text,
  action     text not null,                     -- approve | reject_regenerate | edit_text | assign | upload | retry
  notes      text,
  created_at timestamptz not null default now()
);
create index if not exists reviews_job_idx on public.reviews (job_id, created_at);

-- ---------------------------------------------------------------- updated_at triggers
create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists jobs_updated_at on public.jobs;
create trigger jobs_updated_at before update on public.jobs
  for each row execute function public.set_updated_at();

drop trigger if exists conversations_updated_at on public.conversations;
create trigger conversations_updated_at before update on public.conversations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- RLS: deny everything to anon/authenticated
alter table public.customers     enable row level security;
alter table public.messages      enable row level security;
alter table public.conversations enable row level security;
alter table public.jobs          enable row level security;
alter table public.assets        enable row level security;
alter table public.reviews       enable row level security;

-- ---------------------------------------------------------------- storage bucket "posters" (public read)
-- Public bucket = anyone with a file URL can view it (needed so WhatsApp can fetch the poster).
-- Uploads are done only by the server with the service role key.
insert into storage.buckets (id, name, public)
values ('posters', 'posters', true)
on conflict (id) do update set public = true;
