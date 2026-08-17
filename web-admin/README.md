# SafwanTiger Web Admin

This is a separate, read-only web dashboard for the existing bot. It runs as
its own Node service and does not import, start, or modify the Telegram bot.

## Run locally

```bash
cd web-admin
cp .env.example .env
# set WEB_ADMIN_USERNAME, WEB_ADMIN_PASSWORD, SUPABASE_URL and
# SUPABASE_SERVICE_ROLE_KEY
node --env-file=.env server.mjs
```

Open `http://localhost:8787`.

## Deploy separately

Deploy `web-admin/` as a separate Railway service. Configure the four variables
from `.env.example`; do not reuse the bot's start command or service.

The dashboard intentionally exposes read-only data in this first version:
overview metrics, users, products, orders, and deposits. The Supabase service
role key stays on the server and is never sent to the browser.
