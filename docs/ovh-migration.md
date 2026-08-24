# Migration guide — SparkedHost + MongoDB Atlas → OVH VPS

Moving the DKP bot and its database onto a single OVH VPS, so that the Node
process and `mongod` sit on the same host instead of a shared game panel in the
US talking to an Atlas free cluster.

**What this guide covers:** which options to pick when ordering at OVH, how to
harden and prepare the VPS, how to run the two containers on it, how to copy the
production database over, the cutover runbook and its rollback, how to
decommission the old hosting, how to set up real backups, and how to make a
sanitised copy of production for local development.

**Read the whole thing once before ordering anything.** Several steps are
ordered the way they are because the alternative order is unrecoverable
(§3.2 AVX, §6 cutover, §8 decommissioning).

---

## Table of contents

- [0. Why this migration, and what does not change](#0-why-this-migration-and-what-does-not-change)
- [1. Before you start](#1-before-you-start)
- [2. Ordering the VPS at OVH](#2-ordering-the-vps-at-ovh)
- [3. First hour on the VPS](#3-first-hour-on-the-vps)
- [4. Installing the containers](#4-installing-the-containers)
- [5. Copying the production database](#5-copying-the-production-database)
- [6. Cutover runbook](#6-cutover-runbook)
- [7. Rollback](#7-rollback)
- [8. Decommissioning the old hosting](#8-decommissioning-the-old-hosting)
- [9. Backups](#9-backups)
- [10. Copying production to a dev machine](#10-copying-production-to-a-dev-machine)
- [Appendix A — Enabling MongoDB authentication](#appendix-a--enabling-mongodb-authentication)
- [Appendix B — Indexes](#appendix-b--indexes)
- [Appendix C — Traps worth memorising](#appendix-c--traps-worth-memorising)

---

## 0. Why this migration, and what does not change

Today the code runs on SparkedHost (US) and the data lives on an Atlas free
cluster. Every DKP write is a transatlantic round-trip, and the free cluster
offers **no backup or restore facility at all** — Atlas's own documentation
points free-tier users at `mongodump`/`mongorestore`, which needs a place to run
them from. Co-locating the bot and the database fixes both problems at once.

Target: one OVH VPS running the existing `docker-compose.yml` stack — `dkp-bot`
plus a `mongo` container on a persistent volume — with scheduled `mongodump`
backups pushed off-box.

**What does not change:**

- The MongoDB document schema. `mongodump`/`mongorestore` round-trip BSON
  byte-for-byte, so every `_id` (including every `ObjectId`) survives exactly.
  The third-party roster site's document references keep working: they reach it
  as the hex strings `/backup` renders those `ObjectId`s into.
- The database name (`DKP`) and the collection names.
- The bot's own code. The only repository change this migration requires is the
  Mongo image tag (§4.2).
- The Discord application, its token and its client ID (until §8, where the
  token is rotated deliberately).

**What does change:** `MONGO_URL` (`mongodb+srv://…` → `mongodb://mongo:27017`),
the host, and the backup story.

> **Resolved: the roster site never touches MongoDB.** It consumes the JSON
> produced by `/backup`, asynchronously — an administrator runs the command,
> Discord carries the zip, the site ingests it afterwards. Nothing outside the
> compose network ever opens a MongoDB connection, so the target stack is free
> to publish no port and configure no authentication, and
> [Appendix A](#appendix-a--enabling-mongodb-authentication) stays optional.
>
> Two consequences for scheduling. The roster is **not** a constraint on the
> cutover window: its data is already stale between backups by design, so an
> outage of a few minutes is invisible to it. And the feed keeps working purely
> because the bot keeps working — the only post-cutover check it needs is one
> `/backup` on the new host (C11).
>
> What the feed *does* depend on is the document ids staying identical, which is
> exactly what §5 guarantees. `JSON.stringify` renders each `ObjectId` as its hex
> string, so an id re-created during the copy would silently change every key the
> site joins on, with nothing anywhere reporting an error.
>
> Note the feed is `players` and `raids` only. `options`, `auctions` and
> `debuglog` are not in it, which is why `/backup` alone was never a migration
> path (§5.5) — but it is the whole of what the roster needs.

---

## 1. Before you start

### 1.1 Prerequisites

| Thing | Where | Note |
| --- | --- | --- |
| OVH account | already have one (roster HTML + domain) | Same account, same billing. |
| SSH key pair | your Windows machine | `ssh-keygen -t ed25519 -C "dkp-vps"` if you have none. You will need the **public** key text (`~/.ssh/id_ed25519.pub`). |
| MongoDB Database Tools | your Windows machine | `winget install --exact --id MongoDB.DatabaseTools` (display name "MongoDB Tools"). Provides `mongodump`, `mongorestore`, `bsondump`. |
| `mongosh` | your Windows machine | `winget install --exact --id MongoDB.Shell` |
| Git Bash | your Windows machine | Needed for anything involving `<` redirection or binary pipes. See [Appendix C](#appendix-c--traps-worth-memorising). |
| Atlas DB user with read access | Atlas UI | The bot's own user is fine. |
| Atlas network access | Atlas UI | Add the VPS's IPv4 once you have it, or temporarily `0.0.0.0/0` **only** while the dump runs. |

### 1.2 Budget

Year 1, taking the recommendation in §2:

| Line | HT | TTC |
| --- | --- | --- |
| VPS-1 2027, 12-month upfront | 45,72 € | 54,86 € |
| Premium automated backup, 12-month upfront | 13,20 € | 15,84 € |
| **Total, charged once at commitment** | **58,92 €** | **70,70 €** |

Installation fees are 0 €. Renewal is at the same price — the 3,81 € HT/month
is the standing rate, not a promotional one.

---

## 2. Ordering the VPS at OVH

### 2.1 The model

**VPS-1 2027** (`vps-2027-model1`): 2 vCores, 4 GB RAM, 40 GB NVMe SSD,
500 Mbit/s, 99.9 % SLA.

That is comfortably enough. MongoDB's WiredTiger cache on a 4 GB box is
`max(0.5 × (RAM − 1 GiB), 256 MiB)` ≈ 1.5 GiB, steady-state usage lands around
2.5 GB, and the current dataset is a few tens of megabytes.

### 2.2 Commitment: order with **no commitment**, commit afterwards

| Mode | Monthly HT | Monthly TTC | Charged |
| --- | --- | --- | --- |
| No commitment | 4,49 € | 5,39 € | monthly |
| 6 months upfront | 4,26 € | 5,11 € | 25,56 € HT / 30,67 € TTC once |
| 12 months upfront | 3,81 € | 4,57 € | 45,72 € HT / 54,86 € TTC once |

There is no 24-month option on this range.

**Order without commitment.** Do not count on the 14-day withdrawal right as a
safety net: OVH's terms of service treat immediate execution of the service as a
waiver of it. The safe sequence is:

1. Order the VPS with **no commitment** (4,49 € HT for the first month).
2. Verify AVX and MongoDB on the delivered machine (§3.2 and §4.1).
3. Only then, in the Control Panel → your VPS → **Home** → *My offer* →
   **Commitment** → *Manage my commitment*, switch to 12 months upfront.

If the box fails the AVX check you cancel a month, not a year.

Note that the 12-month upfront engagement has `REACTIVATE_ENGAGEMENT` as its
default end action — it re-engages automatically at term. Set a calendar
reminder for month 11 if you want the choice back.

### 2.3 Datacentre

Eleven are offered and **the price is identical everywhere**: BHS (Canada), DE,
EU-SOUTH-MIL (Milan), EU-WEST-RBX, GRA, SBG, SGP (Singapore), UK, WAW (Warsaw),
SYD (Sydney), YNM (Mumbai).

**Pick GRA, SBG or RBX** — France, on OVH's European backbone, ~10–20 ms from a
French residential line and from Discord's European edge.

Avoid BHS, SGP, SYD, YNM. Beyond the latency: **"unlimited traffic" is
region-conditional.** The APAC locations (SGP, SYD, YNM) apply a 500 GB/month
quota on VPS-1 and throttle to 10 Mbit/s past it. The European locations do not.

(If you ever see a *Local Zone* offer: the smallest one is VPS-1 LZ 2026 at
6,37 € HT/month upfront-12. Not relevant here.)

### 2.4 Operating system

**Choose plain Debian 13** (Debian 12 is fine too). **Do not** choose the
pre-baked *"Debian 12 - Docker"* image.

The reason is engine currency and support: OVH's Docker image ships whatever
version was current when the template was built, from Debian's repositories,
and you cannot get upstream support for it. Installing from Docker's own apt
repository (§4.1) takes four minutes and keeps you on the current engine.

(For the record, the often-repeated "Debian has no Compose V2" is false —
trixie ships `docker-compose` 2.26.1-4 with the V2 CLI plugin. Currency is the
real argument, not availability.)

### 2.5 Options

VPS-1 2027 has three mandatory option families — `os`, `automatedBackup`,
`storage` — all of which can be satisfied at 0 €. The funnel will not let you
past without picking one of each.

| Option | Choose | Cost |
| --- | --- | --- |
| OS | `option-linux` → Debian 13 | 0 € |
| Storage | `option-storage-local-2027-model1` (local NVMe) | 0 € |
| Automated backup | **Premium — 7 rolling days** | 1,10 € HT / 1,32 € TTC per month |
| Snapshot | decline | (0,30 € HT/month) |
| Additional disk | decline | — |
| cPanel / Plesk | decline | — |
| Additional IPv4 | decline | 1,99 € HT / IP / month, and it is ordered *after* delivery anyway |

One IPv4 and one IPv6 are included.

**About the backup option.** The *Standard* tier (1 day of retention) is listed
at 0,35 € HT but carries an open-ended 100 % discount, so it bills at 0,00 €.
The *Premium* tier (7 rolling days) is 1,10 € HT/month at every commitment mode,
with no discount. Take Premium: one day of retention is not enough to notice a
problem over a weekend, and 13,20 € HT a year is cheap for a same-day whole-VM
rollback.

**But do not mistake it for a backup.** OVH's own description says the data
"is exported to our infrastructure and replicated three times **within the same
datacentre**". It restores the whole VM (system disk only), not a database or a
file. It is a fast rollback tier, not durability — SBG2 burned down in March
2021. The real backup story is §9.

### 2.6 What the funnel will *not* ask you

**There is no SSH key field in the order funnel.** It asks for the datacentre,
the OS, the options and the commitment. Nothing else. The key goes in
afterwards (§3.1).

---

## 3. First hour on the VPS

Run the steps in this order. In particular the AVX check (§3.2) comes before
anything is installed, and the firewall goes up before Docker.

### 3.1 Reinstall with your SSH key

You will receive an email with an IP address, the default user `debian` and a
password. Root login is disabled.

You *can* log in with that password — the first login forces a password change
and then drops the session, which is normal, not a fault. But rather than manage
a password at all, go straight to:

**Control Panel → your VPS → Home → the `…` menu next to OS / Distribution →
Reinstall my VPS.** That screen *does* offer an SSH key field. Paste your
public key, reinstall, and you get a key-only `debian` account on a clean image.

```bash
ssh debian@<VPS_IP>
```

Do **not** run `sudo passwd root`. Leave root disabled; `sudo` is the path.

### 3.2 AVX go/no-go — do this before anything else

MongoDB 5.0 and later **require the AVX instruction set**. Without it `mongod`
dies with SIGILL the moment it starts, and because the container has
`restart: unless-stopped`, it crash-loops forever. The tell is
`docker inspect -f '{{.State.ExitCode}}' dkp-mongo` returning **132**.

Check the CPU flags first — no Docker needed, and no reason to install anything
onto a box you might hand back:

```bash
grep -qw avx /proc/cpuinfo && echo "AVX-OK" || echo "NO-AVX-ABORT"
```

If this prints `NO-AVX-ABORT`, stop. Do not commit, do not install. Delete the
VPS within the first month and re-order (OVH's fleet is mixed; a different
delivery may land on a newer host). Everything below assumes `AVX-OK`.

The second half of this gate — actually starting a `mongod` — comes in §4.1,
once Docker exists.

### 3.3 Firewall (before Docker)

`ufw` must be installed and enabled **before** Docker, or Docker's iptables
chains get reshuffled. If you do it the other way round, restart Docker
afterwards.

Order matters: set the default policies first, allow SSH, *then* enable.
Enabling first locks you out.

```bash
sudo apt update && sudo apt install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw limit 22/tcp
sudo ufw enable
sudo ufw status verbose
```

`ufw limit` denies a source address that opens **six or more** connections in
30 seconds. That is a rate limit on brute-forcing, not on you — but if you ever
script a loop of `ssh` calls, you will trip it.

Sanity-check that Docker's chains are still on top after any later
`ufw reload`:

```bash
sudo iptables -S FORWARD | head -3   # DOCKER-USER / DOCKER-FORWARD must come first
```

**Important, and counter-intuitive: ufw does not protect published Docker
ports.** Docker DNATs published ports in `nat/PREROUTING`, so the routing
decision sends those packets to `FORWARD` and they never reach ufw's `INPUT`
chain. Docker's own documentation puts it plainly: *"Packets are routed before
the firewall rules can be applied, effectively ignoring your firewall
configuration."*

The correct answer for this stack is not to fight it: **publish no ports at
all.** The repository's `docker-compose.yml` already has no `ports:` key on
either service, and that — not ufw — is what keeps MongoDB off the internet.
Keep it that way.

### 3.4 SSH hardening

Debian's `sshd_config` starts with `Include /etc/ssh/sshd_config.d/*.conf`, and
in OpenSSH **the first value of a keyword wins**. The glob expands in lexical
order, so a file named `99-hardening.conf` **loses** to the `50-cloud-init.conf`
that the image already ships. Name your drop-in with a low number:

```bash
sudo tee /etc/ssh/sshd_config.d/00-hardening.conf >/dev/null <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
PermitEmptyPasswords no
EOF
```

Validate, then check the *effective* configuration — never assume the file won:

```bash
sudo /usr/sbin/sshd -t
sudo /usr/sbin/sshd -T | grep -iE '^(passwordauthentication|permitrootlogin|pubkeyauthentication|kbdinteractiveauthentication|authenticationmethods|permitemptypasswords)'
```

**Debian 13 (trixie) socket-activation trap.** A fresh trixie has `ssh.socket`
active and enabled. With it in charge, `systemctl reload ssh` fails with
*"fatal: Cannot bind any address"*, and a `Port` directive in `sshd_config` is
inert. Normalise it:

```bash
sudo systemctl disable --now ssh.socket
sudo systemctl enable --now ssh.service
```

From then on use `restart`, never `reload`:

```bash
sudo systemctl restart ssh
```

Keep your current session open and confirm a **second** SSH session works
before closing the first.

`fail2ban` is optional and marginal once password authentication is off. If you
want it anyway, be aware that on Debian 12/13 the stock sshd jail fails with
*"Failed during configuration: Have not found any log file for sshd jail"*
(Debian bugs #1037437 and #1070677); it needs `backend = systemd` and the
`python3-systemd` package.

### 3.5 OVH Edge Network Firewall — leave it **off and empty**

This is the firewall in the OVH Control Panel, upstream of the VM. Two facts
make it dangerous to treat as a convenience:

1. It is **stateless**. Rules that look right for a stateful firewall silently
   break return traffic.
2. It is **automatically enabled during a DDoS attack and cannot be disabled
   until the attack ends** — at which point every rule you left stored springs
   into effect.

So leave it disabled *and* leave the rule list empty. A forgotten "allow 22
only" rule becomes an outage the day you are attacked.

OVH's anti-DDoS mitigation is free and always on regardless. Two side effects
worth knowing: QUIC is dropped at the OVH edge whatever you configure, and
fragmented UDP is DROP by default. Neither affects this bot.

### 3.6 Swap

OVH images ship with no swap. Add 2 GB as an OOM airbag — the moment you need it
is when `mongodump` and `npm ci` overlap:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=1' | sudo tee /etc/sysctl.d/99-swappiness.conf
sudo sysctl --system
free -h
```

`swappiness=1` means "use it only under real pressure", which is what you want
in front of a database.

### 3.7 Timezone

Set the **host** to Europe/Paris. Leave the containers alone.

```bash
sudo timedatectl set-timezone Europe/Paris
timedatectl
```

**Do not set `TZ` on the bot container.** `logParser/logParser.js:3` parses
EverQuest log headers that carry no UTC offset (`[Sun Nov 19 09:52:52 2023]`)
in the runtime's local zone, and writes the result to MongoDB via
`commands/parsedkps.js`. Changing the container's zone would shift the
timestamps of every future parsed log relative to every past one. Containers
stay UTC, which is what production does today.

(`analyze_player_logs.js:38` pins `Europe/Paris` explicitly for display, and
`utils/Logger.js` uses Discord `<t:…>` markers, which render in each viewer's
own zone. Neither is affected.)

### 3.8 Unattended security upgrades

```bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

Two things to know:

- On Debian the configuration key is `Unattended-Upgrade::Origins-Pattern`
  (Ubuntu's `Allowed-Origins` does nothing here).
- **The shipped default is not security-only.** It also includes
  `"origin=Debian,codename=${distro_codename},label=Debian";`, i.e. point
  releases. If you want strictly security updates, trim that line in
  `/etc/apt/apt.conf.d/50unattended-upgrades`.

It will **not** update Docker Engine (third-party repository) and it will
**not** update container images. Those stay manual.

### 3.9 Disk hygiene

40 GB is plenty, but two things eat it silently. Neither needs a logrotate rule:

- **journald** is already bounded — `SystemMaxUse` defaults to 10 % of the
  filesystem capped at 4 GiB, with `SystemKeepFree` at 15 %. Leave it.
- **`logs/bot.log`** is already rotated in-process by `utils/logfile.js`
  (5 MiB × 5 files). Leave it.
- **The Docker build cache** is the actual risk, along with old images. Add a
  monthly `docker system prune -f` (never `-a --volumes`).

```bash
df -h /
docker system df      # after §4
```

---

## 4. Installing the containers

### 4.1 Docker from Docker's own repository

```bash
sudo apt update
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo docker run --rm hello-world
```

Note `$(. /etc/os-release && echo "$VERSION_CODENAME")` rather than the
`lsb_release -cs` you will see in most copy-pasted guides: `lsb_release` is not
installed on a minimal Debian, and the copy-pasted version fails with
`command not found` and then writes a broken sources file.

Add yourself to the `docker` group so you can drop the `sudo`:

```bash
sudo usermod -aG docker $USER
```

Log out and back in for it to take effect.

**Now finish the AVX gate.** This is the part that actually proves MongoDB will
run on this CPU:

```bash
docker run --rm mongo:8.0 mongod --version
```

You want a version banner. If the container dies instead, re-check §3.2 —
and do not proceed to the data copy.

### 4.2 The one repository change: `mongo:7` → `mongo:8.0`

Atlas free clusters run **MongoDB 8.0**. Restoring an 8.0 dump into a `mongo:7`
container is a cross-major downgrade, outside MongoDB's stated compatibility.
Edit `docker-compose.yml`:

```yaml
  mongo:
    image: mongo:8.0
```

**Use `mongo:8.0`, not `mongo:8`.** The Docker official-images project no
longer publishes a bare `8` tag (the shared tags are `8.3.8, 8.3` /
`8.0.29, 8.0` / `7.0.40, 7.0, 7`). Docker Hub still serves a stale `mongo:8`
that resolves to 8.2.12 — which is EOL since 2026-07-31 and, worse, **refuses
to start on a data directory whose feature compatibility version is 7.0**. The
result is a Mongo crash loop, and since the bot has
`depends_on: { mongo: { condition: service_healthy } }`, the bot never starts
either. `mongo:8.0` is the LTS line, supported to 2029-10-31.

### 4.3 Deploy the stack

```bash
sudo mkdir -p /opt/dkp-bot
sudo chown "$USER:$USER" /opt/dkp-bot
git clone https://github.com/Ziglax/nocturnal-dkp-bot.git /opt/dkp-bot
cd /opt/dkp-bot
cp .env_example .env
```

Fill `.env` — but read the interlock below first.

```
DISCORD_TOKEN=
DISCORD_CLIENT_ID=<your application id>
MONGO_URL=mongodb://mongo:27017
LOG_LEVEL=
LOG_FILE=logs/bot.log
```

> **Safety interlock: leave `DISCORD_TOKEN` empty until cutover.**
>
> Two gateway sessions on one bot token both stay connected and both receive
> `INTERACTION_CREATE`. Discord does not evict, deduplicate or arbitrate between
> them. If the new bot connects while the old one is still running, every
> command is executed **twice** — every DKP award doubled, every auction closed
> twice.
>
> The bot fails fast on a missing `DISCORD_TOKEN` (`index.js:24-29`), which is
> exactly the behaviour you want during preparation: you can bring up the Mongo
> container and load the data with the bot deliberately refusing to start.

Bring up **only** MongoDB for now:

```bash
docker compose up -d mongo
docker compose ps
docker logs -f dkp-mongo      # Ctrl-C once you see "Waiting for connections"
```

Note: the compose **service** is called `mongo`; `dkp-mongo` is only the
container name. `docker compose stop dkp-mongo` fails with *"no such service"* —
use `docker compose stop mongo`, or `docker stop dkp-mongo`.

### 4.4 Compose operating rules (already documented in the compose file)

| Change | Command |
| --- | --- |
| Code only | `docker compose restart dkp-bot` |
| `.env` changed | `docker compose up -d` (`restart` keeps creation-time env) |
| Dependencies changed | `docker compose up -d --build -V` |

**Never `docker compose down -v`.** The `-v` deletes the `mongo-data` volume,
i.e. the entire database.

---

## 5. Copying the production database

Done twice: a **rehearsal** now, with the bot still live on SparkedHost, to
prove the whole chain works and to measure it; and a **final** dump during the
cutover window (§6, step C5).

### 5.1 Dump Atlas

From your Windows machine, in **Git Bash** (or PowerShell — the `--archive=`
form below is safe in both, unlike shell redirection):

```bash
mongodump \
  --uri="mongodb+srv://<user>:<password>@<cluster>.mongodb.net/" \
  --db=DKP \
  --gzip \
  --archive=dkp-atlas-$(date +%F).archive.gz \
  --verbose
```

Points of detail, each of which has bitten someone:

- **`--archive=<file>`, never `> file`.** PowerShell 5.1 destroys binary
  redirection: it prepends a UTF-8 BOM, replaces every byte above 0x7F with
  U+FFFD (lossy — the data is *gone*, not merely re-encoded) and appends CRLF.
  Measured on this machine, a 258-byte binary stream came out as 523 corrupt
  bytes. Byte-stream preservation only arrived in PowerShell 7.4. And `<` is a
  hard parser error in every PowerShell version
  (*"The '<' operator is reserved for future use"*).
- **Always quote the URI.** Unquoted, `&` between query parameters is a
  PowerShell parser error. And a `$` in the password is interpolated inside
  *double* quotes — use single quotes, or percent-encode it. (This is the
  opposite of the `.env` rule, where Compose needs `$$`. Do not mix them up.)
- **`--oplog` is unsupported on Atlas free clusters**, as is
  `--dumpDbUsersAndRoles`. Do not add them.
- `--db=DKP` on `mongodump` is correct and supported. (`--nsInclude` does *not*
  exist on `mongodump`; its filters are `--db`, `--collection`,
  `--excludeCollection`, `--excludeCollectionsWithPrefix`.)

Check the result before doing anything else:

```bash
ls -l dkp-atlas-*.archive.gz     # non-zero, and plausible for your dataset
echo $?                          # 0
```

### 5.2 Move the archive to the VPS

```bash
scp dkp-atlas-2026-08-23.archive.gz debian@<VPS_IP>:/tmp/
```

Then, on the VPS, into the container:

```bash
docker cp /tmp/dkp-atlas-2026-08-23.archive.gz dkp-mongo:/tmp/dkp.gz
```

(The `mongo` container mounts only `mongo-data:/data/db` — there is no `/dump`
mount. `docker cp` is the way in.)

### 5.3 Restore

```bash
docker exec dkp-mongo mongorestore \
  --uri="mongodb://localhost:27017" \
  --archive=/tmp/dkp.gz \
  --gzip \
  --nsInclude='DKP.*' \
  --drop \
  --stopOnError \
  --verbose

docker exec dkp-mongo rm -f /tmp/dkp.gz
```

Flag by flag:

- **`--nsInclude='DKP.*'`, not `--db DKP`.** `--db` is deprecated for archive
  input. It is silently rewritten to `--nsInclude=DKP.*` and, critically, it
  **cannot rename** — `--db DKP_NEW` restores zero documents and reports no
  error. Quote it, or bash globs `DKP.*` against the working directory.
- **`--drop`** drops each collection in the restore set immediately before
  restoring it, which makes the command idempotent and re-runnable. It only
  touches collections present in the archive; other databases are untouched.
- **`--stopOnError`** — the default is `false`, meaning mongorestore continues
  through duplicate-key and validation errors. For a one-shot migration you
  want it to abort loudly.
- **`--gzip`** must match the dump, or the archive fails to parse.
- No credentials: the container runs without authentication and publishes no
  port, so `docker exec` is the only route in.

> **`mongorestore` performs INSERTS ONLY.** Without `--drop`, a document whose
> `_id` already exists in the target is **skipped, not updated** — and with the
> default `--stopOnError=false` the run continues and exits 0. The failure mode
> is a "successful" migration that silently discarded your Atlas versions of
> those documents. A restore is not a reset.
>
> Related: `--drop` does *not* drop collections that are absent from the dump
> (here, the unused `shortAuctions`). And if `mongorestore` crashes mid-run
> there is no resume — drop everything and start the restore again.

If you ever need to restore from a file on the host rather than inside the
container, the streaming form is `docker exec -i` — lower-case `i`, and
**never** `-t`:

```bash
docker exec -i dkp-mongo mongorestore \
  --archive --gzip --nsInclude='DKP.*' --drop --stopOnError < dkp.gz
```

### 5.4 Verify

Never trust the exit code alone.

**Counts** — `countDocuments()` runs a real aggregation;
`estimatedDocumentCount()` reads cached metadata and can be stale after a
restore.

```bash
# Atlas
mongosh "mongodb+srv://<cluster>.mongodb.net/DKP" --username <user> --quiet --eval '
  db.getCollectionNames().sort().forEach(c =>
    print(c.padEnd(20), db.getCollection(c).countDocuments({})))'

# VPS
docker exec dkp-mongo mongosh "mongodb://localhost:27017/DKP" --quiet --eval '
  db.getCollectionNames().sort().forEach(c =>
    print(c.padEnd(20), db.getCollection(c).countDocuments({})))'
```

The two lists must be identical — same collection names (`players`, `raids`,
`options`, `auctions`, `debuglog`, `shortAuctions`), same counts.

**A business-level check** that means something to you, run on both sides:

```javascript
db.players.aggregate([{ $group: { _id: "$guild", players: { $sum: 1 }, totalDKP: { $sum: "$dkp" } } }])
```

**Indexes** — with zero `createIndex` calls anywhere in the repository you
should see exactly one `_id_` index per collection on both sides:

```javascript
db.getCollectionNames().sort().forEach(c =>
  printjson({ coll: c, indexes: db.getCollection(c).getIndexes() }))
```

**What not to compare:** `db.collection.stats()` is fine to look at, but only
`count` and `nindexes` are meaningful across the two. `size`, `storageSize`,
`avgObjSize` and `totalIndexSize` legitimately differ because of WiredTiger
block compression, insertion order and fragmentation. A `storageSize` mismatch
is not evidence of data loss; a `count` mismatch is.

`dbHash` is **blocked on Atlas free clusters**, so the obvious checksum command
is unavailable. If you want a true byte-level proof, dump both sides to
directories and hash the canonical Extended JSON, sorted (mongorestore inserts
in random order, so physical order must not matter):

```bash
mongodump --uri="mongodb+srv://<cluster>.mongodb.net/" --username <user> --db=DKP --out=./atlas-dump
docker exec dkp-mongo mongodump --uri="mongodb://localhost:27017" --db=DKP --out=/tmp/local-dump
docker cp dkp-mongo:/tmp/local-dump ./local-dump

for side in atlas-dump local-dump; do
  echo "== $side"
  for f in "$side"/DKP/*.bson; do
    printf '%-24s %s\n' "$(basename "$f")" \
      "$(bsondump --quiet "$f" | LC_ALL=C sort | sha256sum | cut -d' ' -f1)"
  done
done
```

Matching SHA-256 per collection means the two datasets are identical
document-for-document, including every `_id`. Run it in Git Bash, not
PowerShell (`sort` there is `Sort-Object` and behaves differently). **Delete
both directories afterwards** — they are plaintext copies of production.

### 5.5 What about `/backup`?

The `/backup` command's JSON is **not** a migration path, and it is worth
knowing why so nobody reaches for it under pressure.

`JSON.stringify` on a driver document emits `"_id":"6a8a…"` — a **string**.
Re-importing that produces documents whose `_id` is a string rather than an
`ObjectId`, which breaks `getRaidById`, `getAuctionById` and `getAuction` (all
three wrap the id in `new ObjectId()`) and quietly changes the hex keys the
roster site joins on. It also only covers `players` and `raids` — not `options`,
not `auctions`.

Read in the other direction, though, that same JSON *is* the roster site's
feed (§0), and it is fine at that job: exporting an `ObjectId` as its hex string
loses nothing as long as nothing ever imports it back.

`mongodump` writes raw BSON and has none of these problems. Use it.

(Date fields happen to survive either way, because `DKPManager` stores
`new Date().getTime()` numbers rather than BSON dates.)

---

## 6. Cutover runbook

Expect **5 to 10 minutes** of bot downtime, almost all of it verification.
Pick a slot with no raid and no auction — outside raid nights.

The rule underneath the whole sequence: **stop, then start. Never overlap.**
See the interlock in §4.3.

### C1 — Pre-flight gate

On Discord, with the bot still live, confirm all three:

- No active raid. `/showconfig` and the log channel will tell you; in the
  database, `db.raids.countDocuments({ active: true })` must be `0`.
- No open auction: `db.auctions.countDocuments({ auctionActive: true })` must
  be `0`.
- No `/startbid` in the last `30 s + bidtime + 6 min`. The long-auction
  reporting delay (`extraTimeBeforeReporting` in `worker/Worker.js:113`) is
  20 minutes, so if a long auction just closed, wait it out.

**Record your baseline now** — you will compare against it in C7:

```javascript
db.players.aggregate([{ $group: { _id: "$guild", players: { $sum: 1 }, totalDKP: { $sum: "$dkp" } } }])
db.raids.countDocuments({}); db.auctions.countDocuments({}); db.options.countDocuments({})
```

### C2 — Stop the bot on SparkedHost

Stop the process in the SparkedHost panel.

### C3 — Disable auto-start

In the panel, disable whatever restarts the process automatically. A panel that
helpfully brings the old bot back up in the middle of the cutover is the exact
double-run scenario the interlock exists to prevent.

### C4 — Confirm OFFLINE in Discord

Look at the member list. The bot must show as offline. Do not proceed on the
panel's word alone.

### C5 — Final Atlas dump

Repeat §5.1. Then check **both**:

```bash
echo $?                          # must be 0
ls -l dkp-atlas-*.archive.gz     # must be non-zero and plausible
```

A dump that failed and a dump that produced an empty file look identical if you
only check one of them.

### C6 — Load it on the VPS

Drop the rehearsal data first, so there is no chance of mixing the two:

```bash
docker exec dkp-mongo mongosh --quiet --eval 'db.getSiblingDB("DKP").dropDatabase()'
```

Then §5.2 and §5.3 exactly as rehearsed.

### C7 — Verify against the C1 baseline

Re-run the aggregation and the counts from C1 on the VPS. Every figure must
match what you recorded. If anything differs, **stop and go to §7** — do not
start the bot on a database you have not verified.

### C8 — Write the real token

```bash
cd /opt/dkp-bot
nano .env      # set DISCORD_TOKEN=<the token>
```

If you would rather use the shell, prefix the command with a space so it stays
out of `~/.bash_history` (bash's `HISTCONTROL=ignorespace`, which Debian sets
by default). `nano` is simpler and leaves no trace either way.

### C9 — Start

```bash
docker compose up -d
```

**`up -d`, not `restart`** — `restart` reuses the environment captured when the
container was created, i.e. the empty token.

### C10 — Watch the logs

```bash
docker compose logs -f dkp-bot
```

The boot signature is:

```
Started refreshing 20 application commands.
Successfully reloaded application commands.
Ready! Logged in as <tag>
Worker started
```

> **Stop the container on the first failed boot.** Discord allows **1000
> IDENTIFYs per 24 hours per token**. On hitting the limit, all active sessions
> are terminated, **the bot token is reset**, and the application owner is
> emailed. A `restart: unless-stopped` crash loop can reach ~1400 IDENTIFYs a
> day. So: `docker compose stop dkp-bot`, diagnose, then start again. Do not
> let it loop while you think.

About those 20 commands: `index.js:113` performs an idempotent bulk
`PUT Routes.applicationCommands(clientId)`, which is a **full replace** across
every guild. Moving hosts creates no duplicates and needs no cleanup. The "up to
an hour to propagate" line you may remember is stale — Discord now documents
read-repair: it version-checks a stale command, rejects it and triggers a
reload.

**Never run `reloadCommands.js`.** It registers *guild-scoped duplicates* of
every command **and** calls `client.login()` without exiting, opening a second
gateway connection — both of the failure modes this runbook is built to avoid.

### C11 — Smoke test in Discord

- `/showconfig` — the configuration came across.
- `/playerdkp` on a known player — the number matches C1.
- `/dkphistory` on that player — history is present.
- `/listplayersdkps` — pagination works.
- `/backup` — the zip downloads, and `players.json` / `raids.json` inside it are
  populated. This is the roster site's entire feed, so it is worth running once
  before you call the cutover done. It only reads.

Do **not** start a raid or an auction as a test. Read-only commands are enough.

### C12 — Deliberate reboot

```bash
sudo reboot
```

Come back after a minute and confirm both containers are up and the bot is
online again. Better to discover a missing `restart: unless-stopped` or an
un-persisted swap entry now, at a time you chose, than at 3 a.m.

```bash
docker compose ps
free -h
```

---

## 7. Rollback

**Rollback A — before C8 (no token written yet).** Nothing has changed on the
Discord side. Re-enable auto-start on SparkedHost and start the old process.
Total exposure: the minutes since C2. The Atlas data was never modified.

**Rollback B — after C9 (the new bot has run).**

1. `docker compose stop dkp-bot` on the VPS. Confirm the bot shows offline in
   Discord.
2. Start the SparkedHost process again and confirm it shows online.
3. Any writes the new bot made in between exist only on the VPS. If they matter,
   dump the VPS and merge them into Atlas manually; if they do not (a couple of
   read commands during C11 write nothing), you are done.

Rollback B depends on Atlas still accepting connections from SparkedHost. That
is why the Atlas network-access rule is the **last** thing you remove (§8).

---

## 8. Decommissioning the old hosting

Order matters. Each step removes a safety net, so remove them from the least
useful to the most.

**D1 — Take a final dump off the VPS and store it somewhere else.** Before
anything is cancelled. This is the artefact you will wish you had.

**D5 — Set up the scheduled backups (§9) and watch them succeed for a week.**
Until this works, the VPS is a single point of failure and rolling back to
SparkedHost is your only recovery. Do this before cancelling anything.

**D2 — Cancel SparkedHost**, but only after **two full raid weeks** of stable
running on the VPS. Keep it paid and *stopped* in the meantime — that is a
cheap warm standby.

**D4 — Regenerate the Discord token.** The old host had it. Reset it in the
developer portal, update `.env` on the VPS, `docker compose up -d`. This
permanently kills Rollback B, which is why it comes after D2.

**D3 — Remove the Atlas network-access rules and, last of all, the cluster.**
Take one more `mongodump` immediately before deleting the cluster, and keep it
outside the VPS. Deleting an Atlas free cluster is irreversible and there are no
snapshots to fall back on.

Do not skip the "keep it around" phases. The whole point of ordering it this way
is that the cheap safety nets outlive the expensive ones.

---

## 9. Backups

This is the reason for the migration. The target is 3-2-1: three copies, two
media, one off-site.

| Tier | Where | Retention | Purpose |
| --- | --- | --- | --- |
| 0 | OVH Premium automated backup | 7 rolling days | Fast whole-VM rollback. Same datacentre — not durability. |
| 1 | `/var/backups/dkp` on the VPS | 14 daily + 8 weekly | Instant restore of a bad day. |
| 2 | Cloudflare R2, encrypted | 90 days | Off-site, off-provider. |
| 3 | Synology NAS, encrypted | 180 days | Different building, different hands. |

### 9.1 The dump job

A nightly `mongodump` from the container to `/var/backups/dkp`, gzipped, with a
date-stamped filename. Three rules govern how it invokes `docker exec`:

- **Dump:** `docker exec dkp-mongo mongodump … > file` — **no `-t`, no `-i`**.
- **Restore:** `docker exec -i dkp-mongo mongorestore … < file` — `-i` required,
  `-t` never.
- **Never `-it` in a script.** A TTY's line discipline turns `\n` into `\r\n`
  and corrupts the archive. (Conversely, `docker exec` *without* `-t` cannot
  prompt for a password: mongo-tools' `password.Prompt()` branches on
  `IsTerminal()`, reads EOF, sends an empty password and fails auth. `-it` is
  only for interactive dumping.)

Create the directory and make it writable by the operator account before the
first run — `/var/backups` is root-owned, and a redirect from a non-root shell
fails *after* you have already stopped the bot:

```bash
sudo mkdir -p /var/backups/dkp
sudo chown "$USER:$USER" /var/backups/dkp
```

### 9.2 Encryption

Use **`age`**, not GPG — one binary, one recipient file, no keyring.

> **Copy the private key off the VPS before the first encrypted backup runs.**
> If the key only exists on the machine you are backing up, every off-site copy
> is unreadable the day that machine dies. That is not a backup, it is a
> ritual.

And make encryption **fail closed**. The natural-looking guard

```bash
[ -s "$AGE_RECIPIENTS" ] && age -R "$AGE_RECIPIENTS" ...
```

is exempt from `set -e` (it is a condition, not a failure), so a missing
recipients file silently ships **plaintext production data** to R2. Write it as
an explicit `if … else exit 1`.

### 9.3 Off-site: Cloudflare R2

R2's free tier is a recurring monthly allowance, not a trial: 10 GB-month of
storage, 1 M Class A operations, 10 M Class B, and — the reason to pick it —
**zero egress fees**, so a restore drill costs nothing. Activation likely
requires a card on file.

`rclone` config: `type = s3`, `provider = Cloudflare`, `region = auto`,
endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.

- Use **`rclone copy`** plus a separate `rclone delete --min-age 90d`. **Never
  `rclone sync`** — a sync mirrors local deletions upward, which turns a local
  disk problem into remote data loss.
- Add `--no-traverse` on the copy to avoid burning Class B operations listing
  the bucket.
- Write to a `.in-progress` name and rename on success, and make sure the
  temporary name is **excluded** from the rclone pattern, or you will upload
  half-written archives.
- Hard links do not deduplicate on object storage. Each retained copy costs its
  full size.

### 9.4 Off-site: Synology NAS — **pull, never push**

Have the NAS open an outbound SSH connection to the VPS and pull. No port
forwarding, no DDNS, works behind CGNAT, and the VPS gets no credentials for
your home network.

Lock the VPS-side key down in `~/.ssh/authorized_keys`:

```
command="/usr/bin/rrsync -ro /var/backups/dkp",restrict ssh-ed25519 AAAA... nas-pull
```

Two gotchas:

- With `rrsync`, the source path in the NAS-side rsync command is **relative to
  the rrsync root**. Passing `/var/backups/dkp` makes rrsync resolve it to
  `/var/backups/dkp/var/backups/dkp` and abort.
- Do not `chmod 600` the backup files in the dump script if the NAS pulls as a
  different user — that silently revokes the access the pull depends on, and the
  first you hear of it is a stale off-site copy.

### 9.5 The failure that actually loses data

It is not a corrupted archive. It is a backup job that quietly stopped running
three months ago. Three independent layers, in increasing order of
trustworthiness:

1. A Discord webhook fired on failure. Catches loud failures.
2. A success stamp — `/var/lib/dkp-backup/last-success` — plus a **second,
   independent cron watchdog** that alerts when the stamp goes stale. Catches
   the job that never ran at all (a job that does not run cannot report its own
   failure).
3. A freshness check **on the NAS**. This is the strongest, because it runs on a
   different machine: if the VPS is dead or lying, the NAS still notices that
   nothing new arrived.

### 9.6 Restore drill

Monthly, on a calendar reminder. Pull the latest off-site archive, restore it
into a throwaway container on a different port, and run the §5.4 count
comparison against production. An untested backup is a hypothesis.

---

## 10. Copying production to a dev machine

The point is a realistic dev database on your Windows machine without any risk
of touching production. Two rules carry most of the safety:

> **Rule 1 — the dev MongoDB listens on 27018, never 27017.** Not on
> `127.0.0.1:27017` and not on `[::1]:27017`. 27017 is the loaded gun: the
> repository's own specs hard-code `mongodb://localhost:27017` and call
> `deleteMany({})` on `players`, `raids` and `options` in `beforeEach`
> (`DKPManager/DKPManager.spec.js`, `Auctioner/Auctions.spec.js`). They ignore
> `MONGO_URL` entirely. Anything listening on 27017 will eventually be wiped by
> a stray `npm test`.
>
> **Rule 2 — `(DISCORD_TOKEN, MONGO_URL)` is a single unit.** Both prod or both
> dev, never one of each. A dev bot on the production database will end your
> live raid: `worker/Worker.js:27-38` calls `endRaid` when `guilds.fetch`
> returns error 10004 (Unknown Guild), which is exactly what happens when a bot
> that is not in your guild ticks a raid belonging to it.

Use a **second Discord application** and a private test guild.

### 10.1 Install the tools

```powershell
winget install --exact --id MongoDB.DatabaseTools
winget install --exact --id MongoDB.Shell
```

For the server itself, prefer the **ZIP** over the MSI. The MSI's Windows
service is optional, but it defaults to auto-starting on 27017 — see Rule 1.
Start it by hand on 27018:

```powershell
mongod --dbpath D:\Dev\dkp-dev-db --port 27018
```

### 10.2 Dump production, excluding the noise

```bash
mongodump \
  --uri="mongodb+srv://<user>:<password>@<cluster>.mongodb.net/" \
  --db=DKP \
  --excludeCollection=debuglog \
  --excludeCollection=shortAuctions \
  --gzip \
  --archive=D:/Dev/dkp-dumps/dkp-dev-$(date +%F).archive.gz
```

`debuglog` is large, has no `guild` field (so it cannot be filtered per guild
anyway) and carries free-form text; `shortAuctions` is dead.

### 10.3 Restore locally

```bash
mongorestore \
  --uri="mongodb://localhost:27018" \
  --archive=D:/Dev/dkp-dumps/dkp-dev-2026-08-23.archive.gz \
  --gzip --nsInclude='DKP.*' --drop --stopOnError
```

### 10.4 Scrub the secrets

Run [`tools/scrub-dev.js`](../tools/scrub-dev.js) against the **dev** instance:

```powershell
mongosh "mongodb://localhost:27018/DKP" --file tools\scrub-dev.js
```

Open the script first and set `KEEP_GUILD` to the guild snowflake you actually
want in dev. It refuses to run against an `mongodb.net` host, against port
27017, against any port not in its allow-list, and against a database that is
not `DKP`.

What it does:

1. Deletes every document belonging to **other guilds** (the production dump is
   genuinely multi-guild — `worker/Worker.js` iterates `guildOptions.find({})`).
2. Replaces the Raid-Helper API key with a dummy.
3. Replaces channel and role snowflakes with dummies.
4. Remaps guild snowflakes consistently.
5. Drops `debuglog`.

Every field is touched through `Object.prototype.hasOwnProperty`, so the script
never adds or removes a field — the schema constraint holds.

**Call this "secret scrubbing", not anonymisation.** Character names, log
comments and item text are untouched by design: you want realistic data. Treat
the dev database as confidential.

**Delete the archives in `D:\Dev\dkp-dumps` once restored** — they contain the
unscrubbed `raidHelperAPIKey`.

### 10.5 Dev `.env`

```
DISCORD_TOKEN=<the SECOND application's token>
DISCORD_CLIENT_ID=<the SECOND application's id>
MONGO_URL=mongodb://localhost:27018
LOG_LEVEL=DEBUG
```

---

## Appendix A — Enabling MongoDB authentication

Not required for the stack as designed: no port is published, so `mongod` is
reachable only from inside the compose network. The roster site does not need
it either — it reads the `/backup` JSON (§0). Keep this appendix for the day
something genuinely has to connect from outside; as things stand, none of it
applies.

**The trap first.** The official image's entrypoint appends `--auth` *before*
it probes the data directory, and only strips it again inside the
`if [ -n "$shouldPerformInitdb" ]` branch. So setting
`MONGO_INITDB_ROOT_USERNAME` / `MONGO_INITDB_ROOT_PASSWORD` on an **existing**
`mongo-data` volume enables authentication with **zero users defined** — and
the bot immediately fails with *"command find requires authentication"*, with
no way in to create anybody.

Correct order:

1. With auth still off, create the users:

   ```bash
   docker exec -it dkp-mongo mongosh --eval '
     db.getSiblingDB("admin").createUser({
       user: "root", pwd: passwordPrompt(), roles: ["root"] })'

   docker exec -it dkp-mongo mongosh --eval '
     db.getSiblingDB("DKP").createUser({
       user: "dkpbot", pwd: passwordPrompt(), roles: [{ role: "readWrite", db: "DKP" }] })'
   ```

   And, for any read-only consumer that might one day exist:

   ```javascript
   db.getSiblingDB("DKP").createUser({
     user: "readonly", pwd: passwordPrompt(), roles: [{ role: "read", db: "DKP" }] })
   ```

2. Add **only** the command override to the `mongo` service — not the
   `MONGO_INITDB_*` variables:

   ```yaml
   command: ["mongod", "--auth"]
   ```

3. Update `MONGO_URL` in `.env` to
   `mongodb://dkpbot:<password>@mongo:27017/DKP?authSource=DKP`. Remember the
   Compose interpolation rule: a `$` in the password must be written `$$`.

4. `docker compose up -d`.

The existing healthcheck needs no change: `ping` and `hello` are
`requiresAuth() == false`. Be aware, though, that it then proves only that the
server is alive, not that credentials work.

Note that exposing MongoDB to the internet also means publishing a port, which
— as §3.3 explains — ufw will not protect. Restrict it at the OVH edge only if
you accept the stateless-firewall caveat, or better, put the consumer behind an
SSH tunnel or a small read-only API rather than opening 27017.

---

## Appendix B — Indexes

There are currently **zero** `createIndex` calls anywhere in the repository.
Every query is a collection scan. At the present data volume that is fine, but
two indexes are worth adding once the migration has settled.

Indexes are not a schema change — a B-tree is separate storage and is invisible
through the CRUD API — so the documents `/backup` exports are byte-identical
with or without them, and the roster site cannot tell the difference.

```javascript
db.players.createIndex({ guild: 1, player: 1 })
db.raids.createIndex({ guild: 1, active: 1 })
```

Two warnings:

- `players {guild:1, player:1}` **may** eventually be made `unique`, but only
  after checking for existing duplicates. Creating a unique index on data that
  already contains duplicates fails.
- `raids {guild:1, active:1}` **must not** be unique. Every guild accumulates
  many `active: false` raids. If you ever want to enforce "one active raid per
  guild", that needs a partial index:

  ```javascript
  db.raids.createIndex({ guild: 1 }, { unique: true, partialFilterExpression: { active: true } })
  ```

---

## Appendix C — Traps worth memorising

| Trap | Rule |
| --- | --- |
| `mongo:8` resolves to an EOL 8.2 that will not start on an FCV-7.0 volume | Use `mongo:8.0` |
| `mongorestore --archive --db DKP` cannot rename and is deprecated | Use `--nsInclude='DKP.*'` |
| `mongorestore` inserts only, and continues past duplicate keys | Always `--drop --stopOnError` |
| PowerShell 5.1 corrupts binary redirection; `<` is a parser error | Always `--archive=<file>`; use Git Bash for pipes |
| `$` in an Atlas password is interpolated in double quotes | Single-quote the URI or percent-encode |
| `$` in a `.env` password is interpolated by Compose | Write it `$$` |
| `docker exec -t` corrupts binary archives | Dump: no flags. Restore: `-i` only. Never `-it` in a script |
| Two gateway sessions on one token both execute every command | Stop, then start. Never overlap |
| 1000 IDENTIFYs in 24 h resets the bot token | Stop the container on the first failed boot |
| `reloadCommands.js` creates guild duplicates and a second gateway session | Never run it |
| ufw does not filter published Docker ports | Publish no ports |
| A `99-` sshd drop-in loses to `50-cloud-init.conf` | Name it `00-hardening.conf` |
| `ssh.socket` on trixie makes `reload` fail and `Port` inert | Disable the socket, use `restart` |
| The OVH edge firewall auto-enables under DDoS with your stored rules | Leave it off **and** empty |
| `docker compose down -v` deletes `mongo-data` | Never run it |
| `docker compose stop dkp-bot` works; `stop dkp-mongo` does not | The service is `mongo` |
| No AVX means an eternal Mongo crash loop (exit code 132) | Check `/proc/cpuinfo` before anything else |
| A `[ -s file ] && encrypt` guard is exempt from `set -e` | Fail closed with `if … else exit 1` |
| The dev specs wipe `DKP` on `localhost:27017` | Dev Mongo listens on 27018 |
