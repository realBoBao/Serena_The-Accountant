/**
 * ═══════════════════════════════════════════════════════════════
 * FSRS (Free Spaced Repetition Scheduler) Algorithm
 * ═══════════════════════════════════════════════════════════════
 *
 * Dựa trên thuật toán FSRS-5 (open-source, state-of-the-art).
 * Thay thế hệ thống spaced repetition đơn giản bằng tính toán
 * độ khó (Difficulty) và độ ổn định (Stability) chính xác.
 *
 * Công thức: https://github.com/open-spaced-repetition/fsrs.js
 *
 * Được gọi bởi:
 * - flashcard_db.js (reviewFlashcard)
 * - scheduler.js (daily review cron)
 * - discord_bot.js (!quiz, !answer)
 */

// ── FSRS-5 Parameters (tối ưu cho người dùng phổ thông) ──
const FSRS_PARAMS = {
  w: [0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61],
  requestRetention: 0.9, // Mục tiêu ghi nhớ 90%
  maximumInterval: 365,  // Tối đa 1 năm
};

/**
 * Tính toán FSRS scheduling
 * @param {number} stability - Độ ổn định hiện tại (days)
 * @param {number} difficulty - Độ khó (1-10, 1 = dễ nhất)
 * @param {number} rating - Đánh giá: 1=Again, 2=Hard, 3=Good, 4=Easy
 * @param {number} elapsedDays - Số ngày kể từ lần review cuối
 * @returns {{ stability: number, difficulty: number, interval: number, due: Date }}
 */
export function fsrsSchedule(stability, difficulty, rating, elapsedDays = 0) {
  const { w, requestRetention, maximumInterval } = FSRS_PARAMS;

  // Clamp inputs
  stability = Math.max(0.1, stability || 1);
  difficulty = Math.min(10, Math.max(1, difficulty || 5));
  rating = Math.min(4, Math.max(1, Math.round(rating)));
  elapsedDays = Math.max(0, elapsedDays);

  let newStability = stability;
  let newDifficulty = difficulty;

  if (rating === 1) {
    // Again — quên hoàn toàn
    newDifficulty = Math.min(10, difficulty + w[11] * (1 - difficulty / 10));
    newStability = w[10] * Math.pow(stability, -w[12]) * (Math.exp((1 - requestRetention) * w[13]) - 1);
  } else if (rating === 2) {
    // Hard — nhớ nhưng khó
    newDifficulty = Math.min(10, difficulty + w[11] * (0.5 - difficulty / 10));
    newStability = stability * (1 + w[14] * Math.pow(difficulty, -w[15]) * Math.pow(stability, w[16]) * (Math.exp((1 - requestRetention) * w[17]) - 1));
  } else if (rating === 3) {
    // Good — nhớ bình thường
    newDifficulty = Math.max(1, difficulty - w[11] * (difficulty / 10 - 0.5));
    const retrievability = Math.exp(Math.log(0.9) * elapsedDays / stability);
    newStability = stability * (1 + w[8] * Math.pow(difficulty, -w[9]) * Math.pow(stability, w[0]) * (Math.exp((1 - retrievability) * w[1]) - 1));
  } else if (rating === 4) {
    // Easy — nhớ rất tốt
    newDifficulty = Math.max(1, difficulty - w[11] * (difficulty / 10));
    const retrievability = Math.exp(Math.log(0.9) * elapsedDays / stability);
    newStability = stability * (1 + w[8] * Math.pow(difficulty, -w[9]) * Math.pow(stability, w[0]) * (Math.exp((1 - retrievability) * w[1]) - 1)) * w[2];
  }

  // Clamp
  newStability = Math.max(0.1, Math.min(3650, newStability));
  newDifficulty = Math.min(10, Math.max(1, newDifficulty));

  // Calculate interval
  const interval = Math.min(maximumInterval, Math.round(newStability * Math.log(requestRetention) / Math.log(0.9)));

  // Calculate due date
  const due = new Date();
  due.setDate(due.getDate() + interval);

  return {
    stability: Math.round(newStability * 100) / 100,
    difficulty: Math.round(newDifficulty * 100) / 100,
    interval,
    due,
    rating,
  };
}

/**
 * Chuyển đổi boolean correct/incorrect → FSRS rating
 * @param {boolean} correct
 * @param {number} confidence - 1-3 (1=low, 2=medium, 3=high)
 * @returns {number} FSRS rating: 1=Again, 2=Hard, 3=Good, 4=Easy
 */
export function booleanToRating(correct, confidence = 2) {
  if (!correct) return 1; // Again
  if (confidence >= 3) return 4; // Easy
  if (confidence >= 2) return 3; // Good
  return 2; // Hard
}

/**
 * Lấy thông tin trạng thái flashcard
 * @param {object} card - Flashcard object từ DB
 * @returns {{ retrievability: number, status: string }}
 */
export function getCardStatus(card) {
  const now = Date.now();
  const nextReview = new Date(card.next_review || card.created_at).getTime();
  const elapsedDays = Math.max(0, (now - nextReview) / (1000 * 60 * 60 * 24));
  const stability = card.stability || 1;

  const retrievability = Math.exp(Math.log(0.9) * elapsedDays / stability);

  let status = 'new';
  if (elapsedDays < 0) status = 'learning';
  else if (retrievability > 0.9) status = 'mastered';
  else if (retrievability > 0.7) status = 'review';
  else status = 'lapsed';

  return {
    retrievability: Math.round(retrievability * 100) / 100,
    status,
    elapsedDays: Math.round(elapsedDays * 10) / 10,
  };
}

/**
 * Tạo flashcard mới với FSRS state
 * @param {object} card - { question, answer, source, category }
 * @returns {object} Card với FSRS fields
 */
export function createCardWithFsrs(card) {
  return {
    ...card,
    stability: 0.1,
    difficulty: 5,
    interval: 1,
    reps: 0,
    lapses: 0,
    state: 'new', // new, learning, review, relearning
    due: new Date().toISOString(),
  };
}
