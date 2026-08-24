const Logger = require('../utils/Logger');
const Auction = require('../Auctioner/Auction');
const log = require('../debugger.js');

module.exports = class Worker {
    constructor(client, manager) {
        this.client = client;
        this.manager = manager;
        this.logger = new Logger(client);
        this.ticking = new Set();
    }

    async start() {
        console.log('Worker started');
        this.fastInterval = setInterval(() => this.runFastTasks().catch(e => console.error('[worker] fast task failed', e)), 10 * 1000);
        this.mediumInterval = setInterval(() => this.runMediumTasks().catch(e => console.error('[worker] medium task failed', e)), 60 * 1000);
        this.slowInterval = setInterval(() => this.runSlowTasks().catch(e => console.error('[worker] slow task failed', e)), 60 * 60 * 1000);
    }

    stop() {
        console.log('Worker stopped');
        clearInterval(this.fastInterval);
        clearInterval(this.mediumInterval);
        clearInterval(this.slowInterval);
    }

    async tick(guildOptions, raid) {
        let discordGuild;
        try {
            discordGuild = await this.client.guilds.fetch(guildOptions.guild);
        }
        catch (error) {
            console.error(`[worker] Error fetching guild ${guildOptions.guild} for raid: ${raid?.name}`, error);
            if (error?.code === 10004) {
                await this.manager.endRaid(guildOptions.guild).catch(e => console.error('[worker] endRaid failed', e));
            }
            return;
        }
        const raidChannel = await discordGuild.channels.fetch(guildOptions.raidChannel).catch(() => null);
        if (!raidChannel?.members) {
            console.error('[worker] raid channel unavailable', guildOptions.raidChannel);
            return;
        }
        const playersInChannel = [...raidChannel.members.keys()];

        let playersInSecondChannel = [];
        const secondRaidChannel = guildOptions.secondRaidChannel;
        if (secondRaidChannel) {
            const secondChannel = await discordGuild.channels.fetch(secondRaidChannel).catch(() => null);
            if (secondChannel?.members) {
                playersInSecondChannel = [...secondChannel.members.keys()];
            } else {
                console.error('[worker] second raid channel unavailable', secondRaidChannel);
            }
        }

        for (const player of [...playersInChannel, ...playersInSecondChannel]) {
            try {
                await this.manager.addDKP(guildOptions.guild, player, raid.dkpsPerTick, 'Tick', raid);
            } catch (e) {
                console.error('[worker] addDKP failed', guildOptions.guild, player, e);
            }
        }

        await this.manager.addRaidAttendance(guildOptions.guild, raid, [...playersInChannel, ...playersInSecondChannel], 'Tick', raid.dkpsPerTick);

        this.logger.sendRaidEmebed(guildOptions, raid, [...playersInChannel, ...playersInSecondChannel], 3447003, `${raid.name} raid *tick*`).catch(e => console.error('[worker] raid tick embed failed', e));
    }

    async deprecateRaids(guilds) {
        for (const guildOptions of guilds) {
            const time = new Date().getTime() - guildOptions.raidDeprecationTime;
            await this.manager.deprecateOldRaids(guildOptions.guild, time);
        }
    }

    async processRaids(guilds) {
        for (const guildOptions of guilds) {
            // The reentrancy guard is held across the raid read as well, so a slow previous tick can
            // never be followed by a second tick decided on a stale attendance snapshot.
            if (this.ticking.has(guildOptions.guild)) {
                console.log(`[worker] tick skipped, previous tick still running for guild ${guildOptions.guild}`);
                continue;
            }
            this.ticking.add(guildOptions.guild);
            let raid;
            try {
                raid = await this.manager.getActiveRaid(guildOptions.guild);

                if (!raid) {
                    continue;
                }

                const enoughTimePassedSinceLastTick = raid.attendance.length === 0 || raid.attendance[raid.attendance.length - 1].date + raid.tickDuration < new Date().getTime();
                if (enoughTimePassedSinceLastTick) {
                    await this.tick(guildOptions, raid);
                }
            } catch (e) {
                console.error(raid ? '[worker] tick failed' : '[worker] active raid lookup failed', guildOptions.guild, raid?.name, e);
            } finally {
                this.ticking.delete(guildOptions.guild);
            }
        }
    }

    async processAuctions(guilds) {
        for (const guildOptions of guilds) {
            const activeAuctions = await this.manager.getActiveAuctions(guildOptions.guild);
            if (activeAuctions.length === 0) {
                continue;
            }

            const extraTimeBeforeReporting = 1000 * 60 * 20; //20 minutes
            const finishedActiveAuctions = activeAuctions.filter(auction => auction.auctionEnd < new Date().getTime() - extraTimeBeforeReporting);

            for (const auctionData of finishedActiveAuctions) {
                try {
                    //instantaite a new auction from ../Auctioner/Auction.js
                    const auction = new Auction(auctionData.guild, auctionData.item, auctionData.minBid, auctionData.numberOfItems, auctionData.minBidToLockForMain, auctionData.overBidtoWinMain);
                    auction.bids = auctionData.bids;
                    // A bidder who left / was never registered is dropped; any other error (DB down) aborts this
                    // auction's close so it is retried next cycle instead of closing with a wrong winner.
                    const players = (await Promise.all(auction.bids.map(bid => this.manager.getPlayer(auctionData.guild, bid.player, false).catch(e => {
                        if (e?.message === 'Player not found') return null;
                        throw e;
                    })))).filter(Boolean);
                    const w = auction.calculateWinner(players);
                    auctionData.winners = [];
                    if (w) {
                        auctionData.winners = w.length ? w : [w];
                    }
                    log('Auction ended', {
                        guild: auctionData.guild,
                        item: auctionData.item.name,
                        winners: auctionData.winners,
                    });
                    await this.manager.endAuction(guildOptions.guild, auctionData._id, auctionData.winners);
                    this.logger.updateLongAuctionEmbed(guildOptions, auctionData);
                } catch (e) {
                    console.error('[worker] auction close failed', guildOptions.guild, auctionData?._id, e);
                }
            }
        }
    }

    async runFastTasks() {
        const guilds = await this.manager.guildOptions.find({}).toArray();
        await this.processRaids(guilds);
    }

    async runMediumTasks() {
        const guilds = await this.manager.guildOptions.find({}).toArray();
        await this.processAuctions(guilds);
    }

    async runSlowTasks() {
        const guilds = await this.manager.guildOptions.find({}).toArray();
        await this.deprecateRaids(guilds);
    }
}