import { createClient } from "@supabase/supabase-js";

// Vite variables are optional fallbacks. The preferred deployment path is
// runtime config from the Worker so direct Dashboard uploads work too.
async function loadSupabaseConfig(): Promise<{ url: string; publishableKey: string }> {
  const buildUrl = import.meta.env.VITE_SUPABASE_URL || "";
  const buildKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "";
  if (buildUrl && buildKey) return { url: buildUrl, publishableKey: buildKey };

  try {
    const response = await fetch("/api/public-config", { cache: "no-store" });
    if (!response.ok) return { url: buildUrl, publishableKey: buildKey };
    const config = await response.json() as { supabaseUrl?: string; publishableKey?: string };
    return {
      url: buildUrl || config.supabaseUrl || "",
      publishableKey: buildKey || config.publishableKey || "",
    };
  } catch {
    return { url: buildUrl, publishableKey: buildKey };
  }
}

const config = await loadSupabaseConfig();
const url = config.url;
const publishableKey = config.publishableKey;

export const supabase = url && publishableKey
  ? createClient(url, publishableKey, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;

export function requireSupabase() {
  if (!supabase) throw new Error("Supabase is not configured. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY as Cloudflare Worker runtime variables.");
  return supabase;
}
