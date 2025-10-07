# Playwright 1.55.0 with browsers preinstalled
FROM mcr.microsoft.com/playwright:v1.55.0-jammy

ENV NODE_ENV=production \
    TZ=America/Toronto \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PUPPETEER_CACHE_DIR=/home/pwuser/.cache/puppeteer

WORKDIR /boxoffice-bi-app

# Install prod deps first for better cache
COPY package*.json ./
RUN npm ci --omit=dev

# Ensure the runtime has the SAME Playwright version as the image,
# regardless of your lockfile (no changes to your repo).
RUN npm i --no-save playwright@1.55.0

# Copy source
COPY . .

# --- Make puppeteer-core find a Chrome binary ---
# Create a stable symlink to the Chromium that ships with the Playwright image.
USER root
RUN set -eux; \
    CHROME_PATH="$(echo /ms-playwright/chromium-*/chrome-linux/chrome)"; \
    ln -sf "${CHROME_PATH}" /usr/local/bin/chromium-from-pw; \
    chown -h pwuser:pwuser /usr/local/bin/chromium-from-pw

# Point Puppeteer to that Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/chromium-from-pw

# Drop privileges
USER pwuser

# Optional healthcheck
HEALTHCHECK --interval=1m --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "process.exit(0)" && npx playwright --version >/dev/null 2>&1 || exit 1

# Run your daemon
CMD ["node", "cron/seatsSold.js"]
