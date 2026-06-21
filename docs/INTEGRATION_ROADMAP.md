# 🗺️ Integration Roadmap — Thuật toán & Open Source tích hợp

> Audit ngày 14/06/2026. Dựa trên code thực tế trong project.
> Mỗi entry: **Vấn đề cụ thể → Giải pháp → Impact → Effort**

---

## ✅ ĐÃ HOÀN THÀNH (15 items)

| # | Tên | Tier |
|---|-----|------|
| 1 | Hybrid Search (BM25+Vector RRF) | 1 |
| 2 | LRU + 2-tier Semantic Cache | 1 |
| 3 | OWASP Security Headers + Validation | 1 |
| 4 | SQLite WAL Mode (4 DBs) | 1 |
| 5 | Deep Health Check | 1 |
| 6 | Sliding Window Rate Limiting | 2 |
| 7 | DB Pool utility | 2 |
| 8 | Enhanced Structured Logging | 2 |
| 9 | Compression Middleware | 3 |
| 10 | CORS Strict Mode | 3 |
| 11 | Graceful Shutdown + DB close | 3 |
| 12 | Qdrant Vector DB Adapter | 4 |
| 13 | PostgreSQL Migration Helper | 4 |
| 14 | Cloud Scheduler Setup Script | 4 |
| 15 | Scheduler Cloud Run awareness | 4 |

**Tests: 6 suites, 68 tests passed ✅**

---

## ✅ ĐÃ HOÀN THÀNH — Bổ sung (21/06/2026)

| # | Tên | Tier |
|---|-----|------|
| 16 | **Response Caching** (in-memory, 5min TTL, 500 entries) — Giảm API calls cho câu hỏi trùng | 2 |
| 17 | **Context Compression** (`summarizeContext()`) — Giảm 70% token cho long contexts | 1 |
| 18 | **Agent Usage Tracking** (`_trackAgentCall`, `getDetailedAgentUsage`, `getUnusedAgents`) — Biết agent nào đang "chết" | 5 |
| 19 | **Circuit Breaker** (`orchestrator_guard.js`) — RouterAgent fail 5 lần → bypass, fallback response | 6 |
| 20 | **Health Check** (`health_check.js`) — Auto check LLM, Vector DB, Discord mỗi sáng | 5 |
| 21 | **node:sqlite Migration** — `$param` syntax, Date binding, array params (thay vì `?` placeholders) | — |
| 22 | **flashcard_db.js Rewrite** — Fix SQL compatibility, add missing exports (`clearAll`, `deleteFlashcard`, etc.) | — |
| 23 | **!agentstats Enhanced** — Show detailed usage + unused agents warning | 5 |
| 24 | **!help Bypass Middleware** — Move to top of MessageCreate handler, bypass rate limit/dedup | — |

**Tests: 12 suites, 200+ tests passed ✅**

---

## 🔴 TIER 1 — HIGH Impact, LOW Effort (làm ngay)

### 1. Hybrid Search: BM25 + Vector (RRF fusion)
- **Vấn đề**: `vector_store.js` chỉ dùng HNSW (semantic search). Với từ khóa chính xác (tên thuật toán, tên hàm), BM25 tốt hơn vector.
- **Giải pháp**: Đã có `bm25_search.js` nhưng chưa kết hợp. Thêm **Reciprocal Rank Fusion (RRF)** để merge kết quả BM25 + HNSW.
- **Code**: `lib/hybrid_search.js` (~80 dòng)
- **Impact**: 🔴 HIGH — RAG recall tăng 15-30% (paper: https://plg.uwaterloo.ca/~gvcormac/cormacksigir2009-rrf.pdf)
- **Effort**: 🟢 LOW — cả BM25 và HNSW đã có sẵn, chỉ cần fusion layer

### 2. LRU Cache cho Semantic Cache
- **Vấn đề**: `semantic_cache.js` dùng mảng tuyến tính O(N) scan. Với 500 entries, mỗi lookup so sánh 500 embeddings.
- **Giải pháp**: Thêm `lru-cache` (npm: `lru-cache`) hoặc tự implement LRU với Map.
- **Impact**: 🟠 MEDIUM — Cache lookup từ O(N) → O(1)
- **Effort**: 🟢 LOW — 20 dòng thay đổi

### 3. Helmet cho Security Headers
- **Vấn đề**: `security.js` tự viết headers thủ công. Thiếu `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`.
- **Giải pháp**: Dùng `helmet` (npm: `helmet`) — industry standard cho Express/HTTP security headers.
- **Impact**: 🟠 MEDIUM — Bảo mật tốt hơn, đã audit bởi community
- **Effort**: 🟢 LOW — thay 1 function call

### 4. Zod cho Input Validation
- **Vấn đề**: `rest_api_server.js` không validate input shape. `parseBody()` trả về raw object không có schema check.
- **Giải pháp**: `zod` (npm: `zod`) — TypeScript-friendly schema validation. Validate request body trước khi xử lý.
- **Impact**: 🟠 MEDIUM — Chặn malformed requests, type safety
- **Effort**: 🟢 LOW — define schema + 1 dòng validate mỗi route

---

## 🟠 TIER 2 — HIGH Impact, MEDIUM Effort (lần sau)

### 5. WAL Mode cho SQLite
- **Vấn đề**: `knowledge_graph.js`, `flashcard_db.js`, `vector_store.js` dùng SQLite mặc định (journal mode = DELETE). Khi Cloud Run scale-to-zero đột ngột, DB có thể corrupt.
- **Giải pház**: Bật `PRAGMA journal_mode=WAL` + `PRAGMA synchronous=NORMAL` cho mỗi DB connection.
- **Impact**: 🔴 HIGH — Data integrity khi Cloud Run kill container đột ngột
- **Effort**: 🟡 MEDIUM — thêm 2-3 dòng mỗi DB init, nhưng cần test kỹ

### 6. Connection Pooling cho SQLite
- **Vấn đề**: Mỗi `getDb()` call mở connection mới. Khi có nhiều concurrent requests (Cloud Run scale up), SQLite bị lock.
- **Giải pház**: Dùng `better-sqlite3` (synchronous, faster) hoặc connection pool wrapper.
- **Impact**: 🟠 MEDIUM — Concurrent request handling tốt hơn
- **Effort**: 🟡 MEDIUM — cần refactor DB access pattern

### 7. Structured Logging với Pino
- **Vấn đề**: `logger.js` dùng `console.log`. Không có log level, không có structured output. Khó debug trên Cloud Run Logs Explorer.
- **Giải pháp**: `pino` (npm: `pino`) — fastest JSON logger, Cloud Run native support.
- **Impact**: 🟠 MEDIUM — Debug nhanh hơn, log có structure để query
- **Effort**: 🟡 MEDIUM — thay thế logger ở mọi file

### 8. Rate Limiting nâng cao: Sliding Window
- **Vấn động**: `rest_api_server.js` dùng fixed window counter. Có thể bị burst 2x ở boundary.
- **Giải pháp**: Sliding window log hoặc token bucket. Dùng `rate-limiter-flexible` (npm).
- **Impact**: 🟠 MEDIUM — Rate limit chính xác hơn, chống abuse tốt hơn
- **Effort**: 🟡 MEDIUM — thay thế rate limit logic

### 9. Prompt Caching với Semantic Dedup
- **Vấn đề**: `semantic_cache.js` chỉ cache khi similarity > 0.92 (quá cao). Nhiều câu hỏi "gần giống" vẫn gọi LLM.
- **Giải pház**: 2-tier cache: exact match (hash) → semantic match (embedding). Giảm threshold xuống 0.85 cho tier-2.
- **Impact**: 🟠 MEDIUM — Giảm LLM calls ~20-40%
- **Effort**: 🟡 MEDIUM — refactor cache logic

---

## 🟡 TIER 3 — MEDIUM Impact, LOW Effort (khi rảnh)

### 10. Compression Middleware
- **Vấn đề**: API responses (đặc biệt `/api/graph/export`, `/api/flashcards`) không compressed.
- **Giải pháp**: `compression` (npm: `compression`) — gzip middleware.
- **Impact**: 🟡 MEDIUM — Response size giảm 60-80%
- **Effort**: 🟢 LOW — 1 dòng middleware

### 11. CORS strict mode
- **Vấn đề**: `rest_api_server.js` dùng `Access-Control-Allow-Origin: *`. Quá permissive.
- **Giải pház**: Whitelist origin từ env var, chỉ cho phép dashboard domain.
- **Impact**: 🟡 MEDIUM — Bảo mật tốt hơn
- **Effort**: 🟢 LOW — 5 dòng

### 12. Health Check chi tiến hơn
- **Vấn đề**: `/api/health` chỉ trả `{ status: 'ok' }`. Không check DB connectivity, disk space, memory.
- **Giải pház**: Deep health check: ping DB, check memory threshold, check disk.
- **Impact**: 🟡 MEDIUM — Cloud Run auto-restart khi unhealthy
- **Effort**: 🟢 LOW — 30 dòng

### 13. Graceful Shutdown cải tiến
- **Vấn đề**: `rest_api_server.js` có graceful shutdown nhưng không close DB connections.
- **Giải pház**: Close tất cả DB connections, flush caches, complete pending requests trước khi exit.
- **Impact**: 🟡 MEDIUM — Không mất data khi Cloud Run scale to zero
- **Effort**: 🟢 LOW — 20 dòng

---

## 🔵 TIER 4 — HIGH Impact, HIGH Effort (dài hạn)

### 14. Migrate sang PostgreSQL (Cloud SQL)
- **Vấn đề**: SQLite không phù hợp cho Cloud Run (local file, không survive container restart).
- **Giải pház**: PostgreSQL trên Cloud SQL (free tier: shared hoặc Cloud SQL Auth Proxy).
- **Impact**: 🔴 HIGH — Data persistence, concurrent access, backup tự động
- **Effort**: 🔴 HIGH — Migrate schema, refactor all DB access

### 15. Distributed Tracing với OpenTelemetry
- **Vấn đề**: Không có trace ID xuyên suốt request. Khó debug khi có nhiều service.
- **Giải pház**: `@opentelemetry/sdk-node` + Cloud Trace exporter.
- **Impact**: 🟠 MEDIUM — Observability production-grade
- **Effort**: 🔴 HIGH — Instrument toàn bộ codebase

### 16. Vector DB chuyên dụng: Qdrant hoặc pgvector
- **Vấn đề**: HNSW in-memory mất data khi restart. SQLite không tối ưu cho vector search.
- **Giải pház**: Qdrant (Docker) hoặc pgvector (PostgreSQL extension).
- **Impact**: 🔴 HIGH — Vector search nhanh hơn, persistent, scalable
- **Effort**: 🔴 HIGH — Infrastructure mới, migrate data

---

## 📊 Tóm tắt ưu tiên

| # | Tên | Impact | Effort | Tier |
|---|-----|--------|--------|------|
| 1 | Hybrid Search (BM25+Vector RRF) | 🔴 HIGH | 🟢 LOW | 1 |
| 2 | LRU Cache | 🟠 MED | 🟢 LOW | 1 |
| 3 | Helmet Security | 🟠 MED | 🟢 LOW | 1 |
| 4 | Zod Validation | 🟠 MED | 🟢 LOW | 1 |
| 5 | SQLite WAL Mode | 🔴 HIGH | 🟡 MED | 2 |
| 6 | Connection Pooling | 🟠 MED | 🟡 MED | 2 |
| 7 | Pino Structured Logging | 🟠 MED | 🟡 MED | 2 |
| 8 | Sliding Window Rate Limit | 🟠 MED | 🟡 MED | 2 |
| 9 | 2-tier Semantic Cache | 🟠 MED | 🟡 MED | 2 |
| 10 | Compression | 🟡 MED | 🟢 LOW | 3 |
| 11 | CORS Strict | 🟡 MED | 🟢 LOW | 3 |
| 12 | Deep Health Check | 🟡 MED | 🟢 LOW | 3 |
| 13 | Graceful Shutdown+ | 🟡 MED | 🟢 LOW | 3 |
| 14 | PostgreSQL Migration | 🔴 HIGH | 🔴 HIGH | 4 |
| 15 | OpenTelemetry | 🟠 MED | 🔴 HIGH | 4 |
| 16 | Qdrant/pgvector | 🔴 HIGH | 🔴 HIGH | 4 |
