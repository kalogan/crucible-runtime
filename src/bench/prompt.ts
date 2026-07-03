// Minimal v0.1 prompt loading: markdown with `version:` frontmatter and
// {{placeholder}} substitution. No logic in templates — anything conditional
// is decided in TypeScript and passed in as a value (ARCHITECTURE.md §8).

import * as fs from 'node:fs';

export interface PromptFile {
  version: string;
  body: string;
}

export function loadPrompt(filePath: string): PromptFile {
  const raw = fs.readFileSync(filePath, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (!match) throw new Error(`prompt file missing frontmatter: ${filePath}`);
  const versionLine = /(?:^|\n)version:\s*(\S+)/.exec(match[1] ?? '');
  if (!versionLine) throw new Error(`prompt frontmatter missing version: ${filePath}`);
  return { version: versionLine[1]!, body: raw.slice(match[0].length).trim() };
}

export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`unbound prompt placeholder: {{${key}}}`);
    return value;
  });
}
