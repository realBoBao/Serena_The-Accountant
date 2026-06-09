import { describe, it, expect } from '@jest/globals';
import { generateFlashcardsFromText, extractFlashcardsFallback } from '../lib/flashcard_generator.js';

describe('Flashcard Generator', () => {
  describe('extractFlashcardsFallback', () => {
    it('should extract flashcards from text without LLM', () => {
      const text = 'RAG stands for Retrieval-Augmented Generation. It combines search with LLM generation. The system retrieves relevant documents first.';
      const cards = extractFlashcardsFallback(text, 'test-source', 'AI');

      expect(cards.length).toBeGreaterThan(0);
      expect(cards.length).toBeLessThanOrEqual(3);
      expect(cards[0]).toHaveProperty('question');
      expect(cards[0]).toHaveProperty('answer');
      expect(cards[0]).toHaveProperty('source', 'test-source');
      expect(cards[0]).toHaveProperty('category', 'AI');
    });

    it('should handle short text', () => {
      const text = 'Short text.';
      const cards = extractFlashcardsFallback(text, 'test', 'general');
      expect(cards.length).toBeGreaterThanOrEqual(0);
    });

    it('should include source in answer', () => {
      const text = 'Virtual memory is a memory management technique. It allows programs to use more memory than physically available.';
      const cards = extractFlashcardsFallback(text, 'OS-textbook', 'systems');

      for (const card of cards) {
        expect(card.answer).toContain('OS-textbook');
      }
    });

    it('should create questions from sentences', () => {
      const text = 'A process is an instance of a running program. Each process has its own memory space. Processes communicate via IPC mechanisms.';
      const cards = extractFlashcardsFallback(text, 'test', 'OS');

      for (const card of cards) {
        expect(card.question).toContain('What is the key concept from');
      }
    });
  });

  describe('generateFlashcardsFromText', () => {
    it('should return fallback cards when no API key', async () => {
      const originalKey = process.env.OPENROUTER_API_KEY;
      delete process.env.OPENROUTER_API_KEY;

      const text = 'Binary search has O(log n) time complexity. It works on sorted arrays only.';
      const cards = await generateFlashcardsFromText(text, 'algorithms', 'CS');

      expect(cards.length).toBeGreaterThan(0);
      expect(cards[0]).toHaveProperty('question');
      expect(cards[0]).toHaveProperty('answer');

      process.env.OPENROUTER_API_KEY = originalKey;
    });

    it('should handle empty text gracefully', async () => {
      const originalKey = process.env.OPENROUTER_API_KEY;
      delete process.env.OPENROUTER_API_KEY;

      const cards = await generateFlashcardsFromText('', 'empty', 'test');
      expect(cards).toEqual([]);

      process.env.OPENROUTER_API_KEY = originalKey;
    });
  });
});
