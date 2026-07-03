// Append-only JSONL journal (ARCHITECTURE.md §12). The writer appends each
// event synchronously BEFORE the loop applies the corresponding state change
// (write-ahead ordering); the reader reconstructs session state for replay
// validation (V0.1_SPEC.md §8.3).
//
// Guarantee scope (v0.1, deliberate): deterministic replay after SUCCESSFUL
// COMPLETION — per-event writes go through the OS page cache and are fsynced
// at header and close only, so the journal tail is not crash-durable yet.
// Durable write-ahead persistence is v0.4 work (docs/HARDENING.md D1); do not
// build salvage/resume on today's writer.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EventSink, RuntimeEvent } from '../core/events.js';
import type { SessionState } from '../core/session.js';
import type { RuntimeMessage } from '../core/messages.js';
import type { TurnResult } from '../core/loop.js';

export const JOURNAL_VERSION = 1;

export interface JournalHeader {
  type: 'journal_header';
  journalVersion: number;
  /** Opaque run configuration snapshot (model, seed, prompt version, …). */
  config: Record<string, unknown>;
}

export interface TranscriptWriter {
  sink: EventSink;
  filePath: string;
  close(): void;
}

export function createTranscriptWriter(
  filePath: string,
  config: Record<string, unknown>,
): TranscriptWriter {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, 'a');
  const header: JournalHeader = { type: 'journal_header', journalVersion: JOURNAL_VERSION, config };
  fs.writeSync(fd, JSON.stringify(header) + '\n');
  fs.fsyncSync(fd);
  return {
    filePath,
    sink: (event: RuntimeEvent): void => {
      // Synchronous append = the write-ahead guarantee.
      fs.writeSync(fd, JSON.stringify(event) + '\n');
    },
    close(): void {
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    },
  };
}

export interface Journal {
  header: JournalHeader | null;
  events: RuntimeEvent[];
}

export function readJournal(filePath: string): Journal {
  const lines = fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  let header: JournalHeader | null = null;
  const events: RuntimeEvent[] = [];
  for (const line of lines) {
    const parsed = JSON.parse(line) as { type: string };
    if (parsed.type === 'journal_header') header = parsed as JournalHeader;
    else events.push(parsed as RuntimeEvent);
  }
  return { header, events };
}

/**
 * Rebuild the final session state from the journal alone. Any structural
 * defect (missing events, seq gaps) throws — the caller records it as a
 * replay mismatch.
 */
export function reconstructSession(journal: Journal): SessionState {
  let messages: RuntimeMessage[] | null = null;
  let lastTurn: TurnResult | null = null;
  let expectedSeq = 0;

  for (const event of journal.events) {
    expectedSeq += 1;
    if (event.seq !== expectedSeq) {
      throw new Error(`journal seq gap: expected ${expectedSeq}, found ${event.seq}`);
    }
    switch (event.type) {
      case 'turn_started':
        messages = structuredClone(event.messages);
        break;
      case 'infer_response':
        if (messages === null) throw new Error('infer_response before turn_started');
        messages.push(event.message);
        break;
      case 'tool_result':
        if (messages === null) throw new Error('tool_result before turn_started');
        messages.push(event.message);
        break;
      case 'turn_finished':
        lastTurn = event.result;
        break;
      case 'infer_request':
      case 'provider_retry':
      case 'tool_call':
      case 'policy_denied':
      case 'session_error':
        break; // observational; carry no session state
    }
  }
  if (messages === null) throw new Error('journal contains no turn_started event');
  return { messages, lastTurn };
}

/** Canonical JSON (sorted keys) so deep-equality is key-order independent. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}
