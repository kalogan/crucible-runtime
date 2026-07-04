import { describe, expect, it } from 'vitest';
import { parseDuration } from '../src/duration.js';

describe('parseDuration', () => {
  it('parses a single segment for each unit', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('1s')).toBe(1000);
    expect(parseDuration('2m')).toBe(120_000);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('1d')).toBe(86_400_000);
  });

  it('sums multiple back-to-back segments', () => {
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('1h30m15s')).toBe(5_415_000);
    expect(parseDuration('2d12h')).toBe(216_000_000);
  });

  it('accepts a larger count than its unit boundary', () => {
    expect(parseDuration('90m')).toBe(5_400_000);
    expect(parseDuration('1500ms')).toBe(1_500);
  });

  it('treats zero as valid', () => {
    expect(parseDuration('0s')).toBe(0);
  });

  it('ignores surrounding whitespace', () => {
    expect(parseDuration('   2h   ')).toBe(7_200_000);
  });

  it('does not confuse the minute and millisecond units', () => {
    // "m" is minutes, "ms" is milliseconds — a naive parser conflates them.
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('5ms')).toBe(5);
    expect(parseDuration('1m1ms')).toBe(60_001);
  });

  it('throws on the empty string', () => {
    expect(() => parseDuration('')).toThrow();
    expect(() => parseDuration('   ')).toThrow();
  });

  it('throws on an unknown unit', () => {
    expect(() => parseDuration('1x')).toThrow();
    expect(() => parseDuration('10y')).toThrow();
  });

  it('throws on a number with no unit', () => {
    expect(() => parseDuration('10')).toThrow();
    expect(() => parseDuration('1h30')).toThrow();
  });

  it('throws on non-integer or malformed input', () => {
    expect(() => parseDuration('1.5h')).toThrow();
    expect(() => parseDuration('abc')).toThrow();
    expect(() => parseDuration('h')).toThrow();
    expect(() => parseDuration('-1h')).toThrow();
  });
});
