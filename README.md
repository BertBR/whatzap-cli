# whatzap

> **Fork with extra features** (reply with quotes and mentions, richer history with voice notes and images, sending voice notes, deleting our own messages). They were sent to the original project in [#1](https://github.com/CarlosAugustoAlves/whatzap-cli/pull/1), [#2](https://github.com/CarlosAugustoAlves/whatzap-cli/pull/2), [#3](https://github.com/CarlosAugustoAlves/whatzap-cli/pull/3) and [#4](https://github.com/CarlosAugustoAlves/whatzap-cli/pull/4). Original project: [CarlosAugustoAlves/whatzap-cli](https://github.com/CarlosAugustoAlves/whatzap-cli).

**Give Claude, OpenClaw, and your shell scripts a WhatsApp voice.**

A lightweight CLI that connects AI agents and terminal workflows to WhatsApp — no API keys, no paid services. Built on the WhatsApp Web protocol via [Baileys](https://github.com/WhiskeySockets/Baileys). Connects directly to your account via QR code, just like WhatsApp Web.

Send messages and reach groups by name · Record conversation history as JSONL · Persistent daemon, zero reconnections

---

## AI Integration

whatzap is built to work seamlessly with [Claude Code](https://claude.ai/code) and [OpenClaw](https://github.com/Enderfga/openclaw-claude-code). Run `whatzap init` once and any agent can send messages, resolve contacts by name, watch groups, and read conversation history — no phone numbers needed, no reconnections.

```
"Send a WhatsApp to João saying the deploy is live"
"Message the dev team that tests passed"
"Watch Jane's messages"
"Add the family group to my watch list"
```

The Claude Code skill is installed automatically by `whatzap init`. For OpenClaw, whatzap acts as a drop-in WhatsApp backend — authenticated, persistent, and ready from `~/.whatzap/history/`. To reinstall the skill manually:

```bash
whatzap install-skill
```

> **Note:** Contact resolution by name requires macOS — `find-contact` uses AppleScript to query Contacts.app. On other platforms, agents will prompt for the phone number.

---

## Requirements

- Node.js 18 or later
- A WhatsApp account
- macOS (Linux support is partial — `find-contact` requires macOS Contacts)

## Installation

```bash
npm install -g whatzap-cli
```

### First-time setup

```bash
whatzap init
```

Installs the Claude Code skill and authenticates with your WhatsApp account via QR code. Run once after installing.

---

## Command Reference

| Command | Description |
|---|---|
| `whatzap init` | First-time setup: install skill + QR authentication |
| `whatzap login` | Re-authenticate after logout |
| `whatzap logout` | Disconnect and delete saved credentials |
| `whatzap send-message <phone> <message>` | Send a text message (phone with country code) |
| `whatzap send-group <group name> <message>` | Send a message to a WhatsApp group |
| `whatzap reply <message id> <message>` | Reply to a recorded message, quoting it and mentioning its sender |
| `whatzap reply-audio <message id> <file.ogg>` | Reply to a recorded message with a voice note |
| `whatzap send-audio <phone\|jid> <file.ogg>` | Send a voice note to a phone number or JID |
| `whatzap delete <message id>` | Delete, for everyone, a message we sent |
| `whatzap find-contact <name>` | Search macOS Contacts by name, returns JSON |
| `whatzap add-watch <phone\|group name>` | Start recording messages for a contact or group |
| `whatzap remove-watch <phone\|group name>` | Stop recording messages |
| `whatzap list-watch` | List all watched contacts and groups |
| `whatzap setting set default-country-code <code>` | Set default country code for number normalization |
| `whatzap install-skill` | Reinstall the Claude Code skill |
| `whatzap restart` | Restart the background daemon |
| `whatzap stop` | Stop the background daemon |

---

## Usage

### Send a Message

```bash
whatzap send-message <phone> <message>
```

Phone must include the country code. Multi-word messages don't need quotes.

```bash
whatzap send-message +5511999999999 Hello from the terminal!
whatzap send-message +15555550100 Meeting in 10 minutes
```

### Send to a Group

```bash
whatzap send-group <group name> <message>
```

Group name is matched case-insensitively. The longest prefix matching a known group is used as the name; the rest is the message.

```bash
whatzap send-group family Oi pessoal!
whatzap send-group Work Team Meeting in 5 minutes
```

### Reply to a Message

```bash
whatzap reply <message id> <message>
```

Replies to a message recorded in a watched contact or group (see [Watch a Contact or Group](#watch-a-contact-or-group)). The reply quotes the original message and, for incoming messages, starts with an @mention of its sender, so the answer stays attached to the question in busy groups. The message id is the `id` field of the history entry.

```bash
whatzap reply 3EB05F011B6AFCBB71534D Deploy is live!
```

Use `--mention <jid>` (repeatable, anywhere in the arguments) to mention more people; the JID must also appear as `@<number>` in the text for WhatsApp to highlight it:

```bash
whatzap reply --mention 120363000000001@lid 3EB05F011B6AFCBB71534D @120363000000001 please check
```

### Send a Voice Note

```bash
whatzap send-audio <phone|jid> <file.ogg>
whatzap reply-audio <message id> <file.ogg>
```

Sends an Ogg/Opus file as a voice note (push-to-talk). `send-audio` takes a phone number or a full JID (e.g. `120363000000000@lid`, useful when a contact is only reachable by LID); `reply-audio` quotes a recorded message, like `reply`. Only existing `.ogg` files are accepted, and the daemon reads the file itself.

```bash
ffmpeg -i note.wav -c:a libopus -b:a 32k note.ogg
whatzap reply-audio 3EB05F011B6AFCBB71534D note.ogg
```

### Delete a Message

```bash
whatzap delete <message id>
```

Deletes, for everyone, a message sent by this account and recorded in a watched contact or group (an `"out"` history entry). Messages from other people are refused. WhatsApp only allows this for a while after sending.

### Find a Contact (macOS only)

```bash
whatzap find-contact <name>
```

Returns a JSON array of matching contacts:

```json
[{"name":"John Doe","phones":["+15555550100"]},{"name":"John Smith","phones":["+5511988887777"]}]
```

Useful for scripting:

```bash
PHONE=$(whatzap find-contact "John Doe" | jq -r '.[0].phones[0]')
whatzap send-message "$PHONE" On my way!
```

### Watch a Contact or Group

Record all incoming and outgoing messages for a contact or group:

```bash
whatzap add-watch +5511999999999       # by phone
whatzap add-watch family group         # group by name
whatzap add-watch Work Team
```

Messages are written to `~/.whatzap/history/` as newline-delimited JSON:

```json
{"ts":"2026-03-22T10:00:00.000Z","d":"in","n":"Carlos","text":"Hello!","id":"3EB05F011B6AFCBB71534D","p":"120363000000000@lid","pn":"5511999999999@s.whatsapp.net"}
{"ts":"2026-03-22T10:00:30.000Z","d":"in","n":"Carlos","text":"[audio]","id":"3EB0AA00000000000000AA","q":"3EB05F011B6AFCBB71534D","audio":"/home/me/.whatzap/media/3EB0AA00000000000000AA-1a2b3c4d.ogg","sec":12}
{"ts":"2026-03-22T10:01:00.000Z","d":"out","text":"Sure, see you there!"}
```

| Field | Description |
|---|---|
| `ts` | ISO 8601 timestamp |
| `d` | `"in"` (received) or `"out"` (sent) |
| `n` | Sender display name (incoming only) |
| `text` | Message text |
| `id` | WhatsApp message id, used by `whatzap reply` |
| `p` | Sender JID (incoming group messages only), mentioned by `whatzap reply` |
| `pn` | Sender phone JID, when WhatsApp provides it (groups that use LIDs) |
| `q` | Id of the message this one quotes (replies) |
| `fw` | `true` when the message was forwarded |
| `audio` | Path of the downloaded voice note (`~/.whatzap/media/`), with `sec` = duration |
| `image` | Path of the downloaded image (`~/.whatzap/media/`); the caption goes in `text` |

Captions, wrapped messages (ephemeral, view once, edited) and quotes are read from the part that carries the text. Other non-text messages (stickers, documents, locations) are recorded as `[non-text message: <type>]` so they don't disappear silently. Media files get a random suffix and are never overwritten. History is capped at the 100 most recent messages per contact or group.

### Manage the Watch List

```bash
whatzap list-watch
whatzap remove-watch +5511999999999
whatzap remove-watch family group
```

Watch list changes take effect immediately — no daemon restart needed.

### Default Country Code

```bash
whatzap setting set default-country-code 55
```

Phone numbers without a `+` prefix will have the country code prepended automatically:

```bash
whatzap send-message 11999999999 Hello!  # treated as +5511999999999
```

---

## How It Works

whatzap uses a **daemon architecture** to maintain a persistent WhatsApp connection without reconnecting on every command:

```
whatzap <command>
  → src/index.ts              (parse & dispatch)
    → src/commands/*.ts       (command handlers)
      → src/daemon/client.ts  (IPC over Unix socket)
        → src/daemon/server.ts  (background daemon)
          → src/services/whatsapp.ts  (Baileys WebSocket)
            → ~/.whatzap/auth/  (persisted credentials)
```

The daemon runs as a detached background process and communicates via a Unix domain socket at `~/.whatzap/daemon.sock`. It auto-starts on first use if credentials are available.

### Runtime Data

All runtime data lives in `~/.whatzap/`:

| Path | Description |
|---|---|
| `auth/` | Baileys session credentials |
| `daemon.sock` | Unix socket for IPC |
| `daemon.pid` | Daemon process ID |
| `settings.json` | Watch list and default country code |
| `history/` | Recorded messages — one `.jsonl` per watched contact/group |

History filenames are derived from WhatsApp JIDs (e.g. `5511999999999_s-whatsapp-net.jsonl` for contacts, `120363000000_g-us.jsonl` for groups).

---

## Development

```bash
git clone https://github.com/CarlosAugustoAlves/whatzap-cli.git
cd whatzap-cli
npm install

npm start -- send-message +5511999999999 test  # run without compiling
npx tsc --noEmit                                # type-check
npm run build                                   # compile to dist/
node dist/index.js --help                       # run compiled output
```

No automated test suite — verification is manual against a real WhatsApp account.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

---

## License

MIT — see [LICENSE](LICENSE) for details.

## Disclaimer

This project uses the WhatsApp Web protocol via [Baileys](https://github.com/WhiskeySockets/Baileys). Use responsibly and in accordance with [WhatsApp's Terms of Service](https://www.whatsapp.com/legal/terms-of-service). Automated or bulk messaging may violate those terms and result in account restrictions.
