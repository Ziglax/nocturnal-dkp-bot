const { ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType, MessageFlags } = require('discord.js');
const Auctioner = require('../Auctioner/Auctioner');
const uniqid = require('uniqid');
const { safeReply, safeAck, guardListener } = require('./safe.js');

//list of discord colors
const colors = {
    red: 15105570,
    green: 3066993,
    blue: 3447003,
    yellow: 16776960,
    purple: 10181046,
    orange: 15105570
}


module.exports = class Logger {
    constructor(client) {
        this.client = client;
    }

    playerChunks(label, players, chunkSize = 15) {

        if (!players.length) {
            return [{
                name: label,
                value: 'No players',
                inline: true
            }]
        }

        const playerChunks = [];
        while (players.length) {
            playerChunks.push(players.splice(0, chunkSize));
        }

        const playerFields = playerChunks.map((chunk, index) => {
            const name = index == 0 ? label : '\u200B';
            return {
                name,
                value: chunk.join('\n'),
                inline: true
            }
        })

        return playerFields;
    }

    async sendRaidEmebed(guildOptions, raid, playersInChannel, color, title, dkps = null) {
        try {
            const discordGuild = await this.client.guilds.fetch(guildOptions.guild);
            const logChannel = discordGuild.channels.cache.get(guildOptions.logChannel);

            if (!logChannel) {
                return;
            }

            let players = (await Promise.all(playersInChannel.map(async p => {
                const player = await discordGuild.members.fetch(p).catch(() => null);
                if (!player) {
                    return null;
                }
                return `- ${player.nickname || player.user.globalName || player.user.username}`;
            }))).filter(Boolean);

            players = players.sort();

            const totalPlayers = players.length;
            const playerFields = this.playerChunks(`Players (${totalPlayers})`, players);

            try {
                await logChannel
                    .send({
                        embeds: [{
                            color: color,
                            title,
                            fields: [
                                { name: "Time", value: `<t:${Math.floor(new Date().getTime() / 1000)}:t>`, inline: true },
                                { name: "DKPs", value: dkps || raid.dkpsPerTick, inline: true },
                                { name: '\u200B', value: '\u200B' },
                                ...playerFields,
                            ],
                        }]
                    })
            } catch (e) {
                logChannel.send(':prohibited: ' + e).catch(err => console.error('[sendRaidEmebed] fallback send failed', err));
            }
        } catch (error) {
            console.error('[sendRaidEmebed]', error);
        }
    }

    async sendRaidEndEmbed(guildOptions, raid, log) {
        try {
            const discordGuild = await this.client.guilds.fetch(guildOptions.guild);
            const logChannel = discordGuild.channels.cache.get(guildOptions.logChannel);

            if (!logChannel) {
                return;
            }
            const now = new Date().getTime();

            const maxLogChunkSize = 35;
            const logChunks = [];
            while (log.length) {
                logChunks.push(log.splice(0, maxLogChunkSize));
            }

            for (const logChunk of logChunks) {
                const logIndex = logChunks.indexOf(logChunk);
                const title = `${raid.name} raid ended - *${logIndex + 1} of ${logChunks.length}*`;
                try {
                    await logChannel
                        .send({
                            embeds: [{
                                color: 15277667,
                                title: title,
                                description: logChunk.join('\n').slice(0, 4096),
                                fields: [
                                    { name: "Date", value: `<t:${Math.floor(now / 1000)}:d> <t:${Math.floor(now / 1000)}:t>`, inline: true },
                                    { name: "ID", value: raid._id, inline: true },
                                ]
                            }]
                        })
                } catch (e) {
                    console.error('[sendRaidEndEmbed] chunk send failed', logIndex + 1, e);
                }
            }
        } catch (error) {
            console.error('[sendRaidEndEmbed]', error);
        }
    }

    formatSeconds(seconds) {
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        return `${minutes > 0 ? minutes + 'm' : ''} ${remainingSeconds}s`;
    }

    itemsToButtonRows(items) {
        const buttons = items.map(item => new ButtonBuilder().setCustomId('selectitem_' + item.id).setLabel(item.name).setStyle(ButtonStyle.Secondary));
        const buttonGroups = [];
        while (buttons.length) {
            buttonGroups.push(buttons.splice(0, 5));
        }
        return buttonGroups.map(group => new ActionRowBuilder().addComponents(...group));
    }

    itemsToEmbededList(items) {
        return {
            title: 'Search Results',
            description: items.map(item => `#${item.id}${' '.repeat(10 - item.id.length)} ${item.name}${item.type ? ' - ' + item.type : ''}`).join('\n'),
        }
    }

    async sendItemEmbed(interaction, item, forAuction = true) {
        const row = new ActionRowBuilder();
        const button = new ButtonBuilder().setCustomId('startbid_' + item.id + '_' + uniqid()).setLabel('Start Auction').setStyle(ButtonStyle.Primary);
        row.addComponents(button);
        return interaction.editReply({
            embeds: [this.itemToEmbed(item)],
            components: forAuction ? [row] : []
        });
    }

    async itemsSearchToEmbed(interaction, items, forAuction = true) {
        let resolve;
        let reject;
        const result = new Promise((_resolve, _reject) => {
            resolve = _resolve;
            reject = _reject;
        });

        const rows = this.itemsToButtonRows(items);
        try {
            await interaction.editReply({
                content: 'Search Results',
                components: [...rows]
            });
        } catch (error) {
            console.error('[itemsSearchToEmbed] editReply failed', error);
            resolve();
            return result;
        }

        if (!interaction.channel) {
            console.error('[itemsSearchToEmbed] no channel on interaction');
            resolve();
            return result;
        }

        const collectorFilter = i => i.user.id === interaction.user.id;
        const collector = interaction.channel.createMessageComponentCollector({ componentType: ComponentType.Button, time: 30_000, filter: collectorFilter });
        collector.on('collect', guardListener('itemsSearchToEmbed collect', async i => {
            if (i.customId.startsWith('selectitem_')) {
                const itemId = i.customId.split('_')[1];
                resolve(itemId);
                i.deferUpdate().catch(() => {});
                collector.stop();
            }
        }));

        collector.on('end', async (_collected, reason) => {
            if (reason === 'time') {
                await interaction.editReply({ content: 'Time out', components: [] }).catch(() => {});
            }
            // Every other end reason (message or channel deleted, collector stopped)
            // must settle too: the caller awaits this before answering the command,
            // so a pending promise leaves the user on "thinking..." for good.
            resolve();
        });

        return result;
    };

    async sendLongAuctionEmbed(guildOptions, auction, minBid = 0, numberOfItems = 1) {
        const discordGuild = await this.client.guilds.fetch(guildOptions.guild);
        const channel = discordGuild.channels.cache.get(guildOptions.longAuctionChannel || guildOptions.auctionChannel);
        if (!channel) {
            console.error('[sendLongAuctionEmbed] no long auction channel configured for guild', guildOptions.guild);
            return;
        }

        let durationInMiliseconds = auction.auctionEnd - new Date().getTime();
        if (durationInMiliseconds < 0) {
            durationInMiliseconds = 0;
        }

        const embed = this.itemToEmbed(auction.item, colors.blue);

        embed.fields = [
            {
                name: 'Auction ID',
                value: "```" + auction._id + "```",
                inline: true
            },
            {
                name: 'Auction ends',
                value: `<t:${Math.floor(auction.auctionEnd / 1000)}:R>`,
                inline: true
            }
        ]
        const message = await channel.send({
            content: `Bid started - **${minBid} DKP** minimum bid. ${numberOfItems > 1 ? `Top **${numberOfItems}** bids win. Should end at <t:${Math.floor(auction.auctionEnd / 1000)}:f>` : ''}`,
            embeds: [embed]
        })
        //return embed identifier
        return message.id;
    }

    async updateLongAuctionEmbed(guildOptions, auction) {
        //using discordJS update the message embed fields
        const longAuctionChannel = guildOptions.longAuctionChannel || guildOptions.auctionChannel;
        const messageId = auction.messageId;
        if (!messageId) {
            console.log('No messageId found for auction');
            return;
        }
        const channel = await this.client.channels.cache.get(longAuctionChannel);
        try {
            const message = await channel.messages.fetch(messageId);
            const embed = this.itemToEmbed(auction.item, colors.green);
            embed.fields = [
                {
                    name: 'Auction ID',
                    value: "```" + auction._id + "```",
                    inline: true
                },
                {
                    name: 'Auction ends',
                    value: `<t:${Math.floor(auction.auctionEnd / 1000)}:R>`,
                    inline: true
                }
            ]

            embed.fields.push({
                name: 'Winner/s',
                value: auction.winners?.map(winner => `<@${winner.player}> - ${winner.amount} ${winner.bidForMain ? '' : 'Alt'}`).join('\n'),
                inline: false
            })

            embed.fields.push({
                name: 'Bids',
                value: auction.bids?.map(bid => `${bid.amount} ${bid.bidForMain ? '' : 'Alt'}`).join('\n'),
                inline: false
            })

            await message.edit({
                embeds: [embed]
            })
        } catch (e) {
            console.log(e);
            return false
        }
    }

    async sendAuctionStartEmbed(guildOptions, auction, minBid = 0, numberOfItems = 1) {
        const discordGuild = await this.client.guilds.fetch(guildOptions.guild);
        const channel = discordGuild.channels.cache.get(guildOptions.auctionChannel);

        const bidTime = guildOptions.bidTime;
        const officerRole = guildOptions.adminRole;
        if (!channel) {
            return;
        }

        const auctionEndTimestamp = Math.floor(new Date().getTime() / 1000) + bidTime;

        const button = new ButtonBuilder().setCustomId('bid_' + auction.id).setLabel('Main bid').setStyle(ButtonStyle.Primary);
        const buttonAlt = new ButtonBuilder().setCustomId('bid_alt' + auction.id).setLabel('Alt bid').setStyle(ButtonStyle.Secondary)
        const cancelButton = new ButtonBuilder().setCustomId('cancel_' + auction.id).setLabel('Cancel').setStyle(ButtonStyle.Danger);
        const row = new ActionRowBuilder().addComponents(button, buttonAlt, cancelButton);

        const embed = this.itemToEmbed(auction.item, 15105570);
        embed.fields = [
            {
                name: 'Auction ends',
                value: `<t:${auctionEndTimestamp}:R>`,
                inline: true
            },
        ]
        const message = await channel.send({
            content: `Bid started - **${minBid} DKP** minimum bid. ${numberOfItems > 1 ? `Top **${numberOfItems}** bids win` : ''}`,
            embeds: [embed],
            components: [row]
        })

        const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: bidTime * 1000 });
        // DM prompts opened from the bid buttons, all stopped when the auction collector ends
        // (a single listener for all of them, so raid-sized bidder counts never trip MaxListeners).
        // Keyed by bidder: a second click must replace the first prompt, not run beside it.
        // Two live collectors on the same DM channel both read the same message, so
        // "Main bid" then "Alt bid" then "50" used to register the bid twice
        // and the losing race decided whether it counted as MAIN or ALT.
        const dmCollectors = new Map();
        collector.once('end', () => {
            for (const dmCollector of dmCollectors.values()) {
                dmCollector.stop();
            }
        });
        collector.on('collect', guardListener('auction buttons', async i => {
            if (i.customId.startsWith('bid_')) {
                await safeAck(i);
                const forMain = !i.customId.startsWith('bid_alt');
                const user = i.user.id;
                let dmChannel;
                try {
                    dmChannel = await discordGuild.members.fetch(user).then(m => m.createDM());
                    await dmChannel.send({
                        content: `How much do you want to ${forMain ? '`MAIN`' : '`ALT`'} bid on ${auction.item.name}? Send 0 to remove your bid.`,
                    });
                } catch (e) {
                    // The button was already acknowledged with deferUpdate, so a follow-up is the
                    // only way to answer the user without overwriting the public auction message.
                    console.error('[auction buttons] could not DM bidder', user, e?.code || '', e?.message || e);
                    await i.followUp({ content: 'Failed to send DM, please open your DMs to bid.', flags: MessageFlags.Ephemeral }).catch(() => {});
                    return;
                }

                const dmCollector = dmChannel.createMessageCollector({ time: 60000, filter: m => m.author.id === user });
                dmCollector.on('collect', guardListener('auction dm', async m => {
                    const amount = parseInt(m.content);
                    if (Number.isNaN(amount)) {
                        await dmChannel.send('Please send a number. Send 0 to remove your bid.').catch(() => {});
                        return;
                    }
                    if (amount === 0) {
                        // Used to only close this prompt: the bid the player was
                        // withdrawing stayed in the auction, so "Bid cancelled" was a
                        // lie and they could still win the item and be debited.
                        try {
                            const removed = await Auctioner.instance.removeBid(guildOptions.guild, auction.id, user);
                            await dmChannel.send(removed ? 'Bid removed' : 'You had no bid to remove').catch(() => {});
                            dmCollector.stop();
                        } catch (e) {
                            await dmChannel.send(e.message).catch(() => {});
                        }
                        return;
                    }
                    try {
                        await Auctioner.instance.bid(guildOptions.guild, auction.id, amount, user, forMain);
                        await dmChannel.send('Bid placed').catch(() => {});
                        dmCollector.stop();
                    } catch (e) {
                        await dmChannel.send(e.message).catch(() => {});
                    }
                }));

                // Don't let a DM prompt outlive the auction it belongs to, and never let a
                // bidder hold two at once. The identity check keeps the superseded
                // collector's own 'end' from deleting its replacement.
                dmCollectors.get(user)?.stop();
                dmCollectors.set(user, dmCollector);
                dmCollector.once('end', () => {
                    if (dmCollectors.get(user) === dmCollector) {
                        dmCollectors.delete(user);
                    }
                });
            }

            if (i.customId.startsWith('cancel_')) {
                if (!i.member?.roles?.cache?.has(officerRole)) {
                    await safeReply(i, { content: ':Prohibited: You dont have permissions, what do you want your tombstone to say?', flags: MessageFlags.Ephemeral });
                    return;
                }
                await safeAck(i);
                const cancelled = await Auctioner.instance.cancelAuction(auction.id);
                if (!cancelled) {
                    // Auction already closed (or closing) through its timer: the deferUpdate above is a silent no-op,
                    // and the winners embed posted by the close callback must not be overwritten.
                    return;
                }
                cancelButton.setDisabled(true);
                cancelButton.setLabel('Auction Cancelled');
                const row = new ActionRowBuilder().addComponents(cancelButton);
                await message.edit({ embeds: [{ ...embed, color: colors.red }], components: [row] }).catch(e => console.error('[auction buttons] cancel edit failed', e));
                collector.stop();
            }
        }))

        return message;
    }

    playerListToEmbed(players, currentPlayer, currentPage = 0, pageSize = 10) {
        const space = ' ';
        const separatorLine = '\n-----------------------------------------\n';
        const separatorLine2 = '\n--------------------------\n';

        const playerNames = players.map((row, index) => {
            const position = (index + 1) + (currentPage * pageSize);
            return '| `' + position.toString().padStart(2, ' ') + '`: <@' + row.player + '>';
        });

        const playerData = players.map((row) => {
            const attendance = row.attendance + '%';
            return '| `' + row.current.toString().padStart(6, ' ') + ' ` |' + space.repeat(5) + '`' + attendance.padStart(4, ' ').padEnd(5, ' ').padStart(6, ' ') + '`' + space.repeat(5) + '|';
        });

        // Trailing block: the caller's own row, repeated under the page. A caller
        // with no DKP record simply does not get one.
        const currentPlayerAttendance = currentPlayer ? currentPlayer.attendance + '%' : '';
        const currentPlayerBlock = currentPlayer
            ? separatorLine + '| `' + currentPlayer.position.toString().padStart(2, ' ') + '`: <@' + currentPlayer.player + '>' + separatorLine
            : '';
        const currentPlayerDataBlock = currentPlayer
            ? separatorLine2 + '| `' + currentPlayer.current.toString().padStart(6, ' ') + ' ` |' + space.repeat(5) + '`' + currentPlayerAttendance.padStart(4, ' ').padEnd(5, ' ').padStart(6, ' ') + '`' + space.repeat(5) + '|' + separatorLine2
            : '';

        const columnOneHeader = '| # | **Player Name**' + separatorLine;
        const columnTwoHeader = '| ' + space.repeat(5) + '**DKP** ' + space.repeat(5) + '| **Attendance** |' + separatorLine2;

        return {
            color: 0x0099ff,
            fields: [
                {
                    name: '\u200B',
                    value: columnOneHeader + playerNames.join(separatorLine) + separatorLine + currentPlayerBlock,
                    inline: true
                },
                {
                    name: '\u200B',
                    value: columnTwoHeader + playerData.join(separatorLine2) + separatorLine2 + currentPlayerDataBlock,
                    inline: true
                }
            ]

        };

    }

    itemToEmbed(item, color = 3447003) {
        let separator = '--------------------------------------------------------\n';
        return {
            color,
            title: item.name + ' #' + item.id,
            description: separator + item.data,
            url: item.url,
            ...(item.image ? { thumbnail: { url: item.image } } : {}),
        }
    }
}