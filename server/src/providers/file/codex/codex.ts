import * as os from 'os';
import * as path from 'path';

import type {
  FileProvider,
  TranscriptReader,
  TranscriptSnapshot,
} from '../../../../../core/src/provider.js';
import {
  counts,
  filesUnder,
  formatToolStatus,
  number,
  object,
  string,
} from '../../transcriptUtils.js';

/** Rollout format: openai/codex rust-v0.159.0 protocol.rs and items.rs. */
export function createCodexReader(): TranscriptReader {
  const state: TranscriptSnapshot = { status: 'unknown', tools: new Map() };
  const finish = (interrupted: boolean) => {
    state.status = interrupted ? 'interrupted' : 'waiting';
    state.tools.clear();
  };
  return {
    snapshot: () => state,
    accept(value) {
      const record = object(value);
      const payload = object(record.payload);
      if (record.type === 'session_meta') {
        const startedAt = Date.parse(string(payload.timestamp) ?? string(record.timestamp) ?? '');
        if (Number.isFinite(startedAt)) state.startedAt = startedAt;
        state.sessionId = string(payload.id);
        state.cwd = string(payload.cwd);
        state.parentSessionId =
          string(payload.parent_thread_id) ??
          string(object(object(object(payload.source).subagent).thread_spawn).parent_thread_id);
        state.forkedFromId = string(payload.forked_from_id);
      } else if (record.type === 'event_msg') {
        switch (payload.type) {
          case 'task_started':
          case 'turn_started':
            state.status = 'active';
            state.tools.clear();
            state.contextWindow = number(payload.model_context_window) ?? state.contextWindow;
            break;
          case 'task_complete':
          case 'turn_complete':
            finish(!!payload.error);
            break;
          case 'turn_aborted':
            finish(true);
            break;
          case 'token_count': {
            const info = object(payload.info);
            // null is missing information, never an observed zero.
            if (payload.info !== null && payload.info !== undefined) {
              state.usage = {
                total: counts(info.total_token_usage, true),
                last: counts(info.last_token_usage, true),
              };
              state.contextWindow = number(info.model_context_window) ?? state.contextWindow;
            }
            break;
          }
          case 'item_completed': {
            const item = object(payload.item);
            const id = string(item.id);
            if (id) state.tools.delete(id);
            // Item completion (including AgentMessage) is not turn completion.
            break;
          }
        }
      } else if (record.type === 'response_item') {
        const id = string(payload.call_id);
        if ((payload.type === 'function_call' || payload.type === 'custom_tool_call') && id) {
          let input: unknown = payload.input;
          if (typeof payload.arguments === 'string') {
            try {
              input = JSON.parse(payload.arguments);
            } catch {
              /* incomplete arguments */
            }
          }
          state.tools.set(id, { name: string(payload.name) ?? 'tool', input });
          state.status = 'active';
        } else if (
          (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') &&
          id
        ) {
          state.tools.delete(id);
        }
      }
    },
  };
}

export const codexProvider: FileProvider = {
  kind: 'file',
  id: 'codex',
  displayName: 'Codex',
  protocolVersion: 1,
  readingTools: new Set(['read_file', 'list_dir', 'grep_files', 'web.run']),
  // Parent/thread metadata drives child characters, not guesses from tool names.
  subagentToolNames: new Set(),
  terminalNamePrefix: 'Codex',
  formatToolStatus,
  buildLaunchCommand: () => ({ command: 'codex', args: [] }),
  transcripts: {
    discover: () =>
      filesUnder(
        path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'),
        3,
        (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'),
      ).map((file) => ({ path: file })),
    createReader: createCodexReader,
  },
};
