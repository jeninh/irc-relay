# Discord ↔ IRC Relay Bot

A Node.js bot that bridges Discord channels with irc.hackclub.com. Creates Discord channels for every IRC channel automatically, with support for multiple categories and pinned channels.

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Create Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to "Bot" section and create a bot
4. Copy the bot token
5. Go to OAuth2 → URL Generator
6. Select scopes: `bot`
7. Select permissions: `Send Messages`, `Read Messages/View Channels`, `Read Message History`, `Manage Channels`
8. Use the generated URL to invite the bot to your server

### 3. Configure Environment Variables

Create a `.env` file:

```bash
DISCORD_TOKEN=your_bot_token_here
IRC_NICKNAME=DiscordRelay  # Optional, defaults to DiscordRelay
```

### 4. Run the Bot

```bash
npm start
```

## Features

- **Discord ↔ IRC Relaying**: Messages sync bidirectionally
- **Auto-discovery**: Automatically finds all IRC channels and creates Discord channels
- **Multi-category support**: Splits channels across multiple categories (50 per category limit)
- **Star channels**: Owner can use `!STAR` to pin important channels to "Hack Club IRC MAIN" category
- **Alphabetical sorting**: All channels are sorted A-Z
- **Categories at bottom**: IRC categories are positioned at the bottom of the server
- **Auto-reconnect**: Reconnects if either service disconnects
- **Infinite loop prevention**: Ignores bot's own messages
- **Formatting cleanup**: Strips IRC formatting codes
- **Mention safety**: Escapes @ symbols to prevent accidental Discord mentions

## Commands

### !STAR
Move the current channel to the "Hack Club IRC MAIN" category.
- **Only the owner can use this**
- Usage: Type `!STAR` in any IRC relay channel
- The channel will be moved to the main category and repositioned at the bottom

## Message Format

### Discord → IRC
```
<DisplayName> hello from discord
```

### IRC → Discord
```
<IRCName> hello from irc
```

## Category Structure

```
[Existing Server Categories]
...
Hack Club IRC MAIN (starred channels)
Hack Club IRC Misc 0 (first 50 channels)
Hack Club IRC Misc 1 (next 50 channels)
etc.
```

## Troubleshooting

- **Bot doesn't relay messages**: Check that the bot has permissions to view/send messages in channels
- **IRC connection fails**: Verify irc.hackclub.com:6697 is accessible
- **Channels not created**: Ensure the bot has "Manage Channels" permission in the server
- **60-second wait**: The IRC server requires 60 seconds before allowing channel listing

## Requirements

- Node.js 18+
- discord.js v14+
- irc-framework v4+
