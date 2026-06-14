# ═══════════════════════════════════════════════════════════════
# Dockerfile — Cloud Run (REST API Server)
# ═══════════════════════════════════════════════════════════════
# Build:     docker build -t my-ai-brain-api .
# Run local: docker run -p 8080:8080 --env-file .env my-ai-brain-api
# Deploy:    gcloud run deploy my-ai-brain-api --source . --region us-central1
# ═══════════════════════════════════════════════════════════════

FROM node:22-slim

# Install system dependencies (ffmpeg for ManimAgent, python3 for sandbox)
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

# Copy package files first (for Docker layer caching)
COPY package.json package-lock.json* ./

# Install Node.js dependencies (production only for smaller image)
RUN npm ci --only=production

# Copy source code
COPY . .

# Cloud Run sets PORT env var (default 8080).
# rest_api_server.js already reads process.env.PORT.
# Override REST_API_PORT to match so health checks work.
ENV PORT=8080
ENV REST_API_PORT=8080

# Expose port (documentation — Cloud Run uses $PORT)
EXPOSE 8080

# Health check (Cloud Run uses this to verify container startup)
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "const http=require('http');const p=process.env.PORT||8080;http.get('http://localhost:'+p+'/api/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

# Start REST API server (Cloud Run entry point)
CMD ["node", "rest_api_server.js"]
