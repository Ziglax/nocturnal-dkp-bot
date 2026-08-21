// Mirrors console output into a size-rotated log file. Second sink only:
// stdout/stderr are untouched, Docker, Pterodactyl and Container Manager keep
// reading those.
//
// Why a file on top of stdout: `docker logs` dies with the container on every
// recreate, the Pterodactyl console keeps a short scrollback, and neither adds
// the timestamp the bot's console lines lack. logs/bot.log lives in the
// bind-mounted project folder, so it survives recreation and is readable from
// File Station / the panel file manager.
//
// Contract: install() never throws afterwards and console.* keep working
// whatever happens to the file. A failing write (disk full, unwritable folder)
// pauses the file sink for retryMs; the bot keeps logging to stdout and the
// failure itself goes to the original stderr. Appends are synchronous: a few
// microseconds on the local disk the bind mount lives on, and nothing buffered
// is lost when the process is killed. A live file deleted or moved from outside
// (File Station, logrotate) is noticed within a second and recreated.
//
// LOG_FILE env: path of the file, relative to the working directory
// (default logs/bot.log). Set it empty to disable file logging.
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const LEVELS = { log: 'INFO', info: 'INFO', warn: 'WARN', error: 'ERROR', debug: 'DEBUG' };
const LIVENESS_MS = 1000;

let installed = null;

const install = ({
    file = process.env.LOG_FILE === undefined ? 'logs/bot.log' : process.env.LOG_FILE,
    maxSize = 5 * 1024 * 1024,
    maxFiles = 5,
    retryMs = 60_000,
} = {}) => {
    if (installed) return installed;
    if (!file) return null;

    const target = path.resolve(file);
    const archives = Math.max(1, maxFiles - 1); // bot.log.1 ... bot.log.<archives>
    const originalError = console.error.bind(console); // unpatched: no recursion on failure
    let fd = null;
    let size = 0;
    let failedAt = 0;
    let checkedAt = 0;

    const close = () => {
        if (fd === null) return;
        try {
            fs.closeSync(fd);
        } catch (_) {}
        fd = null;
    };

    const open = () => {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fd = fs.openSync(target, 'a');
        size = fs.fstatSync(fd).size;
    };

    // bot.log -> bot.log.1 -> ... -> bot.log.<archives>, the oldest is dropped.
    // The live file is claimed first (-> bot.log.0): if that fails nothing has
    // been shifted yet, so a failed rotation never eats an archive; if the file
    // is already gone there is simply nothing to archive.
    const rotate = () => {
        close();
        const claimed = `${target}.0`;
        try {
            fs.renameSync(target, claimed);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            open();
            return;
        }
        fs.rmSync(`${target}.${archives}`, { force: true });
        for (let i = archives - 1; i >= 1; i--) {
            try {
                fs.renameSync(`${target}.${i}`, `${target}.${i + 1}`);
            } catch (_) {} // nothing to shift yet
        }
        fs.renameSync(claimed, `${target}.1`);
        open();
    };

    const write = (level, args) => {
        if (failedAt) {
            if (Date.now() - failedAt < retryMs) return;
            failedAt = 0;
        }
        try {
            const line = `${new Date().toISOString()} ${level.padEnd(5)} ${util.format(...args)}\n`;
            // Throttled liveness check: writes to a file unlinked from outside keep
            // succeeding (into an inode nobody can read), so failure alone can't tell.
            const now = Date.now();
            if (fd !== null && now - checkedAt >= LIVENESS_MS) {
                checkedAt = now;
                if (!fs.existsSync(target)) close();
            }
            if (fd === null) open();
            if (size > 0 && size + Buffer.byteLength(line) > maxSize) rotate();
            size += fs.writeSync(fd, line);
        } catch (error) {
            failedAt = Date.now();
            close();
            originalError(`[logfile] file logging paused for ${retryMs / 1000}s, cannot write ${target}:`, error?.code || error?.message || error);
        }
    };

    for (const [method, level] of Object.entries(LEVELS)) {
        const original = console[method].bind(console);
        console[method] = (...args) => {
            original(...args);
            write(level, args);
        };
    }

    installed = { file: target, close };
    return installed;
};

module.exports = { install };
