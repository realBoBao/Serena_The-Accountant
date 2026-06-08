# ═══════════════════════════════════════════════════════════════
# Dockerfile — AI Brain Production
# ═══════════════════════════════════════════════════════════════
# Build: docker build -t my-ai-brain .
# Run:   docker run -d --name ai-brain -p 3000:3000 -p 3005:3005 --env-file .env my-ai-brain
# ═══════════════════════════════════════════════════════════════

FROM node:22-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    python3-pip \
    ffmpeg \
    build-essential \
    cmake \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files first (for layer caching)
COPY package.json package-lock.json* ./

# Install Node.js dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Create non-root user
RUN useradd -m -s /bin/bash aibot && chown -R aibot:aibot /app
USER aibot

# Expose ports
EXPOSE 3000 3005

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

# Start via PM2
CMD ["node", "gateway.js"]
