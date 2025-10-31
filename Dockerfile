﻿FROM mcr.microsoft.com/playwright:v1.56.0-jammy

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=America/Toronto \
    LANG=fr_CA.UTF-8 \
    LC_ALL=fr_CA.UTF-8 \
    NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /boxoffice-bi-app

USER root
RUN apt-get update -y \
 && apt-get install -y --no-install-recommends tzdata locales fonts-noto fonts-noto-cjk fonts-noto-color-emoji \
 && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
 && echo $TZ > /etc/timezone \
 && dpkg-reconfigure -f noninteractive tzdata \
 && sed -i 's/# fr_CA.UTF-8 UTF-8/fr_CA.UTF-8 UTF-8/' /etc/locale.gen \
 && locale-gen \
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN chown -R pwuser:pwuser /boxoffice-bi-app
USER pwuser

ENV XDG_RUNTIME_DIR=/tmp/runtime-pwuser
RUN mkdir -p $XDG_RUNTIME_DIR && chmod 700 $XDG_RUNTIME_DIR

CMD ["node", "cron/seatsSold_daemon.js"]
