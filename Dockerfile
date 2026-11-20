# Remote Booth – small image (~120 MB), runs on any x86-64 or ARM64 machine, no GPU needed
FROM node:22-alpine

LABEL org.opencontainers.image.title="Remote Booth" \
      org.opencontainers.image.description="Self-hosted remote podcast studio: record every guest as a separate track, edit and export in the browser" \
      org.opencontainers.image.source="https://github.com/Schnubbirunkel/Remote-Booth" \
      org.opencontainers.image.licenses="MIT"

RUN apk add --no-cache ffmpeg tzdata
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public

ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
RUN mkdir -p /data
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/time || exit 1
CMD ["node", "server/index.js"]
