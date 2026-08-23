const { ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
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
        collector.on('collect', guardListener('auction buttons', async i => {
            if (i.customId.startsWith('bid_')) {
                const forMain = !i.customId.startsWith('bid_alt');

                // The amount is collected by a modal rather than by a DM prompt, so it
                // arrives on an interaction that belongs to this auction and this button.
                // DM prompts could not tell auctions apart: every live prompt sat on the
                // same DM channel and MessageCollector only filters on channelId, so one
                // number typed with two prompts open was registered on both items - and
                // "0" withdrew from both. The modal also lets players with closed DMs bid.
                // A fresh id per click keeps two modals from ever answering each other.
                const modalId = 'bidmodal_' + uniqid();
                const modal = new ModalBuilder()
                    .setCustomId(modalId)
                    .setTitle(`Bid on ${auction.item.name}`.slice(0, 45))
                    .addComponents(new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('amount')
                            .setLabel(`${forMain ? 'MAIN' : 'ALT'} bid amount in DKP`)
                            .setPlaceholder('Enter 0 to remove your bid')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                            .setMaxLength(10)
                    ));

                try {
                    // A modal must be the first response to the interaction, so this path
                    // must not defer or acknowledge it beforehand.
                    await i.showModal(modal);
                } catch (e) {
                    console.error('[auction buttons] could not open the bid modal', i.user.id, e?.code || '', e?.message || e);
                    return;
                }

                // Bounded by what is left of the auction: an answer that arrives after the
                // close has nothing to bid on. A dismissed modal rejects here and is not an
                // error, so it resolves to null and the click is simply dropped.
                const submitted = await i.awaitModalSubmit({
                    time: Math.max(5000, Math.min(auctionEndTimestamp * 1000 - Date.now(), 15 * 60 * 1000)),
                    filter: m => m.customId === modalId && m.user.id === i.user.id,
                }).catch(() => null);
                if (!submitted) {
                    return;
                }

                const raw = submitted.fields.getTextInputValue('amount').trim();
                // Deliberately stricter than parseInt, which silently read "50abc" as 50.
                const amount = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
                if (Number.isNaN(amount)) {
                    await safeReply(submitted, { content: `\`${raw}\` is not a number. Bid again with a whole number of DKP, or 0 to remove your bid.`, flags: MessageFlags.Ephemeral });
                    return;
                }

                try {
                    if (amount === 0) {
                        const removed = await Auctioner.instance.removeBid(guildOptions.guild, auction.id, i.user.id);
                        await safeReply(submitted, { content: removed ? `Bid removed on **${auction.item.name}**` : `You had no bid to remove on **${auction.item.name}**`, flags: MessageFlags.Ephemeral });
                        return;
                    }
                    await Auctioner.instance.bid(guildOptions.guild, auction.id, amount, i.user.id, forMain);
                    // Name the item and the side: a bidder juggling several auctions at once
                    // could not tell which one an unqualified "Bid placed" answered.
                    await safeReply(submitted, { content: `${forMain ? 'MAIN' : 'ALT'} bid of **${amount} DKP** placed on **${auction.item.name}**`, flags: MessageFlags.Ephemeral });
                } catch (e) {
                    await safeReply(submitted, { content: e.message, flags: MessageFlags.Ephemeral });
                }
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