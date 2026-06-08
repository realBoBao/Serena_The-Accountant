/**
 * Multi-Armed Bandit Algorithms for Prompt Strategy Optimization
 *
 * Implements Thompson Sampling (Bayesian) and UCB (Upper Confidence Bound)
 * for adaptive prompt strategy selection.
 *
 * Thompson Sampling uses Beta distribution:
 * - Each arm maintains (alpha, beta) = (successes + 1, failures + 1)
 * - Sample from Beta(alpha, beta) for each arm
 * - Select arm with highest sample
 * - Update based on observed reward (0-1)
 *
 * This is more efficient than static A/B testing because it automatically
 * shifts traffic to better-performing strategies while still exploring.
 *
 * Integration: Used by RagAgent.invokeLlm to select prompt strategy.
 */

import { getLogger } from './logger.js';

const logger = getLogger('Bandit');

// ── Beta Distribution Sampling ──
// Uses the relationship: Beta(a,b) = Gamma(a) / (Gamma(a) + Gamma(b))
// where Gamma(n) for integer n is (n-1)!

function sampleGamma(shape) {
  // Marsaglia and Tsang's method for Gamma sampling
  if (shape < 1) {
    return sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do {
      x = normalRandom();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function normalRandom() {
  // Box-Muller transform
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function sampleBeta(alpha, beta) {
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  return x / (x + y);
}

// ── Thompson Sampling Bandit ──

class ThompsonSamplingBandit {
  constructor(armNames, opts = {}) {
    this.arms = new Map();
    for (const name of armNames) {
      this.arms.set(name, {
        name,
        alpha: 1,  // successes + 1 (prior)
        beta: 1,   // failures + 1 (prior)
        pulls: 0,
        totalReward: 0,
      });
    }
    this.totalPulls = 0;
    this.explorationRate = opts.explorationRate ?? 0.1;
  }

  /**
   * Select an arm using Thompson Sampling.
   * With probability explorationRate, pick random (forced exploration).
   */
  selectArm() {
    // Forced exploration
    if (Math.random() < this.explorationRate) {
      const names = Array.from(this.arms.keys());
      return names[Math.floor(Math.random() * names.length)];
    }

    // Thompson Sampling: sample from each arm's Beta distribution
    let bestArm = null;
    let bestSample = -1;

    for (const [name, arm] of this.arms) {
      const sample = sampleBeta(arm.alpha, arm.beta);
      if (sample > bestSample) {
        bestSample = sample;
        bestArm = name;
      }
    }

    return bestArm;
  }

  /**
   * Update an arm with observed reward (0-1).
   */
  update(armName, reward) {
    const arm = this.arms.get(armName);
    if (!arm) return;

    // Clamp reward to [0, 1]
    const r = Math.max(0, Math.min(1, reward));

    // Bayesian update: Beta(alpha + r, beta + (1 - r))
    arm.alpha += r;
    arm.beta += (1 - r);
    arm.pulls++;
    arm.totalReward += r;
    this.totalPulls++;
  }

  /**
   * Get statistics for all arms.
   */
  getStats() {
    const stats = {};
    for (const [name, arm] of this.arms) {
      stats[name] = {
        pulls: arm.pulls,
        avgReward: arm.pulls > 0 ? Math.round((arm.totalReward / arm.pulls) * 1000) / 1000 : 0,
        alpha: Math.round(arm.alpha * 100) / 100,
        beta: Math.round(arm.beta * 100) / 100,
        // Expected value of Beta distribution
        expectedValue: Math.round((arm.alpha / (arm.alpha + arm.beta)) * 1000) / 1000,
      };
    }
    return { totalPulls: this.totalPulls, arms: stats };
  }

  /**
   * Get the best performing arm (highest expected value).
   */
  getBestArm() {
    let best = null;
    let bestValue = -1;
    for (const [name, arm] of this.arms) {
      const ev = arm.alpha / (arm.alpha + arm.beta);
      if (ev > bestValue) {
        bestValue = ev;
        best = name;
      }
    }
    return { name: best, expectedValue: Math.round(bestValue * 1000) / 1000 };
  }
}

// ── UCB (Upper Confidence Bound) Bandit ──

class UCBBandit {
  constructor(armNames, opts = {}) {
    this.arms = new Map();
    for (const name of armNames) {
      this.arms.set(name, {
        name,
        pulls: 0,
        totalReward: 0,
      });
    }
    this.totalPulls = 0;
    this.c = opts.explorationConstant ?? Math.sqrt(2);
  }

  /**
   * Select arm using UCB1 formula:
   * arm = argmax(avg_reward + c * sqrt(ln(total_pulls) / arm_pulls))
   */
  selectArm() {
    // First, try each arm at least once
    for (const [name, arm] of this.arms) {
      if (arm.pulls === 0) return name;
    }

    let bestArm = null;
    let bestUCB = -1;

    for (const [name, arm] of this.arms) {
      const avgReward = arm.totalReward / arm.pulls;
      const exploration = this.c * Math.sqrt(Math.log(this.totalPulls) / arm.pulls);
      const ucb = avgReward + exploration;

      if (ucb > bestUCB) {
        bestUCB = ucb;
        bestArm = name;
      }
    }

    return bestArm;
  }

  update(armName, reward) {
    const arm = this.arms.get(armName);
    if (!arm) return;
    const r = Math.max(0, Math.min(1, reward));
    arm.pulls++;
    arm.totalReward += r;
    this.totalPulls++;
  }

  getStats() {
    const stats = {};
    for (const [name, arm] of this.arms) {
      stats[name] = {
        pulls: arm.pulls,
        avgReward: arm.pulls > 0 ? Math.round((arm.totalReward / arm.pulls) * 1000) / 1000 : 0,
      };
    }
    return { totalPulls: this.totalPulls, arms: stats };
  }
}

// ── Singleton Instances ──

let _promptBandit = null;

/**
 * Get or create the prompt strategy bandit.
 * Uses Thompson Sampling by default.
 */
export function getPromptBandit(strategies = null) {
  if (!_promptBandit) {
    const arms = strategies || ['concise', 'detailed', 'step_by_step', 'socratic'];
    _promptBandit = new ThompsonSamplingBandit(arms, { explorationRate: 0.1 });
    logger.info(`[Bandit] Initialized Thompson Sampling with arms: ${arms.join(', ')}`);
  }
  return _promptBandit;
}

/**
 * Select the best prompt strategy for the current query.
 * Called by RagAgent.invokeLlm before making the LLM call.
 *
 * @param {string} queryType - Type of query (general, code, math, etc.)
 * @returns {{ strategy: string, modifier: string }}
 */
export function selectPromptStrategy(queryType = 'general') {
  const bandit = getPromptBandit();
  const strategy = bandit.selectArm();

  const modifiers = {
    concise: 'Trả lời ngắn gọn, đi thẳng vào vấn đề. Tối đa 3-5 câu.',
    detailed: 'Trả lời chi tiết, đầy đủ. Bao gồm ví dụ minh họa và giải thích rõ ràng.',
    step_by_step: 'Trả lời theo từng bước (step-by-step). Đánh số từng bước và giải thích logic.',
    socratic: 'Dùng phương pháp Socratic — hướng dẫn người dùng tự tìm ra câu trả lời bằng câu hỏi gợi ý.',
  };

  return {
    strategy,
    modifier: modifiers[strategy] || '',
    promptModifier: modifiers[strategy] ? `\n\n[Phong cách trả lời: ${modifiers[strategy]}]` : '',
  };
}

/**
 * Record feedback for the bandit (called after user interaction).
 * @param {string} strategy - The strategy that was used
 * @param {number} reward - Quality score 0-1 (from user feedback or auto-evaluation)
 */
export function recordBanditFeedback(strategy, reward) {
  const bandit = getPromptBandit();
  bandit.update(strategy, reward);
  logger.debug(`[Bandit] Updated "${strategy}" with reward ${reward.toFixed(2)}`);
}

/**
 * Get bandit statistics for monitoring.
 */
export function getBanditStats() {
  const bandit = getPromptBandit();
  return {
    ...bandit.getStats(),
    best: bandit.getBestArm(),
  };
}

export { ThompsonSamplingBandit, UCBBandit };
