# 🧠 My AI Brain — Multi-Agent AI System

> Hệ thống AI đa tác nhân tự học, tự tiến hóa, tự bảo mật.

## ✨ Tính năng chính

### 🤖 19 AI Agents
| Agent | Vai trò |
|---|---|
| **RagAgent** | RAG-powered Q&A (Vector + BM25 + HyDE + Query Expansion) |
| **CoderAgent** | Viết + chạy code với AddressSanitizer |
| **DebateAgent** | Tranh luận đa tác nhân (Coder vs Rag → Judge) |
| **SocraticAgent** | Phương pháp dạy học Socratic |
| **MentorAgent** | Senior Dev review code |
| **IncidentAgent** | Chaos Engineering (8 loại sự cố production) |
| **SecurityAuditor** | Quét bảo mật code (secrets, SQLi, XSS) |
| **PerformanceProfiler** | Phân tích performance |
| **LogAnalyzer** | Phân tích logs |
| **ManimAgent** | Tạo video animation |
| **VisionAgent** | Phân tích ảnh (Gemini Vision) |
| **VoiceAgent** | Transcribe giọng nói (whisper.cpp) |
| **PdfAgent** | Xử lý PDF/EPUB |
| **GraphAgent** | Knowledge Graph |
| **EvoAgent** | Self-evolution (A/B testing, hyperparameter tuning) |
| **SuggestionAgent** | Gợi ý học tập |
| **AnalysisAgent** | Phân tích URL |
| **InteractionAgent** | Discord interaction tracking |
| **RouterAgent** | Intent classification + routing |

### 🔍 RAG Pipeline
- **Vector Search** (SQLite/Qdrant/BigQuery)
- **BM25 Search** (full-text)
- **HyDE** (Hypothetical Document Embeddings)
- **Query Expansion**
- **Multi-space** (academic, system, daily)
- **Source deduplication**

### 📚 Học tập
- **Spaced Repetition** (FSRS thay SM-2)
- **Socratic Mode** (hỏi ngược, hint system)
- **Shadow Review** (ôn code cū)
- **Learning Path** (DAG từ Knowledge Graph)
- **F1 Evaluation** (đo lường chất lượng)

### 🔒 Bảo mật
- **4-layer sandbox** (Commands, Imports, Patterns, Exfiltration)
- **Trust Levels** (UNTRUSTED → PRIVILEGED)
- **Rate limiting** (per-agent)
- **Audit logging**

### 📊 Monitoring
- **F1 Score Dashboard** (`!f1stats`)
- **👍/👎 Feedback** (per-response)
- **Discord alerts** (service down, errors)
- **Health checks** (auto-restart)

## 🚀 Quick Start

```bash
# 1. Clone
git clone https://github.com/realBoBao/Serena_Project00_Auto-Teaching.git
cd Serena_Project00_Auto-Teaching

# 2. Install
npm install

# 3. Configure
cp .env.example .env
# Edit .env with your API keys

# 4. Run
npm run dev
```

## 📋 Discord Commands

```
!ask <câu hỏi>     → RAG-powered Q&A
!ask <câu hỏi> --deep → Deep search
!run <code>        → Chạy code trong Sandbox
!code <bài toán>   → Viết + chạy code
!debate <bài toán> → Multi-agent debate
!quiz              → Flashcard quiz
!review            → Shadow Review
!incident          → Chaos Engineering
!learn <url>       → Học từ URL/PDF
!path <topic>      → Learning Path
!f1stats           → F1 Score Dashboard
!profile           → Hồ sơ học tập
!help              → Danh sách lệnh
```

## 🏗️ Kiến trúc

```
Discord/Webhook → Orchestrator → RouterAgent → [RagAgent, CoderAgent, ...]
                                          ↓
                                    Sandbox Gateway
                                          ↓
                              [Docker | In-Process]
```

## 📁 Cấu trúc thư mục

```
├── agents/           # 19 AI agents
├── lib/              # Core libraries (RAG, sandbox, cache, etc.)
├── tests/            # 22 test files
├── .github/          # CI/CD workflows
├── docs/             # Documentation
├── scripts/          # Setup scripts
├── artifacts/        # Generated reports
└── backups/          # Auto-backups
```

## 🔑 API Keys cần thiết

| Key | Bắt buộc | Mô tả |
|---|---|---|
| `DISCORD_BOT_TOKEN` | ✅ | Discord bot token |
| `GEMINI_API_KEY` | ✅ | Gemini API key |
| `OPENROUTER_API_KEY` | ⚠️ | Fallback LLM |
| `TAVILY_API_KEY` | ⚠️ | Web search |
| `YOUTUBE_API_KEY` | ⚠️ | YouTube search |
| `GITHUB_TOKEN` | ⚠️ | GitHub search |

## 📊 Cron Jobs

| Thời gian (PDT) | Hành động |
|---|---|
| 8:00 AM | Search & scrape sources |
| 11:00 AM | Search & scrape sources |
| 2:00 PM | Search & scrape sources |
| 5:00 PM | Search & scrape sources |
| 8:00 PM | Search & scrape sources |
| 2:00 AM | Memory consolidation |
| 3:00 AM (Sun) | Backup |

## 📝 License

MIT
