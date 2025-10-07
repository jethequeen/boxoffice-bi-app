# Ships Chromium/WebKit/Firefox + all deps preinstalled
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

ENV NODE_ENV=production \
    TZ=America/Toronto \
    # Playwright keeps browsers here
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    # We'll point puppeteer-core at this symlink we create below
    PUPPETEER_CACHE_DIR=/home/pwuser/.cache/puppeteer

WORKDIR /boxoffice-bi-app

# Install deps first for better cache
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# --- Make puppeteer-core find a Chrome binary ---
# The Playwright image contains Chromium at /ms-playwright/chromium-*/chrome-linux/chrome.
# Create a stable symlink and export PUPPETEER_EXECUTABLE_PATH to it.
USER root
RUN set -eux; \
    CHROME_PATH="$(echo /ms-playwright/chromium-*/chrome-linux/chrome)"; \
    ln -sf "${CHROME_PATH}" /usr/local/bin/chromium-from-pw; \
    chown -h pwuser:pwuser /usr/local/bin/chromium-from-pw

ENV PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/chromium-from-pw

# Drop privileges
USER pwuser

# Optional healthcheck
HEALTHCHECK --interval=1m --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "process.exit(0)" && npx playwright --version >/dev/null 2>&1 || exit 1

CMD ["node", "cron/seatsSold.js"]
