# Local Graph-Enhanced RAG Healthcheck (Phase 19)

## Mục tiêu
- Xác nhận `knowledge_graph.db` có dữ liệu.
- Xác nhận `RagAgent` có đọc graph context (nếu được bật).

## 1) Đảm bảo GraphAgent không bị kẹt Redis
- Hiện GraphAgent đang log: `connect ECONNREFUSED 127.0.0.1:6379`
- `lib/task_queue.js` dùng Redis để chạy worker BullMQ.
- Nếu Redis chưa chạy, worker sẽ không consume job.

**Cần đảm bảo Redis service chạy trên 127.0.0.1:6379**
- Tùy hệ của bạn: start Redis (hoặc docker) rồi quay lại.

## 2) Kiểm tra knowledge_graph.db
Chạy script sqlite query (cần sqlite3 trong PATH):

```powershell
sqlite3 knowledge_graph.db "select count(*) as entities, (select count(*) from edges) as edges from entities;" 
```

Nếu `entities=0` thì Graph RAG chưa có dữ liệu.

## 3) Trigger syncGraph thủ công để seed dữ liệu
Bạn có thể gọi trực tiếp function `sync_graph` bằng job queue (nếu Redis OK):

```powershell
node -e "import { addJob, JobType, QueueName } from './lib/task_queue.js'; addJob(QueueName.GRAPH, JobType.SYNC_GRAPH, { timestamp: Date.now() }).then(j=>console.log('job',j.id)).catch(console.error);" 
```

Sau đó kiểm tra lại `knowledge_graph.db`.

## 4) Xác nhận RagAgent đang dùng graph
Trong `agents/RagAgent.js` tìm flag (ví dụ `GRAPH_ENHANCED_RAG`).
- Nếu chưa bật, bật config đó.

---

Ghi chú: Hiện tại các phần Graph ingestion phụ thuộc BullMQ/Redis. Vì vậy “graph context” chỉ có khi Redis chạy để GraphAgent xử lý job.
