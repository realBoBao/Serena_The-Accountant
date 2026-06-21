# 🏗️ My AI Brain — Kiến trúc hệ thống

> **Cập nhật:** 2026-06-04
> **Trạng thái:** 🟢 Production-ready (296/312 tests PASS)

---

## 📊 Tổng quan

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           MY AI BRAIN ECOSYSTEM                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────────────────────────┐  │
│  │ Discord  │───▶│ Interaction  │───▶│         PlannerAgent             │  │
│  │   Bot    │    │    Agent     │    │     (OODA Loop + Redis)          │  │
│  └──────────┘    └──────────────┘    └──────────┬───────────────────────┘  │
│       │                                         │                          │
│  ┌────┴────┐                          ┌─────────▼──────────┐               │
│  │  REST   │                          │    BullMQ Queues   │               │
│  │  API    │                          │  (4 queues+Redis)  │               │
│  │ (PWA)   │                          └─────────┬──────────┘               │
│  └─────────┘                                    │                          │
│                   ┌─────────────────────────────┼──────────────────┐       │
│                   │                             │                  │       │
│          ┌────────▼──────┐  ┌──────────▼────┐  ┌▼───────────────┐ │       │
│          │  AgentWorker  │  │ PlannerWorker │  │  EvoAgent      │ │       │
│          │  (2 instances)│  │ (1 instance)  │  │  GraphAgent    │ │       │
│          └────────┬──────┘  └───────────────┘  └────────────────┘ │       │
│                   │                                               │       │
│    ┌──────────────┼──────────────────────────────────────┐        │       │
│    │              │                                      │        │       │
│    ▼              ▼                                      ▼        │       │
│ ┌──────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐  │       │
│ │ RAG  │  │  Coder   │  │  Manim   │  │  Vision  │  │ Debate │  │       │
│ │Agent │  │  Agent   │  │  Agent   │  │  Agent   │  │ Agent  │  │       │
│ └──┬───┘  └──────────┘  └────┬─────┘  └──────────┘  └───┬────┘  │       │
│    │                         │                           │        │       │
│    ▼                         ▼                           ▼        │       │
│ ┌──────────────────────────────────────────────────────────────┐  │       │
│ │                    Shared Infrastructure                      │  │       │
│ │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐   │  │       │
│ │  │ SQLite   │ │  Qdrant  │ │  Redis   │ │  Prometheus  │   │  │       │
│ │  │ Vectors  │ │ (ready)  │ │ Sessions │ │  + Grafana   │   │  │       │
│ │  └──────────┘ └──────────┘ └──────────┘ └──────────────┘   │  │       │
│ │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐   │  │       │
│ │  │Knowledge │ │ Embedding│ │  Flash-  │ │    Video     │   │  │       │
│ │  │  Graph   │ │  Cache   │ │  cards   │ │    CDN       │   │  │       │
│ │  └──────────┘ └──────────┘ └──────────┘ └──────────────┘   │  │       │
│ └──────────────────────────────────────────────────────────────┘  │       │
└─────────────────────────────────────────────────────────────────────┘       │
```

---

## 🤖 Agent Registry (10 Agents)

| Agent | Vai trò | Queue | Function |
|---|---|---|---|
| **RagAgent** | RAG Q&A, web search, hybrid search | `priority` | `answerQuestion` |
| **CoderAgent** | Viết code, debug, Big O analysis | `priority` | `solveWithDebugLoop` |
| **ManimAgent** | Sinh animation video (Manim) | `priority` | `createAnimationForPlanner` |
| **VisionAgent** | Phân tích ảnh (Gemini Vision) | `priority` | `analyzeImageBuffer` |
| **VoiceAgent** | Transcribe audio (whisper.cpp) | `priority` | `processVoiceMessage` |
| **PdfAgent** | Xử lý PDF, flashcard generation | `priority` | `processPdf` |
| **DebateAgent** | Multi-agent debate + Planner intervention | `priority` | `runDebate` |
| **FlashcardAgent** | Tạo flashcard từ text | `priority` | `generateFlashcards` |
| **EvoAgent** | Tự tiến hóa, health monitoring + behavioral evolution | `evolution` | `runDailyEvolution` |
| **GraphAgent** | Knowledge graph, entity extraction | `graph` | `extractEntities` |

---

## 🔄 OODA Loop (PlannerAgent)

```
┌─────────────────────────────────────────────────────────┐
│                    OODA LOOP                             │
│                                                         │
│  1. OBSERVE  → Đọc session state từ Redis              │
│                Đọc kết quả workers từ session           │
│                                                         │
│  2. ORIENT   → LLM phân tích:                           │
│                - Đã xong chưa?                          │
│                - Nút thắt đâu?                          │
│                - Cần agent nào tiếp?                    │
│                Fallback: heuristic (topo sort)          │
│                                                         │
│  3. DECIDE   → Chọn agent + action cho bước tiếp       │
│                Build context từ dependency results      │
│                                                         │
│  4. ACT      → Dispatch BullMQ job vào queue tương ứng │
│                Lưu step vào session                     │
│                                                         │
│  Loop cho đến khi: status = 'completed' | 'failed'     │
└─────────────────────────────────────────────────────────┘
```

---

## 🎬 ManimAgent Pipeline

```
Input: description (tiếng Việt)
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│  Step 1: generateManimCode(description)                 │
│  LLM → Python code (Manim library)                      │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│  Step 2: renderManimVideo(code) [retry loop]            │
│  manim -qm script.py SceneName → MP4                   │
│                                                         │
│  Nếu lỗi:                                               │
│    classifyManimError() → errorType + isRetriable       │
│    ├─ isRetriable=true  → LLM fix code → render lại     │
│    └─ isRetriable=false → trả error về Planner          │
│    Max retries: 2                                       │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│  Step 3: compressVideo() (nếu > 24MB)                   │
│  ffmpeg → target bitrate → fit Discord 25MB limit       │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│  Step 4: copyToStaticPath()                             │
│  /public/videos/{jobId}.mp4                             │
│  Optional: upload to S3/CDN                             │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
Output: { success: true, videoUrl, videoPath, sizeMB }
        { success: false, error, errorType, debugInfo }
```

### Error Classification

| errorType | isRetriable | Mô tả |
|---|---|---|
| `syntax_error` | ✅ | Lỗi cú pháp Python |
| `import_error` | ✅ | Lỗi import module |
| `manim_api_error` | ✅ | Sai method/tham số Manim |
| `latex_error` | ✅ | Lỗi MathTeX/LaTeX |
| `scene_not_found` | ✅ | Class name mismatch |
| `manim_not_installed` | ❌ | Manim chưa cài |
| `render_timeout` | ❌ | Render quá lâu |
| `pipeline_timeout` | ❌ | Pipeline quá lâu |

---

## 🧠 Knowledge Graph

```
┌─────────────────────────────────────────────────────────┐
│  SQLite: knowledge_graph.db                             │
│                                                         │
│  entities: id, name, type, description, metadata        │
│  edges: source_id, target_id, relation, weight          │
│  entity_aliases: alias → entity_id                      │
│                                                         │
│  API:                                                   │
│  - upsertEntity(name, type, desc)                       │
│  - addRelationship(src, tgt, rel, weight)               │
│  - searchEntities(query, type, limit)                   │
│  - traverseGraph(entityId, depth) → BFS                 │
│  - exportGraphForVisualization() → D3 format            │
└─────────────────────────────────────────────────────────┘

Graph-Enhanced RAG:
  Query → extract entities → search KG → append relationships → RagAgent
```

---

## 📱 PWA (Mobile Companion)

```
public/
├── index.html          # Main app (mobile-first)
├── manifest.json       # PWA manifest
├── sw.js               # Service Worker (cache + push)
├── css/app.css         # Responsive styles
├── js/app.js           # App logic (API client)
└── videos/             # Rendered Manim videos

Tabs:
  📚 Flashcards  → Due cards, review, stats
  ❓ Hỏi đáp     → Ask AI, voice input
  🕸️ Knowledge   → Search knowledge graph
  📊 Stats       → System stats, evolution metrics
```

---

## 🔧 Shared Libraries

| Library | Purpose |
|---|---|
| `embeddings.js` | Gemini embedding (3072 dims) + cache-first |
| `embedding_cache.js` | SQLite LRU cache (TTL 7d, max 10K) |
| `bm25_search.js` | Full-text search (TF-IDF) |
| `vector_store.js` | SQLite vectors + Qdrant fallback |
| `vector_collections.js` | 3-space: academic, system, daily |
| `knowledge_graph.js` | SQLite graph: entities + edges |
| `entity_extractor.js` | LLM entity extraction |
| `graph_rag.js` | Graph-enhanced RAG |
| `self_evolution.js` | Auto-eval, A/B testing, model selection |
| `session_store.js` | Redis-backed session state |
| `task_queue.js` | BullMQ: 4 queues + Redis |
| `video_cdn.js` | Local/S3 video storage |
| `code_sandbox.js` | Multi-language sandbox |
| `flashcard_db.js` | Spaced repetition DB |
| `metrics.js` | Prometheus metrics |

---

## 📊 PM2 Services (9 services)

| Service | Script | Instances |
|---|---|---|
| AI_Discord_Bot | `discord_bot.js` | 1 |
| AI_Feedback_Server | `feedback_server.js` | 1 |
| AI_Scheduler | `scheduler.js` | 1 |
| AI_Library_Watcher | `watch_library.js` | 1 |
| AI_REST_API | `rest_api_server.js` | 1 |
| AI_Admin_Dashboard | `admin_dashboard.js` | 1 |
| AI_EvoAgent | `agents/EvoAgent.js` | 1 |
| AI_GraphAgent | `agents/GraphAgent.js` | 1 |
| AI_PlannerWorker | `agents/PlannerWorker.js` | 1 |
| AI_AgentWorker | `agents/AgentWorker.js` | 2 (cluster) |

---

## 🗄️ Data Storage

| Storage | Purpose | Technology |
|---|---|---|
| Vectors | Document embeddings | SQLite (Qdrant ready) |
| Knowledge Graph | Entity relationships | SQLite |
| Embedding Cache | Cached embeddings | SQLite |
| Sessions | Session state | Redis |
| Task Queue | Agent jobs | BullMQ + Redis |
| Flashcards | Spaced repetition | SQLite |
| Videos | Rendered animations | Local/S3 |
| Metrics | System monitoring | Prometheus |
| Config | Agent weights, feedback | JSON files |
| User Profiles | Learning profile, preferences, topic stats | SQLite |
| Implicit Feedback | CTR, dwell time, category affinity | SQLite |
| Mood States | Emotional state history, transitions | SQLite |
| Memory Decay | Ebbinghaus decay log, freshness scores | SQLite |

---

## 🔄 Data Flow

```
User Input (Discord/REST/PWA)
  │
  ├─► MoodState      → analyze tone + time → emotional state
  ├─► ImplicitFeedback → track dwell time, CTR, category affinity
  └─► InteractionAgent → createSession() → Redis
       │
       ▼
  PlannerWorker → init_session job → PlannerAgent.startSession()
       │
       ├─ OBSERVE: read session state + mood + implicit signals
       ├─ ORIENT:  LLM analyze progress + behavioral context
       ├─ DECIDE:  choose next agent (mood-aware)
       └─ ACT:     dispatch BullMQ job

  ── Background (Cron) ──
  4:00 AM  EvoAgent.runDailyEvolution()
           ├─ System health check
           ├─ Knowledge gap detection
           └─ Behavioral analysis (implicit + mood + decay)
  4:30 AM  MemoryDecay.runDailyDecay()
           └─ Ebbinghaus forgetting curve on preferences
       │
       ▼
  AgentWorker → load agent → execute → save result
       │
       ├─ RagAgent → vector search + BM25 + graph → answer
       ├─ CoderAgent → sandbox → code + metrics
       ├─ ManimAgent → LLM code → render → compress → static URL
       ├─ VisionAgent → Gemini Vision → analysis
       ├─ VoiceAgent → whisper.cpp → text → RAG
       ├─ DebateAgent → 2×Coder + Rag + Judge → best solution
       └─ ... (10 agents total)
       │
       ▼
  PlannerAgent.onWorkerComplete() → OODA loop
       │
       ├─ More steps? → dispatch next job
       └─ Done? → finalize session → return result
```
