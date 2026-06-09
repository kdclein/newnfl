import { createClient } from "@supabase/supabase-js";

// Publishable key + URL are public and protected by row-level security, so it's
// safe to ship defaults in the bundle. Override via Netlify env vars if desired.
const url = import.meta.env.VITE_SUPABASE_URL || "https://vhnbugglrpxwuzjfuzph.supabase.co";
const key = import.meta.env.VITE_SUPABASE_ANON_KEY || "sb_publishable_ADqo7llyvsSu6pDA78Iw7A_xoUHQrPf";

export const supabase = createClient(url, key);
