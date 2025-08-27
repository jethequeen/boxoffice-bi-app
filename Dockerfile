# ---- Build & runtime image (Debian-based for Puppeteer deps) ----
FROM node:20-bullseye

# Set timezone & locales early (noninteractive tzdata install)
ENV TZ=America/Toronto \
    DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# System deps for Chromium + fonts
RUN apt-get update && apt-get install -y --no-install-recommends \
    tzdata ca-certificates \
    chromium \
    # common runtime libs Puppeteer/Chromium need
    libnss3 libxss1 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxrandr2 \
    libgtk-3-0 libasound2 libatk1.0-0 libatk-bridge2.0-0 \
    libdrm2 libgbm1 libxdamage1 \
    libpango-1.0-0 libcairo2 \
    fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# App directory
WORKDIR /app

# Install node deps first (better layer cache)
COPY package*.json ./
# If you use pnpm/yarn, swap accordingly
RUN npm ci --omit=dev

# Copy source
COPY . .

# Use the pre-created 'node' user from base image for safer runtime
USER node

# No ports to expose; this is a daemon
# Healthcheck is optional; here we just ensure node can start
HEALTHCHECK --interval=1m --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "process.exit(0)"

# Run the daemon
CMD ["node", "cron/seatsSold_daemon.js"]
