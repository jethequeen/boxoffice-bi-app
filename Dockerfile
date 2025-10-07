FROM mcr.microsoft.com/playwright:v1.55.0-jammy

# become root for OS packages
USER root

ENV TZ=America/Toronto \
    NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    LANG=fr_CA.UTF-8 \
    LC_ALL=fr_CA.UTF-8

# fonts + locale (no sudo)
RUN apt-get update && apt-get install -y --no-install-recommends \
      locales tzdata fonts-noto fonts-noto-cjk fonts-noto-color-emoji \
    && sed -i 's/# fr_CA.UTF-8 UTF-8/fr_CA.UTF-8 UTF-8/' /etc/locale.gen \
    && locale-gen \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /boxoffice-bi-app

# deps first for better cache
COPY package*.json ./
RUN npm ci --omit=dev

# app code
COPY . .

# make sure app dir is owned by pwuser (the runtime user in this image)
RUN chown -R pwuser:pwuser /boxoffice-bi-app

# drop privileges back to pwuser for runtime
USER pwuser

# quick sanity check that bundled Chromium exists
RUN node -e "const fs=require('fs');console.log('chromium-present:',fs.readdirSync('/ms-playwright').some(n=>n.startsWith('chromium'))) "

CMD ["node", "cron/seatsSold.js"]
