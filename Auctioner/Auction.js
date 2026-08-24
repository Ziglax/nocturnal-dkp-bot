require('dotenv').config()
const uniqid = require('uniqid');
const log = require('../debugger.js');

module.exports = class Auction {
    constructor(guild, item, minBid = 0, numberOfItems = 1, minBidToLockForMain = 0, overBidtoWinMain = 0, checkAttendance = true) {
        this.item = item;
        this.bids = [];
        this.id = `${guild}_${uniqid()}`;
        this.winner = null;
        this.winners = [];
        this.guild = guild;
        this.auctionActive = true;
        this.minBid = minBid;
        this.numberOfItems = numberOfItems === 0 ? 1 : numberOfItems;
        this.minBidToLockForMain = minBidToLockForMain;
        this.overBidtoWinMain = overBidtoWinMain;
        this.checkAttendance = checkAttendance;
    }

    endAuction() {
        this.auctionActive = false;
    }

    bid(amount, playerData, bidForMain = true) {
        if (!this.auctionActive) {
            throw new Error('Auction is not active');
        }
        if (process.env.LOG_LEVEL === 'DEBUG') {
            log(`Registering bid for ${this.item.name}`, {
                player: playerData.player,
                amount,
                bidForMain
            });
        }
        this.validateBidAmount(amount, playerData);

        const existingBid = this.bids.find(bid => bid.player === playerData.player);
        if (existingBid) {
            existingBid.amount = amount;
            existingBid.bidForMain = bidForMain;
            return;
        } else {
            this.bids.push({ player: playerData.player, amount, attendance: playerData.attendance, bidForMain });
        }
    }

    // Withdraw a bid. Kept separate from bid() because validateBidAmount() rejects
    // any amount <= 0 before it ever looks for an existing bid, so "bid 0 to cancel"
    // can never travel through bid(). Mirrors DKPManager.removeBid for long auctions.
    // Returns true when a bid was actually removed, false when the player had none.
    removeBid(playerId) {
        if (!this.auctionActive) {
            throw new Error('Auction is not active');
        }
        const index = this.bids.findIndex(bid => bid.player === playerId);
        if (index === -1) {
            return false;
        }
        this.bids.splice(index, 1);
        if (process.env.LOG_LEVEL === 'DEBUG') {
            log(`Removing bid for ${this.item.name}`, {
                player: playerId
            });
        }
        return true;
    }

    toObject() {
        return {
            id: this.id,
            item: this.item,
            bids: this.bids,
            winner: this.winner,
            guid: this.guild
        };
    }

    validateBidAmount(amount, player) {
        // calculateWinner looks the bidder up in a list its caller built, and that
        // lookup comes back undefined when the record could not be read. Say so
        // instead of letting the balance check below throw a TypeError that the
        // caller would then file as the bid's rejection reason.
        if (!player) {
            throw new Error('Player record could not be read');
        }

        if (amount <= 0) {
            throw new Error('DKP - Bot scowls at you. Bid amount must be greater than 0');
        }

        if (!Number.isInteger(amount)) {
            throw new Error('DKP - Bot scowls at you. Bid amount must be an integer');
        }

        if (amount > player.current) {
            throw new Error(`DKP - Bot scowls at you. Bid amount is greater than player current DKP (${player.current})`);
        }

        if (amount < this.minBid) {
            throw new Error(`DKP - Bot scowls at you. Bid amount is less than the minimum bid (${this.minBid})`);
        }
    }

    getTopBids(bids, amount) {
        if (bids.length === 0) {
            return [];
        }
        const bidsSorted = bids.sort((a, b) => b.amount - a.amount);
        const minBidToWin = bidsSorted.length > amount ? bidsSorted[amount - 1].amount : bidsSorted[bidsSorted.length - 1].amount;
        const filteredbids = bidsSorted.filter((bid) => bid.amount >= minBidToWin);

        const topBids = [];
        while (topBids.length < amount && filteredbids.length > 0) {
            if (filteredbids.length === 1) {
                topBids.push(filteredbids[0]);
                break;
            }
            if (filteredbids[0].amount > filteredbids[1].amount) {
                topBids.push(filteredbids[0]);
                filteredbids.splice(0, 1);
                continue;
            }
            if (filteredbids[0].amount === filteredbids[1].amount) {
                // Equal amounts are settled by a straight random draw among every bid
                // tied at the top amount. filteredbids is sorted by amount descending,
                // so that tied group is its head: an index drawn below tiedCount always
                // lands on a tied bid, and splicing the same index removes the one that
                // was drawn.
                const tiedCount = filteredbids.filter(bid => bid.amount === filteredbids[0].amount).length;
                const winnerIndex = Math.floor(Math.random() * tiedCount);
                topBids.push(filteredbids[winnerIndex]);
                filteredbids.splice(winnerIndex, 1);
            }
        }

        return topBids;
    }

    getWinners(bids, numberOfWinners = 1) {
        const [highestMainBid] = bids.filter(bid => bid.bidForMain).sort((a, b) => b.amount - a.amount);
        const mainBids = bids.filter(bid => (bid.bidForMain && bid.amount >= this.minBidToLockForMain) || (this.overBidtoWinMain && highestMainBid && bid.amount >= highestMainBid.amount + this.overBidtoWinMain));
        const altBids = bids.filter(bid => mainBids.findIndex(mainBid => mainBid.player === bid.player) === -1);
        const topMainBids = this.getTopBids(mainBids, numberOfWinners);
        const topAltBids = this.getTopBids(altBids, numberOfWinners);


        const winners = topMainBids;

        if (winners.length < numberOfWinners) {
            winners.push(...topAltBids.slice(0, numberOfWinners - winners.length));
        }

        return winners;
    }

    calculateWinner(playersList) {
        if (process.env.LOG_LEVEL === 'DEBUG') {
            log('Calculating winners', {
                item: this.item.name,
                bids: this.bids,
                numberOfItems: this.numberOfItems,
                minBidToLockForMain: this.minBidToLockForMain,
                overBidtoWinMain: this.overBidtoWinMain
            });
        }
        if (this.bids.length === 0) {
            return null;
        }
        this.bids = this.bids.map(bid => {
            try {
                this.validateBidAmount(bid.amount, playersList.find(player => player.player === bid.player));
                return { ...bid, valid: true };
            }
            catch (e) {
                if (process.env.LOG_LEVEL === 'DEBUG') {
                    log('Removing invalid bid', {
                        player: bid.player,
                        amount: bid.amount,
                        reason: e.message
                    });
                }
                return { ...bid, valid: false, reason: e.message };
            }
        });


        this.bids = this.bids.filter(bid => bid.valid);

        if (this.bids.length === 0) {
            return null;
        }

        const amountOfWinnersNeeded = this.numberOfItems > this.bids.length ? this.bids.length : this.numberOfItems;

        const winners = this.getWinners(this.bids, amountOfWinnersNeeded);
        if (this.numberOfItems > 1) {
            this.winners = winners.slice(0, this.numberOfItems);
            return this.winners;
        }

        const winner = winners[Math.floor(Math.random() * winners.length)];
        this.winner = winner;
        return winner;
    }
}