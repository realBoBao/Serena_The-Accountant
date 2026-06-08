#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# deploy.sh — AI Brain VPS Deployment Script
# ═══════════════════════════════════════════════════════════════
# Usage: bash deploy.sh
# Prerequisites: Docker, Docker Compose, Git
# ═══════════════════════════════════════════════════════════════

set -e

echo "═══════════════════════════════════════════════"
echo "  AI Brain — VPS Deployment"
echo "═══════════════════════════════════════════════"

# ── Step 1: Update code ──
echo ""
echo "[1/6] Pulling latest code..."
git pull origin main 2>/dev/null || echo "  (skipping git pull — not a git repo)"

# ── Step 2: Check .env ──
echo ""
echo "[2/6] Checking .env file..."
if [ ! -f .env ]; then
    echo "  ❌ .env not found! Copy .env.example and fill in your keys:"
    echo "     cp .env.example .env"
    echo "     nano .env"
    exit 1
fi
echo "  ✅ .env found"

# ── Step 3: Create data directories ──
echo ""
echo "[3/6] Creating data directories..."
mkdir -p data models artifacts backups logs
echo "  ✅ Directories ready"

# ── Step 4: Build Docker image ──
echo ""
echo "[4/6] Building Docker image..."
docker compose build --no-cache ai-brain
echo "  ✅ Image built"

# ── Step 5: Start services ──
echo ""
echo "[5/6] Starting services..."
docker compose down 2>/dev/null || true
docker compose up -d redis qdrant
echo "  ⏳ Waiting for Redis + Qdrant to be ready..."
sleep 10
docker compose up -d ai-brain
echo "  ✅ All services started"

# ── Step 6: Verify ──
echo ""
echo "[6/6] Verifying deployment..."
sleep 5

HEALTH=$(curl -s http://localhost:3000/health 2>/dev/null || echo '{"status":"error"}')
STATUS=$(echo "$HEALTH" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).status)}catch{console.log('error')}})")
echo "  Health: $STATUS"

if [ "$STATUS" = "healthy" ] || [ "$STATUS" = "degraded" ]; then
    echo ""
    echo "═══════════════════════════════════════════════"
    echo "  ✅ Deployment successful!"
    echo "═══════════════════════════════════════════════"
    echo ""
    echo "  Ports:"
    echo "    3000 — Health + Webhooks"
    echo "    3005 — REST API"
    echo "    6379 — Redis"
    echo "    6333 — Qdrant"
    echo ""
    echo "  Commands:"
    echo "    docker compose logs -f ai-brain  # View logs"
    echo "    docker compose restart ai-brain  # Restart bot"
    echo "    docker compose down              # Stop all"
    echo ""
else
    echo ""
    echo "  ⚠️  Health check returned: $STATUS"
    echo "  Check logs: docker compose logs ai-brain"
fi
