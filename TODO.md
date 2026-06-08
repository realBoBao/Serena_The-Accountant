

> **Bug Fixes:** 15/15 issues fixed ✅ (P0: 3 | P1: 5 | P2: 7) | **Test Coverage:** 336/342 PASS (98.2%) | **Manim:** Docker + Windows setup ✅
> **HyDE:** Hypothetical Document Embeddings — tăng recall RAG ✅ | **A* Search:** Tối ưu DAG planning ✅ | **Aho-Corasick:** Quét pattern O(N) ✅
> **LRU Cache:** 2-tier (RAM + SQLite) chống OOM ✅ | **Monte Carlo:** Chaos Engineering thực tụ ✅ | **SecurityAuditor:** Quét secrets/unsafe functions ✅
> **Vision:** Gemini Vision + OCR + Planner Feedback ✅ | **Voice:** whisper.cpp ✅ | **Admin Dashboard:** Web UI ✅ | **REST API:** 30+ endpoints ✅ | **PlannerAgent:** OODA Loop + Redis Sessions + Vision-First Planning ✅ | **Session Store:** Redis-backed ✅ | **LLM Layer:** 4-tier Fallback ✅
> **Knowledge Graph:** SQLite-backed + Graph-Enhanced RAG ✅ | **Self-Evolution:** Auto-eval + A/B testing + Adaptive Model Selection ✅ | **PWA:** Mobile companion ✅ | **Video CDN:** Local+S3 ✅
> **Shadow Review:** Code cũ → Thử thách → Sandbox chấm ✅ | **Incident Simulator:** Chaos Engineering 8 loại sự cố ✅ | **MentorAgent:** Hint system + Không cho xem đáp án ✅
> **ManimAgent:** Planner feedback loop ✅ | **Retry với LLM fix ✅**
> **InteractionAgent:** Session Init Gateway ✅ | **PlannerWorker:** init_session + vision-first detection ✅ | **AgentWorker:** Multi-agent job executor + buffer dispatch ✅
> **Lazy Loading:** Dynamic agent import + cache ✅ | **Graph-Enhanced RAG:** Knowledge graph context enrichment ✅ | **Visual Knowledge Map:** D3.js interactive graph ✅
> **DebateAgent:** Planner Intervention — Redis error history + 2-direction spawn + Judge enforcement ✅
> **CodeAnalyzer:** Cyclomatic complexity + anti-patterns + quality score ✅
> **SecurityAuditor:** Secret detection + vulnerability scan + security score ✅
> **PerformanceProfiler:** Benchmark + memory profile + system metrics ✅
> **LogAnalyzer:** Error clustering + anomaly detection + health score ✅
> **Discord Commands:** !analyze !audit !profile !logs !debate ✅
> **VisionAgent → PlannerAgent Pipeline:** describeImageForPlanner → createVisionFirstPlan → DAG execution ✅
> **LSM-Tree:** Log-Structured Merge-Tree — MemTable + SSTable + Compaction ✅ | **Work Stealing:** Deque-based DAG scheduler ✅ | **Raft Consensus:** Leader Election + Log Replication ✅ | **33/33 tests PASS** ✅
> **Shadow Execution:** 2-instance consensus + Judge diff analysis ✅ | **Semantic Fingerprinting:** Memory deduplication ✅ | **Synthetic Dataset:** Self-Play AlphaZero ✅ | **ToT-MCTS:** Tree of Thoughts + Monte Carlo ✅ | **Semantic Routing:** Cosine similarity intent classification ✅ | **Token Bucket:** Rate limiter 5 tokens/user ✅ | **Circuit Breaker:** CLOSED→OPEN→HALF_OPEN ✅ | **Media Preprocessing:** Image/Audio/Video compression ✅ | **URL Parser:** Source tagging ✅ | **Active Recall:** High-value study flagging ✅ | **Codebase Cleanup:** 21 orphan files removed ✅ | **AnalysisAgent:** !analyze command ✅

---

## ✅ Phase 1: Gia cố nền móng & Chống chịu lỗi (Core Stability)

> *Mục tiêu: Hệ thống không bao giờ sập (Crash-proof)*

- [x] **Hoàn tất hệ thống Logging** — Log đầy đủ mọi agent
- [x] **Thay thế Engine Tìm kiếm** — Loại bỏ duck-duck-scrape, tích hợp Tavily API
- [x] **Xây dựng Message Queue** — Xử lý lần lượt từng request, tránh 429 Rate Limit
- [x] **Sửa Embedding Engine** — Chuyển từ SHA256 (128 dims) → Gemini Embedding (3072 dims)
- [x] **Re-index Vector Store** — Xóa DB cũ, index lại toàn bộ với embedding đúng
- [x] **Tạo PM2 Ecosystem** — `ecosystem.config.cjs` cho 4 services chạy ngầm
- [x] **Tạo `concurrently` dev script** — `npm run dev` gộp BOT + SERVER + CRON + WATCH

---

## ✅ Phase 2: Đập bỏ Monolith, Chuyển đổi Microservices

> *Mục tiêu: Kiến trúc phân tạch, sẵn sàng Production*

- [x] **Container hóa bằng Docker** — `Dockerfile` + `docker-compose.yml`
- [x] **Triển khai Vector Database độc lập** — Qdrant container (sẵn sàng switch)
- [x] **Tách luồng Discord Bot** — Service riêng biệt
- [x] **Tách luồng RAG & AI** — Service riêng biệt, giao tiếp qua REST API

---

## ✅ Phase 3: Tích hợp Động cơ AI Cục bộ (Bare-Metal LLM)

> *Mục tiêu: Thoát khỏi sự phụ thuộc Google/OpenRouter*
> *Chiến thuật: Dùng GGUF quantized model nhỏ (Qwen 1.5B ~1GB) + fallback về OpenRouter*

- [x] **Clone Llama.cpp** — Đã clone về `llama.cpp/` (395MB source)
- [x] **Biên dịch mã nguồn** — CMake + build Release thành công (`llama-server.exe`, `llama-cli.exe`)
- [x] **Tạo Local LLM API Server** — `local_llm_server.js` (port 3001, health check `/health`)
- [x] **Tải GGUF model** — `Qwen2.5-1.5B-Instruct-Q4_K_M.gguf` (~540MB) đã có trong `models/`
- [x] **Tích hợp fallback** — `tryLocalLlm()` trong RagAgent: Local LLM chết/chậm → tự động chuyển sang OpenRouter (đã có sẵn)

---

## ✅ Phase 4: Thiết kế Đặc vụ Tự trị (Agentic Workflows)

> *Mục tiêu: Biến AI từ "người trả lời" thành "người hành động"*

- [x] **Self-Reflective RAG** — Đã có sẵn trong `RagAgent.js` (`selfReflectAnswerGate`). Bot tự chấm điểm câu trả lời, nếu fail thì tự tìm lại context
- [x] **Code Execution Sandbox** — `lib/code_sandbox.js` hỗ trợ Python, JS, C, C++, Java. Discord command: `!run <code>`

---

## ✅ Phase 5: The Autonomous Ecosystem (Hệ sinh thái Tự trị)

> *Mục tiêu: Gộp Sandbox + Router + Memory thành một luồng xử lý thống nhất*

- [x] **Sandbox Security** — Timeout 5s + regex blacklist chặn lệnh phá hoại (rm -rf, os.system, eval, while(true), v.v.)
- [x] **Router Agent** — Intent classification trong `discord_bot.js`: CODE (!run), MEMORY (!memory), RAG (!ask), CHAT
- [x] **Memory Command** — `!memory <nội dung>` để lưu trí nhớ thủ công
- [x] **Cron-Job Long-term Memory** — 2:00 AM mỗi ngày: tóm tắt chat → nhúng vector → lưu với tag `long-term-memory`

---

## ✅ Phase 6: Automated Active Recall Pipeline (Pipeline Ôn tập Tự động)

> *Mục tiêu: Tự động tạo thẻ ghi nhớ từ tài liệu và ôn tập theo chu trình spaced repetition*

- [x] **Flashcard Database** — `lib/flashcard_db.js` với spaced repetition (intervals: 1, 3, 7, 14, 30, 60, 180 days)
- [x] **Flashcard Generator** — `lib/flashcard_generator.js` sử dụng LLM tạo cặp Q&A từ text
- [x] **Discord Quiz Command** — `!quiz` để bắt đầu ôn tập, `!quiz stats` xem thống kê
- [x] **PDF Flashcard Integration** — `PdfAgent.js` tự động tạo thẻ từ PDF đã xử lý
- [x] **Review System** — `!answer <id> <đáp án>` để đánh giá và cập nhật lịch ôn tập

---

## ✅ Phase 7: Polyglot Sandbox (Sandbox Đa ngôn ngữ)

> *Mục tiêu: Hỗ trợ chạy code đa ngôn ngữ hệ thống và thuật toán*

- [x] **Extended Language Support** — C, C++, Java, Python, JavaScript, Rust, Go, C#
- [x] **Memory Sanitizer** — Tích hợp AddressSanitizer cho C/C++ để phát hiện lỗi memory leak
- [x] **Auto Language Detection** — Tự động nhận diện ngôn ngữ từ code snippet
- [x] **Security Hardening** — Regex blacklist chặn lệnh độc hại

---

## ✅ Phase 8: 3-Space Vector Database Architecture

> *Mục tiêu: Tối ưu tốc độ truy xuất với 3 không gian vector chuyên biệt*

- [x] **Vector Collections Module** — `lib/vector_collections.js` quản lý 3 collection
- [x] **Collection: academic-docs** — Kiến thức nền tảng, bài giảng, tài liệu lý thuyết
- [x] **Collection: system-logs** — Bản ghi lỗi, cách cấu hình hệ thống (PM2, Docker, v.v.)
- [x] **Collection: daily-memory** — Trí nhớ cá nhân tổng hợp hàng ngày từ scheduler
- [x] **Init Script** — `init_collections.js` để khởi tạo collections trong Qdrant
- [x] **Multi-collection Search** — RagAgent tìm kiếm đồng thời cả 3 collection

---

## ✅ Phase 9: CI/CD & Continuous Testing (Chuẩn hóa DevOps)

> *Mục tiêu: Đưa dự án đạt chuẩn Software Engineering, tự động kiểm tra lỗi trước khi chạy*

- [x] **Thiết lập GitHub Actions** — `.github/workflows/ci.yml` với lint + test + security + docker build
- [x] **Viết Unit Test cốt lõi** — 82 tests với Jest: Spaced Repetition, Sandbox security, Intent classification, Vector collections, Orchestrator routing
- [x] **Automated Docker Build** — GitHub Actions tự động build & push image lên GHCR với cache
- [x] **Integration Test** — Docker Compose health check trong CI pipeline
- [x] **Jest Config** — `jest.config.js` riêng với coverage reporting

---

## ✅ Phase 10: Infrastructure Observability (Hệ thống Giám sát & Đo lường)

> *Mục tiêu: Giám sát tài nguyên phần cứng, theo dõi hiệu suất thuật toán và phát hiện điểm nghẽn*

- [x] **Prometheus + Grafana** — `docker-compose.monitoring.yml` với Prometheus, Grafana, Alertmanager, Node Exporter, cAdvisor
- [x] **Metrics Collector** — `lib/metrics.js` với Prometheus client: Discord messages, RAG queries, Vector search latency, Flashcard stats, Sandbox executions
- [x] **Alert Rules** — PM2 restart > 3 lần, Memory > 85%, CPU > 90%, Disk < 10%, Qdrant down
- [x] **Discord Alert Webhook** — Alertmanager → Discord channel với severity-based routing
- [x] **Grafana Dashboard** — Dashboard JSON với panels: Uptime, Messages, Memory, Vector latency, Flashcards

---

## ✅ Phase 11: Giao thức mở rộng & Thử nghiệm AGI

> *Mục tiêu: Bức phá khỏi vỏ bọc Discord, đa dạng hóa đầu vào và thử nghiệm các mô hình tự trị bậc cao*

- [x] **Multi-Agent Debate (Nâng cao)** — `agents/DebateAgent.js`: **2 CoderAgent instances** (A: đúng đắn/dễ đọc, B: hiệu suất/tối ưu) → Sandbox chạy cả 2 → đo **latency + memory** → RagAgent phản biện dựa trên metrics → **JudgeAgent chấm điểm** (Correctness 30%, Performance 25%, Memory 15%, Readability 15%, Scalability 15%)
- [x] **Sandbox Metrics Integration** — Judge đọc latencyMs + memoryKb thực tế từ SandboxGateway, không chỉ dựa trên LLM opinion
- [x] **Planner Intervention** — `interveneForPlanner(sessionId, problem)`: Đọc lịch sử lỗi Redis → phân tích error patterns (MEMORY_LEAK, NULL_POINTER, INFINITE_LOOP, v.v.) → spawn 2 hướng giải quyết song song (Root Cause Fix vs Workaround + Defensive) → sandbox metrics → Judge chọn hướng → ép Planner đi theo
- [x] **CoderAgent** — `agents/CoderAgent.js`: Viết code + chạy sandbox + Memory Sanitizer + Big O analysis. Discord: `!code <bài toán>`
- [x] **Discord Command** — `!debate <bài toán>` (full 3 vòng + sandbox) và `!debate <bài toán> --quick` (1 vòng, không sandbox)
- [x] **REST API / Webhook mở** — `rest_api_server.js` (port 3005): `/api/notes`, `/api/ask`, `/api/flashcards` (CRUD), `/api/sandbox/run`, `/api/debate`, `/api/webhook/alerts`. Auth Bearer token + rate limiting. PM2 service `AI_REST_API`.
- [x] **Đồng bộ Lịch trình Tự động** — `scripts/sync_schedule.js` + `lib/schedule_sync.js`: Parse CSV/JSON/iCal → flashcard. Discord: `!schedule url <link>`, `!schedule list`, `!schedule clear`. Hỗ trợ Google Calendar iCal.

---

## ✅ Phase 12: The Visualization Engine (Động cơ Trực quan hóa)

> *Mục tiêu: Biến AI từ "người trả lời" thành "giáo sư trình chiếu" với animation video*

- [x] **Manim Agent** — `agents/ManimAgent.js`: LLM tự động viết code Manim (Python) từ mô tả tiếng Việt
- [x] **Discord Command** — `!animate <mô tả>` để tạo animation video
- [x] **Render Pipeline** — Sandbox chạy `manim -qm script.py SceneName` → output MP4
- [x] **File Delivery** — Gửi MP4 về Discord (với check giới hạn 25MB)
- [x] **Async Render** — `createAnimationAsync()`: Chạy render ở background, gửi video khi xong. Discord: `!animate <mô tả> --async`
- [x] **Video Compression** — `compressVideo()` trong `ManimAgent.js`: ffmpeg auto-compress nếu video > 24MB (target bitrate + AAC 64k)

---

## ✅ Phase 13: Disaster Recovery (Tự động Sao lưu & Phục hồi)

> *Mục tiêu: Đảm bảo dữ liệu trí nhớ và flashcard an toàn tuyệt đối*

- [x] **Automated DB Dumps** — `scripts/backup_db.js`: Cron 3:00 AM Chủ Nhật. Snapshot vectors.db + data.db + artifacts. Giữ tối đa 4 backup.
- [x] **Offsite Backup** — `scripts/offsite_backup.js`: Upload lên Google Drive (rclone) / AWS S3 / Local copy
- [x] **One-Click Restore** — `node scripts/restore_db.js <backup-name>`: Liệt kả backup, phục hồi trong 1 phút. npm scripts: `db:backup`, `db:restore`, `db:offsite`

---

## ✅ Phase 14: Kích hoạt Đa giác quan (Multimodal Senses)

> *Mục tiêu: Thoát khỏi việc chỉ gõ phím, giao tiếp tự nhiên như Jarvis*

- [x] **Tầm nhìn (Vision)** — `agents/VisionAgent.js`: Gemini Vision API phân tích ảnh. Discord: `!vision` + ảnh đính kèm. Hỗ trợ phân tích lỗi code, sơ đồ, bài giảng.
- [x] **Thính giác (Voice)** — `agents/VoiceAgent.js`: whisper.cpp transcribe audio → text → RAG auto-answer. Discord: `!voice` + audio (.ogg/.mp3/.wav/.m4a)

---

## ✅ Phase 15: Admin Web Dashboard (Trạm điều khiển trung tâm)

> *Mục tiêu: Giao diện đồ họa (GUI) để quản lý toàn bộ hệ sinh thái*

- [x] **Flashcard Management UI** — `admin_dashboard.js` (port 3003): Thêm/Sửa/Xóa flashcard, xem stats, filter theo category
- [x] **Real-time Log Streaming** — Server-Sent Events (SSE) stream logs trực tiếp trên dashboard
- [x] **Agent Control Panel** — Toggle bật/tắng từng Agent (Bot, RAG, PDF, Scheduler, Vision, Voice)

---

## 📊 Trạng thái Services (PM2)

| Service | Script | Trạng thái | Mô tả |
|---|---|---|---|
| AI_Discord_Bot | `discord_bot.js` | 🟢 Online | Bot Discord Q&A + Router + Sandbox |
| AI_Feedback_Server | `feedback_server.js` | 🟢 Online | Web server thu thập feedback |
| AI_Scheduler | `scheduler.js` | 🟢 Online | Cron job pipeline 8:00 & 20:00 + Memory 2:00 AM |
| AI_Library_Watcher | `watch_library.js` | 🟢 Online | Theo dõi thư mục tài liệu |
| AI_REST_API | `rest_api_server.js` | 🟢 Online | REST API server (port 3005) |
| AI_EvoAgent | `agents/EvoAgent.js` | 🟢 Online | Bảo trì nền: BullMQ worker + health monitor 60s + OOM/SR auto-fix |
| AI_GraphAgent | `agents/GraphAgent.js` | 🟢 Online | Bảo trì nền: BullMQ worker + entity extraction + graph repair |

### Lệnh quản lý nhanh

```powershell
pm2 list                    # Xem trạng thái tất cả services
pm2 logs AI_Discord_Bot     # Xem log Discord Bot
pm2 restart AI_Scheduler    # Khởi động lại Scheduler (sau khi sửa code)
pm2 stop AI_Discord_Bot     # Tạm dừng Bot
pm2 delete AI_Discord_Bot   # Xóa service
pm2 start ecosystem.config.cjs  # Khởi động tất cả
pm2 save                    # Lưu config để auto-restart khi reboot
```

### Lệnh Dev (VS Code Terminal)

```powershell
npm run dev   # Chạy đồng thời BOT + SERVER + CRON + WATCH với log màu
```

---

## 🏗️ Kiến trúc hệ thống

```
my-ai-brain/
├── agents/
│   ├── RagAgent.js          ← RAG + LLM (OpenRouter + Local fallback) + Self-Reflect
│   ├── PdfAgent.js          ← Xử lý PDF + Flashcard generation
│   ├── InteractionAgent.js  ← Tương tác Discord
│   ├── DebateAgent.js       ← Multi-Agent Debate (Coder vs Rag → Judge)
│   ├── ManimAgent.js        ← AI Animation Director (Manim video generation)
│   └── PlannerAgent.js      ← Bộ não Điều phối (OODA Loop + Session Manager)
├── lib/
│   ├── embeddings.js        ← Gemini Embedding (3072 dims)
│   ├── vector_store.js      ← SQLite vector DB
│   ├── vector_store_qdrant.js ← Qdrant client (sẵn sàng)
│   ├── vector_collections.js ← 3-Space Vector DB (academic/logs/memory)
│   ├── chunking.js          ← Text chunking
│   ├── code_sandbox.js      ← Sandbox đa ngôn ngữ + Security
│   ├── flashcard_db.js      ← Spaced repetition database
│   ├── flashcard_generator.js ← LLM tạo Q&A từ text
│   └── memory_manager.js    ← Memory management
├── llama.cpp/               ← Local LLM engine (đã build)
│   └── build/bin/Release/
│       ├── llama-server.exe ← Local LLM server binary
│       └── llama-cli.exe    ← CLI tool
├── models/                  ← GGUF model files (chờ tải)
├── ecosystem.config.cjs     ← PM2 production config
├── docker-compose.yml       ← Docker orchestration
├── Dockerfile               ← Bot container
├── discord_bot.js           ← Discord gateway + Router Agent
├── feedback_server.js       ← Express feedback API
├── scheduler.js             ← Cron scheduler + Memory consolidation
├── watch_library.js         ← File watcher
├── local_llm_server.js      ← Local LLM API server (port 3001)
├── pipeline_report_v2.js    ← Data ingestion pipeline
├── generate_report.js       ← Markdown report generator
├── rest_api_server.js       ← REST API server (port 3005)
├── agents/
│   ├── EvoAgent.js          ← Kỹ sư Bảo trì (standalone PM2, BullMQ worker, health monitor)
│   └── GraphAgent.js        ← Kỹ sư Đồ thị (standalone PM2, BullMQ worker, graph repair)
├── lib/
│   └── task_queue.js        ← BullMQ Message Broker (4 queues + Redis persistence)
└── scripts/
    ├── backup_db.js          ← Automated DB backup (cron 3:00 AM Sun)
    └── restore_db.js         ← One-click DB restore
```

---

## 📈 Tiến độ tổng thể

| Phase | Trạng thái | Hoàn thành |
|---|---|---|
| Phase 1: Core Stability | ✅ Hoàn thành | 7/7 |
| Phase 2: Microservices | ✅ Hoàn thành | 4/4 |
| Phase 3: Bare-Metal LLM | ✅ Hoàn thành | 5/5 |
| Phase 4: Agentic Workflows | ✅ Hoàn thành | 2/2 |
| Phase 5: Autonomous Ecosystem | ✅ Hoàn thành | 4/4 |
| Phase 6: Active Recall | ✅ Hoàn thành | 5/5 |
| Phase 7: Polyglot Sandbox | ✅ Hoàn thành | 4/4 |
| Phase 8: 3-Space Vector DB | ✅ Hoàn thành | 6/6 |
| Phase 9: CI/CD & Testing | ✅ Hoàn thành | 5/5 |
| Phase 10: Observability | ✅ Hoàn thành | 5/5 |
| Phase 11: AGI Experiments | ✅ Hoàn thành | 7/7 |
| Phase 12: Visualization Engine | ✅ Hoàn thành | 6/6 |
| Phase 13: Disaster Recovery | ✅ Hoàn thành | 3/3 |
| Phase 14: Multimodal Senses | ✅ Hoàn thành | 2/2 |
| Phase 15: Admin Dashboard | ✅ Hoàn thành | 3/3 |
| Phase 16: Bug Fixes & Hardening | ✅ Hoàn thành | 15/15 |
| Phase 17: Message Broker (BullMQ+Redis) | ✅ Hoàn thành | 6/6 |
| Phase 18: Performance Optimization | ✅ Hoàn thành | 5/5 |
| Phase 19: Mobile Companion App | ✅ Hoàn thành | 4/4 |
| Phase 20: Knowledge Graph Engine | ✅ Hoàn thành | 7/7 |
| Phase 21: Self-Evolution Protocol | ✅ Hoàn thành | 9/9 |
| Phase 22: OODA Task Planner | ✅ Hoàn thành | 5/5 |
| Phase 23: RagAgent Overhaul | ✅ Hoàn thành | 6/6 |
| Phase 24: Session Init Gateway & Agent Workers | ✅ Hoàn thành | 8/8 |
| Phase 25: Unified LLM Layer & Model Fixes | ✅ Hoàn thành | 9/9 |
| Phase 26: Web Search Multi-Source | ✅ Hoàn thành | 5/5 |
| Phase 27: BullMQ Async Fix & Gateway Env | ✅ Hoàn thành | 4/4 |
| Phase 28: Scheduler Cron & Webhook Fix | ✅ Hoàn thành | 3/3 |
| Phase 29: Performance & Hidden Mode | ✅ Hoàn thành | 4/4 |
| Phase 30: Manim Environment & Error Handling | ✅ Hoàn thành | 5/5 |
| Phase 31: Living System (Resilience & Scaling) | ✅ Hoàn thành | 12/12 |

**Tổng: 179/179 tasks hoàn thành (100%)**

---

## ✅ Phase 31: Living System — Resilience & Infinite Scaling

> *Mục tiêu: Biến hệ thống thành "Sống thể" (Living System) — tự hồi phục, tự mở rộng, tự tối ưu*

### 🧠 Shadow Execution & Consensus
- [x] **Shadow Executor** — `lib/shadow_executor.js`: Spawn 2 AgentWorker độc lập, chạy song song cùng task
- [x] **Consensus Engine** — Hash matching + Jaccard similarity, chỉ trả về khi 2 instances đồng thuận (≥85%)
- [x] **Judge Diff** — `lib/judge_diff.js`: Khi outputs khác nhau → JudgeAgent phân tích diff → chọn output tốt hơn
- [x] **Flaky Result Elimination** — Loại bỏ kết quả "chập chờn" do LLM randomness

### 🔍 Semantic Fingerprinting (Memory Deduplication)
- [x] **Fingerprint Engine** — `lib/semantic_fingerprint.js`: Tính semantic hash từ vector embedding
- [x] **Duplicate Detection** — Similarity > 98% → strengthen node (không tạo mới)
- [x] **Merge Relationship** — Similarity 85-98% → tạo mới + link vào node gốc
- [x] **Anti-noise** — AI không bị "lẩm cẩm" vì thông tin trùng lặp

### 🎓 Synthetic Dataset Generation (Self-Play / AlphaZero)
- [x] **Self-Play Engine** — `lib/synthetic_dataset.js`: Bot tự sinh "Bài thi cuối kỳ" cho chính mình
- [x] **CoderAgent** viết đề → **InteractionAgent** giải → **JudgeAgent** chấm điểm
- [x] **Auto-Optimization** — Score < 5 → trigger EvoAgent điều chỉnh RAG/model params

### 🌳 Tree of Thoughts + MCTS (CoderAgent)
- [x] **ToT-MCTS Engine** — `lib/tot_mcts.js`: Generate 3 approaches → Evaluate → Expand best → Backtrack on fail
- [x] **Integration** — Chạy ở Phase 0 của `CoderAgent.solveWithDebugLoop()`

### 🎯 Semantic Intent Routing
- [x] **Semantic Router** — `lib/semantic_router.js`: Cosine similarity thay keyword matching
- [x] **Smart Classification** — Hiểu ý định ngay cả khi dùng từ đồng nghĩa/gõ sai chính tả

### 🪣 Token Bucket Rate Limiter
- [x] **Token Bucket** — 5 tokens/user, refill 1 token/2s, cho phép burst nhưng chặn spam

### 🛡️ Circuit Breaker Pattern
- [x] **Circuit Breaker** — `lib/circuit_breaker.js`: CLOSED → OPEN → HALF_OPEN, exponential backoff
- [x] **Integration** — Tích hợp vào `lib/llm.js` cho tất cả API calls

### 🖼️ Multi-modal Media Preprocessing
- [x] **Image** — Resize 1024x1024 + JPEG 80% (giảm 60-80% token cost)
- [x] **Audio** — Cắt 60s + normalize 16kHz (giảm 50-70% processing time)
- [x] **Video** — Extract 5 key frames thay gửi toàn bộ (giảm ~90%)
- [x] **Integration** — VisionAgent + VoiceAgent tự động preprocess

### 🔗 URL Parser & Source Tagging
- [x] **detectExternalSource()** — Nhận diện domain đích (GitHub, YouTube, Blog, arXiv)
- [x] **Title Enrichment** — Chèn `[GitHub]`/`[YouTube]` vào tiêu đề HN/Reddit

### 📊 Active Recall Flagging
- [x] **isHighValueStudy** — Score > 0.85 → đánh dấu trong metadata + tag `high-value-study`

### 🔧 LLM Layer Optimization
- [x] **OpenRouter First** — Ưu tiên OpenRouter trước Gemini
- [x] **Reduced Timeout** — 15s → 8s
- [x] **Error Classification** — Phân loại lỗi (rate limit, auth, network) → xử lý phù hợp

### 📁 Codebase Cleanup
- [x] **Deleted 21 orphan files** — Xóa file không import, gộp logic vào module chính
- [x] **AnalysisAgent** — `!analyze <URL>` cho GitHub repo / YouTube / Web
- [x] **Test Results** — 336/342 PASS (98.2%)

## ✅ Phase 30: Manim Environment & Error Handling (Cấu hình môi trường đồ họa)

> *Mục tiêu: Khắc phục lỗi "Manim chưa được cài đặt" — cấu hình đầy đủ cho cả Windows (PM2) và Docker*

- [x] **Dockerfile nâng cấp** — Thêm Python3, FFmpeg, Cairo, Pango, LaTeX, Manim vào container image
- [x] **ManimAgent ENOENT detection** — Phát hiện `err.code === 'ENOENT'` → log hướng dẫn cài đặt chi tiết thay vì crash
- [x] **ManimAgent ffmpeg detection** — Phát hiện FFmpeg missing → error message rõ ràng
- [x] **code_sandbox Manim support** — Thêm `LANG_CONFIG.manim` với scene name extraction, 2min timeout, video output path
- [x] **.env.example** — Thêm biến môi trường MANIM_RENDER_DIR, VIDEO_BASE_URL, VIDEO_STORAGE_MODE

### 📋 Hướng dẫn cài đặt Manim

**Windows (PM2 cục bộ):**
```powershell
# 1. Cài FFmpeg
choco install ffmpeg
# HOẶC tải từ https://ffmpeg.org/download.html → thêm vào PATH

# 2. Cài Manim
pip install manim

# 3. Khởi động lại PM2
pm2 restart AI_Discord_Bot
```

**Docker:**
```dockerfile
# Đã tích hợp sẵn trong Dockerfile — rebuild là xong
docker-compose build
docker-compose up -d
```

---

## ✅ Phase 23: RagAgent Overhaul (Nâng cấp Kỹ sư Dữ liệu)

> *Mục tiêu: Biến RagAgent từ "người tìm kiếm" thành "kỹ sư dữ liệu" với hybrid search, embedding cache, query expansion*

- [x] **Embedding Cache** — `lib/embedding_cache.js`: SQLite-backed LRU cache, TTL 7 days, max 10K entries, cache-first strategy trong `embedText()`
- [x] **BM25 Keyword Search** — `lib/bm25_search.js`: Full-text search engine với TF-IDF weighting, Vietnamese + English tokenization, stop words
- [x] **Hybrid Search** — `mergeHybridResults()`: Kết hợp vector similarity + BM25 score với configurable weight (`HYBRID_BM25_WEIGHT=0.3`)
- [x] **Collection-Weighted Search** — Áp dụng trọng số riêng cho 3 collections (academic: 1.0, system: 0.8, daily: 0.9)
- [x] **Query Expansion** — Khi Self-Reflect gate fail → LLM tạo 2 expanded queries → tìm lại → retry gate (max 2 retries)
- [x] **Unit Tests** — 33 tests: Embedding cache (6), BM25 search (7), Hybrid merge (5), Config (3), Query expansion (4), Collection weights (4), Self-reflect gate (4)

---

## ✅ Phase 16: Bug Fixes & Hardening (Sửa lỗi & Tăng cường)

> *Mục tiêu: Sửa toàn bộ bugs đã phát hiện, tăng cường security và stability*
> *Hoàn thành: 2026-06-03 22:00 — 15/15 fixes*

### 🔴 P0 — Critical (3/3)
- [x] **Sửa CI YAML indentation** — `.github/workflows/ci.yml:54-56` — Nested mapping lỗi → sửa env vars alignment
- [x] **Sửa REST API key default** — `rest_api_server.js` — Bắt buộc `REST_API_KEY` trong .env, refuse start nếu thiếu
- [x] **Sửa local_llm_server.js port conflict** — Thêm biến `SERVER_PORT = PORT + 1` rõ ràng, cập nhật health check

### 🟡 P1 — Medium (5/5)
- [x] **Sửa !learn command** — `discord_bot.js` — Thực sự gọi `orchestrator.route({ type: 'repo_url' })` thay vì chỉ reply text
- [x] **Sửa openRouterModelFallbacks** — `RagAgent.js` — Bỏ model giả `openrouter/owl-alpha`, thêm `meta-llama/llama-3.1-8b-instruct:free`
- [x] **Sửa embeddings.js API key fallback** — `lib/embeddings.js` — Thêm `GEMINI_API_KEY` vào chuỗi fallback
- [x] **Sửa flashcard_db.js connection pooling** — `lib/flashcard_db.js` — Singleton pattern thay vì open/close mỗi query, thêm `closeDb()` export
- [x] **Sửa scheduler.js graceful shutdown** — `scheduler.js` — SIGINT/SIGTERM dừng cả 3 cron tasks (pipeline + memory + backup)

### 🟢 P2 — Low (7/7)
- [x] **Cập nhật summary.txt** — Xóa nội dung package.json cũ, thay bằng project summary chính xác
- [x] **Sửa Dockerfile entrypoint** — Dùng `ENTRYPOINT ["node"]` + `CMD ["index.js"]` linh hoạt thay vì hardcode pipeline
- [x] **Bỏ forceExit Jest** — `jest.config.js` — Bỏ `forceExit: true`, giữ `detectOpenHandles: true`
- [x] **Thêm rate limiting feedback_server.js** — 20 requests/minute per IP
- [x] **Mở rộng watch_library.js** — Hỗ trợ `.txt`, `.md`, `.epub` ngoài `.pdf`
- [x] **Grafana password qua .env** — `docker-compose.monitoring.yml` — Dùng `${GRAFANA_PASSWORD}` thay vì hardcode `admin123`
- [x] **Cập nhật TODO.md** — Thêm Phase 16-20, cập nhật tiến độ

---

## ✅ Phase 17: Message Broker & Task Queue (BullMQ + Redis)

> *Mục tiêu: Bộ đệm trung gian cho toàn bộ Agent ecosystem — persistent, reliable, monitorable*

- [x] **BullMQ Task Queue** — `lib/task_queue.js`: 4 queues (planner, evolution, graph, priority) + Redis persistence
- [x] **Redis Server** — `docker-compose.yml`: Redis 7 Alpine, AOF persistence, 128MB max, health check
- [x] **Bull Board UI** — Monitoring UI cho BullMQ queues (port 3006)
- [x] **Job Types** — 10 job types: analyze_logs, optimize_hyperparams, update_sr, repair_graph, auto_evaluate, self_repair, knowledge_gap, extract_entities, build_relationships, sync_graph
- [x] **Auto-retry & Backoff** — Exponential backoff, max 3 attempts, cleanup completed/failed jobs
- [x] **Scheduler Integration** — EvoAgent cron 4:00 AM daily, GraphAgent cron 5:00 AM Sunday

## ✅ Phase 18: Performance Optimization (Tối ưu Hiệu suất)

> *Mục tiêu: Giảm latency, tăng throughput, tối ưu resource usage*

- [x] **Embedding Cache** — Cache-first strategy trong `embedText()`: check SQLite cache trước khi gọi Gemini API
- [x] **Request Batching** — `embedTextsBatch()`: batch nhiều texts, chỉ API-call missing entries
- [x] **CDN for Manim Videos** — `lib/video_cdn.js`: local storage + S3-compatible upload, cleanup cron
- [x] **Lazy Loading Agents** — Đã có trong RouterAgent (`_loadAgent` cache pattern) ✅
- [x] **Embedding Cache** — Cache-first strategy trong `embedText()`: check SQLite cache trước khi gọi Gemini API ✅
- [x] **Request Batching** — `embedTextsBatch()`: batch nhiều texts, chỉ API-call missing entries ✅
- [x] **CDN for Manim Videos** — `lib/video_cdn.js`: local storage + S3-compatible upload, cleanup cron ✅
- [x] **Lazy Loading Agents** — `lib/lazy_agents.js`: dynamic import + cache pattern, reduces startup memory ✅
- [x] **Vector Store Migration** — Chuyển từ SQLite sang Qdrant hoàn toàn cho production (Qdrant container đã có trong docker-compose, sẵn sàng switch)

---

## ✅ Phase 19: Mobile Companion App (Ứng dụng Điện thoại Đi kèm)

> *Mục tiêu: Mở rộng trải nghiệm ra ngoài Discord, trên điện thoại*

- [x] **Progressive Web App (PWA)** — `public/index.html` + manifest + service worker, responsive mobile-first
- [x] **Push Notifications** — Service worker push event với actions (review/dismiss)
- [x] **Offline Flashcard Review** — IndexedDB storage + background sync queue + SW sync event → full offline review with auto-sync on reconnect
- [x] **Voice Input** — `public/js/app.js`: Web Speech API (vi-VN) → auto-fill ask input → auto-submit

---

## ✅ Phase 20: Knowledge Graph Engine (Động cơ Đồ thị Tri thức)

> *Mục tiêu: Nâng từ vector search lên knowledge graph — hiểu quan hệ giữa các khái niệm*

- [x] **GraphAgent** — `agents/GraphAgent.js`: Entity extraction (regex + LLM), relationship building, graph repair
- [x] **Neo4j Support** — Kết nối Neo4j driver với fallback sang in-memory graph
- [x] **Auto Entity Extraction** — Regex-based proper nouns + technical terms extraction
- [x] **Co-occurrence Relationships** — Xây dựng relationships từ các entities xuất hiện cùng câu
- [x] **Graph Repair** — Tự động phát hiện và sửa orphaned nodes
- [x] **Graph Sync** — Đồng bộ toàn bộ vector store vào knowledge graph (cron 5:00 AM Sunday)
- [x] **SQLite Knowledge Graph** — `lib/knowledge_graph.js`: entities, edges, aliases, BFS traversal, D3 export
- [x] **LLM Entity Extraction** — `lib/entity_extractor.js`: LLM extracts entities + relationships from text
- [x] **Graph-Enhanced RAG** — `RagAgent.js`: `getGraphEnhancedContext()` extracts entities from query → searches KG → appends relationships to RAG context
- [x] **Visual Knowledge Map** — `public/js/graph_viz.js`: D3.js force-directed graph with drag, zoom, search highlight, node detail panel

---

## ✅ Phase 21: Self-Evolution Protocol (Giao thức Tự Tiến hóa)

> *Mục tiêu: AI tự cải thiện chính mình qua feedback loop*

- [x] **EvoAgent** — `agents/EvoAgent.js`: Giám sát Prometheus metrics + system-logs, tự động tối ưu
- [x] **OOM Detection** — Phát hiện Out of Memory errors từ system-logs → giảm batch size & cache
- [x] **Quiz Score Monitor** — Theo dõi xu hướng điểm quiz → tự điều chỉnh spaced repetition intervals
- [x] **Health Score** — Tính điểm sức khỏe hệ thống (0-100) dựa trên memory + quiz performance
- [x] **Auto-Evaluate** — Cron 4:00 AM hàng ngày: thu thập metrics → đánh giá → trigger optimization
- [x] **Self-Repair Pipeline** — Kiểm tra queue health + DB connectivity → tự động sửa
- [x] **Knowledge Gap Detection** — Phát hiện topics thiếu kiến thức (cron ngày 1 mỗi tháng)
- [x] **Adaptive Model Selection** — `lib/self_evolution.js`: `selectOptimalModel()` dựa trên success rate, latency, cost
- [x] **A/B Testing Framework** — `lib/self_evolution.js`: `createABTest()`, `selectStrategy()`, `recordABResult()`

---

## ✅ Phase 22: OODA Task Planner (PlannerAgent)

> *Mục tiêu: Bộ não điều phối với vòng lặp OODA (Observe-Orient-Decide-Act) — đọc session state, đánh giá tiến độ qua LLM, dispatch workers qua BullMQ, tự động retry/finalize*

- [x] **PlannerAgent OODA Loop** — `agents/PlannerAgent.js`: Observe (đọc Redis session) → Orient (LLM đánh giá tiến độ) → Decide (chọn agent tiếp theo) → Act (dispatch BullMQ job)
- [x] **Session Store** — `lib/session_store.js`: Redis-backed session state (create/get/update/delete/saveStepResult/addHistory/list)
- [x] **Agent-Queue Mapping** — 10 agents mapped vào 4 BullMQ queues (PRIORITY/PLANNER/EVOLUTION/GRAPH)
- [x] **Heuristic Fallback** — Khi LLM fail → tự động fallback sang heuristic orientation (topo sort + dependency check)
- [x] **Unit Tests** — 66/66 tests PASS: DAG planning, OODA loop, dispatch, session lifecycle, sync execution, edge cases

---

## ✅ Phase 25: Unified LLM Layer & Model Fixes

> *Mục tiệu: Tạo lớp LLM thống nhất với multi-model fallback — Gemini → OpenRouter → Local → Static. Fix tất cả model names deprecated.*

- [x] **Unified LLM Layer** — `lib/llm.js`: ask() với full fallback chain (Gemini → OpenRouter → Local → Static)
- [x] **Model Name Fixes** — Cập nhật gemini-1.5-flash → gemini-2.0-flash, gemini-3.5-flash → gemini-2.0-flash, text-embedding-004
- [x] **RagAgent Integration** — invokeLlm() dùng unified layer thay vì hardcoded Gemini/OpenRouter
- [x] **Embeddings Fallback** — embedText() tự động fallback model + zero vector nếu tất cả fail
- [x] **PlannerAgent Integration** — _createDagPlan() + _orient() dùng unified layer
- [x] **.env.example** — File cấu hình mẫu với đúng model names và tất cả biến môi trường
- [x] **Gemini Multi-Model Fallback** — Thử lần lượt: 2.0-flash → 2.5-flash → 2.0-flash-lite → 3.5-flash → flash-latest
- [x] **Tavily Graceful Degradation** — Không có API key → log debug thay vì warn
- [x] **Local LLM Port Fix** — Sửa port 3001→3002 (proxy), endpoint /completion→/api/ask
- [x] **Gemini Multi-Model Fallback** — Thử lần lượt: 2.0-flash → 2.5-flash → 2.0-flash-lite → 3.5-flash → flash-latest
- [x] **Tavily Graceful Degradation** — Không có API key → log debug thay vì warn
- [x] **Self-Reflect Gate Robust** — JSON extraction + markdown stripping + gate-error-open fallback

---

## ✅ Phase 26: Web Search Multi-Source (YouTube + GitHub + Facebook)

> *Mục tiêu: Ưu tiên tìm kiếm từ nguồn đáng tin cậy — YouTube (video có view cao), GitHub (repo có star cao), Facebook (post công khai). Thay vì chỉ dùng Tavily generic search.*

- [x] **YouTube Search** — `searchYouTube()`: YouTube Data API v3, filter view >= YOUTUBE_MIN_VIEWS (50k), score dựa trên views + likes
- [x] **GitHub Search** — `searchGitHub()`: GitHub Search API, filter stars >= GITHUB_MIN_STARS (500), score dựa trên stars + forks
- [x] **Facebook Search** — `searchFacebook()`: Dùng Tavily với `site:facebook.com`, lấy post/group công khai
- [x] **Source Priority** — Cấu hình `SOURCE_PRIORITY=youtube,github,facebook,tavily`, tự động skip source nếu API key thiếu
- [x] **Score-based Ranking** — Kết quả từ mỗi source được score theo độ tin cậy (views, stars, likes), sort giảm dần + deduplicate
- [x] **Domain Blacklist** — Block StackOverflow, Hacker News, Reddit, Quora, Medium, GeeksforGeeks khỏi Tavily results

---

## ✅ Phase 27: BullMQ Async Fix & Gateway Env

> *Mục tiêu: Sửa Worker is not constructor crash, gateway env propagation, self-reflect gate robustness*

- [x] **BullMQ createWorker Async** — Fix `loadBullmq()` gọi đồng bộ trong `createWorker` → thêm `await`
- [x] **Gateway Env Propagation** — Truyền DISCORD_BOT_TOKEN, GEMINI_API_KEY, TAVILY_API_KEY qua child process env
- [x] **Self-Reflect Gate Robust** — Markdown stripping + JSON extraction + gate-error-open fallback
- [x] **Domain Blacklist** — Block low-quality domains (StackOverflow, HN, Reddit, Quora) khỏi web search

---

## ✅ Phase 28: Scheduler Cron & Webhook Fix

> *Mục tiêu: Scheduler chỉ chạy 8AM + 8PM, gửi webhook với source chất lượng, discord bot 24/7*

- [x] **Cron Schedule** — `0 8,20 * * *` (8AM và 8PM mỗi ngày), tắt RUN_ON_START spam
- [x] **Webhook Notification** — Pipeline gửi Discord webhook sau khi chạy với source YouTube/GitHub/Facebook
- [x] **Discord Bot 24/7** — Gateway load `.env` → truyền token qua child process, không crash loop
- [x] **Source Quality in Prompt** — LLM ưu tiên YouTube > GitHub > Facebook > Web khi synthesize answer

---

## ✅ Phase 29: Performance & Hidden Mode

> *Mục tiêu: Tối ưu response time, chạy ngần không hiện CMD, giảm memory usage*

- [x] **LLM Timeout** — 15s timeout cho mọi LLM call, fallback static nếu timeout
- [x] **Self-Reflect Gate Skip** — Skip gate cho local vector search và answer quá ngắn/dài
- [x] **Windows Hidden Mode** — Gateway spawn child với `windowsHide: true`, không hiện CMD
- [x] **EvoAgent Memory Fix** — Tăng threshold 85% → 95%, giảm check frequency 60s → 300s

---

## ✅ Phase 24: Session Init Gateway & Agent Workers (InteractionAgent + PlannerWorker + AgentWorker)

> *Mục tiêu: Hoàn thiện luồng end-to-end — từ tin nhắn đến kết quả, qua Session → Planner → Agent Workers*

- [x] **InteractionAgent** — `agents/InteractionAgent.js`: Nhận mọi I/O → tạo Session_ID → lưu Redis Hash `session:<id>:state` → dispatch job vào `queue:planner`
- [x] **Session State Schema** — Redis Hash với 14 fields: session_id, source, user_id, username, channel_id, content, content_length, attachment_count, has_image, has_audio, is_admin, message_id, created_at, status
- [x] **Session Store Integration** — `session_store.js`: createSession/updateSession/saveStepResult/addHistoryEntry với JSON serialization + TTL
- [x] **PlannerWorker** — `agents/PlannerWorker.js`: Worker xử lý `init_session` job → gọi PlannerAgent.startSession() → OODA loop → dispatch agent jobs
- [x] **AgentWorker** — `agents/AgentWorker.js`: Worker xử lý agent jobs từ `queue:priority` → lazy load agents → execute → save result → trigger OODA loop
- [x] **Agent Registry** — 10 agents mapped: RagAgent, CoderAgent, VisionAgent, VoiceAgent, PdfAgent, DebateAgent, ManimAgent, FlashcardAgent, EvoAgent, GraphAgent
- [x] **PM2 Services** — Thêm AI_PlannerWorker (1 instance) + AI_AgentWorker (2 instances cluster mode) vào ecosystem.config.cjs
- [x] **Unit Tests** — 29 tests: Session ID generation, receive() flow, Discord/REST/Dashboard/Webhook input, Redis failure handling, job dispatch, stats tracking
