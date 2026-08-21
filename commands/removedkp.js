const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const log = require('../debugger.js');
const { safeReply } = require('../utils/safe.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('removedkp')
        .setDescription('Remove DKP from a player')
        .addUserOption(option => option.setName('player').setDescription('The player').setRequired(true))
        .addIntegerOption(option => option.setName('dkp').setDescription('The amount of DKP to add').setMinValue(1).setRequired(true))
        .addStringOption(option => option.setName('comment').setDescription('The log to parse').setRequired(true)),
    async execute(interaction, manager) {
        const guild = interaction.guild.id;
        const player = interaction.options.getUser('player');
        const dkp = interaction.options.getInteger('dkp');
        const comment = interaction.options.getString('comment');
        let written = false;
        try {
            const activeRaid = await manager.getActiveRaid(guild);
            await manager.removeDKP(guild, player.id, dkp, comment, activeRaid);
            written = true;

            if (process.env.LOG_LEVEL === 'DEBUG') {
                log(`Executed removedkp command`, {
                    player: player.id,
                    dkp,
                    comment
                });
            }

            await interaction.reply(`Removed ${dkp} DKPs from <@${player.id}>. ${comment}`);
        } catch (error) {
            // Never report a false failure: the write may have succeeded and only the reply failed.
            console.error(written ? 'removedkp: DKP removed but the reply failed:' : 'Failed to remove DKP:', error);
            await safeReply(interaction, {
                content: written ? `Removed ${dkp} DKPs from <@${player.id}> (the confirmation message failed to send).` : '⛔ Failed to remove DKP',
                flags: MessageFlags.Ephemeral
            });
        }
    },
    restricted: true,
};