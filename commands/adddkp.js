require('dotenv').config()
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const log = require('../debugger.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('adddkp')
        .setDescription('Add DKP to a player')
        .addUserOption(option => option.setName('player').setDescription('The player').setRequired(true))
        .addIntegerOption(option => option.setName('dkp').setDescription('The amount of DKP to add').setMinValue(1).setRequired(true))
        .addStringOption(option => option.setName('comment').setDescription('Reason').setRequired(true)),
    async execute(interaction, manager) {
        const guild = interaction.guild.id;
        const player = interaction.options.getUser('player');
        const dkp = interaction.options.getInteger('dkp');
        const comment = interaction.options.getString('comment');

        if (process.env.LOG_LEVEL === 'DEBUG') {
            log(`Executed adddkp command`, {
                player: player.id,
                dkp,
                comment
            });
        }

        // Awaited. Without the await this replied "Added N DKPs" the instant the
        // write was handed to the driver, so a rejected write announced DKP that
        // never landed and left the officer with no way to know.
        try {
            await manager.addDKP(guild, player.id, dkp, comment);
        } catch (error) {
            console.error('[adddkp] DKP write failed', player.id, error?.message || error);
            await interaction.reply({ content: `:prohibited: The DKP write failed for <@${player.id}>. Check \`/dkphistory\` before running this again.`, flags: MessageFlags.Ephemeral });
            return;
        }
        await interaction.reply(`Added ${dkp} DKPs to <@${player.id}>. ${comment}`);
    },
    restricted: true,
};