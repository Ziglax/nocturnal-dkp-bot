/**
 * Debiting the winners of a long auction.
 *
 * Two callers share this: the worker, when the auction was started with autodebit
 * on, and the Confirm button, when it was not. Keeping the rule in one place is
 * what lets the two of them race without ever taking a winner's DKP twice.
 */

// How long a finished auction keeps its results hidden before the bot closes it
// and publishes the winners. It is not a grace period: blocks of offline auctions
// are run side by side, and revealing the first results while the last auctions
// are still open would tell the remaining bidders exactly what to bid. Per-auction
// now, set by /startlongbid's lockdelay option; this is the value auctions started
// without one get, and the value auctions created before the option existed keep.
const DEFAULT_LOCK_DELAY = 20 * 60 * 1000;

const lockDelayOf = (auction) => (typeof auction?.lockDelay === 'number' ? auction.lockDelay : DEFAULT_LOCK_DELAY);

// Only an explicit true switches the automatic debit on. An auction document
// written before the option existed has no autoDebit field, and it was started
// under the old rule where an officer removed the DKP by hand - so it has to keep
// being handled by hand.
const autoDebitOf = (auction) => auction?.autoDebit === true;

/**
 * Takes one winner's DKP, once and only once.
 *
 * The claim goes in first. debitedPlayers is the auction's own record of who has
 * already been taken, and $addToSet behind a `debitedPlayers: {$ne: player}` filter
 * is a single atomic update: of two callers racing over the same winner - the
 * worker's automatic debit landing on the same tick as an officer's Confirm, or two
 * overlapping worker ticks - exactly one is told it claimed the winner, and only
 * that one writes DKP.
 *
 * A claim whose debit then fails is handed back, so Confirm can be pressed again
 * once the balance is there. That is the one ordering that can misreport: if the
 * winning claimant fails and releases while the loser is still reading, the loser
 * reports "already settled" for a winner nobody debited. Callers therefore render
 * the recap from a fresh read of debitedPlayers, never from this status alone.
 *
 * Returns { player, amount, status } where status is one of:
 *   debited      - the DKP were taken, `current` carries the new balance
 *   already      - somebody else had already claimed this winner
 *   insufficient - the balance could not cover the bid, nothing was written
 */
const debitAuctionWinner = async (manager, guild, auction, winner, raid) => {
    const claimed = await manager.claimAuctionDebit(guild, auction._id, winner.player);
    if (!claimed) {
        return { player: winner.player, amount: winner.amount, status: 'already' };
    }

    let updated;
    try {
        updated = await manager.removeDKP(guild, winner.player, winner.amount, auction.item?.name, raid, auction.item);
    } catch (error) {
        await manager.releaseAuctionDebit(guild, auction._id, winner.player).catch(e => console.error('[auction debit] could not release the claim', auction._id, winner.player, e?.message || e));
        throw error;
    }

    if (!updated) {
        // removeDKP refuses a debit the balance cannot cover, and refusing writes
        // nothing. The bid was checked against a balance read when it was placed,
        // and days can pass before a long auction closes.
        await manager.releaseAuctionDebit(guild, auction._id, winner.player).catch(e => console.error('[auction debit] could not release the claim', auction._id, winner.player, e?.message || e));
        return { player: winner.player, amount: winner.amount, status: 'insufficient' };
    }

    return { player: winner.player, amount: winner.amount, status: 'debited', current: updated.current };
};

/**
 * Same, for every winner of an auction. One winner failing does not stop the next:
 * the recap has to be able to say which of them were taken and which were not.
 * A thrown debit becomes status 'error' rather than aborting the run.
 */
const debitAuctionWinners = async (manager, guild, auction, winners, raid) => {
    const report = [];
    for (const winner of winners) {
        try {
            report.push(await debitAuctionWinner(manager, guild, auction, winner, raid));
        } catch (error) {
            console.error('[auction debit] debit failed', auction._id, winner.player, error?.message || error);
            report.push({ player: winner.player, amount: winner.amount, status: 'error' });
        }
    }
    return report;
};

module.exports = { DEFAULT_LOCK_DELAY, lockDelayOf, autoDebitOf, debitAuctionWinner, debitAuctionWinners };
