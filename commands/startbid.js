const { SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType, MessageFlags } = require('discord.js');
const ItemSearch = require('../search/ItemSearch');
const Auctioner = require('../Auctioner/Auctioner');
const { playSound } = require('../utils/Player.js');
const log = require('../debugger.js');
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
        .setName('startbid')
        .setDescription('start a bid for an item')
        .addStringOption(option => option.setName('search').setDescription('Item name or id').setRequired(true))
        .addIntegerOption(option => option.setName('minbid').setDescription('Minimum bid').setMinValue(0).setRequired(false))
        .addIntegerOption(option => option.setName('numitems').setDescription('Number of items').setMinValue(1).setRequired(false))
        .addStringOption(option => option.setName('database').setDescription('quarm | takp').setRequired(false)),
    async execute(interaction, manager, logger) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const guild = interaction.guild;
        const guildConfig = await manager.getGuildOptions(interaction.guild.id) || {};
        const raidChannel = guildConfig.raidChannel;
        const secondRaidChannel = guildConfig.secondRaidChannel;
        const search = interaction.options.getString('search');

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
                    const officerRole = guildConfig.adminRole;
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

                    let message;
                    const callback = async (auction) => {
                        if (!message) {
                            console.error('auction ended before message existed', auction.id);
                            return;
                        }
                        try {
                            const embed = logger.itemToEmbed(auction.item, 5763719);
                            const row = new ActionRowBuilder();
                            const confirmButton = new ButtonBuilder().setCustomId('confirm_' + auction.id).setLabel('Confirm Winner/s').setStyle(ButtonStyle.Primary);
                            row.addComponents(confirmButton);
                            embed.fields = [
                                { name: 'Winner/s', value: winnerMessage(auction) },
                                { name: 'Bids', value: auction.bids.sort((a, b) => b.amount - a.amount).map(bid => `- ${bid.amount}${bid.bidForMain ? '' : ' - alter'}`).join('\n') },
                                {
                                    name: 'Auction ID',
                                    value: "```" + auction._id + "```",
                                },
                            ];

                            await message.edit({
                                embeds: [embed],
                                components: auction.winner || auction.winners.length ? [row] : []
                            });

                            if (auction.winner || auction.winners.length > 0) {
                                const collectorFilter = i => i.user.id === interaction.user.id; //|| i.member.roles.cache.has(officerRole);
                                const confirmWinCollector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: 360_000, filter: collectorFilter });
                                confirmWinCollector.on('collect', async i => {
                                    let current = null; // winner being debited, for the failure log
                                    try {
                                        if (i.customId.startsWith('confirm_' + auction.id)) {
                                            confirmWinCollector.stop();
                                            confirmButton.setDisabled(true);
                                            confirmButton.setLabel('Winner/s Confirmed').setStyle(ButtonStyle.Success);
                                            await safeAck(i);
                                            await message.edit({
                                                components: [row]
                                            }).catch(e => console.error(e));

                                            const raid = await manager.getActiveRaid(guild.id);
                                            if (auction.winner) {
                                                current = auction.winner;
                                                await manager.removeDKP(guild.id, auction.winner.player, auction.winner.amount, auction.item.name, raid, auction.item);
                                                if (process.env.LOG_LEVEL === 'DEBUG') {
                                                    log('Removing dkps from winer', {
                                                        player: auction.winner.player,
                                                        amount: auction.winner.amount,
                                                        item: auction.item.name
                                                    });
                                                }
                                            }
                                            else {
                                                for (const winner of auction.winners) {
                                                    current = winner;
                                                    await manager.removeDKP(guild.id, winner.player, winner.amount, auction.item.name, raid, auction.item);
                                                    if (process.env.LOG_LEVEL === 'DEBUG') {
                                                        log('Removing dkps from winer', {
                                                            player: winner.player,
                                                            amount: winner.amount,
                                                            item: auction.item.name
                                                        });
                                                    }
                                                }
                                            }
                                        }
                                    } catch (error) {
                                        console.error('confirm winners failed', auction.id, current ? `while debiting ${current.player} (${current.amount} DKP)` : '(before any debit)', error);
                                        // Keep the button disabled so a re-click cannot double-debit winners already written.
                                        confirmButton.setLabel('Confirm failed - see logs').setStyle(ButtonStyle.Danger);
                                        await message.edit({
                                            content: 'Failed to remove DKP from winner/s, check the logs.',
                                            components: [row]
                                        }).catch(e => console.error(e));
                                    }
                                });

                                confirmWinCollector.on('end', async (_collected, reason) => {
                                    confirmButton.setDisabled(true);
                                    if (reason === 'time') {
                                        confirmButton.setLabel('Time for confirmation ended').setStyle(ButtonStyle.Success);
                                        try {
                                            await message.edit({
                                                components: [row]
                                            });
                                        }
                                        catch (e) {
                                            console.log(e);
                                        }
                                    }
                                });
                            }
                        } catch (error) {
                            console.error('auction end callback failed', auction?.id, error);
                        }
                    };

                    const bidTime = guildConfig.bidTime;
                    const startedAuction = await Auctioner.instance.startAuction(
                        item,
                        guild.id,
                        callback,
                        {
                            minBid,
                            duration: bidTime * 1000,
                            numberOfItems,
                            minBidToLockForMain: guildConfig.minBidToLockForMain,
                            overBidtoWinMain: guildConfig.overBidtoWinMain,
                            checkAttendance: false
                        }
                    );
                    message = await logger.sendAuctionStartEmbed(guildConfig, startedAuction, minBid, numberOfItems);

                    if (raidChannel) {
                        try {
                            await playSound(guild, raidChannel, '../assets/bell.mp3');
                        } catch (e) {
                            console.error('bell failed', e);
                        }
                    }
                    if (secondRaidChannel) {
                        try {
                            await playSound(guild, secondRaidChannel, '../assets/bell.mp3');
                        } catch (e) {
                            console.error('bell failed', e);
                        }
                    }
                }
            } catch (error) {
                // The latch only guards the early-return paths above: by the time
                // anything past collector.stop() can throw, no further click can be
                // collected, so releasing it here cannot let a second auction through.
                // It does not mean nothing was created -- a throw after the auction
                // exists leaves it live, which the message below does not say.
                starting = false;
                console.error('startbid collect failed', error);
                await safeReply(interaction, { content: 'Failed to start the bid.', flags: MessageFlags.Ephemeral });
            }
        });
    },
    restricted: true
};