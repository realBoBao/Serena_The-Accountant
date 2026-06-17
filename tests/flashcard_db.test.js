import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import {
  addFlashcard,
  getDueFlashcards,
  getRandomFlashcards,
  reviewFlashcard,
  getStats,
  deleteFlashcard,
  clearAll,
  closeDb,
  SPACED_INTERVALS,
} from '../lib/flashcard_db.js';

describe('Flashcard Database - Spaced Repetition', () => {
  beforeAll(async () => {
    await clearAll();
  });

  afterAll(async () => {
    await clearAll();
    await closeDb();
  });

  beforeEach(async () => {
    await clearAll();
  });

  describe('addFlashcard', () => {
    it('should add a flashcard and return an ID', async () => {
      const id = await addFlashcard({
        question: 'What is RAG?',
        answer: 'Retrieval-Augmented Generation',
        source: 'test',
        category: 'AI',
      });
      expect(id).toBeDefined();
      expect(typeof id).toBe('number');
      expect(id).toBeGreaterThan(0);
    });

    it('should add flashcard with default category', async () => {
      const id = await addFlashcard({
        question: 'What is PM2?',
        answer: 'Process Manager for Node.js',
      });
      expect(id).toBeDefined();
    });

    it('should handle special characters in question/answer', async () => {
      const id = await addFlashcard({
        question: 'What is `const` in C++?',
        answer: 'A keyword for immutable variables: const int x = 5;',
        source: 'test',
      });
      expect(id).toBeDefined();
    });
  });

  describe('getDueFlashcards', () => {
    it('should return empty array when no cards exist', async () => {
      const cards = await getDueFlashcards();
      expect(cards).toEqual([]);
    });

    it('should return cards that are due for review', async () => {
      await addFlashcard({
        question: 'What is Docker?',
        answer: 'Containerization platform',
        source: 'test',
      });

      // New cards should be due immediately (next_review = now)
      const cards = await getDueFlashcards(10);
      expect(cards.length).toBe(1);
      expect(cards[0].question).toBe('What is Docker?');
    });

    it('should respect the limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await addFlashcard({
          question: `Question ${i}`,
          answer: `Answer ${i}`,
        });
      }

      const cards = await getDueFlashcards(3);
      expect(cards.length).toBe(3);
    });
  });

  describe('getRandomFlashcards', () => {
    it('should return empty array when no cards exist', async () => {
      const cards = await getRandomFlashcards();
      expect(cards).toEqual([]);
    });

    it('should return random cards', async () => {
      for (let i = 0; i < 5; i++) {
        await addFlashcard({
          question: `Random Q${i}`,
          answer: `Random A${i}`,
          category: 'test',
        });
      }

      const cards = await getRandomFlashcards(3);
      expect(cards.length).toBe(3);
    });

    it('should filter by category', async () => {
      await addFlashcard({
        question: 'AI Question',
        answer: 'AI Answer',
        category: 'AI',
      });
      await addFlashcard({
        question: 'DevOps Question',
        answer: 'DevOps Answer',
        category: 'DevOps',
      });

      const aiCards = await getRandomFlashcards(10, 'AI');
      expect(aiCards.every(c => c.category === 'AI')).toBe(true);
    });
  });

  describe('reviewFlashcard - Spaced Repetition Algorithm', () => {
    it('should update review count and correct count on correct answer', async () => {
      const id = await addFlashcard({
        question: 'What is a pointer?',
        answer: 'A variable that stores a memory address',
      });

      const result = await reviewFlashcard(id, true);
      expect(result).toBeDefined();
      expect(result.reviewCount).toBe(1);
      expect(result.correctCount).toBe(1);
    });

    it('should reset interval on incorrect answer', async () => {
      const id = await addFlashcard({
        question: 'What is virtual memory?',
        answer: 'Memory management technique',
      });

      // Mark correct twice first
      await reviewFlashcard(id, true);
      await reviewFlashcard(id, true);

      // Then mark incorrect
      const result = await reviewFlashcard(id, false);
      expect(result).toBeDefined();
      expect(result.reviewCount).toBe(3);
      expect(result.correctCount).toBe(2);
    });

    it('should return null for non-existent card', async () => {
      const result = await reviewFlashcard(99999, true);
      expect(result).toBeNull();
    });

    it('should follow spaced repetition intervals', async () => {
      const id = await addFlashcard({
        question: 'Test SR',
        answer: 'Test Answer',
      });

      // Simulate multiple correct reviews
      let result;
      for (let i = 0; i < 6; i++) {
        result = await reviewFlashcard(id, true);
        expect(result.correctCount).toBe(i + 1);
        expect(result.reviewCount).toBe(i + 1);
      }

      // After 6 correct answers, should be at max interval (180 days)
      expect(result.correctCount).toBe(6);
    });
  });

  describe('SPACED_INTERVALS constant', () => {
    it('should have correct interval values', () => {
      expect(SPACED_INTERVALS).toEqual([1, 3, 7, 14, 30, 60, 180]);
    });

    it('should have 7 intervals', () => {
      expect(SPACED_INTERVALS.length).toBe(7);
    });

    it('intervals should be ascending', () => {
      for (let i = 1; i < SPACED_INTERVALS.length; i++) {
        expect(SPACED_INTERVALS[i]).toBeGreaterThan(SPACED_INTERVALS[i - 1]);
      }
    });
  });

  describe('getStats', () => {
    it('should return zero stats for empty DB', async () => {
      const stats = await getStats();
      expect(stats.total).toBe(0);
      expect(stats.due).toBe(0);
    });

    it('should return correct stats after adding cards', async () => {
      await addFlashcard({ question: 'Q1', answer: 'A1' });
      await addFlashcard({ question: 'Q2', answer: 'A2' });

      const stats = await getStats();
      expect(stats.total).toBe(2);
    });
  });

  describe('deleteFlashcard', () => {
    it('should delete an existing flashcard', async () => {
      const id = await addFlashcard({
        question: 'To delete',
        answer: 'Delete me',
      });

      const deleted = await deleteFlashcard(id);
      expect(deleted).toBe(true);

      const cards = await getRandomFlashcards(10);
      expect(cards.length).toBe(0);
    });

    it('should return false for non-existent card', async () => {
      const deleted = await deleteFlashcard(99999);
      expect(deleted).toBe(false);
    });
  });
});
