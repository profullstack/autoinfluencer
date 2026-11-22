FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/autoinfluencer.db AUTOINFLUENCER_TIMEOUT_MS=240000
# --chown + chmod: host checkouts are often 0660, which the node user cannot read.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
RUN chmod -R a+rX /app && mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
# No Docker HEALTHCHECK: the c0mpute worker health-checks /healthz itself, and its 30 s snapshot
# pause would fail a Docker check, which dev2 watchdog-autoheal answers with `docker restart`
# (new dynamic port, stale in the worker, 502).
CMD ["node", "src/server.js"]
