/**
 * Parse a human-readable duration string into a whole number of milliseconds.
 *
 * A duration is one or more `<integer><unit>` segments written back-to-back,
 * summed together. Supported units:
 *   - `ms` milliseconds
 *   - `s`  seconds (1000 ms)
 *   - `m`  minutes (60 s)
 *   - `h`  hours   (60 m)
 *   - `d`  days    (24 h)
 *
 * Examples:
 *   parseDuration('500ms')    === 500
 *   parseDuration('2m')       === 120000
 *   parseDuration('1h30m')    === 5400000
 *   parseDuration('1h30m15s') === 5415000
 *   parseDuration('  2h  ')   === 7200000   (surrounding whitespace is ignored)
 *
 * Rules:
 *   - Numbers are non-negative integers. No decimals, no signs.
 *   - The ENTIRE string (after trimming) must be valid consecutive segments.
 *   - Invalid input throws an Error. Invalid includes: the empty string,
 *     an unknown unit (e.g. '1x'), a number with no unit (e.g. '10'), a
 *     non-integer (e.g. '1.5h'), or any stray characters.
 *
 * This is the only file you should change.
 */
export function parseDuration(_input: string): number {
  throw new Error('not implemented');
}
