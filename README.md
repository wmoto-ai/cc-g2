# cc-g2 — Smart glasses companion for Claude Code

[日本語 README](./README.ja.md)

`cc-g2` connects Even G2 smart glasses to Claude Code so you can review permission prompts, send voice comments, and check completion notifications without staying at your desk.

![cc-g2 simulator demo](./docs/screenshots/cc-g2-simulator.gif)

Even G2 can open notifications, record a voice reply, and send that response back to Claude Code through the local Hub.

## What works today

- Approve / deny Claude Code permission requests from G2
- Send voice comments back to Claude Code
- Check completion notifications on G2
- Browse recent notifications and details on the glasses

## Current limitations

- **AskUserQuestion is not supported on G2 yet**. There is no interactive choice UI on the glasses for it today. For now, treat it as a workflow where you may need to answer with a comment or use the PC side.
- **This README focuses on completion notifications and permission-related interactions**, which are the flows currently easiest to verify.
- **Real hardware has known list input quirks**. In some list screens, swipe direction can feel inverted on the device. See [docs/known-limitations.md](docs/known-limitations.md).
- **Simulator behavior differs from real hardware**. Always verify important behavior on the actual glasses.

## Architecture

```text
PC (Claude Code + Hub) <-> iPhone (Even App + Vite UI) <-> Even G2
```

- **Notification Hub** (`:8787`) handles notifications and approval flow
- **Vite UI** (`:5173`) provides the G2 companion web UI
- **Claude Code HTTP hook** sends permission requests to the Hub

## Recommended setup

`cc-g2` works best with a setup based on **tmux + Tailscale + iPhone + Even G2**.

- **tmux** keeps the Claude Code session alive and supports the reply relay flow
- **Tailscale** makes it easier for the iPhone to reach the local Hub safely
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

> `cc-g2` is intended for trusted networks, not public internet deployment.

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/wmoto-ai/cc-g2.git
cd cc-g2
pnpm install
```

### 2. Configure

```bash
cp .env.example .env.local
# Add GROQ_API_KEY if you want speech-to-text

mkdir -p ~/.local/bin
ln -sf "$(pwd)/scripts/cc-g2.sh" ~/.local/bin/cc-g2
export PATH="$HOME/.local/bin:$PATH"
command -v cc-g2
```

Restart the infra with `cc-g2 !` after changing `.env.local`.

### 3. Start

```bash
cc-g2
```

This starts the Hub and Vite UI, injects Claude Code hooks, prepares a tmux session, shows a QR code, and launches Claude Code.

## Commands

| Command | Description |
|---------|-------------|
| `cc-g2` | Start infra + show QR + launch Claude Code |
| `cc-g2 new` | Start in a new tmux session |
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

Voice comments are returned to Claude Code as **deny + instruction text**.

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

## Links

- [Known limitations](docs/known-limitations.md)
- <https://getmoshi.app/articles/mac-remote-endless-agent-setup>

## License

MIT
