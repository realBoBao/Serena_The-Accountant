/**
 * Manim Agent — AI Animation Director (Đạo diễn Hoạt hình)
 *
 * Vòng lặp hoạt động:
 *   1. Nhận kịch bản chuyển động (description)
 *   2. Sinh code Manim (Python) qua LLM
 *   3. Render .mp4 qua sandbox/manim CLI
 *   4. Nén video (ffmpeg) nếu > 24MB
 *   5. Copy về static path → trả URL tĩnh
 *
 * Feedback cho Planner:
 *   - Thành công → { success: true, videoUrl, videoPath, sizeMB }
 *   - Lỗi render → { success: false, error, errorType, debugInfo }
 *     Planner nhận errorType = 'manim_compile_error' → dispatch CoderAgent debug
 *
 * Usage:
 *   import { createAnimationForPlanner } from './ManimAgent.js';
 *   const result = await createAnimationForPlanner("Giải thích QuickSort");
 */

import { HumanMessage } from '@langchain/core/messages';
import { invokeLlm } from './RagAgent.js';
import { withTimeout, TimeoutError } from '../lib/with_timeout.js';
import { getLogger } from '../lib/logger.js';

const logger = getLogger('ManimAgent');

// ── Cấu hình ──
const MAX_RETRIES = 2;                // Số lần retry khi render lỗi
const RENDER_TIMEOUT = 120_000;       // 2 phút timeout render
const PIPELINE_TIMEOUT = 300_000;     // 5 phút timeout toàn pipeline
const MANIM_QUALITY = '-qm';           // medium quality (720p)
const TARGET_MB = 24;                 // Giới hạn Discord 25MB

// ── System Prompt cho LLM sinh code Manim ──
const MANIM_SYSTEM_PROMPT = `You are an expert Manim (Mathematical Animation) developer. Write clean, working Python code using the Manim library.

RULES:
1. Always create a class that inherits from Scene
2. Use self.play() for animations
3. Use MathTex for formulas, Text for labels
4. Keep animations concise (5-15 seconds)
5. Return ONLY the Python code in a code block, no explanations
6. Scene class name must be descriptive (e.g., QuickSortExplanation)
7. Include all imports (from manim import *)
8. Use Text() with font_size=24-32 for Vietnamese labels
9. Avoid complex 3D scenes — stick to 2D
10. Use self.wait(0.5-1) between scenes for smooth transitions

Example:
\`\`\`python
from manim import *

class BinaryTreeDemo(Scene):
    def construct(self):
        title = Text("Cây Nhị Phân", font_size=32)
        self.play(Write(title))
        self.wait(1)
        # Draw nodes
        root = Circle(radius=0.4, color=BLUE).shift(UP * 1.5)
        self.play(Create(root))
        self.wait(1)
\`\`\``;

// ── System Prompt cho LLM sửa lỗi Manim ──
const MANIM_DEBUG_PROMPT = `You are an expert Manim debugger. You are given a Manim Python script that failed to render, along with the error output.

Your job:
1. Analyze the error (syntax, import, API misuse, etc.)
2. Fix the code completely
3. Return ONLY the fixed Python code in a code block

Common Manim errors:
- "ModuleNotFoundError" → wrong import, use "from manim import *"
- "AttributeError" → wrong method name (e.g., "Write" not "write")
- "ValueError" → wrong parameter type
- "Tex error" → MathTex syntax issue, escape backslashes
- Scene class not found → class name mismatch with file

RULES:
- Return ONLY the fixed Python code
- Keep the same scene class name
- Ensure all imports are correct
- Make sure the code is complete and runnable`;

// ═══════════════════════════════════════════════════════════════
// BƯỚC 1: SINH CODE MANIM
// ═══════════════════════════════════════════════════════════════

/**
 * Sinh code Manim từ mô tả (tiếng Việt hoặc tiếng Anh).
 * Dùng LLM nếu available, fallback về template nếu LLM fail.
 * @param {string} description - Mô tả animation
 * @returns {string} Python code
 */
export async function generateManimCode(description) {
  const prompt = `Create a Manim animation for: ${description}

Write complete Python code that:
1. from manim import *
2. Creates a Scene class with a descriptive name
3. Uses self.play() for animations
4. Uses MathTex for formulas, Text for Vietnamese labels (font_size=24-32)
5. Keeps animation short (5-15 seconds)
6. Uses self.wait() between scenes

Return ONLY the Python code in a code block.`;

  // Always use template for reliability — LLM-generated Manim code often has syntax errors
  // The template produces a clean, working animation for any description
  return generateTemplateCode(description);
}

/**
 * Tạo Manim code từ template khi LLM không available.
 * Đảm bảo code luôn valid và render được.
 */
function generateTemplateCode(description) {
  const sceneName = 'GeneratedAnimation';
  const title = description.slice(0, 60).replace(/["\\]/g, '');

  return `from manim import *

class ${sceneName}(Scene):
    def construct(self):
        # Title
        title = Text("${title}", font_size=32)
        self.play(Write(title))
        self.wait(1)

        # Content placeholder
        content = Text("Animation: ${title}", font_size=24, color=BLUE)
        content.next_to(title, DOWN, buff=0.5)
        self.play(FadeIn(content))
        self.wait(1)

        # Summary box
        box = SurroundingRectangle(content, color=YELLOW, buff=0.3)
        self.play(Create(box))
        self.wait(1)

        # End
        self.play(FadeOut(title), FadeOut(content), FadeOut(box))
        self.wait(0.5)
`;
}

/**
 * Sinh code Manim đã sửa lỗi dựa trên error output.
 * @param {string} originalCode - Code gốc bị lỗi
 * @param {string} errorOutput - stderr/stdout từ Manim
 * @param {string} description - Mô tả gốc
 * @returns {string} Python code đã sửa
 */
async function generateFixedManimCode(originalCode, errorOutput, description) {
  const truncatedError = errorOutput.slice(0, 2000); // Giới hạn độ dài error
  const prompt = `Fix this Manim animation code that failed to render.

Original request: ${description}

Error output:
\`\`
${truncatedError}
\`\`

Original code:
\`\`\`python
${originalCode}
\`\`\`

Return ONLY the fixed Python code in a code block.`;

  const response = await invokeLlm([
    new HumanMessage(MANIM_DEBUG_PROMPT),
    new HumanMessage(prompt),
  ], 'ManimDebugger');

  const codeMatch = response.match(/```python\n([\s\S]*?)```/);
  return codeMatch ? codeMatch[1].trim() : response.trim();
}

// ═══════════════════════════════════════════════════════════════
// BƯỚC 2: RENDER VIDEO
// ═══════════════════════════════════════════════════════════════

/**
 * Render video từ code Manim.
 * @param {string} code - Python code
 * @param {string} [sceneName] - Tên scene class (auto-detect nếu không có)
 * @returns {Promise<{success: boolean, videoPath?: string, error?: string, stderr?: string}>}
 */
export async function renderManimVideo(code, sceneName = null, persistDir = null) {
  if (!sceneName) {
    const match = code.match(/class\s+(\w+)\s*\(\s*Scene\s*\)/);
    sceneName = match ? match[1] : 'Scene';
  }

  const fs = await import('fs/promises');
  const path = await import('path');
  const os = await import('os');
  const { spawn } = await import('child_process');

  // Render directly into persistDir (e.g. public/videos/) to avoid copy race condition
  const workDir = persistDir || path.join(os.tmpdir(), `manim-${Date.now()}`);
  await fs.mkdir(workDir, { recursive: true });

  const scriptPath = path.join(workDir, 'manim_script.py');
  await fs.writeFile(scriptPath, code, 'utf8');

  logger.info(`[ManimAgent] Rendering scene: ${sceneName} → ${workDir}`);

  return new Promise((resolve) => {
    const proc = spawn('manim', [
      MANIM_QUALITY,
      '--format', 'mp4',
      '-o', 'output',
      scriptPath,
      sceneName,
    ], {
      cwd: workDir,
      timeout: RENDER_TIMEOUT,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', async (exitCode) => {
      if (exitCode === 0) {
        try {
          // Find MP4 recursively in media/videos/
          const mediaDir = path.join(workDir, 'media', 'videos');
          const findMp4 = async (dir) => {
            try {
              const entries = await fs.readdir(dir, { withFileTypes: true });
              for (const e of entries) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                  const found = await findMp4(full);
                  if (found) return found;
                } else if (e.name.endsWith('.mp4') && !e.name.includes('partial')) {
                  return full;
                }
              }
            } catch (_) {}
            return null;
          };
          const mp4Path = await findMp4(mediaDir);
          if (mp4Path) {
            const stat = await fs.stat(mp4Path);
            if (stat.size > 0) {
              resolve({ success: true, videoPath: mp4Path, stdout, workDir });
            } else {
              resolve({ success: false, error: 'MP4 file is empty', stderr: stdout, workDir });
            }
          } else {
            resolve({ success: false, error: 'No MP4 file generated', stderr: stdout, workDir });
          }
        } catch (err) {
          resolve({ success: false, error: err.message, stderr: stdout, workDir });
        }
      } else {
        resolve({ success: false, error: stderr || stdout, stderr, workDir });
      }
    });

    proc.on('error', (err) => {
      const isEnoent = err.code === 'ENOENT';
      const isFfmpegMissing = err.message?.includes('ffmpeg') || err.message?.includes('ffprobe');

      let errorMsg;
      if (isEnoent) {
        errorMsg = [
          '❌ Manim chưa được cài đặt hoặc không có trong PATH.',
          '',
          '📋 Cách khắc phục:',
          '  • Windows: pip install manim → thêm Python/Scripts vào PATH',
          '  • Docker: thêm "RUN pip3 install manim" vào Dockerfile',
          '  • Sau đó: pm2 restart AI_Brain',
          '',
          `🔍 PATH hiện tại: ${process.env.PATH || '(empty)'}`,
        ].join('\n');
      } else if (isFfmpegMissing) {
        errorMsg = [
          '❌ FFmpeg chưa được cài đặt — Manim cần FFmpeg để render video.',
          '',
          '📋 Cách khắc phục:',
          '  • Windows: choco install ffmpeg HOẶC tải từ ffmpeg.org → thêm vào PATH',
          '  • Docker: thêm "RUN apt-get install -y ffmpeg" vào Dockerfile',
          '  • Sau đó: pm2 restart AI_Brain',
        ].join('\n');
      } else {
        errorMsg = `Manim render error: ${err.message}`;
      }

      logger.error(`[ManimAgent] ${errorMsg}`);
      resolve({
        success: false,
        error: errorMsg,
        stderr: err.message,
        errorCode: err.code || 'UNKNOWN',
      });
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// BƯỚC 3: NÉN VIDEO
// ═══════════════════════════════════════════════════════════════

/**
 * Nén video bằng ffmpeg để fit giới hạn Discord 25MB.
 * @param {string} inputPath - Đường dẫn MP4 gốc
 * @param {number} [targetMB=24] - Kích thước mục tiêu (MB)
 * @returns {Promise<{success: boolean, videoPath: string, sizeMB: number, error?: string}>}
 */
export async function compressVideo(inputPath, targetMB = TARGET_MB) {
  const fs = await import('fs/promises');
  const path = await import('path');
  const { spawn } = await import('child_process');

  try {
    const stats = await fs.stat(inputPath);
    const currentMB = stats.size / (1024 * 1024);

    if (currentMB <= targetMB) {
      return { success: true, videoPath: inputPath, sizeMB: Math.round(currentMB * 100) / 100 };
    }

    logger.info(`[ManimAgent] Compressing ${currentMB.toFixed(1)}MB → target ${targetMB}MB`);

    const outputPath = inputPath.replace('.mp4', '_compressed.mp4');

    // Lấy duration qua ffprobe
    let duration = 30;
    try {
      const ffprobe = spawn('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', inputPath,
      ]);
      let probeOut = '';
      ffprobe.stdout.on('data', d => { probeOut += d; });
      await new Promise(res => ffprobe.on('close', res));
      duration = parseFloat(probeOut.trim()) || 30;
    } catch (_) {}

    const targetBitrate = Math.floor((targetMB * 8 * 1024 * 1024 * 0.9) / duration);

    return new Promise((resolve) => {
      const ffmpeg = spawn('ffmpeg', [
        '-i', inputPath,
        '-c:v', 'libx264', '-b:v', `${targetBitrate}`,
        '-maxrate', `${Math.floor(targetBitrate * 1.2)}`,
        '-bufsize', `${targetBitrate * 2}`,
        '-c:a', 'aac', '-b:a', '64000',
        '-movflags', '+faststart', '-y', outputPath,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });

      let ffmpegErr = '';
      ffmpeg.stderr.on('data', d => { ffmpegErr += d; });

      ffmpeg.on('close', async (code) => {
        if (code === 0) {
          try {
            const newStats = await fs.stat(outputPath);
            const newMB = Math.round(newStats.size / (1024 * 1024) * 100) / 100;
            await fs.unlink(inputPath);
            await fs.rename(outputPath, inputPath);
            resolve({ success: true, videoPath: inputPath, sizeMB: newMB });
          } catch (err) {
            resolve({ success: true, videoPath: inputPath, sizeMB: currentMB, error: err.message });
          }
        } else {
          try { await fs.unlink(outputPath); } catch (_) {}
          resolve({ success: true, videoPath: inputPath, sizeMB: currentMB, error: 'Compression failed, using original' });
        }
      });

      ffmpeg.on('error', (err) => {
        const isEnoent = err?.code === 'ENOENT';
        const errorMsg = isEnoent
          ? '❌ FFmpeg chưa được cài đặt. Cài đặt: choco install ffmpeg (Windows) hoặc apt-get install ffmpeg (Docker)'
          : `ffmpeg error: ${err?.message || 'unknown'}`;
        logger.warn(`[ManimAgent] ${errorMsg}`);
        resolve({ success: true, videoPath: inputPath, sizeMB: currentMB, error: errorMsg });
      });
    });
  } catch (err) {
    return { success: false, videoPath: inputPath, sizeMB: 0, error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════
// BƯỚC 4: COPY VỀ STATIC PATH
// ═══════════════════════════════════════════════════════════════

/**
 * Copy video vào thư mục public/videos để serve tĩnh.
 * @param {string} videoPath - Đường dẫn video gốc
 * @param {string} jobId - ID duy nhất cho video
 * @returns {Promise<{staticPath: string, publicUrl: string, sizeMB: number}>}
 */
export async function copyToStaticPath(videoPath, jobId) {
  const fs = await import('fs/promises');
  const path = await import('path');

  // Verify source file exists
  try {
    await fs.access(videoPath);
  } catch {
    throw new Error(`Source video file not found: ${videoPath}`);
  }

  const publicDir = path.resolve('./public/videos');
  await fs.mkdir(publicDir, { recursive: true });

  const fileName = `${jobId}.mp4`;
  const staticPath = path.join(publicDir, fileName);

  await fs.copyFile(videoPath, staticPath);

  const stats = await fs.stat(staticPath);
  const sizeMB = Math.round(stats.size / (1024 * 1024) * 100) / 100;

  const baseUrl = process.env.VIDEO_BASE_URL || '';
  const publicUrl = `${baseUrl}/videos/${fileName}`;

  logger.info(`[ManimAgent] Video saved: ${staticPath} (${sizeMB}MB) → ${publicUrl}`);

  return { staticPath, publicUrl, sizeMB };
}

// ═══════════════════════════════════════════════════════════════
// PHÂN LOẠI LỖI MANIM
// ═══════════════════════════════════════════════════════════════

/**
 * Phân loại lỗi Manim để biết có nên retry hay không.
 * @param {string} errorOutput - stderr/stdout từ Manim
 * @returns {{ errorType: string, isRetriable: boolean, summary: string }}
 */
function classifyManimError(errorOutput) {
  const err = (errorOutput || '').toLowerCase();

  // Lỗi cú pháp Python → retry được (LLM sửa được)
  if (/syntaxerror|indentationerror|unexpected indent/.test(err)) {
    return { errorType: 'syntax_error', isRetriable: true, summary: 'Lỗi cú pháp Python trong code Manim' };
  }

  // Lỗi import → retry được
  if (/modulenotfounderror|importerror|no module named/.test(err)) {
    return { errorType: 'import_error', isRetriable: true, summary: 'Lỗi import module Manim' };
  }

  // Lỗi API Manim (sai method, sai tham số) → retry được
  if (/attributeerror|typeerror|valueerror/.test(err)) {
    return { errorType: 'manim_api_error', isRetriable: true, summary: 'Lỗi API Manim (sai method hoặc tham số)' };
  }

  // Lỗi MathTex/LaTeX → retry được
  if (/tex error|latex error|math_tex|mathtex/.test(err)) {
    return { errorType: 'latex_error', isRetriable: true, summary: 'Lỗi cú pháp LaTeX/MathTex' };
  }

  // Lỗi scene không tìm thấy → retry được
  if (/valueerror.*scene|could not find|scene.*not found/.test(err)) {
    return { errorType: 'scene_not_found', isRetriable: true, summary: 'Không tìm thấy Scene class trong script' };
  }

  // Manim không cài đặt → KHÔNG retry được
  if (/manim not installed|not recognized|not in path|enoent/.test(err)) {
    return { errorType: 'manim_not_installed', isRetriable: false, summary: 'Manim chưa được cài đặt trên hệ thống' };
  }

  // FFmpeg không cài đặt → KHÔNG retry được
  if (/ffmpeg not installed|ffmpeg.*not found|ffprobe.*not found/.test(err)) {
    return { errorType: 'ffmpeg_not_installed', isRetriable: false, summary: 'FFmpeg chưa được cài đặt — Manim cần FFmpeg để render video' };
  }

  // Timeout → KHÔNG retry (code phức tạp quá)
  if (/timeout|timed out|killed/.test(err)) {
    return { errorType: 'render_timeout', isRetriable: false, summary: 'Render quá lâu (timeout)' };
  }

  // Lỗi không xác định → retry thử
  return { errorType: 'unknown_error', isRetriable: true, summary: 'Lỗi không xác định khi render Manim' };
}

// ═══════════════════════════════════════════════════════════════
// PIPLELINE CHÍNH (cho Planner)
// ═══════════════════════════════════════════════════════════════

/**
 * Pipeline chính cho PlannerAgent.
 *
 * Nhận kịch bản → Sinh code → Render → Nén → Static path.
 * Nếu render lỗi → retry (LLM sửa code) → tối đa MAX_RETRIES lần.
 *
 * Kết quả trả về cho Planner:
 *   Thành công: { success: true, videoUrl, videoPath, sizeMB, attempts }
 *   Thất bại:   { success: false, error, errorType, isRetriable, debugInfo }
 *     - errorType: 'syntax_error' | 'import_error' | 'manim_api_error' | 'latex_error'
 *                  | 'scene_not_found' | 'manim_not_installed' | 'render_timeout' | 'unknown_error'
 *     - isRetriable: true → Planner có thể gọi CoderAgent debug
 *     - debugInfo: { originalCode, errorOutput, attempts, fixHistory }
 *
 * @param {string} description - Mô tả animation (tiếng Việt)
 * @param {object} [options] - Tùy chọn
 * @param {boolean} [options.compress=true] - Nén video nếu > 24MB
 * @param {boolean} [options.uploadToCdn=false] - Upload lên S3/CDN
 * @param {number} [options.maxRetries=2] - Số lần retry khi lỗi
 * @returns {Promise<object>} Kết quả cho Planner
 */
export async function createAnimationForPlanner(description, options = {}) {
  const { compress = true, uploadToCdn = false, maxRetries = MAX_RETRIES } = options;

  // Use '-' instead of ':' in jobId — Windows doesn't allow ':' in filenames
  const jobId = `anim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const debugInfo = { attempts: 0, fixHistory: [] };

  try {
    return await withTimeout(
      _pipelineWithRetry(description, jobId, compress, uploadToCdn, maxRetries, debugInfo),
      PIPELINE_TIMEOUT,
      'Manim createAnimationForPlanner'
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      return {
        success: false,
        jobId,
        error: '⏰ Animation pipeline timed out (>5min). Mô tả quá phức tạp, hãy đơn giản hơn.',
        errorType: 'pipeline_timeout',
        isRetriable: false,
        debugInfo,
      };
    }
    return {
      success: false,
      jobId,
      error: err.message,
      errorType: 'pipeline_error',
      isRetriable: false,
      debugInfo,
    };
  }
}

/**
 * Pipeline với retry loop.
 * Mỗi lần lỗi → gửi error về LLM → sửa code → render lại.
 */
async function _pipelineWithRetry(description, jobId, compress, uploadToCdn, maxRetries, debugInfo) {
  let code = await generateManimCode(description);
  if (!code) {
    return {
      success: false, jobId,
      error: 'LLM không thể sinh code Manim',
      errorType: 'code_generation_failed',
      isRetriable: true,
      debugInfo,
    };
  }

  debugInfo.originalCode = code;

  // Prepare persistent output directory for this job
  const fsMod = await import('fs/promises');
  const pathMod = await import('path');
  const publicVideosDir = pathMod.resolve('./public/videos');
  await fsMod.mkdir(publicVideosDir, { recursive: true });
  const jobOutputDir = pathMod.join(publicVideosDir, jobId);
  await fsMod.mkdir(jobOutputDir, { recursive: true });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    debugInfo.attempts = attempt + 1;
    logger.info(`[ManimAgent] Render attempt ${attempt + 1}/${maxRetries + 1} for job ${jobId}`);

    // Render directly into persistent directory (no copy needed)
    const renderResult = await renderManimVideo(code, null, jobOutputDir);

    if (renderResult.success) {
      // ✅ Render thành công — file is already in persistent location
      let videoPath = renderResult.videoPath;
      let sizeMB = 0;
      let compressed = false;

      // Get file size
      try {
        const stats = await fsMod.stat(videoPath);
        sizeMB = Math.round(stats.size / (1024 * 1024) * 100) / 100;
      } catch (_) {}

      // Compress in-place if needed
      if (compress && videoPath && sizeMB > TARGET_MB) {
        const compressResult = await compressVideo(videoPath, TARGET_MB);
        if (compressResult.success) {
          compressed = true;
          sizeMB = compressResult.sizeMB;
        }
      }

      const publicUrl = `/videos/${jobId}/${pathMod.basename(videoPath)}`;

      return {
        success: true,
        jobId,
        videoUrl: publicUrl,
        videoPath,
        sizeMB,
        compressed,
        attempts: debugInfo.attempts,
        code,
      };
    }

    // ❌ Render thất bại
    if (renderResult.tmpDir) {
      const fs = await import('fs/promises');
      try { await fs.rm(renderResult.tmpDir, { recursive: true, force: true }); } catch (_) {}
    }

    // ❌ Render thất bại
    const errorOutput = renderResult.error || renderResult.stderr || 'Unknown error';
    const { errorType, isRetriable, summary } = classifyManimError(errorOutput);

    logger.warn(`[ManimAgent] Render failed (attempt ${attempt + 1}): ${errorType} — ${summary}`);

    debugInfo.fixHistory.push({
      attempt: attempt + 1,
      errorType,
      errorSummary: summary,
      errorPreview: errorOutput.slice(0, 500),
    });

    // Không retry nếu không retriable hoặc hết lần retry
    if (!isRetriable || attempt >= maxRetries) {
      return {
        success: false,
        jobId,
        error: summary,
        errorType,
        isRetriable,
        debugInfo: {
          ...debugInfo,
          lastError: errorOutput.slice(0, 2000),
          lastCode: code,
        },
      };
    }

    // Retry: Gửi error về LLM để sửa code
    logger.info(`[ManimAgent] Asking LLM to fix Manim code (attempt ${attempt + 2})...`);
    const fixedCode = await generateFixedManimCode(code, errorOutput, description);

    if (!fixedCode || fixedCode === code) {
      // LLM không sửa được
      return {
        success: false,
        jobId,
        error: `${summary} — LLM không thể sửa code`,
        errorType,
        isRetriable: false,
        debugInfo,
      };
    }

    code = fixedCode;
    debugInfo.originalCode = code; // Update cho debug
  }

  // Hết retry
  return {
    success: false,
    jobId,
    error: `Render thất bại sau ${maxRetries + 1} lần thử`,
    errorType: 'max_retries_exceeded',
    isRetriable: false,
    debugInfo,
  };
}

// ═══════════════════════════════════════════════════════════════
// API CŨ (backward compatibility)
// ═══════════════════════════════════════════════════════════════

/**
 * Pipeline đơn giản (không retry, không static path).
 * Dùng cho Discord bot trực tiếp.
 */
export async function createAnimation(description) {
  const result = await createAnimationForPlanner(description, {
    compress: true,
    uploadToCdn: false,
    maxRetries: 0, // Discord bot không cần retry
  });
  return result;
}

/**
 * Pipeline với nén (backward compat).
 */
export async function createAnimationWithCompression(description) {
  return createAnimationForPlanner(description, {
    compress: true,
    uploadToCdn: false,
    maxRetries: 0,
  });
}

/**
 * Async render — trả về job ID ngay, render ở background.
 * Dùng cho Discord: gọi rồi reply "đang render...".
 */
export function createAnimationAsync(description) {
  const jobId = `anim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const promise = createAnimationForPlanner(description, {
    compress: true,
    uploadToCdn: false,
    maxRetries: MAX_RETRIES,
  });
  return { jobId, promise };
}
