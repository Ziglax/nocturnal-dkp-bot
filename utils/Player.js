const { joinVoiceChannel, createAudioPlayer, createAudioResource, entersState, StreamType, AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');
const path = require('node:path');
const fs = require('node:fs');

const playSound = async (guild, channelId, soundRelativePath) => {
    return new Promise((resolve, reject) => {
        let connection;
        let player;
        let settled = false;
        const done = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(t);
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
        const t = setTimeout(() => done(new Error('playSound timeout')), 30_000);
        try {
            connection = joinVoiceChannel({
                channelId: channelId,
                guildId: guild.id,
                adapterCreator: guild.voiceAdapterCreator,
            });
            connection.on('error', (error) => {
                console.error('voice connection error', error);
                done(error);
            });
            player = createAudioPlayer();
            const resource = createAudioResource(fs.createReadStream(path.join(__dirname, soundRelativePath)), { inputType: StreamType.Arbitrary });
            player.play(resource);
            connection.subscribe(player);

            player.on(AudioPlayerStatus.Idle, () => {
                done();
            });

            player.on('error', error => {
                console.error(`Error: ${error?.message} with resource ${error?.resource?.metadata}`);
                done(error);
            });
        } catch (error) {
            console.error(error);
            done(error);
        }
    });
}

module.exports = {
    playSound
};