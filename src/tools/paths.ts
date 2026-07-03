import * as path from 'node:path';
import picomatch from 'picomatch';

/**
 * Resolve a model-supplied path inside the workspace. Anything that escapes
 * the root (absolute paths elsewhere, ../ traversal) is rejected — the
 * workspace boundary is mechanical, not behavioral.
 */
export function resolveInWorkspace(
  workspace: string,
  p: string,
): { ok: true; abs: string; rel: string } | { ok: false; reason: string } {
  const abs = path.resolve(workspace, p);
  if (abs !== workspace && !abs.startsWith(workspace + path.sep)) {
    return { ok: false, reason: `path escapes the workspace: ${p}` };
  }
  return { ok: true, abs, rel: path.relative(workspace, abs) || '.' };
}

/** Write allowlist check against workspace-relative picomatch globs. */
export function matchesSurface(rel: string, surface: string[]): boolean {
  return picomatch.isMatch(rel, surface, { dot: true });
}
