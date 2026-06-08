/**
 * ═══════════════════════════════════════════════════════
 * Vision Agent — Chuyên gia Phân tích Ảnh & OCR
 * ═══════════════════════════════════════════════════════
 *
 * Vai trò: Đọc hiểu UI/UX, sơ đồ hệ thống, chụp lỗi màn hình
 *          (Blue Screen, Terminal error), bài giảng, sơ đồ kỹ thuật.
 *
 * Công cụ: Gemini Vision API (gemini-2.0-flash)
 *          - Nhận dạng ký tự (OCR) → cấu trúc lại thành Markdown
 *          - Phân tích lỗi code/hệ thống → đề xuất fix
 *          - Đọc sơ đồ/bài giảng → tóm tắt có cấu trúc
 *
 * Workflow:
 * 1. Validate image (size, type)
 * 2. Download từ Discord attachment URL
 * 3. Gọi Gemini Vision API với retry + timeout
 * 4. Trả về phân tích có cấu trúc Markdown
 *
 * Discord: !vision <mô tả thêm> (kèm ảnh attachment)
 *
 * @author Serena_Project00
 * @since Phase 14
 */

import 'dotenv/config';
import { getLogger } from '../lib/logger.js';
import { preprocessImage } from '../lib/media_preprocessor.js';

// ── Logger ──
const logger = getLogger('VisionAgent');

// ── Configuration ──
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.Gemini_API_KEY || '';
const GEMINI_VISION_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-2.0-flash-lite';
const VISION_API_TIMEOUT = Number(process.env.VISION_API_TIMEOUT || 30000); // 30s
const VISION_MAX_RETRIES = 2;
const VISION_RETRY_DELAY_MS = 2000;
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB limit
const SUPPORTED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/bmp',
]);

// ── System Prompt cho Vision ──
const VISION_SYSTEM_PROMPT = `Bạn là **Vision Analyst** — chuyên gia phân tích hình ảnh kỹ thuật.

## Nhiệm vụ
Phân tích hình ảnh một cách chi tiết, có cấu trúc. Tùy loại ảnh:

### Nếu là ảnh chụp lỗi (Error Screenshot / Blue Screen / Terminal Error):
1. **Loại lỗi**: Xác định chính xác loại lỗi (runtime, compile, network, permission, v.v.)
2. **Nguyên nhân gốc rễ**: Phân tích tại sao lỗi xảy ra
3. **Cách fix**: Hướng dẫn sửa chi tiết, bao gồm code fix nếu có
4. **OCR text**: Trích xuất TOÀN BỘ text lỗi từ ảnh (nếu có)
5. **Gợi ý**: Từ khóa tìm kiếm thêm hoặc docs liên quan

### Nếu là sơ đồ hệ thống / kiến trúc (System Diagram / Architecture):
1. **Tổng quan**: Mô tả kiến trúc tổng thể
2. **Các thành phần**: Liệt kê modules/services/nodes
3. **Luồng dữ liệu**: Mô tả data flow giữa các thành phần
4. **Điểm chú ý**: Bottleneck, single point of failure, v.v.
5. **OCR text**: Trích xuất tất cả labels, annotations từ sơ đồ

### Nếu là bài giảng / slide (Lecture / Slide):
1. **Chủ đề chính**: Tóm tắt chủ đề
2. **Các khái niệm quan trọng**: Liệt kê và giải thích ngắn gọn
3. **Công thức / Code**: Trích xuất chính xác (dùng code block)
4. **OCR text**: Trích xuất toàn bộ text từ slide
5. **Liên hệ**: Kết nối với kiến thức liên quan

### Nếu là giao diện UI/UX:
1. **Loại giao diện**: Web app, mobile, desktop, v.v.
2. **Thành phần UI**: Liệt kê các elements (buttons, forms, nav, v.v.)
3. **Đánh giá UX**: Nhận xét về trải nghiệm người dùng
4. **OCR text**: Trích xuất toàn bộ text hiển thị trên UI

## Quy tắc output:
- Luôn trả lời bằng **tiếng Việt** (trừ thuật ngữ kỹ thuật)
- Dùng **Markdown** có cấu trúc (headers, bullet points, code blocks)
- Phần OCR text phải trong code block để giữ nguyên format
- Ngắn gọn nhưng đầy đủ — không lan man
- Nếu ảnh không rõ hoặc không thể phân tích → nói thẳng`;

// ── Planner-Optimized Prompt ──
// Prompt này tối ưu để trả về text cấu trúc ngắn gọn cho PlannerAgent
// thay vì Markdown dài dòng cho user.
const PLANNER_VISION_PROMPT = `Bạn là **Vision Analyst** — chuyên gia phân tích hình ảnh kỹ thuật.

Nhiệm vụ: Phân tích ảnh và trả về MÔ TẢ TEXT CẤU TRÚC cho PlannerAgent sử dụng.

## Quy tắc output (NGHIÊM NGẶT):
- Trả về text thuần, KHÔNG markdown headers, KHÔNG bullet points
- Mô tả trong 2-5 câu, mỗi câu một thông tin quan trọng
- Câu đầu: Loại ảnh + nội dung chính
- Câu sau: Chi tiết kỹ thuật quan trọng (cấu trúc, trạng thái, vấn đề)
- Nếu có lỗi: mô tả lỗi + nguyên nhân + cách fix trong 1-2 câu
- Nếu là sơ đồ: mô tả cấu trúc + các thành phần + mối quan hệ
- Cuối cùng: thêm dòng "OCR_TEXT: <toàn bộ text trích xuất được>" nếu có text trong ảnh

## Ví dụ output:
"Đây là ảnh chụp màn hình lỗi runtime Python. Chương trình bị TypeError tại dòng 42 do truyền None vào hàm expect string. Cách fix: thêm null check trước khi gọi hàm. OCR_TEXT: TypeError: expected str, got NoneType at line 42"

"Đây là sơ đồ một cây nhị phân bị mất cân bằng tại node gốc. Cây có 7 nodes, chiều cao 4, node gốc có con trái sâu 3 mà con phải sâu 1. Cần rotation để cân bằng. OCR_TEXT: root(50) left(30) right(70)"`;

// ── Validation ──

/**
 * Validate image trước khi xử lý
 * @param {string} mimeType
 * @param {number} sizeBytes
 * @returns {{ ok: boolean, error?: string }}
 */
function validateImage(mimeType, sizeBytes) {
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    return {
      ok: false,
      error: `Định dạng ảnh không hỗ trợ: ${mimeType || 'unknown'}. Hỗ trợ: ${[...SUPPORTED_MIME_TYPES].join(', ')}`,
    };
  }
  if (sizeBytes > MAX_IMAGE_SIZE_BYTES) {
    return {
      ok: false,
      error: `Ảnh quá lớn: ${(sizeBytes / 1024 / 1024).toFixed(1)}MB. Tối đa: ${MAX_IMAGE_SIZE_BYTES / 1024 / 1024}MB`,
    };
  }
  return { ok: true };
}

// ── Retry Helper ──

/**
 * Retry wrapper với exponential backoff
 */
async function withRetry(fn, { maxRetries = VISION_MAX_RETRIES, delayMs = VISION_RETRY_DELAY_MS, label = 'operation' } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const waitMs = delayMs * Math.pow(2, attempt);
        logger.warn(`[${label}] Attempt ${attempt + 1} failed, retrying in ${waitMs}ms: ${err.message}`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  }
  throw lastError;
}

// ── Core: Gọi Gemini Vision API ──

/**
 * Phân tích ảnh bằng Gemini Vision API
 *
 * @param {Buffer} imageBuffer - Raw image bytes
 * @param {string} mimeType - MIME type (image/png, image/jpeg, ...)
 * @param {string} [userPrompt=''] - Prompt bổ sung từ user
 * @returns {Promise<string>} Phân tích có cấu trúc Markdown
 * @throws {Error} Nếu API key thiếu hoặc API call fail
 */
export async function analyzeImage(imageBuffer, mimeType, userPrompt = '') {
  if (!GEMINI_API_KEY) {
    throw new Error('GOOGLE_API_KEY / Gemini_API_KEY chưa được set trong .env. Không thể dùng Vision API.');
  }

  // Validate
  const validation = validateImage(mimeType, imageBuffer.length);
  if (!validation.ok) {
    throw new Error(validation.error);
  }

  // ── Pre-process: Resize + Compress để giảm token cost ──
  const preprocessed = await preprocessImage(imageBuffer, { maxDim: 1024, quality: 80 });
  const finalBuffer = preprocessed.buffer;
  logger.info(`[analyzeImage] Image preprocessed: ${(preprocessed.originalSize / 1024).toFixed(0)}KB → ${(preprocessed.compressedSize / 1024).toFixed(0)}KB (${preprocessed.ratio}%)`);

  const base64Image = finalBuffer.toString('base64');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent`;

  const fullPrompt = userPrompt
    ? `${VISION_SYSTEM_PROMPT}\n\n## Yêu cầu cụ thể từ người dùng:\n${userPrompt}`
    : VISION_SYSTEM_PROMPT;

  const body = {
    contents: [{
      parts: [
        { text: fullPrompt },
        {
          inline_data: {
            mime_type: mimeType || 'image/png',
            data: base64Image,
          },
        },
      ],
    }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 4096,
    },
  };

  return withRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VISION_API_TIMEOUT);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        // 429 = rate limit → retry, 400 = bad request → don't retry
        if (res.status === 429) {
          throw new Error(`Rate limit (429): ${errText.slice(0, 200)}`);
        }
        if (res.status === 400) {
          throw new Object.assign(new Error(`Bad request (400): ${errText.slice(0, 200)}`), { noRetry: true });
        }
        throw new Error(`Gemini Vision API error ${res.status}: ${errText.slice(0, 200)}`);
      }

      const data = await res.json();

      // Check for safety blocks
      if (data?.promptFeedback?.blockReason) {
        throw new Error(`Ảnh bị chặn bởi safety filter: ${data.promptFeedback.blockReason}`);
      }

      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

      if (!text) {
        logger.warn('[analyzeImage] Empty response from Gemini Vision');
        return '⚠️ Không nhận được phân tích từ Vision API. Thử lại với ảnh rõ hơn.';
      }

      logger.info(`[analyzeImage] Success — ${text.length} chars output`);
      return text.trim();
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        throw new Error(`Timeout sau ${VISION_API_TIMEOUT / 1000}s. Ảnh có thể quá lớn hoặc API chậm.`);
      }
      throw err;
    }
  }, { label: 'GeminiVision' });
}

// ── Download Helper ──

/**
 * Download image từ URL về buffer (không cần lưu file)
 * @param {string} url
 * @returns {Promise<{ buffer: Buffer, mimeType: string, size: number }>}
 */
async function downloadImageToBuffer(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000); // 15s download timeout

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`Download thất bại: HTTP ${res.status}`);
    }

    const contentType = res.headers.get('content-type') || 'image/png';
    const contentLength = parseInt(res.headers.get('content-length') || '0', 10);

    if (contentLength > MAX_IMAGE_SIZE_BYTES) {
      throw new Error(`Ảnh quá lớn: ${(contentLength / 1024 / 1024).toFixed(1)}MB`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return {
      buffer,
      mimeType: contentType,
      size: buffer.length,
    };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error('Download ảnh timeout (>15s). Kiểm tra kết nối mạng.');
    }
    throw err;
  }
}

// ── Discord Message Processor ──

/**
 * Xử lý message Discord có ảnh đính kèm
 * Hàm chính được gọi từ discord_bot.js
 *
 * @param {import('discord.js').Message} message
 * @returns {Promise<{ success: boolean, results: Array<{ fileName: string, analysis?: string, error?: string }>, error?: string }>}
 */
export async function processVisionMessage(message) {
  const attachments = message.attachments.filter(att =>
    att.contentType?.startsWith('image/')
  );

  if (attachments.size === 0) {
    logger.info('[processVisionMessage] No image attachments found');
    return {
      success: false,
      error: 'Không tìm thấy ảnh đính kèm. Hãy gửi ảnh cùng lệnh `!vision`.',
    };
  }

  const results = [];
  const userPrompt = message.content.replace(/^!vision\s*/i, '').trim();

  logger.info(`[processVisionMessage] Processing ${attachments.size} image(s), prompt: "${userPrompt.slice(0, 50)}"`);

  for (const [, attachment] of attachments) {
    const fileName = attachment.name || 'unknown';
    try {
      // Download trực tiếp vào buffer (không cần file temp)
      const { buffer, mimeType, size } = await downloadImageToBuffer(attachment.url);

      logger.info(`[processVisionMessage] Downloaded "${fileName}" (${(size / 1024).toFixed(0)}KB, ${mimeType})`);

      // Phân tích
      const analysis = await analyzeImage(buffer, mimeType, userPrompt);

      results.push({ fileName, analysis });
      logger.info(`[processVisionMessage] Analyzed "${fileName}" — ${analysis.length} chars`);
    } catch (err) {
      logger.error(`[processVisionMessage] Failed "${fileName}": ${err.message}`);
      results.push({
        fileName,
        error: err.message || String(err),
      });
    }
  }

  const successCount = results.filter(r => !r.error).length;
  logger.info(`[processVisionMessage] Done — ${successCount}/${results.length} succeeded`);

  return { success: true, results };
}

// ── Direct Buffer Processor (cho REST API / Orchestrator) ──

/**
 * Xử lý trực tiếp từ buffer (không qua Discord message)
 * Dùng cho REST API endpoint và Orchestrator routing.
 *
 * @param {Buffer} imageBuffer
 * @param {string} mimeType
 * @param {string} [prompt='']
 * @returns {Promise<{ success: boolean, analysis?: string, error?: string }>}
 */
export async function analyzeImageBuffer(imageBuffer, mimeType, prompt = '') {
  try {
    const analysis = await analyzeImage(imageBuffer, mimeType, prompt);
    return { success: true, analysis };
  } catch (err) {
    logger.error(`[analyzeImageBuffer] Failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ── Planner Feedback: Mô tả ảnh cho PlannerAgent ──

/**
 * Phân tích ảnh và trả về mô tả text cấu trúc TỐI ƯU cho PlannerAgent.
 *
 * Khác vì analyzeImage():
 * - Output ngắn gọn (2-5 câu), KHÔNG markdown dài dòng
 * - Tập trung vào: loại ảnh, nội dung chính, chi tiết kỹ thuật, vấn đề
 * - Cuối cùng có OCR_TEXT line
 * - PlannerAgent dùng output này làm input để tạo DAG
 *
 * @param {Buffer} imageBuffer
 * @param {string} mimeType
 * @param {string} [userContext=''] - Context từ user (VD: "Tôi muốn fix lỗi này")
 * @returns {Promise<{ success: boolean, description?: string, ocrText?: string, error?: string }>}
 */
export async function describeImageForPlanner(imageBuffer, mimeType, userContext = '') {
  if (!GEMINI_API_KEY) {
    return { success: false, error: 'GOOGLE_API_KEY / Gemini_API_KEY chưa được set trong .env.' };
  }

  const validation = validateImage(mimeType, imageBuffer.length);
  if (!validation.ok) {
    return { success: false, error: validation.error };
  }

  const base64Image = imageBuffer.toString('base64');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent`;

  const contextLine = userContext
    ? `\n\n## Ngữ cảnh từ người dùng: ${userContext}`
    : '';

  const body = {
    contents: [{
      parts: [
        { text: PLANNER_VISION_PROMPT + contextLine },
        {
          inline_data: {
            mime_type: mimeType || 'image/png',
            data: base64Image,
          },
        },
      ],
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 1024, // Ngắn gọn cho planner
    },
  };

  try {
    const raw = await withRetry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), VISION_API_TIMEOUT);

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(`Gemini Vision API ${res.status}: ${errText.slice(0, 200)}`);
        }

        const data = await res.json();
        if (data?.promptFeedback?.blockReason) {
          throw new Error(`Safety filter: ${data.promptFeedback.blockReason}`);
        }

        return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
          throw new Error(`Timeout ${VISION_API_TIMEOUT / 1000}s`);
        }
        throw err;
      }
    }, { label: 'PlannerVision' });

    if (!raw) {
      return { success: false, error: 'Vision API trả về kết quả rỗng.' };
    }

    // Extract OCR_TEXT line nếu có
    let description = raw.trim();
    let ocrText = '';
    const ocrMatch = description.match(/OCR_TEXT:\s*([\s\S]+)$/i);
    if (ocrMatch) {
      ocrText = ocrMatch[1].trim();
      description = description.replace(/OCR_TEXT:\s*[\s\S]+$/i, '').trim();
    }

    logger.info(`[describeImageForPlanner] OK — ${description.length} chars, OCR: ${ocrText.length} chars`);

    return { success: true, description, ocrText };
  } catch (err) {
    logger.error(`[describeImageForPlanner] Failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Describe image từ URL (cho Discord flow).
 * Download → describeForPlanner trong một bước.
 *
 * @param {string} imageUrl
 * @param {string} [userContext='']
 * @returns {Promise<{ success: boolean, description?: string, ocrText?: string, error?: string }>}
 */
export async function describeImageFromUrl(imageUrl, userContext = '') {
  try {
    const { buffer, mimeType } = await downloadImageToBuffer(imageUrl);
    return await describeImageForPlanner(buffer, mimeType, userContext);
  } catch (err) {
    logger.error(`[describeImageFromUrl] Failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}
