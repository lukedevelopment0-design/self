# self

Web dashboard to **delete your own messages** in Discord DMs and group chats, using a **user account token** and [discord.js-selfbot-v13](https://github.com/aiko-chan-ai/discord.js-selfbot-v13) ([docs](https://discordjs-self-v13.netlify.app/)).

> **Warning:** Automating a user account violates [Discord’s Terms of Service](https://discord.com/terms) and can get the account banned. Use at your own risk. Never commit your token.

**Production:** [https://self-production-c86a.up.railway.app](https://self-production-c86a.up.railway.app)

## Setup

1. Clone [github.com/lukedevelopment0-design/self](https://github.com/lukedevelopment0-design/self) (or your fork).
2. `npm install`
3. Copy `.env.example` → `.env` and set **`TOKEN`** (user token).
4. `npm start` → open `http://localhost:8080`

Railway: set `TOKEN`, optional `DATA_DIR=/data` with a volume for resume data.

## Features

- **All DMs** — every DM + group DM channel (minus exclusions).
- **Single conversation** — target a **channel ID** or **user ID** (1:1 DM).
- **Exclude channel IDs** — skip group DMs or specific DM channels.
- **Exclude user IDs** — skip 1:1 DMs with those people.
- **Persistent queue** — `data/purge.json` (compact `messageId,channelId,young` rows); auto-resume after restart.
- Only deletes messages **sent by your account**.

## Rate limits (conservative defaults)

| Action | Endpoint | Default delay |
|--------|----------|-----------------|
| Read history | `GET /channels/{id}/messages` | **6.01s** between pages (`SCAN_PAGE_DELAY_MS`) |
| Bulk delete | `POST …/bulk-delete` (≤14 days, **bots only** — often **fails** on user tokens) | **1.1s** between attempts; falls back to single delete |
| Single delete | `DELETE …/messages/{id}` | **1.01–1.25s** random (`DELETE_MIN_MS` / `DELETE_MAX_MS`) |

On **429**, the library should honor `retry_after`; these delays reduce how often you hit limits.

## API

- `GET /api/status` — job progress + log (max 100 lines in UI, 1000 in memory).
- `GET /api/dms` — list DM channels for the logged-in account.
- `POST /api/purge` — body: `{ mode: "all"|"single", channelId?, userId?, excludeChannelIds?, excludeUserIds? }`
- `POST /api/cancel`

## License

MIT — no warranty; not affiliated with Discord or aiko-chan-ai.
