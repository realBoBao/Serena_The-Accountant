@echo off
cd /d C:\Users\bogia\Downloads\my-ai-brain
pm2 start ecosystem.config.cjs
echo AI Brain started in background. Use 'pm2 list' to check status.
echo To stop: pm2 kill
