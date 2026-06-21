# Local LLM làm agent giống bạn — hướng dẫn nhanh

## Mục tiêu
- Biến **local Llama.cpp** thành “não” cho workflow agent trong repo.
- Hiện tại repo đã có **Agent system** (RouterAgent/Orchestrator + agents/*). Việc còn thiếu là **đưa local LLM vào luồng chính** thay vì chỉ fallback.

## Bước 1 — Bật local LLM ưu tiên (ít sửa code)
1) Mở file `.env` ở root dự án.
2) Thêm/đảm bảo:
- `USE_LOCAL_LLM=true`
- `LOCAL_LLM_URL=http://localhost:3002` (hoặc đúng theo port local bạn đang chạy)
3) Chạy local LLM server:
- `node local_llm_server.js`

## Bước 2 — Đảm bảo agent đang dùng local
- Trong `agents/RagAgent.js`, hàm `invokeLlm()` sẽ gọi `tryLocalLlm()` trước **khi** `USE_LOCAL_LLM=true`.
- Vì vậy bước 1 là đủ để RAG/CHAT dùng local cho phần tổng hợp.

## Bước 3 — Nếu muốn “local” cho cả self-reflect gate
Hiện tại gate logic nằm trong `selfReflectAnswerGate()` và nó gọi lại `invokeLlm()`.
- Nhờ Bước 1, gate cũng sẽ đi qua local.
- Nếu bạn muốn cấu hình “local-only” tuyệt đối, cần sửa thêm logic trong `invokeLlm()` (để không đòi OpenRouter key khi local fails-open).

## Bước 4 — Nếu muốn các agent khác (PDF/Debate/Manim/…) dùng local
- Hiện tại chỉ `RagAgent` có nhánh local LLM.
- Cần đưa “LLM provider” (local/openrouter) dùng chung vào các file:
  - `agents/DebateAgent.js`
  - `agents/PdfAgent.js`
  - `agents/ManimAgent.js`
  - `agents/InteractionAgent.js` (nếu có LLM)

---
## Checklist chạy nhanh
- [ ] `models/*.gguf` tồn tại
- [ ] `node local_llm_server.js` chạy không lỗi và có log online
- [ ] `.env` có `USE_LOCAL_LLM=true`
- [ ] Restart bot: `pm2 restart AI_Discord_Bot` hoặc `npm run dev`

