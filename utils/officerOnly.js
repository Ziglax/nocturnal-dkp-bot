const { PermissionFlagsBits } = require('discord.js');

// index.js lets any guild Administrator through every `restricted: true` command,
// because /configure has to be usable before an officer role exists to check
// against. The auction commands are where that bypass is wrong: cancelling or
// force-closing an auction moves DKP and cannot be undone, and the guild already
// said who may do that when it set adminRole. An administrator who is not an
// officer is told no.
//
// The one exception is a guild with no adminRole configured at all. There the
// bypass is the only key in existence, and applying the rule literally would
// leave a 48 hour auction with nothing able to stop it.
//
// Optional chaining the whole way down: this reads the member object Discord
// attached to the interaction, and a partial member has caught this codebase out
// before.
const isOfficer = (member, guildConfig) => {
    const officerRole = guildConfig?.adminRole;
    if (!officerRole) {
        return Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator));
    }

    return Boolean(member?.roles?.cache?.has(officerRole));
};

module.exports = { isOfficer };
