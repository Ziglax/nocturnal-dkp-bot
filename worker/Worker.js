const Logger = require('../utils/Logger');
const { lockDelayOf } = require('../utils/auctionDebit.js');
const { closeLongAuction } = require('../utils/auctionClose.js');

module.exports = class Worker {
    constructor(client, manager) {
        this.client = client;
        this.manager = manager;
        this.logger = new Logger(client);
        this.ticking = new Set();
        this.auctioning = new Set();
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
            // The same shape as the raid tick guard, and held across the read for the
            // same reason: the medium tick fires every minute, and a block of long
            // auctions closing together takes as long as it takes. Without this, the
            // next tick reads the very same auctions - still active, because the first
            // tick has not reached them yet - and closes them twice. endAuction is a
            // compare-and-swap now, so the loser refuses rather than pays twice; the
            // guard is what stops it re-reading every bidder to arrive at that refusal.
            if (this.auctioning.has(guildOptions.guild)) {
                console.log(`[worker] auction close skipped, previous close still running for guild ${guildOptions.guild}`);
                continue;
            }
            this.auctioning.add(guildOptions.guild);
            try {
                const activeAuctions = await this.manager.getActiveAuctions(guildOptions.guild);
                if (activeAuctions.length === 0) {
                    continue;
                }

                // A finished auction keeps its results hidden for its lock delay before
                // the bot closes it and publishes the winners. Blocks of offline auctions
                // are run side by side, and revealing the first results while the last
                // auctions are still open would tell the remaining bidders exactly what
                // to bid. Per-auction since /startlongbid gained its lockdelay option;
                // an auction started before it keeps the twenty minutes it ran under.
                const now = new Date().getTime();
                const finishedActiveAuctions = activeAuctions.filter(auction => auction.auctionEnd + lockDelayOf(auction) < now);

                for (const auctionData of finishedActiveAuctions) {
                    // One auction failing does not stop the block: they are independent,
                    // and the next tick picks this one up again. A close that lost the race
                    // to /cancelauction or to /endauction arrives here too, as the throw
                    // from endAuction.
                    await closeLongAuction(this.manager, this.logger, guildOptions, auctionData)
                        .catch(e => console.error('[worker] auction close failed', guildOptions.guild, auctionData?._id, e));
                }
            } catch (e) {
                console.error('[worker] active auction lookup failed', guildOptions.guild, e);
            } finally {
                this.auctioning.delete(guildOptions.guild);
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