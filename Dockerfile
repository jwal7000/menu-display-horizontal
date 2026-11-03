# Menu pipeline — one image, two Cloud Run Jobs (menu-build, inventory-sync).
# Build/deploy: cloudrun/deploy-menu-jobs.sh
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src

# Jobs run as an unprivileged user; clones go to /tmp (in-memory on Cloud Run).
USER node
ENV NODE_ENV=production

ENTRYPOINT ["node", "src/jobs/run.js"]
