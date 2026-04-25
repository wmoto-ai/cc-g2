# cc-g2 — Smart glasses companion for Claude Code / Codex CLI

[日本語 README](./README.ja.md)

`cc-g2` connects Even G2 smart glasses to Claude Code / Codex CLI so you can review permission prompts, send voice comments, and check completion notifications without staying at your desk.

![cc-g2 simulator demo](./docs/screenshots/cc-g2-simulator.gif)

Even G2 can open notifications, record a voice reply, and send that response back to Claude Code or Codex CLI through the local Hub.

## What works today

- Approve / deny Claude Code / Codex CLI permission requests from G2
- Answer Claude Code `AskUserQuestion` prompts from G2 option lists
- Send voice comments back to Claude Code / Codex CLI
- Check Claude Code / Codex CLI completion notifications on G2
- Browse recent notifications and details on the glasses
- Launch Claude Code / Codex CLI sessions by voice via Even App custom AI

## Current limitations

- **AskUserQuestion support is intentionally compact**. G2 can show question options and send selected answers, including multiple questions in sequence. The **Other (voice)** path sends a spoken free-form answer. Long question text or many options may still need the PC side because of the G2 display limits.
- **This README focuses on completion notifications and permission-related interactions**, which are the flows currently easiest to verify.
- **Real hardware has known list input quirks**. In some list screens, swipe direction can feel inverted on the device. See [docs/known-limitations.md](docs/known-limitations.md).
- **Simulator behavior differs from real hardware**. Always verify important behavior on the actual glasses.

## Architecture

```text
PC (Claude Code / Codex CLI + Hub + Voice Entry) <-> iPhone (Even App + Vite UI) <-> Even G2
```

- **Notification Hub** (`:8787`) handles notifications and approval flow
- **Vite UI** (`:5173`) provides the G2 companion web UI
- **Voice Entry** (`:8797`) launches sessions by voice (optional)
- **Claude Code HTTP hook / Codex command hook** sends permission requests to the Hub

The Hub is intended to mirror and answer explicit permission prompts. It should not broaden Claude Code / Codex CLI permissions or override user / org policy outside the normal `approve` / `deny` flow.

## Recommended setup

`cc-g2` works best with a setup based on **tmux + Tailscale + iPhone + Even G2**.

- **tmux** keeps the Claude Code / Codex CLI session alive and supports the reply relay flow
- **Tailscale** makes it easier for the iPhone to reach the local Hub safely. You can also use a local IP on the same WiFi, but Tailscale is convenient for remote or cross-network access
- **Moshi or similar helper notifications** are optional, but useful when you are away from your desk
- **G2 notifications** are useful for checking pending approvals and completions

Reference: <https://getmoshi.app/articles/mac-remote-endless-agent-setup>

## Requirements

- macOS recommended
- Node.js (LTS) + pnpm
- tmux
- jq
- Tailscale (optional if you disable QR-based remote access)
- Claude Code (`claude` command)
- Codex CLI (`codex` command, only for `cc-g2 --codex` / `cc-g2 codex`)

> `cc-g2` is intended for trusted networks, not public internet deployment.

## Quick start

### 1. Install

Install directly from GitHub:

```bash
pnpm add -g github:wmoto-ai/cc-g2
```

Source checkout install:

```bash
git clone https://github.com/wmoto-ai/cc-g2.git
cd cc-g2
pnpm install
pnpm link --global
```

### 2. Configure

```bash
cd "$(pnpm root -g)/@wmoto-ai/cc-g2"
cp .env.example .env.local
```

For a source checkout install, run the configure step from the cloned repository directory instead.

Key settings in `.env.local`:

| Variable | Purpose |
|----------|---------|
| `GROQ_API_KEY` | STT for voice comments (Groq, optional) |
| `CC_G2_VOICE_ENTRY_ENABLED=0` | Disable Voice Entry (enabled by default) |
| `CC_G2_REPO_ROOTS` | Repository scan path (default: `~/Repos`) |

Restart the infra with `cc-g2 !` after changing `.env.local`. From outside the tmux session, use `cc-g2 stop && cc-g2`.

### 3. Start

```bash
cc-g2
```

This starts the Hub and Vite UI, injects Claude Code hooks, prepares a tmux session, shows a QR code, and launches Claude Code.

To start Codex CLI instead:

```bash
cc-g2 --codex
# or
cc-g2 codex
```

This injects Codex CLI hooks and launches Codex CLI with G2 approval/completion notifications.

## Commands

| Command | Description |
|---------|-------------|
| `cc-g2` | Start infra + show QR + launch Claude Code |
| `cc-g2 new` | Start in a new tmux session |
| `cc-g2 --codex` | Start infra + show QR + launch Codex CLI with G2 hooks |
| `cc-g2 codex` | Same as `cc-g2 --codex` |
| `cc-g2 --native-codex` | Legacy alias for `cc-g2 --codex` |
| `cc-g2-codex` | Alias for `cc-g2 --codex` |
| `cc-g2 !` | Restart infra first |
| `cc-g2 stop` | Stop Hub + Vite |
| `cc-g2 status` | Check runtime status |
| `cc-g2 doctor` | Check dependencies and services |
| `cc-g2 -p "prompt"` | Launch Claude Code with a prompt |

## Controls

| Gesture | Action |
|---------|--------|
| Swipe up / down | Move through lists, change pages |
| Single tap | Select / confirm |
| Double tap | Back / cancel / stop recording |

### Voice comment flow

1. Open the action screen and choose **Comment**
2. Speak into the G2 microphone
3. **Double tap to stop recording**
4. Choose **Send / Retry / Cancel** after STT finishes
5. **Swipe cancels recording** while recording is active

Voice comments are returned to Claude Code / Codex CLI as **deny + instruction text**.

### AskUserQuestion flow

When Claude Code asks an `AskUserQuestion`, cc-g2 opens the question directly on G2 instead of showing it as a normal notification detail.

1. Read the question on G2
2. Swipe through the available options
3. Single tap to choose an option
4. For multiple questions, answer each question in sequence
5. Choose **Other (voice)** if you need to dictate a free-form answer

Selected answers are sent back through the Hub as an answer payload for the matching Claude Code prompt.

## Voice Entry

Launch Claude Code / Codex CLI sessions by speaking to G2 via Even App's custom AI agent. Include `codex` in the spoken request to start a Codex CLI session.

### Setup

1. Voice Entry is enabled by default. To disable, add `CC_G2_VOICE_ENTRY_ENABLED=0` to `.env.local` and restart with `cc-g2 !`
2. Verify with `cc-g2 status` — look for `Voice entry (port 8797): running`
3. In Even App → Conversate → Custom AI Agent, set:
   - **Endpoint URL**: `http://<Tailscale hostname or IP>:8797/v1/chat/completions`
   - **Bearer token**: auto-generated on first start, check with `cat tmp/voice-entry/voice-entry-token`

Find your Tailscale address:

```bash
tailscale status --self     # hostname (recommended)
tailscale ip -4             # IP fallback
```

### Usage

Say "Hey Even, fix tests in my-repo" and Voice Entry will:
1. Transcribe your speech (via Even App STT)
2. Auto-detect the target repository
3. Launch a new `cc-g2` session

Say "continue" or "さっきの続き" to resume the last session.

Repository candidates are scanned from `CC_G2_REPO_ROOTS` (default: `~/Repos`).

## Simulator

```bash
./scripts/start-simulator.sh
```

- Opens a browser-based phone + G2 simulator on port 5173
- Add `?dev=1` to show Developer Tools / Event Log
- Use `SIMULATOR_VERSION=...` if you want to switch simulator versions

## Development

```bash
pnpm hub:watch
pnpm dev
pnpm test
pnpm run test:all
pnpm test:watch
```

## Troubleshooting

- Run `cc-g2 doctor` to check dependencies and service health
- **After a PC restart, run `cc-g2 !`** to restart all services — Hub and Voice Entry tokens can get out of sync after a reboot
- If Voice Entry won't start: check `cc-g2 status` and make sure `CC_G2_VOICE_ENTRY_ENABLED=0` is not set in `.env.local`
- If Even App can't connect: verify the Bearer token with `cat tmp/voice-entry/voice-entry-token` and check Tailscale connectivity

## Links

- [Known limitations](docs/known-limitations.md)
- <https://getmoshi.app/articles/mac-remote-endless-agent-setup>

## License

MIT
