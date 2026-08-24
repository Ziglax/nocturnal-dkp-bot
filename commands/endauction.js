require('dotenv').config()
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const log = require('../debugger.js');
const { isOfficer } = require('../utils/officerOnly.js');
const { closeLongAuction } = require('../utils/auctionClose.js');

// Closes a running long auction now instead of at its end time.
//
// It is settled by the very code the worker runs - closeLongAuction - so the
// winners, the hand-down to the next bid when a winner cannot pay, the automatic
// debit and the recap are identical to a close that happened on its own. That
// sharing is the point: an early close must not be a second, slightly different
// implementation of the same rules.
//
// The lock delay is deliberately not honoured. An officer typing this has decided
// the auction is over, and making them wait another twenty minutes to see the
// outcome would leave them unable to tell a working command from a broken one.
// The cost: when a block of auctions is running side by side, this one's price
// becomes public while the others are still taking bids.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('endauction')
        .setDescription('Close a running long auction now and publish its results')
        .addStringOption(option => option.setName('auctionid').setDescription('The auction id, from the auction message').setRequired(true)),
    async execute(interaction, manager, logger) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const guild = interaction.guild.id;
        const auctionid = interaction.options.getString('auctionid').trim();
        // The fallback keeps the guild id, which is what closeLongAuction keys on; a
        // server with no config simply has no channel to repaint.
        const guildConfig = await manager.getGuildOptions(guild) || { guild };

        // Below deferReply on purpose. A gate that answers the interaction before it
        // makes the command's own deferReply throw InteractionAlreadyReplied.
        if (!isOfficer(interaction.member, guildConfig)) {
            await interaction.editReply({ content: '⛔ Only an officer can end an auction early.' });
            return;
        }

        // ObjectId() throws a BSONError on anything that is not 24 hex characters,
        // which reaches the officer as the generic "something went wrong".
        if (!/^[0-9a-f]{24}$/i.test(auctionid)) {
            await interaction.editReply({ content: '⛔ That does not look like an auction id. Copy the **Auction ID** from the auction message (24 hex characters).' });
            return;
        }

        if (process.env.LOG_LEVEL === 'DEBUG') {
            log(`Executed endauction command`, {
                user: interaction.user.id,
                auctionid: auctionid,
            });
        }

        const auction = await manager.getAuction(guild, auctionid).catch(error => {
            if (error?.message === 'Auction not found') {
                return null;
            }
            throw error;
        });
        if (!auction) {
            await interaction.editReply({ content: '⛔ No auction with that id in this server.' });
            return;
        }

        // Strict, like /auctiondetails: a document that somehow lacks the field is
        // treated as running rather than finished, because closing an auction twice
        // is the expensive mistake and endAuction refuses it anyway.
        if (auction.auctionActive !== true) {
            await interaction.editReply({
                content: auction.cancelled
                    ? '⛔ That auction was cancelled. It cannot be closed - start a new one with /startlongbid.'
                    : '⛔ That auction is already closed. `/auctiondetails ' + auctionid + '` shows its results.',
            });
            return;
        }

        // closeLongAuction throws when the auction stopped being active between the
        // read above and its own compare-and-swap: the worker's minute tick got there
        // first, or somebody cancelled it. It can also throw halfway through, after
        // the auction is already closed - which is why the wording below never
        // promises that nothing happened.
        const closed = await closeLongAuction(manager, logger, guildConfig, auction).catch(error => {
            console.error('[endauction] close failed', auctionid, error);
            return { error };
        });
        if (closed.error) {
            const message = closed.error?.message;
            await interaction.editReply({
                content: message === 'Auction not active' || message === 'Auction not found'
                    ? '⛔ That auction closed while this command was running - the bot got there first, or somebody cancelled it. `/auctiondetails ' + auctionid + '` shows what happened.'
                    : '⛔ The auction could not be closed: ' + (message || 'unknown error') + '. Check `/auctiondetails ' + auctionid + '` before retrying - it may have closed before the failure.',
            });
            return;
        }

        // Unconditional: an early close is an officer decision that changed who owns
        // an item, and closeLongAuction's own 'Auction ended' line does not say who
        // asked for it.
        log('Auction ended by officer', {
            guild,
            auction: auctionid,
            item: auction.item?.name,
            by: interaction.user.id,
        });

        const winners = closed.winners || [];
        const result = winners.length
            ? winners.map(winner => '<@' + winner.player + '> - ' + winner.amount + (winner.bidForMain ? '' : ' Alt')).join('\n')
            : 'No winner - nobody could bid on it.';
        await interaction.editReply({
            content: '✅ Auction closed on **' + auction.item?.name + '**. The results are now public in the auction channel.\n' + result,
            // The bot writes the mentions, so without this it pings every winner a
            // second time.
            allowedMentions: { parse: [] },
        });
    },
    restricted: true,
};
