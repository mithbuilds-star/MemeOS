# Supabase current API keys in MemeOS

MemeOS uses Supabase's current API key format, not the legacy JWT-based `anon` and `service_role` API keys.

## Cloudflare Worker runtime variables

| Name | Value | Type |
|---|---|---|
| `SUPABASE_URL` | Your project URL | Text variable |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_...` | Text variable (public) |

The browser loads these from the same-origin `/api/public-config` endpoint at runtime. This works with a dashboard-uploaded Worker and does not depend on Vite build variables. The endpoint returns only the project URL and publishable key.

## Cloudflare Worker secrets

| Name | Value | Type |
|---|---|---|
| `SUPABASE_SECRET_KEY` | `sb_secret_...` | Secret |
| `CREDENTIALS_ENCRYPTION_KEY` | Base64-encoded 32-byte key | Secret |

The secret key is only used server-side in the `apikey` header. It is never sent to the browser and is not a JWT, so do not put it in `Authorization: Bearer`. For user-specific authentication, MemeOS sends the user's Supabase access token in `Authorization: Bearer`.

Optional build-time fallback variables are `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`; they are not required when the Worker runtime variables are configured.

Official migration guide: https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys
