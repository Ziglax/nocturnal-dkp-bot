// scrub-dev.js — run with:
//   mongosh "mongodb://127.0.0.1:27018/DKP" --file tools/scrub-dev.js
//
// Scrubs secrets from a DEV copy of the DKP database (see docs/ovh-migration.md §10).
//
// Field NAMES and TYPES are preserved: a field is only ever overwritten if it
// already exists, so the document schema the roster website reads is unchanged.
//
// This is SECRET SCRUBBING, not anonymisation. Character names, log comments and
// item text are deliberately left intact so the dev data stays realistic. Treat
// the resulting database as confidential.

// ---------------------------------------------------------------- configuration

const EXPECTED_DB = 'DKP';
const ALLOWED_PORTS = [27018, 27019];   // deliberately NOT 27017

// REQUIRED. The production dump is multi-guild (worker/Worker.js iterates
// guildOptions.find({})). Every document belonging to another guild is DELETED
// before anything is remapped — without this pass the remapping below would
// collapse several guilds into one and silently merge their players and raids.
// Set this to the real production guild snowflake you want to keep in dev.
const KEEP_GUILD = 'PUT-THE-REAL-PROD-GUILD-SNOWFLAKE-HERE';

const DEV_GUILD = '000000000000000001'; // <- your TEST guild snowflake
const DUMMY_OPTION_IDS = {
    raidChannel: '000000000000000010',
    secondRaidChannel: '000000000000000011',
    logChannel: '000000000000000012',
    auctionChannel: '000000000000000013',
    longAuctionChannel: '000000000000000014',
    adminRole: '000000000000000015',
};
const DUMMY_API_KEY = 'dev-dummy-raidhelper-key';

// ---------------------------------------------------------------- safety guards

let host = '';
let port = null;
try {
    const ss = db.serverStatus();
    host = ss.host || '';
    const m = /:(\d+)$/.exec(host);
    if (m) port = parseInt(m[1], 10);
} catch (e) {
    print('could not read serverStatus(): ' + e.message);
}
if (port === null) {
    try {
        port = db.adminCommand({ getCmdLineOpts: 1 }).parsed.net.port;
    } catch (e) {
        print('could not read getCmdLineOpts: ' + e.message);
    }
}

if (/mongodb\.net/i.test(host)) {
    throw new Error('ABORT: connected to an Atlas host (' + host + '). This script is for the LOCAL dev copy only.');
}
if (port === null) {
    throw new Error('ABORT: could not determine the server port. Refusing to run.');
}
if (ALLOWED_PORTS.indexOf(port) === -1) {
    throw new Error('ABORT: port ' + port + ' is not in the allow-list [' + ALLOWED_PORTS.join(', ') + ']. Refusing to run.');
}
if (db.getName() !== EXPECTED_DB) {
    throw new Error('ABORT: connected to database "' + db.getName() + '", expected "' + EXPECTED_DB + '".');
}
if (!/^\d{17,20}$/.test(KEEP_GUILD)) {
    print('');
    print('Guilds present in this copy (options collection):');
    db.options.distinct('guild').forEach(function (g) {
        print('  ' + g +
            '   players=' + db.players.countDocuments({ guild: g }) +
            ' raids=' + db.raids.countDocuments({ guild: g }) +
            ' auctions=' + db.auctions.countDocuments({ guild: g }));
    });
    print('');
    throw new Error('ABORT: KEEP_GUILD is not set to a guild snowflake. Pick one from the list above and edit this file.');
}

print('Scrubbing ' + db.getName() + ' on ' + host + ' (port ' + port + ')');
print('Keeping guild ' + KEEP_GUILD + ', dropping every other guild.');

// ---------------------------------------------------------------- 0. drop other guilds
// MUST run before any remapping: after step 1 every guild field reads DEV_GUILD
// and the guilds are no longer distinguishable.

['options', 'players', 'raids', 'auctions'].forEach(function (c) {
    const r = db[c].deleteMany({ guild: { $ne: KEEP_GUILD } });
    print(c + ': dropped ' + r.deletedCount + ' documents belonging to other guilds');
});

if (db.options.countDocuments({ guild: KEEP_GUILD }) === 0) {
    throw new Error('ABORT: no options document left for guild ' + KEEP_GUILD + '. Wrong snowflake? The copy is now empty — restore the dump and try again.');
}

// ---------------------------------------------------------------- 1. options

let optionsTouched = 0;
db.options.find({}).forEach(function (doc) {
    const set = {};
    // only overwrite fields that ALREADY exist -> schema unchanged
    if (Object.prototype.hasOwnProperty.call(doc, 'raidHelperAPIKey') && doc.raidHelperAPIKey !== null) {
        set.raidHelperAPIKey = DUMMY_API_KEY;
    }
    Object.keys(DUMMY_OPTION_IDS).forEach(function (field) {
        if (Object.prototype.hasOwnProperty.call(doc, field) && doc[field] !== null) {
            set[field] = DUMMY_OPTION_IDS[field];
        }
    });
    if (Object.prototype.hasOwnProperty.call(doc, 'guild')) set.guild = DEV_GUILD;
    if (Object.keys(set).length) {
        db.options.updateOne({ _id: doc._id }, { $set: set });
        optionsTouched++;
    }
});
print('options scrubbed: ' + optionsTouched);

// ---------------------------------------------------------------- 2. pseudonymise Discord user ids
// players.player and auctions.bids[].player are Discord user snowflakes.
// Map each real id to a stable fake 18-digit snowflake so the string type,
// the field, and the cross-collection joins all survive.
// NB: build the fake id as a STRING. An 18-digit snowflake is far beyond
// Number.MAX_SAFE_INTEGER (9007199254740991), so a numeric counter would
// silently hand every player the same id and merge them all into one.

const idMap = {};
let idCounter = 0;
function fakeId(real) {
    if (!Object.prototype.hasOwnProperty.call(idMap, real)) {
        idCounter++;
        idMap[real] = '1000000000000' + String(idCounter).padStart(5, '0'); // 18 digits
    }
    return idMap[real];
}

let playersTouched = 0;
db.players.find({}).forEach(function (doc) {
    const set = {};
    if (typeof doc.player === 'string') set.player = fakeId(doc.player);
    if (Object.prototype.hasOwnProperty.call(doc, 'guild')) set.guild = DEV_GUILD;
    if (Object.keys(set).length) {
        db.players.updateOne({ _id: doc._id }, { $set: set });
        playersTouched++;
    }
});
print('players scrubbed: ' + playersTouched + ' (' + Object.keys(idMap).length + ' distinct discord ids remapped)');

// ---------------------------------------------------------------- 3. raids

let raidsTouched = 0;
db.raids.find({}).forEach(function (doc) {
    const set = {};
    if (Object.prototype.hasOwnProperty.call(doc, 'guild')) set.guild = DEV_GUILD;
    if (Array.isArray(doc.attendance)) {
        let changed = false;
        const attendance = doc.attendance.map(function (entry) {
            if (entry && Array.isArray(entry.players)) {
                changed = true;
                entry.players = entry.players.map(function (p) {
                    return typeof p === 'string' ? fakeId(p) : p;
                });
            }
            return entry;
        });
        if (changed) set.attendance = attendance;
    }
    if (Object.keys(set).length) {
        db.raids.updateOne({ _id: doc._id }, { $set: set });
        raidsTouched++;
    }
});
print('raids scrubbed: ' + raidsTouched);

// ---------------------------------------------------------------- 4. auctions

let auctionsTouched = 0;
db.auctions.find({}).forEach(function (doc) {
    const set = {};
    if (Object.prototype.hasOwnProperty.call(doc, 'guild')) set.guild = DEV_GUILD;
    if (Object.prototype.hasOwnProperty.call(doc, 'messageId') && doc.messageId !== null) {
        set.messageId = '000000000000000099';
    }
    if (Array.isArray(doc.bids)) {
        set.bids = doc.bids.map(function (bid) {
            if (bid && typeof bid.player === 'string') bid.player = fakeId(bid.player);
            return bid;
        });
    }
    if (Array.isArray(doc.winners)) {
        set.winners = doc.winners.map(function (w) {
            if (w && typeof w.player === 'string') w.player = fakeId(w.player);
            return w;
        });
    }
    if (Object.keys(set).length) {
        db.auctions.updateOne({ _id: doc._id }, { $set: set });
        auctionsTouched++;
    }
});
print('auctions scrubbed: ' + auctionsTouched);

// ---------------------------------------------------------------- 5. debuglog
// Free-form {title, info, createdAt} - info can contain ids and comments, and it
// has no guild field so it cannot be filtered per guild. Drop it in the dev copy.

const debugCount = db.debuglog.countDocuments();
if (debugCount > 0) {
    db.debuglog.drop();
    print('debuglog dropped (' + debugCount + ' documents)');
} else {
    print('debuglog empty or absent');
}

print('--- scrub complete ---');
