import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type {
  TokenCounts,
  TranscriptFileLocation,
  TranscriptReader,
  TranscriptSnapshot,
} from '../../../../../core/src/provider.js';
import { pathsMatch } from '../../../pathKey.js';
import { counts, filesUnder, object, string } from '../../transcriptUtils.js';

export function geminiHome(): string {
  return path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini');
}

export function discoverGeminiSessions(workspaces: readonly string[]): TranscriptFileLocation[] {
  const result: TranscriptFileLocation[] = [];
  const roots = [geminiHome(), path.join(os.homedir(), '.cache', '.gemini')];
  for (const root of new Set(roots)) {
    const projects = new Map<string, string>();
    for (const cwd of workspaces)
      projects.set(crypto.createHash('sha256').update(cwd).digest('hex'), cwd);
    try {
      const registry = object(
        JSON.parse(fs.readFileSync(path.join(root, 'projects.json'), 'utf8')),
      );
      for (const [cwd, id] of Object.entries(object(registry.projects))) {
        if (typeof id === 'string' && /^[a-z0-9-]+$/.test(id)) projects.set(id, cwd);
      }
    } catch {
      /* older Gemini has no registry */
    }
    let dirs: fs.Dirent[];
    try {
      dirs = fs.readdirSync(path.join(root, 'tmp'), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const project = path.join(root, 'tmp', dir.name);
      let cwd = projects.get(dir.name);
      if (!cwd) {
        try {
          cwd = fs.readFileSync(path.join(project, '.project_root'), 'utf8').trim();
        } catch {
          /* older session */
        }
      }
      const chats = path.join(project, 'chats');
      for (const file of filesUnder(chats, 1, (name) => /\.jsonl?$/.test(name))) {
        result.push({
          path: file,
          cwd,
          parentSessionId: pathsMatch(path.dirname(file), chats)
            ? undefined
            : path.basename(path.dirname(file)),
        });
      }
    }
  }
  return result;
}

/** Replay semantics from Gemini v0.61.0 chatRecordingService.ts. Rewind excludes
 * its target message; an unknown rewind target clears the message history. */
export function createGeminiReader(): TranscriptReader {
  let metadata: Record<string, unknown> = {};
  const messages = new Map<string, Record<string, unknown>>();
  function replace(value: unknown) {
    messages.clear();
    if (Array.isArray(value)) for (const item of value) add(item);
  }
  function add(value: unknown) {
    const msg = object(value);
    if (typeof msg.id === 'string') messages.set(msg.id, msg);
  }
  return {
    accept(value) {
      const record = object(value);
      if (typeof record.$rewindTo === 'string') {
        const ids = [...messages.keys()];
        const index = ids.indexOf(record.$rewindTo);
        for (const id of index < 0 ? ids : ids.slice(index)) messages.delete(id);
      } else if (typeof record.id === 'string') add(record);
      else {
        const patch = record.$set !== undefined ? object(record.$set) : record;
        metadata = { ...metadata, ...patch };
        if (Array.isArray(patch.messages)) replace(patch.messages);
      }
    },
    snapshot() {
      const state: TranscriptSnapshot = {
        startedAt: Number.isFinite(Date.parse(String(metadata.startTime)))
          ? Date.parse(String(metadata.startTime))
          : undefined,
        sessionId: string(metadata.sessionId),
        cwd: Array.isArray(metadata.directories) ? string(metadata.directories[0]) : undefined,
        status: 'unknown',
        tools: new Map(),
      };
      let total: TokenCounts | undefined;
      let last: TokenCounts | undefined;
      for (const msg of messages.values()) {
        const usage = counts(msg.tokens);
        if (usage) {
          last = usage;
          total ??= {};
          for (const [key, value] of Object.entries(usage)) {
            const field = key as keyof TokenCounts;
            total[field] = (total[field] ?? 0) + value;
          }
        }
        // The recorder normally writes completed tools. They are history, not
        // evidence that a tool is still running or that the agent's turn ended.
        if (Array.isArray(msg.toolCalls))
          for (const value of msg.toolCalls) {
            const tool = object(value);
            const id = string(tool.id);
            if (!id) continue;
            if (tool.status === 'executing')
              state.tools.set(id, { name: string(tool.name) ?? 'tool', input: tool.args });
            else state.tools.delete(id);
          }
      }
      if (state.tools.size) state.status = 'active';
      if (total || last) state.usage = { total, last };
      return state;
    },
  };
}
