const { ObjectId } = require("mongodb");
const { DEFAULT_LOCK_DELAY } = require("../utils/auctionDebit.js");

module.exports = class DKPManager {
    constructor(dbClient) {
        this.dbClient = dbClient;
        const db = this.dbClient.db('DKP');

        this.raids = db.collection(`raids`);
        this.players = db.collection(`players`);
        this.guildOptions = db.collection(`options`);
        this.auctions = db.collection(`auctions`);
        this.shortAuctions = db.collection(`shortAuctions`);
    }

    async createRaid(guild, name, tickDuration = 60000 * 60, dkpsPerTick = 1, eventId = null) {
        const alreadyActiveRaid = await this.raids.findOne({ guild, active: true });
        if (alreadyActiveRaid) {
            throw new Error('There is already an active raid');
        }

        const date = new Date().getTime();
        const result = await this.raids.insertOne({
            guild,
            name,
            date,
            attendance: [],
            tickDuration,
            dkpsPerTick,
            active: true,
            deprecated: false,
            eventId,
        });

        return this.raids.findOne({ _id: result.insertedId });
    }

    async addRaidAttendance(guild, raid, players, comment, dkps) {
        const date = new Date().getTime();
        return this.raids.updateOne({ _id: raid._id, guild }, { $push: { attendance: { players, comment, date, dkps } } });
    }

    async getActiveRaid(guild) {
        return this.raids.findOne({ guild, active: true });
    }

    async getRaidById(guild, raidId) {
        return await this.raids.findOne({ _id: raidId, guild });
    }

    async endRaid(guild) {
        return this.raids.updateOne({ active: true, guild }, { $set: { active: false } });
    }

    async getRaidDKPMovements(guild, raidId) {
        const raid = await this.raids.findOne({ _id: raidId, guild }, { projection: { attendance: 1 } });
        //group attendance entries by comment untill different comment is found
        const attendance = raid.attendance.reduce((acc, entry, index) => {
            if (index === 0) {
                acc.push({ comment: entry.comment, dkps: entry.dkps, date: entry.date });
            }
            else if (entry.comment !== raid.attendance[index - 1].comment) {
                acc.push({ comment: entry.comment, dkps: entry.dkps, date: entry.date });
            }
            else if (entry.comment === raid.attendance[index - 1].comment) {
                acc[acc.length - 1].dkps += entry.dkps;
            }
            return acc;
        }, []);

        if (!raid) {
            throw new Error('Raid not found');
        }

        const loots = await this.players.aggregate([
            { $match: { guild } },
            { $unwind: '$log' },
            { $match: { 'log.raid._id': raidId, 'log.dkp': { $lt: 0 } } },
            { $project: { player: 1, dkps: '$log.dkp', comment: '$log.comment', date: '$log.date', _id: 0, item: '$log.item' } },
        ]).toArray();

        return [...loots, ...raid.attendance].sort((a, b) => a.date - b.date);
    }

    async deprecateOldRaids(guild, time) {
        return this.raids.updateMany({ guild, date: { $lt: time } }, { $set: { deprecated: true } });
    }

    async addDKP(guild, player, dkp, comment, raid = null) {
        return this.players.findOneAndUpdate(
            { player, guild },
            {
                $inc: { current: dkp },
                $push: {
                    log: {
                        dkp: dkp,
                        comment,
                        date: new Date().getTime(),
                        raid: raid ? { _id: raid._id, name: raid.name } : null,
                    },
                },
                $setOnInsert: { creationDate: new Date().getTime() },
            },
            { upsert: true },
        );
    }

    // A debit only goes through when the player actually holds the DKP. The balance
    // check rides in the filter, so checking and writing are one atomic operation:
    // two debits racing over the same pool - a short auction confirmed while the
    // worker closes a long one, an officer removing DKP at the same moment - cannot
    // both pass it, and the loser writes nothing.
    //
    // Returns the updated player document, or null when the balance was too low or
    // the player has no record. null means nothing was written, so every caller must
    // report it as a failure rather than as a removal.
    //
    // Deliberately not an upsert any more: upserting on a player who had no record
    // conjured one sitting at minus the debited amount.
    async removeDKP(guild, player, dkp, comment, raid = null, item = null) {
        return this.players.findOneAndUpdate(
            { player, guild, current: { $gte: dkp } },
            {
                $inc: { current: -dkp },
                $push: {
                    log: {
                        dkp: -dkp,
                        comment,
                        date: new Date().getTime(),
                        raid: raid ? { _id: raid._id, name: raid.name } : null,
                        item,
                    },
                },
            },
            { returnDocument: 'after' },
        );
    }

    calculatePlayerAttendance(player, raids) {
        const totalAttendancePossibleSincePlayerJoined = raids.reduce((total, raid) => {
            if (raid.date < player.creationDate) {
                return raid.attendance.filter((attendance) => attendance.date >= player.creationDate).length + total;
            };
            return total + raid.attendance.length;
        }, 0);


        if (totalAttendancePossibleSincePlayerJoined === 0) {
            return { ...player, attendance: 100 };
        }

        const playerAttendedRaids = raids.reduce((total, raid) => {
            const playerAttendance = raid.attendance.filter((attendance) => attendance.players.includes(player.player));
            return total + playerAttendance.length;
        }, 0);

        const attendance = parseFloat(((playerAttendedRaids / totalAttendancePossibleSincePlayerJoined) * 100).toFixed(2));

        return { ...player, attendance };
    }

    async getPlayerDKP(guild, player) {
        const playerData = await this.players.findOne({ player, guild });
        if (!playerData) {
            throw new Error('Player not found');
        }
        return playerData.current;
    }

    async getPlayer(guild, playerId, withAttendance = true) {

        const player = await this.players.findOne({ player: playerId, guild });
        if (!player) {
            throw new Error('Player not found');
        }
        //get player position based on current dkp
        //const players = await this.players.find({ guild }).sort({ current: -1 }).toArray();
        //const position = players.findIndex(p => p.player === playerId) + 1;
        const position = 0;
        if (!withAttendance) {
            return { ...player, position };
        }

        const raids = await this.raids.find({ guild, deprecated: false }).toArray();
        return this.calculatePlayerAttendance({ ...player, position }, raids);
    }

    async listPlayers(guild, page = 0, pageSize = 10, lastPlayerActivity = null) {
        try {
            const query = { guild };
            if (lastPlayerActivity) {
                const cutoffTime = new Date().getTime() - lastPlayerActivity;
                query['log.date'] = { $gte: cutoffTime };
            }

            const players = await this.players.find(query)
                .sort({ current: -1 })
                .skip(page * pageSize)
                .limit(pageSize)
                .toArray();

            const raids = await this.raids.find({ guild, deprecated: false }).toArray();

            return {
                players: players.map(player => this.calculatePlayerAttendance(player, raids)),
                total: await this.players.countDocuments(query)
            };
        }
        catch (e) {
            console.log('Error listing players', e);
            return [];
        }
    }

    async getAll(guild, collection) {
        if (!this[collection]) {
            throw new Error(`Collection ${collection} not found`);
        }
        return this[collection].find({ guild }).toArray();
    }

    async searchLogs(guild, searchterm) {
        //search in all Logs for an specific term and return the logs order by date with the player
        const logs = await this.players.aggregate([
            { $match: { guild } },
            { $unwind: '$log' },
            { $match: { 'log.comment': { $regex: searchterm, $options: 'i' } } },
            { $project: { player: 1, dkp: '$log.dkp', comment: '$log.comment', date: '$log.date', item: '$log.item' } },
        ]).toArray();
        return logs.sort((a, b) => a.date - b.date);
    }

    async addCharacter(guild, player, character) {
        const alreadyRegistered = await this.players.findOne({ characters: character, guild });

        if (alreadyRegistered) {
            throw new Error(`Character ${character} already registered`);
        }

        // Without upsert this matched nothing for a member who has no player
        // document yet (addDKP/removeDKP create theirs on the fly, this one did
        // not), so the character was dropped while the command still answered
        // "Successfully registered". Filtering on player+guild only, so the
        // upsert can never insert a second document for the same player; the
        // $nin it replaces is already covered by the check above, and $addToSet
        // keeps re-registering one's own character a no-op.
        return this.players.findOneAndUpdate(
            { player, guild },
            {
                $addToSet: { characters: character },
                $setOnInsert: { creationDate: new Date().getTime(), current: 0, log: [] },
            },
            { upsert: true },
        );
    }

    async saveGuildOptions(guild, options) {
        return this.guildOptions.findOneAndUpdate({ guild }, { $set: options }, { upsert: true });
    }

    async getGuildOptions(guild) {
        return this.guildOptions.findOne({ guild });
    }

    async createAution(guild, item, minBid, numberOfItems, minBidToLockForMain, overBidtoWinMain, duration, autoDebit = true, lockDelay = DEFAULT_LOCK_DELAY) {
        const auction = {
            guild,
            item,
            minBid,
            numberOfItems,
            minBidToLockForMain,
            overBidtoWinMain,
            bids: [],
            auctionActive: true,
            createdAt: new Date().getTime(),
            auctionEnd: new Date().getTime() + duration,
            // The three fields below are additive: an auction document written
            // before they existed simply does not carry them, and every reader
            // defaults it back to the behaviour it was started under.
            autoDebit,
            lockDelay,
            debitedPlayers: [],
        };

        const result = await this.auctions.insertOne(auction);
        return this.auctions.findOne({ _id: result.insertedId });
    }

    async getAuction(guild, auctionId) {
        const auction = await this.auctions.findOne({ _id: new ObjectId(auctionId), guild });
        if (!auction) {
            throw new Error('Auction not found');
        }
        return auction;
    }

    async getActiveAuctions(guild) {
        return this.auctions.find({ guild, auctionActive: true }).toArray();
    }

    async getFinishedActiveAuctions(guild) {
        const currentTime = new Date().getTime();
        return this.auctions.find({ guild, auctionActive: true, auctionEnd: { $lt: currentTime } }).toArray();
    }

    async updateAuctionMessageId(guild, auctionId, messageId) {
        const auction = await this.auctions.findOne({ _id: auctionId, guild });
        if (!auction) {
            throw new Error('Auction not found');
        }
        return this.auctions.updateOne({ _id: auction._id, guild }, { $set: { messageId } });
    }

    // Closing is a compare-and-swap on auctionActive; the read below only runs when
    // that fails, to tell 'no such auction' apart from 'somebody got there first'.
    // The old shape read the auction, checked the flag and then wrote without it, so
    // two overlapping worker ticks - or a tick landing on the same millisecond as
    // /cancelauction - both passed the check and both wrote, the loser overwriting a
    // result on an auction it had already settled.
    //
    // matchedCount, not modifiedCount: matching is what grants ownership here, and an
    // update that happens to write the identical winners still means this caller won.
    // Both thrown strings are the ones this method already threw.
    async endAuction(guild, auctionId, winners) {
        const result = await this.auctions.updateOne(
            { _id: new ObjectId(auctionId), guild, auctionActive: true },
            { $set: { auctionActive: false, winners } },
        );
        if (result.matchedCount === 0) {
            const auction = await this.auctions.findOne({ _id: new ObjectId(auctionId), guild });
            throw new Error(auction ? 'Auction not active' : 'Auction not found');
        }

        return result;
    }

    // Stops an auction taking bids without settling it, for /endauction.
    //
    // auctionActive was never what stopped a bidder: bid() and removeBid() require it
    // rather than change it, and two updates that both demand the same value never lose
    // to each other - so the compare-and-swap in endAuction cannot see a bid at all. The
    // deadline is what stops them, and the worker never had to think about that because
    // it only ever closes auctions whose auctionEnd is already behind them. An officer
    // closing early is the first caller for which it is still days away, so the deadline
    // has to be pulled in before the bids are read, not after the winners are written.
    //
    // One millisecond behind now, because those two checks refuse on `auctionEnd < now`:
    // a check running on this very millisecond would otherwise still pass.
    //
    // lockDelay goes to 0 with it. Nothing reads it after a close except the worker's own
    // close filter, and leaving it at twenty minutes would hold the auction there for
    // that long if the settlement failed halfway; at 0 the next tick finishes the job.
    //
    // Compare-and-swap on auctionActive, like endAuction and cancelAuction above: null
    // means the worker or /cancelauction got there first. The document comes back with
    // the bids as they stood the moment bidding stopped, and that is the list the caller
    // has to settle - reading them again later would reopen the window this closes.
    async closeAuctionBidding(guild, auctionId) {
        return this.auctions.findOneAndUpdate(
            { _id: new ObjectId(auctionId), guild, auctionActive: true },
            { $set: { auctionEnd: new Date().getTime() - 1, lockDelay: 0 } },
            { returnDocument: 'after' },
        );
    }

    // Voids a long auction: it stops taking bids and is never settled. The bids are
    // deliberately kept - an officer has to be able to read what was bid on an
    // auction they pulled, and /auctiondetails is the only way to do that.
    //
    // cancelled/cancelledAt/cancelledBy are additive, exactly like autoDebit above: a
    // document written before this command existed carries none of them, and every
    // reader treats a missing flag as 'not cancelled'. That is why the filters that
    // refuse a cancelled auction say `cancelled: { $ne: true }` and not
    // `cancelled: false`, which would match no auction in flight today.
    //
    // winners is set to an empty array on purpose. /auctiondetails reports a missing
    // winners field as 'closed before the bot stored winners', which would be a lie
    // about an auction that was voided minutes ago.
    //
    // auctionActive: true in the filter makes this a compare-and-swap, so an auction
    // the worker closed a millisecond earlier comes back null instead of being voided
    // after its winners were already debited. The document is returned so the caller
    // can repaint the post without a second read; null means nothing matched.
    async cancelAuction(guild, auctionId, cancelledBy) {
        return this.auctions.findOneAndUpdate(
            { _id: new ObjectId(auctionId), guild, auctionActive: true },
            {
                $set: {
                    auctionActive: false,
                    cancelled: true,
                    cancelledAt: new Date().getTime(),
                    cancelledBy,
                    winners: [],
                },
            },
            { returnDocument: 'after' },
        );
    }

    // Rewrites the winners of an auction that is already closed, which endAuction
    // refuses to do. The winner picked at the close can turn out to be unable to
    // pay by the time the DKP are actually taken, and the item then goes down the
    // bid list - a change that has to be recorded, because this field is what the
    // auction message, /auctiondetails and every outside reader are drawn from.
    // Only the existing winners field is touched; nothing is added to the document.
    //
    // A cancelled auction is closed too, and it has no winners to rewrite: `$ne true`
    // rather than false, because an auction started before /cancelauction existed
    // carries no cancelled field at all.
    async setAuctionWinners(guild, auctionId, winners) {
        return this.auctions.updateOne(
            { _id: new ObjectId(auctionId), guild, auctionActive: false, cancelled: { $ne: true } },
            { $set: { winners } },
        );
    }

    // One winner, one debit. debitedPlayers is the auction's own record of who has
    // already been taken, and $addToSet behind a `debitedPlayers: {$ne: player}`
    // filter is a single atomic update: when the worker's automatic debit and an
    // officer's Confirm land together, exactly one of them comes back with
    // modifiedCount 1 and goes on to write the DKP.
    // Only a closed auction can be debited, hence the auctionActive guard - and only
    // one that was closed on its merits, hence the cancelled one. A voided auction has
    // no winners, so nothing should ever reach here; this clause is what makes that
    // true even for a stale Confirm button somebody still has on screen.
    async claimAuctionDebit(guild, auctionId, player) {
        const result = await this.auctions.updateOne(
            { _id: new ObjectId(auctionId), guild, auctionActive: false, cancelled: { $ne: true }, debitedPlayers: { $ne: player } },
            { $addToSet: { debitedPlayers: player } },
        );
        return result.modifiedCount === 1;
    }

    // Hands a claim back when the debit behind it did not go through, so Confirm can
    // be pressed again once the balance is there.
    async releaseAuctionDebit(guild, auctionId, player) {
        return this.auctions.updateOne(
            { _id: new ObjectId(auctionId), guild },
            { $pull: { debitedPlayers: player } },
        );
    }

    async removeBid(guild, auctionId, player) {
        //check if auction is active
        const auction = await this.auctions.findOne({ _id: new ObjectId(auctionId), guild });
        if (!auction) {
            throw new Error('Auction not found');
        }
        if (auction.auctionActive === false) {
            // Two different pieces of news for the bidder, and only the document can
            // tell them apart: the timer ran out, or an officer pulled the auction.
            throw new Error(auction.cancelled ? 'Auction was cancelled' : 'Auction not active');
        }
        // The same deadline bid() enforces. auctionActive on its own is not enough:
        // the worker deliberately waits out the lock delay before closing a finished
        // auction, so between the advertised end and that close the flag is still
        // true. Withdrawing in that window pulled the winning bid after bidding was
        // supposed to be over and handed the item to the runner-up.
        if (auction.auctionEnd < new Date().getTime()) {
            throw new Error('Auction has ended');
        }

        // auctionActive belongs in the filter, not only in the check above: the read
        // and this write are two round trips, and a cancel landing between them used to
        // delete a bid out of a voided auction - the one record a void keeps.
        const result = await this.auctions.updateOne(
            { _id: auction._id, guild, auctionActive: true },
            { $pull: { bids: { player: player.player } } },
        );
        if (result.matchedCount === 0) {
            const fresh = await this.auctions.findOne({ _id: auction._id, guild });
            throw new Error(fresh?.cancelled ? 'Auction was cancelled' : 'Auction not active');
        }

        return result;
    }

    async bid(guild, auctionId, amount, player, bidForMain = true) {
        if (amount <= 0) {
            throw new Error('DKP - Bot scowls at you. Bid amount must be greater than 0');
        }

        if (!Number.isInteger(amount)) {
            throw new Error('DKP - Bot scowls at you. Bid amount must be an integer');
        }
        //check if auction is active
        const auction = await this.auctions.findOne({ _id: new ObjectId(auctionId), guild });
        if (!auction) {
            throw new Error('Auction not found');
        }
        // This was never checked here at all, despite the comment above: the deadline
        // below was the only stop, so a bid could still land on an auction the worker
        // had already closed and debited - and, once /cancelauction existed, on a
        // voided one, which removeBid would then refuse to undo.
        if (auction.auctionActive === false) {
            throw new Error(auction.cancelled ? 'Auction was cancelled' : 'Auction not active');
        }
        if (auction.auctionEnd < new Date().getTime()) {
            throw new Error('Auction has ended');
        }

        if (amount > player.current) {
            throw new Error(`DKP - Bot scowls at you. Bid amount is greater than player current DKP (${player.current})`);
        }

        if (amount < auction.minBid) {
            throw new Error(`DKP - Bot scowls at you. Bid amount is less than the minimum bid (${auction.minBid})`);
        }

        //auction contains player bid
        const update = auction.bids.find(bid => bid.player === player.player)
            //update that player bid
            ? this.auctions.updateOne(
                { _id: auction._id, guild, auctionActive: true, 'bids.player': player.player },
                { $set: { 'bids.$.amount': amount, 'bids.$.bidForMain': bidForMain } },
            )
            //add bid
            : this.auctions.updateOne(
                { _id: auction._id, guild, auctionActive: true },
                { $push: { bids: { player: player.player, amount, bidForMain } } },
            );

        const result = await update;
        if (result.matchedCount === 0) {
            // The close or the cancel landed between the read above and this write.
            // Re-read rather than guess: which of the two happened is the only thing the
            // bidder is actually told, and this window is milliseconds wide.
            const fresh = await this.auctions.findOne({ _id: auction._id, guild });
            throw new Error(fresh?.cancelled ? 'Auction was cancelled' : 'Auction not active');
        }

        return result;
    }

    // Short Auctions Methods
    async storeShortAuction(guild, auction) {
        // Convert in-memory auction to database format
        const auctionData = {
            guild,
            item: auction.item,
            minBid: auction.minBid,
            numberOfItems: auction.numberOfItems,
            bids: auction.bids,
            auctionActive: false,
            createdAt: new Date().getTime(),
            auctionEnd: new Date().getTime(),
            winners: auction.winner ? [auction.winner] : auction.winners,
        };

        const result = await this.auctions.insertOne(auctionData);
        return this.auctions.findOne({ _id: result.insertedId });
    }

    async getAuctionById(guild, auctionId) {
        const auction = await this.auctions.findOne({ _id: new ObjectId(auctionId), guild });
        if (!auction) {
            throw new Error('Auction not found');
        }
        return auction;
    }
};
