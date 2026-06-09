# 🔥 HOTFIX — Production Server Issues

## 1. `Pipeline error: score is not defined`

**Nguyên nhân:** Trong `pipeline_report_v2.js`, hàm `calculateSourceScore()` trả về giá trị 0-1, nhưng code so sánh `r.score >= 6` (giả định thang 0-10).

**Fix đã áp dụng:** Đổi threshold từ `6/4` → `0.7/0.4`.

**Trên production server, chạy:**
```bash
cd /home/bogiabao2006/ai-brain
grep -n "score >= 6" pipeline_report_v2.js
# Nếu có, sửa thành:
# const goodRepos = repos.filter(r => r.score >= 0.7);
# const okRepos = repos.filter(r => r.score >= 0.4 && r.score < 0.7);
# const weakRepos = repos.filter(r => r.score < 0.4);
```

## 2. `Backup failed: Unexpected end of input`

**Nguyên nhân:** File `catch-up.json` hoặc backup metadata bị corrupt (empty hoặc truncated).

**Fix:** Thêm defensive JSON.parse vào tất cả đọc file:

```javascript
// Trong scheduler.js — thay thế mọi JSON.parse(file) bằng:
function safeReadJson(filePath, defaultValue = {}) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || raw.trim() === '') return defaultValue;
    return JSON.parse(raw);
  } catch {
    console.warn(`[scheduler] Corrupt JSON file: ${filePath}, using defaults`);
    return defaultValue;
  }
}
```

**Trên production server:**
```bash
# Kiểm tra file corrupt
cat /home/bogiabao2006/ai-brain/catch-up.json
# Nếu empty hoặc truncated:
echo '{}' > /home/bogiabao2006/ai-brain/catch-up.json
```

## 3. Các lỗi KHÔNG CẦN SỬA (expected behavior)

| Lý do | Fallback |
|---|---|
| `Qdrant not available` | ✅ Tự fallback SQLite |
| `Reddit 403` | ✅ Trả về empty results |
| `LLM API error` | ✅ Fallback heuristic |
| `Gemini 503` | ✅ Tự retry |
| `Discord shard reconnecting` | ✅ Auto-reconnect |
