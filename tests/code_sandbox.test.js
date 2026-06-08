import { describe, it, expect, beforeAll } from '@jest/globals';
import { executeCode, getSupportedLanguages } from '../lib/code_sandbox.js';

describe('Code Sandbox - Security & Execution', () => {
  describe('Language Support', () => {
    it('should support all expected languages', () => {
      const langs = getSupportedLanguages();
      expect(langs).toContain('python');
      expect(langs).toContain('javascript');
      expect(langs).toContain('c');
      expect(langs).toContain('cpp');
      expect(langs).toContain('java');
      expect(langs).toContain('rust');
      expect(langs).toContain('go');
      expect(langs).toContain('csharp');
    });
  });

  describe('Security - Dangerous Code Blocking', () => {
    it('should block rm -rf /', async () => {
      const result = await executeCode('import os; os.system("rm -rf /")', 'python');
      expect(result.blocked).toBe(true);
      expect(result.success).toBe(false);
    });

    it('should block os.system calls', async () => {
      const result = await executeCode('import os; os.system("ls")', 'python');
      expect(result.blocked).toBe(true);
    });

    it('should block subprocess', async () => {
      const result = await executeCode('import subprocess; subprocess.run(["ls"])', 'python');
      expect(result.blocked).toBe(true);
    });

    it('should block eval()', async () => {
      const result = await executeCode('eval("console.log(1)")', 'javascript');
      expect(result.blocked).toBe(true);
    });

    it('should block while(true) infinite loop', async () => {
      const result = await executeCode('while(true){}', 'javascript');
      expect(result.blocked).toBe(true);
    });

    it('should block for(;;) infinite loop', async () => {
      const result = await executeCode('for(;;){}', 'javascript');
      expect(result.blocked).toBe(true);
    });

    it('should block child_process require', async () => {
      const result = await executeCode('const cp = require("child_process")', 'javascript');
      expect(result.blocked).toBe(true);
    });

    it('should block process.exit', async () => {
      const result = await executeCode('process.exit(1)', 'javascript');
      expect(result.blocked).toBe(true);
    });
  });

  describe('Python Execution', () => {
    it('should run simple Python code', async () => {
      const result = await executeCode('print("Hello, World!")', 'python');
      expect(result.success).toBe(true);
      expect(result.output).toContain('Hello, World!');
      expect(result.language).toBe('python');
    });

    it('should handle Python math operations', async () => {
      const result = await executeCode('print(2 + 2 * 10)', 'python');
      expect(result.success).toBe(true);
      expect(result.output.trim()).toBe('22');
    });

    it('should capture Python errors', async () => {
      const result = await executeCode('print(undefined_var)', 'python');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should timeout long-running Python code', async () => {
      const result = await executeCode(
        'import time\nwhile True: time.sleep(1)',
        'python'
      );
      expect(result.timedOut).toBe(true);
    }, 15000);
  });

  describe('JavaScript Execution', () => {
    it('should run simple JS code', async () => {
      const result = await executeCode('console.log("Hello JS")', 'javascript');
      expect(result.success).toBe(true);
      expect(result.output).toContain('Hello JS');
    });

    it('should handle JS array operations', async () => {
      const result = await executeCode(
        'const arr = [1,2,3,4,5]; console.log(arr.reduce((a,b) => a+b, 0));',
        'javascript'
      );
      expect(result.success).toBe(true);
      expect(result.output.trim()).toBe('15');
    });
  });

  describe('Auto Language Detection', () => {
    it('should detect Python from def keyword', async () => {
      const result = await executeCode('def hello():\n  print("hi")\nhello()');
      expect(result.language).toBe('python');
      expect(result.success).toBe(true);
    });

    it('should detect JavaScript from console.log', async () => {
      const result = await executeCode('console.log("test")');
      expect(result.language).toBe('javascript');
    });

    it('should detect C from #include', async () => {
      // This will fail to compile without gcc, but should detect as C
      const result = await executeCode('#include <stdio.h>\nint main(){return 0;}');
      expect(result.language).toBe('c');
    });

    it('should detect C++ from iostream', async () => {
      const result = await executeCode('#include <iostream>\nint main(){return 0;}');
      expect(result.language).toBe('cpp');
    });

    it('should detect Java from public class', async () => {
      const result = await executeCode('public class Main { public static void main(String[] args){} }');
      expect(result.language).toBe('java');
    });

    it('should detect Rust from fn main', async () => {
      const result = await executeCode('fn main() { println!("hello"); }');
      expect(result.language).toBe('rust');
    });

    it('should detect Go from package main', async () => {
      const result = await executeCode('package main\nfunc main() {}');
      expect(result.language).toBe('go');
    });
  });

  describe('Sandbox Cleanup', () => {
    it('should return exit code', async () => {
      const result = await executeCode('print("test")', 'python');
      expect(result.exitCode).toBeDefined();
      expect(result.exitCode).toBe(0);
    });

    it('should handle syntax errors gracefully', async () => {
      const result = await executeCode('def broken(', 'python');
      expect(result.success).toBe(false);
    });
  });
});
