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

        // Awaited one at a time. forEach(async ...) fired every write and waited for
        // none of them, so the reply below announced DKP that could still fail to
        // land, and the attendance snapshot recorded players nobody had credited.
        const credited = [];
        const failed = [];
        for (const player of playersInChannel) {
            try {
                await manager.addDKP(guild, player, dkp, comment, activeRaid);
                credited.push(player);
            } catch (error) {
                console.error('[addraiddkp] DKP write failed', player, error?.message || error);
                failed.push(player);
            }
        }

        if (process.env.LOG_LEVEL === 'DEBUG') {
            log(`Executed addraiddkp command`, {
                dkp,
                comment
            });
        }

        if (credited.length === 0) {
            await interaction.reply({ content: `:prohibited: No DKP was added: all ${playersInChannel.length} writes failed. No attendance was recorded either.`, flags: MessageFlags.Ephemeral });
            return;
        }

        // Only the players actually credited go into the snapshot: an attendance
        // entry naming someone who never received the DKP would count towards their
        // attendance % for a tick they were not paid for.
        await manager.addRaidAttendance(guild, activeRaid, credited, comment, dkp);
        await interaction.reply({
            content: failed.length
                ? `Added ${dkp} DKP to ${credited.length} of ${playersInChannel.length} players in the raid channel. Failed for ${failed.slice(0, 10).map(id => `<@${id}>`).join(', ')}${failed.length > 10 ? ` and ${failed.length - 10} more` : ''} - they were left out of the attendance snapshot.`
                : `Added ${dkp} DKP to all players (${credited.length}) in the raid channel`
        });

        logger.sendRaidEmebed(guildConfig, activeRaid, credited, 15105570, `${activeRaid.name}: ${comment}`, dkp, 'DKP');
    },
    restricted: true,
};