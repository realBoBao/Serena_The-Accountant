# My AI Brain — Serena, AI Robot Girl Companion

> Hệ thống AI đa tác nhân tự học, tự tiến hóa, tự bảo mật.
> **VPS/PM2 Production | Ponytail Optimized**
> **197 tests PASS | 20 Agents | 7-tier RAG | Plugin System | Career Agent**

---

## Architecture

```
Discord Bot (dumb client)
    ↓ HTTP/WebSocket
API Server (gateway.js:3005)
    ↓
Orchestrator (RouterAgent + Persona Routing)
    ↓
20 Agents (Rag, Coder, Socratic, Manim, Vision, Debate, ...)
    ↓
7-tier RAG Pipeline
    ↓
SQLite Vector Store (domain-filtered) + BM25 + Knowledge Graph
```

### Tier System
- **Tier 1**: Persona Routing (Therapist vs Technical) — skip RAG for casual chat
- **Tier 2**: Decoupled Orchestrator — REST API independent of Discord
- **Tier 3**: T-Shaped Learning — deep (spaced repetition) + broad (RSS news)
- **Tier 4**: Career Agent — interview prep, job scraper, outreach drafting

---

## Discord Commands

### Hỏi đáp & Tìm kiếm
```
!ask <câu hỏi>              → RAG-powered Q&A (7-tier pipeline)
!ask <câu hỏi> --deep       → Deep search (8 results, 5 web sources)
!learn <url>                → Học từ URL/PDF
!path <topic>               → Learning Path (Dễ → Khó, từ KG)
!path <topic> --short       → Chỉ 5 bước tiếp theo
!path <topic> --gaps        → Chỉ topic cần học
!recap <topic>              → Tóm tắt bài học
!history <topic>            → Xem facts gần đây từ KG
!whenwas <topic> [date]     → Query KG tại thời điểm cụ thể
!memory <nội dung>           → Lưu trí nhớ cá nhân
```

### Code & Thuật toán
```
!run <code>                 → Chạy code trong Sandbox
!code <bài toán>            → Viết + chạy code tự động
!debate <bài toán>          → Multi-agent debate
!analyze <code>             → Phân tích chất lượng code
!audit <code>               → Quét bảo mật code
!perf <code>                → Phân tích performance
!logs <text>                → Phân tích logs
!review                     → Shadow Review (ôn code cũ)
!incident                   → Chaos Engineering
```

### Voice Channel
```
!voice join                 → Tham gia voice channel
!voice leave                → Rời voice channel
!voice study                → Bật chế độ học (bot im lặng)
!voice stop                 → Tắt chế độ học
!voice + audio              → Transcribe giọng nói (whisper.cpp)
```

### Học tập
```
!quiz                       → Flashcard quiz (FSRS)
!quiz stats                 → Thống kê flashcard
!answer <id> <đáp án>       → Trả lời flashcard
!f1stats                    → F1 Score Dashboard
!profile                    → Hồ sơ học tập
!preferences                → Tùy chọn model/sources/learning
!prefer <style>             → Phong cách học (example_first | theory_first | code_heavy)
```

### Sáng tạo
```
!animate <mô tả>            → Tạo video animation (Manim)
!vision + ảnh               → Phân tích ảnh (Gemini Vision)
```

### Hệ thống
```
!schedule                   → Đồng bộ thời khóa biểu
!plugins                    → Danh sách plugins
!resources                  → Tài nguyên hệ thống
!cli <command>              → Chạy CLI command
!agentstats                 → Thống kê sử dụng agents
!gaps                       → Xem knowledge gaps
!cs                         → Xem CS curriculum
!help                       → Danh sách lệnh
```

### Career & Interview
```
!draft <JD text>            → Soạn thản outreach (3 versions)
!interview start            → Mock interview với Staff Engineer
!interview end              → Kết thúc mock interview
```

### Daily Algo Bot (Webhook)
```
8:00 AM daily                → Gửi bài thuật toán vào #daily-algo
23:59 PM daily               → Gửi đáp án nếu chưa !done
!done                        → Đánh dãu giải xong, skip đáp án
```

### Job Bot (Webhook)
```
Mỗi 6h                       → Scrape SimplifyJobs → gửi #job-alerts
```

### Camera (Web UI)
```
📷 Camera tab               → Nhận diện cảm xúc (demo mode)
```

---

## Quick Start (VPS/PM2)

```bash
git clone https://github.com/realBoBao/Serena_The-Accountant.git
cd Serena_The-Accountant
npm install
cp .env.example .env
# Edit .env with your API keys
npm test
pm2 start ecosystem.config.cjs
pm2 save
```
