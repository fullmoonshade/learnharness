FROM node:26-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:26-bookworm-slim AS builder

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

RUN npm run build \
	&& node scripts/smoke-provider-runtime.mjs \
	&& node scripts/build-server.mjs

FROM node:26-bookworm-slim AS runtime

ENV NODE_ENV=production \
	NEXT_TELEMETRY_DISABLED=1 \
	HOSTNAME=0.0.0.0 \
	PORT=3000 \
	LH_DATA_DIR=/var/lib/learnharness/data \
	CHROME_PATH=/usr/bin/chromium

RUN apt-get update \
	&& apt-get install --yes --no-install-recommends \
		ca-certificates \
		chromium \
		fonts-dejavu-core \
	&& rm -rf /var/lib/apt/lists/* \
	&& groupadd --system --gid 1001 learnharness \
	&& useradd --system --uid 1001 --gid learnharness learnharness \
	&& mkdir -p /app /var/lib/learnharness/data \
	&& chown -R learnharness:learnharness /app /var/lib/learnharness

WORKDIR /app

COPY --from=builder --chown=learnharness:learnharness /app/.next/standalone ./

USER learnharness

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["sh", "-c", "export LH_AUTH_FILE=\"${LH_AUTH_FILE:-/var/lib/learnharness/auth.json}\"; exec node server.js"]
