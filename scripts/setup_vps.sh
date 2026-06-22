#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# VPS Setup Script — Cài đặt dependencies cho Serena AI Brain
# Chạy: bash scripts/setup_vps.sh
# ═══════════════════════════════════════════════════════════════

set -e

echo "🔧 Updating system..."
sudo apt update && sudo apt upgrade -y

echo "📦 Installing Node.js 24..."
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs

echo "📦 Installing FFmpeg (required for Discord voice)..."
sudo apt install -y ffmpeg

echo "📦 Installing Python 3 + edge-tts (required for TTS)..."
sudo apt install -y python3 python3-pip
pip3 install edge-tts

echo "📦 Installing PM2 (process manager)..."
sudo npm install -g pm2

echo "📦 Installing Git..."
sudo apt install -y git

echo "✅ All dependencies installed!"
echo ""
echo "📋 Next steps:"
echo "1. Clone repo: git clone https://github.com/realBoBao/Serena_Project00_Auto-Teaching.git"
echo "2. cd Serena_Project00_Auto-Teaching"
echo "3. npm install --legacy-peer-deps --ignore-scripts"
echo "4. Copy .env and configure"
echo "5. pm2 start discord_bot.js --name AI-Brain"
echo ""
echo "🎙️ Voice will work on VPS Linux with FFmpeg installed!"
