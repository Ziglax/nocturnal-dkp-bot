# Debian (glibc): ffmpeg-static and @snazzah/davey ship glibc-only
# prebuilt binaries that fail to run/build on alpine's musl libc.
# node >= 22.12 required by @discordjs/voice 0.19 (dev machine runs Node 24).
FROM node:24-bookworm-slim

WORKDIR /app

# Production deps only (jest lives in devDependencies). If the lockfile drifts
# from package.json, let the build fail loudly — resync with `npm install`
# on the dev machine and commit the result.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Baked-in copy makes the image runnable standalone; under docker-compose the
# ./:/app bind mount shadows it and serves the live source instead.
COPY . .

# No EXPOSE: dkp-bot is a pure Discord gateway client, it serves no HTTP.
# Slash commands self-register at startup (index.js), so no separate register step.
CMD ["node", "index.js"]
