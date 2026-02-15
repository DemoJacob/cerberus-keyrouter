# --- Build stage ---
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# --- Runtime stage ---
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install Bitwarden CLI
RUN npm install -g @bitwarden/cli

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy compiled JS from builder
COPY --from=builder /app/dist ./dist

# Copy frontend HTML files to dist
COPY src/audit-frontend.html ./dist/audit-frontend.html
COPY src/admin-frontend.html ./dist/admin-frontend.html
COPY src/approve-frontend.html ./dist/approve-frontend.html

# Copy entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create data directory for config + audit DBs
RUN mkdir -p /app/data

EXPOSE 8899

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:8899/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
