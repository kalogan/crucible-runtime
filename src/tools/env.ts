// H3 (HARDENING.md): run_command must not inherit the ambient environment.
// A shell command issued by the model would otherwise see every secret in the
// host shell (API keys, tokens, cloud creds). We forward an explicit allowlist
// of OS/toolchain infrastructure variables — enough for node/pnpm/git to run,
// nothing that carries a credential — and force CI=true.

// Uppercased names; matching is case-insensitive because Windows uses `Path`,
// `TEMP`, etc. with varying case. These are non-secret infrastructure vars.
const ALLOWED = new Set(
  [
    // POSIX + cross-platform toolchain essentials
    'PATH',
    'PATHEXT',
    'HOME',
    'SHELL',
    'USER',
    'LOGNAME',
    'LANG',
    'LANGUAGE',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'TERM',
    'TMPDIR',
    'TEMP',
    'TMP',
    // Windows system infrastructure — node/pnpm genuinely need these to run
    // (pnpm's store lives under LOCALAPPDATA; the shell needs ComSpec/SystemRoot).
    'SYSTEMROOT',
    'SYSTEMDRIVE',
    'WINDIR',
    'COMSPEC',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMDATA',
    'PROGRAMW6432',
    'COMMONPROGRAMFILES',
    'COMMONPROGRAMFILES(X86)',
    'ALLUSERSPROFILE',
    'PUBLIC',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'PROCESSOR_IDENTIFIER',
  ].map((n) => n.toUpperCase()),
);

/**
 * Build a sanitized environment for a spawned command: allowlisted infra vars
 * from `source`, plus forced overrides (CI=true so test runners never enter
 * watch mode). `extraAllow` widens the allowlist for a specific benchmark if
 * ever needed; secrets in the ambient env are never forwarded.
 */
export function buildCommandEnv(
  source: NodeJS.ProcessEnv = process.env,
  extraAllow: string[] = [],
): NodeJS.ProcessEnv {
  const allow = new Set(ALLOWED);
  for (const name of extraAllow) allow.add(name.toUpperCase());

  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && allow.has(key.toUpperCase())) env[key] = value;
  }
  env['CI'] = 'true';
  return env;
}
