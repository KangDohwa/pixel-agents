import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { createCodexReader } from '../src/providers/file/codex/codex.js';
import { createGeminiReader } from '../src/providers/hook/gemini/geminiTranscript.js';
import {
  claudeProvider,
  codexProvider,
  geminiProvider,
  providerById,
} from '../src/providers/index.js';
import { TranscriptFile } from '../src/transcriptFile.js';

// Field names/record shapes follow the pinned official sources in the readers.
// All content is synthetic, never copied from a user's session.
const codexMeta = (
  id: string,
  cwd: string,
  timestamp = new Date().toISOString(),
  parent?: string,
) => ({
  type: 'session_meta',
  payload: { id, session_id: 'root-not-thread', cwd, timestamp, parent_thread_id: parent },
});
const event = (type: string, extra = {}) => ({ type: 'event_msg', payload: { type, ...extra } });
const line = (record: unknown) => JSON.stringify(record) + '\n';

describe('stateful transcript providers', () => {
  let root: string;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let sent: Record<string, unknown>[];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-fixture-'));
    process.env.CODEX_HOME = path.join(root, '.codex');
    process.env.GEMINI_CLI_HOME = root;
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.watchAllSessions.current = true;
    sent = [];
    store.on('broadcast', (m) => sent.push(m));
  });
  afterEach(() => {
    runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  function write(relative: string, records: unknown[], json = false): string {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, json ? JSON.stringify(records[0]) : records.map(line).join(''));
    return file;
  }
  const rollout = '.codex/sessions/2026/09/29/rollout-fixture.jsonl';
  const chat = '.gemini/tmp/project/chats/session-fixture.jsonl';

  it('Codex disk append reaches runtime/store: full thread ID, tools, exact usage, turn end without session exit', () => {
    const file = write(rollout, [
      codexMeta('full-thread', root),
      event('task_started'),
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'c1',
          name: 'read_file',
          arguments: '{"path":"synthetic.ts"}',
        },
      },
    ]);
    runtime.transcripts.scan();
    const agent = [...store.values()][0];
    expect(agent).toMatchObject({
      providerId: 'codex',
      sessionId: 'full-thread',
      observedStatus: 'active',
    });
    expect(agent.activeToolNames.get('c1')).toBe('codex/read_file');
    expect(agent.tokenUsage).toBeUndefined();
    fs.appendFileSync(
      file,
      line(
        event('token_count', {
          info: {
            total_token_usage: {
              input_tokens: 13,
              cached_input_tokens: 3,
              output_tokens: 2,
              reasoning_output_tokens: 1,
              total_tokens: 15,
            },
            last_token_usage: { total_tokens: 8 },
          },
        }),
      ) +
        line({
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'c1',
            output: [{ type: 'text', text: 'synthetic' }],
          },
        }) +
        line(event('task_complete')),
    );
    runtime.transcripts.scan();
    expect(store.size).toBe(1);
    expect(agent.observedStatus).toBe('waiting');
    expect(agent.tokenUsage).toEqual({
      total: { input: 13, cached: 3, output: 2, reasoning: 1, total: 15 },
      last: { total: 8 },
    });
    expect(agent.activeToolIds.size).toBe(0);
    expect(sent).toContainEqual(
      expect.objectContaining({ type: 'agentStatus', status: 'waiting', silent: false }),
    );
    fs.appendFileSync(file, line(event('token_count', { info: null })));
    runtime.transcripts.scan();
    expect(agent.tokenUsage?.total?.total).toBe(15);
    expect(sent.at(-1)).toMatchObject({ silent: true });
  });

  it('new rollout generation wins for reused IDs even if old files later grow; fork is not a subagent', () => {
    const first = write(rollout, [
      codexMeta('same', root, '2026-09-28T01:00:00Z'),
      event('task_complete'),
    ]);
    runtime.transcripts.scan();
    const id = [...store.keys()][0];
    const newer = write(rollout.replace('fixture', 'newer'), [
      codexMeta('same', root, '2026-09-29T01:00:00Z'),
      event('task_started'),
    ]);
    fs.appendFileSync(first, line(event('task_complete')));
    runtime.transcripts.scan();
    expect(store.size).toBe(1);
    expect(store.get(id)).toMatchObject({ jsonlFile: newer, observedStatus: 'active' });
    const reader = createCodexReader();
    reader.accept({ type: 'session_meta', payload: { id: 'fork', forked_from_id: 'same' } });
    expect(reader.snapshot().parentSessionId).toBeUndefined();
  });

  it('partial UTF-8 is buffered and truncation/rewrite/rename replays instead of duplicating usage', () => {
    const file = write(chat, [
      { sessionId: 'gemini-full-id', directories: [root] },
      {
        id: 'm1',
        type: 'gemini',
        content: [{ text: 'synthetic' }],
        tokens: { input: 10, output: 2, total: 12 },
      },
    ]);
    runtime.transcripts.scan();
    const agent = [...store.values()][0];
    expect(agent.observedStatus).toBe('unknown');
    const bytes = Buffer.from(
      line({ id: 'm2', type: 'gemini', content: [{ text: '가' }], tokens: { total: 9 } }),
    );
    const split = bytes.indexOf(Buffer.from('가')) + 1;
    fs.appendFileSync(file, bytes.subarray(0, split));
    runtime.transcripts.scan();
    expect(agent.tokenUsage?.total?.total).toBe(12);
    fs.appendFileSync(file, bytes.subarray(split));
    runtime.transcripts.scan();
    expect(agent.tokenUsage?.total?.total).toBe(21);
    fs.appendFileSync(
      file,
      line({ id: 'm2', type: 'gemini', tokens: { total: 4 } }) + line({ $rewindTo: 'm2' }),
    );
    runtime.transcripts.scan();
    expect(agent.tokenUsage?.total?.total).toBe(12);
    fs.renameSync(file, file + '.old');
    write(chat, [
      {
        sessionId: 'gemini-full-id',
        messages: [{ id: 'new', type: 'gemini', tokens: { total: 7 } }],
      },
    ]);
    runtime.transcripts.scan();
    expect(agent.tokenUsage?.total?.total).toBe(7);
    expect(store.size).toBe(1);
    fs.writeFileSync(file, line({ sessionId: 'gemini-full-id', messages: [] }));
    runtime.transcripts.scan();
    expect(agent.tokenUsage).toBeUndefined();
    expect(sent.some((m) => m.type === 'agentStatus' && m.status === 'waiting')).toBe(false);
  });

  it('legacy Gemini JSON rewrites, $set replacement, repeated IDs and unknown rewind are replayed', () => {
    const file = write(
      chat.replace('.jsonl', '.json'),
      [{ sessionId: 'legacy-full', messages: [{ id: '1', type: 'gemini', tokens: { total: 5 } }] }],
      true,
    );
    runtime.transcripts.scan();
    const agent = [...store.values()][0];
    expect(agent.sessionId).toBe('legacy-full');
    fs.writeFileSync(file, '{');
    runtime.transcripts.scan();
    expect(agent.tokenUsage?.total?.total).toBe(5);
    fs.writeFileSync(
      file,
      JSON.stringify({ sessionId: 'legacy-full', messages: [{ id: '2', tokens: { total: 6 } }] }),
    );
    runtime.transcripts.scan();
    expect(agent.tokenUsage?.total?.total).toBe(6);
    const reader = createGeminiReader();
    reader.accept({ sessionId: 's' });
    reader.accept({ id: '1', tokens: { total: 9 } });
    reader.accept({ id: '1', tokens: { total: 2 } });
    expect(reader.snapshot().usage?.total?.total).toBe(2);
    reader.accept({ $set: { messages: [{ id: '3', tokens: { total: 4 } }] } });
    expect(reader.snapshot().usage?.total?.total).toBe(4);
    reader.accept({ $rewindTo: 'missing' });
    expect(reader.snapshot().usage).toBeUndefined();
  });

  it('dispatches hooks by provider and distinguishes approval, turn completion and session exit', () => {
    const raw = { session_id: 'identical', cwd: root, transcript_path: path.join(root, chat) };
    runtime.handleHookEvent('not-registered', { ...raw, hook_event_name: 'SessionStart' });
    runtime.handleHookEvent('codex', { ...raw, hook_event_name: 'SessionStart' });
    expect(store.size).toBe(0);
    runtime.handleHookEvent('gemini', { ...raw, hook_event_name: 'BeforeAgent' });
    const agent = [...store.values()][0];
    expect(agent.providerId).toBe('gemini');
    runtime.handleHookEvent('claude', { ...raw, hook_event_name: 'Stop' });
    expect(agent.observedStatus).toBe('active');
    expect(agent.isWaiting).toBe(false);
    for (let i = 0; i < 2; i++)
      runtime.handleHookEvent('gemini', {
        ...raw,
        hook_event_name: 'BeforeTool',
        tool_name: 'read_file',
      });
    runtime.handleHookEvent('gemini', {
      ...raw,
      hook_event_name: 'AfterTool',
      tool_name: 'read_file',
    });
    expect(agent.activeToolIds.size).toBe(1);
    runtime.handleHookEvent('gemini', {
      ...raw,
      hook_event_name: 'Notification',
      notification_type: 'ToolPermission',
    });
    expect(sent.at(-1)).toMatchObject({ type: 'agentToolPermission' });
    runtime.handleHookEvent('gemini', { ...raw, hook_event_name: 'AfterAgent' });
    expect(agent.observedStatus).toBe('waiting');
    expect(store.size).toBe(1);
    write(rollout, [codexMeta('identical', root), event('task_started')]);
    runtime.transcripts.scan();
    expect(store.size).toBe(2);
    runtime.handleHookEvent('gemini', { ...raw, hook_event_name: 'SessionEnd', reason: 'exit' });
    expect([...store.values()].map((a) => a.providerId)).toEqual(['codex']);
  });

  it('restores provider identity and child links, preserves unknown, never replays a completion notification', () => {
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    write(rollout, [codexMeta('parent', root), event('task_complete')]);
    write(rollout.replace('fixture', 'child'), [
      codexMeta('child', root, undefined, 'parent'),
      event('turn_aborted'),
    ]);
    runtime.transcripts.scan();
    runtime.transcripts.scan();
    const parent = [...store.values()].find((a) => a.sessionId === 'parent')!;
    const child = [...store.values()].find((a) => a.sessionId === 'child')!;
    expect(child.leadAgentId).toBe(parent.id);
    const saved = store.loadPersistedAgents();
    expect(saved.every((a) => a.providerId === 'codex')).toBe(true);
    runtime.dispose();
    expect(store.loadPersistedAgents()).toEqual(saved);
    store.clear();
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.watchAllSessions.current = true;
    runtime.restoreExternalAgents();
    expect(store.get(child.id)?.agentName).toBe('Codex subagent');
    sent.length = 0;
    runtime.transcripts.scan();
    expect(store.size).toBe(2);
    expect(
      sent
        .filter((m) => m.type === 'agentStatus' && m.status === 'waiting')
        .every((m) => m.silent === true),
    ).toBe(true);
    fs.unlinkSync(path.join(root, rollout));
    runtime.transcripts.scan();
    expect(store.get(parent.id)?.observedStatus).toBe('unknown');
    expect(store.size).toBe(2);
  });

  it('scope gates discovery and stale activity becomes unknown, never approval or done', () => {
    write(rollout, [codexMeta('scope', root), event('task_started')]);
    runtime.watchAllSessions.current = false;
    runtime.transcripts.scan();
    expect(store.size).toBe(0);
    runtime.transcripts.start([root]);
    expect(store.size).toBe(1);
    sent.length = 0;
    runtime.transcripts.scan(Date.now() + 61_000);
    expect([...store.values()][0].observedStatus).toBe('unknown');
    expect(sent.some((m) => m.type === 'agentToolPermission' || m.status === 'waiting')).toBe(
      false,
    );
  });

  it('launch commands do not interpolate cwd, session IDs or bypass into Codex/Gemini shells', () => {
    for (const provider of [codexProvider, geminiProvider]) {
      expect(
        provider.buildLaunchCommand?.('"; injected', 'C:\\space & $(injected)\\project', {
          bypassPermissions: true,
        }),
      ).toEqual({ command: provider.id, args: [] });
    }
    expect(providerById('arbitrary-shell')).toBeUndefined();
  });

  it('Gemini discovers project registry, legacy hash and nested subagent full IDs', () => {
    write('.gemini/projects.json', [{ projects: { [root]: 'short-project' } }], true);
    const parentFile = '.gemini/tmp/short-project/chats/session-parent.jsonl';
    write(parentFile, [{ sessionId: 'parent-full' }]);
    write('.gemini/tmp/short-project/chats/parent-full/child-short.jsonl', [
      { sessionId: 'child-full', kind: 'subagent' },
    ]);
    runtime.transcripts.start([root]);
    const parent = [...store.values()].find((a) => a.sessionId === 'parent-full')!;
    const child = [...store.values()].find((a) => a.sessionId === 'child-full')!;
    runtime.transcripts.scan();
    expect(parent.projectDir).toBe(root);
    expect(child.leadAgentId).toBe(parent.id);
    const hash = crypto.createHash('sha256').update(root).digest('hex');
    write(
      '.gemini/tmp/' + hash + '/chats/legacy.json',
      [{ sessionId: 'hashed-project-full', messages: [] }],
      true,
    );
    runtime.watchAllSessions.current = false;
    runtime.transcripts.scan();
    expect([...store.values()].find((a) => a.sessionId === 'hashed-project-full')?.projectDir).toBe(
      root,
    );
  });

  it('completed Codex items and function outputs never stand in for task completion', () => {
    const reader = createCodexReader();
    reader.accept(
      event('item_completed', {
        item: {
          type: 'AgentMessage',
          id: 'message',
          content: [{ type: 'Text', text: 'synthetic' }],
        },
      }),
    );
    expect(reader.snapshot().status).toBe('unknown');
    reader.accept(event('turn_started'));
    reader.accept({
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: 'patch',
        name: 'apply_patch',
        input: 'synthetic',
      },
    });
    reader.accept({
      type: 'response_item',
      payload: { type: 'custom_tool_call_output', call_id: 'patch', output: 'synthetic' },
    });
    expect(reader.snapshot().tools.size).toBe(0);
    expect(reader.snapshot().status).toBe('active');
    reader.accept(event('turn_complete', { error: { message: 'synthetic' } }));
    expect(reader.snapshot().status).toBe('interrupted');
  });

  it('Gemini rewind invalidates prior hook completion evidence', () => {
    const file = write(chat, [
      { sessionId: 'rewind-full', messages: [{ id: 'a', tokens: { total: 3 } }] },
    ]);
    runtime.transcripts.scan();
    runtime.handleHookEvent('gemini', {
      session_id: 'rewind-full',
      cwd: root,
      hook_event_name: 'AfterAgent',
    });
    expect([...store.values()][0].observedStatus).toBe('waiting');
    fs.appendFileSync(file, line({ $rewindTo: 'a' }));
    runtime.transcripts.scan();
    expect([...store.values()][0].observedStatus).toBe('unknown');
    expect([...store.values()][0].tokenUsage).toBeUndefined();
  });

  it('complete records only: an unfinished JSONL line does not reach the parser', () => {
    const file = write('partial.jsonl', []);
    const cursor = new TranscriptFile(file);
    fs.writeFileSync(file, '{"id":');
    expect(cursor.read()?.records).toEqual([]);
    fs.appendFileSync(file, '"ok"}\n');
    expect(cursor.read()?.records).toEqual([{ id: 'ok' }]);
  });
});
