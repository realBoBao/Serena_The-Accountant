# 🚀 Hướng dẫn cài đặt my-ai-brain trên máy mới

## Yêu cầu hệ thống

- **Node.js** 20+ (khuyến nghị 24)
- **Git**
- **PM2** (`npm install -g pm2`)
- **Python 3** + **FFmpeg** (cho Manim animation, tùy chọn)

## Cài đặt

### 1. Clone project
```powershell
git clone https://github.com/YOUR_USERNAME/my-ai-brain.git
cd my-ai-brain
```

### 2. Cài dependencies
```powershell
npm install
```

### 3. Tạo file .env
```powershell
copy .env.example .env
```

Mở file `.env` và điền các API keys cần thiết:

| Key | Bắt buộc? | Cách lấy |
|---|---|---|
| `DISCORD_BOT_TOKEN` | ✅ Có | Discord Developer Portal → Bot → Token |
| `GOOGLE_API_KEY` | ✅ Có | Google AI Studio → API Key |
| `OPENROUTER_API_KEY` | ✅ Có | openrouter.ai → Keys |
| `TAVILY_API_KEY` | ✅ Có | app.tavily.com → API Key |
| `GITHUB_TOKEN` | ❌ Không | GitHub → Settings → Personal Access Tokens |
| `YOUTUBE_API_KEY` | ❌ Không | Google Cloud Console → YouTube Data API |

### 4. Khởi động
```powershell
# Development
node gateway.js

# Production (với PM2)
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # Auto-start khi reboot
```

### 5. Kiểm tra
- Health Check: http://localhost:3000/health
- REST API: http://localhost:3005/api/health
- Discord: Gõ `!help` trong Discord server

## Cấu trúc thư mục

```
my-ai-brain/
├── agents/           # Các AI Agent
│   ├── RagAgent.js       # RAG + LLM
│   ├── CoderAgent.js     # Viết/chạy code
│   ├── VisionAgent.js    # Phân tích ảnh
│   ├── VoiceAgent.js     # Transcribe audio
│   ├── DebateAgent.js    # Tranh luận
│   ├── ManimAgent.js     # Animation
│   ├── PlannerAgent.js   # Lập kế hoạch
│   └── InteractionAgent.js # Gateway agent
├── lib/              # Thư viện chung
│   ├── llm.js            # Unified LLM layer
│   ├── embeddings.js     # Gemini embedding
│   ├── vector_store.js   # Vector DB
│   ├── task_queue.js     # BullMQ queue
│   └── session_store.js  # Session management
├── gateway.js        # Entry point (chạy tất cả)
├── discord_bot.js    # Discord bot
├── rest_api_server.js # REST API
├── scheduler.js      # Cron jobs
├── watch_library.js  # File watcher
└── ecosystem.config.cjs # PM2 config
```

## Discord Commands

Gõ `!help` trong Discord để xem danh sách lệnh.

## Troubleshooting

| Vấn đề | Giải pháp |
|---|---|
| `DISCORD_BOT_TOKEN missing` | Thêm token vào `.env` |
| `Redis unavailable` | Bình thường, hệ thống dùng in-memory fallback |
| `Port 3005 in use` | `pm2 stop all` rồi start lại |
| `Module not found` | Chạy `npm install` lại |
