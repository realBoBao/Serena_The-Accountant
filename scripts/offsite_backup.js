#!/usr/bin/env node
/**
 * Offsite Backup — Phase 13: Đẩy backup lên cloud storage
 *
 * Hỗ trợ:
 * - Google Drive (qua gdrive CLI hoặc rclone)
 * - AWS S3 (qua AWS CLI)
 * - Local copy (mặc định)
 *
 * Usage:
 *   node scripts/offsite_backup.js --source backups/backup-xxx --target gdrive
 *   node scripts/offsite_backup.js --source backups/backup-xxx --target s3 --bucket my-bucket
 *   node scripts/offsite_backup.js --source backups/backup-xxx --target local --dir /mnt/backup
 *
 * Yêu cầu:
 * - Google Drive: cài `rclone` và config remote `gdrive:`
 * - AWS S3: cài `aws cli` và config credentials
 */

import { spawn } from 'child_process';
import { existsSync, statSync, readdirSync } from 'fs';
import path from 'path';

function runCmd(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr || stdout}`));
    });
    proc.on('error', reject);
  });
}

async function uploadToGDrive(sourcePath, remotePath) {
  console.log(`[Offsite] Uploading to Google Drive: ${remotePath}`);
  try {
    // Try rclone first
    await runCmd('rclone', ['copy', sourcePath, `gdrive:${remotePath}`, '-v']);
    console.log('[Offsite] ✅ Google Drive upload complete (rclone)');
    return true;
  } catch {
    console.warn('[Offsite] rclone not available, trying gdrive CLI...');
  }

  try {
    // Fallback: gdrive CLI
    await runCmd('gdrive', ['upload', '--parent', remotePath, sourcePath]);
    console.log('[Offsite] ✅ Google Drive upload complete (gdrive)');
    return true;
  } catch {
    console.error('[Offsite] ❌ Google Drive upload failed. Install rclone: https://rclone.org/downloads/');
    return false;
  }
}

async function uploadToS3(sourcePath, bucket, prefix = 'my-ai-brain-backups/') {
  console.log(`[Offsite] Uploading to S3: s3://${bucket}/${prefix}`);
  try {
    const filename = path.basename(sourcePath);
    await runCmd('aws', ['s3', 'cp', sourcePath, `s3://${bucket}/${prefix}${filename}`, '--storage-class', 'STANDARD_IA']);
    console.log('[Offsite] ✅ S3 upload complete');
    return true;
  } catch (err) {
    console.error('[Offsite] ❌ S3 upload failed:', err.message);
    console.error('[Offsite] Install AWS CLI: https://aws.amazon.com/cli/');
    return false;
  }
}

async function copyLocal(sourcePath, destDir) {
  console.log(`[Offsite] Copying to local: ${destDir}`);
  try {
    const { mkdir, copyFile } = await import('fs/promises');
    await mkdir(destDir, { recursive: true });
    const destPath = path.join(destDir, path.basename(sourcePath));
    await copyFile(sourcePath, destPath);
    console.log(`[Offsite] ✅ Local copy complete: ${destPath}`);
    return true;
  } catch (err) {
    console.error('[Offsite] ❌ Local copy failed:', err.message);
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);

  const sourceIdx = args.indexOf('--source');
  const targetIdx = args.indexOf('--target');
  const bucketIdx = args.indexOf('--bucket');
  const dirIdx = args.indexOf('--dir');

  if (sourceIdx === -1 || !args[sourceIdx + 1]) {
    console.log('📦 Offsite Backup — Đẩy backup lên cloud storage');
    console.log('');
    console.log('Usage:');
    console.log('  node scripts/offsite_backup.js --source <path> --target gdrive');
    console.log('  node scripts/offsite_backup.js --source <path> --target s3 --bucket <bucket-name>');
    console.log('  node scripts/offsite_backup.js --source <path> --target local --dir <directory>');
    console.log('');
    console.log('Targets: gdrive, s3, local');
    process.exit(1);
  }

  const sourcePath = args[sourceIdx + 1];
  const target = args[targetIdx + 1] || 'local';

  if (!existsSync(sourcePath)) {
    console.error(`❌ Source not found: ${sourcePath}`);
    process.exit(1);
  }

  const stats = statSync(sourcePath);
  const sizeMB = stats.isDirectory()
    ? `${(readdirSync(sourcePath).length} files)`
    : `${(stats.size / 1024 / 1024).toFixed(1)}MB`;

  console.log(`📦 Offsite Backup`);
  console.log(`  Source: ${sourcePath} (${sizeMB})`);
  console.log(`  Target: ${target}`);
  console.log('');

  let success = false;

  switch (target) {
    case 'gdrive':
      success = await uploadToGDrive(sourcePath, 'my-ai-brain-backups');
      break;
    case 's3': {
      const bucket = bucketIdx !== -1 ? args[bucketIdx + 1] : process.env.S3_BACKUP_BUCKET;
      if (!bucket) {
        console.error('❌ Missing S3 bucket. Use --bucket <name> or set S3_BACKUP_BUCKET env var.');
        process.exit(1);
      }
      success = await uploadToS3(sourcePath, bucket);
      break;
    }
    case 'local': {
      const destDir = dirIdx !== -1 ? args[dirIdx + 1] : './backups/offsite';
      success = await copyLocal(sourcePath, destDir);
      break;
    }
    default:
      console.error(`❌ Unknown target: ${target}`);
      process.exit(1);
  }

  if (success) {
    console.log('');
    console.log('✅ Offsite backup complete!');
  } else {
    console.log('');
    console.log('⚠️  Offsite backup failed. Data is still safe in local backup.');
    process.exit(1);
  }
}

main();
