import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Runtime configuration is loaded from the Worker before the React app
// mounts. This avoids top-level await, which is unsupported by Vite's
// default browser build targets.
export let supabase: SupabaseClient | null = null;
let initialization: Promise<SupabaseClient | null> | null = null;

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

export function initializeSupabase(): Promise<SupabaseClient | null> {
  if (!initialization) {
    initialization = loadSupabaseConfig().then(({ url, publishableKey }) => {
      if (url && publishableKey) {
        supabase = createClient(url, publishableKey, {
          auth: { persistSession: true, autoRefreshToken: true },
        });
      }
      return supabase;
    });
  }
  return initialization;
}

export function requireSupabase(): SupabaseClient {
  if (!supabase) throw new Error("Supabase is not configured. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY as Cloudflare Worker runtime variables.");
  return supabase;
}
