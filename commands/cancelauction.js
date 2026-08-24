require('dotenv').config()
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const log = require('../debugger.js');
const { isOfficer } = require('../utils/officerOnly.js');

// Voids a running long auction: no winner is picked and no DKP is taken.
//
// The bids stay in the document. An officer reads them back with /auctiondetails,
// and they are deliberately NOT republished in the channel - a voided auction is
// usually re-run, and reprinting what everyone bid the first time would hand the
// second round to whoever scrolls up.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('cancelauction')
        .setDescription('Void a running long auction: no winner, no DKP taken')
        .addStringOption(option => option.setName('auctionid').setDescription('The auction id, from the auction message').setRequired(true)),
    async execute(interaction, manager, logger) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const guild = interaction.guild.id;
        const auctionid = interaction.options.getString('auctionid').trim();
        // The fallback keeps the guild id, which is what everything downstream keys
        // on; a server with no config simply has no channel to repaint.
        const guildConfig = await manager.getGuildOptions(guild) || { guild };

        // Below deferReply on purpose. A gate that answers the interaction before it
        // makes the command's own deferReply throw InteractionAlreadyReplied.
        if (!isOfficer(interaction.member, guildConfig)) {
            await interaction.editReply({ content: '⛔ Only an officer can cancel an auction.' });
            return;
        }

        // ObjectId() throws a BSONError on anything that is not 24 hex characters,
        // which reaches the officer as the generic "something went wrong".
        if (!/^[0-9a-f]{24}$/i.test(auctionid)) {
            await interaction.editReply({ content: '⛔ That does not look like an auction id. Copy the **Auction ID** from the auction message (24 hex characters).' });
            return;
        }

        if (process.env.LOG_LEVEL === 'DEBUG') {
            log(`Executed cancelauction command`, {
                user: interaction.user.id,
                auctionid: auctionid,
            });
        }

        // null means the compare-and-swap matched nothing: either there is no such
        // auction here, or it is not running any more. Telling those apart costs one
        // extra read, and only on the path that is already about to refuse.
        const auction = await manager.cancelAuction(guild, auctionid, interaction.user.id);
        if (!auction) {
            const existing = await manager.getAuction(guild, auctionid).catch(() => null);
            if (!existing) {
                await interaction.editReply({ content: '⛔ No auction with that id in this server.' });
                return;
            }
            if (existing.cancelled) {
                await interaction.editReply({ content: '⛔ That auction was already cancelled.' });
                return;
            }

            await interaction.editReply({ content: '⛔ That auction is already closed - its winners are published and their DKP may already be taken. `/auctiondetails ' + auctionid + '` shows what happened, and /adddkp is how to give it back.' });
            return;
        }

        // Unconditional, unlike the debug line above: an officer destroying a live
        // auction is exactly what a log is for.
        log('Auction cancelled', {
            guild,
            auction: String(auction._id),
            item: auction.item?.name,
            by: interaction.user.id,
            bids: auction.bids?.length || 0,
        });

        // The repaint is a second, separate failure: the message may have been
        // deleted, or the bot may have lost the channel since. The auction is voided
        // either way, so the reply says which of the two happened rather than
        // reporting the whole command as failed.
        const repainted = await logger.updateLongAuctionCancelledEmbed(guildConfig, auction);
        const bids = auction.bids?.length || 0;
        const kept = bids
            ? bids + ' bid' + (bids > 1 ? 's' : '') + ' kept on record - `/auctiondetails ' + auction._id + '` reads them back.'
            : 'There were no bids.';
        const done = '✅ Auction cancelled on **' + auction.item?.name + '**. No winner, no DKP taken. ' + kept;
        await interaction.editReply({
            content: repainted
                ? done
                : done + '\n⚠️ The auction message could not be updated - it may still show the bid buttons. Say so in the channel yourself.',
        });
    },
    restricted: true,
};
