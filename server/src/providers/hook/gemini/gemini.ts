import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { formatToolStatus, string } from '../../transcriptUtils.js';
import {
  areHooksInstalled,
  installHooks,
  prepareHooks,
  uninstallHooks,
} from './geminiHookInstaller.js';
import { createGeminiReader, discoverGeminiSessions } from './geminiTranscript.js';

export const geminiProvider: HookProvider = {
  kind: 'hook',
  id: 'gemini',
  displayName: 'Gemini CLI',
  protocolVersion: 1,
  readingTools: new Set([
    'read_file',
    'read_many_files',
    'list_directory',
    'grep_search',
    'glob',
    'google_web_search',
    'web_fetch',
  ]),
  subagentToolNames: new Set(),
  permissionExemptTools: new Set(),
  terminalNamePrefix: 'Gemini CLI',
  formatToolStatus,
  buildLaunchCommand: () => ({ command: 'gemini', args: [] }),
  transcripts: { discover: discoverGeminiSessions, createReader: createGeminiReader },
  prepareHooks,
  installHooks,
  uninstallHooks,
  areHooksInstalled,
  consentDisclosure: () => ({
    headline: 'Enable Gemini CLI live activity?',
    disclosure:
      'Pixel Agents adds its hooks to your Gemini user settings.json and saves a backup before the first change. Existing settings and other hooks are preserved.\n\nSession identity, working directory, tool names and lifecycle events are sent to Pixel Agents servers on this machine. Prompts, responses and tool results are not forwarded. Servers listen on loopback unless you explicitly expose one with --host.\n\nYou can remove these hooks in Settings. Without hooks, saved transcripts remain readable, but live approval and completion may be unknown.',
  }),
  normalizeHookEvent(raw) {
    const sessionId = string(raw.session_id);
    if (!sessionId) return null;
    let event: AgentEvent;
    switch (raw.hook_event_name) {
      case 'SessionStart':
        event = {
          kind: 'sessionStart',
          source: string(raw.source),
          cwd: string(raw.cwd),
          transcriptPath: string(raw.transcript_path),
        };
        break;
      case 'SessionEnd':
        event = { kind: 'sessionEnd', reason: string(raw.reason) };
        break;
      case 'BeforeAgent':
        event = { kind: 'turnStart' };
        break;
      case 'AfterAgent':
        event = { kind: 'turnEnd' };
        break;
      case 'BeforeTool':
        event = {
          kind: 'toolStart',
          toolId: `hook:${string(raw.tool_name) ?? 'tool'}`,
          toolName: string(raw.tool_name) ?? 'tool',
        };
        break;
      case 'AfterTool':
        event = { kind: 'toolEnd', toolId: `hook:${string(raw.tool_name) ?? 'tool'}` };
        break;
      case 'Notification':
        if (raw.notification_type !== 'ToolPermission') return null;
        event = { kind: 'permissionRequest' };
        break;
      default:
        return null;
    }
    return { sessionId, event, cwd: string(raw.cwd), transcriptPath: string(raw.transcript_path) };
  },
};
