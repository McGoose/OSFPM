# ── Stage 1: build the React client ──────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# Copy manifests first so dependency layers are cached independently of source
COPY package.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/

RUN npm install --workspaces --include-workspace-root

COPY client/ ./client/
COPY server/ ./server/

RUN npm run build -w client

# ── Stage 2: lean production image ────────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY server/package.json ./server/

# Install server-only production dependencies
RUN npm install --workspace=server --omit=dev

COPY server/ ./server/
COPY --from=builder /app/client/dist ./client/dist

# Data directory is created at runtime by db/index.js; mount a volume here
VOLUME ["/app/data"]

EXPOSE 5000

CMD ["node", "server/src/index.js"]
