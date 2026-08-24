const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const { safeReply } = require('./safe.js');
const { debitAuctionWinners } = require('./auctionDebit.js');

/**
 * Serves the Confirm DKP button of a closed long auction.
 *
 * A short auction confirms its winners through the message collector that opened
 * it, which works because it lives in memory for a few minutes. A long auction is
 * closed by the worker, days later and possibly after a restart, so there is no
 * collector left to own its button: index.js routes every `lconfirm_` button here
 * and the custom id carries the auction, exactly like the bid buttons do.
 *
 * Logger.updateLongAuctionEmbed only draws the button while a winner still owes
 * DKP, so a press should normally have work to do - but a second officer pressing
 * the stale copy of the message they already had open is expected, and harmless:
 * the debit is claimed on the auction document, so a winner who was already taken
 * comes back as 'already' rather than being charged twice.
 */
const handleLongAuctionConfirm = async (interaction, manager, logger) => {
    const guild = interaction.guildId;
    const auctionId = interaction.customId.slice('lconfirm_'.length);

    // The id is built by Logger.updateLongAuctionEmbed, so this only rejects a
    // hand-crafted one - which matters because ObjectId() throws on bad input.
    if (!guild || !/^[0-9a-f]{24}$/i.test(auctionId)) {
        await safeReply(interaction, { content: 'That confirm button is malformed. Take the DKP with `/removedkp`.', flags: MessageFlags.Ephemeral });
        return;
    }

    // Before any database read: everything below is several round trips and the
    // reply window is 3 seconds.
    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (e) {
        console.error('[long auction confirm] could not defer the reply', interaction.user.id, e?.code || '', e?.message || e);
        return;
    }

    const guildConfig = await manager.getGuildOptions(guild).catch((e) => {
        console.error('[long auction confirm] guild options lookup failed', guild, e?.message || e);
        return null;
    });

    // The same gate index.js puts on a restricted command: guild administrators
    // bypass the officer role, which may not even be configured. This button takes
    // DKP from other people, so it cannot be left open to the channel.
    const isOfficer = interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)
        || (guildConfig?.adminRole && interaction.member?.roles?.cache?.has(guildConfig.adminRole));
    if (!isOfficer) {
        await safeReply(interaction, { content: `You don't have the permission to confirm an auction`, flags: MessageFlags.Ephemeral });
        return;
    }

    try {
        const auction = await manager.getAuction(guild, auctionId);
        if (auction.auctionActive) {
            await safeReply(interaction, { content: 'That auction is still running, so there is nothing to confirm yet.', flags: MessageFlags.Ephemeral });
            return;
        }

        const winners = auction.winners || [];
        if (!winners.length) {
            await safeReply(interaction, { content: 'That auction closed without a winner, so there is nothing to take.', flags: MessageFlags.Ephemeral });
            return;
        }

        // Whatever raid is running right now, which is the raid a manual /removedkp
        // would have logged the debit against. Usually none: a long auction is
        // confirmed days after the raid the item dropped in.
        const raid = await manager.getActiveRaid(guild).catch((e) => {
            console.error('[long auction confirm] active raid lookup failed', guild, e?.message || e);
            return null;
        });

        const report = await debitAuctionWinners(manager, guild, auction, winners, raid);

        // Re-read before redrawing: the recap has to name who is actually recorded as
        // debited on the auction, not who this run believes it took. That also picks
        // up a winner another officer confirmed a second earlier.
        const fresh = await manager.getAuction(guild, auctionId).catch((e) => {
            console.error('[long auction confirm] could not re-read the auction for its recap', auctionId, e?.message || e);
            return null;
        });
        if (fresh) {
            await logger.updateLongAuctionEmbed(guildConfig || {}, fresh, report);
        }

        const debited = report.filter(entry => entry.status === 'debited');
        const already = report.filter(entry => entry.status === 'already');
        const failed = report.filter(entry => entry.status !== 'debited' && entry.status !== 'already');
        const lines = [];
        if (debited.length) {
            lines.push(`Taken: ${debited.map(entry => `<@${entry.player}> (${entry.amount} DKP)`).join(', ')}`);
        }
        if (already.length) {
            lines.push(`Already settled: ${already.map(entry => `<@${entry.player}>`).join(', ')}`);
        }
        if (failed.length) {
            lines.push(`:warning: Not taken: ${failed.map(entry => `<@${entry.player}> (${entry.amount} DKP, ${entry.status === 'insufficient' ? 'balance too low' : 'the write failed'})`).join(', ')} - press Confirm again, or use \`/removedkp\`.`);
        }

        await safeReply(interaction, { content: lines.join('\n') || 'Nothing to do.', flags: MessageFlags.Ephemeral });
    } catch (error) {
        console.error('[long auction confirm] failed', auctionId, error?.message || error);
        await safeReply(interaction, { content: `:prohibited: ${error?.message || 'The confirmation failed'}. Nothing else was taken - check \`/dkphistory\` before retrying.`, flags: MessageFlags.Ephemeral });
    }
};

module.exports = { handleLongAuctionConfirm };
