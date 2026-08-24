require('dotenv').config()
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const log = require('../debugger.js');

// Discord refuses a message body over 2000 characters. Splitting on line
// boundaries below that keeps a contested auction readable instead of failing.
const CHUNK_LIMIT = 1900;

const chunkLines = (text) => {
    const chunks = [];
    let current = '';
    for (const line of text.split('\n')) {
        // A single line longer than the limit has no newline to split on, so it
        // is cut rather than dropped - it cannot happen with the lines below.
        const piece = line.length > CHUNK_LIMIT ? line.slice(0, CHUNK_LIMIT) : line;
        if (current && current.length + piece.length + 1 > CHUNK_LIMIT) {
            chunks.push(current);
            current = piece;
        } else {
            current = current ? current + '\n' + piece : piece;
        }
    }
    if (current) {
        chunks.push(current);
    }
    return chunks;
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('auctiondetails')
        .setDescription('Show the details of a finished auction')
        .addStringOption(option => option.setName('auctionid').setDescription('The auction id').setRequired(true)),
    async execute(interaction, manager) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const guild = interaction.guild.id;
        const auctionid = interaction.options.getString('auctionid').trim();
        const guildConfig = await manager.getGuildOptions(interaction.guild.id) || {};

        if (process.env.LOG_LEVEL === 'DEBUG') {
            log(`Executed auctiondetails command`, {
                user: interaction.user.id,
                auctionid: auctionid,
            });
        }

        // ObjectId() throws a BSONError on anything that is not 24 hex characters,
        // which reached the officer as the generic "something went wrong".
        if (!/^[0-9a-f]{24}$/i.test(auctionid)) {
            await interaction.editReply({ content: '⛔ That does not look like an auction id. Copy the **Auction ID** from the auction message (24 hex characters).' });
            return;
        }

        const auction = await manager.getAuction(guild, auctionid).catch(error => {
            if (error?.message === 'Auction not found') {
                return null;
            }
            throw error;
        });
        if (!auction) {
            await interaction.editReply({ content: '⛔ No auction with that id in this server.' });
            return;
        }

        // A running auction must disclose nothing at all. Officers bid like everyone
        // else, so showing them the standing bids would let them outbid on
        // information no other bidder has.
        //
        // auctionActive is the only reliable marker: endAuction sets it together
        // with the winners in a single $set, and a short auction is inserted already
        // closed - so `false` also means no further bid can ever be recorded. The
        // comparison is deliberately strict, so a document that somehow lacks the
        // field is treated as running rather than finished.
        if (auction.auctionActive !== false) {
            await interaction.editReply({ content: '⛔ That auction is still running. `/auctiondetails` only works on finished auctions - a long auction is closed by the bot about 20 minutes after its end time, try again after that.' });
            return;
        }

        let message = `Auction details: ${auction.item.name} - ${auction._id}\n`;
        message += `Number of items: ${auction.numberOfItems}\n`;

        message += `Bids:\n`;
        if (auction.bids.length) {
            message += auction.bids.map(bid => `- <@${bid.player}> - ${bid.amount} - ${bid.bidForMain ? 'MAIN' : 'ALT'}`).join('\n') + '\n';
        } else {
            message += `No bids\n`;
        }

        message += `Winners:\n`;
        if (!Array.isArray(auction.winners)) {
            // Long auctions closed before May 2025 were closed without storing the
            // winners: say so rather than claim that nobody won.
            message += `Not recorded - this auction closed before the bot stored winners\n`;
        } else if (auction.winners.length) {
            message += auction.winners.map(winner => `- <@${winner.player}> - ${winner.amount} - ${winner.bidForMain ? 'MAIN' : 'ALT'}`).join('\n') + '\n';
        } else {
            message += `No winner\n`;
        }

        const chunks = chunkLines(message);
        await interaction.editReply({ content: chunks[0] });
        for (const chunk of chunks.slice(1)) {
            await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral });
        }

        // Posted last and only once the details actually reached the officer, so the
        // notice means exactly one thing: bids were shown. A refusal reveals nothing
        // and must not name an officer in public - and since a refusal invites a
        // retry, posting it earlier put one message in the channel per attempt.
        const auctionChannel = interaction.guild.channels.cache.get(guildConfig.auctionChannel);
        if (auctionChannel) {
            await auctionChannel.send({
                content: `<@${interaction.user.id}>` + " used `/auctiondetails` to peek under the hood :eyes: " + `\`${auction._id}\``,
                // The bot writes the mention, so without this it pings the officer.
                allowedMentions: { parse: [] },
            }).catch(error => console.error('[auctiondetails] peek notice failed', error?.code || '', error?.message || error));
        }
    },
    restricted: true,
};
