# Supabase API keys used by MemeOS

MemeOS is configured for Supabase's current API key format. Use the new keys, not the legacy JWT-based `anon` and `service_role` keys.

## Get the keys

In Supabase Dashboard, open **Project Settings → API Keys** and select **Publishable and secret API keys**. Create the default pair if the project does not already have them.

## Put each key in the correct place

| MemeOS setting | Supabase value | Where it goes |
|---|---|---|
| `VITE_SUPABASE_URL` | Project URL | Cloudflare build variable / `.env.local` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_...` | Cloudflare build variable / `.env.local` |
| `SUPABASE_URL` | Project URL | Worker runtime variable (`wrangler.toml`) |
| `SUPABASE_SECRET_KEY` | `sb_secret_...` | Cloudflare Worker secret only |

Never use the secret key in a `VITE_` variable, browser code, GitHub, or the Render service. The Render service only needs the Supabase project URL to validate signed audio URLs; it does not need a Supabase API key.

## Important request-header behavior

The new publishable and secret keys are not JWTs. Worker REST and Storage admin calls send the secret key in the `apikey` header and do not send it as `Authorization: Bearer`. For a signed-in user check, the Worker sends `apikey: <secret key>` and `Authorization: Bearer <user access token>`.

## Official reference

https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys
