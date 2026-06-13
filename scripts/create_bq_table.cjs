/**
 * Tạo BigQuery dataset + table cho RAG vector storage
 * Chạy: node scripts/create_bq_table.js
 */
const { BigQuery } = require('@google-cloud/bigquery');
const fs = require('fs');

const path = require('path');
const keyData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vertex-key.json'), 'utf8'));
const PROJECT_ID = keyData.project_id;
const DATASET_ID = 'agent_memory';
const TABLE_ID = 'rag_knowledge';

const bigquery = new BigQuery({ projectId: PROJECT_ID });

async function createTable() {
    console.log(`Project: ${PROJECT_ID}`);
    console.log(`Dataset: ${DATASET_ID}`);
    console.log(`Table: ${TABLE_ID}`);

    // 1. Tạo dataset nếu chưa có
    const [datasetExists] = await bigquery.dataset(DATASET_ID).exists();
    if (!datasetExists) {
        console.log(`Creating dataset ${DATASET_ID}...`);
        await bigquery.createDataset(DATASET_ID, { location: 'US' });
        console.log('✅ Dataset created');
    } else {
        console.log('ℹ️  Dataset already exists');
    }

    // 2. Tạo table với schema hỗ trợ vector
    const dataset = bigquery.dataset(DATASET_ID);
    const [tableExists] = await dataset.table(TABLE_ID).exists();

    if (!tableExists) {
        console.log(`Creating table ${TABLE_ID}...`);
        const schema = [
            { name: 'id', type: 'STRING', mode: 'REQUIRED' },
            { name: 'content', type: 'STRING', mode: 'NULLABLE' },
            { name: 'metadata', type: 'JSON', mode: 'NULLABLE' },
            { name: 'content_embedding', type: 'FLOAT64', mode: 'REPEATED' },
            { name: 'source', type: 'STRING', mode: 'NULLABLE' },
            { name: 'category', type: 'STRING', mode: 'NULLABLE' },
            { name: 'created_at', type: 'TIMESTAMP', mode: 'NULLABLE' },
        ];

        await dataset.createTable(TABLE_ID, { schema });
        console.log('✅ Table created');
    } else {
        console.log('ℹ️  Table already exists');
    }

    console.log('\n✅ BigQuery setup complete!');
}

createTable().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
