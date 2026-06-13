/**
 * Test pipeline: Text → Vertex AI Embedding → BigQuery
 * Chạy: node scripts/test_bq_pipeline.js
 */
const { BigQuery } = require('@google-cloud/bigquery');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');

const path = require('path');
const keyData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vertex-key.json'), 'utf8'));
const PROJECT_ID = keyData.project_id;
const DATASET_ID = 'agent_memory';
const TABLE_ID = 'rag_knowledge';

async function test() {
    console.log('=== Test BigQuery Pipeline ===\n');

    // 1. Khởi tạo clients
    process.env.GOOGLE_APPLICATION_CREDENTIALS = './vertex-key.json';
    const bigquery = new BigQuery({ projectId: PROJECT_ID });
    const ai = new GoogleGenAI({
        vertexai: { project: PROJECT_ID, location: 'us-central1' }
    });

    // 2. Test text → embedding
    const testText = 'FSRS (Free Spaced Repetition Scheduler) là thuật toán spaced repetition thế hệ mới, vượt SM-2 về recall accuracy.';
    console.log('1. Text:', testText.slice(0, 80) + '...');

    console.log('2. Calling Vertex AI Embedding (text-embedding-004)...');
    const embedResponse = await ai.models.embedContent({
        model: 'text-embedding-004',
        contents: testText,
    });

    const vector = embedResponse?.embeddings?.[0]?.values || [];
    console.log(`   ✅ Vector dimensions: ${vector.length}`);

    // 3. Insert vào BigQuery
    console.log('3. Inserting to BigQuery...');
    const row = {
        id: `test_${Date.now()}`,
        content: testText,
        metadata: JSON.stringify({ source: 'test', model: 'text-embedding-004' }),
        content_embedding: vector,
        source: 'test_pipeline',
        category: 'spaced-repetition',
        created_at: new Date().toISOString(),
    };

    await bigquery.dataset(DATASET_ID).table(TABLE_ID).insert([row]);
    console.log('   ✅ Inserted to BigQuery');

    // 4. Verify
    console.log('4. Verifying...');
    const [rows] = await bigquery.query({
        query: `SELECT id, content, ARRAY_LENGTH(content_embedding) as dim FROM \`${PROJECT_ID}.${DATASET_ID}.${TABLE_ID}\` WHERE id = @id`,
        params: { id: row.id },
    });

    if (rows.length > 0) {
        console.log(`   ✅ Verified: ${rows[0].dim} dimensions stored`);
    }

    console.log('\n✅ Pipeline test complete!');
}

test().catch(err => {
    console.error('❌ Error:', err.message);
    if (err.details) console.error('Details:', JSON.stringify(err.details, null, 2));
    process.exit(1);
});
