import * as fs from 'fs';
import * as path from 'path';

import type { TokenCounts } from '../../../core/src/provider.js';

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
export function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
export function counts(value: unknown, codex = false): TokenCounts | undefined {
  const record = object(value);
  const names: Record<keyof TokenCounts, string> = codex
    ? {
        input: 'input_tokens',
        cached: 'cached_input_tokens',
        cacheWrite: 'cache_write_input_tokens',
        output: 'output_tokens',
        reasoning: 'reasoning_output_tokens',
        tool: 'tool_tokens',
        total: 'total_tokens',
      }
    : {
        input: 'input',
        cached: 'cached',
        cacheWrite: 'cacheWrite',
        output: 'output',
        reasoning: 'thoughts',
        tool: 'tool',
        total: 'total',
      };
  const result: TokenCounts = {};
  for (const [key, field] of Object.entries(names)) {
    const count = number(record[field]);
    if (count !== undefined) result[key as keyof TokenCounts] = count;
  }
  return Object.keys(result).length ? result : undefined;
}

/** Fixed-depth traversal of transcript directories; never follows symlinks. */
export function filesUnder(
  root: string,
  depth: number,
  matches: (name: string) => boolean,
): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory() && depth > 0) files.push(...filesUnder(file, depth - 1, matches));
      else if (entry.isFile() && matches(entry.name)) files.push(file);
    }
  } catch {
    /* absent or unreadable provider directory */
  }
  return files;
}

export function formatToolStatus(name: string, input?: unknown): string {
  const args = object(input);
  const file = string(args.file_path) ?? string(args.path) ?? string(args.filename);
  if (file) return `${name}: ${path.basename(file)}`;
  return `Using ${name}`;
}
