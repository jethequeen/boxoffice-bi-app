FROM mcr.microsoft.com/playwright:v1.56.0-jammy

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

# Dépendances OS + locales + fonts
RUN apt-get update -y \
 && apt-get install -y --no-install-recommends \
      tzdata locales fonts-noto fonts-noto-cjk fonts-noto-color-emoji \
 && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
 && echo $TZ > /etc/timezone \
 && dpkg-reconfigure -f noninteractive tzdata \
 && sed -i 's/# fr_CA.UTF-8 UTF-8/fr_CA.UTF-8 UTF-8/' /etc/locale.gen \
 && locale-gen \
 && rm -rf /var/lib/apt/lists/*

# Node deps d'abord
COPY package*.json ./
RUN npm ci --omit=dev

# On installe le Chrome correspondant à ta version de puppeteer-core
USER pwuser
SHELL ["/bin/bash", "-lc"]
RUN npx -y puppeteer@$(node -p "require('./node_modules/puppeteer-core/package.json').version.split('.')[0]") \
      browsers install chrome \
 && echo "PUPPETEER_EXECUTABLE_PATH=$(node -e \"\
  const fs=require('fs');\
  const p=process.env.PUPPETEER_CACHE_DIR||process.env.HOME+'/.cache/puppeteer';\
  const v=require('./node_modules/puppeteer-core/package.json').version.split('.')[0];\
  const d=fs.readdirSync(p).find(n=>n.startsWith('chrome'));\
  console.log(p+'/'+d+'/chrome-linux64/chrome');\
 \")" | tee -a /home/pwuser/.bashrc /etc/environment

# Répertoire runtime pour Chrome (évite crashs XDG + sandbox)
RUN mkdir -p /tmp/runtime-pwuser && chmod 700 /tmp/runtime-pwuser

# Appli
USER root
COPY . .
RUN chown -r pwuser:pwuser /boxoffice-bi-app
USER pwuser
ENV XDG_RUNTIME_DIR=/tmp/runtime-pwuser

# Bonnes pratiques headless: no-sandbox + shm
# (tu as déjà shm_size: "1gb" dans compose)
CMD ["node", "cron/seatsSold_daemon.js"]
