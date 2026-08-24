const { joinVoiceChannel, createAudioPlayer, createAudioResource, entersState, StreamType, AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');
const path = require('node:path');
const fs = require('node:fs');

// A guild has exactly one voice connection: joinVoiceChannel() hands back the
// existing one instead of opening a second, and connection.subscribe() replaces
// the previous subscription. Two overlapping playSound() calls therefore fight
// over the same object: the first player silently loses its subscription and
// parks in AutoPaused (NoSubscriberBehavior.Pause) until the timeout, while a
// destroy() from either side tears the other's UDP socket down mid-handshake,
// which is what "Cannot perform IP discovery - socket closed" is. Plays are
// queued per guild so a call owns the connection for its whole lifetime.
const queues = new Map();

const READY_TIMEOUT_MS = 15_000; // gateway + UDP handshake, normally under a second
const PLAY_TIMEOUT_MS = 30_000; // hard backstop for the whole call
const GAP_MS = 500; // let a teardown reach the gateway before rejoining the guild

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Resolves when the sound has finished playing, rejects on any voice failure.
// Never leaves the connection behind, whichever way it ends.
const playOnce = async (guild, channelId, soundRelativePath) => {
    const channel = await guild.channels.fetch(channelId).catch((error) => {
        console.error('bell skipped, cannot fetch channel', channelId, error?.message || error);
        return null;
    });
    if (!channel) return;
    if (!channel.isVoiceBased()) {
        console.error('bell skipped, not a voice channel', channelId);
        return;
    }
    // Joining an empty channel costs a full handshake nobody can hear, and it is
    // the case most likely to hit a voice server the guild is not using.
    if (!channel.members.some((member) => !member.user.bot)) {
        console.log(`bell skipped, nobody in ${channel.name}`);
        return;
    }

    return new Promise((resolve, reject) => {
        let connection;
        let player;
        let settled = false;
        const onConnectionError = (error) => {
            // An error arriving after we are done is the teardown of a connection we
            // already gave up on. Still logged, but tagged, so it does not read as a
            // second failure.
            console.error(`voice connection error in ${channel.name}${settled ? ' (after completion)' : ''}:`, error?.message || error);
            done(error);
        };
        const done = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(t);
            try {
                connection?.off('error', onConnectionError);
            } catch (_) {}
            // stop(true) forces the Idle transition, which destroys the resource pipeline
            // (kills the ffmpeg child, closes the file descriptor) and removes the player from
            // the global audio cycle. connection.destroy() alone only unsubscribes: with the
            // default NoSubscriberBehavior.Pause the player would sit in AutoPaused forever.
            // The synchronous 'idle' this emits re-enters done() and is dropped by the guard above.
            try {
                player?.stop(true);
            } catch (_) {}
            try {
                connection?.destroy();
            } catch (_) {}
            err ? reject(err) : resolve();
        };
        const t = setTimeout(() => done(new Error(`playSound timeout in ${channel.name}`)), PLAY_TIMEOUT_MS);
        try {
            connection = joinVoiceChannel({
                channelId: channelId,
                guildId: guild.id,
                adapterCreator: guild.voiceAdapterCreator,
            });
            connection.on('error', onConnectionError);
            // Subscribing only once the connection is Ready: a player attached to a
            // connection still handshaking never reaches Idle, so the call would hang
            // until the 30s backstop instead of failing in 15.
            entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS)
                .then(() => {
                    if (settled) return;
                    player = createAudioPlayer();
                    player.on(AudioPlayerStatus.Idle, () => {
                        done();
                    });
                    player.on('error', (error) => {
                        console.error(`Error: ${error?.message} with resource ${error?.resource?.metadata}`);
                        done(error);
                    });
                    const resource = createAudioResource(fs.createReadStream(path.join(__dirname, soundRelativePath)), { inputType: StreamType.Arbitrary });
                    player.play(resource);
                    connection.subscribe(player);
                })
                .catch((error) => done(error));
        } catch (error) {
            console.error(error);
            done(error);
        }
    });
};

const playSound = (guild, channelId, soundRelativePath) => {
    const previous = queues.get(guild.id);
    const current = previous
        ? previous.then(() => wait(GAP_MS)).then(() => playOnce(guild, channelId, soundRelativePath))
        : playOnce(guild, channelId, soundRelativePath);
    // The queued tail swallows failures so one broken bell cannot cancel the next
    // one; the caller still gets its own rejection through `current`. The entry is
    // dropped once nothing else is waiting behind it.
    const tail = current.catch(() => {}).then(() => {
        if (queues.get(guild.id) === tail) queues.delete(guild.id);
    });
    queues.set(guild.id, tail);
    return current;
};

module.exports = {
    playSound
};
