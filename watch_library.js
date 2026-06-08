import chokidar from 'chokidar';
import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import { orchestrator } from './Orchestrator.js';

const incomingDir = path.resolve('./library/incoming');
const archiveDir = path.resolve('./library/archive');

async function ensureLibraryFolders() {
  await fs.mkdir(incomingDir, { recursive: true });
  await fs.mkdir(archiveDir, { recursive: true });
}

async function archiveFile(filePath) {
  const fileName = path.basename(filePath);
  const targetPath = path.join(archiveDir, `${Date.now()}_${fileName}`);
  await fs.rename(filePath, targetPath);
  return targetPath;
}

async function handlePdf(filePath) {
  console.log(chalk.blue('Hot folder detected new PDF:'), filePath);
  const result = await orchestrator.route({ type: 'pdf_file', filePath });
  if (result?.error) {
    console.error(chalk.red('Watcher error:'), result.error);
    return;
  }
  const archived = await archiveFile(filePath);
  console.log(chalk.green(`PDF processed and archived to ${archived}`));
}

async function startWatcher() {
  await ensureLibraryFolders();
  const watcher = chokidar.watch(incomingDir, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 100,
    },
  });

  watcher.on('add', async (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    const SUPPORTED_EXTENSIONS = ['.pdf', '.txt', '.md', '.epub'];

    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      console.log(chalk.yellow('Ignoring unsupported file type in hot folder:'), filePath);
      return;
    }

    if (ext === '.pdf') {
      try {
        await handlePdf(filePath);
      } catch (error) {
        console.error(chalk.red('watch_library failed:'), error.message || error);
      }
    } else {
      // Handle text-based files (.txt, .md, .epub)
      console.log(chalk.blue('Hot folder detected new text file:'), filePath);
      try {
        const fs = await import('fs/promises');
        const content = await fs.readFile(filePath, 'utf8');
        const { chunkText } = await import('./lib/chunking.js');
        const { embedText } = await import('./lib/embeddings.js');
        const { upsertDocument } = await import('./lib/vector_store.js');

        const chunks = chunkText(content);
        const embeddings = await Promise.all(chunks.map(c => embedText(c)));
        const fileName = path.basename(filePath, ext);
        await upsertDocument(`hotfolder:${fileName}`, {
          url: filePath,
          project: 'hot-folder',
          category: 'document',
          type: ext.slice(1),
        }, chunks, embeddings);

        const archived = await archiveFile(filePath);
        console.log(chalk.green(`Text file processed (${chunks.length} chunks) and archived to ${archived}`));
      } catch (error) {
        console.error(chalk.red('watch_library text processing failed:'), error.message || error);
      }
    }
  });

  watcher.on('ready', () => {
    console.log(chalk.green(`Watching hot folder: ${incomingDir}`));
  });

  watcher.on('error', (error) => {
    console.error(chalk.red('Hot folder watcher error:'), error);
  });
}

startWatcher().catch((err) => {
  console.error(chalk.red('Failed to start hot folder watcher:'), err);
  process.exit(1);
});

// Graceful shutdown for PM2
function gracefulShutdown(signal) {
  console.log(`[Watcher] Received ${signal}, shutting down...`);
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
