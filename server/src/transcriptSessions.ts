import * as fs from 'fs';
import * as path from 'path';

import type {
  AgentProvider,
  HookProvider,
  TranscriptReader,
  TranscriptSnapshot,
} from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import { assignPaletteIfNeeded } from './paletteAssigner.js';
import { pathsMatch } from './pathKey.js';
import { providers } from './providers/index.js';
import { TranscriptFile } from './transcriptFile.js';
import type { AgentState, PersistedAgent } from './types.js';

interface TrackedFile {
  file: TranscriptFile;
  reader: TranscriptReader;
  mtime: number;
  generation: number;
  birthtime: number;
  snapshot?: TranscriptSnapshot;
}

/** File providers share replay/file boundaries, not Claude's heuristic timers.
 * Silence is never evidence of approval waiting, a completed turn, or exit. */
export class TranscriptSessions {
  private files = new Map<string, TrackedFile>();
  private dismissed = new Set<string>();
  private hookStates = new Map<
    string,
    { snapshot: TranscriptSnapshot; at: number; tools: Map<string, number> }
  >();
  private timer?: ReturnType<typeof setInterval>;
  private workspaces: string[] = [];
  private persisted = '';
  constructor(
    private store: AgentStateStore,
    private watchAll: { current: boolean },
    private registry: readonly AgentProvider[] = providers,
  ) {}

  start(workspaces: string[]): void {
    this.workspaces = workspaces;
    if (this.timer) return;
    this.scan();
    this.timer = setInterval(() => this.scan(), 1000);
  }
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.files.clear();
    this.hookStates.clear();
  }
  dismiss(agent: AgentState): void {
    this.dismissed.add(this.key(agent.providerId!, agent.sessionId));
  }
  private key(provider: string, session: string): string {
    return `${provider}:${session}`;
  }
  private find(provider: string, session: string): AgentState | undefined {
    return [...this.store.values()].find(
      (a) => a.providerId === provider && a.sessionId === session,
    );
  }
  private allowed(cwd: string | undefined): boolean {
    return (
      this.watchAll.current ||
      (!!cwd &&
        this.workspaces.some((root) => {
          const relative = path.relative(root, cwd);
          return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
        }))
    );
  }
  restore(saved: PersistedAgent): void {
    if (!saved.sessionId || !this.registry.some((p) => p.id === saved.providerId && p.transcripts))
      return;
    this.create(
      saved.providerId!,
      saved.sessionId,
      saved.projectDir,
      saved.jsonlFile,
      saved.id,
      saved,
    );
    this.store.nextAgentId.current = Math.max(this.store.nextAgentId.current, saved.id + 1);
  }
  private create(
    providerId: string,
    sessionId: string,
    cwd: string,
    file: string,
    id = this.store.nextAgentId.current++,
    saved?: PersistedAgent,
  ): AgentState {
    const agent: AgentState = {
      id,
      providerId,
      sessionId,
      projectDir: cwd,
      jsonlFile: file,
      isExternal: true,
      fileOffset: 0,
      lineBuffer: '',
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      backgroundAgentToolIds: new Set(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      lastDataAt: 0,
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      hookDelivered: false,
      contextTokens: 0,
      maxContextTokens: 0,
      observedStatus: 'unknown',
      folderName: cwd ? path.basename(cwd) : undefined,
    };
    if (saved)
      Object.assign(agent, {
        palette: saved.palette,
        hueShift: saved.hueShift,
        folderName: saved.folderName,
        leadAgentId: saved.leadAgentId,
        agentName: saved.agentName,
      });
    assignPaletteIfNeeded(agent, this.store);
    this.store.set(id, agent);
    return agent;
  }

  /** Public to allow deterministic disk -> runtime -> store tests without clocks. */
  scan(now = Date.now()): void {
    for (const provider of this.registry) {
      if (!provider.transcripts) continue;
      const candidates = new Map<
        string,
        { tracked: TrackedFile; file: string; snapshot: TranscriptSnapshot; changed: boolean }
      >();
      const locations = provider.transcripts.discover(this.workspaces);
      // A restored file remains tracked even before a workspace is opened.
      for (const a of this.store.values())
        if (
          a.providerId === provider.id &&
          a.jsonlFile &&
          !locations.some((f) => pathsMatch(f.path, a.jsonlFile))
        )
          locations.push({ path: a.jsonlFile, cwd: a.projectDir });
      const present = new Set(locations.map((l) => l.path));
      for (const location of locations) {
        const key = `${provider.id}:${location.path}`;
        let tracked = this.files.get(key);
        if (!tracked) {
          try {
            if (
              now - fs.statSync(location.path).mtimeMs > 300_000 &&
              ![...this.store.values()].some(
                (a) => a.providerId === provider.id && pathsMatch(a.jsonlFile, location.path),
              )
            )
              continue;
          } catch {
            continue;
          }
          tracked = {
            file: new TranscriptFile(location.path),
            reader: provider.transcripts.createReader(),
            mtime: 0,
            generation: 0,
            birthtime: 0,
          };
          this.files.set(key, tracked);
        }
        let changed = false;
        try {
          const update = tracked.file.read();
          if (update) {
            if (update.reset) tracked.reader = provider.transcripts.createReader();
            for (const record of update.records) tracked.reader.accept(record);
            tracked.snapshot = tracked.reader.snapshot();
            if (
              tracked.snapshot.sessionId &&
              ((update.reset && location.path.endsWith('.jsonl')) ||
                update.records.some((r) => r !== null && typeof r === 'object' && '$rewindTo' in r))
            ) {
              this.hookStates.delete(this.key(provider.id, tracked.snapshot.sessionId));
            }
            tracked.mtime = update.mtime;
            tracked.generation =
              tracked.snapshot.startedAt ?? fs.statSync(location.path).birthtimeMs;
            tracked.birthtime = fs.statSync(location.path).birthtimeMs;
            changed = update.records.length > 0 || update.reset;
          }
        } catch {
          // Keep identity and usage during rotation; current activity is unknown.
          if (tracked.snapshot) {
            tracked.snapshot = { ...tracked.snapshot, status: 'unknown', tools: new Map() };
            changed = true;
          }
        }
        if (!tracked.snapshot?.sessionId) continue;
        const snapshot = {
          ...tracked.snapshot,
          cwd: tracked.snapshot.cwd ?? location.cwd,
          parentSessionId: tracked.snapshot.parentSessionId ?? location.parentSessionId,
        };
        const previous = candidates.get(snapshot.sessionId!);
        // Revert/resume can produce several files for one thread. A late append
        // to an older generation must not resurrect reverted history/usage.
        if (
          !previous ||
          tracked.generation > previous.tracked.generation ||
          (tracked.generation === previous.tracked.generation &&
            (tracked.birthtime > previous.tracked.birthtime ||
              (tracked.birthtime === previous.tracked.birthtime && location.path > previous.file)))
        ) {
          candidates.set(snapshot.sessionId!, { tracked, file: location.path, snapshot, changed });
        }
      }
      for (const [session, candidate] of candidates) {
        const key = this.key(provider.id, session);
        if (this.dismissed.has(key)) continue;
        let agent = this.find(provider.id, session);
        if (
          !agent &&
          (!this.allowed(candidate.snapshot.cwd) || now - candidate.tracked.mtime > 300_000)
        )
          continue;
        const initial = !agent || !agent.lastDataAt;
        agent ??= this.create(provider.id, session, candidate.snapshot.cwd ?? '', candidate.file);
        const switched = !pathsMatch(agent.jsonlFile, candidate.file);
        agent.jsonlFile = candidate.file;
        agent.projectDir = candidate.snapshot.cwd ?? agent.projectDir;
        const hook = this.hookStates.get(key);
        const snapshot =
          hook && now - hook.at < 60_000
            ? { ...candidate.snapshot, status: hook.snapshot.status, tools: hook.snapshot.tools }
            : candidate.snapshot;
        if (candidate.changed || initial || switched)
          this.apply(
            agent,
            provider,
            snapshot,
            Math.max(candidate.tracked.mtime, hook?.at ?? 0),
            initial || switched,
          );
        const parent = snapshot.parentSessionId && this.find(provider.id, snapshot.parentSessionId);
        if (parent && agent.leadAgentId !== parent.id) {
          agent.leadAgentId = parent.id;
          agent.agentName = `${provider.displayName} subagent`;
          this.store.broadcast({
            type: 'agentTeamInfo',
            id: agent.id,
            leadAgentId: parent.id,
            agentName: agent.agentName,
          });
        }
      }
      for (const agent of this.store.values())
        if (agent.providerId === provider.id) {
          if (
            (agent.observedStatus === 'active' && now - agent.lastDataAt > 60_000) ||
            (agent.jsonlFile && !present.has(agent.jsonlFile))
          ) {
            this.apply(
              agent,
              provider,
              { status: 'unknown', tools: new Map(), usage: agent.tokenUsage },
              agent.lastDataAt,
              true,
            );
          }
        }
    }
    const persisted = JSON.stringify(
      [...this.store.values()].map((a) => [
        a.id,
        a.providerId,
        a.sessionId,
        a.jsonlFile,
        a.projectDir,
        a.leadAgentId,
      ]),
    );
    if (persisted !== this.persisted) {
      this.persisted = persisted;
      this.store.persist();
    }
  }

  handleHook(provider: HookProvider, raw: Record<string, unknown>): void {
    const normalized = provider.normalizeHookEvent(raw);
    if (!normalized) return;
    const { sessionId, event } = normalized;
    const key = this.key(provider.id, sessionId);
    let agent = this.find(provider.id, sessionId);
    if (event.kind === 'sessionStart') this.dismissed.delete(key);
    if (this.dismissed.has(key) || (!agent && !this.allowed(normalized.cwd))) return;
    if (event.kind === 'sessionEnd') {
      this.dismissed.add(key);
      this.hookStates.delete(key);
      if (agent) this.store.delete(agent.id);
      this.store.persist();
      return;
    }
    agent ??= this.create(
      provider.id,
      sessionId,
      normalized.cwd ?? '',
      normalized.transcriptPath ?? '',
    );
    if (normalized.transcriptPath) agent.jsonlFile = normalized.transcriptPath;
    let hook = this.hookStates.get(key);
    if (!hook) {
      hook = { snapshot: { status: 'unknown', tools: new Map() }, at: 0, tools: new Map() };
      this.hookStates.set(key, hook);
    }
    hook.at = Date.now();
    const s = hook.snapshot;
    if (event.kind !== 'permissionRequest') agent.permissionSent = false;
    if (event.kind === 'turnStart' || event.kind === 'sessionStart') {
      s.status = event.kind === 'turnStart' ? 'active' : 'unknown';
      s.tools.clear();
      hook.tools.clear();
    } else if (event.kind === 'turnEnd') {
      s.status = 'waiting';
      s.tools.clear();
      hook.tools.clear();
    } else if (event.kind === 'toolStart') {
      hook.tools.set(event.toolId, (hook.tools.get(event.toolId) ?? 0) + 1);
      s.tools.set(event.toolId, { name: event.toolName });
      s.status = 'active';
    } else if (event.kind === 'toolEnd') {
      const count = Math.max(0, (hook.tools.get(event.toolId) ?? 0) - 1);
      hook.tools.set(event.toolId, count);
      if (!count) s.tools.delete(event.toolId);
      s.status = 'active';
    } else if (event.kind === 'permissionRequest') {
      agent.permissionSent = true;
      agent.lastDataAt = hook.at;
      this.store.broadcast({ type: 'agentToolPermission', id: agent.id });
      return;
    }
    agent.hookDelivered = true;
    this.apply(
      agent,
      provider,
      { ...s, usage: agent.tokenUsage },
      hook.at,
      event.kind === 'sessionStart',
    );
    this.store.persist();
  }

  private apply(
    agent: AgentState,
    provider: AgentProvider,
    snapshot: TranscriptSnapshot,
    at: number,
    silent: boolean,
  ): void {
    const status =
      Date.now() - at > 60_000 && snapshot.status === 'active' ? 'unknown' : snapshot.status;
    const tools = status === 'unknown' || status === 'interrupted' ? new Map() : snapshot.tools;
    if (status === 'unknown' || status === 'interrupted') agent.permissionSent = false;
    for (const id of agent.activeToolIds)
      if (!tools.has(id)) this.store.broadcast({ type: 'agentToolDone', id: agent.id, toolId: id });
    agent.activeToolIds.clear();
    agent.activeToolStatuses.clear();
    agent.activeToolNames.clear();
    for (const [id, tool] of tools) {
      const label = provider.formatToolStatus(tool.name, tool.input);
      agent.activeToolIds.add(id);
      agent.activeToolStatuses.set(id, label);
      agent.activeToolNames.set(id, `${provider.id}/${tool.name}`);
      this.store.broadcast({
        type: 'agentToolStart',
        id: agent.id,
        toolId: id,
        status: label,
        toolName: `${provider.id}/${tool.name}`,
        permissionActive: agent.permissionSent,
      });
    }
    const changed = agent.observedStatus !== status;
    agent.observedStatus = status;
    agent.isWaiting = status === 'waiting';
    agent.lastDataAt = at;
    agent.tokenUsage = snapshot.usage;
    this.store.broadcast({
      type: 'agentStatus',
      id: agent.id,
      status,
      silent: silent || !changed,
      permissionActive: agent.permissionSent,
      usage: snapshot.usage ?? {},
    });
  }
}
