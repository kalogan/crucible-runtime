import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadPrompt, interpolate } from '../../src/bench/prompt.js';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-prompt-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const LF_PROMPT = '---\nversion: 3\n---\nYou are {{who}}.\n';

describe('loadPrompt', () => {
  it('parses LF prompts', () => {
    const file = path.join(dir, 'lf.md');
    fs.writeFileSync(file, LF_PROMPT);
    const prompt = loadPrompt(file);
    expect(prompt.version).toBe('3');
    expect(prompt.body).toBe('You are {{who}}.');
  });

  it('parses CRLF prompts identically (Windows checkout)', () => {
    const file = path.join(dir, 'crlf.md');
    fs.writeFileSync(file, LF_PROMPT.replace(/\n/g, '\r\n'));
    const prompt = loadPrompt(file);
    expect(prompt.version).toBe('3');
    expect(prompt.body).toBe('You are {{who}}.');
  });

  it('throws on missing frontmatter', () => {
    const file = path.join(dir, 'bare.md');
    fs.writeFileSync(file, 'no frontmatter here\n');
    expect(() => loadPrompt(file)).toThrow(/frontmatter/);
  });
});

describe('interpolate', () => {
  it('substitutes placeholders and throws on unbound ones', () => {
    expect(interpolate('You are {{who}}.', { who: 'the Architect' })).toBe('You are the Architect.');
    expect(() => interpolate('{{missing}}', {})).toThrow(/unbound/);
  });
});
