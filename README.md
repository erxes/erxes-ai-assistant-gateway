# erxes Ai Assistant Gateway

Central Discord gateway for the official erxes Ai Assistant bot.

## Architecture

This service uses one official Discord application and bot named `erxes Ai Assistant`.

```text
Discord guildId + channelId
-> erxes-ai-assistant-gateway
-> tenantId
-> assistantId
-> runtime kind (OpenClaw or Hermes)
-> isolated runtime adapter URL
-> assistant answer
-> Discord reply
```

Customers do not create Discord applications, provide bot tokens, enable privileged intents, or calculate permissions. The gateway-generated installation URL requests the configured bot permission integer, and Erxes Admin owns tenant authorization and channel binding.

An installation belongs to a tenant and Discord guild, not to an individual
assistant. Install the official bot once, then reuse that installation for
OpenClaw and Hermes channel bindings in the same tenant. `assistantId` remains
accepted on installation list requests for compatibility but is not a filter.

## Discord Application Setup

Create the Discord application manually in the Discord Developer Portal.

Use:

```text
Application name: erxes Ai Assistant
Bot name: erxes Ai Assistant
```

Collect:

```text
Application ID
Client ID
Client Secret
Public Key
Bot Token
```

Enable only this privileged intent for the `all_messages` response mode:

```text
Message Content Intent
```

Leave Presence Intent and Server Members Intent disabled.

Enable **Requires OAuth2 Code Grant** for the bot. The callback accepts the
installed guild from Discord's exchanged token response; the callback query
guild is only a consistency hint.

Use OAuth installation scopes:

```text
bot
applications.commands
```

The gateway-generated installation flow requests only the permissions used by
the shared bot:

```text
Manage Channels + View Channels + Send Messages + Embed Links + Attach Files +
Read Message History + Send Messages in Threads: 274878024720
```

Administrator is not required. SaaS users do not use the Discord Developer
Portal OAuth2 URL Generator directly; they use `/discord/oauth/start`, which
generates the install URL with the configured least-privilege permission set.
Older installations granted Administrator remain compatible.

Configure hosted URLs:

```text
Interactions Endpoint URL:
https://<gateway-domain>/discord/interactions

OAuth Redirect URI:
https://<gateway-domain>/discord/oauth/callback
```

For local Discord testing, expose port `3001` through an HTTPS tunnel and use the tunnel URLs for those two Discord settings.

## Environment

Copy `.env.example` to `.env` and fill the Discord credentials.

```env
NODE_ENV=development
PORT=3001
PUBLIC_BASE_URL=http://localhost:3001
MONGO_URL=mongodb://127.0.0.1:27017/erxes_ai_assistant_gateway

DISCORD_APPLICATION_ID=
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_PUBLIC_KEY=
DISCORD_BOT_TOKEN=
DISCORD_REDIRECT_URI=http://localhost:3001/discord/oauth/callback
DISCORD_TEST_GUILD_ID=
DISCORD_BOT_PERMISSIONS=274878024720
ENABLE_MOCK_OPENCLAW=false

ERXES_GATEWAY_ADMIN_SECRET=change-me
ERXES_ALLOWED_RETURN_URLS=http://localhost:3000

OPENCLAW_REQUEST_TIMEOUT_MS=120000
ERXES_ASSISTANT_REPLY_MAX_CHARS=1800
OPENCLAW_SHARED_SECRET=
CRON_WEBHOOK_SECRET=
```

Never commit `.env`. Never log Discord tokens, client secrets, gateway admin secrets, or OpenClaw shared secrets.

`OPENCLAW_SHARED_SECRET` is retained for backward compatibility with existing
OpenClaw adapters and is also the Hermes adapter signing secret. Every runtime
request includes HMAC-signed tenant, assistant, runtime-kind, HTTP-method, and
path claims with a short-lived timestamp. A Hermes adapter must verify those
claims against its own immutable identity before invoking Hermes WebUI.

Hermes cron delivery URLs use the scoped webhook contract:

```text
POST /webhooks/discord-cron?tenant=<tenantId>&assistant=<assistantId>&runtime=hermes&channel=<channelId-or-name>&token=<scoped-token>
```

The scoped token is HMAC-SHA256 over `v2`, tenant ID, assistant ID, and runtime
kind, separated by newlines, truncated to 32 hexadecimal characters. Existing
assistant-only OpenClaw webhook tokens remain accepted only for OpenClaw and
legacy pre-runtimeKind bindings.

## Local Development

```bash
cd /home/batzorig/Erxes/erxes-ai-assistant-gateway
cp .env.example .env
docker compose -f infra/docker-compose.yml up -d
pnpm install
pnpm dev
```

Checks:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Health:

```bash
curl http://localhost:3001/health
```

OAuth start:

Use the authenticated `agentDiscordConnectUrl` GraphQL query in `agent_api`.
It returns a short-lived URL whose tenant, assistant, user, return URL, and
expiry are signed with `ERXES_GATEWAY_ADMIN_SECRET`; a browser cannot choose
another tenant by editing the query string.

Register slash command:

```bash
pnpm register:commands
```

If `DISCORD_TEST_GUILD_ID` is set, this registers a guild command. Otherwise it registers the global command:

```text
/assistant question:<text>
```

Mock OpenClaw is disabled by default. Enable it only for local development or a short-lived deployed mock test:

```env
ENABLE_MOCK_OPENCLAW=true
```

Do not enable the mock route in production. Startup validation rejects `ENABLE_MOCK_OPENCLAW=true` when `NODE_ENV=production`.

Mock OpenClaw:

```bash
curl -X POST http://localhost:3001/mock-openclaw/api/erxes-ai-assistant/ask \
  -H 'content-type: application/json' \
  -d '{
    "tenantId": "test-saas-1",
    "assistantId": "support-assistant-1",
    "question": "hello",
    "user": { "id": "discord-user-id", "username": "Discord Name" },
    "discord": { "guildId": "guild-id", "channelId": "channel-id" },
    "source": "discord"
  }'
```

Create a test binding after a `DiscordInstallation` exists:

```bash
curl -X POST http://localhost:3001/api/bindings \
  -H 'content-type: application/json' \
  -H 'x-erxes-gateway-admin-secret: change-me' \
  -d '{
    "installationId": "<installation-object-id>",
    "tenantId": "test-saas-1",
    "assistantId": "support-assistant-1",
    "assistantName": "Support Assistant",
    "runtimeKind": "openclaw",
    "discordGuildId": "<discord-guild-id>",
    "discordChannelId": "<discord-channel-id>",
    "openclawUrl": "http://localhost:3001/mock-openclaw"
  }'
```

List installations, channels, and bindings:

```bash
curl "http://localhost:3001/api/installations?tenantId=test-saas-1&installedByErxesUserId=user-1" \
  -H 'x-erxes-gateway-admin-secret: change-me'

curl "http://localhost:3001/api/installations/<installation-object-id>/channels" \
  -H 'x-erxes-gateway-admin-secret: change-me'

curl "http://localhost:3001/api/bindings?tenantId=test-saas-1" \
  -H 'x-erxes-gateway-admin-secret: change-me'
```

## Routes

Public:

```text
GET /health
GET /discord/oauth/start
GET /discord/oauth/callback
POST /discord/interactions
POST /mock-openclaw/api/erxes-ai-assistant/ask  # only when ENABLE_MOCK_OPENCLAW=true
```

Protected with `x-erxes-gateway-admin-secret`:

```text
GET /api/installations
GET /api/installations/:id
GET /api/installations/:id/channels
GET /api/bindings
GET /api/bindings/:id
POST /api/bindings
PATCH /api/bindings/:id
DELETE /api/bindings/:id
POST /api/bindings/rehome
POST /api/bindings/disable-by-url
```

Installation listing requires both `tenantId` and
`installedByErxesUserId`. This keeps one user's Discord servers reusable by
that user's OpenClaw and Hermes assistants without exposing them to other
users in the same tenant. The result is also intersected with the connected
Discord bot's live guild cache, so deleted servers and servers where the bot
was removed do not appear. While Discord is reconnecting, the route returns
`503` instead of serving stale installation records.

Hermes lifecycle callers include `runtimeKind: "hermes"` in the rehome and
disable-by-url request bodies. The field is optional so existing OpenClaw
callers remain compatible, while Hermes lifecycle changes cannot match an
OpenClaw binding that happens to store the same runtime URL.

## Security

Implemented:

- Discord Ed25519 request signature verification.
- Raw request body preservation for interactions.
- Secure expiring single-use OAuth state.
- OAuth callback only saves connected installations after OAuth code exchange succeeds, Discord returns the installed guild, the bot can fetch the guild, and returned permissions include the required least-privilege set (or Administrator for an older install).
- Erxes return URL allowlist.
- Protected internal APIs with `x-erxes-gateway-admin-secret`.
- Only the Message Content privileged intent is used; Presence and Server
  Members intents remain disabled.
- The gateway-generated install URL requests only the permissions used for channel management, messages, files, embeds, history, and thread replies.
- OAuth scopes remain only `bot` and `applications.commands`.
- No customer bot tokens.
- No secrets in redirect URLs.
- OpenClaw request timeout handling.
- Optional `x-erxes-ai-assistant-secret` forwarding.
- Runtime kind on every binding (`openclaw` by default, `hermes` for Hermes)
  plus HMAC-signed tenant/assistant identity headers on runtime requests.
- Channels created by either runtime inherit the originating binding's runtime
  kind, and cross-channel actions remain scoped to that tenant and runtime.
- Hermes binding URLs must use HTTPS outside loopback or Kubernetes service
  DNS, and Hermes bindings require `OPENCLAW_SHARED_SECRET`.
- Tenant/guild installation validation before binding writes.
- One active binding per Discord guild/channel.
- Production startup rejects placeholder gateway admin secrets and refuses to enable the mock OpenClaw route.

TODO: replace the shared gateway admin secret with stronger service authentication, signed requests, and audit logging.

## Ubuntu 24.04 Hosting

Assumptions:

- A DNS record points `gateway-domain` to the server.
- MongoDB is either managed or reachable privately.
- Node.js 22, pnpm, PM2, Nginx, and Certbot are allowed.

Install packages:

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pnpm pm2
```

Deploy:

```bash
git clone <repo-url> /opt/erxes-ai-assistant-gateway
cd /opt/erxes-ai-assistant-gateway
cp .env.example .env
pnpm install
pnpm test
pnpm build
pm2 start dist/src/main.js --name erxes-ai-assistant-gateway
pm2 save
pm2 startup
```

Nginx:

```nginx
server {
  server_name <gateway-domain>;

  client_max_body_size 5m;

  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 130s;
  }
}
```

Enable SSL:

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d <gateway-domain>
```

Verify:

```bash
curl https://<gateway-domain>/health
```

Configure Discord:

```text
Interactions Endpoint URL:
https://<gateway-domain>/discord/interactions

OAuth Redirect URI:
https://<gateway-domain>/discord/oauth/callback
```

Register global command:

```bash
cd /opt/erxes-ai-assistant-gateway
DISCORD_TEST_GUILD_ID= pnpm register:commands
```

Useful logs and rollback:

```bash
pm2 logs erxes-ai-assistant-gateway
pm2 restart erxes-ai-assistant-gateway
pm2 stop erxes-ai-assistant-gateway
```

Rollback by deploying the previous git revision, running `pnpm install && pnpm build`, then `pm2 restart erxes-ai-assistant-gateway`.

## End-To-End MVP Test

1. Create one official Discord application and bot named `erxes Ai Assistant`.
2. Configure this gateway with the official Discord credentials.
3. Register `/assistant question:<text>`.
4. Start Erxes with `ERXES_AI_ASSISTANT_GATEWAY_URL` and `ERXES_AI_ASSISTANT_GATEWAY_SECRET`.
5. Open an Erxes AI assistant.
6. Click `Connect Discord`.
7. Approve the official bot in Discord.
8. Return to Erxes and select a Discord server/channel.
9. Click `Connect channel`.
10. Run `/assistant question: hello` in Discord.
11. The gateway resolves guild/channel to tenant/assistant/OpenClaw and edits the Discord reply with the final answer.
