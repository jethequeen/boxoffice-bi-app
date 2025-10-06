# ---- Base image with Chromium deps (built once, cached) ----
FROM node:20-bullseye AS base

ENV TZ=America/Toronto \
    DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update && apt-get install -y --no-install-recommends \
    tzdata ca-certificates chromium \
    libnss3 libxss1 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxrandr2 \
    libgtk-3-0 libasound2 libatk1.0-0 libatk-bridge2.0-0 \
    libdrm2 libgbm1 libxdamage1 libpango-1.0-0 libcairo2 \
    libxshmfence1 libxkbcommon0 \
    fonts-liberation fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*


WORKDIR /boxoffice-bi-app

# ---- Dependencies layer (reused for dev/prod) ----
FROM base AS deps
# leverage build cache for npm
COPY package*.json ./
# cache npm downloads so "npm ci" is fast
# (safe to omit if your builder doesn't support --mount=type=cache)
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# ---- Runtime base with node_modules but no app code (great for dev) ----
FROM base AS runtime
COPY --from=deps /boxoffice-bi-app/node_modules ./node_modules
# Optional: preinstall nodemon for dev (or use npx in compose)
RUN npm i -g nodemon
USER node

# ---- Production image (copies source once; immutable at runtime) ----
FROM runtime AS prod
COPY . .
# Healthcheck is optional
HEALTHCHECK --interval=1m --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "process.exit(0)"
CMD ["node", "cron/seatsSold.js"]
