/**
 * code_sandbox_v2.js — Canonical 4-layer security pattern database
 * Single source of truth for all security patterns.
 * Imported by code_sandbox.js for analyzeCodeSecurity().
 */

// Re-exports from code_sandbox.js (execution + language config)
export { executeCode, getSupportedLanguages, getLang } from './code_sandbox.js';

// ── Security Analysis (uses canonical patterns from this file) ──
export function analyzeCodeSecurity(code) {
  for (const p of DANGEROUS_COMMANDS) {
    if (p.test(code)) return { safe: false, reason: `🚫 [Layer 1] Dangerous command: ${p.toString().slice(0, 60)}`, layer: 1 };
  }
  for (const p of DANGEROUS_IMPORTS) {
    if (p.test(code)) return { safe: false, reason: `🚫 [Layer 2] Dangerous import: ${p.toString().slice(0, 60)}`, layer: 2 };
  }
  for (const p of DANGEROUS_PATTERNS) {
    if (p.test(code)) return { safe: false, reason: `🚫 [Layer 3] Dangerous pattern: ${p.toString().slice(0, 60)}`, layer: 3 };
  }
  for (const p of EXFILTRATION_PATTERNS) {
    if (p.test(code)) return { safe: false, reason: `🚫 [Layer 4] Data exfiltration: ${p.toString().slice(0, 60)}`, layer: 4 };
  }
  return { safe: true, reason: null, layer: 0 };
}

// ═══════════════════════════════════════════════════════════════
// LAYER 1: Dangerous System Commands
// ═══════════════════════════════════════════════════════════════
export const DANGEROUS_COMMANDS = [
  /\brm\s+(-[rfRF]+\s+)?(\/|~|\.\.)/,
  /\bshutdown\b/, /\breboot\b/, /\bpoweroff\b/, /\bhalt\b/,
  /\bkill\s+-9\s+1\b/, /\bkill\s+-9\s+-1\b/,
  /\bdd\s+if=/, /\bmkfs\b/, /\bfdisk\b/,
  /\bformat\s+[a-z]:/i, /\bdel\s+\/s\s+/i, /\brd\s+\/s\s+/i,
  /\bcipher\s+\/w/i,
];

// ═══════════════════════════════════════════════════════════════
// LAYER 2: Dangerous Imports/Requires
// ═══════════════════════════════════════════════════════════════
export const DANGEROUS_IMPORTS = [
  /\brequire\s*\(\s*['"]child_process['"]\s*\)/,
  /\brequire\s*\(\s*['"]fs['"]\s*\)/,
  /\brequire\s*\(\s*['"]fs\/promises['"]\s*\)/,
  /\brequire\s*\(\s*['"]net['"]\s*\)/,
  /\brequire\s*\(\s*['"]http['"]\s*\)/,
  /\brequire\s*\(\s*['"]dgram['"]\s*\)/,
  /\brequire\s*\(\s*['"]cluster['"]\s*\)/,
  /\brequire\s*\(\s*['"]vm['"]\s*\)/,
  /\brequire\s*\(\s*['"]worker_threads['"]\s*\)/,
  /\brequire\s*\(\s*['"]dgram['"]\s*\)/,
  /\brequire\s*\(\s*['"]cluster['"]\s*\)/,
  /\brequire\s*\(\s*['"]vm['"]\s*\)/,
  /\brequire\s*\(\s*['"]worker_threads['"]\s*\)/,
  /\bimport\s+.*\s+from\s+['"]child_process['"]/,
  /\bimport\s+.*\s+from\s+['"]fs['"]/,
  /\bimport\s+.*\s+from\s+['"]net['"]/,
  /\bimport\s+os\b/, /\bfrom\s+os\s+import\b/,
  /\bimport\s+subprocess\b/, /\bfrom\s+subprocess\s+import\b/,
  /\bimport\s+shutil\b/, /\bimport\s+socket\b/,
  /\bimport\s+ctypes\b/, /\bimport\s+signal\b/,
  /\bimport\s+multiprocessing\b/, /\bimport\s+threading\b/,
  /\bimport\s+pty\b/, /\bimport\s+resource\b/,
  /\b__import__\s*\(\s*['"](os|subprocess|shutil|socket|ctypes|signal|multiprocessing|threading|pty|resource)['"]\)/,
  /\bos\.system\s*\(/i, /\bsubprocess\b/i, /\bchild_process\b/i,
  /\bimport\s+ctypes\b/, /\bimport\s+signal\b/,
  /\b__import__\s*\(\s*['"](os|subprocess|shutil|socket|ctypes)/,
  /\bimport\s+java\.io\.File\b/,
  /\bimport\s+java\.lang\.Runtime\b/,
  /\bimport\s+java\.lang\.ProcessBuilder\b/,
  /\bimport\s+java\.net\./,
  /\bimport\s+java\.io\./,
  /\bRuntime\s*\.\s*getRuntime\s*\(\s*\)\s*\.\s*exec\b/,
  /\bProcessBuilder\b/,
  /#include\s*<unistd\.h>/,
  /#include\s*<sys\/socket\.h>/,
  /#include\s*<netinet\//,
  /#include\s*<arpa\/inet\.h>/,
  /#include\s*<signal\.h>/,
  /#include\s*<sys\/wait\.h>/,
  /#include\s*<sys\/mman\.h>/,
  /use\s+std::process::Command\b/,
  /use\s+std::fs::remove_/,
  /use\s+std::os::unix::/,
  /use\s+std::net::/,
];

// ═══════════════════════════════════════════════════════════════
// LAYER 3: Code Injection Patterns
// ═══════════════════════════════════════════════════════════════
export const DANGEROUS_PATTERNS = [
  /\beval\s*\(/, /\bFunction\s*\(/, /\bnew\s+Function\s*\(/,
  /\bexec\s*\(/, /\bexecSync\s*\(/, /\bexecFile\s*\(/,
  /\bspawn\s*\(/, /\bspawnSync\s*\(/, /\bfork\s*\(/,
  /\brequire\s*\(\s*[^'"]/, /\bimport\s*\(/,
  /\bvm\.runInNewContext/, /\bvm\.runInThisContext/, /\bvm\.Script/,
  /\bprocess\s*\.\s*(exit|kill|abort|chdir|setuid|setgid)\b/,
  /\bprocess\s*\.\s*env\b/,
  /\bhttp\s*\.\s*(get|request|createServer)\b/,
  /\bhttps\s*\.\s*(get|request|createServer)\b/,
  /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/,
  /\bhttp\s*\.\s*(get|request|createServer)\b/,
  /\bhttps\s*\.\s*(get|request|createServer)\b/,
  /\bfs\s*\.\s*(readFile|writeFile|appendFile|unlink|rmdir|rm|createReadStream|createWriteStream)\b/,
  /\bfs\s*\.\s*(readdir|access|stat|lstat|chmod|chown|rename|symlink|readlink|realpath|mkdir|mkdtemp)\b/,
  /\bwhile\s*\(\s*(true|1)\s*\)\s*\{/,
  /\bfor\s*\(\s*;\s*;\s*\)\s*\{/,
  /\b__proto__\b/, /\bconstructor\s*\[\s*['"]constructor['"]\s*\]/,
  /\bObject\.prototype\b/,
  /\b__builtins__\b/, /\b__globals__\b/,
  /\bglobals\s*\(\s*\)/, /\blocals\s*\(\s*\)/,
  /\bgetattr\s*\(/, /\bsetattr\s*\(/, /\bdelattr\s*\(/, /\bcompile\s*\(/,
  /\bRuntime\s*\.\s*getRuntime\s*\(\s*\)\s*\.\s*exec\b/,
  /\bProcessBuilder\b/, /\bClass\s*\.\s*forName\b/,
  /\bsystem\s*\(\s*['"]/, /\bpopen\s*\(/,
  /\bexecl\s*\(/, /\bexecv\s*\(/,
  /\bclone\s*\(/, /\bptrace\s*\(/, /\bmmap\s*\(/, /\bmprotect\s*\(/,
  /\bos\.Remove\s*\(/, /\bos\.RemoveAll\s*\(/,
  /\bos\.Chdir\s*\(/, /\bos\.Exit\s*\(/,
  /\bnet\.Dial\b/, /\bnet\.Listen\b/,
  /\bexec\.Command\s*\(/,
  /\b__subclasses__\b/,
  /\b__class__\b/,
  /\b__builtins__\b/,
  /\b__globals__\b/,
  /\bglobals\s*\(\s*\)/,
  /\blocals\s*\(\s*\)/,
];

// ═══════════════════════════════════════════════════════════════
// LAYER 4: Data Exfiltration Patterns
// ═══════════════════════════════════════════════════════════════
export const EXFILTRATION_PATTERNS = [
  /\bcurl\s+/, /\bwget\s+/, /\bnc\s+/, /\bnetcat\b/,
  /\.env\b.*(?:send|post|write|upload)/i,
  /process\.env.*(?:send|post|write|upload)/i,
  /(?:api_key|apikey|secret|token|password|credential).*(?:send|post|write|log|print)/i,
];
