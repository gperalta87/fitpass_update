# Chromium + deps preinstalled (Puppeteer team image)
FROM ghcr.io/puppeteer/puppeteer:23

ENV TZ=Europe/Madrid \
    NODE_ENV=production \
    PUPPETEER_CACHE_DIR=/home/pptruser/.cache/puppeteer

WORKDIR /home/pptruser/app

# Install deps first (better cache)
COPY --chown=pptruser:pptruser package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY --chown=pptruser:pptruser src ./src

# Switch to non-root user AFTER everything is copied
USER pptruser

EXPOSE 3000
CMD ["npm", "start"]