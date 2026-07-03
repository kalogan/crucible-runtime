import { ToolRegistry } from '../registry.js';
import { readFile, listDir, writeFile } from './fs.js';
import { grep } from './search.js';
import { runCommand } from './exec.js';

export { readFile, listDir, writeFile, grep, runCommand };

/** The v0.1 tool set — exactly five (V0.1_SPEC.md §6). */
export function standardRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(readFile)
    .register(listDir)
    .register(grep)
    .register(writeFile)
    .register(runCommand);
}
