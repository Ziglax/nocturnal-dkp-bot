const { ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const Auctioner = require('../Auctioner/Auctioner');
const uniqid = require('uniqid');
const { safeReply, safeAck, guardListener } = require('./safe.js');
const { lockDelayOf } = require('./auctionDebit.js');
const { openBidModal, closeBidModal, auctionOverMessage, bidErrorMessage } = require('./bidModals.js');

//list of discord colors
const colors = {
    red: 15158332,
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

    // Discord rejects an embed field longer than 1024 characters, and it rejects the
    // whole message with it. That matters most on a long auction: removing its bid
    // buttons is part of the same edit, so a bid list grown past the limit over
    // several days would leave the buttons sitting on a closed auction.
    // An empty value is accepted and renders as a blank field, so the fallback text
    // is cosmetic - it just keeps a bidless auction from looking half-written.
    embedFieldValue(lines, empty = 'None') {
        if (!lines?.length) {
            return empty;
        }

        const kept = [];
        let length = 0;
        for (const line of lines) {
            // Keep room for the line that stands in for whatever does not fit.
            if (length + line.length + 1 > 990) {
                kept.push(`... and ${lines.length - kept.length} more`);
                break;
            }
            kept.push(line);
            length += line.length + 1;
        }
        return kept.join('\n');
    }

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
        // Same two buttons as a short auction, so a bidder does not have to learn a
        // second way to bid. They cannot be driven by a message collector like the
        // short-auction ones: a long auction runs for days and survives a restart,
        // which a collector does not. index.js routes them by custom id instead, so
        // the id has to carry everything the handler needs - the side and the
        // auction. ObjectId is hex, so it never collides with the underscores.
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`lbid_main_${auction._id}`).setLabel('Main bid').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`lbid_alt_${auction._id}`).setLabel('Alt bid').setStyle(ButtonStyle.Secondary),
        );

        // Built as sentences rather than one template so an omitted one does not leave
        // a double space behind. Bidders see the end time on the embed, so the wait
        // between that time and the results being posted has to be advertised too -
        // otherwise a block of offline auctions looks stuck for twenty minutes.
        const lockDelay = lockDelayOf(auction);
        const sentences = [`Bid started - **${minBid} DKP** minimum bid.`];
        if (numberOfItems > 1) {
            sentences.push(`Top **${numberOfItems}** bids win. Should end at <t:${Math.floor(auction.auctionEnd / 1000)}:f>`);
        }
        if (lockDelay > 0) {
            sentences.push(`Results are posted about **${Math.round(lockDelay / 60000)} minutes** after the end.`);
        }

        const message = await channel.send({
            content: sentences.join(' '),
            embeds: [embed],
            components: [row]
        })
        //return embed identifier
        return message.id;
    }

    // debitReport is what debitAuctionWinners just returned, or null when nothing was
    // attempted on this pass. It only refines the wording of a line: whether a winner
    // was actually taken is read from auction.debitedPlayers, which the caller refreshes
    // from the database first. A debit that failed and handed its claim back shows up
    // in nothing else.
    async updateLongAuctionEmbed(guildOptions, auction, debitReport = null) {
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
                    name: 'Auction ended',
                    value: `<t:${Math.floor(auction.auctionEnd / 1000)}:f>`,
                    inline: true
                }
            ]

            embed.fields.push({
                name: 'Winner/s',
                value: this.embedFieldValue(auction.winners?.map(winner => `<@${winner.player}> - ${winner.amount} ${winner.bidForMain ? '' : 'Alt'}`), 'No winner'),
                inline: false
            })

            embed.fields.push({
                name: 'Bids',
                value: this.embedFieldValue(auction.bids?.map(bid => `${bid.amount} ${bid.bidForMain ? '' : 'Alt'}`), 'No bids'),
                inline: false
            })

            // Whether the winners paid is the one thing the recap could not say before,
            // and an officer had to go and check /dkphistory by hand.
            const winners = auction.winners || [];
            const debited = new Set(auction.debitedPlayers || []);
            const reportByPlayer = new Map((debitReport || []).map(entry => [entry.player, entry]));
            // A bid whose owner could not pay for it at debit time is not a winner
            // any more, so mapping over the winners would lose it. Saying so is the
            // only trace left of a name this very message announced minutes ago.
            const skipped = (debitReport || []).filter(entry => entry.status === 'skipped');
            if (winners.length || skipped.length) {
                const dkpLines = winners.map((winner) => {
                    if (debited.has(winner.player)) {
                        return `:white_check_mark: <@${winner.player}> - ${winner.amount} DKP taken`;
                    }
                    // No claim on the auction means nothing was taken, whatever the
                    // reason. The report only says which reason to print.
                    const status = reportByPlayer.get(winner.player)?.status;
                    if (status === 'insufficient') {
                        return `:warning: <@${winner.player}> - ${winner.amount} DKP NOT taken, balance too low`;
                    }
                    if (status === 'error') {
                        return `:warning: <@${winner.player}> - ${winner.amount} DKP NOT taken, the write failed`;
                    }
                    return `:warning: <@${winner.player}> - ${winner.amount} DKP NOT taken, an officer must confirm`;
                });
                for (const entry of skipped) {
                    dkpLines.push(`:arrow_down: <@${entry.player}> - ${entry.amount} DKP bid skipped, balance too low`);
                }
                embed.fields.push({
                    name: 'DKP',
                    value: this.embedFieldValue(dkpLines),
                    inline: false
                })
            }

            // Clearing the components is what retires the bid buttons: they are not
            // owned by a collector that could expire on its own. A winner still owing
            // DKP gets a Confirm in their place - the auction was started with autodebit
            // off, or its automatic debit could not go through. Pressing it is safe to
            // repeat: the debit is claimed on the auction, so a winner already taken is
            // skipped.
            const components = winners.some(winner => !debited.has(winner.player))
                ? [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`lconfirm_${auction._id}`).setLabel('Confirm DKP').setStyle(ButtonStyle.Success),
                )]
                : [];

            // content, like the embed, has to stop describing a running auction. It is
            // the only part of the post that reaches the channel list and a reply quote,
            // and left alone it went on reading 'Bid started - 50 DKP minimum bid. Should
            // end at <a date now days past>. Results are posted about 20 minutes after
            // the end.' above an embed that already names the winners.
            await message.edit({
                content: `Auction ended on **${auction.item.name}**`,
                embeds: [embed],
                components
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

        const embed = this.itemToEmbed(auction.item, colors.orange);
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

                // Deliberately not bounded by what is left of the auction any more.
                // Discord keeps the form open for 15 minutes whatever this collector
                // does, so giving up at the close left the submission with nobody to
                // answer it: Discord put its own "Something went wrong. Try again." over
                // a form the player could not get past, and never told them the auction
                // was over. Waiting the full window means a late answer is received and
                // answered. A dismissed modal rejects here and is not an error, so it
                // resolves to null and the click is simply dropped.
                openBidModal(modalId);
                const submitted = await i.awaitModalSubmit({
                    time: 15 * 60 * 1000,
                    filter: m => m.customId === modalId && m.user.id === i.user.id,
                }).catch(() => null).finally(() => closeBidModal(modalId));
                if (!submitted) {
                    return;
                }

                // Ahead of the parse: once the auction is over the amount is beside the
                // point, and this can name the item where Auctioner, which drops a closed
                // auction from its list, would only be able to say 'Auction not found'.
                if (!auction.auctionActive) {
                    // An officer pulling the auction and the timer running out are the same
                    // state to this guard, and 'ended' reads as 'it ran its course and
                    // somebody won' - a bidder cancelled ten seconds into a five-minute
                    // auction concluded they had simply typed too slowly.
                    await safeReply(submitted, { content: auctionOverMessage(auction.item.name, auction.cancelled), flags: MessageFlags.Ephemeral });
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
                    // The auction can still close between the guard above and the call,
                    // and then Auctioner refuses in its own words - which mean nothing to
                    // a player. bidErrorMessage says the same thing as the guard.
                    //
                    // The flag is read here and not carried down from the guard, because
                    // the guard passed while the auction was still running: the window
                    // that matters opens after it, inside the getPlayer round trip
                    // Auctioner.bid awaits. A Cancel landing there used to be reported to
                    // the bidder as the auction having ended. The withdrawal above has no
                    // such window - nothing between the guard and it suspends - so this
                    // only ever matters for the bid.
                    await safeReply(submitted, { content: bidErrorMessage(e, auction.item.name, auction.cancelled), flags: MessageFlags.Ephemeral });
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
                    // Auction already closed (or closing) through its timer: the winners embed
                    // posted by the close callback must not be overwritten. followUp, never
                    // safeReply: safeAck already deferred this, and a deferred component
                    // interaction routes to editReply, which would replace that winners embed
                    // with a bare line of text in public.
                    await i.followUp({
                        content: `That auction on **${auction.item.name}** is already over, so there was nothing to cancel. If the message names winners, press **Confirm Winner/s** as usual.`,
                        flags: MessageFlags.Ephemeral
                    }).catch(e => console.error('[auction buttons] cancel race notice failed', e?.code || '', e?.message || e));
                    return;
                }
                cancelButton.setDisabled(true);
                cancelButton.setLabel('Auction Cancelled');
                const row = new ActionRowBuilder().addComponents(cancelButton);
                // fields is rewritten rather than carried over: the spread is shallow, so
                // reusing it left the running auction's 'Auction ends' value on the message -
                // `<t:...:R>`, the one Discord style the client re-renders on a timer, so a
                // cancelled auction went on counting for ever. It also pointed at the
                // scheduled end, so a cancel twenty seconds in first read 'in 2 minutes'.
                // Both replacements are fixed styles, and `:f` is what this file already uses.
                const cancelledAt = Math.floor(new Date().getTime() / 1000);
                const cancelledEmbed = {
                    ...embed,
                    color: colors.red,
                    fields: [
                        { name: 'Cancelled at', value: `<t:${cancelledAt}:f>`, inline: true },
                        // A mention inside an embed resolves but never notifies. Nothing else
                        // records who pulled it: a cancelled auction is not stored.
                        { name: 'Cancelled by', value: `<@${i.user.id}>`, inline: true }
                    ]
                };
                // content is passed explicitly because it is the only part of the message that
                // reaches the channel list and a reply quote, where the embed does not exist.
                // Left out, it went on saying 'Bid started' under a cancelled auction.
                const edited = await message.edit({
                    content: `Bid cancelled on **${auction.item.name}** - no winner, no DKP taken`,
                    embeds: [cancelledEmbed],
                    components: [row]
                }).then(() => true).catch(e => { console.error('[auction buttons] cancel edit failed', e); return false; });
                collector.stop();
                if (!edited) {
                    // The auction is dead either way, but the post still shows a countdown and
                    // three bid buttons that now answer to nobody, so say so rather than
                    // leaving the officer with the silence deferUpdate gives them.
                    await i.followUp({
                        content: `**${auction.item.name}** is cancelled - no winner, no DKP taken - but the post could not be updated, so it still shows a countdown and the bid buttons. Ignore them, or delete the message.`,
                        flags: MessageFlags.Ephemeral
                    }).catch(e => console.error('[auction buttons] cancel edit notice failed', e?.code || '', e?.message || e));
                }
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