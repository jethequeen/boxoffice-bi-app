# Includes Chromium/WebKit/Firefox + all required OS deps preinstalled
# Pin a version you’re comfortable with:
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

# Keep Node in production mode
ENV NODE_ENV=production \
    TZ=America/Toronto \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Workdir
WORKDIR /boxoffice-bi-app

# Install dependencies first for better layer caching
COPY package*.json ./
# If you use pnpm/yarn, swap this line accordingly
RUN npm ci --omit=dev

# Copy the rest of your source
COPY . .

# Use the pre-created 'pwuser' (playwright base image default) which has correct permissions
USER pwuser

# Optional healthcheck (verifies Node runs & Playwright CLI is present)
HEALTHCHECK --interval=1m --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "process.exit(0)" && npx playwright --version >/dev/null 2>&1 || exit 1

# Run your daemon
CMD ["node", "cron/seatsSold.js"]
