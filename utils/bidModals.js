// Everything about the lifetime of a bid modal.
//
// A modal is opened by a button handler and answered by an awaitModalSubmit
// collector that only exists while that handler is awaiting. Discord keeps the
// form open for 15 minutes regardless, and if the player submits it after the
// collector is gone - the bot restarted, or the collector timed out - the
// submission is dispatched to the client listeners and then dropped. Nothing
// acknowledges the interaction, so Discord shows its own red "Something went
// wrong. Try again." over a form the player cannot get past, and never tells
// them the auction is over.
//
// index.js answers those orphans. It can only tell an orphan from a live one by
// asking here: a handler registers its modal id before awaiting and clears it
// as soon as the await settles, so a submission whose id is not registered has
// nobody else waiting for it. The check is order-independent - the id is still
// registered for the whole synchronous dispatch of the event, so it does not
// matter whether index.js runs before or after the collector.

const PREFIXES = ['bidmodal_', 'lbidmodal_'];

const pending = new Set();

const openBidModal = (modalId) => {
    pending.add(modalId);
};

const closeBidModal = (modalId) => {
    pending.delete(modalId);
};

// True when a collector is currently waiting on this modal, i.e. somebody else
// is going to answer it.
const isBidModalPending = (modalId) => pending.has(modalId);

const isBidModal = (modalId) => PREFIXES.some(prefix => (modalId || '').startsWith(prefix));

// What a player sees when the auction closed under an open form. The reason
// comes first because it is the only part that is news: the amount they typed
// no longer matters, and there is nothing for them to retry.
const expiredAuctionMessage = (itemName) => `:hourglass: The auction on **${itemName}** ended while this window was open, so nothing was changed.`;

// The same situation from the player's side, with a different cause: an officer
// pulled the auction. Kept apart from the message above because 'ended' reads as
// 'it ran its course and somebody won', and a bidder told that concludes they
// typed too slowly. No hourglass - time is not what ran out.
const cancelledAuctionMessage = (itemName) => `The auction on **${itemName}** was cancelled by an officer, so nothing was changed.`;

// The one place that picks between the two. Both sites that answer a bidder - the
// guard that runs before the amount is even parsed, and the catch around the bid
// itself - go through here, so they cannot drift apart in wording.
const auctionOverMessage = (itemName, cancelled = false) => (
    cancelled ? cancelledAuctionMessage(itemName) : expiredAuctionMessage(itemName)
);

// Same message without an item name, for the orphan handler in index.js: the
// modal id carries no item, and the auction may be one the bot no longer knows
// about at all.
const expiredBidWindowMessage = () => `:hourglass: That bid window is no longer open - the auction ended, or the bot restarted while the form was up. Nothing was changed.`;

// Auctioner, Auction and DKPManager all refuse a late bid or withdrawal by
// throwing, and each has its own wording for it. To the player they are one
// situation, and it is one of the two above; anything else is a real error and
// is passed through unchanged. Anchored on purpose: a message that merely
// contains one of these - 'Auction not found in the database' - is a genuine
// failure and must not be reported as the auction being over.
const AUCTION_OVER = /^Auction (has ended|not active|is not active|not found)$/;

// The long auction half of the same problem, and it could not be solved the same
// way. A short auction lives in memory, so the caller can read auction.cancelled
// at the moment the bid was refused; a long auction lives in the database, and the
// bidder's process never sees the document /cancelauction wrote. So DKPManager
// says which of the two happened in the string it throws, and this is that string.
// It is the only member of AUCTION_OVER's family that carries its own cause.
const AUCTION_CANCELLED = /^Auction was cancelled$/;

// `cancelled` is the auction's own flag, read by the caller at the moment the bid
// was refused. There is exactly one window where that differs from reading it
// when the form opened: Auctioner.bid suspends in a getPlayer round trip, and an
// officer cancelling inside it leaves Auction.bid throwing 'Auction is not
// active' - the same string the timer produces, carrying nothing about the cause.
// The flag is the only thing that tells the two apart.
//
// A positional boolean rather than an options object, and not only for house
// style: this is called from inside a catch, where a throw is NOT caught by its
// own try. Destructuring a null argument would escape to guardListener, which
// only logs - leaving the modal unacknowledged and the player stuck behind
// Discord's own "Something went wrong", which is the exact failure this file
// exists to remove. Omitted, this behaves exactly as it always did, which is what
// the long auction path wants: it has no button to read a flag from, so it lets
// the thrown string speak instead - see AUCTION_CANCELLED above.
const bidErrorMessage = (error, itemName, cancelled = false) => {
    const message = error?.message || '';
    // Tested first, and without consulting `cancelled`: this string exists only
    // because DKPManager read the flag off the document, which outranks anything a
    // caller could infer from an object it is holding.
    if (AUCTION_CANCELLED.test(message)) {
        return cancelledAuctionMessage(itemName);
    }

    return AUCTION_OVER.test(message)
        ? auctionOverMessage(itemName, cancelled)
        : (message || 'The bid could not be placed');
};

module.exports = {
    openBidModal,
    closeBidModal,
    isBidModalPending,
    isBidModal,
    expiredAuctionMessage,
    cancelledAuctionMessage,
    auctionOverMessage,
    expiredBidWindowMessage,
    bidErrorMessage,
};
