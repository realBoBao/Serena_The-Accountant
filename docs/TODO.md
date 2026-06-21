# 📋 TODO — my-ai-brain Roadmap

> **Cập nhật:** 2026-06-13
> **Test Coverage:** 325/325 PASS (100%) | **CI Jobs:** 4/4 (Lint → Test → Security → Build)
> **PM2 Services:** 8 online | **Uptime:** 24/7 | **Deploy:** GitHub Actions → SSH

---

## ✅ Đã hoàn thành

### Core Infrastructure
- ✅ Discord Bot + Webhook Bot + REST API + Scheduler
- ✅ RAG Pipeline (Vector + BM25 + HyDE + Query Expansion)
- ✅ LLM Fallback Chain: OpenRouter → Gemini → Local → Static
- ✅ 325 Unit Tests (100% pass)
- ✅ FSRS Spaced Repetition (thay SM-2)
- ✅ User Mental Model (SQLite-backed profile + learning style)
- ✅ Temporal Knowledge Graph (bi-temporal, Graphiti-style)
- ✅ Probabilistic Guardrails (TF-IDF scope detector + F1 + grounding verifier)
- ✅ Security: CSP + CORS + API key + IP filter + Audit log + npm audit CI
- ✅ CI/CD: 4 jobs (Lint → Test → Security → Build) + SSH deploy

### Discord Commands (22 commands)
```
!ask <câu hỏi>     → RAG-powered Q&A
!ask <câu hỏi> --deep → Deep search
!run <code>        → Chạy code trong Sandbox
!code <bài toán>   → Viết + chạy code tự động
!debate <bài toán> → Multi-agent debate
!quiz              → Flashcard quiz (FSRS)
!answer <id> <ans> → Review flashcard
!learn <url>       → Học từ URL/PDF
!history <topic>   → Xem facts từ Knowledge Graph
!whenwas <topic>   → Query KG tại thời điểm cụ thể
!analyze <code>    → Code quality analysis
!audit <code>      → Security audit
!profile <code>    → Performance profiling
!profile           → Xem hồ sơ học tập
!logs <text>       → Log analysis
!vision + ảnh      → Phân tích ảnh
!voice + audio     → Transcribe giọng nói
!animate <mô tả>   → Tạo video animation
!plan + ảnh        → Lập kế hoạch từ ảnh
!review            → Shadow Review (ôn code)
!incident          → Chaos Engineering
!memory <nội dung> → Lưu trí nhớ
!preferences       → Tuỳ chọn model/sources/learning
!prefer            → Đặt phong cách học
!f1stats           → F1 Score Dashboard
!path <topic>      → Lộ trình học từ KG
!schedule          → Đồng bộ thời khóa biểu
!help              → Danh sách lệnh
```

---

## 📊 Đánh giá chất lượng toàn diện

| Tiêu chí | Hiện tại | Mục tiếu | Ghi chú |
|---|---|---|---|
| **Test Coverage** | 325/325 (100%) | ✅ | Unit tests |
| **CI/CD** | 4 jobs | ✅ | Lint + Test + Security + Build |
| **Code Quality** | ESLint + Prettier | ✅ | Automated |
| **Security** | 4-layer sandbox + npm audit | ✅ | CI + runtime |
| **RAG Quality** | F1 + grounding verifier | ✅ | Chống hallucination |
| **Self-Learning** | FSRS + User Profile + KG | ✅ | Temporal KG |
| **Multi-Agent** | 8 agents + debate + pipeline | ✅ | Orchestrator |
| **Observability** | Logging + PM2 + health check | ⚠️ | Thiếu Prometheus/Grafana |
| **Documentation** | Code comments + HOTFIX.md | ⚠️ | Thiếu API docs |
| **E2E Tests** | ❌ Chưa có | ⚠️ | Integration tests |
| **Load Testing** | ❌ Chưa có | ⚠️ | Performance benchmarks |
| **Chaos Engineering** | !incident command | ✅ | Simulated |
| **Backup/Restore** | ✅ Auto-backup | ✅ | Weekly cron |
| **Deploy Automation** | ✅ GitHub Actions → SSH | ✅ | Auto deploy on push |

---

## 🔴 Cần cải thiện

### P0 — Critical (nên làm)
- [ ] **SSH Deploy fail** — Fix SSH key authentication (GitHub Secrets ↔ server authorized_keys)
- [ ] **E2E Integration Tests** — Thêm tests cho full pipeline (scrape → embed → query → answer)
- [ ] **API Documentation** — Swagger/OpenAPI cho 30+ REST endpoints

### P1 — High (nên làm trong 1-2 tuần)
- [ ] **Prometheus + Grafana** — Metrics dashboard cho PM2 services
- [ ] **Load Testing** — Benchmark concurrent requests, memory usage
- [ ] **Error Tracking** — Sentry hoặc tương tự cho production errors
- [ ] **Dependency Updates** — `npm outdated` → update critical packages

### P2 — Medium (nice to have)
- [ ] **TypeScript Migration** — Gradual migration từ JS → TS (bắt đầu từ lib/)
- [ ] **i18n** — Đa ngữ (Việt + Anh) cho Discord messages
- [ ] **Plugin System** — Cho phép thêm agents mới không cần sửa core
- [ ] **WebSocket Real-time** — Thay polling bằng WS cho notifications

---

## 🛠️ Quick Commands

```bash
# Local dev
npm run dev                    # Start all services
npm test                       # Run tests
node scripts/backup.sh         # Backup data

# Discord
!preferences model openrouter  # Set preferred model
!preferences sources youtube   # Set preferred sources
!preferences learning on       # Enable self-learning
!quiz                          # Start flashcard quiz
!quiz stats                    # View flashcard stats
!f1stats                       # View F1 Score Dashboard
!history distributed systems   # Query Knowledge Graph
```
