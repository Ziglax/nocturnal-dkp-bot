const Auction = require('./Auction');

const defaultConfig = {
    minBid: 0,
    duration: 60000,
    numberOfItems: 1,
    minBidToLockForMain: 0,
    overBidtoWinMain: 0,
    checkAttendance: true,
};

class Auctioner {

    constructor(dkpManager = null) {
        if (dkpManager) {
            this.dkpManager = dkpManager;
        }

        if (Auctioner.instance) {
            return Auctioner.instance;
        }
        Auctioner.instance = this;
        this.auctions = [];
    }

    startAuction(item, guild, callback, config = {}) {
        const { minBid, duration, numberOfItems, minBidToLockForMain, overBidtoWinMain, checkAttendance } = Object.assign({}, defaultConfig, config);
        const auction = new Auction(guild, item, minBid, numberOfItems, minBidToLockForMain, overBidtoWinMain, checkAttendance);
        this.auctions.push(auction);
        setTimeout(async () => {
            if (!auction.auctionActive) {
                return;
            }
            // Closed here, before the first await rather than after the lookups
            // below. Those lookups are database round trips, and the auction used to
            // stay open across them: a bid landing in that window was confirmed to
            // the bidder and then silently dropped by calculateWinner, and a Cancel
            // landing there returned true, painted the message cancelled, and was
            // then overwritten by a winners embed carrying a live Confirm button.
            // Nothing awaits between the guard above and this line, so the window is
            // now zero-width.
            auction.endAuction();
            try {
                // A bidder the database cannot produce - record deleted, transient
                // read failure - loses their own bid and nothing more. The close only
                // ever fires once, so letting one lookup reject would leave the item
                // unawarded for good, with no retry anywhere.
                const players = this.dkpManager
                    ? (await Promise.all(auction.bids.map(bid => this.dkpManager.getPlayer(guild, bid.player, checkAttendance)
                        .catch((error) => {
                            console.error('[auctioner] dropping a bidder from the close', auction.id, bid.player, error?.message || error);
                            return null;
                        })))).filter(Boolean)
                    : [];
                auction.calculateWinner(players);

                // Store the short auction in the database when it ends
                if (this.dkpManager) {
                    try {
                        const storedAuction = await this.dkpManager.storeShortAuction(guild, auction);
                        auction._id = storedAuction._id;
                    } catch (error) {
                        console.error('Failed to store short auction in database:', error);
                    }
                }

                await callback(auction);
            } catch (error) {
                console.error('[auctioner] auction close failed', auction.id, error);
            } finally {
                this.removeAuction(auction.id);
            }
        }, duration);

        return auction;
    }

    async cancelAuction(auctionId) {
        const auction = this.getAuction(auctionId);
        if (!auction || !auction.auctionActive) {
            return false;
        }
        // Set BEFORE endAuction, not after. endAuction only clears auctionActive,
        // which is indistinguishable from the timer expiring - which is why a bidder
        // whose auction was pulled was told it had ended. Everything downstream reads
        // the flag to tell those two apart, so it must never be possible to observe
        // the auction inactive but not yet marked cancelled. Nothing suspends between
        // these two lines today; this ordering means nothing has to.
        //
        // In memory only, and never persisted: a cancelled auction is not stored at
        // all, and storeShortAuction builds its document field by field.
        auction.cancelled = true;
        auction.endAuction();
        this.removeAuction(auctionId);
        return true;
    }

    removeAuction(auctionId) {
        this.auctions = this.auctions.filter(auction => auction.id !== auctionId);
    }

    getAuction(auctionId) {
        return this.auctions.find(auction => auction.id === auctionId);
    }

    async bid(guild, auctionId, amount, player, bidForMain = true) {
        const auction = this.auctions.find(auction => auction.id === auctionId);
        if (!auction) {
            throw new Error('Auction not found');
        }
        const playerData = await this.dkpManager.getPlayer(guild, player, auction.checkAttendance);
        auction.bid(amount, playerData, bidForMain);
    }

    // Withdraw a bidder's bid from a running auction. No DKP lookup: removing a bid
    // needs nothing from the player record, and a bidder whose record went missing
    // must still be able to pull out.
    // Returns true when a bid was removed, false when the player had none.
    // Throws 'Auction is not active' while the close is running and 'Auction not
    // found' after it, because removeAuction() drops the auction from the list in
    // startAuction's finally block.
    async removeBid(guild, auctionId, player) {
        const auction = this.auctions.find(auction => auction.id === auctionId && auction.guild === guild);
        if (!auction) {
            throw new Error('Auction not found');
        }
        return auction.removeBid(player);
    }
}

module.exports = Auctioner;