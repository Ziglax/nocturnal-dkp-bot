const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const log = require('../debugger.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('addraiddkp')
        .setDescription('Add DKP to the entiere raid channel')
        .addIntegerOption(option => option.setName('dkp').setDescription('The amount of DKP to add').setRequired(true))
        .addStringOption(option => option.setName('comment').setDescription('Reason').setRequired(true)),
    async execute(interaction, manager, logger) {
        const guild = interaction.guild.id;
        const dkp = interaction.options.getInteger('dkp');
        const comment = interaction.options.getString('comment');


        const guildConfig = await manager.getGuildOptions(interaction.guild.id) || {};
        const raidChannel = guildConfig.raidChannel;
        if (!raidChannel) {
            await interaction.reply({ content: ':prohibited: Please set the raid channel first with /setraidchannel', flags: MessageFlags.Ephemeral });
            return;
        }

        const channel = await interaction.guild.channels.fetch(raidChannel);
        const playersInChannel = [...channel.members.keys()];
        if (playersInChannel.length === 0) {
            await interaction.reply({ content: ':prohibited: No players in the raid channel', flags: MessageFlags.Ephemeral });
            return;
        }


        const activeRaid = await manager.getActiveRaid(guild);
        if (!activeRaid) {
            await interaction.reply({ content: `:prohibited: There is no active raid, use /startraid to start one first`, flags: MessageFlags.Ephemeral });
            return;
        }

        playersInChannel.forEach(async player => {
            await manager.addDKP(guild, player, dkp, comment, activeRaid);
        });

        if (process.env.LOG_LEVEL === 'DEBUG') {
            log(`Executed addraiddkp command`, {
                dkp,
                comment
            });
        }

        await manager.addRaidAttendance(guild, activeRaid, playersInChannel, comment, dkp);
        await interaction.reply({ content: `Added ${dkp} DKP to all players (${playersInChannel.length}) in the raid channel` });

        logger.sendRaidEmebed(guildConfig, activeRaid, playersInChannel, 15105570, `${activeRaid.name}: ${comment}`, dkp, 'DKP');
    },
    restricted: true,
};