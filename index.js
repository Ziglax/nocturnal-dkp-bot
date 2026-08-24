const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config()
// File sink for console output (logs/bot.log, LOG_FILE to move or disable): right
// after dotenv so every later line, boot failures included, lands in the file too.
require('./utils/logfile.js').install();
const { Client, Events, GatewayIntentBits, Collection, REST, Routes, PermissionFlagsBits, MessageFlags } = require('discord.js');
const DKPManager = require('./DKPManager/DKPManager.js');
const Worker = require('./worker/Worker.js');
const Logger = require('./utils/Logger');
const Auctioner = require('./Auctioner/Auctioner.js');
const { safeReply } = require('./utils/safe.js');
const { handleLongAuctionBid } = require('./utils/longAuctionBid.js');
const { handleLongAuctionConfirm } = require('./utils/longAuctionConfirm.js');

// Process-level safety nets: a rejected promise or stray exception must not
// kill the bot mid-raid. Log-only by policy (prod restarts are slow and lose
// in-memory auctions); boot failures below still fail fast.
process.on('unhandledRejection', (reason) => {
	console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (error) => {
	console.error('Uncaught exception:', error);
});

for (const key of ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'MONGO_URL']) {
	if (!process.env[key]) {
		console.error(`Missing required env var ${key}`);
		process.exit(1);
	}
}

const dbClient = require('./db.js');
// connect() is async: exit on rejection so the restart policy retries with a
// clear error instead of an unhandled-rejection crash 30s later.
dbClient.connect().catch((error) => {
	console.error(error);
	process.exit(1);
});

const log = require('./debugger.js');

const dkpManager = new DKPManager(dbClient);
const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const auctioner = new Auctioner(dkpManager);

// Create a new client instance
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.DirectMessages] });
client.on(Events.Error, (error) => console.error('Discord client error:', error));
client.on(Events.ShardError, (error) => console.error('Discord shard error:', error));
const worker = new Worker(client, dkpManager);
const logger = new Logger(client);

client.commands = new Collection();
const commands = [];

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
	const filePath = path.join(commandsPath, file);
	const command = require(filePath);
	// Set a new item in the Collection with the key as the command name and the value as the exported module
	if ('data' in command && 'execute' in command) {
		client.commands.set(command.data.name, command);
		commands.push(command.data.toJSON());
	} else {
		console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
	}
}

client.on(Events.InteractionCreate, async interaction => {
	// Long auction bid buttons, before the chat-input gate below drops every
	// component interaction. They cannot be answered by a message collector like
	// the short-auction buttons are: a long auction outlives the process, and a
	// collector does not, so after a restart its buttons would silently do nothing.
	if (interaction.isButton() && interaction.customId.startsWith('lbid_')) {
		try {
			await handleLongAuctionBid(interaction, dkpManager);
		} catch (error) {
			console.error('[long auction bid]', error);
		}
		return;
	}

	// Same story for the Confirm button of a closed long auction: the worker closes
	// it long after the command that started it has gone, so no collector owns it.
	if (interaction.isButton() && interaction.customId.startsWith('lconfirm_')) {
		try {
			await handleLongAuctionConfirm(interaction, dkpManager, logger);
		} catch (error) {
			console.error('[long auction confirm]', error);
		}
		return;
	}

	if (!interaction.isChatInputCommand()) return;

	if (!interaction.guild) {
		// Above the try block: needs its own crash protection.
		await safeReply(interaction, { content: `This command can only be used in a discord server`, flags: MessageFlags.Ephemeral });
		return;
	}

	const command = interaction.client.commands.get(interaction.commandName);

	if (!command) {
		console.error(`No command matching ${interaction.commandName} was found.`);
		return;
	}

	try {
		// Guild administrators bypass the officer-role check: the role lives in the
		// guild config, which /configure (itself restricted) must be able to create
		// while the database is still empty.
		if (command.restricted && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
			const guildConfig = await dkpManager.getGuildOptions(interaction.guild.id);
			if (!guildConfig || !interaction.member.roles.cache.has(guildConfig.adminRole)) {
				await safeReply(interaction, { content: `You don't have the permission to use this command`, flags: MessageFlags.Ephemeral });
				return;
			}
		}
		await command.execute(interaction, dkpManager, logger);
	} catch (error) {
		console.error(`Error executing command ${interaction.commandName}:`, error);
		log(`Error executing command: ${interaction.commandName}`, error).catch(() => {});
		await safeReply(interaction, { content: '⛔ Something went wrong running that command.', flags: MessageFlags.Ephemeral });
	}
});

client.once(Events.ClientReady, async c => {
	try {
		console.log(`Started refreshing ${commands.length} application commands.`);

		// The put method is used to fully refresh all commands in the guild with the current set
		const rest = new REST().setToken(token);
		//await rest.put(Routes.applicationCommands(clientId), { body: [] });
		await rest.put(Routes.applicationCommands(clientId), { body: commands })
		console.log(`Successfully reloaded application commands.`);

		//uncomment to force reload
		/*c.guilds.cache.forEach(async guild => {
			console.log(`Started refreshing ${commands.length} application (/) commands for guild: ${guild.name} (${guild.id}).`);
			// The put method is used to fully refresh all commands in the guild with the current set
			await rest.put(Routes.applicationGuildCommands(clientId, guild.id), { body: commands });
			await rest.put(Routes.applicationGuildCommands(clientId, guild.id), { body: [] });
			console.log(`Successfully reloaded application (/) commands for guild: ${guild.name} (${guild.id}).`);
		});*/


	} catch (error) {
		// And of course, make sure you catch and log any errors!
		console.error(error);
	}

	console.log(`Ready! Logged in as ${c.user.tag}`);
	worker.start();
});

client.login(token).catch((error) => {
	console.error('Failed to log in to Discord:', error);
	process.exit(1);
});

