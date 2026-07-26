# Media worker: TorBox audits, trust snapshots, embedded-subtitle alignment.
#
# Sized for a second service on an existing 1 CPU / 1 GB droplet that already runs
# the Telegram→Stremio addon. Only ffmpeg (with ffprobe) and alass are needed —
# there is no audio-sync path, so no Python, Whisper, or ffsubsync.
FROM node:22-alpine

RUN apk add --no-cache ffmpeg ca-certificates wget \
    && ARCH="$(uname -m)" \
    && case "$ARCH" in \
         x86_64)  ALASS_URL="https://github.com/kaegi/alass/releases/download/v2.0.0/alass-linux64" ;; \
         aarch64) ALASS_URL="" ;; \
         *)       ALASS_URL="" ;; \
       esac \
    # alass ships an x86_64 binary. On other architectures the image builds without
    # it and the worker fails alignment jobs cleanly instead of crash-looping.
    && if [ -n "$ALASS_URL" ]; then \
         wget -q -O /usr/local/bin/alass "$ALASS_URL" && chmod +x /usr/local/bin/alass; \
       else \
         echo "alass unavailable for $ARCH — build with a prebuilt binary mounted at /usr/local/bin/alass"; \
       fi \
    && apk del wget

WORKDIR /app

# Only the runtime dependency (node-fetch) is installed; there is no build step.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The worker imports shared logic from lib/ so parsing and ranking semantics stay
# identical between Vercel and this process.
COPY lib ./lib
COPY worker ./worker

ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=384

# Single heavy job at a time; the loop yields entirely while Telegram streams.
CMD ["node", "worker/media-intelligence/index.mjs"]
