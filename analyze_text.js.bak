/**
 * analyze_text.js — Phân tích text bằng Gemini API
 * Usage: node analyze_text.js <file_path> <metadata>
 */

import 'dotenv/config';
import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';

const apiKey = process.env.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY || '';
if (!apiKey) {
  console.error('GOOGLE_API_KEY not set');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite' });

const filePath = process.argv[2];
const metadata = process.argv[3] || '';

if (!filePath) {
  console.error('Usage: node analyze_text.js <file_path> <metadata>');
  process.exit(1);
}

async function main() {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const prompt = `Phân tích nội dung sau và trả về JSON với format:
{
  "summary": "Tóm tắt ngắn gọn (2-3 câu)",
  "category": "Backend|AI|DevOps|Math|Algorithms|Other",
  "key_concepts": ["concept1", "concept2"],
  "technologies": ["tech1", "tech2"],
  "score": 0-100
}

Metadata: ${metadata}

Nội dung:
${text.slice(0, 8000)}`;

    const result = await model.generateContent(prompt);
    const response = result.response;
    const raw = response.text();

    // Parse JSON từ response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log(JSON.stringify(parsed, null, 2));

      // Save analysis
      const analysisPath = filePath.replace(/\.txt$/, '') + '_analysis.json';
      fs.writeFileSync(analysisPath, JSON.stringify(parsed, null, 2));

      // Save summary
      const summaryPath = filePath.replace(/\.txt$/, '') + '_summary.txt';
      fs.writeFileSync(summaryPath, parsed.summary || raw.slice(0, 500));
    } else {
      console.log(raw);
    }
  } catch (err) {
    console.error('Analysis failed:', err.message);
    process.exit(1);
  }
}

main();
