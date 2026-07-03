import { describe, expect, it } from 'vitest';
import { overlaps } from '../src/interval.js';

describe('overlaps (closed intervals)', () => {
  it('returns false for disjoint intervals', () => {
    expect(overlaps({ start: 1, end: 3 }, { start: 5, end: 8 })).toBe(false);
    expect(overlaps({ start: 5, end: 8 }, { start: 1, end: 3 })).toBe(false);
  });

  it('returns true for clearly overlapping intervals', () => {
    expect(overlaps({ start: 1, end: 5 }, { start: 3, end: 9 })).toBe(true);
    expect(overlaps({ start: 3, end: 9 }, { start: 1, end: 5 })).toBe(true);
  });

  it('returns true for intervals that touch at a boundary point', () => {
    // Closed intervals include their endpoints: [1,5] and [5,9] share the
    // point 5, so they overlap.
    expect(overlaps({ start: 1, end: 5 }, { start: 5, end: 9 })).toBe(true);
    expect(overlaps({ start: 5, end: 9 }, { start: 1, end: 5 })).toBe(true);
  });
});
