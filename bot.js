import 'dotenv/config.js';
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { Client as IRCClient } from 'irc-framework';

// ========== CONFIGURATION ==========
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'YOUR_DISCORD_BOT_TOKEN_HERE';
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || 'YOUR_DISCORD_CHANNEL_ID_HERE';
const IRC_NICKNAME = process.env.IRC_NICKNAME || 'DiscordRelay';
const IRC_HOST = 'irc.hackclub.com';
const IRC_PORT = 6697;
const IRC_CHANNEL = '#lounge';
const IRC_TLS = true;

// ========== STATE TRACKING ==========
let ircClient = null;
let discordClient = null;
let isConnectingIRC = false;
let ircConnected = false;

// ========== DISCORD CLIENT SETUP ==========
discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
});

discordClient.once('clientReady', () => {
  console.log(`[Discord] Logged in as ${discordClient.user.tag}`);
  setupIRCClient();
});

discordClient.on('messageCreate', async (message) => {
  // Ignore bot's own messages and messages from other channels
  if (message.author.id === discordClient.user.id) return;
  if (message.channelId !== DISCORD_CHANNEL_ID) return;

  // Get display name (nickname or username)
  const displayName = message.member?.displayName || message.author.username;
  const content = message.content;

  if (!content) return;

  // Relay to IRC
  if (ircClient && ircConnected) {
    const ircMessage = `<${displayName}> ${content}`;
    ircClient.say(IRC_CHANNEL, ircMessage);
    console.log(`[Discord→IRC] ${ircMessage}`);
  } else {
    console.warn('[Discord→IRC] IRC not connected, dropping message');
  }
});

discordClient.on('error', (error) => {
  console.error('[Discord] Error:', error);
});

discordClient.on('disconnect', () => {
  console.warn('[Discord] Disconnected, attempting to reconnect...');
  discordClient.login(DISCORD_TOKEN);
});

// ========== IRC CLIENT SETUP ==========
function setupIRCClient() {
  if (isConnectingIRC) return;
  isConnectingIRC = true;

  console.log(`[IRC] Setting up with nickname: ${IRC_NICKNAME}`);
  
  ircClient = new IRCClient({
    nick: IRC_NICKNAME,
    host: IRC_HOST,
    port: IRC_PORT,
    tls: IRC_TLS,
    rejectUnauthorized: false,
    gecos: 'Discord IRC Relay Bot',
  });

  ircClient.on('message', (event) => {
    const nick = event.nick;
    const message = event.message;
    const channel = event.target;

    console.log(`[IRC] Raw message event:`, { nick, channel, message });

    // Ignore messages from the relay bot itself
    if (nick === IRC_NICKNAME) return;

    // Only relay messages from the configured channel
    if (channel !== IRC_CHANNEL) return;

    if (!message) return;

    // Strip IRC formatting codes
    const cleanMessage = stripIRCFormatting(message);

    // Escape @ symbols to prevent Discord mentions
    const escapedMessage = cleanMessage.replace(/@/g, '@\u200b');

    // Relay to Discord
    const discordChannel = discordClient.channels.cache.get(DISCORD_CHANNEL_ID);
    if (discordChannel && discordChannel.isTextBased()) {
      discordChannel.send(`<${nick}> ${escapedMessage}`).catch((error) => {
        console.error('[IRC→Discord] Failed to send message:', error);
      });
      console.log(`[IRC→Discord] <${nick}> ${cleanMessage}`);
    }
  });

  ircClient.on('registered', () => {
    ircConnected = true;
    console.log(`[IRC] Connected and registered as ${IRC_NICKNAME}`);
    ircClient.join(IRC_CHANNEL);
  });

  // Fallback: join channel on MOTD end (some servers send this instead)
  ircClient.on('motd', () => {
    if (!ircConnected) {
      ircConnected = true;
      console.log(`[IRC] MOTD received, joining ${IRC_CHANNEL}`);
      ircClient.join(IRC_CHANNEL);
    }
  });

  ircClient.on('join', (event) => {
    if (event.nick === IRC_NICKNAME) {
      console.log(`[IRC] Joined ${event.channel}`);
    }
  });

  ircClient.on('socket connected', () => {
    console.log('[IRC] Socket connected, waiting for registration...');
  });

  ircClient.on('connect', () => {
    console.log('[IRC] Connected to server');
  });

  ircClient.on('server error', (error) => {
    console.error('[IRC] Server error:', error);
  });

  ircClient.on('_error', (error) => {
    console.error('[IRC] Internal error:', error);
  });



  ircClient.on('error', (error) => {
    console.error('[IRC] Error:', error.message || error);
  });

  ircClient.on('socket close', () => {
    console.warn('[IRC] Socket closed unexpectedly');
    ircConnected = false;
  });

  ircClient.on('close', () => {
    console.warn('[IRC] Disconnected, reconnecting in 5 seconds...');
    ircConnected = false;
    isConnectingIRC = false;
    setTimeout(setupIRCClient, 5000);
  });

  console.log(`[IRC] Connecting to ${IRC_HOST}:${IRC_PORT}...`);
  ircClient.connect();
}

// ========== UTILITY FUNCTIONS ==========
/**
 * Strip IRC formatting codes (bold, color, italic, underline, reset)
 * IRC formatting: \x02 (bold), \x03 (color), \x1D (italic), \x1F (underline), \x0F (reset)
 */
function stripIRCFormatting(text) {
  return text
    .replace(/\x02/g, '') // bold
    .replace(/\x03(?:\d{1,2}(?:,\d{1,2})?)?/g, '') // color
    .replace(/\x1D/g, '') // italic
    .replace(/\x1F/g, '') // underline
    .replace(/\x0F/g, '') // reset
    .replace(/\x16/g, ''); // reverse
}

// ========== LOGIN ==========
discordClient.login(DISCORD_TOKEN);
