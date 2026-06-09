import { describe, it, expect } from '@jest/globals';
import {
  needsMemorySanitizer,
  getCoderAgentLanguages,
  analyzeError,
} from '../agents/CoderAgent.js';

// ── CoderAgent Unit Tests ──

describe('CoderAgent', () => {
  describe('needsMemorySanitizer()', () => {
    it('should return true for C', () => {
      expect(needsMemorySanitizer('c')).toBe(true);
    });

    it('should return true for C++', () => {
      expect(needsMemorySanitizer('cpp')).toBe(true);
    });

    it('should return false for Python', () => {
      expect(needsMemorySanitizer('python')).toBe(false);
    });

    it('should return false for JavaScript', () => {
      expect(needsMemorySanitizer('javascript')).toBe(false);
    });

    it('should return false for Java', () => {
      expect(needsMemorySanitizer('java')).toBe(false);
    });

    it('should return false for Rust', () => {
      expect(needsMemorySanitizer('rust')).toBe(false);
    });

    it('should return false for Go', () => {
      expect(needsMemorySanitizer('go')).toBe(false);
    });

    it('should return false for C#', () => {
      expect(needsMemorySanitizer('csharp')).toBe(false);
    });
  });

  describe('getCoderAgentLanguages()', () => {
    it('should return supported languages from code_sandbox', () => {
      const langs = getCoderAgentLanguages();
      expect(langs).toBeInstanceOf(Array);
      expect(langs.length).toBeGreaterThan(0);
    });

    it('should include python and javascript', () => {
      const langs = getCoderAgentLanguages();
      expect(langs).toContain('python');
      expect(langs).toContain('javascript');
    });

    it('should include C and C++', () => {
      const langs = getCoderAgentLanguages();
      expect(langs).toContain('c');
      expect(langs).toContain('cpp');
    });
  });

  describe('analyzeError()', () => {
    it('should return null fields for empty stderr', () => {
      const result = analyzeError('', 'code');
      expect(result.errorLine).toBeNull();
      expect(result.errorType).toBeNull();
      expect(result.summary).toBeNull();
    });

    it('should detect GCC compile error with line number', () => {
      const stderr = 'main.c:12:5: error: expected \';\' before \'}\' token';
      const code = '#include <stdio.h>\nint main() {\n  printf("hello")\n  return 0;\n}';
      const result = analyzeError(stderr, code);
      expect(result.errorLine).toBe(12);
      expect(result.errorType).toBe('error');
      expect(result.summary).toContain('Compile error');
    });

    it('should detect AddressSanitizer heap-buffer-overflow', () => {
      const stderr = `=================================================================
==12345==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x602000000014 at pc 0x0000004c2a33 bp 0x7ffd4e8e8a20 sp 0x7ffd4e8e8a18
READ of size 4 at 0x602000000014 thread T0
    #0 0x4c2a33 in main /tmp/sandbox/main.c:8:15`;
      const code = 'int main() {\n  int arr[5];\n  arr[10] = 42;\n  return 0;\n}';
      const result = analyzeError(stderr, code);
      expect(result.errorType).toBe('heap_buffer_overflow');
      expect(result.errorLine).toBe(8);
      expect(result.summary).toContain('Heap buffer overflow');
    });

    it('should detect AddressSanitizer use-after-free', () => {
      const stderr = `==12345==ERROR: AddressSanitizer: heap-use-after-free on address 0x602000000010
    #0 0x4c2a33 in main /tmp/sandbox/main.c:15:10`;
      const code = 'int main() {\n  int* p = malloc(sizeof(int));\n  free(p);\n  *p = 42;\n  return 0;\n}';
      const result = analyzeError(stderr, code);
      expect(result.errorType).toBe('use_after_free');
      expect(result.summary).toContain('Use-after-free');
    });

    it('should detect Python runtime error with line number', () => {
      const stderr = `Traceback (most recent call last):
  File "main.py", line 5, in <module>
    print(1/0)
ZeroDivisionError: division by zero`;
      const code = 'x = 1\ny = 0\nresult = x / y\nprint(result)';
      const result = analyzeError(stderr, code);
      expect(result.errorLine).toBe(5);
      expect(result.errorType).toBe('zerodivisionerror');
      expect(result.summary).toContain('zerodivisionerror');
    });

    it('should detect segmentation fault', () => {
      const stderr = 'Segmentation fault (core dumped)';
      const code = 'int main() { int* p = 0; *p = 42; return 0; }';
      const result = analyzeError(stderr, code);
      expect(result.errorType).toBe('segmentation_fault');
      expect(result.summary).toContain('Segmentation fault');
    });

    it('should detect timeout', () => {
      const stderr = '⏰ TIMEOUT: Code execution exceeded 5s limit';
      const code = 'while(1) {}';
      const result = analyzeError(stderr, code);
      expect(result.errorType).toBe('timeout');
      expect(result.summary).toContain('Timeout');
    });

    it('should extract error line text', () => {
      const stderr = 'main.c:3: error: undeclared variable';
      const code = 'int main() {\n  int x = 1;\n  y = 2;\n  return 0;\n}';
      const result = analyzeError(stderr, code);
      expect(result.errorLine).toBe(3);
      expect(result.errorLineText).toBe('y = 2;');
    });

    it('should detect memory leak from ASan', () => {
      const stderr = `==12345==ERROR: LeakSanitizer: detected memory leaks
    #0 0x4c2a33 in main /tmp/sandbox/main.c:5:10`;
      const code = 'int main() {\n  int* p = malloc(100);\n  return 0;\n}';
      const result = analyzeError(stderr, code);
      expect(result.errorType).toBe('memory_leak');
      expect(result.summary).toContain('Memory leak');
    });
  });

  describe('Module exports', () => {
    it('should export solveWithDebugLoop function', async () => {
      const mod = await import('../agents/CoderAgent.js');
      expect(typeof mod.solveWithDebugLoop).toBe('function');
    });

    it('should export writeCode function', async () => {
      const mod = await import('../agents/CoderAgent.js');
      expect(typeof mod.writeCode).toBe('function');
    });

    it('should export runCode function', async () => {
      const mod = await import('../agents/CoderAgent.js');
      expect(typeof mod.runCode).toBe('function');
    });

    it('should export optimizeCode function', async () => {
      const mod = await import('../agents/CoderAgent.js');
      expect(typeof mod.optimizeCode).toBe('function');
    });

    it('should export debugCode function', async () => {
      const mod = await import('../agents/CoderAgent.js');
      expect(typeof mod.debugCode).toBe('function');
    });

    it('should export analyzeError function', async () => {
      const mod = await import('../agents/CoderAgent.js');
      expect(typeof mod.analyzeError).toBe('function');
    });

    it('should export needsMemorySanitizer function', async () => {
      const mod = await import('../agents/CoderAgent.js');
      expect(typeof mod.needsMemorySanitizer).toBe('function');
    });

    it('should export getCoderAgentLanguages function', async () => {
      const mod = await import('../agents/CoderAgent.js');
      expect(typeof mod.getCoderAgentLanguages).toBe('function');
    });
  });
});
