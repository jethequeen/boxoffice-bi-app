# Playwright image that ALREADY contains matching Chromium build
# (match your package.json's "playwright": "1.55.x")
FROM mcr.microsoft.com/playwright:v1.55.0-jammy

# Node is already installed in this image (v18 LTS). If you REQUIRE Node 20, uncomment:
# RUN sudo apt-get update && sudo apt-get install -y --no-install-recommends curl ca-certificates \
#   && curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - \
#   && sudo apt-get install -y nodejs && sudo apt-get clean && sudo rm -rf /var/lib/apt/lists/*

ENV TZ=America/Toronto \
    NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    LANG=fr_CA.UTF-8 \
    LC_ALL=fr_CA.UTF-8

# Fonts for proper text rendering (accents, emoji, etc.)
RUN sudo apt-get update && sudo apt-get install -y --no-install-recommends \
    locales tzdata fonts-noto fonts-noto-cjk fonts-noto-color-emoji \
    && sudo sed -i 's/# fr_CA.UTF-8 UTF-8/fr_CA.UTF-8 UTF-8/' /etc/locale.gen \
    && sudo locale-gen \
    && sudo rm -rf /var/lib/apt/lists/*

WORKDIR /boxoffice-bi-app

# Install deps with browsers already present in image
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Optional: sanity check that Chromium exists in the image
RUN node -e "console.log('has browser?', require('fs').existsSync('/ms-playwright/chromium-*/chrome-linux'))"

# Default user is 'pwuser' with proper permissions in base image
USER pwuser

# Start your daemon
CMD ["node", "cron/seatsSold.js"]
