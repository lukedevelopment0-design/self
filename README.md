# self

Web dashboard to **delete your own messages** in Discord DMs and group chats, using a **user account token** and [discord.js-selfbot-v13](https://github.com/aiko-chan-ai/discord.js-selfbot-v13) ([docs](https://discordjs-self-v13.netlify.app/)).

> **Warning:** Automating a user account violates [Discord’s Terms of Service](https://discord.com/terms) and can get the account banned. Use at your own risk. Never commit your token.

**Production:** [https://self-production-c86a.up.railway.app](https://self-production-c86a.up.railway.app)

## Setup

1. Clone [github.com/lukedevelopment0-design/self](https://github.com/lukedevelopment0-design/self) (or your fork).
2. `npm install`
3. Copy `.env.example` → `.env` and set **`TOKEN`** (user token).
4. `npm start` → open `http://localhost:8080`

Railway: set `TOKEN`, and **`DATA_DIR=/data` on a mounted volume** so `purge.json` survives redeploys (ephemeral disk wipes `./data`).

Progress is flushed to disk after **every queue change, scan cursor update, and delete batch**. Failed deletes stay in the queue; **Start / continue purge** keeps scan progress unless you use **Restart scan**.

## Features

- **All DMs** — every DM + group DM channel (minus exclusions).
- **Single conversation** — target a **channel ID** or **user ID** (1:1 DM).
- **Exclude channel IDs** — skip group DMs or specific DM channels.
- **Exclude user IDs** — skip 1:1 DMs with those people.
- **Persistent data** — `purge.json` keeps **`f`** (every message ever found, never removed) and **`q`** (still to delete). **`targets`** lists all single-mode conversations you added. Switching to a **new user ID merges** into targets without wiping prior data.
- Only deletes messages **sent by your account**.

## Rate limits (conservative defaults)

| Action | Endpoint | Default delay |
|--------|----------|-----------------|
| Read history | `GET /channels/{id}/messages` | **6.5–7.5s** random between pages (`SCAN_PAGE_MIN_MS` / `SCAN_PAGE_MAX_MS`) |
| Bulk delete | `POST …/bulk-delete` (≤14 days, **bots only** — often **fails** on user tokens) | Tried when ≥2 recent msgs on a page; then **1.01–1.25s** before next step |
| Single delete | `DELETE …/messages/{id}` | **1.01–1.25s** random (`DELETE_MIN_MS` / `DELETE_MAX_MS`) |

On **429**, the library should honor `retry_after`; these delays reduce how often you hit limits.

## API

- `GET /api/status` — job progress + log (max 100 lines in UI, 1000 in memory).
- `GET /api/dms` — list DM channels for the logged-in account.
- `POST /api/purge` — body: `{ mode: "all"|"single", channelId?, userId?, excludeChannelIds?, excludeUserIds? }`
- `POST /api/cancel`

## License

MIT — no warranty; not affiliated with Discord or aiko-chan-ai.
