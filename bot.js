import 'dotenv/config.js';
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { Client as IRCClient } from 'irc-framework';

// ========== CONFIGURATION ==========
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'YOUR_DISCORD_BOT_TOKEN_HERE';
const DISCORD_SERVER_ID = '1418037714170806384'; // Server ID to sync
const DISCORD_MAIN_CATEGORY_NAME = 'Hack Club IRC MAIN'; // Main category for starred channels
const DISCORD_MISC_CATEGORY_PREFIX = 'Hack Club IRC Misc'; // Prefix for overflow categories
const DISCORD_OWNER_ID = '1145174224726659143'; // Only this user can use !STAR command
const IRC_NICKNAME = process.env.IRC_NICKNAME || 'DiscordRelay';
const IRC_HOST = 'irc.hackclub.com';
const IRC_PORT = 6697;
const IRC_TLS = true;
const CHANNEL_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
const MAX_CHANNELS_PER_CATEGORY = 50; // Discord limit

// ========== STATE TRACKING ==========
let ircClient = null;
let discordClient = null;
let isConnectingIRC = false;
let ircConnected = false;
let ircChannels = new Set(); // Track IRC channels
let discordChannelMap = new Map(); // Map IRC channel to Discord channel ID
let channelCheckInterval = null;
let guild = null;
let starredChannels = new Set(); // Track channels in MAIN category
let lastSyncTime = 0; // Prevent duplicate syncs
let isSyncing = false; // Prevent concurrent syncs

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
  guild = discordClient.guilds.cache.get(DISCORD_SERVER_ID);
  if (!guild) {
    console.error(`[Discord] Server ${DISCORD_SERVER_ID} not found!`);
    return;
  }
  console.log(`[Discord] Using server: ${guild.name}`);
  setupIRCClient();
  
  // Start periodic channel checks
  channelCheckInterval = setInterval(checkAndSyncChannels, CHANNEL_CHECK_INTERVAL);
  console.log('[Discord] Started channel sync interval (every 5 minutes)');
});

discordClient.on('messageCreate', async (message) => {
  // Ignore bot's own messages
  if (message.author.id === discordClient.user.id) return;

  const displayName = message.member?.displayName || message.author.username;
  const content = message.content;

  if (!content) return;

  // Handle !STAR command (only for owner)
  if (content.startsWith('!STAR')) {
    if (message.author.id !== DISCORD_OWNER_ID) {
      message.reply('Only the owner can use this command.').catch(() => {});
      return;
    }

    const ircChannelForMsg = Array.from(discordChannelMap.entries()).find(
      ([_, discordId]) => discordId === message.channelId
    )?.[0];

    if (!ircChannelForMsg) {
      message.reply('This channel is not mapped to an IRC channel.').catch(() => {});
      return;
    }

    try {
      await starChannel(message.channelId, ircChannelForMsg);
      message.reply(`⭐ ${ircChannelForMsg} moved to ${DISCORD_MAIN_CATEGORY_NAME}`).catch(() => {});
    } catch (error) {
      console.error('[Star] Error:', error.message);
      message.reply('Failed to star this channel.').catch(() => {});
    }
    return;
  }

  // Handle !DELETE command (only for owner)
  if (content === '!DELETE') {
    if (message.author.id !== DISCORD_OWNER_ID) {
      message.reply('Only the owner can use this command.').catch(() => {});
      return;
    }

    try {
      message.reply('🗑️ Deleting all -irc channels...').catch(() => {});
      const deleted = await deleteIRCChannels();
      message.channel.send(`✅ Deleted ${deleted} IRC relay channels.`).catch(() => {});
    } catch (error) {
      console.error('[Delete] Error:', error.message);
      message.reply('Failed to delete channels.').catch(() => {});
    }
    return;
  }

  // Check if this Discord channel maps to an IRC channel
  let ircChannel = null;
  for (const [irc, discordId] of discordChannelMap.entries()) {
    if (discordId === message.channelId) {
      ircChannel = irc;
      break;
    }
  }

  // Relay to IRC if mapped
  if (ircChannel && ircClient && ircConnected) {
    const ircMessage = `<${displayName}> ${content}`;
    ircClient.say(ircChannel, ircMessage);
    console.log(`[Discord→IRC] ${ircChannel} - ${ircMessage}`);
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
    gecos: 'https://discord.gg/k2qKFXd4nx',
  });

  // Handle LIST responses (numeric 322 and 323)
  ircClient.on('raw', (event) => {
    if (event.line.includes(' 322 ')) {
      // RPL_LIST: :server 322 nick channel :topic
      const match = event.line.match(/322 \S+ (\S+)/);
      if (match && match[1].startsWith('#') && match[1].length > 1) {
        // Filter out invalid channels like "#", numbers only, or special service channels
        const channelName = match[1];
        // Only accept channels with at least one alphanumeric character that isn't just dashes/numbers
        if (!/^#[\d\-]*$/.test(channelName) && !/^#(services|chanserv|nickserv|ircop)$/i.test(channelName)) {
          ircChannels.add(channelName);
        }
      }
    }
    if (event.line.includes(' 323 ')) {
      // RPL_LISTEND
      console.log('[LIST] List complete');
    }
  });

  ircClient.on('message', (event) => {
    const nick = event.nick;
    const message = event.message;
    const channel = event.target;

    // Ignore messages from the relay bot itself
    if (nick === IRC_NICKNAME) return;

    // Ignore non-channel messages (server notices, etc)
    if (!channel || !channel.startsWith('#')) return;

    if (!message) return;

    // Strip IRC formatting codes
    const cleanMessage = stripIRCFormatting(message);

    // Escape @ symbols to prevent Discord mentions
    const escapedMessage = cleanMessage.replace(/@/g, '@\u200b');

    // Find the Discord channel for this IRC channel
    const discordChannelId = discordChannelMap.get(channel);
    if (!discordChannelId) return;

    // Relay to Discord
    const discordChannel = discordClient.channels.cache.get(discordChannelId);
    if (discordChannel && discordChannel.isTextBased()) {
      discordChannel.send(`<${nick}> ${escapedMessage}`).catch((error) => {
        console.error('[IRC→Discord] Failed to send message:', error);
      });
      console.log(`[IRC→Discord] ${channel} - <${nick}> ${cleanMessage}`);
    }
  });

  ircClient.on('registered', () => {
    ircConnected = true;
    console.log(`[IRC] Connected and registered as ${IRC_NICKNAME}`);
    // Wait 65 seconds before listing channels (IRC server requires 60+ seconds)
    console.log('[IRC] Waiting 65 seconds before listing channels...');
    setTimeout(() => {
      checkAndSyncChannels();
    }, 65000);
  });

  // Fallback: check channels on MOTD end (some servers send this instead)
  ircClient.on('motd', () => {
    if (!ircConnected) {
      ircConnected = true;
      console.log(`[IRC] MOTD received, waiting 65 seconds before listing channels...`);
      setTimeout(() => {
        checkAndSyncChannels();
      }, 65000);
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

/**
 * Sanitize IRC channel name for Discord channel name
 * Discord channels can only have lowercase letters, numbers, hyphens, and underscores
 * Names must start with alphanumeric
 */
function sanitizeChannelName(ircChannel) {
  let sanitized = ircChannel
    .toLowerCase()
    .replace(/^#/, '') // Remove leading #
    .replace(/[^a-z0-9-_]/g, '-') // Replace invalid chars with hyphen
    .replace(/^-+/, '') // Remove leading dashes
    .substring(0, 94);
  
  // Ensure it doesn't become empty
  if (!sanitized) {
    sanitized = 'channel';
  }
  
  return sanitized + '-irc'; // Discord channel name limit (100 - 4 for "-irc")
}

/**
 * Check IRC for available channels and sync with Discord
 */
async function checkAndSyncChannels() {
  if (!ircClient || !ircConnected) {
    console.warn('[Sync] IRC not connected, skipping channel sync');
    return;
  }

  // Prevent concurrent syncs
  if (isSyncing) {
    console.warn('[Sync] Sync already in progress, skipping');
    return;
  }

  // Prevent syncs within 10 seconds of last sync
  const now = Date.now();
  if (now - lastSyncTime < 10000) {
    console.warn('[Sync] Last sync was recent, skipping');
    return;
  }

  isSyncing = true;
  lastSyncTime = now;

  console.log('[Sync] Requesting channel list from IRC...');
  
  // Request LIST from IRC
  ircClient.raw('LIST');

  // Wait for LIST response
  return new Promise((resolve) => {
    let listReceived = false;

    const handleListEnd = async () => {
      if (listReceived) return;
      listReceived = true;

      console.log(`[Sync] Found ${ircChannels.size} IRC channels:`, Array.from(ircChannels));

      // Sync Discord channels
      await syncDiscordChannels();
      isSyncing = false;
      resolve();
    };

    // Timeout after 15 seconds
    setTimeout(handleListEnd, 15000);
  });
}

/**
 * Create/update Discord channels to match IRC channels
 */
async function syncDiscordChannels() {
  if (!guild) {
    console.error('[Sync] No guild found');
    return;
  }

  // Sort IRC channels alphabetically
  const sortedChannels = Array.from(ircChannels).sort();

  // Ensure categories exist
  await ensureCategories();

  let categoryIndex = 0;
  let channelCountInCategory = 0;

  for (const ircChannel of sortedChannels) {
    const discordChannelName = sanitizeChannelName(ircChannel);

    // Check if channel already exists
    let discordChannel = guild.channels.cache.find(
      (ch) => ch.isTextBased() && ch.name === discordChannelName
    );

    // Determine target category
    let targetCategory;
    
    // If channel already exists in MAIN, keep it there
    const mainCategory = guild.channels.cache.find(
      (ch) => ch.type === 4 && ch.name === DISCORD_MAIN_CATEGORY_NAME
    );
    if (discordChannel && mainCategory && discordChannel.parentId === mainCategory.id) {
      // Channel is in MAIN, keep it there
      starredChannels.add(ircChannel);
      targetCategory = mainCategory;
    } else if (starredChannels.has(ircChannel)) {
      // Starred channels go to MAIN category
      targetCategory = mainCategory;
    } else {
      // Regular channels go to MISC categories
      // Count existing channels in current category to determine if we need to move to next
      const currentCategoryName = `${DISCORD_MISC_CATEGORY_PREFIX} ${categoryIndex}`;
      const currentCategory = guild.channels.cache.find(
        (ch) => ch.type === 4 && ch.name === currentCategoryName
      );
      
      if (currentCategory) {
        const channelsInCategory = currentCategory.children.cache.filter(
          (ch) => ch.isTextBased()
        ).size;
        
        // If current category is full, move to next
        if (channelsInCategory >= MAX_CHANNELS_PER_CATEGORY) {
          categoryIndex++;
          channelCountInCategory = 0;
        }
      }

      targetCategory = guild.channels.cache.find(
        (ch) => ch.type === 4 && ch.name === `${DISCORD_MISC_CATEGORY_PREFIX} ${categoryIndex}`
      );
    }

    if (!targetCategory) {
      console.warn(`[Sync] Target category for ${ircChannel} not found`);
      continue;
    }

    if (!discordChannel) {
      // Channel doesn't exist, create it
      try {
        discordChannel = await guild.channels.create({
          name: discordChannelName,
          type: 0, // Text channel
          parent: targetCategory,
          reason: `IRC relay for ${ircChannel}`,
        });
        console.log(`[Sync] Created Discord channel #${discordChannelName} for ${ircChannel}`);
      } catch (error) {
        console.error(`[Sync] Failed to create channel ${discordChannelName}:`, error.message);
        continue;
      }
    } else if (discordChannel.parentId !== targetCategory.id) {
      // Channel exists but in wrong category, move it
      try {
        await discordChannel.setParent(targetCategory);
        console.log(`[Sync] Moved #${discordChannelName} to ${targetCategory.name}`);
      } catch (error) {
        console.error(`[Sync] Failed to move channel:`, error.message);
      }
    }

    // Update mapping
    discordChannelMap.set(ircChannel, discordChannel.id);

    // Only rejoin starred channels if needed
    if (starredChannels.has(ircChannel)) {
      try {
        ircClient.join(ircChannel);
      } catch (error) {
        // Already joined or error, skip
      }
    }

    if (!starredChannels.has(ircChannel)) {
      channelCountInCategory++;
    }
  }

  // Position categories at bottom
  await positionCategoriesAtBottom();

  console.log(`[Sync] Channel sync complete. Mapped ${discordChannelMap.size} channels`);
}

/**
 * Ensure required categories exist
 */
async function ensureCategories() {
  if (!guild) return;

  // Ensure MAIN category exists
  let mainCategory = guild.channels.cache.find(
    (ch) => ch.type === 4 && ch.name === DISCORD_MAIN_CATEGORY_NAME
  );
  if (!mainCategory) {
    try {
      mainCategory = await guild.channels.create({
        name: DISCORD_MAIN_CATEGORY_NAME,
        type: 4,
        reason: 'Main IRC relay category',
      });
      console.log('[Sync] Created MAIN category');
    } catch (error) {
      console.error('[Sync] Failed to create MAIN category:', error.message);
    }
  }

  // Ensure MISC categories exist (for all channels)
  let miscCategoryIndex = 0;
  let channelCount = 0;

  for (const ircChannel of Array.from(ircChannels).sort()) {
    if (starredChannels.has(ircChannel)) continue;

    if (channelCount >= MAX_CHANNELS_PER_CATEGORY) {
      miscCategoryIndex++;
      channelCount = 0;
    }

    const miscCategoryName = `${DISCORD_MISC_CATEGORY_PREFIX} ${miscCategoryIndex}`;
    let miscCategory = guild.channels.cache.find(
      (ch) => ch.type === 4 && ch.name === miscCategoryName
    );

    if (!miscCategory) {
      try {
        miscCategory = await guild.channels.create({
          name: miscCategoryName,
          type: 4,
          reason: `IRC relay overflow category ${miscCategoryIndex}`,
        });
        console.log(`[Sync] Created category ${miscCategoryName}`);
      } catch (error) {
        console.error(`[Sync] Failed to create category ${miscCategoryName}:`, error.message);
      }
    }

    channelCount++;
  }
}

/**
 * Position MISC IRC categories at the bottom of the server (keep MAIN in place)
 */
async function positionCategoriesAtBottom() {
  if (!guild) return;

  const miscCategories = guild.channels.cache.filter(
    (ch) => ch.type === 4 && ch.name.startsWith(DISCORD_MISC_CATEGORY_PREFIX)
  );

  const allCategories = guild.channels.cache.filter((ch) => ch.type === 4);
  const totalCategories = allCategories.size;

  let position = totalCategories - miscCategories.size;

  try {
    for (const [, category] of miscCategories) {
      await category.setPosition(position++);
    }
    console.log('[Sync] Positioned MISC IRC categories at bottom');
  } catch (error) {
    console.error('[Sync] Failed to position categories:', error.message);
  }
}

/**
 * Move a channel to the MAIN category (star it)
 */
async function starChannel(channelId, ircChannel) {
  if (!guild) throw new Error('Guild not found');

  console.log(`[Star] Attempting to star ${ircChannel}...`);

  const channel = guild.channels.cache.get(channelId);
  if (!channel) {
    console.error(`[Star] Channel ${channelId} not found`);
    throw new Error('Discord channel not found');
  }

  const mainCategory = guild.channels.cache.find(
    (ch) => ch.type === 4 && ch.name === DISCORD_MAIN_CATEGORY_NAME
  );
  if (!mainCategory) {
    console.error(`[Star] MAIN category not found. Creating it...`);
    // Try to create it if it doesn't exist
    await ensureCategories();
    const newMainCategory = guild.channels.cache.find(
      (ch) => ch.type === 4 && ch.name === DISCORD_MAIN_CATEGORY_NAME
    );
    if (!newMainCategory) throw new Error('Failed to create MAIN category');
  }

  try {
    const targetCategory = guild.channels.cache.find(
      (ch) => ch.type === 4 && ch.name === DISCORD_MAIN_CATEGORY_NAME
    );
    await channel.setParent(targetCategory);
    starredChannels.add(ircChannel);
    await positionCategoriesAtBottom();
    console.log(`[Star] Successfully moved ${ircChannel} to MAIN category`);
  } catch (error) {
    console.error(`[Star] Failed to move channel:`, error.message);
    throw error;
  }
}

/**
 * Delete all Discord channels ending in -irc
 */
async function deleteIRCChannels() {
  if (!guild) throw new Error('Guild not found');

  const ircChannelsToDelete = guild.channels.cache.filter(
    (ch) => ch.isTextBased() && ch.name.endsWith('-irc')
  );

  let deletedCount = 0;
  for (const [, channel] of ircChannelsToDelete) {
    try {
      await channel.delete();
      console.log(`[Delete] Deleted channel #${channel.name}`);
      deletedCount++;
    } catch (error) {
      console.error(`[Delete] Failed to delete #${channel.name}:`, error.message);
    }
  }

  // Clear mappings and starred channels
  ircChannels.clear();
  discordChannelMap.clear();
  starredChannels.clear();

  console.log(`[Delete] Deleted ${deletedCount} IRC relay channels`);
  return deletedCount;
}

/**
 * Handle IRC LIST response
 */
function handleIRCListResponse(event) {
  // RPL_LIST (322) format: :server 322 nick channel :topic
  if (event.params && event.params[1]) {
    const channel = event.params[1];
    if (channel.startsWith('#')) {
      ircChannels.add(channel);
    }
  }
}

// ========== LOGIN ==========
discordClient.login(DISCORD_TOKEN);
