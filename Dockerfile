# Dockerfile
FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=America/Toronto \
    LANG=fr_CA.UTF-8 \
    LC_ALL=fr_CA.UTF-8 \
    NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=0 \
    PUPPETEER_CACHE_DIR=/home/node/.cache/puppeteer

# System deps: tz + locales + Chromium runtime libs + certs + fonts (emoji optional)
RUN apt-get update -y && apt-get install -y --no-install-recommends \
      tzdata locales ca-certificates \
      libnss3 libnspr4 libatk1.0-0 libcups2 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxext6 libxshmfence1 \
      libasound2 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libpango-1.0-0 libpangocairo-1.0-0 \
      fonts-noto fonts-noto-cjk fonts-noto-color-emoji \
 && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
 && echo $TZ > /etc/timezone \
 && dpkg-reconfigure -f noninteractive tzdata \
 && sed -i 's/# fr_CA.UTF-8 UTF-8/fr_CA.UTF-8 UTF-8/' /etc/locale.gen \
 && locale-gen \
 && update-ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /boxoffice-bi-app

# Install deps first (this step downloads Chromium via Puppeteer)
COPY package*.json ./
RUN npm ci --omit=dev

# App code
COPY . .

# Drop root
RUN chown -R node:node /boxoffice-bi-app /home/node
USER node

# Launch your daemon (adjust path if it's cron/… instead)
CMD ["node", "daemon/seatsSold_daemon.js"]
