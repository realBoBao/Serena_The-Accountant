import { archiveOldMemories } from '../lib/memory_manager.js';

const retentionDays = Number(process.argv[2] || 7);
archiveOldMemories(retentionDays)
  .then(() => {
    console.log(`Archived memory entries older than ${retentionDays} days.`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('archive_memory error:', err.message || err);
    process.exit(1);
  });
