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

The dashboard provides the main Telegram admin areas through the browser:
overview, users, admins, categories, products, orders, deposits, payment
methods, settings, announcements, referrals, gift codes, promotions, supplier
APIs, supplier links, and user price overrides. Records can be added, edited,
deleted, searched, and paginated. Changes are made through the server-side
Supabase service-role connection and therefore appear to the bot immediately.
The Supabase service-role key stays on the server and is never sent to the
browser. The Telegram bot source code is not imported or modified.
