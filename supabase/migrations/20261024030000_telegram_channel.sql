-- Allow the Telegram customer channel. Replaces the CHECK constraint on customers.channel;
-- no rows are modified. (schema.sql contains the same definition for fresh databases.)
alter table public.customers drop constraint if exists customers_channel_check;
alter table public.customers
  add constraint customers_channel_check check (channel in ('whatsapp', 'web', 'dev', 'telegram'));
