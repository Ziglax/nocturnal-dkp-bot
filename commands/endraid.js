const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { processRaidHelperEventDKP } = require('../utils/raidHelperUtils');
const { safeReply } = require('../utils/safe.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('endraid')
        .setDescription('End current raid'),
    async execute(interaction, manager, logger) {
        const guild = interaction.guild.id;
        const guildConfig = await manager.getGuildOptions(guild) || {};

        const activeRaid = await manager.getActiveRaid(guild);
        if (!activeRaid) {
            await interaction.reply({ content: ':prohibited: There is no active raid', flags: MessageFlags.Ephemeral });
            return;
        }
        await manager.endRaid(guild);

        await interaction.reply({ content: `Raid ${activeRaid.name} ended`, flags: MessageFlags.Ephemeral });

        // The raid is closed above and cannot be reopened, so every step below is
        // best effort: none of them may throw their way out of this command and
        // leave the officer with a raid that ended with no summary and no
        // Raid-Helper bonus. What did not work is collected here and reported once.
        const warnings = [];
        const fetchChannel = async (channelId) => {
            if (!channelId) {
                return null;
            }
            return interaction.guild.channels.fetch(channelId).catch((error) => {
                console.error('[endraid] could not fetch channel', channelId, error?.code || '', error?.message || error);
                return null;
            });
        };

        const raidChannel = await fetchChannel(guildConfig.raidChannel);
        const secondChannel = await fetchChannel(guildConfig.secondRaidChannel);

        if (guildConfig.secondRaidChannel && !secondChannel?.members) {
            warnings.push('the second raid voice channel could not be read, so its members are missing from the final attendance snapshot');
        }

        if (raidChannel?.members) {
            const playersInChannel = [...raidChannel.members.keys()];
            const playersInSecondChannel = secondChannel?.members ? [...secondChannel.members.keys()] : [];
            await manager.addRaidAttendance(guild, activeRaid, [...playersInChannel, ...playersInSecondChannel], 'End', 0);
        } else {
            // Writing the snapshot anyway would record that nobody was in the raid,
            // and every player who actually was there would see their attendance %
            // drop for it. No snapshot is the honest answer.
            console.error('[endraid] raid channel unavailable, End snapshot skipped', guildConfig.raidChannel);
            warnings.push('the raid voice channel could not be read, so no final attendance snapshot was taken');
        }

        const log = await manager.getRaidDKPMovements(guild, activeRaid._id);
        const logMessage = await Promise.all(log.map(async (entry) => {
            // A looter who has left the guild since winning makes this fetch throw
            // Unknown Member, and that throw used to abort the whole command: no
            // summary in the log channel, and no Raid-Helper bonus below. The
            // mention renders the same way a fetched member does, so the fallback
            // costs the summary nothing.
            const player = entry.player
                ? await interaction.guild.members.fetch(entry.player).catch(() => `<@${entry.player}>`)
                : '';
            if (player && entry.item) {
                return `<t:${Math.floor(entry.date / 1000)}:t> *${player}* won [${entry.item.name}](${entry.item.url}) for ${Math.abs(entry.dkps)} dkps`;
            }
            if (player) {
                return `<t:${Math.floor(entry.date / 1000)}:t> *${player}* ${entry.dkps > 0 ? 'gained' : 'lost'} ${Math.abs(entry.dkps)} dkps *${entry.comment}*`;
            }

            return `<t:${Math.floor(entry.date / 1000)}:t> *${entry.comment}*`;
        }));

        await logger.sendRaidEndEmbed(guildConfig, activeRaid, logMessage);

        if (activeRaid.eventId) {
            const logChannel = await fetchChannel(guildConfig.logChannel);
            try {
                // Awards the bonus even with no log channel - it only skips the report.
                await processRaidHelperEventDKP({
                    guild,
                    raidId: activeRaid._id,
                    eventId: activeRaid.eventId,
                    dkp: 5,
                    manager,
                    guildInstance: interaction.guild,
                    logger,
                    logChannel
                });
            } catch (error) {
                console.error('[endraid] Raid-Helper event bonus failed', activeRaid.eventId, error?.message || error);
                warnings.push(`the Raid-Helper bonus could not be awarded (${error?.message || error}) - \`/addraideventdkp 5 ${activeRaid._id} ${activeRaid.eventId}\` runs it again`);
            }
        }

        if (warnings.length) {
            await safeReply(interaction, { content: `:warning: Raid **${activeRaid.name}** is ended, but ${warnings.join(', and ')}.`, flags: MessageFlags.Ephemeral });
        }
    },
    restricted: true,
};
