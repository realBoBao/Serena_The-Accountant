# 📋 LIB REVIEW — Phân tích 85 files trong lib/

## 🔴 Vấn đề chính

### 1. Logic trùng lặp / Song song
| File | Vấn đề |
|---|---|
| `adaptive_model.js` | Chọn model theo query type — **trùng với `llm.js`** |
| `query_quality.js` | Đánh giá query quality — **trùng với `rag_verifier.js`** |
| `knowledge_gap_ingest.js` | Auto-ingest cho knowledge gaps — **trùng với `pipeline_report_v2.js`** |
| `confidence_scorer.js` | 4-signal confidence — **trùng với `rag_verifier.js`** |
| `semantic_cache.js` | Cache embedding — **trùng với `context_cache.js`** |
| `vector_store.js` + `vector_store_qdrant.js` + `hnsw.js` | 3 file vector search — **nên gộp** |
| `code_sandbox.js` + `code_sandbox_v2.js` | 2 version — **nên xóa v1** |
| `sqlite_sync.js` + `sqlite_async.js` | 2 wrapper — **nên gộp** |
| `last30days.js` | Alexa skill — **không cần, xóa** |
| `moneyprinter_client.js` | Video generation — **không cần, xóa** |
| `pngtuber_server.js` | PNGTuber — **không cần, xóa** |
| `video_streamer.js` | Video streaming — **không cần, xóa** |
| `tts.js` | Text-to-speech — **chưa dùng, xóa** |
| `persona_router.js` | Persona routing — **chưa dùng, xóa** |
| `north_star.js` | North star metric — **chưa dùng, xóa** |
| `feature_flags.js` | Feature flags — **chưa dùng, xóa** |
| `outbox.js` + `outbox_worker.js` | Outbox pattern — **chưa dùng, xóa** |
| `batch_processor.js` | Batch processing — **chưa dùng, xóa** |
| `work_stealer.js` | Work stealing — **chưa dùng, xóa** |
| `lsm_tree.js` | LSM Tree — **chưa dùng, xóa** |
| `raft.js` | Raft consensus — **chưa dùng, xóa** |
| `mem0_client.js` | Mem0 — **chưa dùng, xóa** |

### 2. Files cần tích hợp vào Discord Bot
| File | Vai trò | Tích hợp vào |
|---|---|---|
| `query_quality.js` | Đánh giá query | `RagAgent.js` → trước khi search |
| `adaptive_model.js` | Chọn model tối ưu | `llm.js` → thêm vào chain |
| `knowledge_gap_ingest.js` | Auto-ingest | `EvoAgent.js` → cron job |
| `rag_verifier.js` | Verify answer | `RagAgent.js` → sau khi có answer |
| `confidence_scorer.js` | Confidence score | `RagAgent.js` → sau khi có answer |
| `semantic_cache.js` | Cache query | `RagAgent.js` → trước khi gọi LLM |
| `context_cache.js` | Cache context | `RagAgent.js` → trước khi search |
| `hybrid_search.js` | Hybrid search | `RagAgent.js` → thay thế vector_search |
| `bm25_search.js` | BM25 search | `RagAgent.js` → hybrid với vector |
| `hnsw.js` | HNSW index | `vector_store.js` → thay thế brute force |
| `datalog_engine.js` | Datalog engine | `rag_verifier.js` → logic verification |
| `fact_extractor.js` | Fact extraction | `rag_verifier.js` → extract claims |
| `source_analyzer.js` | Source analysis | `pipeline_report_v2.js` → đánh giá sources |
| `quality_tracker.js` | Quality tracking | `EvoAgent.js` → track chất lượng |
| `implicit_feedback.js` | Implicit feedback | `RagAgent.js` → học từ user behavior |
| `mood_state.js` | Mood state | `RagAgent.js` → điều chỉnh tone |
| `session_memory.js` | Session memory | `RagAgent.js` → context ngắn hạn |
| `schedule_sync.js` | Schedule sync | `scheduler.js` → đồng bộ lịch |
| `health_check.js` | Health check | `scheduler.js` → daily check |
| `load_shedder.js` | Load shedding | `gateway.js` → rate limiting |
| `circuit_breaker.js` | Circuit breaker | `llm.js` → fail-fast |
| `idempotency.js` | Idempotency | `gateway.js` → dedup requests |
| `orchestrator_guard.js` | Orchestrator guard | `Orchestrator.js` → bảo vệ |
| `security.js` | Security middleware | `rest_api_server.js` → auth |
| `structured_logger.js` | Structured logging | `logger.js` → nâng cấp |
| `observability.js` | Observability | `metrics.js` → tích hợp |
| `prompt_optimizer.js` | Prompt optimization | `RagAgent.js` → tối ưu prompt |
| `prompt_compressor.js` | Prompt compression | `RagAgent.js` → giảm token |
| `shadow_review.js` | Shadow review | `MentorAgent.js` → ôn code |
| `speculative_worker.js` | Speculative execution | `RagAgent.js` → prefetch |
| `request_hedging.js` | Request hedging | `llm.js` → redundancy |
| `request_coalescer.js` | Request coalescing | `gateway.js` → dedup |
| `edge_router.js` | Edge routing | `RouterAgent.js` → local LLM |
| `lazy_agents.js` | Lazy loading | `RouterAgent.js` → giảm memory |
| `lazy_knowledge.js` | Lazy knowledge | `knowledge_graph.js` → on-demand |
| `gap_router.js` | Gap routing | `knowledge_gap_ingest.js` → điều hướng |
| `roadmap_engine.js` | Roadmap engine | `learning_path.js` → tạo lộ trình |
| `cli_tool_finder.js` | CLI tool finder | `PrivilegedAgent.js` → tìm tools |
| `devops_db.js` | DevOps DB | `pipeline_report_v2.js` → lưu trữ |
| `backoff.js` | Backoff | `fetch_retry.js` → retry logic |
| `fetch_retry.js` | Fetch retry | tất cả API calls |
| `with_timeout.js` | Timeout | tất cả async operations |

### 3. Files cần xóa (không dùng / trùng)
- `last30days.js` — Alexa skill, không liên quan
- `moneyprinter_client.js` — Video gen, không dùng
- `pngtuber_server.js` — PNGTuber, không dùng
- `video_streamer.js` — Video streaming, không dùng
- `tts.js` — TTS, chưa tích hợp
- `persona_router.js` — Persona, chưa dùng
- `north_star.js` — Metric, chưa dùng
- `feature_flags.js` — Flags, chưa dùng
- `outbox.js` + `outbox_worker.js` — Outbox, chưa dùng
- `batch_processor.js` — Batch, chưa dùng
- `work_stealer.js` — Work stealing, chưa dùng
- `lsm_tree.js` — LSM Tree, chưa dùng
- `raft.js` — Raft, chưa dùng
- `mem0_client.js` — Mem0, chưa dùng
- `code_sandbox_v2.js` — Giữ v2, xóa v1
- `sqlite_sync.js` — Xóa, dùng `sqlite_async.js`
- `context_cache.js` — Gộp vào `semantic_cache.js`
- `confidence_scorer.js` — Gộp vào `rag_verifier.js`
- `adaptive_model.js` — Gộp vào `llm.js`
- `query_quality.js` — Gộp vào `rag_verifier.js`
- `knowledge_gap_ingest.js` — Gộp vào `EvoAgent.js`

## 📐 Kiến trúc mới đề xuất

```
lib/
├── core/           # Core logic (không phụ thuộc bên ngoài)
│   ├── llm.js              # LLM chain (adaptive model + fallback)
│   ├── rag_agent.js        # RAG pipeline (search + verify + cache)
│   ├── router.js           # Intent routing
│   └── orchestrator.js     # Event orchestration
├── search/         # Search engines
│   ├── vector_store.js     # Vector search (SQLite/HNSW/Qdrant)
│   ├── bm25_search.js      # BM25 keyword search
│   └── hybrid_search.js    # Hybrid (vector + BM25)
├── verify/         # Verification & quality
│   ├── rag_verifier.js     # Answer verification (Datalog + confidence)
│   ├── query_quality.js    # Query quality gate
│   └── source_analyzer.js  # Source quality analysis
├── cache/          # Caching layer
│   ├── semantic_cache.js   # Embedding-based query cache
│   └── context_cache.js    # Context compression cache
├── agents/         # Agent logic
│   ├── evo_agent.js        # Self-evolution
│   ├── planner_agent.js    # DAG planning
│   └── worker_agent.js     # Job processing
├── media/          # Media processing
│   ├── repo_analyzer.js    # Code repo analysis
│   └── media_preprocessor.js # Audio/video preprocessing
├── infra/          # Infrastructure
│   ├── db.js               # Database (SQLite)
│   ├── logger.js           # Logging
│   ├── metrics.js          # Prometheus metrics
│   ├── health_check.js     # Health checks
│   ├── circuit_breaker.js  # Circuit breaker
│   ├── load_shedder.js     # Load shedding
│   ├── idempotency.js      # Idempotency
│   └── security.js         # Security middleware
└── utils/          # Utilities
    ├── chunking.js         # Text chunking
    ├── embeddings.js       # Embedding generation
    ├── fetch_retry.js      # HTTP retry
    ├── backoff.js          # Exponential backoff
    └── with_timeout.js     # Timeout wrapper
```

## 🎯 Thứ tự implement

**Phase 1 — Dọn dẹt (ngay):**
1. Xóa 15+ files không dùng
2. Gộp trùng: `adaptive_model.js` → `llm.js`, `query_quality.js` → `rag_verifier.js`
3. Gộp cache: `context_cache.js` → `semantic_cache.js`

**Phase 2 — Tích hợp (tuần này):**
4. `query_quality.js` → `RagAgent.js` (trước khi search)
5. `rag_verifier.js` → `RagAgent.js` (sau khi có answer)
6. `semantic_cache.js` → `RagAgent.js` (trước khi gọi LLM)
7. `knowledge_gap_ingest.js` → `EvoAgent.js` (cron job)

**Phase 3 — Nâng cấp (tuần sau):**
8. `hnsw.js` → `vector_store.js` (thay brute force)
9. `hybrid_search.js` → `RagAgent.js` (thay vector-only)
10. `datalog_engine.js` → `rag_verifier.js` (logic verification)
