/**
 * Handing an item to the next bidder when the winner cannot pay for it.
 *
 * The balance behind a bid is already checked twice: when the bid is placed, and
 * again when the auction closes, where calculateWinner drops every bid the bidder
 * can no longer cover so the item goes down the list on its own. Neither check
 * covers the gap between the close and the debit - up to six minutes for a short
 * auction, waiting on the officer's Confirm, and days for a long one started with
 * autodebit off. A win settled in that gap left the announced winner unable to pay
 * and the item unsold: the bot said "not debited, balance too low" and stopped
 * there, with the runner-up getting nothing.
 *
 * This runs the debit, and when it comes back refused for want of DKP, picks the
 * next winner under the same rules the auction was closed with and tries again.
 *
 * Deliberately free of dependencies - no discord.js, no database, no Auction. The
 * rules come in as an object exposing getWinners(bids, count) (an Auction, in
 * practice) and the debit as a function, which is what lets both the short and the
 * long auction path share this, and what lets it be tested on its own.
 */

/**
 * The next best bid, chosen exactly the way the winners themselves were: main/alt
 * lock, the overbid rule, and a random draw between equal amounts. Bidders already
 * holding an item and those already refused are out, which is what makes the loop
 * below terminate - every round takes one more name out of the running.
 *
 * The balance is not pre-checked here. The debit is the authority on it, and
 * asking first would only add a read that can go stale before the write.
 */
const nextBestBid = (bids, excluded, rules) => {
    const candidates = (bids || []).filter(bid => (
        bid
        && !excluded.has(bid.player)
        && Number.isInteger(bid.amount)
        && bid.amount > 0
        && bid.amount >= (rules.minBid || 0)
    ));

    if (!candidates.length) {
        return null;
    }

    const [bid] = rules.getWinners(candidates, 1);
    return bid || null;
};

/**
 * Debits every winner, replacing the ones whose balance will not cover their bid.
 *
 * debit(winner) must resolve to an entry carrying a `status`, one of the four
 * auctionDebit.js returns: 'debited', 'already', 'insufficient' or 'error'. Only
 * 'insufficient' hands the item on - 'error' means the write itself did not go
 * through, and a database hiccup must not cost somebody an item they won.
 *
 * A winner nobody can replace keeps the item, exactly as before: they end up in the
 * report as not debited, for an officer to settle by hand.
 *
 * Returns { winners, report, skipped, changed }:
 *   winners - the corrected list, in the same slot order as the one passed in
 *   report  - one entry per slot, the debit that stands there in the end
 *   skipped - every bid passed over for want of DKP, in the order they were refused
 *   changed - true when at least one item changed hands
 */
const settleAuctionWinners = async ({ winners, bids, rules, debit, maxRounds }) => {
    const finalWinners = (winners || []).slice();
    const report = [];
    const skipped = [];
    // Everybody holding an item, so no one is handed a second copy of it, and
    // everybody already refused, so the item is never offered back to them.
    const excluded = new Set(finalWinners.map(winner => winner.player));
    const cap = typeof maxRounds === 'number' ? maxRounds : (bids || []).length + 1;
    let changed = false;

    for (let slot = 0; slot < finalWinners.length; slot++) {
        let entry = await debit(finalWinners[slot]);
        let rounds = 0;

        while (entry.status === 'insufficient' && rounds++ < cap) {
            const replacement = nextBestBid(bids, excluded, rules);
            if (!replacement) {
                break;
            }
            const refused = finalWinners[slot];
            skipped.push({
                player: refused.player,
                amount: refused.amount,
                bidForMain: refused.bidForMain,
                reason: 'balance too low',
            });
            excluded.add(replacement.player);
            // valid: true is what calculateWinner stamps on every bid that survives the
            // close, so every winner ever written to an auction carries it. The long
            // auction path picks its replacement out of the stored bids, which are only
            // { player, amount, bidForMain }, so without this a reassigned winner would
            // be the one element of the array missing the field - on the collection a
            // roster site reads.
            finalWinners[slot] = { ...replacement, valid: true };
            changed = true;
            entry = await debit(replacement);
        }

        report.push(entry);
    }

    return { winners: finalWinners, report, skipped, changed };
};

// The shape the two recap writers read a passed-over bid back as. Kept here so the
// embed and the ephemeral summary cannot drift apart on the spelling.
const skippedEntries = (skipped) => (skipped || []).map(entry => ({ ...entry, status: 'skipped' }));

module.exports = { nextBestBid, settleAuctionWinners, skippedEntries };
