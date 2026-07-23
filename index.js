'use strict';

const http = require('node:http');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const REQUIRED_ENV = [
  'DISCORD_TOKEN',
  'CLIENT_ID',
  'GUILD_ID',
  'LEAGUE_CHANNEL_ID',
  'QUEUE_1S_CHANNEL_ID',
  'QUEUE_2S_CHANNEL_ID',
  'MATCH_CATEGORY_ID',
  'LEADERBOARD_CHANNEL_ID',
  'LEAGUE_ADMIN_ROLE_ID',
  'WAGER_ADMIN_ROLE_ID',
  'BRONZE_ROLE_ID',
  'SILVER_ROLE_ID',
  'GOLD_ROLE_ID',
  'PLATINUM_ROLE_ID',
  'EMERALD_ROLE_ID',
  'DIAMOND_ROLE_ID',
  'MASTER_ROLE_ID',
  'GRANDMASTER_ROLE_ID',
  'ELITE_ROLE_ID',
  'LEGEND_ROLE_ID',
];

const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
  process.exit(1);
}

const POINTS_PER_MATCH = 20;
const LEADERBOARD_LIMIT = 10;
const NICKNAME_INTERVAL_MS = 60_000;
const LEADERBOARD_INTERVAL_MS = 5 * 60_000;
const DATABASE_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'league.db');

const RANKS = [
  { name: 'Bronze', min: 0, max: 199, emoji: '🥉', roleId: process.env.BRONZE_ROLE_ID },
  { name: 'Silver', min: 200, max: 399, emoji: '🥈', roleId: process.env.SILVER_ROLE_ID },
  { name: 'Gold', min: 400, max: 649, emoji: '🥇', roleId: process.env.GOLD_ROLE_ID },
  { name: 'Platinum', min: 650, max: 899, emoji: '💎', roleId: process.env.PLATINUM_ROLE_ID },
  { name: 'Emerald', min: 900, max: 1149, emoji: '💚', roleId: process.env.EMERALD_ROLE_ID },
  { name: 'Diamond', min: 1150, max: 1399, emoji: '💠', roleId: process.env.DIAMOND_ROLE_ID },
  { name: 'Master', min: 1400, max: 1599, emoji: '👑', roleId: process.env.MASTER_ROLE_ID },
  { name: 'Grandmaster', min: 1600, max: 1799, emoji: '🔥', roleId: process.env.GRANDMASTER_ROLE_ID },
  { name: 'Elite', min: 1800, max: 1949, emoji: '⚡', roleId: process.env.ELITE_ROLE_ID },
  { name: 'Legend', min: 1950, max: Number.POSITIVE_INFINITY, emoji: '🌟', roleId: process.env.LEGEND_ROLE_ID },
];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

const db = new Database(DATABASE_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    user_id TEXT PRIMARY KEY,
    points INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    streak INTEGER NOT NULL DEFAULT 0,
    best_streak INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS queue_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT NOT NULL,
    queue_type TEXT NOT NULL,
    captain_id TEXT NOT NULL,
    teammate_id TEXT,
    joined_at INTEGER NOT NULL,
    UNIQUE(mode, captain_id),
    UNIQUE(mode, teammate_id)
  );

  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_id TEXT NOT NULL UNIQUE,
    mode TEXT NOT NULL,
    queue_type TEXT NOT NULL,
    channel_id TEXT,
    team1_json TEXT NOT NULL,
    team2_json TEXT NOT NULL,
    winner_team INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const getPlayerStmt = db.prepare('SELECT * FROM players WHERE user_id = ?');
const insertPlayerStmt = db.prepare(`
  INSERT INTO players (user_id, points, wins, losses, streak, best_streak, created_at, updated_at)
  VALUES (?, 0, 0, 0, 0, 0, ?, ?)
`);
const setSettingStmt = db.prepare(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);
const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');

function now() {
  return Date.now();
}

function getRank(points) {
  return RANKS.find((rank) => points >= rank.min && points <= rank.max) || RANKS[0];
}

function ensurePlayer(userId) {
  let player = getPlayerStmt.get(userId);
  if (!player) {
    const timestamp = now();
    insertPlayerStmt.run(userId, timestamp, timestamp);
    player = getPlayerStmt.get(userId);
  }
  return player;
}

function cleanBaseName(displayName) {
  return displayName.replace(/^\(\d+\)\s*/, '').trim() || 'Player';
}

function safeChannelName(value) {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 90);
}

function makePublicMatchId(mode) {
  const number = Math.floor(1000 + Math.random() * 9000);
  return `${mode.toUpperCase()}-${number}`;
}

function brandingFiles() {
  return [
    new AttachmentBuilder('./333-banner.png', { name: '333-banner.png' }),
    new AttachmentBuilder('./333-logo.png', { name: '333-logo.png' }),
  ];
}

function premiumEmbed(title, description, color = 0xff1111) {
  return new EmbedBuilder()
    .setColor(color)
    .setAuthor({
      name: '333 PVP • COMPETITIVE LEAGUE',
      iconURL: 'attachment://333-logo.png',
    })
    .setTitle(title)
    .setDescription(description)
    .setThumbnail('attachment://333-logo.png')
    .setFooter({
      text: '333 PVP • PROVE YOUR RANK',
      iconURL: 'attachment://333-logo.png',
    })
    .setTimestamp();
}

function hasAdminRole(member, queueType) {
  if (!member) return false;
  if (member.id === member.guild.ownerId) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;

  const roleId = queueType === 'wager'
    ? process.env.WAGER_ADMIN_ROLE_ID
    : process.env.LEAGUE_ADMIN_ROLE_ID;

  return member.roles.cache.has(roleId);
}

function queueAdminRoleId(queueType) {
  return queueType === 'wager'
    ? process.env.WAGER_ADMIN_ROLE_ID
    : process.env.LEAGUE_ADMIN_ROLE_ID;
}

async function syncRankRole(member, points) {
  if (!member || !member.manageable) return;

  const rank = getRank(points);
  const allRankRoleIds = RANKS.map((item) => item.roleId).filter(Boolean);
  const rolesToRemove = allRankRoleIds.filter(
    (roleId) => roleId !== rank.roleId && member.roles.cache.has(roleId)
  );

  if (rolesToRemove.length > 0) {
    await member.roles.remove(rolesToRemove, '333 PVP automatic rank update').catch(console.error);
  }

  if (rank.roleId && !member.roles.cache.has(rank.roleId)) {
    await member.roles.add(rank.roleId, `333 PVP rank updated to ${rank.name}`).catch(console.error);
  }
}

async function syncNickname(member, points) {
  if (!member || !member.manageable) return;
  const baseName = cleanBaseName(member.displayName);
  const nextName = `(${points}) ${baseName}`.slice(0, 32);

  if (member.displayName !== nextName) {
    await member.setNickname(nextName, '333 PVP points sync').catch(() => {});
  }
}

async function syncMemberProfile(guild, userId) {
  const player = ensurePlayer(userId);
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;
  await syncRankRole(member, player.points);
  await syncNickname(member, player.points);
}

function playerRankPosition(userId) {
  const row = db.prepare(`
    SELECT position FROM (
      SELECT user_id, ROW_NUMBER() OVER (
        ORDER BY points DESC, wins DESC, losses ASC, updated_at ASC
      ) AS position
      FROM players
    ) ranked
    WHERE user_id = ?
  `).get(userId);

  return row?.position || 1;
}

function statsDescription(userId) {
  const player = ensurePlayer(userId);
  const rank = getRank(player.points);
  const matches = player.wins + player.losses;
  const winRate = matches > 0 ? ((player.wins / matches) * 100).toFixed(1) : '0.0';
  const position = playerRankPosition(userId);

  return [
    `### ${rank.emoji} ${rank.name}`,
    '',
    `**League Points**\n\`${player.points.toLocaleString()}\``,
    '',
    `**Wins**\n\`${player.wins.toLocaleString()}\``,
    '',
    `**Losses**\n\`${player.losses.toLocaleString()}\``,
    '',
    `**Win Rate**\n\`${winRate}%\``,
    '',
    `**Current Streak**\n\`${player.streak.toLocaleString()}\``,
    '',
    `**Best Streak**\n\`${player.best_streak.toLocaleString()}\``,
    '',
    `**Leaderboard Position**\n\`#${position}\``,
  ].join('\n');
}

function leaguePanelPayload() {
  const embed = premiumEmbed(
    '🏆 333 PVP LEAGUE',
    [
      '**Welcome to the official 333 PVP competitive league.**',
      '',
      '> Win matches, earn points, climb ranks, and secure your place in the Top 10.',
      '',
      '### Ranked Progression',
      '🥉 Bronze • `0–199`',
      '🥈 Silver • `200–399`',
      '🥇 Gold • `400–649`',
      '💎 Platinum • `650–899`',
      '💚 Emerald • `900–1149`',
      '💠 Diamond • `1150–1399`',
      '👑 Master • `1400–1599`',
      '🔥 Grandmaster • `1600–1799`',
      '⚡ Elite • `1800–1949`',
      '🌟 Legend • `1950+`',
      '',
      '**Every win:** `+20 points`',
      '**Every loss:** `-20 points` • never below zero',
    ].join('\n')
  ).setImage('attachment://333-banner.png');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('league_check_stats')
      .setLabel('Check My Stats')
      .setEmoji('📊')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('league_refresh_stats')
      .setLabel('Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    embeds: [embed],
    components: [row],
    files: brandingFiles(),
    allowedMentions: { parse: [] },
  };
}

function queuePanelPayload(mode) {
  const isOnes = mode === '1s';
  const title = isOnes ? '⚔️ 1V1 MATCHMAKING' : '👥 2V2 MATCHMAKING';
  const description = [
    `**Join the ${isOnes ? '1v1' : '2v2'} queue and get matched automatically.**`,
    '',
    isOnes
      ? '> The first two available players are placed into a private match channel.'
      : '> Enter your teammate’s Discord user ID. Two complete teams are placed into a private match channel.',
    '',
    '### Choose Your Queue',
    '🎮 **Normal Queue** • League Admin support',
    '💰 **Wager Queue** • Wager Admin support',
    '',
    'You cannot join multiple queues or queue while already in an active match.',
  ].join('\n');

  const embed = premiumEmbed(title, description).setImage('attachment://333-banner.png');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`queue_${mode}_normal`)
      .setLabel('Join Normal Queue')
      .setEmoji('🎮')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`queue_${mode}_wager`)
      .setLabel('Join Wager Queue')
      .setEmoji('💰')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`queue_leave_${mode}`)
      .setLabel('Leave Queue')
      .setEmoji('🚪')
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    embeds: [embed],
    components: [row],
    files: brandingFiles(),
    allowedMentions: { parse: [] },
  };
}

function leaderboardEmbed(guild) {
  const rows = db.prepare(`
    SELECT * FROM players
    ORDER BY points DESC, wins DESC, losses ASC, updated_at ASC
    LIMIT ?
  `).all(LEADERBOARD_LIMIT);

  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.length > 0
    ? rows.map((player, index) => {
        const rank = getRank(player.points);
        const medal = medals[index] || `\`#${index + 1}\``;
        const member = guild.members.cache.get(player.user_id);
        const name = member ? cleanBaseName(member.displayName) : `<@${player.user_id}>`;
        return `${medal} **${name}**\n┗ ${rank.emoji} ${rank.name} • **${player.points.toLocaleString()} pts** • ${player.wins}W / ${player.losses}L`;
      })
    : ['*No ranked matches have been completed yet.*'];

  return premiumEmbed(
    '🏆 333 PVP TOP 10',
    [
      '**The highest-ranked players in the city.**',
      '',
      ...lines,
      '',
      '*Updates automatically every 5 minutes.*',
    ].join('\n')
  ).setImage('attachment://333-banner.png');
}

async function upsertPanel(channelId, settingKey, payloadFactory) {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    throw new Error(`${settingKey} channel is not text-based.`);
  }

  const stored = getSettingStmt.get(settingKey)?.value;
  if (stored) {
    const oldMessage = await channel.messages.fetch(stored).catch(() => null);
    if (oldMessage) {
      await oldMessage.edit(payloadFactory());
      return oldMessage;
    }
  }

  const message = await channel.send(payloadFactory());
  setSettingStmt.run(settingKey, message.id);
  return message;
}

async function ensurePanels(guild) {
  await upsertPanel(
    process.env.LEAGUE_CHANNEL_ID,
    'league_panel_message',
    leaguePanelPayload
  );

  await upsertPanel(
    process.env.QUEUE_1S_CHANNEL_ID,
    'queue_1s_panel_message',
    () => queuePanelPayload('1s')
  );

  await upsertPanel(
    process.env.QUEUE_2S_CHANNEL_ID,
    'queue_2s_panel_message',
    () => queuePanelPayload('2s')
  );

  await updateLeaderboard(guild);
}

async function updateLeaderboard(guild) {
  await upsertPanel(
    process.env.LEADERBOARD_CHANNEL_ID,
    'leaderboard_message',
    () => ({
      embeds: [leaderboardEmbed(guild)],
      files: brandingFiles(),
      allowedMentions: { parse: [] },
    })
  );
}

function userIsQueued(userId) {
  return Boolean(db.prepare(`
    SELECT 1 FROM queue_entries
    WHERE captain_id = ? OR teammate_id = ?
    LIMIT 1
  `).get(userId, userId));
}

function userHasActiveMatch(userId) {
  const matches = db.prepare(`
    SELECT team1_json, team2_json FROM matches WHERE status = 'active'
  `).all();

  return matches.some((match) => {
    const players = [...JSON.parse(match.team1_json), ...JSON.parse(match.team2_json)];
    return players.includes(userId);
  });
}

function removeUsersFromQueue(userIds) {
  const placeholders = userIds.map(() => '?').join(',');
  db.prepare(`
    DELETE FROM queue_entries
    WHERE captain_id IN (${placeholders})
       OR teammate_id IN (${placeholders})
  `).run(...userIds, ...userIds);
}

async function joinQueue(interaction, mode, queueType, teammateId = null) {
  const captainId = interaction.user.id;
  const guild = interaction.guild;

  if (userIsQueued(captainId) || userHasActiveMatch(captainId)) {
    await interaction.reply({
      content: 'You are already queued or currently inside an active match.',
      ephemeral: true,
    });
    return;
  }

  if (mode === '2s') {
    if (!teammateId || !/^\d{17,20}$/.test(teammateId)) {
      await interaction.reply({
        content: 'Please provide a valid Discord user ID for your teammate.',
        ephemeral: true,
      });
      return;
    }

    if (teammateId === captainId) {
      await interaction.reply({
        content: 'You cannot use your own Discord ID as your teammate.',
        ephemeral: true,
      });
      return;
    }

    const teammate = await guild.members.fetch(teammateId).catch(() => null);
    if (!teammate || teammate.user.bot) {
      await interaction.reply({
        content: 'That teammate could not be found in this Discord server.',
        ephemeral: true,
      });
      return;
    }

    if (userIsQueued(teammateId) || userHasActiveMatch(teammateId)) {
      await interaction.reply({
        content: 'Your teammate is already queued or inside an active match.',
        ephemeral: true,
      });
      return;
    }
  }

  try {
    db.prepare(`
      INSERT INTO queue_entries (mode, queue_type, captain_id, teammate_id, joined_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(mode, queueType, captainId, teammateId, now());
  } catch {
    await interaction.reply({
      content: 'One of the selected players is already in this queue.',
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: mode === '1s'
      ? `✅ You joined the **${queueType === 'wager' ? 'Wager' : 'Normal'} 1v1 queue**.`
      : `✅ You and <@${teammateId}> joined the **${queueType === 'wager' ? 'Wager' : 'Normal'} 2v2 queue**.`,
    ephemeral: true,
  });

  await tryMatchmake(guild, mode, queueType);
}

async function tryMatchmake(guild, mode, queueType) {
  const entries = db.prepare(`
    SELECT * FROM queue_entries
    WHERE mode = ? AND queue_type = ?
    ORDER BY joined_at ASC
    LIMIT 2
  `).all(mode, queueType);

  if (entries.length < 2) return;

  const first = entries[0];
  const second = entries[1];

  const team1 = mode === '1s'
    ? [first.captain_id]
    : [first.captain_id, first.teammate_id];

  const team2 = mode === '1s'
    ? [second.captain_id]
    : [second.captain_id, second.teammate_id];

  removeUsersFromQueue([...team1, ...team2]);

  try {
    await createMatch(guild, mode, queueType, team1, team2);
  } catch (error) {
    console.error('Failed to create match:', error);

    const restore = db.prepare(`
      INSERT OR IGNORE INTO queue_entries
      (mode, queue_type, captain_id, teammate_id, joined_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    restore.run(mode, queueType, first.captain_id, first.teammate_id, first.joined_at);
    restore.run(mode, queueType, second.captain_id, second.teammate_id, second.joined_at);
  }
}

async function createMatch(guild, mode, queueType, team1, team2) {
  const publicId = makePublicMatchId(mode);
  const adminRoleId = queueAdminRoleId(queueType);
  const channelName = safeChannelName(
    `${mode === '1s' ? '1s-match' : '2s-match'}-${publicId.split('-')[1]}`
  );

  const permissionOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
      ],
    },
    {
      id: adminRoleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ],
    },
    ...[...team1, ...team2].map((userId) => ({
      id: userId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    })),
  ];

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: process.env.MATCH_CATEGORY_ID,
    topic: `333 PVP ${mode.toUpperCase()} ${queueType.toUpperCase()} match ${publicId}`,
    permissionOverwrites,
  });

  const result = db.prepare(`
    INSERT INTO matches (
      public_id, mode, queue_type, channel_id,
      team1_json, team2_json, status, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(
    publicId,
    mode,
    queueType,
    channel.id,
    JSON.stringify(team1),
    JSON.stringify(team2),
    now()
  );

  const matchId = Number(result.lastInsertRowid);
  const team1Mentions = team1.map((id) => `<@${id}>`).join('\n');
  const team2Mentions = team2.map((id) => `<@${id}>`).join('\n');
  const allMentions = [...team1, ...team2].map((id) => `<@${id}>`).join(' ');

  const embed = premiumEmbed(
    `⚔️ ${mode.toUpperCase()} MATCH • ${publicId}`,
    [
      `### TEAM 1`,
      team1Mentions,
      '',
      '**VS**',
      '',
      `### TEAM 2`,
      team2Mentions,
      '',
      `**Queue Type:** ${queueType === 'wager' ? '💰 Wager' : '🎮 Normal'}`,
      `**Match ID:** \`${publicId}\``,
      '',
      `**Winner Reward:** +${POINTS_PER_MATCH} points each`,
      `**Loss Penalty:** -${POINTS_PER_MATCH} points each • minimum 0`,
    ].join('\n')
  ).setImage('attachment://333-banner.png');

  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`match_request_admin:${matchId}`)
      .setLabel('Request Admin')
      .setEmoji('🚨')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`match_assign_winner:${matchId}`)
      .setLabel('Assign Winner')
      .setEmoji('🏆')
      .setStyle(ButtonStyle.Danger)
  );

  await channel.send({
    content: `${allMentions} <@&${adminRoleId}>`,
    embeds: [embed],
    components: [controls],
    files: brandingFiles(),
    allowedMentions: {
      users: [...team1, ...team2],
      roles: [adminRoleId],
    },
  });
}

async function requestAdmin(interaction, matchId) {
  const match = db.prepare(`
    SELECT * FROM matches WHERE id = ? AND status = 'active'
  `).get(matchId);

  if (!match) {
    await interaction.reply({
      content: 'This match is no longer active.',
      ephemeral: true,
    });
    return;
  }

  const participants = [...JSON.parse(match.team1_json), ...JSON.parse(match.team2_json)];
  if (!participants.includes(interaction.user.id)) {
    await interaction.reply({
      content: 'Only players in this match can request an admin.',
      ephemeral: true,
    });
    return;
  }

  const roleId = queueAdminRoleId(match.queue_type);
  const role = interaction.guild.roles.cache.get(roleId);
  const admins = role
    ? role.members.filter((member) => !member.user.bot)
    : new Map();

  const jumpUrl = `https://discord.com/channels/${interaction.guild.id}/${interaction.channel.id}`;

  let sent = 0;
  for (const member of admins.values()) {
    try {
      const embed = new EmbedBuilder()
        .setColor(0xff1111)
        .setTitle('🚨 333 PVP ADMIN REQUEST')
        .setDescription(
          [
            `**Requested by:** ${interaction.user}`,
            `**Match:** \`${match.public_id}\``,
            `**Queue:** ${match.queue_type === 'wager' ? 'Wager' : 'Normal'}`,
            `**Channel:** <#${interaction.channel.id}>`,
            '',
            `[Jump directly to the match](${jumpUrl})`,
          ].join('\n')
        )
        .setTimestamp();

      await member.send({ embeds: [embed] });
      sent += 1;
    } catch {
      // DMs may be closed.
    }
  }

  await interaction.reply({
    content: sent > 0
      ? `✅ Admin request sent to **${sent}** available admin(s).`
      : '⚠️ The admin role was notified here, but no private DMs could be delivered.',
    ephemeral: true,
  });

  await interaction.channel.send({
    content: `<@&${roleId}> assistance has been requested by ${interaction.user}.`,
    allowedMentions: { roles: [roleId], users: [interaction.user.id] },
  });
}

async function showWinnerSelector(interaction, matchId) {
  const match = db.prepare(`
    SELECT * FROM matches WHERE id = ? AND status = 'active'
  `).get(matchId);

  if (!match) {
    await interaction.reply({
      content: 'This match is no longer active.',
      ephemeral: true,
    });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasAdminRole(member, match.queue_type)) {
    await interaction.reply({
      content: 'Only the correct League Admin or Wager Admin role can assign a winner.',
      ephemeral: true,
    });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`match_winner_select:${matchId}`)
    .setPlaceholder('Select the winning team')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('Team 1 Wins')
        .setDescription('Award Team 1 and deduct Team 2')
        .setEmoji('🏆')
        .setValue('1'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Team 2 Wins')
        .setDescription('Award Team 2 and deduct Team 1')
        .setEmoji('🏆')
        .setValue('2')
    );

  await interaction.reply({
    content: 'Select the official winner for this match:',
    components: [new ActionRowBuilder().addComponents(menu)],
    ephemeral: true,
  });
}

const finalizeMatchTransaction = db.transaction((matchId, winningTeam) => {
  const match = db.prepare(`
    SELECT * FROM matches WHERE id = ? AND status = 'active'
  `).get(matchId);

  if (!match) throw new Error('MATCH_NOT_ACTIVE');

  const team1 = JSON.parse(match.team1_json);
  const team2 = JSON.parse(match.team2_json);
  const winners = winningTeam === 1 ? team1 : team2;
  const losers = winningTeam === 1 ? team2 : team1;
  const timestamp = now();

  for (const userId of winners) {
    ensurePlayer(userId);
    db.prepare(`
      UPDATE players
      SET points = points + ?,
          wins = wins + 1,
          streak = streak + 1,
          best_streak = MAX(best_streak, streak + 1),
          updated_at = ?
      WHERE user_id = ?
    `).run(POINTS_PER_MATCH, timestamp, userId);
  }

  for (const userId of losers) {
    ensurePlayer(userId);
    db.prepare(`
      UPDATE players
      SET points = MAX(0, points - ?),
          losses = losses + 1,
          streak = 0,
          updated_at = ?
      WHERE user_id = ?
    `).run(POINTS_PER_MATCH, timestamp, userId);
  }

  db.prepare(`
    UPDATE matches
    SET winner_team = ?, status = 'completed', completed_at = ?
    WHERE id = ?
  `).run(winningTeam, timestamp, matchId);

  return { match, winners, losers };
});

async function finalizeMatch(interaction, matchId, winningTeam) {
  const match = db.prepare(`
    SELECT * FROM matches WHERE id = ? AND status = 'active'
  `).get(matchId);

  if (!match) {
    await interaction.reply({
      content: 'This match has already been completed.',
      ephemeral: true,
    });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasAdminRole(member, match.queue_type)) {
    await interaction.reply({
      content: 'You are not authorized to assign the winner for this match.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  let result;
  try {
    result = finalizeMatchTransaction(matchId, winningTeam);
  } catch (error) {
    if (error.message === 'MATCH_NOT_ACTIVE') {
      await interaction.editReply('This match has already been completed.');
      return;
    }
    throw error;
  }

  for (const userId of [...result.winners, ...result.losers]) {
    await syncMemberProfile(interaction.guild, userId);
  }

  const winnerMentions = result.winners.map((id) => `<@${id}>`).join('\n');
  const loserMentions = result.losers.map((id) => `<@${id}>`).join('\n');

  const embed = premiumEmbed(
    `🏆 TEAM ${winningTeam} WINS`,
    [
      '### WINNING TEAM',
      winnerMentions,
      `**+${POINTS_PER_MATCH} points each**`,
      '',
      '### DEFEATED TEAM',
      loserMentions,
      `**-${POINTS_PER_MATCH} points each • minimum 0**`,
      '',
      `**Match:** \`${result.match.public_id}\``,
      '',
      '*This match channel will close in 10 seconds.*',
    ].join('\n'),
    0x22c55e
  ).setImage('attachment://333-banner.png');

  await interaction.channel.send({
    content: result.winners.map((id) => `<@${id}>`).join(' '),
    embeds: [embed],
    files: brandingFiles(),
    allowedMentions: { users: result.winners },
  });

  await interaction.editReply(`✅ Team ${winningTeam} has been recorded as the winner.`);
  await updateLeaderboard(interaction.guild).catch(console.error);

  setTimeout(async () => {
    await interaction.channel.delete(
      `333 PVP match ${result.match.public_id} completed by ${interaction.user.tag}`
    ).catch(console.error);
  }, 10_000).unref();
}

async function syncAllNicknamesAndRanks(guild) {
  const rows = db.prepare('SELECT user_id, points FROM players').all();

  for (const row of rows) {
    const member = await guild.members.fetch(row.user_id).catch(() => null);
    if (!member) continue;
    await syncRankRole(member, row.points);
    await syncNickname(member, row.points);
  }
}

const commands = [
  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('View league stats for yourself or another player')
    .addUserOption((option) =>
      option.setName('player').setDescription('Player to inspect').setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('leavequeue')
    .setDescription('Leave any active 1v1 or 2v2 queue'),
  new SlashCommandBuilder()
    .setName('league-setup')
    .setDescription('Rebuild all 333 PVP league panels')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('setpoints')
    .setDescription('Set a player’s league points')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((option) =>
      option.setName('player').setDescription('Player').setRequired(true)
    )
    .addIntegerOption((option) =>
      option.setName('points').setDescription('New point total').setMinValue(0).setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('addpoints')
    .setDescription('Add league points to a player')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((option) =>
      option.setName('player').setDescription('Player').setRequired(true)
    )
    .addIntegerOption((option) =>
      option.setName('points').setDescription('Points to add').setMinValue(1).setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('removepoints')
    .setDescription('Remove league points without going below zero')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((option) =>
      option.setName('player').setDescription('Player').setRequired(true)
    )
    .addIntegerOption((option) =>
      option.setName('points').setDescription('Points to remove').setMinValue(1).setRequired(true)
    ),
].map((command) => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`333 PVP League Bot online as ${readyClient.user.tag}`);

  readyClient.user.setPresence({
    activities: [{ name: '333 PVP Ranked League' }],
    status: 'online',
  });

  try {
    await registerCommands();
    const guild = await readyClient.guilds.fetch(process.env.GUILD_ID);
    const fullGuild = await guild.fetch();
    await fullGuild.members.fetch();
    await ensurePanels(fullGuild);
    await syncAllNicknamesAndRanks(fullGuild);
  } catch (error) {
    console.error('Startup setup failed:', error);
  }

  setInterval(async () => {
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    if (guild) await syncAllNicknamesAndRanks(guild).catch(console.error);
  }, NICKNAME_INTERVAL_MS).unref();

  setInterval(async () => {
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    if (guild) await updateLeaderboard(guild).catch(console.error);
  }, LEADERBOARD_INTERVAL_MS).unref();
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId === 'league_check_stats' || interaction.customId === 'league_refresh_stats') {
        const embed = premiumEmbed(
          '📊 YOUR 333 PVP PROFILE',
          statsDescription(interaction.user.id)
        );

        await interaction.reply({
          embeds: [embed],
          files: [new AttachmentBuilder('./333-logo.png', { name: '333-logo.png' })],
          ephemeral: true,
        });
        return;
      }

      if (interaction.customId.startsWith('queue_1s_')) {
        const queueType = interaction.customId.endsWith('_wager') ? 'wager' : 'normal';
        await joinQueue(interaction, '1s', queueType);
        return;
      }

      if (interaction.customId === 'queue_leave_1s' || interaction.customId === 'queue_leave_2s') {
        const result = db.prepare(`
          DELETE FROM queue_entries
          WHERE captain_id = ? OR teammate_id = ?
        `).run(interaction.user.id, interaction.user.id);

        await interaction.reply({
          content: result.changes > 0
            ? '✅ You have left the queue.'
            : 'You are not currently in a queue.',
          ephemeral: true,
        });
        return;
      }

      if (interaction.customId.startsWith('queue_2s_')) {
        const queueType = interaction.customId.endsWith('_wager') ? 'wager' : 'normal';

        const modal = new ModalBuilder()
          .setCustomId(`queue_2s_modal:${queueType}`)
          .setTitle(`333 PVP ${queueType === 'wager' ? 'Wager' : 'Normal'} 2v2`);

        const teammateInput = new TextInputBuilder()
          .setCustomId('teammate_id')
          .setLabel('Teammate Discord User ID')
          .setPlaceholder('Example: 123456789012345678')
          .setStyle(TextInputStyle.Short)
          .setMinLength(17)
          .setMaxLength(20)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(teammateInput));
        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId.startsWith('match_request_admin:')) {
        const matchId = Number(interaction.customId.split(':')[1]);
        await requestAdmin(interaction, matchId);
        return;
      }

      if (interaction.customId.startsWith('match_assign_winner:')) {
        const matchId = Number(interaction.customId.split(':')[1]);
        await showWinnerSelector(interaction, matchId);
        return;
      }
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('queue_2s_modal:')) {
      const queueType = interaction.customId.split(':')[1];
      const teammateId = interaction.fields.getTextInputValue('teammate_id').trim();
      await joinQueue(interaction, '2s', queueType, teammateId);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('match_winner_select:')) {
      const matchId = Number(interaction.customId.split(':')[1]);
      const winningTeam = Number(interaction.values[0]);
      await finalizeMatch(interaction, matchId, winningTeam);
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'stats') {
      const user = interaction.options.getUser('player') || interaction.user;
      const embed = premiumEmbed(
        `📊 ${user.username.toUpperCase()} • LEAGUE PROFILE`,
        statsDescription(user.id)
      );

      await interaction.reply({
        embeds: [embed],
        files: [new AttachmentBuilder('./333-logo.png', { name: '333-logo.png' })],
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'leavequeue') {
      const result = db.prepare(`
        DELETE FROM queue_entries
        WHERE captain_id = ? OR teammate_id = ?
      `).run(interaction.user.id, interaction.user.id);

      await interaction.reply({
        content: result.changes > 0
          ? '✅ You left the active queue.'
          : 'You are not currently queued.',
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'league-setup') {
      await interaction.deferReply({ ephemeral: true });
      await ensurePanels(interaction.guild);
      await interaction.editReply('✅ All 333 PVP league panels have been rebuilt.');
      return;
    }

    if (['setpoints', 'addpoints', 'removepoints'].includes(interaction.commandName)) {
      const target = interaction.options.getUser('player', true);
      const amount = interaction.options.getInteger('points', true);
      ensurePlayer(target.id);

      if (interaction.commandName === 'setpoints') {
        db.prepare(`
          UPDATE players SET points = ?, updated_at = ? WHERE user_id = ?
        `).run(amount, now(), target.id);
      } else if (interaction.commandName === 'addpoints') {
        db.prepare(`
          UPDATE players SET points = points + ?, updated_at = ? WHERE user_id = ?
        `).run(amount, now(), target.id);
      } else {
        db.prepare(`
          UPDATE players SET points = MAX(0, points - ?), updated_at = ? WHERE user_id = ?
        `).run(amount, now(), target.id);
      }

      await syncMemberProfile(interaction.guild, target.id);
      await updateLeaderboard(interaction.guild);

      const player = ensurePlayer(target.id);
      const rank = getRank(player.points);

      await interaction.reply({
        content: `✅ ${target} now has **${player.points.toLocaleString()} points** and the **${rank.name}** role.`,
        ephemeral: true,
      });
    }
  } catch (error) {
    console.error('Interaction error:', error);

    const message = 'Something went wrong. Please check the bot logs and permissions.';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => {});
    } else {
      await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
    }
  }
});

client.on(Events.GuildMemberRemove, (member) => {
  db.prepare(`
    DELETE FROM queue_entries
    WHERE captain_id = ? OR teammate_id = ?
  `).run(member.id, member.id);
});

client.on(Events.Error, console.error);
client.on(Events.Warn, console.warn);

const port = Number(process.env.PORT || 3000);
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({
    service: '333-pvp-league-bot',
    status: client.isReady() ? 'online' : 'starting',
  }));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Health server listening on port ${port}`);
});

client.login(process.env.DISCORD_TOKEN);

function shutdown(signal) {
  console.log(`${signal} received. Shutting down...`);
  server.close();
  client.destroy();
  db.close();
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
