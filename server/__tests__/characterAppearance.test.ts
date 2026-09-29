import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { defaultAppearance } from '../../core/src/appearance.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { loadCharacterSprites, mergeCharacterSprites } from '../src/assetLoader.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { claudeProvider } from '../src/providers/index.js';
import type { AgentState } from '../src/types.js';

let tmp: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmp };
});
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-appearance-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  expect(path.basename(tmp)).toMatch(/^pixel-appearance-/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

it.each([
  'parent-first',
  'child-first',
  'restore-before-parent',
  'custom-default',
  'saved-child',
  'legacy-child',
])('first Codex parent link inherits only automatic appearance: %s', (order) => {
  vi.stubEnv('CODEX_HOME', path.join(tmp, '.codex'));
  const adapter = new FileStateAdapter({ namespace: 'standalone' });
  let store = new AgentStateStore();
  store.setAdapter(adapter);
  let runtime = new AgentRuntime(store, claudeProvider);
  runtime.watchAllSessions.current = true;
  const sent: Record<string, unknown>[] = [];
  store.on('broadcast', (message) => sent.push(message));
  const write = (id: string, parent?: string) => {
    const dir = path.join(tmp, '.codex/sessions/2026/09/29');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `rollout-${id}.jsonl`),
      JSON.stringify({
        type: 'session_meta',
        payload: { id, cwd: tmp, parent_thread_id: parent },
      }) + '\n',
    );
  };
  const restart = () => {
    runtime.dispose();
    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    store.on('broadcast', (message) => sent.push(message));
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.watchAllSessions.current = true;
    runtime.restoreExternalAgents();
  };
  const parentChoice = { head: 2, body: 2, clothes: 2 };
  try {
    if (order !== 'parent-first') {
      write('child', 'parent');
      runtime.transcripts.scan();
      const child = [...store.values()][0];
      if (order === 'custom-default' || order === 'legacy-child') {
        handleClientMessage(
          {
            type: 'saveAgentSeats',
            seats: {
              [child.id]: {
                ...adapter.loadSeats()[String(child.id)],
                appearance: order === 'legacy-child' ? null : defaultAppearance(child.id),
                appearanceCustomized: true,
              },
            },
          },
          () => {},
          { store, cache: null },
        );
      } else if (order === 'saved-child') {
        adapter.saveSeats({
          [child.id]: { palette: 5, appearance: { head: 1, body: 0, clothes: 2 } },
        });
      }
      if (order === 'restore-before-parent' || order === 'saved-child') restart();
    }
    write('parent');
    runtime.transcripts.scan();
    const parent = [...store.values()].find((a) => a.sessionId === 'parent')!;
    adapter.saveSeats({ [parent.id]: { palette: 5, appearance: parentChoice } });
    if (order === 'parent-first') write('child', 'parent');
    runtime.transcripts.scan();
    const child = [...store.values()].find((a) => a.sessionId === 'child')!;
    const expected =
      order === 'custom-default'
        ? defaultAppearance(child.id)
        : order === 'legacy-child'
          ? null
          : order === 'saved-child'
            ? { head: 1, body: 0, clothes: 2 }
            : parentChoice;
    expect(child.leadAgentId).toBe(parent.id);
    expect(adapter.loadSeats()[String(child.id)].appearance).toEqual(expected);
    expect(sent).toContainEqual(
      expect.objectContaining({ type: 'agentTeamInfo', id: child.id, appearance: expected }),
    );
    restart();
    runtime.transcripts.scan();
    expect(adapter.loadSeats()[String(child.id)].appearance).toEqual(expected);
    expect(store.get(child.id)?.leadAgentId).toBe(parent.id);
  } finally {
    runtime.dispose();
  }
});

it.each(['empty-cell', 'short-anchor', 'non-finite-cell', 'non-finite-anchor'])(
  'real character loading falls back for malformed metadata: %s',
  async (corruption) => {
    const dir = path.join(tmp, 'assets/characters');
    fs.cpSync(path.resolve(__dirname, '../../webview-ui/public/assets/characters'), dir, {
      recursive: true,
    });
    const manifestPath = path.join(dir, 'layered/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (corruption === 'empty-cell') manifest.cells.heads[0][0] = [];
    if (corruption === 'short-anchor') manifest.destinationAnchors.heads = [8];
    if (corruption === 'non-finite-cell') manifest.cells.heads[0][0][0] = null;
    if (corruption === 'non-finite-anchor') manifest.destinationAnchors.heads[0] = null;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const sprites = await loadCharacterSprites(tmp);
    expect(sprites?.characters).toHaveLength(6);
    expect(sprites?.layeredCharacters).toEqual([]);
  },
);

it.each([null, { head: 2, body: 1, clothes: 0 }])(
  'restores the same identity but resets appearance after closing the last agent: %j',
  (appearance) => {
    vi.stubEnv('CODEX_HOME', path.join(tmp, '.codex'));
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    let store = new AgentStateStore();
    store.setAdapter(adapter);
    let runtime = new AgentRuntime(store, claudeProvider);
    runtime.watchAllSessions.current = true;
    const dir = path.join(tmp, '.codex/sessions/2026/09/29');
    fs.mkdirSync(dir, { recursive: true });
    const write = (sessionId: string) => {
      const file = path.join(dir, `rollout-${sessionId}.jsonl`);
      fs.writeFileSync(
        file,
        JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: tmp } }) + '\n',
      );
      return file;
    };
    const restart = () => {
      runtime.dispose();
      store = new AgentStateStore();
      store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
      runtime = new AgentRuntime(store, claudeProvider);
      runtime.watchAllSessions.current = true;
      runtime.restoreExternalAgents();
    };
    try {
      const oldFile = write('old-session');
      runtime.transcripts.scan();
      const { id } = [...store.values()][0];
      const choice = {
        ...adapter.loadSeats()[String(id)],
        seatId: 'desk-1',
        appearance,
        appearanceCustomized: true,
      };
      handleClientMessage({ type: 'saveAgentSeats', seats: { [id]: choice } }, () => {}, {
        store,
        runtime,
        cache: null,
      });
      adapter.saveSeats({ 99: { seatId: 'desk-99', palette: 4 } });
      restart();
      expect(store.get(id)?.sessionId).toBe('old-session');
      expect(adapter.loadSeats()[String(id)]).toEqual(choice);
      handleClientMessage({ type: 'closeAgent', id }, () => {}, { store, runtime, cache: null });
      expect(adapter.loadAgents()).toEqual([]);
      expect(adapter.loadSeats()[String(id)]).toEqual(choice);
      fs.unlinkSync(oldFile);
      restart();
      write('new-session');
      runtime.transcripts.scan();
      expect(store.get(id)?.sessionId).toBe('new-session');
      expect(adapter.loadSeats()[String(id)]).toMatchObject({
        seatId: 'desk-1',
        appearance: defaultAppearance(id),
        appearanceCustomized: false,
      });
      expect(adapter.loadSeats()['99']).toEqual({ seatId: 'desk-99', palette: 4 });
    } finally {
      runtime.dispose();
    }
  },
);

it.each(['session', 'provider'])(
  'a saved numeric ID alone does not restore a different %s',
  (field) => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    adapter.saveAgents([
      {
        id: 1,
        providerId: 'codex',
        sessionId: 'saved',
        terminalName: '',
        jsonlFile: '/unused',
        projectDir: '/unused',
      },
    ]);
    adapter.saveSeats({ 1: { seatId: 'desk-1', appearance: null, appearanceCustomized: true } });
    const store = new AgentStateStore();
    store.setAdapter(adapter);
    store.set(1, {
      id: 1,
      providerId: field === 'provider' ? 'gemini' : 'codex',
      sessionId: field === 'session' ? 'new' : 'saved',
    } as AgentState);
    expect(adapter.loadSeats()['1']).toMatchObject({
      seatId: 'desk-1',
      appearance: defaultAppearance(1),
      appearanceCustomized: false,
    });
  },
);

it('seeds new sessions before agentCreated, preserves legacy restores and inherits teammates', () => {
  const adapter = new FileStateAdapter({ namespace: 'standalone' });
  adapter.saveAgents([{ id: 1, terminalName: '', jsonlFile: '/unused', projectDir: '/unused' }]);
  adapter.saveSeats({ 1: { palette: 5 } });
  const store = new AgentStateStore();
  store.setAdapter(adapter);
  store.set(1, { id: 1, palette: 5, sessionId: 'unused', jsonlFile: '/unused' } as AgentState);
  expect(adapter.loadSeats()['1'].appearance ?? null).toBeNull();
  store.on('agentAdded', (id) =>
    expect(adapter.loadSeats()[String(id)].appearance).toEqual(defaultAppearance(2)),
  );
  store.set(2, { id: 2, palette: 2 } as AgentState);
  store.set(3, { id: 3, palette: 2, leadAgentId: 2 } as AgentState);
});

it('saveAgentSeats survives a fresh adapter and partial snapshots without changing palettes', () => {
  const adapter = new FileStateAdapter({ namespace: 'standalone' });
  const store = new AgentStateStore();
  store.setAdapter(adapter);
  store.set(2, { id: 2, palette: 5, hueShift: 90 } as AgentState);
  const appearance = { head: 2, body: 0, clothes: 1 };
  handleClientMessage(
    {
      type: 'saveAgentSeats',
      seats: { 2: { palette: 5, hueShift: 90, seatId: null, appearance } },
    },
    () => {},
    { store, cache: null },
  );
  adapter.saveSeats({ 7: { palette: 1 } });
  const restarted = new FileStateAdapter({ namespace: 'standalone' });
  expect(restarted.loadSeats()['2']).toEqual({
    palette: 5,
    hueShift: 90,
    seatId: null,
    appearance,
  });
  expect(store.get(2)?.palette).toBe(5);
  expect(new FileStateAdapter({ namespace: 'vscode' }).loadSeats()).toEqual({});
  restarted.saveSeats({ 2: { palette: 5, appearance: null } });
  expect(adapter.loadSeats()['2'].appearance).toBeNull();
  restarted.saveSeats({ 2: { appearance: { head: 4, body: 0, clothes: 1 } } });
  expect(adapter.loadSeats()['2'].appearance).toBeNull();
});

it('external character append preserves the separate layered catalog and legacy indices', () => {
  const legacy = { down: [], up: [], right: [] };
  const external = { down: [[]], up: [[]], right: [[]] };
  const layered = Array.from({ length: 27 }, () => legacy);
  const result = mergeCharacterSprites(
    { characters: [legacy], layeredCharacters: layered },
    { characters: [external] },
  );
  expect(result.characters).toEqual([legacy, external]);
  expect(result.layeredCharacters).toBe(layered);
});
