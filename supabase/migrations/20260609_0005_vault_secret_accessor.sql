-- Lets edge functions read API keys from Supabase Vault (the user stored the
-- provider keys there rather than as Edge Function env secrets). pg_net is also
-- enabled here — used to invoke edge functions from SQL (and by pg_cron in
-- Phase 5 for the daily refresh).
create extension if not exists pg_net with schema extensions;

-- Read a decrypted Vault secret by name. SECURITY DEFINER to reach the vault,
-- but EXECUTE is granted ONLY to service_role (server-side edge functions) and
-- revoked from anon/authenticated/public — it never hits the client API surface.
create or replace function public.get_vault_secret(p_name text)
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1;
$$;

revoke all on function public.get_vault_secret(text) from public, anon, authenticated;
grant execute on function public.get_vault_secret(text) to service_role;
