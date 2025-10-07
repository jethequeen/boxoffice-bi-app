FROM mcr.microsoft.com/playwright:v1.55.0-jammy

USER root

# Make APT non-interactive and set timezone/locale up front
ENV DEBIAN_FRONTEND=noninteractive \
    TZ=America/Toronto \
    LANG=fr_CA.UTF-8 \
    LC_ALL=fr_CA.UTF-8 \
    NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /boxoffice-bi-app

# OS deps, fonts, tzdata + locales (no prompts)
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

# app code
COPY . .

# hand back to the unprivileged user provided by the base image
RUN chown -R pwuser:pwuser /boxoffice-bi-app
USER pwuser

# sanity check that bundled Chromium is present
RUN node -e "const fs=require('fs');console.log('chromium-present:',fs.existsSync('/ms-playwright'))"

CMD ["node", "cron/seatsSold.js"]
