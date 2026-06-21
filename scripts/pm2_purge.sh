#!/bin/bash
# PM2 Deep Purge & Restart Script
# Chạy: bash scripts/pm2_purge.sh

echo "=== PM2 Deep Purge ==="

# 1. Kill all PM2 processes
echo "[1/5] Killing PM2 daemon..."
pm2 kill

# 2. Clear all PM2 logs
echo "[2/5] Clearing PM2 logs..."
rm -rf ~/.pm2/logs/*

# 3. Install missing dependencies
echo "[3/5] Installing missing npm packages..."
npm install dotenv @langchain/core better-sqlite3 2>/dev/null || true

# 4. Start all processes from ecosystem
echo "[4/5] Starting PM2 from ecosystem.config.cjs..."
pm2 start ecosystem.config.cjs

# 5. Save PM2 config
echo "[5/5] Saving PM2 config..."
pm2 save

echo "=== Done ==="
echo "Check status: pm2 list"
echo "Check logs: pm2 logs --lines 20"
