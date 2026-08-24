const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags } = require('discord.js');
const uniqid = require('uniqid');
const { safeReply } = require('./safe.js');
const log = require('../debugger.js');

/**
 * Serves the Main bid / Alt bid buttons of a long auction.
 *
 * Short auctions drive their buttons from a message collector, which works
 * because they live in memory and last minutes. A long auction lasts days, lives
 * in Mongo and survives a restart - after which no collector exists any more, so
 * its buttons would go dead. index.js routes every `lbid_` button here instead,
 * and the custom id carries the whole context: `lbid_<side>_<auctionId>`.
 */
const handleLongAuctionBid = async (interaction, manager) => {
    const guild = interaction.guildId;
    const [, side, auctionId] = interaction.customId.split('_');
    const forMain = side === 'main';

    // The ids are built by Logger.sendLongAuctionEmbed, so this only rejects a
    // hand-crafted one - which matters because ObjectId() throws on bad input.
    if (!guild || !/^[0-9a-f]{24}$/i.test(auctionId || '')) {
        await safeReply(interaction, { content: 'That bid button is malformed. Use `/auctiondetails` to look the auction up.', flags: MessageFlags.Ephemeral });
        return;
    }

    // The item name is already on the message the button sits on, so the modal
    // can name it without a database read - showModal only has a 3 second window.
    const itemName = (interaction.message?.embeds?.[0]?.title || 'this item').replace(/ #\d+$/, '');

    // A fresh id per click keeps two modals from ever answering each other.
    const modalId = 'lbidmodal_' + uniqid();
    const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle(`Bid on ${itemName}`.slice(0, 45))
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('amount')
                .setLabel(`${forMain ? 'MAIN' : 'ALT'} bid amount in DKP`)
                .setPlaceholder('Enter 0 to remove your bid')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(10)
        ));

    try {
        // A modal must be the first response to the interaction, so this path
        // must not defer or acknowledge it beforehand.
        await interaction.showModal(modal);
    } catch (e) {
        console.error('[long auction bid] could not open the bid modal', interaction.user.id, e?.code || '', e?.message || e);
        return;
    }

    // Capped at the 15 minutes Discord keeps a modal open. The auction end is not
    // pre-checked: manager.bid already refuses a late bid with 'Auction has ended',
    // and one round trip less keeps this path short. A dismissed modal rejects
    // here, which is not an error - it resolves to null and the click is dropped.
    const submitted = await interaction.awaitModalSubmit({
        time: 15 * 60 * 1000,
        filter: m => m.customId === modalId && m.user.id === interaction.user.id,
    }).catch(() => null);
    if (!submitted) {
        return;
    }

    const raw = submitted.fields.getTextInputValue('amount').trim();
    // Deliberately stricter than parseInt, which silently read "50abc" as 50.
    const amount = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
    if (Number.isNaN(amount)) {
        await safeReply(submitted, { content: `\`${raw}\` is not a number. Bid again with a whole number of DKP, or 0 to remove your bid.`, flags: MessageFlags.Ephemeral });
        return;
    }

    // Same message as the /bid command this replaced, so an existing debuglog
    // query keeps returning long auction bids.
    if (process.env.LOG_LEVEL === 'DEBUG') {
        log(`Executed command bid`, {
            user: interaction.user.id,
            item: itemName,
            dkps: amount,
        });
    }

    // Where a short auction answers from memory, every branch below is two or
    // three Mongo round trips - defer so the 3 second reply window cannot lapse.
    try {
        await submitted.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (e) {
        console.error('[long auction bid] could not defer the reply', interaction.user.id, e?.code || '', e?.message || e);
        return;
    }

    try {
        // No attendance needed here, and it is the expensive half of getPlayer.
        const player = await manager.getPlayer(guild, interaction.user.id, false);

        if (amount === 0) {
            const result = await manager.removeBid(guild, auctionId, player);
            await safeReply(submitted, { content: result?.modifiedCount ? `Bid removed on **${itemName}**` : `You had no bid to remove on **${itemName}**`, flags: MessageFlags.Ephemeral });
            return;
        }

        await manager.bid(guild, auctionId, amount, player, forMain);
        // Name the item and the side: a bidder juggling several auctions at once
        // could not tell which one an unqualified "Bid placed" answered.
        await safeReply(submitted, { content: `${forMain ? 'MAIN' : 'ALT'} bid of **${amount} DKP** placed on **${itemName}**`, flags: MessageFlags.Ephemeral });
    } catch (e) {
        await safeReply(submitted, { content: e.message, flags: MessageFlags.Ephemeral });
    }
};

module.exports = { handleLongAuctionBid };
