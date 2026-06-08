/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Bloom Filter — Cấu trúc dữ liệu xác suất cho URL deduplication
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Mục tiêu: Kiểm tra "URL này đã được phân tích chưa?" trong O(1) với
 * RAM cực nhỏ (vài MB cho hàng chục triệu URL).
 *
 * Nguyên lý:
 *   - Mảng bit size M, khởi tạo toàn 0
 *   - K hàm băm h1, h2, ..., hk
 *   - Thêm item: băm qua K hàm, bit[h1(x)] = bit[h2(x)] = ... = 1
 *   - Kiểm tra: nếu bất kỳ bit nào = 0 → CHẮN CHẮN chưa tồn tại
 *              nếu tất cả bit = 1 → CÓ KHẢ NĂNG đã tồn tại (false positive)
 *
 * False positive rate: (1 - e^(-K*N/M))^K
 *   Với M=100MB, K=7, N=10M items → FPR ≈ 0.8%
 *
 * Ứng dụng:
 *   - AnalysisAgent: Kiểm tra URL đã phân tích chưa
 *   - webScout: Crawler tránh trùng lặp
 *   - LogAnalyzer: Phát hiện log mới
 *
 * @module lib/bloom_filter
 */

'use strict';

import crypto from 'crypto';

export class BloomFilter {
  /**
   * @param {number} expectedItems — Số item dự kiến (ví dụ: 10000000)
   * @param {number} [fpRate=0.01] — False positive rate (mặc định 1%)
   */
  constructor(expectedItems, fpRate = 0.01) {
    // Tính toán kích thước mảng bit tối ưu
    // M = -(N * ln(fpRate)) / (ln2)^2
    this.size = Math.ceil(-(expectedItems * Math.log(fpRate)) / (Math.LN2 ** 2));
    // K = (M/N) * ln2
    this.hashCount = Math.ceil((this.size / expectedItems) * Math.LN2);

    // Dùng Uint8Array tiết kiệm RAM (1 byte = 8 bits)
    this.bitArray = new Uint8Array(Math.ceil(this.size / 8));
    this.itemCount = 0;

    console.log(`[BloomFilter] Initialized: size=${this.size} bits (${(this.size / 8 / 1024 / 1024).toFixed(1)}MB), hashCount=${this.hashCount}, expectedItems=${expectedItems}, fpRate=${fpRate}`);
  }

  /**
   * Tạo K hash functions từ 2 hash cơ sở (Kirsch-Mitzenmacker optimization)
   * h_i(x) = (h1(x) + i * h2(x)) mod M
   */
  _hashes(item) {
    const str = String(item);
    const h1 = parseInt(crypto.createHash('md5').update(str).digest('hex').slice(0, 8), 16);
    const h2 = parseInt(crypto.createHash('sha256').update(str).digest('hex').slice(0, 8), 16);
    const positions = [];
    for (let i = 0; i < this.hashCount; i++) {
      positions.push((h1 + i * h2) % this.size);
    }
    return positions;
  }

  /**
   * Thêm item vào filter
   * @param {string} item — URL hoặc string cần thêm
   */
  add(item) {
    for (const pos of this._hashes(item)) {
      const byteIndex = Math.floor(pos / 8);
      const bitIndex = pos % 8;
      this.bitArray[byteIndex] |= (1 << bitIndex);
    }
    this.itemCount++;
  }

  /**
   * Kiểm tra item có thể đã tồn tại không
   * @param {string} item
   * @returns {boolean} — true = có thể đã tồn tại, false = chắc chắn chưa
   */
  mightContain(item) {
    for (const pos of this._hashes(item)) {
      const byteIndex = Math.floor(pos / 8);
      const bitIndex = pos % 8;
      if (!(this.bitArray[byteIndex] & (1 << bitIndex))) {
        return false; // Chắc chắn chưa tồn tại
      }
    }
    return true; // Có thể đã tồn tại (false positive rate ~1%)
  }

  /**
   * Kết hợp add + check trong 1 bước (tiết kiệm hash computation)
   * @param {string} item
   * @returns {boolean} — true nếu item ĐÃ tồn tại trước đó
   */
  addAndCheck(item) {
    let existed = true;
    for (const pos of this._hashes(item)) {
      const byteIndex = Math.floor(pos / 8);
      const bitIndex = pos % 8;
      if (!(this.bitArray[byteIndex] & (1 << bitIndex))) {
        existed = false;
        this.bitArray[byteIndex] |= (1 << bitIndex);
      }
    }
    this.itemCount++;
    return existed;
  }

  /** Số item đã thêm */
  get count() { return this.itemCount; }

  /** Kích thước RAM (bytes) */
  get memoryBytes() { return this.bitArray.length; }

  /** Thống kê */
  stats() {
    return {
      items: this.itemCount,
      sizeBits: this.size,
      sizeMB: (this.size / 8 / 1024 / 1024).toFixed(2),
      hashCount: this.hashCount,
      memoryBytes: this.memoryBytes,
      fillRatio: (this.bitArray.reduce((sum, b) => sum + this._popcount(b), 0) / this.size * 100).toFixed(1) + '%',
    };
  }

  /** Đếm số bit = 1 trong 1 byte */
  _popcount(byte) {
    let count = 0;
    while (byte) { count += byte & 1; byte >>= 1; }
    return count;
  }

  /** Serialize để lưu vào file */
  toJSON() {
    return {
      size: this.size,
      hashCount: this.hashCount,
      itemCount: this.itemCount,
      data: Buffer.from(this.bitArray).toString('base64'),
    };
  }

  /** Load từ file */
  static fromJSON(json) {
    const filter = Object.create(BloomFilter.prototype);
    filter.size = json.size;
    filter.hashCount = json.hashCount;
    filter.itemCount = json.itemCount;
    filter.bitArray = new Uint8Array(Buffer.from(json.data, 'base64'));
    return filter;
  }
}

export default BloomFilter;
