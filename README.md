# Nocturnal DKP Bot

A Discord bot that runs a DKP (Dragon Kill Points) system for an EverQuest guild: raid attendance ticks, loot auctions, manual adjustments, history and backups — all through slash commands, backed by MongoDB.

Item lookups target the [Project Quarm](https://www.pqdi.cc) and [TAKP](https://www.takproject.net/allaclone/) databases. Optional integration with [Raid-Helper](https://raid-helper.dev) rewards players who signed up for the event *and* attended.

This is a fork of the `dkpbot` written by Alberto Casado Torres, hardened for 24/7 operation (crash safety nets, file logging) and packaged for Docker / Synology Container Manager.

## Table of contents

- [How it works](#how-it-works)
- [Commands](#commands)
  - [Setup](#setup)
  - [Raids](#raids)
  - [DKP adjustments](#dkp-adjustments)
  - [Auctions](#auctions)
  - [Lookups](#lookups)
  - [Backup](#backup)
- [Configuration](#configuration)
  - [Server configuration (`/configure`)](#server-configuration-configure)
  - [Environment variables (`.env`)](#environment-variables-env)
  - [Discord application setup](#discord-application-setup)
  - [First run in a server](#first-run-in-a-server)
- [Deployment](#deployment)
  - [Requirements](#requirements)
  - [Option A — Docker Compose (bot + MongoDB)](#option-a--docker-compose-bot--mongodb)
  - [Option B — Synology NAS (Container Manager)](#option-b--synology-nas-container-manager)
  - [Option C — Bot only, MongoDB Atlas](#option-c--bot-only-mongodb-atlas)
  - [Option D — Bare metal](#option-d--bare-metal)
  - [Migrating to an OVH VPS](#migrating-to-an-ovh-vps)
  - [Updating](#updating)
  - [Slash command registration](#slash-command-registration)
  - [Logs](#logs)
  - [Database and backups](#database-and-backups)
  - [Tests](#tests)
- [Known limitations](#known-limitations)
- [Credits and license](#credits-and-license)

## How it works

**Players and DKP.** Every Discord member gets one player record per server, holding a DKP balance and a log of every movement (amount, reason, date, raid, item). The record is created the first time the member gains or loses DKP; players can attach their EverQuest character names to it with `/registercharacter`.

**Raids and attendance.** An officer runs `/startraid`; everyone in the configured raid voice channel(s) gets the *Start* DKP. From then on the bot **ticks** every `tickduration` minutes: each member currently in the raid channel(s) receives `dkpspertick` DKP and an attendance snapshot is recorded. `/endraid` takes a last snapshot (no DKP) and posts a summary in the log channel: one line per Start / tick / `/addraiddkp` / End snapshot, plus the loot won and the DKP removed with `/removedkp` during the raid (`/adddkp` additions are not linked to raids and do not appear). Attendance % shown by `/listplayersdkps` = snapshots that include the player ÷ snapshots taken since the player's record was created (their first DKP movement), over the raids of the last `raiddeprecationtime` days (older raids are flagged *deprecated* by an hourly job). A player with no possible snapshot yet shows 100 %.

**Auctions.** Two flavours:

- **Short auction** (`/startbid`) — lives in memory for `bidtime` seconds. The bot posts the item in the auction channel with *Main bid* / *Alt bid* / *Cancel* buttons and rings a bell in the raid channel(s). Clicking a bid button opens a Discord form asking for the amount; entering **0** withdraws the bid. At the end the winners are announced and the officer who started it presses **Confirm Winner/s** (within 6 minutes) to debit the DKP.
- **Long auction** (`/startlongbid`) — stored in the database, runs for N hours. The bot posts the item in the long auction channel with the same *Main bid* / *Alt bid* buttons and form as a short auction; players bid until the end time; the bot closes it `lockdelay` minutes later (20 by default) and edits the original auction post with the winners, their bids and whether their DKP was taken (no new message, nobody is pinged). At close every bid is re-checked against the bidder's balance at that moment: a bid the player can no longer cover (e.g. after winning a short auction meanwhile) is dropped silently. Winners are debited automatically when the auction closes, unless it was started with `autodebit: false` — then the closed post carries a **Confirm DKP** button for officers instead.

  The `lockdelay` is not a grace period: blocks of offline auctions are run side by side, and publishing the first winners while the last auctions are still open would tell the remaining bidders exactly what to bid. Bids can neither be placed nor withdrawn during it. Set `lockdelay: 0` for a single auction that should be settled as soon as it ends.

Main vs alt bids: a bid flagged *main* only counts as main if it reaches `minbidtolockformain`; an alt bid can still beat main bids when it exceeds the highest main bid by `overbidtowinmain`. Main bids win first, alt bids fill the remaining items; equal bids are split at random.

**Raid-Helper.** With `raidhelperapikey` configured, `/startraid` looks for a Raid-Helper event starting within ±10 minutes and — **only when no `name` was given** — links it to the raid (the event title becomes the raid name). On `/endraid` the bot automatically awards **5 DKP** to players who signed up (not Absence/Bench) and were present in enough attendance snapshots. A raid started with an explicit `name` is not linked and gets no automatic bonus; `/addraideventdkp` runs the same check manually with any amount, including after the fact.

**Permissions.** Officer commands require either the **Administrator** permission or the role set with `/configure role` (the *officer role*). `/configure`, `/showconfig` and `/backup` are hidden from non-administrators by default on the Discord side (changeable in *Server Settings → Integrations*); `/configure` is also an officer command, but `/showconfig` and `/backup` have no bot-side check, so anyone granted them in Integrations can run them. All commands must be used inside a server, not in DMs.

## Commands

`<option>` = required, `[option]` = optional. "Officer" = administrator or member of the configured officer role.

### Setup

| Command | Who | What it does |
| --- | --- | --- |
| `/configure <role> <raidchannel> <logchannel> <auctionchannel> [tickduration] [raiddeprecationtime] [bidtime] [longauctionchannel] [secondraidchannel] [minbidtolockformain] [overbidtowinmain] [minbid] [raidhelperapikey]` | Administrator (officer role once set) | Saves the server configuration. The four required options must be supplied on **every** call. Omitted numbers/text keep their stored value, but an omitted `secondraidchannel` or `longauctionchannel` is **cleared** — repeat them each time. See [Server configuration](#server-configuration-configure). |
| `/showconfig` | Administrator (Discord default) | Posts the current configuration as a public embed (the Raid-Helper key is never shown). |

### Raids

| Command | Who | What it does |
| --- | --- | --- |
| `/startraid [name] [dkpspertick] [tickduration]` | Officer | Starts a raid. `dkpspertick` defaults to 1; `tickduration` (minutes, decimals allowed) defaults to the configured value, else 6. Everyone in the raid channel(s) gets the Start DKP; a green embed is posted in the log channel. `name` defaults to the Raid-Helper event title when one is detected, otherwise to today's date; giving a `name` skips the Raid-Helper link (no automatic 5 DKP at `/endraid` — use `/addraideventdkp` afterwards). Only one raid can be active per server. |
| `/endraid` | Officer | Ends the active raid, takes a final attendance snapshot and posts the raid summary (snapshots, loot, `/removedkp` removals) with the raid ID. Runs the Raid-Helper 5 DKP bonus if the raid was linked to an event. |
| `/addraiddkp <dkp> <comment>` | Officer | Gives `dkp` to every member currently in the raid voice channel (main channel only) and records an attendance snapshot. Requires an active raid. |
| `/addraideventdkp <dkp> <raidid> <eventid>` | Officer | Awards `dkp` to players who signed up to Raid-Helper event `eventid` and attended raid `raidid` (the ID printed by `/endraid`). A player is eligible when present in at least `min(10, floor(unique attendees / 2))` snapshots (never less than 1). Posts a report (rewarded / not enough attendance / not subscribed / not attended) in the log channel. Use `dkp` = 0 to get the report only. Not idempotent. |

### DKP adjustments

| Command | Who | What it does |
| --- | --- | --- |
| `/adddkp <player> <dkp> <comment>` | Officer | Adds `dkp` (≥ 1) to a player with a reason. Public confirmation in the channel. |
| `/removedkp <player> <dkp> <comment>` | Officer | Removes `dkp` (≥ 1) from a player. Linked to the active raid if any, so it shows up in the raid summary. Balances may go negative. |

### Auctions

| Command | Who | What it does |
| --- | --- | --- |
| `/startbid <search> [minbid] [numitems] [database]` | Officer | Short auction. Searches the item (name or numeric id) in `database` (`quarm` default, or `takp`), lets you pick it with buttons if several match (up to 25; 26–40 matches are only listed with their ids, more asks you to refine the search), then shows a **Start Auction** button (30 s). The auction runs `bidtime` seconds in the auction channel with bid buttons and a bell in the raid channel(s). When it ends, the winners are shown with a **Confirm Winner/s** button (officer who started it, 6 minutes): confirming debits the DKP with the item name as reason. `minbid` defaults to the configured minimum bid (`0` also means "use the configured value"); `numitems` (default 1) = how many top bids win. The **Cancel** button is limited to members of the officer role. |
| `/startlongbid <search> [minbid] [numitems] [duration] [autodebit] [lockdelay] [database]` | Officer | Same item search and **Start Auction** button as `/startbid`; the auction is created when the button is pressed and stored in the database, open for `duration` hours (default 48). Posted in the long auction channel (falls back to the auction channel) with its **Auction ID** and *Main bid* / *Alt bid* buttons. Closed by the bot `lockdelay` minutes after the end (default 20, 0-1440); the embed is updated with the winners and a **DKP** field saying, for each of them, whether their DKP was taken. `autodebit` (default true) takes it automatically at close; with `autodebit: false` the closed embed keeps a **Confirm DKP** button instead. Both options are per auction and are read when the command is typed, not when the **Start Auction** button is pressed. |
| `/auctiondetails <auctionid>` | Officer | Shows the bids and winners of a **finished** auction (ephemeral, split over several messages if long). A running auction is refused: officers bid too, so the standing bids of a live auction are shown to nobody. A long auction only becomes readable once the bot closes it, `lockdelay` minutes after its end time (20 by default). Short auctions are readable as soon as they end (their Auction ID is printed on the winners embed; cancelled ones are not stored). Once the details have been shown, the auction channel gets a public notice that you peeked — nothing is posted when the command refuses. |

Bidding works the same way on both kinds of auction: click *Main bid* or *Alt bid* on the auction message and a Discord form asks for the amount. It works whether or not the player has DMs open. The form belongs to the auction whose button was clicked, so several auctions can run side by side without an amount landing on the wrong item. Discord only allows one form open at a time, so clicking a second bid button replaces the first form; the abandoned auction is left untouched and can be bid on afterwards. Entering `0` withdraws the bid, and bidding again replaces it. The amount must be a whole number, at most your current DKP and at least the minimum bid. Per auction it is either a main or an alt bid, never both. Bidders must already have a player record.

The buttons of a long auction keep working across a bot restart — unlike a short auction, it is stored in the database and its buttons are answered from the auction id they carry rather than by a listener that would die with the process. They disappear when the bot closes the auction, replaced by a **Confirm DKP** button when a winner still owes DKP. That button is restricted to administrators and the officer role, survives a restart the same way, and is safe to press twice: each winner is claimed on the auction document before their DKP is written, so nobody is charged twice — and it disappears once every winner has paid.

### Lookups

| Command | Who | What it does |
| --- | --- | --- |
| `/playerdkp [player]` | Everyone | Current DKP of a player (you by default). Ephemeral. |
| `/dkphistory [player]` | Everyone | Full DKP history of a player, newest first, consecutive ticks of a raid aggregated. Paginated (30 lines) with buttons, ephemeral. |
| `/listplayersdkps` | Everyone | Ranking of active players (at least one movement in the last `raiddeprecationtime` days) with DKP and attendance %, 10 per page. Not available while a raid is active. |
| `/searchlogs <search>` | Everyone | Searches every log entry of the server whose reason matches `search` (case-insensitive, regex allowed). Loot is logged with the item name as reason, so searching an item shows who won it and for how much. A search term containing `tick` is refused (raid ticks cannot be listed — nor items whose name contains it); tick entries still appear when a broader pattern matches them. |
| `/searchitem <search> [database]` | Everyone | Looks an item up by name or id in `quarm` (default) or `takp` and posts its stats. Up to 25 matches can be picked with buttons. |
| `/registercharacter <name>` | Everyone | Adds an EverQuest character name to the `characters` list of your own player record, creating the record if you have none yet. A name can only be registered once per server. **Nothing in the bot reads that list any more** — its only consumer, `/parsedkps`, was removed; the command is kept for whatever reads the database directly. |

### Backup

| Command | Who | What it does |
| --- | --- | --- |
| `/backup` | Administrator (Discord default) | Exports the server's `players` and `raids` collections as JSON and posts them as `backup.zip` **in the channel where the command is run** (the files also stay in `./backups/` on the host). Configuration and auctions are not included. |

## Configuration

### Server configuration (`/configure`)

Stored per Discord server in the `options` collection. Values are set with `/configure` and shown with `/showconfig` (except `raidhelperapikey`, which is never displayed).

| Option | Type | Default | Used by |
| --- | --- | --- | --- |
| `role` | Role (required) | — | The officer role allowed to run raid, DKP and auction commands. |
| `raidchannel` | Voice channel (required) | — | Attendance: who is in it at Start and at each tick gets DKP (`/endraid` only records who is there). Also the channel `/addraiddkp` pays, and where the auction bell plays. |
| `logchannel` | Text channel (required) | — | Raid start/tick/end embeds, `/addraiddkp` and Raid-Helper reports. |
| `auctionchannel` | Text channel (required) | — | Short auctions (`/startbid`) and the `/auctiondetails` notice (only posted when details were actually shown). |
| `secondraidchannel` | Voice channel | none | Second voice channel counted for attendance (Start, ticks, End — not `/addraiddkp`). Must differ from `raidchannel`. |
| `longauctionchannel` | Text channel | `auctionchannel` | Where long auctions (`/startlongbid`) are posted. |
| `tickduration` | Number (minutes, ≥ 0.1) | 6 | Default time between raid ticks; `/startraid tickduration` overrides it per raid. |
| `raiddeprecationtime` | Number (days) | 90 | Raids older than this are flagged *deprecated* by the hourly job and ignored for attendance %; players with no movement in that window disappear from `/listplayersdkps`. The flag is never removed (raising the value later does not bring raids back) and no minimum is enforced: `0` deprecates **every** raid at the next pass. |
| `bidtime` | Integer (seconds, 30–1000) | 60 | Duration of short auctions. |
| `minbid` | Integer (≥ 0) | 0 | Default minimum bid for auctions. |
| `minbidtolockformain` | Integer (≥ 0) | none (every main bid counts) | Minimum amount for a main bid to count as main; below it the bid competes as an alt bid. |
| `overbidtowinmain` | Integer (≥ 0) | none | An alt bid wins over the best main bid when it exceeds it by this amount. |
| `raidhelperapikey` | String | none | Raid-Helper server API key; enables event auto-detection at `/startraid` and the automatic 5 DKP bonus at `/endraid` (raids started without a `name`). |

Notes:

- `role`, `raidchannel`, `logchannel` and `auctionchannel` are required on every call, even to change a single number. `secondraidchannel` and `longauctionchannel` must also be repeated each time: leaving one out clears it.
- Passing `0` for `minbid`, `minbidtolockformain` or `overbidtowinmain` cannot reset a non-zero stored value, and the Raid-Helper key cannot be removed from the command; edit the `options` document in MongoDB if you need that.
- The raid channels must be **voice** channels, the others **text** channels (Discord enforces this in the option picker).

### Environment variables (`.env`)

Copy `.env_example` to `.env` at the project root (it is git- and docker-ignored). Values are read with `dotenv`; keep them unquoted. Under Docker Compose the same file is also parsed by Compose (`env_file`), which interpolates `$`: write any `$` in a value (e.g. an Atlas password) as `$$`.

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Bot token from the Discord developer portal. |
| `DISCORD_CLIENT_ID` | yes | Application ID; used to register the slash commands. |
| `MONGO_URL` | yes | MongoDB connection string. Docker Compose: `mongodb://mongo:27017`; bare metal: `mongodb://localhost:27017`; Atlas: the full `mongodb+srv://…` URI. The database name is always `DKP`. |
| `LOG_LEVEL` | no | `DEBUG` writes a trace (who, what, values) of the main DKP/auction commands — `/adddkp`, `/removedkp`, `/addraiddkp`, `/playerdkp`, `/listplayersdkps`, `/searchitem`, `/auctiondetails`, auction bids and winners — into the `debuglog` collection. Anything else = off. Does not change console verbosity. |
| `LOG_FILE` | no | Path of the log file mirror, relative to the working directory. Default `logs/bot.log`; set it empty to log to the console only. |

The bot exits at startup when one of the three required variables is missing, when MongoDB is unreachable or when the Discord login fails.

### Discord application setup

1. In the [Discord developer portal](https://discord.com/developers/applications), create an application, open **Bot**, click **Reset Token** and put the token in `DISCORD_TOKEN`. The **Application ID** (General Information) goes to `DISCORD_CLIENT_ID`.
2. No privileged intent is needed (the bot uses `Guilds`, `GuildVoiceStates` and `DirectMessages` only), so leave the *Privileged Gateway Intents* switches off.
3. Invite the bot with your own client ID:

   ```
   https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=2150747136&scope=bot+applications.commands
   ```

   `2150747136` grants: View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Connect, Speak, Use Application Commands. Connect/Speak are needed for the auction bell, Attach Files for `/backup`, Read Message History to update long-auction embeds. Make sure the bot can see and write in the log/auction channels and join the raid voice channels (channel overrides apply).
4. Slash commands are registered globally by the bot itself at every start. Registration is a full replace across every server, so moving the bot to another host creates no duplicates. If a client still shows an outdated command, press Ctrl+R in Discord — Discord version-checks stale commands and triggers a reload.

### First run in a server

1. Create the officer role and the raid voice / log text / auction text channels.
2. As an administrator, run `/configure` with the four required options (plus `tickduration`, `bidtime`, etc.).
3. Check with `/showconfig`.
4. Members run `/registercharacter <name>` if the character names are wanted in the database — nothing in the bot itself reads them (see the command table).

## Deployment

### Requirements

- Node.js **≥ 22.12** (the Docker image uses Node 24) and MongoDB (4.4 or newer) for bare metal, **or** Docker with the Compose plugin.
- Outbound HTTPS to Discord, `www.pqdi.cc`, `www.takproject.net` and `raid-helper.dev`.
- Nothing inbound: the bot is a pure Discord gateway client and exposes no port.

### Option A — Docker Compose (bot + MongoDB)

`docker-compose.yml` builds the bot image (Debian-based — `ffmpeg-static` and `@snazzah/davey` ship glibc-only binaries) and runs a `mongo:7` container with a persistent `mongo-data` volume.

```bash
git clone https://github.com/Ziglax/nocturnal-dkp-bot.git
cd nocturnal-dkp-bot
cp .env_example .env          # fill DISCORD_TOKEN / DISCORD_CLIENT_ID, set MONGO_URL=mongodb://mongo:27017
docker compose up -d --build
docker compose logs -f dkp-bot
```

The project folder is bind-mounted into the container (`./:/app`), so `logs/` and `backups/` appear on the host and code edits only need a restart. `node_modules` comes from the image through an anonymous volume.

### Option B — Synology NAS (Container Manager)

`docker-compose.nas.yml` is the same stack with two differences: MongoDB **4.4** (newer versions need the AVX instruction set, missing on Atom/Celeron NAS CPUs) and no `logging:` block, so Container Manager's *Log* tab can display the bot output.

1. Copy the repository to a shared folder (e.g. `/volume1/docker/dkp-bot`) with your `.env`, and rename `docker-compose.nas.yml` to `docker-compose.yml` there (replacing the generic one).
2. Container Manager → **Project** → **Create**: pick the folder, keep the existing `docker-compose.yml`, finish the wizard. The first build takes a few minutes.
3. Day to day, use the project's **Action** menu: **Stop**, **Build** (rebuilds the image — only enabled while the project is stopped), **Start**, **Restart**. Avoid **Clean**: it is `docker compose down` and removes the stack (Synology's documentation says volumes too); back up the database first if you ever use it.
4. The YAML can be edited from the project's *Details → YAML Configurations* tab while the project is stopped. The bot log is also in `logs/bot.log` in the shared folder (readable from File Station).

From SSH the same stack can be driven with `sudo docker compose …` in the shared folder (add `-f docker-compose.nas.yml` only if you kept the original file name).

### Option C — Bot only, MongoDB Atlas

`docker-compose.prod.yml` runs just the bot against an external database (e.g. a MongoDB Atlas free tier). Put the full Atlas URI in `MONGO_URL`; if the password contains `$`, write it as `$$` (Compose interpolates `.env` files).

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

### Option D — Bare metal

```bash
git clone https://github.com/Ziglax/nocturnal-dkp-bot.git
cd nocturnal-dkp-bot
cp .env_example .env          # MONGO_URL=mongodb://localhost:27017 or your own server
npm ci --omit=dev
node index.js
```

There is no `npm start` script. Use a supervisor that restarts the process (pm2, systemd, a Pterodactyl *nodejs* egg…) — the bot exits on purpose when the token or the database is unavailable at startup.

### Migrating to an OVH VPS

[**docs/ovh-migration.md**](docs/ovh-migration.md) is a full runbook for moving off a split hosting (bot on a game panel, database on an Atlas free cluster) onto a single OVH VPS running Option A's stack: which options to pick when ordering, how to harden the machine, how to copy the production database over with `mongodump`, the cutover sequence and its rollback, how to set up real backups, and how to make a sanitised copy of production for local development ([`tools/scrub-dev.js`](tools/scrub-dev.js)).

### Updating

| Change | Docker Compose | Bare metal |
| --- | --- | --- |
| Code (`git pull`) | `docker compose restart dkp-bot` | restart the process |
| Dependencies (`package.json` + `package-lock.json`) | `docker compose up -d --build -V` (`-V` renews the `node_modules` volume) | `npm ci --omit=dev`, restart |
| `.env` | `docker compose up -d` (a restart keeps the old environment) — on Synology: Stop, then Start the project | restart the process |

Add `-f docker-compose.prod.yml` to each command when using the Atlas stack. Never run `docker compose down -v`: it deletes the `mongo-data` volume, i.e. the whole database.

Short auctions live in memory: wait until no `/startbid` auction is running before restarting. Active raids and long auctions are stored in the database and carry on after a restart.

### Slash command registration

At every start the bot overwrites its **global** application commands with the contents of `commands/` (`Successfully reloaded application commands.` in the log). Nothing else to run: when a command definition changes, restart the bot. Discord clients cache the command list; if a client shows *"This command is outdated"*, press Ctrl+R in Discord (or wait a few minutes).

`reloadCommands.js` is a legacy script that registers **guild-scoped** copies of the commands; running it makes every command appear twice. Do not use it.

### Logs

- Everything goes to the console (`docker compose logs`, Container Manager's *Log* tab, Pterodactyl console).
- The same output is mirrored with UTC timestamps into `logs/bot.log`, rotated at 5 MB × 5 files (`LOG_FILE` to move or disable it). Under Compose the folder is on the host, so the file survives container recreation.
- Command errors, `/backup` runs, long-auction closings, failed `/playerdkp` lookups and Raid-Helper member-fetch or log-post failures are always recorded in the `debuglog` MongoDB collection; `LOG_LEVEL=DEBUG` adds a trace of the commands listed under [Environment variables](#environment-variables-env). Nothing prunes that collection.
- Worker messages are prefixed with `[worker]` (raid ticks every 10 s, long-auction closing every 60 s, raid deprecation hourly).

### Database and backups

The bot uses the `DKP` database with the collections `players`, `raids`, `options`, `auctions` and `debuglog`. Pointing the bot at an existing database (for instance the one used by the original `dkpbot`) works as is — the schema is unchanged.

- Application-level: `/backup` exports players and raids of one server (JSON in a zip, posted in the channel). It is **not** a migration path: `JSON.stringify` turns every `_id` into a string, so re-importing that JSON breaks `getRaidById` / `getAuctionById` / `getAuction`, and configuration and auctions are not included at all.
- Full backup (all servers, configuration, auctions):

  ```bash
  docker exec dkp-mongo mongodump --db DKP --gzip --archive=/tmp/dkp.gz && docker cp dkp-mongo:/tmp/dkp.gz ./dkp-$(date +%F).archive.gz
  ```

  Restore (stop the bot first with `docker compose stop dkp-bot`):

  ```bash
  docker cp ./dkp-2026-08-23.archive.gz dkp-mongo:/tmp/dkp.gz && docker exec dkp-mongo mongorestore --archive=/tmp/dkp.gz --gzip --nsInclude='DKP.*' --drop --stopOnError
  ```

  `--nsInclude='DKP.*'` and not `--db DKP`: `--db` is deprecated on archive input, is silently rewritten, and cannot rename (`--db DKP_NEW` restores zero documents and reports no error). `--drop` and `--stopOnError` are not optional — `mongorestore` inserts only, so without `--drop` a document whose `_id` already exists is skipped, and by default the run continues past duplicate-key errors and still exits 0.

  Never pass `-t` to `docker exec` around a dump or a restore: the TTY turns `\n` into `\r\n` and corrupts the archive. Dump takes no flags, restore over stdin takes `-i` alone.
- Atlas **free** clusters have no snapshots and no restore facility — Atlas's own documentation points free-tier users at `mongodump`/`mongorestore`, which is the reason for [Migrating to an OVH VPS](docs/ovh-migration.md).

### Tests

`npx jest` runs the specs in `Auctioner/` and `DKPManager/` (`jest` is a dev dependency: `npm install` first; it is not in the Docker image). **Both connect to a hard-coded `mongodb://localhost:27017` — they ignore `MONGO_URL` — and wipe the `players`, `raids` and `options` collections of its `DKP` database (the Auction spec also leaves test auctions in `auctions`).** Run them only with a throwaway local MongoDB, never on a machine where port 27017 leads to a real database. Every remaining spec touches the database; there is no longer one that does not.

## Known limitations

- A long auction started with `autodebit: false`, and any auction created before that option existed, announces its winners without debiting them: press **Confirm DKP** on the closed post, or `/removedkp` them by hand.
- A winner whose balance no longer covers their bid at close is not debited. The embed says so and the **Confirm DKP** button stays, to be pressed once they can cover it.
- A running short auction lives only in memory: a restart while one is open loses it (no DKP is moved before confirmation anyway), and a restart during the 6-minute confirmation window leaves the **Confirm Winner/s** button dead (it stays on the message but does nothing) — debit those winners with `/removedkp`. Finished short auctions are stored in `auctions` when they close.
- There is no command to cancel a long auction (delete it from the `auctions` collection if needed).
- Long auctions closed before May 2025 were stored without their winners; `/auctiondetails` shows their bids and reports the winners as *not recorded*.
- `/addraiddkp` only counts the main raid channel, not `secondraidchannel`.
- A raid cannot be started with 0 DKP per tick (attendance only): `dkpspertick` 0 is treated as 1.
- `/backup` posts the zip publicly; run it in an officer-only channel.

## Credits and license

Original project: `dkpbot` by Alberto Casado Torres (ISC license, see `package.json`). This fork: [Ziglax/nocturnal-dkp-bot](https://github.com/Ziglax/nocturnal-dkp-bot).
