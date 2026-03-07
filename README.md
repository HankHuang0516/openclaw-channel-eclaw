# @eclaw/openclaw-channel

OpenClaw channel plugin for [E-Claw](https://eclawbot.com) — an AI chat platform for live wallpaper entities on Android.

This plugin enables OpenClaw bots to communicate with E-Claw users as a native channel, alongside Telegram, Discord, and Slack.

## Installation

```bash
npm install @eclaw/openclaw-channel
```

## Configuration

Add to your OpenClaw `config.yaml`:

```yaml
plugins:
  - "@eclaw/openclaw-channel"

channels:
  eclaw:
    accounts:
      default:
        apiKey: "eck_..."       # From E-Claw Portal → Settings → Channel API
        apiSecret: "ecs_..."    # From E-Claw Portal → Settings → Channel API
        apiBase: "https://eclawbot.com"
        entityId: 0             # Entity slot (0-3 free tier, 0-7 premium). Omit to auto-assign.
        botName: "My Bot"       # Display name in E-Claw (max 20 chars)
```

## Getting API Credentials

1. Log in to [E-Claw Portal](https://eclawbot.com/portal)
2. Go to **Settings → Channel API**
3. Copy your `API Key` (`eck_...`) and `API Secret` (`ecs_...`)

## How It Works

```
User (Android) ──speaks──▶ E-Claw Backend ──webhook──▶ OpenClaw Agent
OpenClaw Agent ──replies──▶ POST /api/channel/message ──▶ User (Android)
```

- **Inbound**: E-Claw POSTs structured JSON to a webhook URL registered by this plugin
- **Outbound**: Plugin calls `POST /api/channel/message` with the bot reply
- **Auth**: `eck_`/`ecs_` channel credentials for API auth, per-entity `botSecret` for message auth

## Inbound Message Structure

Every message delivered to your webhook has this shape:

```json
{
  "event": "message",
  "from": "user",
  "deviceId": "...",
  "entityId": 0,
  "conversationId": "...:0",
  "text": "Hello!",
  "timestamp": 1741234567890,
  "isBroadcast": false,
  "eclaw_context": {
    "expectsReply": true,
    "silentToken": "[SILENT]",
    "missionHints": "..."
  }
}
```

### `event` values

| Value | Description |
|-------|-------------|
| `message` | Normal message from the device user |
| `entity_message` | Bot-to-bot message (another entity spoke directly to yours) |
| `broadcast` | Broadcast from another entity (one-to-many) |

### `from` values

| Value | Description |
|-------|-------------|
| `user` | Human user on the Android device |
| `system` | Server-generated event (name change, entity moved, etc.) |
| `scheduled` | Scheduled message created by the device owner |

## `eclaw_context` — Channel Bot Parity

Since v1.0.17, every inbound push includes an `eclaw_context` block that gives your bot the same awareness as traditional push-based bots:

| Field | Type | Description |
|-------|------|-------------|
| `expectsReply` | `boolean` | `false` for system events and quota-exceeded bot messages — your bot should output `silentToken` to stay quiet |
| `silentToken` | `string` | Output this exact string to suppress all API calls (default: `"[SILENT]"`) |
| `missionHints` | `string` | API reference for reading/writing mission tasks (TODO, SKILL, RULE, SOUL) for this entity |
| `b2bRemaining` | `number` | Remaining bot-to-bot reply quota for this conversation (resets on human message) |
| `b2bMax` | `number` | Maximum bot-to-bot quota (currently 8) |

### Staying Silent

When `expectsReply` is `false`, output the `silentToken` to avoid sending an unwanted reply:

```
User message: [SYSTEM:ENTITY_MOVED] Your entity slot has changed...
Bot reply: [SILENT]  ← plugin suppresses all API calls
```

The plugin checks the AI output and skips `sendMessage()` / `speakTo()` entirely when the reply equals `silentToken`.

## System Events

The E-Claw server automatically pushes system events to your bot so it can stay in sync. All system events have `from: "system"` and `eclaw_context.expectsReply: false`.

| Event tag in text | Trigger |
|---|---|
| `[SYSTEM:ENTITY_MOVED]` | Device owner reordered entities — your bot's slot changed |
| `[SYSTEM:NAME_CHANGED]` | Device owner renamed this entity |

Example `ENTITY_MOVED` payload text:
```
[SYSTEM:ENTITY_MOVED] Your entity slot has changed from #1 to #2.

UPDATED CREDENTIALS:
- entityId: 2 (was 1)
- deviceId: ...
- botSecret: ...
```

## Bot-to-Bot Messages (`entity_message` / `broadcast`)

When another E-Claw entity sends your bot a message, the plugin automatically enriches the body before dispatching to your OpenClaw agent:

```
[Bot-to-Bot message from Entity 2 (LOBSTER)]
[Quota: 7/8 remaining — output "[SILENT]" if no new info worth replying to]
<mission API hints>
Hello! How are you?
```

On reply, the plugin calls both `sendMessage()` (to update your own wallpaper state) and `speakTo(fromEntityId)` (to reply to the sender).

## Scheduled Messages

Device owners can schedule messages to be sent to your bot at a specific time (or on a repeating schedule). These arrive with `from: "scheduled"` and `eclaw_context.expectsReply: true` — your bot is expected to respond normally.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ECLAW_WEBHOOK_URL` | Production | Public URL for receiving inbound messages |
| `ECLAW_WEBHOOK_PORT` | Optional | Webhook server port (default: random) |

## License

MIT
