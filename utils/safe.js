// Crash-safe wrappers for Discord interaction handling.
// These never throw and never reject: a routine Discord error (10062 Unknown
// interaction, 40060 already acknowledged, 10008 Unknown Message, transient
// 5xx) must never kill the process.

// Error-path reply that routes on the interaction state. Do NOT call it after
// safeAck()/deferUpdate() on a component interaction: deferred=true routes to
// editReply, which overwrites the message the component belongs to. Use
// i.followUp({ ..., flags: MessageFlags.Ephemeral }) there instead.
const safeReply = async (interaction, payload) => {
    try {
        if (interaction.deferred) return await interaction.editReply(payload);
        if (interaction.replied) return await interaction.followUp(payload);
        return await interaction.reply(payload);
    } catch (error) {
        console.error('[safeReply]', error?.code || '', error?.message || error);
        return null;
    }
};

const safeAck = async (i) => {
    try {
        await i.deferUpdate();
        return true;
    } catch (error) {
        console.error('[safeAck]', error?.code || '', error?.message || error);
        return false;
    }
};

const guardListener = (name, fn) => async (...args) => {
    try {
        await fn(...args);
    } catch (error) {
        console.error(`[${name}]`, error);
    }
};

module.exports = { safeReply, safeAck, guardListener };
