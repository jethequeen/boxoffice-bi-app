FROM mcr.microsoft.com/playwright:v1.55.0-jammy
USER root

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=America/Toronto \
    LANG=fr_CA.UTF-8 \
    LC_ALL=fr_CA.UTF-8 \
    NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PUPPETEER_CACHE_DIR=/home/pwuser/.cache/puppeteer \
    PUPPETEER_SKIP_DOWNLOAD=1

WORKDIR /boxoffice-bi-app

# OS bits (non-interactive tz/locales)
RUN apt-get update -y \
 && apt-get install -y --no-install-recommends \
      tzdata locales fonts-noto fonts-noto-cjk fonts-noto-color-emoji \
 && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
 && echo $TZ > /etc/timezone \
 && dpkg-reconfigure -f noninteractive tzdata \
 && sed -i 's/# fr_CA.UTF-8 UTF-8/fr_CA.UTF-8 UTF-8/' /etc/locale.gen \
 && locale-gen \
 && rm -rf /var/lib/apt/lists/*

# deps first for cache
COPY package*.json ./
RUN npm ci --omit=dev

# Install the exact Chrome that your puppeteer-core expects
# (use the puppeteer CLI matching your puppeteer-core version)
# If you have puppeteer-core@22.x, use the same major here:
RUN su - pwuser -c "npx -y puppeteer@$(node -p \"require('./node_modules/puppeteer-core/package.json').version.split('.')[0]\") browsers install chrome"

# app code
COPY . .
RUN chown -R pwuser:pwuser /boxoffice-bi-app
USER pwuser

CMD ["node", "cron/seatsSold.js"]
