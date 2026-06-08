import { promises as fs } from 'fs';
import 'dotenv/config';
import { HumanMessage } from 'langchain';
import { ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';

const CHUNK_SIZE = 600;
const CHUNK_OVERLAP = 120;
const TOP_K = 3;

function chunkText(text, chunkSize = CHUNK_SIZE, chunkOverlap = CHUNK_OVERLAP) {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  const chunks = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(start + chunkSize, normalized.length);
    if (end < normalized.length) {
      const lastSeparator = normalized.lastIndexOf('\n', end);
      if (lastSeparator > start + chunkSize / 2) {
        end = lastSeparator;
      } else {
        const lastPeriod = normalized.lastIndexOf('. ', end);
        if (lastPeriod > start + chunkSize / 2) {
          end = lastPeriod + 1;
        }
      }
    }

    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);

    start += chunkSize - chunkOverlap;
  }

  return chunks;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    aNorm += a[i] * a[i];
    bNorm += b[i] * b[i];
  }

  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

async function buildVectorStore(filePath = 'knowledge.txt') {
  const rawText = await fs.readFile(filePath, 'utf8');
  const chunks = chunkText(rawText);

  if (chunks.length === 0) {
    throw new Error('File is empty or could not be chunked. Please add text to knowledge.txt.');
  }

  // Use local deterministic embeddings to avoid model/version mismatch in dev.
  // (Production can swap back to real embeddings once GOOGLE embedding model is confirmed.)
  const { embedText, cosineSimilarity } = await import('./lib/embeddings.js');
  const vectors = await Promise.all(chunks.map((t) => embedText(t)));


  return chunks.map((text, index) => ({
    id: `chunk-${index + 1}`,
    text,
    vector: vectors[index],
  }));
}

function retrieveTopK(vectorStore, queryVector, k = TOP_K) {
  return [...vectorStore]
    .map((item) => ({
      ...item,
      similarity: cosineSimilarity(item.vector, queryVector),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);
}

function buildPrompt(relevantChunks, question) {
  const context = relevantChunks
    .map((chunk, index) => `--- Đoạn ${index + 1} ---\n${chunk.text}`)
    .join('\n\n');

  return `Bạn là một trợ lý kỹ thuật cấp cao.
Hãy trả lời câu hỏi dựa trên các TÀI LIỆU được cung cấp bên dưới.
Nếu trong tài liệu không có thông tin, hãy trả lời: "Tôi không tìm thấy thông tin này trong cơ sở dữ liệu".

TÀI LIỆU:
${context}

CÂU HỎI:
${question}

HÃY TRẢ LỜI NGẮN GỌN, CHÍNH XÁC, KHÔNG SÁNG TẠO THÊM.`;
}

function formatResponse(response) {
  if (typeof response === 'string') return response;
  if (response?.text) return response.text;
  if (Array.isArray(response?.content)) {
    return response.content
      .map((block) => (typeof block === 'string' ? block : JSON.stringify(block)))
      .join('');
  }
  return String(response);
}

async function askQuestion(vectorStore, question) {
  // Dev-safe: use local deterministic embeddings (no remote embedding model dependency)
  const { embedText, cosineSimilarity } = await import('./lib/embeddings.js');
  const queryVector = await embedText(question);
  const relevantChunks = retrieveTopK(vectorStore, queryVector, TOP_K);



  const prompt = buildPrompt(relevantChunks, question);

  const llm = new ChatGoogleGenerativeAI({
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.Google_API_KEY || '',
    temperature: 0,
    maxOutputTokens: 600,
  });

  const response = await llm.invoke([new HumanMessage(prompt)]);
  return formatResponse(response);
}

async function main() {
  try {
    console.log('🚀 Xây dựng bộ nhớ vector từ knowledge.txt...');
    const vectorStore = await buildVectorStore('knowledge.txt');

    const question = process.argv.slice(2).join(' ') ||
      'Hệ thống RAG này hoạt động như thế nào và tại sao lại an toàn hơn so với mô hình AI thông thường?';

    console.log(`\n👤 Câu hỏi: ${question}\n`);

    const answer = await askQuestion(vectorStore, question);
    console.log('🤖 Trả lời:');
    console.log(answer);
  } catch (error) {
    console.error('❌ Lỗi:', error.message || error);
  }
}

main();
