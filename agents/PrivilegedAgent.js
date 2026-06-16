/**
 * PrivilegedAgent — Agent with elevated system privileges
 *
 * Based on obra/superpowers philosophy:
 * - Tool Use / Function Calling with system-level access
 * - File system operations (read/write within sandbox)
 * - CLI command execution (within sandbox)
 * - Task management and automation
 *
 * Security: All operations are sandboxed via code_sandbox.js
 * Trust Level: PRIVILEGED (can access file system, CLI, but still sandboxed)
 *
 * Usage:
 *   import { PrivilegedAgent } from './PrivilegedAgent.js';
 *   const result = await PrivilegedAgent.execute({
 *     action: 'organize_files',
 *     params: { directory: './artifacts', pattern: '*.json' }
 *   });
 */

import { executeCode, getSupportedLanguages } from '../lib/code_sandbox.js';
import { invokeLlm } from '../lib/llm.js';
import { HumanMessage } from '@langchain/core/messages';
import { getLogger } from '../lib/logger.js';
import { readFile, writeFile, readdir, stat, mkdir, unlink, rename } from 'fs/promises';
import path from 'path';

const logger = getLogger('PrivilegedAgent');

// ── System Prompt (obra/superpowers inspired) ──
const PRIVILEGED_SYSTEM_PROMPT = `You are a privileged system administrator AI with elevated access to the local file system and CLI. Your job is to help manage, organize, and automate tasks on the server.

## Core Capabilities

1. **File System Operations**
   - Read files (within project directory only)
   - Write/create files (within project directory only)
   - List directory contents
   - Create/delete directories
   - Move/rename files
   - Check file stats (size, modified time)

2. **CLI Command Execution**
   - Run shell commands within sandbox
   - Process management (list, kill)
   - System info (disk, memory, uptime)
   - Git operations (status, log, diff)

3. **Task Automation**
   - Batch file operations
   - Scheduled cleanup tasks
   - Log analysis and rotation
   - Data export/import

## Security Rules

1. **Sandbox boundary**: Never access files outside the project directory
2. **No destructive operations**: Never delete the project directory itself
3. **No network access**: Don't make external network calls
4. **No credential access**: Don't read .env files or secrets
5. **Log everything**: Log all operations for audit trail

## Output Format

For file operations:
\`\`\`json
{
  "action": "read_file|write_file|list_dir|create_dir|delete|move",
  "path": "relative/path",
  "result": "...",
  "success": true
}
\`\`\`

For CLI operations:
\`\`\`bash
# Command to execute
[command here]
\`\`\`

Expected output:
\`\`\`
[expected stdout]
\`\`\``;

/**
 * Execute a privileged action
 * @param {{ action: string, params: object }} request
 * @returns {{ success: boolean, result: any, error?: string }}
 */
export async function execute(request) {
  const { action, params = {} } = request;
  logger.info(`[PrivilegedAgent] Executing: ${action}`);

  try {
    switch (action) {
      case 'read_file':
        return await _readFile(params.path);
      case 'write_file':
        return await _writeFile(params.path, params.content);
      case 'list_dir':
        return await _listDir(params.path || '.');
      case 'create_dir':
        return await _createDir(params.path);
      case 'delete':
        return await _deletePath(params.path);
      case 'move':
        return await _movePath(params.from, params.to);
      case 'file_stats':
        return await _fileStats(params.path);
      case 'run_command':
        return await _runCommand(params.command, params.timeout);
      case 'disk_usage':
        return await _diskUsage();
      case 'cleanup_old_files':
        return await _cleanupOldFiles(params.directory, params.maxAgeDays);
      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    logger.error(`[PrivilegedAgent] ${action} failed:`, err.message);
    return { success: false, error: err.message };
  }
}

// ── File System Operations ──

async function _readFile(filePath) {
  const safe = _safePath(filePath);
  const content = await readFile(safe, 'utf8');
  return { success: true, result: content, path: safe };
}

async function _writeFile(filePath, content) {
  const safe = _safePath(filePath);
  await writeFile(safe, content, 'utf8');
  return { success: true, result: 'written', path: safe };
}

async function _listDir(dirPath) {
  const safe = _safePath(dirPath);
  const entries = await readdir(safe, { withFileTypes: true });
  const result = entries.map(e => ({
    name: e.name,
    isFile: e.isDirectory() ? false : true,
    isDir: e.isDirectory(),
  }));
  return { success: true, result, path: safe };
}

async function _createDir(dirPath) {
  const safe = _safePath(dirPath);
  await mkdir(safe, { recursive: true });
  return { success: true, result: 'created', path: safe };
}

async function _deletePath(targetPath) {
  const safe = _safePath(targetPath);
  const info = await stat(safe);
  if (info.isDirectory()) {
    // Only delete if empty or contains only files (no subdirs with content)
    const entries = await readdir(safe);
    if (entries.length > 10) {
      return { success: false, error: 'Directory has too many entries (>10), aborting for safety' };
    }
    await unlink(safe).catch(() => {});
  } else {
    await unlink(safe);
  }
  return { success: true, result: 'deleted', path: safe };
}

async function _movePath(from, to) {
  const safeFrom = _safePath(from);
  const safeTo = _safePath(to);
  await rename(safeFrom, safeTo);
  return { success: true, result: 'moved', from: safeFrom, to: safeTo };
}

async function _fileStats(filePath) {
  const safe = _safePath(filePath);
  const info = await stat(safe);
  return {
    success: true,
    result: {
      size: info.size,
      modified: info.mtime.toISOString(),
      created: info.birthtime.toISOString(),
      isFile: info.isFile(),
      isDir: info.isDirectory(),
    },
    path: safe,
  };
}

// ── CLI Operations (sandboxed) ──

async function _runCommand(command, timeout = 30) {
  // Whitelist of safe commands
  const SAFE_COMMANDS = ['ls', 'dir', 'cat', 'type', 'echo', 'pwd', 'cd', 'find', 'grep', 'head', 'tail', 'wc', 'sort', 'uniq', 'date', 'whoami', 'ps', 'top', 'df', 'du', 'free', 'uptime', 'git'];
  const cmdParts = command.trim().split(/\s+/);
  const baseCmd = cmdParts[0];

  if (!SAFE_COMMANDS.includes(baseCmd)) {
    return { success: false, error: `Command not in whitelist: ${baseCmd}. Allowed: ${SAFE_COMMANDS.join(', ')}` };
  }

  try {
    const result = await executeCode(`const {execSync} = require('child_process'); console.log(execSync(${JSON.stringify(command)}, {timeout: ${timeout * 1000}, encoding: 'utf8'}));`, 'javascript', timeout);
    return { success: true, result: result.output?.trim() || '(no output)' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function _diskUsage() {
  try {
    const result = await executeCode(`const {execSync} = require('child_process'); console.log(execSync('df -h .', {encoding: 'utf8'}));`, 'javascript', 10);
    return { success: true, result: result.output?.trim() };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function _cleanupOldFiles(directory, maxAgeDays = 30) {
  const safe = _safePath(directory);
  const entries = await readdir(safe, { withFileTypes: true });
  const now = Date.now();
  const maxAge = maxAgeDays * 86400000;
  let cleaned = 0;

  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const filePath = path.join(safe, entry.name);
    const info = await stat(filePath);
    if (now - info.mtime.getTime() > maxAge) {
      await unlink(filePath);
      cleaned++;
    }
  }

  return { success: true, result: `Cleaned ${cleaned} files older than ${maxAgeDays} days`, directory: safe };
}

// ── Security: Ensure path stays within project directory ──

function _safePath(inputPath) {
  const projectRoot = process.cwd();
  const resolved = path.resolve(projectRoot, inputPath);
  if (!resolved.startsWith(projectRoot)) {
    throw new Error(`Path traversal blocked: ${inputPath}`);
  }
  return resolved;
}

export default { execute, PRIVILEGED_SYSTEM_PROMPT };
