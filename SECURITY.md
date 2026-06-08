# 🔒 AI Sandbox Security Architecture

## Tổng quan

Hệ thống sandbox bảo mật cho phép các AI Agent chạy code một cách an toàn mà không gây rủi ro cho máy host. Đây là lớp bảo vệ chống lại RCE (Remote Code Execution), prompt injection, và code độc hại.

## Kiến trúc bảo mật

```
┌─────────────────────────────────────────────────────────────┐
│                      AGENTS LAYER                           │
│  Orchestrator │ RagAgent │ PdfAgent │ VisionAgent │ ...     │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  SANDBOX GATEWAY                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │Policy Engine │  │Security Scan │  │  Audit Logger    │  │
│  │• Trust Level │  │• Layer 1: Cmd│  │• Execution Log   │  │
│  │• Rate Limit  │  │• Layer 2: Imp│  │• Stats           │  │
│  │• Code Size   │  │• Layer 3: Pat│  │• History         │  │
│  │• Timeout Cap │  │• Layer 4: Exf│  │                  │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
└──────────────────────────┬──────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
┌──────────────────────┐  ┌──────────────────────────────┐
│   DOCKER SANDBOX     │  │   IN-PROCESS SANDBOX         │
│   (Preferred)        │  │   (Fallback)                 │
│                      │  │                              │
│ ✅ Network: NONE     │  │ ⚠️  Same OS                  │
│ ✅ RAM: 256MB max    │  │ ✅ shell: false              │
│ ✅ CPU: 0.5 core     │  │ ✅ Sanitized env             │
│ ✅ PIDs: 50 max      │  │ ✅ Timeout + process kill    │
│ ✅ Read-only FS      │  │ ✅ Temp dir isolation        │
│ ✅ No capabilities   │  │ ✅ Auto-cleanup              │
│ ✅ Auto-destroy      │  │                              │
└──────────────────────┘  └──────────────────────────────┘
```

## 4 Lớp bảo mật (Security Layers)

### Layer 1: Dangerous Commands
Chặn các lệnh hủy hoại hệ thống:
- `rm -rf /`, `rm -rf ~`
- `shutdown`, `reboot`, `poweroff`
- `dd if=/dev/zero`, `mkfs`, `fdisk`
- `kill -9 1` (kill init)
- Windows: `format C:`, `del /s /q`, `cipher /w`

### Layer 2: Dangerous Imports
Chặn import module nguy hiểm:
- **Node.js**: `child_process`, `fs`, `net`, `dgram`, `cluster`, `vm`
- **Python**: `os`, `subprocess`, `shutil`, `socket`, `ctypes`, `__import__`
- **Java**: `java.lang.Runtime`, `ProcessBuilder`, `java.net.*`
- **C/C++**: `<unistd.h>`, `<sys/socket.h>`, `<signal.h>`
- **Rust**: `std::process::Command`, `std::fs::remove_`

### Layer 3: Code Injection Patterns
Chặn các pattern thực thi code độc hại:
- `eval()`, `new Function()`, `exec()`, `spawn()`
- `process.exit()`, `process.env`, `process.kill()`
- `while(true){}`, `for(;;){}` (infinite loops)
- `fetch()`, `http.get()`, `WebSocket` (network)
- `fs.readFile()`, `fs.writeFile()` (file I/O)
- `__proto__`, `__subclasses__`, `__builtins__` (prototype pollution)
- `system()`, `fork()`, `exec()` (C/C++ system calls)
- `exec.Command()`, `os.Remove()` (Go system calls)

### Layer 4: Data Exfiltration
Chặn cố gắng đánh cắp dữ liệu:
- `curl`, `wget`, `nc` (netcat)
- Pattern: gửi API keys/secrets ra ngoài

## Trust Levels

| Level | Label | Timeout | Network | FileIO | Rate Limit | Approval |
|-------|-------|---------|---------|--------|------------|----------|
| 0 | 🔴 UNTRUSTED | 5s | ❌ | ❌ | 3/min | ✅ Required |
| 1 | 🟡 BASIC | 10s | ❌ | ✅ | 10/min | ❌ |
| 2 | 🟢 TRUSTED | 30s | ❌ | ✅ | 30/min | ❌ |
| 3 | 🔵 PRIVILEGED | 60s | ✅ | ✅ | 60/min | ❌ |

## Agent Trust Assignments

| Agent | Trust Level | Reason |
|-------|-------------|--------|
| orchestrator | 🔵 PRIVILEGED | System-level, controls all agents |
| scheduler | 🟢 TRUSTED | Internal system agent |
| rag | 🟢 TRUSTED | Internal knowledge agent |
| pdf | 🟢 TRUSTED | Internal processing agent |
| interaction | 🟡 BASIC | User-facing, moderate risk |
| debate | 🟡 BASIC | Internal reasoning agent |
| manim | 🟡 BASIC | Code generation agent |
| vision | 🟡 BASIC | Image processing agent |
| voice | 🟡 BASIC | Audio processing agent |
| user_input | 🔴 UNTRUSTED | External, untrusted source |
| web_scraped | 🔴 UNTRUSTED | External, untrusted source |
| discord_message | 🔴 UNTRUSTED | External, untrusted source |

## Docker Security Flags

Khi chạy code trong Docker container, các flag bảo mật sau được áp dụng:

```bash
docker run \
  --rm                              # Auto-destroy sau khi chạy
  --network none                    # ← Không có mạng
  --memory 256m                     # ← Giới hạn RAM
  --memory-swap 256m                # ← Không swap
  --cpus 0.5                        # ← Giới hạn CPU
  --pids-limit 50                   # ← Giới hạn số process
  --read-only                       # ← Root FS read-only
  --tmpfs /tmp:rw,noexec,size=50m   # ← /tmp writable, noexec
  --user 1000:1000                  # ← Non-root user
  --cap-drop ALL                    # ← Drop ALL capabilities
  --security-opt no-new-privileges  # ← Không được leo thang quyền
  --stop-signal SIGKILL             # ← Force kill on timeout
```

## Cách sử dụng

### 1. Setup sandbox (lần đầu)

```bash
node scripts/setup_sandbox.js
```

### 2. Sử dụng trong code

```javascript
import { sandboxGateway } from './sandbox_gateway.js';

// Chạy code từ agent
const result = await sandboxGateway.execute({
  agent: 'rag',
  code: 'print("Hello World")',
  language: 'python',
});

if (result.blocked) {
  console.log('Code bị chặn:', result.error);
} else if (result.success) {
  console.log('Output:', result.output);
} else {
  console.log('Error:', result.error);
}
```

### 3. Kiểm tra trạng thái

```javascript
const status = await sandboxGateway.getStatus();
console.log(status);
// {
//   initialized: true,
//   dockerAvailable: true,
//   dockerImageBuilt: true,
//   preferredMethod: 'docker',
//   stats: { totalExecutions: 42, blocked: 3, ... }
// }
```

### 4. Kiểm tra agent permission

```javascript
const perm = sandboxGateway.canExecute('rag');
console.log(perm);
// {
//   agent: 'rag',
//   trustLevel: 2,
//   trustLabel: '🟢 TRUSTED',
//   rateLimit: { allowed: true, remaining: 27, resetIn: 45 },
//   canExecute: true
// }
```

## File Structure

```
my-ai-brain/
├── Dockerfile.sandbox          # Docker image cho sandbox
├── sandbox_runner.js           # Docker sandbox orchestrator
├── sandbox_gateway.js          # Unified gateway (entry point)
├── lib/
│   ├── code_sandbox.js         # In-process sandbox (legacy)
│   ├── code_sandbox_v2.js      # In-process sandbox (improved)
│   └── sandbox_policy.js       # Policy engine & audit
├── scripts/
│   └── setup_sandbox.js        # Setup & diagnostics
├── tests/
│   └── sandbox_security.test.js # Security test suite
└── SECURITY.md                 # This file
```

## Quy tắc vàng

1. **KHÔNG BAO GIỜ** cho Agent chạy code trực tiếp trên host OS
2. **LUÔN** qua SandboxGateway trước khi execute code
3. **ƯU TIÊN** Docker sandbox, fallback in-process khi cần
4. **GIỚI HẠN** timeout, RAM, CPU cho mọi execution
5. **NGẮT MẠNG** trừ khi thực sự cần (chỉ PRIVILEGED)
6. **LOG** mọi execution để audit
7. **KIỂM TRA** rate limit để tránh abuse

## Cài đặt Docker (Windows)

1. Tải Docker Desktop: https://www.docker.com/products/docker-desktop/
2. Cài đặt và khởi động Docker Desktop
3. Chạy: `node scripts/setup_sandbox.js`
4. Xác nhận: `docker images | findstr ai-sandbox`

## Testing

```bash
# Chạy security tests
node --experimental-vm-modules node_modules/jest/bin/jest.js tests/sandbox_security.test.js

# Chạy với coverage
node --experimental-vm-modules node_modules/jest/bin/jest.js tests/sandbox_security.test.js --coverage
```
