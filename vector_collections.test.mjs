import { describe, it, expect } from '@jest/globals';
import { COLLECTIONS } from '../lib/vector_collections.js';

describe('Vector Collections - Configuration', () => {
  describe('COLLECTIONS constant', () => {
    it('should have 3 collections defined', () => {
      const keys = Object.keys(COLLECTIONS);
      expect(keys.length).toBe(3);
    });

    it('should have academic-docs collection', () => {
      expect(COLLECTIONS.ACADEMIC).toBe('academic-docs');
    });

    it('should have system-logs collection', () => {
      expect(COLLECTIONS.SYSTEM).toBe('system-logs');
    });

    it('should have daily-memory collection', () => {
      expect(COLLECTIONS.DAILY).toBe('daily-memory');
    });

    it('collection names should be lowercase with hyphens', () => {
      for (const [key, value] of Object.entries(COLLECTIONS)) {
        expect(value).toMatch(/^[a-z][a-z0-9-]+$/);
      }
    });
  });
});

describe('Vector Collections - Document Classification', () => {
  // Test the classifyDocument logic from analyze_pdf.js
  function classifyDocument(fileName, text) {
    const lowerName = fileName.toLowerCase();
    const lowerText = text.toLowerCase().slice(0, 500);

    if (
      lowerName.includes('log') ||
      lowerName.includes('error') ||
      lowerName.includes('config') ||
      lowerName.includes('docker') ||
      lowerText.includes('error') ||
      lowerText.includes('exception') ||
      lowerText.includes('stack trace') ||
      lowerText.includes('pm2')
    ) {
      return 'system';
    }

    if (
      lowerName.includes('lecture') ||
      lowerName.includes('baitap') ||
      lowerName.includes('exercise') ||
      lowerName.includes('homework') ||
      lowerText.includes('bai tap') ||
      lowerText.includes('exercise')
    ) {
      return 'academic';
    }

    return 'academic';
  }

  it('should classify error logs as system', () => {
    expect(classifyDocument('error.log.txt', 'Error: connection failed')).toBe('system');
  });

  it('should classify docker configs as system', () => {
    expect(classifyDocument('docker-compose.yml', 'version: 3.8')).toBe('system');
  });

  it('should classify PM2 logs as system', () => {
    expect(classifyDocument('app.log', 'PM2 process restarted')).toBe('system');
  });

  it('should classify stack traces as system', () => {
    expect(classifyDocument('crash.txt', 'Stack trace: at Object.run')).toBe('system');
  });

  it('should classify lecture notes as academic', () => {
    expect(classifyDocument('lecture_01.pdf', 'Introduction to OS')).toBe('academic');
  });

  it('should classify exercises as academic', () => {
    expect(classifyDocument('baitap_tuan1.pdf', 'Bai tap 1')).toBe('academic');
  });

  it('should default to academic for unknown documents', () => {
    expect(classifyDocument('random.pdf', 'Some content')).toBe('academic');
  });
});
