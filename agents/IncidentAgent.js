/**
 * IncidentAgent — Chaos Engineering: 3 AM Incident Simulator
 *
 * Giả lập sự cố production thực tế trong Sandbox.
 * User phải đọc log, chẩn đoán root cause, viết hotfix.
 *
 * Các loại incident:
 * 1. Memory Leak (C/C++) — AddressSanitizer phát hiện
 * 2. Deadlock (Java/C++) — Thread dump analysis
 * 3. Race Condition — Concurrent access bug
 * 4. OOM Kill — Memory limit exceeded
 * 5. Nginx 502 — Backend crash
 * 6. Database Connection Pool Exhaustion
 * 7. Infinite Loop — CPU spike
 * 8. Buffer Overflow — Security vulnerability
 *
 * Được gọi bởi:
 * - discord_bot.js (!incident command)
 * - REST API (/api/incident)
 */

import { executeCode } from '../lib/code_sandbox.js';
import { invokeLlm } from './RagAgent.js';
import { HumanMessage } from '@langchain/core/messages';
import { getLogger } from '../lib/logger.js';

const logger = getLogger('IncidentAgent');

// ── Monte Carlo Simulation ──
// Mô phỏng traffic spikes, resource exhaustion theo phân phối chuẩn
// để tạo incident scenarios thực tế (không rập khuôn)

/**
 * Box-Muller transform: sinh random number theo phân phối chuẩn N(mean, stdDev)
 */
function gaussianRandom(mean = 0, stdDev = 1) {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return z * stdDev + mean;
}

/**
 * Monte Carlo simulation cho traffic spike.
 * Mô phỏng request rate theo thời gian với normal distribution + random spikes.
 *
 * @param {object} opts
 * @param {number} opts.durationMinutes - Thời gian mô phỏng (phút)
 * @param {number} opts.baseRPS - Request/giây bình thường
 * @param {number} opts.peakRPS - Request/giây đỉnh
 * @param {number} opts.spikeProbability - Xác suất xảy ra spike (0-1)
 * @returns {Array<{time, rps, cpu, memory, event?}>}
 */
export function simulateTrafficPattern({
  durationMinutes = 60,
  baseRPS = 100,
  peakRPS = 5000,
  spikeProbability = 0.1,
} = {}) {
  const samples = [];
  const totalSeconds = durationMinutes * 60;
  const sampleInterval = 30; // 1 sample mỗi 30 giây

  let spikeActive = false;
  let spikeRemaining = 0;
  let spikeIntensity = 0;

  for (let t = 0; t < totalSeconds; t += sampleInterval) {
    const minute = Math.floor(t / 60);

    // Normal traffic: base + gaussian noise
    let rps = Math.max(0, Math.round(gaussianRandom(baseRPS, baseRPS * 0.15)));

    // Traffic pattern: cao hơn vào giờ hành chính (8h-18h)
    const hourOfDay = (new Date().getHours() + minute / 60) % 24;
    if (hourOfDay >= 8 && hourOfDay <= 18) {
      rps = Math.round(rps * 1.5);
    }

    // Random spike (DDoS, viral post, etc.)
    if (!spikeActive && Math.random() < spikeProbability) {
      spikeActive = true;
      spikeRemaining = Math.floor(gaussianRandom(300, 120)); // 300s ± 120s
      spikeIntensity = gaussianRandom(0.7, 0.15); // 70% ± 15% of peak
      spikeIntensity = Math.max(0.3, Math.min(1, spikeIntensity));
    }

    let event = null;
    if (spikeActive) {
      const spikeRps = Math.round(baseRPS + (peakRPS - baseRPS) * spikeIntensity);
      rps = Math.max(rps, spikeRps);
      spikeRemaining -= sampleInterval;

      if (spikeRemaining <= 0) {
        spikeActive = false;
        event = 'SPIKE_END';
      } else if (spikeRemaining > spikeRemaining + sampleInterval - 1) {
        event = 'SPIKE_START';
      }
    }

    // CPU correlates with RPS (non-linear)
    const cpuBase = 20;
    const cpuPerK = 8; // CPU increase per 1000 RPS
    const cpu = Math.min(99, Math.round(cpuBase + (rps / 1000) * cpuPerK + gaussianRandom(0, 3)));

    // Memory: grows slowly, spikes during traffic
    const memBase = 30;
    const mem = Math.min(98, Math.round(memBase + (rps / peakRPS) * 50 + gaussianRandom(0, 2)));

    samples.push({
      time: `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`,
      rps,
      cpu,
      memory: mem,
      event,
    });
  }

  return samples;
}

/**
 * Tạo metrics string từ Monte Carlo simulation.
 */
export function generateMetricsFromSimulation(samples) {
  const maxRPS = Math.max(...samples.map(s => s.rps));
  const maxCPU = Math.max(...samples.map(s => s.cpu));
  const maxMem = Math.max(...samples.map(s => s.memory));
  const avgRPS = Math.round(samples.reduce((a, s) => a + s.rps, 0) / samples.length);

  const spikes = samples.filter(s => s.event === 'SPIKE_START');

  return {
    summary: `Peak RPS: ${maxRPS.toLocaleString()} | Avg RPS: ${avgRPS.toLocaleString()} | Peak CPU: ${maxCPU}% | Peak Memory: ${maxMem}%`,
    spikes: spikes.length,
    timeline: samples.filter(s => s.event || s.rps > avgRPS * 2 || s.cpu > 80).slice(0, 10),
    raw: samples,
  };
}

// ── Incident Templates ──

const INCIDENT_TYPES = [
  {
    id: 'memory_leak',
    name: 'Memory Leak (C/C++)',
    severity: 'CRITICAL',
    description: 'Service memory usage growing continuously, OOM kill imminent',
    sandboxLanguage: 'cpp',
    hintKeywords: ['new', 'delete', 'malloc', 'free', 'pointer'],
  },
  {
    id: 'deadlock',
    name: 'Deadlock (Java/C++)',
    severity: 'HIGH',
    description: 'Multiple threads blocked, service unresponsive',
    sandboxLanguage: 'cpp',
    hintKeywords: ['mutex', 'lock', 'thread', 'pthread'],
  },
  {
    id: 'race_condition',
    name: 'Race Condition',
    severity: 'HIGH',
    description: 'Inconsistent data under concurrent access',
    sandboxLanguage: 'cpp',
    hintKeywords: ['mutex', 'atomic', 'lock_guard', 'synchronized'],
  },
  {
    id: 'buffer_overflow',
    name: 'Buffer Overflow',
    severity: 'CRITICAL',
    description: 'Security vulnerability — potential RCE',
    sandboxLanguage: 'cpp',
    hintKeywords: ['strcpy', 'sprintf', 'array', 'bounds'],
  },
  {
    id: 'infinite_loop',
    name: 'Infinite Loop / CPU Spike',
    severity: 'HIGH',
    description: 'CPU at 99%, service timeout',
    sandboxLanguage: 'cpp',
    hintKeywords: ['while', 'for', 'condition', 'break'],
  },
  {
    id: 'null_pointer',
    name: 'Null Pointer Dereference',
    severity: 'CRITICAL',
    description: 'Segfault — service crashing',
    sandboxLanguage: 'cpp',
    hintKeywords: ['nullptr', 'NULL', 'pointer', 'check'],
  },
  {
    id: 'connection_pool',
    name: 'Database Connection Pool Exhaustion',
    severity: 'HIGH',
    description: 'All connections in use, requests timing out',
    sandboxLanguage: 'cpp',
    hintKeywords: ['connection', 'pool', 'close', 'release'],
  },
  {
    id: 'nginx_502',
    name: 'Nginx 502 Bad Gateway',
    severity: 'CRITICAL',
    description: 'Backend service crashed, proxy returning errors',
    sandboxLanguage: 'cpp',
    hintKeywords: ['crash', 'segfault', 'exception', 'signal'],
  },
];

// ── Generate Incident Scenario ──

/**
 * Tạo kịch bản sự cố giả lập.
 * Dùng LLM để tạo log thực tự, metrics, và buggy code.
 */
export async function generateIncident(userId, difficulty = 'medium') {
  const incidentType = INCIDENT_TYPES[Math.floor(Math.random() * INCIDENT_TYPES.length)];
  logger.info(`[IncidentAgent] Generating ${incidentType.name} incident for ${userId}`);

  const scenarioPrompt = `Bạn là một SRE (Site Reliability Engineer) giỏi. Nhiệm vụ: TẠO KỊCH BẢN SỰ CỐ giả lập thực tế.

=== LOẠI SỰ CỐ: ${incidentType.name} ===
Mô tả: ${incidentType.description}
Độ khó: ${difficulty}

Tạo ra:
1. **LOG FILE** giả lập (50-100 dòng) — nhật ký lỗi thực tế từ hệ thống production
2. **METRICS** — CPU, Memory, Disk I/O, Network stats
3. **BUGGY CODE** — Đoạn code ${incidentType.sandboxLanguage} có lỗi gây ra sự cố (50-150 dòng)
4. **ROOT CAUSE** — Gốc rễ vấn đề (ẨN, không hiển thị cho user)
5. **HOTFIX** — Cách sửa đúng (ẨN, dùng để chấm điểm)

Format output — JSON hợp lệ:
{
  "title": "Tiêu đề sự cố",
  "scenario": "Mô tả tình huống bằng tiếng Việt (user đang on-call lúc 3AM, monitoring alert...)",
  "logs": "Log file giả lập (dạng text, có timestamps, error messages)",
  "metrics": "CPU/Memory/Network stats giả lập",
  "buggyCode": "Đoạn code ${incidentType.sandboxLanguage} có lỗi",
  "hiddenRootCause": "Gốc rễ lỗi (ẨN)",
  "hiddenHotfix": "Code sửa đúng (ẨN)",
  "timeLimit": "15",
  "hints": ["hint 1", "hint 2", "hint 3"]
}`;

  try {
    const raw = await invokeLlm([
      new HumanMessage('You are an expert SRE. Create realistic incident scenarios. Always respond in Vietnamese.'),
      new HumanMessage(scenarioPrompt),
    ], 'IncidentGen');

    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      return {
        ok: true,
        incident: {
          ...parsed,
          type: incidentType.id,
          typeName: incidentType.name,
          severity: incidentType.severity,
          language: incidentType.sandboxLanguage,
          difficulty,
          createdAt: Date.now(),
          userId,
        },
      };
    }
  } catch (err) {
    logger.warn('[IncidentAgent] LLM generation failed:', err.message);
  }

  // Fallback: tạo incident đơn giản
  return createFallbackIncident(incidentType, difficulty, userId);
}

function createFallbackIncident(type, difficulty, userId) {
  // Dùng Monte Carlo simulation để tạo metrics thực tế (không rập khuôn)
  const simSamples = simulateTrafficPattern({
    durationMinutes: 120,
    baseRPS: difficulty === 'easy' ? 50 : difficulty === 'hard' ? 500 : 200,
    peakRPS: difficulty === 'easy' ? 500 : difficulty === 'hard' ? 10000 : 3000,
    spikeProbability: difficulty === 'easy' ? 0.05 : difficulty === 'hard' ? 0.25 : 0.12,
  });
  const simMetrics = generateMetricsFromSimulation(simSamples);
  const mcMetrics = `${simMetrics.summary}\nTraffic Spikes: ${simMetrics.spikes}\nLoad Average: ${(gaussianRandom(4, 1.5)).toFixed(1)} | Threads: ${Math.floor(gaussianRandom(256, 50))} | Open Connections: ${Math.floor(gaussianRandom(512, 100))}`;

  const fallbackScenarios = {
    memory_leak: {
      title: '🚨 Memory Leak — Service sắp OOM',
      scenario: 'Bạn đang on-call lúc 3AM. Monitoring cảnh báo: Service "user-service" memory usage tăng từ 200MB lên 4GB trong 2 giờ. Container sắp bị OOM kill.',
      logs: `[2026-06-06 02:15:01] INFO  user-service started
[2026-06-06 02:15:02] INFO  Listening on port 8080
[2026-06-06 02:30:00] WARN  Memory usage: 200MB
[2026-06-06 03:00:00] WARN  Memory usage: 800MB
[2026-06-06 03:30:00] WARN  Memory usage: 1.5GB
[2026-06-06 03:45:00] ERROR Memory usage: 2.8GB — approaching limit
[2026-06-06 03:50:00] ERROR Memory usage: 3.5GB — OOM imminent
[2026-06-06 03:55:00] CRITICAL Memory usage: 4.0GB — container killed by OOM
[2026-06-06 03:55:01] INFO  Container restarting...
[2026-06-06 03:55:02] INFO  user-service started
[2026-06-06 03:55:03] WARN  Memory usage: 200MB (cycle repeats)`,
      metrics: `${mcMetrics}\nGC Pauses: ${gaussianRandom(2.3, 0.5).toFixed(1)}s (abnormal) | Heap: ${(gaussianRandom(3.8, 0.3)).toFixed(1)}GB/4.0GB`,
      buggyCode: `#include <iostream>
#include <vector>
#include <string>

struct UserSession {
    std::string userId;
    std::vector<char*> data;
    
    UserSession(const std::string& id) : userId(id) {
        // Simulate loading user data
        for (int i = 0; i < 100; i++) {
            char* buf = new char[1024 * 1024]; // 1MB per allocation
            data.push_back(buf);
        }
    }
    
    // BUG: Missing destructor — memory leak!
    // ~UserSession() should delete[] each char* in data
};

int main() {
    std::vector<UserSession*> sessions;
    
    // Simulate 1000 concurrent users
    for (int i = 0; i < 1000; i++) {
        sessions.push_back(new UserSession("user_" + std::to_string(i)));
    }
    
    // BUG: Only deleting pointers, not the objects
    for (auto s : sessions) {
        delete s;  // This calls destructor, but destructor doesn't free data!
    }
    
    std::cout << "All sessions processed" << std::endl;
    return 0;
}`,
      hiddenRootCause: 'UserSession destructor is missing. Each session allocates 100MB (100 x 1MB) but never frees it. 1000 sessions = 10GB leaked.',
      hiddenHotfix: 'Add destructor: ~UserSession() { for (auto p : data) delete[] p; data.clear(); }',
      hints: [
        'Kiểm tra destructor của struct UserSession — có không?',
        'Mỗi session cấp phát bao nhiêu memory? Có giải phóng không?',
        'Dùng AddressSanitizer để tìm exact leak location.',
      ],
    },
    null_pointer: {
      title: '💥 Segfault — Null Pointer Dereference',
      scenario: 'Service crash loop. Core dump generated. Bạn cần tìm dòng code gây segfault và viết hotfix.',
      logs: `[2026-06-06 03:00:01] INFO  request_handler: processing request #12345
[2026-06-06 03:00:01] ERROR Segmentation fault (core dumped) at 0x00000000
[2026-06-06 03:00:01] INFO  Backtrace: handler.cpp:42 → router.cpp:15 → main.cpp:8
[2026-06-06 03:00:02] INFO  Container restarting...
[2026-06-06 03:00:03] INFO  request_handler: processing request #12346
[2026-06-06 03:00:03] ERROR Segmentation fault (core dumped) at 0x00000000`,
      metrics: `${mcMetrics}\nCrash count: ${Math.floor(gaussianRandom(47, 10))} in 1 hour | Uptime: ${Math.floor(gaussianRandom(30, 10))}s average | Error rate: 100%`,
      buggyCode: `#include <iostream>
#include <string>

struct Request {
    std::string path;
    std::string* body;  // Can be null for GET requests
    
    Request(const std::string& p) : path(p), body(nullptr) {}
};

void handleRequest(Request* req) {
    // BUG: No null check on body
    std::cout << "Processing: " << req->path << std::endl;
    std::cout << "Body length: " << req->body->length() << std::endl;  // CRASH if body is null
}

int main() {
    Request* req = new Request("/api/users");  // GET request, body is null
    handleRequest(req);
    delete req;
    return 0;
}`,
      hiddenRootCause: 'Request::body is nullptr for GET requests, but handleRequest() dereferences it without checking.',
      hiddenHotfix: 'Add null check: if (req->body != nullptr) { /* use body */ } else { /* handle empty body */ }',
      hints: [
        'Dòng nào truy cập pointer mà không check null?',
        'Request GET có body không? Khi nào body = nullptr?',
        'Thêm null check trước khi dereference pointer.',
      ],
    },
  };

  const fallback = fallbackScenarios[type.id] || fallbackScenarios['memory_leak'];

  return {
    ok: true,
    incident: {
      ...fallback,
      type: type.id,
      typeName: type.name,
      severity: type.severity,
      language: type.sandboxLanguage,
      difficulty,
      createdAt: Date.now(),
      userId,
      timeLimit: '15',
    },
  };
}

// ── Evaluate Hotfix ──

/**
 * Chấm điểm hotfix của user.
 * 1. So sánh với hidden root cause
 * 2. Chạy code trong Sandbox
 * 3. Đưa ra điểm và feedback
 */
export async function evaluateHotfix(incident, userHotfix, language = 'cpp') {
  // 1. Chạy code trong Sandbox
  let sandboxResult;
  try {
    sandboxResult = await executeCode({ agent: 'incident_hotfix', code: userHotfix, language });
  } catch (err) {
    sandboxResult = { success: false, error: err.message, stdout: '', stderr: err.message };
  }

  // 2. Dùng LLM chấm điểm
  const evalPrompt = `Bạn là Senior SRE chấm hotfix. Nhiệm vụ: CHẤM ĐIỂM hotfix của on-call engineer.

=== SỰ CỐ ===
${incident.title}
${incident.scenario}

=== ROOT CAUSE (đáp án đúng) ===
${incident.hiddenRootCause}

=== HOTFIX ĐÚNG ===
${incident.hiddenHotfix}

=== HOTFIX CỦA USER ===
\`\`\`${language}
${userHotfix.slice(0, 1500)}
\`\`\`

=== KẾT QUẢ CHẠY THỬ ===
${sandboxResult.success ? `✅ Thành công\nOutput: ${sandboxResult.stdout?.slice(0, 300) || ''}` : `❌ Lỗi\n${sandboxResult.stderr?.slice(0, 300) || sandboxResult.error || ''}`}

Chấm điểm 0-10 dựa trên:
- Có tìm đúng root cause không?
- Hotfix có sửa đúng lỗi không?
- Code có chạy thành công không?
- Có phát hiện thêm vấn đề khác không?

Trả về JSON:
{
  "score": <0-10>,
  "passed": <true nếu >= 6>,
  "feedback": "Nhận xét tiếng Việt",
  "rootCauseCorrect": <boolean>,
  "fixCorrect": <boolean>
}`;

  try {
    const raw = await invokeLlm([
      new HumanMessage('You are a strict Senior SRE. Always respond in Vietnamese.'),
      new HumanMessage(evalPrompt),
    ], 'IncidentEval');

    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      return {
        score: Math.min(10, Math.max(0, parsed.score || 0)),
        passed: parsed.passed !== false && (parsed.score || 0) >= 6,
        feedback: parsed.feedback || 'Không có nhận xét.',
        rootCauseCorrect: parsed.rootCauseCorrect || false,
        fixCorrect: parsed.fixCorrect || false,
        sandboxResult,
      };
    }
  } catch (err) {
    logger.warn('[IncidentAgent] LLM evaluation failed:', err.message);
  }

  // Fallback
  const passed = sandboxResult.success;
  return {
    score: passed ? 7 : 3,
    passed,
    feedback: passed ? '✅ Hotfix chạy thành công!' : '❌ Hotfix chưa sửa được lỗi.',
    rootCauseCorrect: false,
    fixCorrect: passed,
    sandboxResult,
  };
}

// ── Session Management ──

const incidentSessions = new Map();

export function createIncidentSession(userId, incident) {
  const sessionId = `incident:${userId}:${Date.now()}`;
  incidentSessions.set(sessionId, {
    userId,
    incident,
    startTime: Date.now(),
    hintsUsed: 0,
    attempts: 0,
    status: 'active',
  });
  return sessionId;
}

export function getIncidentSession(sessionId) {
  return incidentSessions.get(sessionId);
}

export function updateIncidentSession(sessionId, updates) {
  const s = incidentSessions.get(sessionId);
  if (s) Object.assign(s, updates);
  return s;
}
