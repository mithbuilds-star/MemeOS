# Cloudflare Supabase runtime configuration

The frontend no longer depends on Vite build-time environment variables. At startup it requests `/api/public-config` from the Worker.

In Cloudflare Dashboard → Workers & Pages → `memeos` → Settings → Variables and Secrets, add these **runtime text variables**:

- `SUPABASE_URL` = `https://brlqdwnpoamvfuhdptx.supabase.co`
- `SUPABASE_PUBLISHABLE_KEY` = your Supabase key beginning `sb_publishable_`

Keep these as **Worker secrets**:

- `SUPABASE_SECRET_KEY` = your Supabase key beginning `sb_secret_`
- `CREDENTIALS_ENCRYPTION_KEY` = base64-encoded 32-byte key

Save changes and deploy the updated Worker. Then test:

`https://memeos.mithbuilds.workers.dev/api/public-config`

It should return JSON containing `supabaseUrl` and `publishableKey`. It must never return `SUPABASE_SECRET_KEY`.

The `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` build variables are now optional fallbacks only. Do not use legacy `anon` or `service_role` API keys.
