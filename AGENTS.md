# AGENTS.md — Nocturnal DKP Bot

Agent-facing notes for this repo. The README is the authoritative feature, configuration and deployment reference; this file is a map of the code and its conventions. Read both before changing anything.

## What this is

A Discord bot running a DKP system for an EverQuest guild (raid attendance ticks, loot auctions, manual adjustments, history, backups), backed by MongoDB. Fork of `dkpbot` by Alberto Casado Torres, hardened for 24/7 operation and packaged for Docker / Synology Container Manager.

- Node.js ≥ 22.12, `discord.js` v14, `mongodb` driver v6, `@discordjs/voice`.
- DB: database `DKP`, collections `players`, `raids`, `options`, `auctions`, `debuglog`.
- Item lookups: Project Quarm (`search/QUARMItemSearch.js`) and TAKP (`search/TAKPItemSearch.js`), shared base in `search/ItemSearch.js`.
- Optional Raid-Helper integration in `utils/raidHelperUtils.js`.

## Layout

| Path | Owns |
| --- | --- |
| `index.js` | Entry point: client bootstrap, env checks, interaction dispatch, `lbid_` button routing, global slash-command registration at startup. |
| `commands/*.js` | One file per slash command; each exports `{ data, execute, restricted? }` and is auto-loaded by name. |
| `DKPManager/DKPManager.js` | All database logic (players, raids, options, auctions) and DKP business rules. |
| `Auctioner/Auction.js` | In-memory short-auction engine (bids, winner calc). `Auctioner/Auctioner.js` runs them on a timer and stores finished short auctions. |
| `search/` | Item search providers (QUARM / TAKP). |
| `utils/Logger.js` | Discord embed/message helpers for raids, auctions and bid buttons. |
| `utils/longAuctionBid.js` | Serves the `lbid_` bid buttons of long auctions via modals. |
| `utils/safe.js` | Crash-safe interaction wrappers (`safeReply`, `safeAck`, `guardListener`). |
| `utils/logfile.js` | Mirrors console output into `logs/bot.log` (size-rotated). Installed first thing in `index.js`. |
| `utils/Player.js` | Player record helpers. |
| `worker/Worker.js` | Background loop: fast (raid ticks, 10 s), medium (long-auction close, 60 s), slow (raid deprecation, hourly). |
| `debugger.js` / `db.js` | `debuglog` collection writer / the shared Mongo client. |
| `tools/scrub-dev.js` | Sanitises a production dump for local development. |
| `docs/ovh-migration.md` | Runbook for migrating to an OVH VPS. |

Compose stacks: `docker-compose.yml` (bot + MongoDB), `docker-compose.nas.yml` (Synology: Mongo 4.4, no logging block), `docker-compose.prod.yml` (bot only, external Mongo).

## Runtime flow

- `index.js:25` fails fast on missing `DISCORD_TOKEN` / `DISCORD_CLIENT_ID` / `MONGO_URL`; `dbClient.connect()` rejection and `client.login()` failure also exit 1 (restart policy retries).
- `unhandledRejection` / `uncaughtException` are **swallowed by design** (`index.js:18`) — prod restarts are slow and lose in-memory auctions, so a stray error must not kill the bot.
- Interaction dispatch (`index.js:72`): `lbid_` buttons → `handleLongAuctionBid`; everything else gates on `interaction.isChatInputCommand()`. Commands with `restricted: true` require Administrator or the configured officer role (`index.js:105`).
- Slash commands are registered globally (full replace) on every startup (`index.js:127`). Do not use `reloadCommands.js` — it registers guild-scoped copies and duplicates every command.
- Short auctions live in `Auctioner` memory only (restart loses them). Long auctions live in Mongo, survive restarts, and are closed ~20 min after end by the medium worker task (`worker/Worker.js:106`).

## Conventions — mandatory for edits

- **Never let an interaction path throw or reject.** Use `safeReply` / `safeAck` / `guardListener` from `utils/safe.js`. `safeReply` routes on the interaction state (reply / followUp / editReply); do not call it after `deferUpdate()` on a component interaction (deferred routes to `editReply` and overwrites the message) — use `interaction.followUp` there.
- **Always use `MessageFlags.Ephemeral`**, never the deprecated `ephemeral: true` option (removed in commit `0e838f8`).
- **Validate `ObjectId` input as `/^[0-9a-f]{24}$/i` before DB lookups** — `ObjectId()` throws a `BSONError` on bad input, and `manager.getAuction` throws `'Auction not found'` (catch it, don't let it surface).
- **Modal bidding pattern** (`utils/longAuctionBid.js`): custom id `lbid_<main|alt>_<auctionId>`; per-click `uniqid()` modal id; `showModal` must be the first response; amount validated with `/^\d+$/` (stricter than `parseInt`, which reads `"50abc"` as 50); defer before the DB round trips.
- Per-command/task errors are caught and logged with a `[name]` prefix (e.g. `[worker]`, `[long auction bid]`, `[safeReply]`); the worker reentrancy guard (`Worker.js:81`) prevents overlapping ticks per guild.
- Long-auction state is set in single `$set` calls (`endAuction` sets `auctionActive: false` with winners) — `auctionActive !== false` means "still running" for `/auctiondetails`.
- Logging: console + file mirror. `debugger.js` writes the `debuglog` collection; wrap with `if (process.env.LOG_LEVEL === 'DEBUG')` for command traces (see README). Follow the existing pattern when adding traces.

## Running and testing

- No `npm start` script. Bare metal: `npm ci --omit=dev && node index.js`. Env comes from `.env` (see `.env_example`; `LOG_FILE` may be empty to disable file logging).
- Docker: `docker compose up -d --build` (Option A). Never run `docker compose down -v` — it deletes the `mongo-data` volume (the whole DB). When deps change: `docker compose up -d --build -V`.
- Tests: `npx jest` (dev dependency — `npm install` first, not in the Docker image). **Danger: the specs hard-code `mongodb://localhost:27017` (ignoring `MONGO_URL`) and wipe the local `players`, `raids` and `options` collections (the Auction spec also leaves data in `auctions`).** Run only against a throwaway local MongoDB, never where port 27017 reaches a real database. There is no lint or typecheck command.

## Gotchas

- A running short auction is lost on restart; the 6-minute Confirm Winner/s button dies with it (debit with `/removedkp`). Finished short auctions are stored in `auctions` at close.
- Long-auction winners are announced but never debited automatically — officers must `/removedkp`.
- `/addraiddkp` counts the main raid channel only (not `secondraidchannel`).
- `raiddeprecationtime` deprecation is one-way: the flag is never removed once set.
- Compose interpolates `.env` (`env_file`), so write `$` in values (e.g. Atlas passwords) as `$$`.
- There is no `/parsedkps` command any more (removed, along with `logParser/`); `/registercharacter` data is not consumed by the bot.
