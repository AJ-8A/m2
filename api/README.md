# AJChat

AJChat is an original realtime messenger with real users and direct friend-to-friend chat.

## Architecture

- GitHub Pages: frontend
- Cloudflare Worker: API
- Cloudflare D1: accounts, friends, and message history
- Cloudflare Durable Objects: realtime WebSocket chat rooms

Cloudflare recommends Durable Objects for long-lived WebSocket connections, and the hibernation API lets idle objects hibernate without disconnecting clients. citeturn331233search0turn331233search1

## Backend setup

From the repository root:

```bash
cd api
npx wrangler d1 create ajchat-db
```

Copy the returned database ID into `wrangler.jsonc` at `d1_databases[0].database_id`.

Then:

```bash
npx wrangler d1 execute ajchat-db --remote --file=schema.sql
npx wrangler deploy
```

The frontend is configured for:

`https://ajchat-api.study4u-aj.workers.dev`

After deployment, friends can create accounts at the GitHub Pages website, add each other's usernames, and chat in realtime.

## Important

The current login system is intentionally simple for a personal project. Passwords are hashed with PBKDF2 in the Worker. For a public production service, add rate limiting, account recovery, abuse controls, stronger session management, and a real media-storage system.
