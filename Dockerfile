# Chromium + deps preinstalled (Puppeteer team image)
FROM ghcr.io/puppeteer/puppeteer:23

ENV TZ=Europe/Madrid \
    NODE_ENV=production \
    PUPPETEER_CACHE_DIR=/home/pptruser/.cache/puppeteer

# Run as non-root user that ships with the image
USER pptruser
WORKDIR /home/pptruser/app

# Install deps first (better cache)
COPY --chown=pptruser:pptruser package*.json ./
RUN npm ci --omit=dev --unsafe-perm --loglevel verbose

# Copy source
COPY --chown=pptruser:pptruser src ./src

EXPOSE 3000
CMD ["npm", "start"]
