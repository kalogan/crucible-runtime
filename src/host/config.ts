// Zod-validated runtime configuration. host/ is the only layer reading
// process.env (V0.1_SPEC.md §4).

import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

const configSchema = z.object({
  ollamaBaseUrl: z.string().url().default('http://127.0.0.1:11434'),
  scratchDir: z.string().default(path.join(os.tmpdir(), 'crucible-scratch')),
});

export type RuntimeConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return configSchema.parse({
    ...(env['OLLAMA_BASE_URL'] !== undefined ? { ollamaBaseUrl: env['OLLAMA_BASE_URL'] } : {}),
    ...(env['CRUCIBLE_SCRATCH_DIR'] !== undefined ? { scratchDir: env['CRUCIBLE_SCRATCH_DIR'] } : {}),
  });
}
