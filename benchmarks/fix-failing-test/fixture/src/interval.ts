export interface Interval {
  /** Inclusive lower bound. */
  start: number;
  /** Inclusive upper bound. */
  end: number;
}

/**
 * Whether two closed intervals share at least one point.
 * Closed means the endpoints belong to the interval, so [1,5] and [5,9]
 * overlap at the single point 5.
 */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}
