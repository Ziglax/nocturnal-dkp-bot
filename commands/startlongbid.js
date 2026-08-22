const { SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType, MessageFlags } = require('discord.js');
const ItemSearch = require('../search/ItemSearch');
const Auctioner = require('../Auctioner/Auctioner');
const { playSound } = require('../utils/Player.js');
const client = require('../db');
const { safeAck, safeReply } = require('../utils/safe.js');

const itemSearch = new ItemSearch();

const winnerMessage = (auction) => {
    if (auction.winner) {
        return `<@${auction.winner.player}>${auction.winner.bidForMain ? '' : ' - alter'} for ${auction.winner.amount} dkp`;
    }

    if (auction.winners.length) {
        return auction.winners.map(winner => `<@${winner.player}>${winner.bidForMain ? '' : ' - alter'} for ${winner.amount} dkp`).join('\n');
    }

    return 'No winner';
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('startlongbid')
        .setDescription('start a bid for an item')
        .addStringOption(option => option.setName('search').setDescription('Item name or id').setRequired(true))
        .addIntegerOption(option => option.setName('minbid').setDescription('Minimum bid').setMinValue(0).setRequired(false))
        .addIntegerOption(option => option.setName('numitems').setDescription('Number of items').setMinValue(1).setRequired(false))
        .addIntegerOption(option => option.setName('duration').setDescription('Hours of bid').setRequired(false))
        .addStringOption(option => option.setName('database').setDescription('quarm | takp').setRequired(false)),
    async execute(interaction, manager, logger) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const guild = interaction.guild;
        const guildConfig = await manager.getGuildOptions(interaction.guild.id) || {};
        const search = interaction.options.getString('search');
        const hours = interaction.options.getInteger('duration') || 48;

        const minBid = interaction.options.getInteger('minbid') || guildConfig.minBid || 0;
        const numberOfItems = interaction.options.getInteger('numitems') || 1;
        const database = interaction.options.getString('database') || 'quarm';

        if (database !== 'quarm' && database !== 'takp') {
            await interaction.editReply({ content: 'Invalid database option. Must be quarm or takp' });
            return;
        }

        const items = await itemSearch.searchItem(search, database);

        if (!items) {
            await interaction.editReply({ content: 'No items found' });
            return;
        }

        if (items.length && items.length > 40) {
            await interaction.editReply({ content: `List too long (${items.length}), refine search` });
            return;
        }

        if (items.length && items.length > 25) {
            await interaction.editReply({ embeds: [logger.itemsToEmbededList(items)] });
            return;
        }

        let item;
        if (!Array.isArray(items)) {
            item = items;
        } else {
            const itemId = await logger.itemsSearchToEmbed(interaction, items, true);
            if (!itemId) {
                return;
            }
            item = await itemSearch.searchItem(itemId, database);
        }

        if (!item) {
            await interaction.editReply({ content: 'No items found' });
            return;
        }

        const startAuctionMessage = await logger.sendItemEmbed(interaction, item, true);
        const collectorFilter = i => i.user.id === interaction.user.id;
        // Set synchronously, before the first await: two clicks on Start Auction
        // land as two collect events before collector.stop() runs, which used to
        // create two auctions for the same item (and two overlapping bells).
        let starting = false;
        const collector = startAuctionMessage.createMessageComponentCollector({ componentType: ComponentType.Button, time: 30_000, filter: collectorFilter });
        collector.on('collect', async i => {
            try {
                if (i.customId.startsWith(`startbid_`)) {
                    if (starting) {
                        // Acknowledge the click we are dropping, otherwise Discord
                        // shows the officer a red "This interaction failed".
                        await safeAck(i);
                        return;
                    }
                    starting = true;
                    // Released on every path that stops before collector.stop(): those
                    // never created an auction, so the officer must be able to retry.
                    if (!(await safeAck(i))) {
                        starting = false;
                        return;
                    }
                    await interaction.editReply({
                        content: `Bid started`,
                        embeds: [],
                        components: []
                    });
                    collector.stop();

                    const duration = hours * 60 * 60 * 1000;
                    //guild, item, minBid, numberOfItems, minBidToLockForMain, overBidtoWinMain, duration = 48
                    const auction = await manager.createAution(guild.id, item, minBid, numberOfItems, guildConfig.minBidToLockForMain, guildConfig.overBidtoWinMain, duration);
                    const messageId = await logger.sendLongAuctionEmbed(guildConfig, auction, minBid, numberOfItems);
                    if (messageId) {
                        await manager.updateAuctionMessageId(guild.id, auction._id, messageId);
                    } else {
                        console.error('startlongbid: auction embed not posted (no long auction channel?)', guild.id, auction._id);
                        await safeReply(interaction, { content: 'Auction created but its embed could not be posted: check the long auction channel configuration.', flags: MessageFlags.Ephemeral });
                    }
                }
            } catch (error) {
                // Safe: after collector.stop() no further click can be collected, so
                // this can only re-open the window for a failure that created nothing.
                starting = false;
                console.error('startlongbid collect failed', error);
                await safeReply(interaction, { content: 'Failed to start the bid.', flags: MessageFlags.Ephemeral });
            }
        });
    },
    restricted: true
};