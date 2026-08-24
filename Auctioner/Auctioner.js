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
            try {
                const players = this.dkpManager
                    ? await Promise.all(auction.bids.map(bid => this.dkpManager.getPlayer(guild, bid.player, checkAttendance)))
                    : [];
                auction.endAuction();
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
    // Throws 'Auction not found' once the auction has closed, because removeAuction()
    // drops it from the list in startAuction's finally block.
    async removeBid(guild, auctionId, player) {
        const auction = this.auctions.find(auction => auction.id === auctionId && auction.guild === guild);
        if (!auction) {
            throw new Error('Auction not found');
        }
        return auction.removeBid(player);
    }
}

module.exports = Auctioner;