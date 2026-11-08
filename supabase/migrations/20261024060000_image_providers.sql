-- Record where each poster background came from (Hugging Face / Cloudflare), and let a reviewer
-- pick the provider for one "Reject & Regenerate" round. Additive only: no rows are modified.
alter table public.assets add column if not exists background_provider  text;  -- huggingface | cloudflare
alter table public.assets add column if not exists background_model     text;  -- e.g. black-forest-labs/FLUX.1-schnell
alter table public.assets add column if not exists background_served_by text;  -- HF inference provider (nscale, fal-ai, ...) or workers-ai
alter table public.assets add column if not exists background_note      text;  -- fallback reason, e.g. "HF out of credits"
alter table public.jobs   add column if not exists regen_provider       text;  -- huggingface | cloudflare | null (= IMAGE_PROVIDER)
