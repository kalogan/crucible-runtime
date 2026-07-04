import { ToolRegistry } from '../registry.js';
import { readFile, listDir, writeFile, editFile } from './fs.js';
import { grep, glob } from './search.js';
import { runCommand } from './exec.js';

export { readFile, listDir, writeFile, editFile, grep, glob, runCommand };

/**
 * The standard tool set. v0.1 shipped five; v0.2 adds edit_file and glob.
 * (Benchmarks pick their own allowlist via BenchmarkSpec.tools.allowed;
 * fix-failing-test still allows only the original five, so its baseline is
 * unchanged.)
 */
export function standardRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(readFile)
    .register(listDir)
    .register(grep)
    .register(glob)
    .register(writeFile)
    .register(editFile)
    .register(runCommand);
}
