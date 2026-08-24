const Auction = require('../Auctioner/Auction.js');
const log = require('../debugger.js');
const { autoDebitOf, debitAuctionWinners, beginSettlement, endSettlement } = require('./auctionDebit.js');
const { settleAuctionWinners, skippedEntries } = require('./auctionReassign.js');

/**
 * Closing one long auction: pick the winners, close it, take the DKP, repaint the post.
 *
 * Two callers: the worker, once an auction's end time and its lock delay have both
 * passed, and /endauction, when an officer closes one early. Extracted rather than
 * copied so an early close is settled by exactly the same code as a normal one - the
 * hand-down to the next bid, the settlement lock and the recap are the three things
 * there must never be a second, slightly different version of.
 *
 * Throws whatever endAuction throws when the auction is no longer open, so a caller
 * that lost the race to another tick or to /cancelauction says so instead of settling
 * an auction it does not own.
 */
const closeLongAuction = async (manager, logger, guildOptions, auctionData) => {
    //instantaite a new auction from ../Auctioner/Auction.js
    const auction = new Auction(auctionData.guild, auctionData.item, auctionData.minBid, auctionData.numberOfItems, auctionData.minBidToLockForMain, auctionData.overBidtoWinMain);
    auction.bids = auctionData.bids;
    // A bidder who left / was never registered is dropped; any other error (DB down) aborts this
    // auction's close so it is retried next cycle instead of closing with a wrong winner.
    const players = (await Promise.all(auction.bids.map(bid => manager.getPlayer(auctionData.guild, bid.player, false).catch(e => {
        if (e?.message === 'Player not found') return null;
        throw e;
    })))).filter(Boolean);
    const w = auction.calculateWinner(players);
    auctionData.winners = [];
    if (w) {
        auctionData.winners = w.length ? w : [w];
    }
    await manager.endAuction(guildOptions.guild, auctionData._id, auctionData.winners);
    // Logged below the close, not above it: endAuction is a compare-and-swap now and
    // throws when another tick or /cancelauction got there first, and logging first
    // wrote an 'Auction ended' line for every one of those. The id goes on the line for
    // the same reason - two auctions on the same item are otherwise the same line.
    log('Auction ended', {
        guild: auctionData.guild,
        auction: String(auctionData._id),
        item: auctionData.item.name,
        winners: auctionData.winners,
    });

    // endAuction is what makes the debit legal: claimAuctionDebit only
    // matches an auction that is already closed, so nothing can be taken
    // from a winner while the auction could still change.
    let debitReport = null;
    // Belt and braces next to the per-guild reentrance guard: this is the
    // same lock an officer's Confirm takes, so an automatic debit and a
    // manual one can never settle the same auction side by side.
    if (autoDebitOf(auctionData) && auctionData.winners.length && beginSettlement(auctionData._id)) {
        try {
            // Whatever raid is running right now, which is the raid a manual
            // /removedkp would have logged the debit against. Usually none:
            // a long auction closes days after the raid it came from.
            const raid = await manager.getActiveRaid(guildOptions.guild).catch((e) => {
                console.error('[auction close] active raid lookup failed for an auction debit', auctionData._id, e?.message || e);
                return null;
            });
            // A winner who cannot cover their bid loses the item to the next
            // bid down. auction.bids is the list calculateWinner already
            // pruned, so only bids that were valid at the close are offered.
            const settled = await settleAuctionWinners({
                winners: auctionData.winners,
                bids: auction.bids,
                rules: auction,
                debit: winner => debitAuctionWinners(manager, guildOptions.guild, auctionData, [winner], raid).then(([entry]) => entry),
            });
            debitReport = settled.report.concat(skippedEntries(settled.skipped));
            if (settled.changed) {
                auctionData.winners = settled.winners;
                await manager.setAuctionWinners(guildOptions.guild, auctionData._id, settled.winners)
                    .catch(e => console.error('[auction close] could not record the new auction winner/s', auctionData._id, e?.message || e));
            }
        } finally {
            endSettlement(auctionData._id);
        }
    }

    // The recap names who was debited, and it has to read that back from
    // the auction rather than trust the report above: a debit that failed
    // and handed its claim back between the two shows up only here.
    auctionData.debitedPlayers = await manager.getAuction(guildOptions.guild, auctionData._id)
        .then(fresh => fresh.debitedPlayers || [])
        .catch((e) => {
            console.error('[auction close] could not re-read the auction for its recap', auctionData._id, e?.message || e);
            return auctionData.debitedPlayers || [];
        });
    await logger.updateLongAuctionEmbed(guildOptions, auctionData, debitReport);

    // For /endauction, which has an officer waiting on an answer. The worker throws it
    // away: its recap is the auction post.
    return { winners: auctionData.winners, debitReport };
};

module.exports = { closeLongAuction };
