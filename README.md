# My AI Brain — Multi-Agent AI System

> Hệ thống AI đa tác nhân tự học, tự tiến hóa, tự bảo mật.
> **Cloud Run Ready | PM2 Production | Ponytail Optimized**

---

## Tính năng chính

### 20 AI Agents
| Agent | Vai trò |
|---|---|
| **RagAgent** | RAG-powered Q&A (Vector + BM25 + HyDE + Query Expansion + Confidence Scoring) |
| **CoderAgent** | Viết + chạy code với AddressSanitizer & self-debug loop |
| **DebateAgent** | Tranh luận đa tác nhân (Coder vs Rag → Judge) |
| **SocraticAgent** | Phương pháp dạy học Socratic (hỏi ngược, hint system) |
| **MentorAgent** | Senior Dev review code (Shadow Review) |
| **IncidentAgent** | Chaos Engineering (8 loại sự cố production) |
| **SecurityAuditor** | Quét bảo mật code (secrets, SQLi, XSS, path traversal) |
| **ManimAgent** | Tạo video animation (Manim) |
| **VisionAgent** | Phân tích ảnh (Gemini Vision) |
| **VoiceAgent** | Transcribe giọng nói (whisper.cpp) |
| **PdfAgent** | Xử lý PDF/EPUB, trích xuất flashcards |
| **GraphAgent** | Knowledge Graph (entity extraction, relationship building) |
| **EvoAgent** | Self-evolution (performance monitoring, knowledge gap detection) |
| **SuggestionAgent** | Gợi ý học tập cá nhân hóa |
| **AnalysisAgent** | Phân tích URL với Bloom Filter dedup |
| **InteractionAgent** | Discord interaction tracking + session management |
| **RouterAgent** | Intent classification + routing (lazy-loaded agents) |
| **PlannerAgent** | OODA Loop DAG Task Planner (vision-first planning) |
| **PlannerWorker** | OODA task dispatcher |
| **GraphAgentLauncher** | GraphAgent standalone service launcher |

### RAG Pipeline (7 tầng)
```
Query → Semantic Cache → Hybrid Search (Vector + BM25) → Knowledge Graph Context
                                                                    ↓
Answer ← Confidence Scoring ← Self-Reflect Gate ← LLM Synthesis ← HyDE + Query Expansion
```

| Tầng | Công nghệ | Mô tả |
|---|---|---|
| **Semantic Cache** | Embedding cosine similarity (≥0.92) | Tránh gọi API cho câu hỏi lặp |
| **Vector Search** | SQLite (HNSW index) | Tìm kiếm ngữ nghĩa O(log N) |
| **BM25 Search** | Full-text TF-IDF | Tìm kiếm từ khóa |
| **HyDE** | Hypothetical Document Embeddings | Tạo câu trả lời giả để tìm context tốt hơn |
| **Query Expansion** | LLM-generated variants | Mở rộng câu hỏi với từ đồng nghĩa |
| **Knowledge Graph** | SQLite BFS traversal | Bổ sung mối quan hệ giữa các khái niệm |
| **Confidence Scoring** | 4-signal aggregation | Retrieval + Consensus + Source + Self-Check |

### Multi-Source Web Search (7 nguồn)
```
Pipeline → GitHub + YouTube + arXiv + Reddit + StackOverflow + HackerNews + Tavily
         ↓
    ~30-40 sources/lần chạy → Score-based ranking → Dedup (URL + hash)
```

| Nguồn | Max Results | Score | Hash Check |
|---|---|---|---|
| **GitHub** | 3-5 | 0.5-1.0 | stargazers_count |
| **YouTube** | 3-5 | 0.3-0.9 | viewCount |
| **arXiv** | 3 | 0.4-0.8 | published date |
| **Reddit** | 3-5 | 0.3-0.7 | score |
| **StackOverflow** | 5 | 0.3-0.9 | score |
| **HackerNews** | 5 | 0.2-0.8 | points |
| **Tavily** | 3 | 0.4-0.6 | snippet |

### Học tập
- **Spaced Repetition** (FSRS thay SM-2) — thuật toán tối ưu interval ôn tập
- **Socratic Mode** — hỏi ngược, hint system, không đáp án trực tiếp
- **Shadow Review** — ôn code cũ với MentorAgent
- **Learning Path** — DAG từ Knowledge Graph + Topological Sort + Flashcard stats
- **Bandit-based Prompt Selection** — Thompson Sampling tối ưu prompt strategy

### Bảo mật
- **4-layer sandbox** (Commands, Imports, Patterns, Exfiltration)
- **Trust Levels** (UNTRUSTED → PRIVILEGED)
- **Rate limiting** (per-agent, per-IP)
- **Audit logging** (mọi API call được log)
- **Atomic file writes** (chống corrupt khi crash)
- **Scope Detection** — chặn off-topic queries

### Monitoring
- **F1 Score Dashboard** (`!f1stats`)
- **👍/👎 Feedback** (per-response)
- **Health checks** (auto-restart via PM2)
- **Semantic Cache stats** (hit rate, entries)
- **Performance Profiler** — CPU, memory, event loop monitoring
- **Log Analyzer** — OOM detection, error pattern matching

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/realBoBao/Serena_Project00_Auto-Teaching.git
cd Serena_Project00_Auto-Teaching

# 2. Install
npm install

# 3. Configure
cp .env.example .env
# Edit .env with your API keys (see below)

# 4. Run tests
npm test

# 5. Start all services
npm run dev

# Or start individual services
node discord_bot.js      # Discord bot
node rest_api_server.js  # REST API (port 3005)
node scheduler.js        # Cron jobs
```

### API Keys

| Key | Bắt buộc | Mô tả |
|---|---|---|
| `DISCORD_BOT_TOKEN` | ✅ | Discord bot token |
| `GEMINI_API_KEY` | ✅ | Gemini API key (embeddings + LLM) |
| `OPENROUTER_API_KEY` | ⚠️ | Fallback LLM |
| `TAVILY_API_KEY` | ⚠️ | Web search |
| `YOUTUBE_API_KEY` | ⚠️ | YouTube search |
| `GITHUB_TOKEN` | ⚠️ | GitHub search |
| `REST_API_KEY` | ⚠️ | REST API authentication |

### Cấu trúc thư mục

```
├── agents/              # 20 AI agents
│   ├── RagAgent.js      # RAG pipeline (core engine)
│   ├── CoderAgent.js    # Code sandbox + self-debug
│   ├── DebateAgent.js   # Multi-agent debate
│   ├── EvoAgent.js      # Self-evolution
│   ├── GraphAgent.js    # Knowledge Graph
│   ├── PlannerAgent.js  # OODA DAG planner
│   └── ...
├── lib/                 # Core libraries (64 modules)
│   ├── confidence_scorer.js    # 4-signal confidence scoring
│   ├── semantic_cache.js       # Embedding-based query dedup
│   ├── atomic_write.js         # Atomic JSON write/read
│   ├── learning_path.js        # DAG learning path generator
│   ├── knowledge_graph.js      # SQLite KG + BFS traversal
│   ├── flashcard_db.js         # FSRS spaced repetition
│   ├── bandit.js               # Thompson Sampling prompt selection
│   ├── grounding_verifier.js   # Answer grounding verification
│   ├── scope_detector.js       # Query scope detection
│   ├── security_auditor.js     # Code security scanning
│   ├── performance_profiler.js # System performance monitoring
│   ├── log_analyzer.js         # Log analysis & OOM detection
│   ├── study_csp.js            # Study scheduling (CSP)
│   ├── repo_analyzer.js        # Repository analysis
│   ├── user_profile.js         # User learning profile
│   └── ...
├── tests/               # Test files
├── scripts/             # Maintenance scripts (backup, restore, archive)
├── public/              # PWA mobile companion
├── artifacts/           # Generated reports
└── backups/             # Auto-backups (weekly)
```

---

## Discord Commands

```
!ask <câu hỏi>              → RAG-powered Q&A
!ask <câu hỏi> --deep       → Deep search (8 results, 5 web sources)
!run <code>                 → Chạy code trong Sandbox
!code <bài toán>            → Viết + chạy code tự động
!debate <bài toán>          → Multi-agent debate
!quiz                       → Flashcard quiz (FSRS)
!answer <id> <ans>          → Review flashcard
!review                     → Shadow Review (ôn code)
!incident                   → Chaos Engineering
!learn <url>                → Học từ URL/PDF
!path <topic>               → Learning Path (DAG từ KG)
!path <topic> --short       → Chỉ 5 bước tiếp theo
!path <topic> --gaps        → Chỉ topic cần học
!f1stats                    → F1 Score Dashboard
!profile                    → Hồ sơ học tập
!preferences                → Tùy chọn model/sources/learning
!help                       → Danh sách lệnh
```

### REST API Endpoints

```
GET  /api/health                    → Health check
POST /api/ask                       → RAG Q&A
GET  /api/learning-path?topic=X     → Learning path generator
GET  /api/flashcards/due            → Due flashcards
POST /api/flashcards                → Create flashcard
POST /api/flashcards/:id/review     → Review flashcard
GET  /api/graph/search?q=X          → Knowledge Graph search
GET  /api/graph/stats               → KG statistics
GET  /api/graph/export              → Export graph (D3.js format)
GET  /api/evolution/stats           → Self-evolution statistics
GET  /api/evolution/gaps            → Knowledge gaps
GET  /api/cache/stats               → Embedding cache statistics
POST /api/vision/analyze            → Image analysis
POST /api/sandbox/run               → Code execution
POST /api/debate                    → Multi-agent debate
POST /api/notes                     → Quick note (iOS Shortcuts)
```

---

## Kiến trúc

```
┌─────────────────────────────────────────────────────────────────┐
│                        Discord / Webhook                         │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │    Orchestrator      │
                    │  (Event-driven)      │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │    RouterAgent       │
                    │  (Intent routing)    │
                    └──────────┬──────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
┌───────▼───────┐    ┌────────▼────────┐    ┌───────▼───────┐
│  RagAgent     │    │  CoderAgent     │    │  DebateAgent  │
│  (54KB core)  │    │  (Sandbox)      │    │  (Multi-round)│
└───────┬───────┘    └────────┬────────┘    └───────┬───────┘
        │                      │                      │
        └──────────────────────┼──────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │   RAG Pipeline       │
                    │                      │
                    │  Semantic Cache      │
                    │  → Hybrid Search     │
                    │  → KG Context        │
                    │  → HyDE + Expand     │
                    │  → LLM Synthesis     │
                    │  → Confidence Score  │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   Data Layer         │
                    │                      │
                    │  SQLite (vectors)    │
                    │  Knowledge Graph     │
                    │  Flashcard DB (FSRS) │
                    │  Semantic Cache      │
                    └─────────────────────┘
```

### Data Flow

1. **Input** → Discord message → Orchestrator event
2. **Routing** → RouterAgent classifies intent → dispatches to appropriate agent
3. **Semantic Cache** → Check if similar query was answered before (cosine ≥ 0.92)
4. **Retrieval** → Hybrid search (Vector + BM25) across 3 collections (academic, system, daily)
5. **Enrichment** → Knowledge Graph context + HyDE + Query Expansion
6. **Synthesis** → LLM generates answer with self-reflect gate
7. **Confidence** → 4-signal scoring (Retrieval, Consensus, Source, Self-Check)
8. **Output** → Answer + confidence suffix (if medium/low) + cache store

---

## Cron Jobs (Scheduler)

| Thời gian (PDT) | Hành động |
|---|---|
| 8AM, 11AM, 2PM, 5PM, 8PM | Pipeline: search, scrape, embed, store |
| 2:00 AM | Memory consolidation (archive old, embed recent) |
| 3:00 AM (Sunday) | Full backup (DB + artifacts) |
| 4:00 AM (daily) | EvoAgent: performance analysis + knowledge gap detection |
| 5:00 AM (Sunday) | GraphAgent: knowledge graph sync |
| 8:00 AM (daily) | SuggestionAgent: proactive learning suggestions |

### Cloud Run Mode
Khi chạy trên Cloud Run (`K_SERVICE` env set), node-cron bị disable. Thay vào đó dùng Google Cloud Scheduler → HTTP POST → `/scheduler/:job`.

---

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test
node --experimental-vm-modules node_modules/jest/bin/jest.js tests/rag_agent.test.js

# Test all agents load correctly
node scripts/test_agents.mjs

# Test Discord webhook (gửi notification test ngay)
node scripts/test_webhook.js

# Test scheduler catch-up (xem job nào bị missed)
node scripts/test_scheduler.js

# Test pipeline (chạy thật, bypass check thời gian)
node scripts/test_scheduler.js --run-pipeline
```

## Cloud Run Deployment

```bash
# Build & deploy
gcloud run deploy bot-name \
  --source . \
  --project Project_ID \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars REST_API_KEY=...,DISCORD_BOT_TOKEN=...,GEMINI_API_KEY=...

# Update env vars
gcloud run services update bot-name \
  --set-env-vars KEY=VALUE
```

---

## Mobile Companion (PWA)

```
GET /           → PWA (flashcards, Q&A, knowledge graph, stats)
GET /manifest.json → PWA manifest
```

Features:
- Offline flashcard review (IndexedDB + background sync)
- Voice input (Web Speech API, vi-VN)
- Push notifications (flashcard reminders)
- Knowledge Graph visualization (D3.js force-directed graph)

---

## Nguyên tắc Ponytail

Dự án tuân theo triết lý **"Lazy Senior Dev"**:

- **YAGNI** — Không build feature không cần
- **Stdlib first** — Dùng native Node.js trước khi cài dependency
- **One line** — Nếu làm được 1 dòng, không viết 50 dòng
- **Deletion > Addition** — Xóa code cũ hơn là thêm code mới
- **Boring > Clever** — Code dễ đọc hơn code thông minh
- **Mark shortcuts** — Mọi simplification đều có `ponytail:` comment kèm ceiling và upgrade path

---

## License

MIT
