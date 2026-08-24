require('dotenv').config()
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const log = require('../debugger.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('playerdkp')
        .setDescription('Shows the DKP of a player')
        .addUserOption(option => option.setName('player').setDescription('The player').setRequired(false)),
    async execute(interaction, manager) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const guild = interaction.guild.id;
        const player = interaction.options.getUser('player') || interaction.user;

        if (process.env.LOG_LEVEL === 'DEBUG') {
            log(`Executed playerdkp`, {
                user: interaction.user.id,
                player: player.id
            });
        }

        try {
            const currentDKP = await manager.getPlayerDKP(guild, player.id);
            await interaction.editReply({ content: '` ' + currentDKP + ' ` DKP' });
        } catch (e) {
            // Without this reply the interaction stayed on "thinking..." forever.
            console.error('[playerdkp]', e);
            log(`Error getting playerdkp for player`, {
                player: player.id,
                error: e?.message
            });
            await interaction.editReply({
                content: e?.message === 'Player not found'
                    ? `:prohibited: ${player.username} has no DKP record yet`
                    : ':prohibited: Could not read the DKP, try again in a moment.'
            });
        }
    },
    restricted: false,
};