import fs from 'fs/promises';
import path from 'path';

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const [key, value] = raw.slice(2).split('=');
    args[key] = value === undefined ? true : value;
  }
  return args;
}

function formatDate(dt) {
  return dt.toISOString().slice(0, 10);
}

async function exists(pathStr) {
  try {
    await fs.access(pathStr);
    return true;
  } catch {
    return false;
  }
}

async function removeDir(target) {
  await fs.rm(target, { recursive: true, force: true });
}

async function ensureDir(target) {
  await fs.mkdir(target, { recursive: true });
}

function buildMoveTarget(archiveDir, itemName) {
  const now = new Date();
  const prefix = `${formatDate(now)}-`;
  return path.join(archiveDir, `${prefix}${itemName}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const artifactDir = path.resolve(args.dir || process.env.ARTIFACT_DIR || './artifacts');
  const archiveDir = path.resolve(args.archiveDir || process.env.ARTIFACT_ARCHIVE_DIR || './archived_artifacts');
  const retentionDays = args.retention ? Number(args.retention) : Number(process.env.ARTIFACT_RETENTION_DAYS || 30);
  const keepNewest = args.keep ? Number(args.keep) : null;
  const dryRun = Boolean(args.dryRun || args.dry);
  const archive = Boolean(args.archive);
  const remove = Boolean(args.delete);
  const pattern = args.pattern ? new RegExp(args.pattern, 'i') : null;

  if (!(archive || remove || dryRun)) {
    console.log('Usage: node cleanup_artifacts.js [--retention=30] [--keep=100] [--archive|--delete] [--dry-run] [--pattern=video|repo]');
    console.log('Example: node cleanup_artifacts.js --retention=30 --archive --dry-run');
  }

  if (!await exists(artifactDir)) {
    throw new Error(`Artifact directory not found: ${artifactDir}`);
  }

  const entries = await fs.readdir(artifactDir, { withFileTypes: true });
  const directories = [];
  for (const entry of entries.filter((e) => e.isDirectory())) {
    const fullPath = path.join(artifactDir, entry.name);
    if (pattern && !pattern.test(entry.name)) continue;
    const stat = await fs.stat(fullPath);
    directories.push({
      name: entry.name,
      fullPath,
      mtimeMs: stat.mtimeMs,
      ageDays: Math.floor((Date.now() - stat.mtimeMs) / 86400000),
    });
  }

  if (!directories.length) {
    console.log('No artifact directories found to evaluate.');
    return;
  }

  directories.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const cutoff = retentionDays >= 0 ? Date.now() - retentionDays * 86400000 : null;
  const toRemove = new Set();

  if (keepNewest !== null && keepNewest >= 0) {
    directories.slice(keepNewest).forEach((item) => toRemove.add(item));
  }

  if (cutoff !== null) {
    directories.filter((item) => item.mtimeMs < cutoff).forEach((item) => toRemove.add(item));
  }

  const candidates = Array.from(toRemove);
  if (!candidates.length) {
    console.log('No artifact directories matched the cleanup criteria.');
    return;
  }

  console.log(`Artifact cleanup target: ${artifactDir}`);
  console.log(`Found ${directories.length} directories, ${candidates.length} eligible for cleanup.`);
  for (const item of candidates) {
    console.log(`- ${item.name} (age ${item.ageDays} days)`);
  }

  if (dryRun) {
    console.log('\nDry-run complete: no files were deleted or moved.');
    return;
  }

  if (archive) {
    await ensureDir(archiveDir);
    for (const item of candidates) {
      const target = buildMoveTarget(archiveDir, item.name);
      console.log(`Archiving ${item.fullPath} -> ${target}`);
      await fs.rename(item.fullPath, target);
    }
    console.log('\nArchive complete.');
    return;
  }

  if (remove) {
    for (const item of candidates) {
      console.log(`Deleting ${item.fullPath}`);
      await removeDir(item.fullPath);
    }
    console.log('\nDelete complete.');
    return;
  }

  console.log('\nNo action specified. Use --archive or --delete to apply cleanup.');
}

main().catch((error) => {
  console.error('Cleanup failed:', error.message || error);
  process.exit(1);
});
