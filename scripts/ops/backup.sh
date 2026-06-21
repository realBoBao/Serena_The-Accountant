#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Auto-Backup Script — AI Brain
# Chạy mỗi đêm lúc 2AM qua cronjob
# ═══════════════════════════════════════════════════════════════

BACKUP_DIR="$HOME/backups"
PROJECT_DIR="$HOME/my-ai-brain"
DATE=$(date +%Y-%m-%d_%H%M%S)
RETENTION_DAYS=7  # Giữ backup 7 ngày

# Tạo thư mục backup nếu chưa có
mkdir -p "$BACKUP_DIR"

# Tạo backup
BACKUP_FILE="$BACKUP_DIR/ai_data_$DATE.tar.gz"

echo "[Backup] Starting backup at $(date)"
echo "[Backup] Project dir: $PROJECT_DIR"
echo "[Backup] Backup file: $BACKUP_FILE"

# Gom tất cả file .db, .sqlite, .csv, .json (trừ node_modules)
cd "$PROJECT_DIR" || exit 1

# Liệt kê file sẽ backup
FILES_TO_BACKUP=$(find . -type f \( -name "*.db" -o -name "*.sqlite" -o -name "*.csv" -o -name "*.json" \) ! -path "./node_modules/*" ! -path "./.git/*" 2>/dev/null)

if [ -z "$FILES_TO_BACKUP" ]; then
    echo "[Backup] ⚠️ No database files found"
    exit 0
fi

# Nén và lưu
tar -czf "$BACKUP_FILE" $FILES_TO_BACKUP 2>/dev/null

if [ -f "$BACKUP_FILE" ]; then
    SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    echo "[Backup] ✅ Success: $BACKUP_FILE ($SIZE)"
else
    echo "[Backup] ❌ Failed to create backup"
    exit 1
fi

# Xóa backup cũ hơn 7 ngày
DELETED=$(find "$BACKUP_DIR" -name "ai_data_*.tar.gz" -mtime +$RETENTION_DAYS -delete -print | wc -l)
echo "[Backup] Cleaned up $DELETED old backup(s) (older than $RETENTION_DAYS days)"

echo "[Backup] Done at $(date)"
