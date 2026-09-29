import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { object } from '../../transcriptUtils.js';

const EVENTS = [
  'SessionStart',
  'SessionEnd',
  'BeforeAgent',
  'AfterAgent',
  'BeforeTool',
  'AfterTool',
  'Notification',
];
const NAME = 'pixel-agents-gemini';
const settingsPath = () =>
  path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini', 'settings.json');
const scriptPath = () => path.join(os.homedir(), '.pixel-agents', 'hooks', 'gemini-hook.js');
function hookCommand(): string {
  const file = scriptPath();
  if (process.platform === 'win32') {
    if (/[\r\n"%!]/.test(file))
      throw new Error('Gemini hook path contains unsupported shell characters');
    return `node "${file}"`;
  }
  return `node '${file.replace(/'/g, "'\\''")}'`;
}

function read(): { raw: string | null; settings: Record<string, unknown> } {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { raw: null, settings: {} };
    throw error;
  }
  const settings: unknown = JSON.parse(raw);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    throw new Error('Gemini settings must be a JSON object');
  return { raw, settings: settings as Record<string, unknown> };
}

function ours(hook: unknown): boolean {
  const value = object(hook);
  return value.name === NAME && value.command === hookCommand();
}

export function prepareHooks(bundleRoot: string): boolean {
  const source = path.join(bundleRoot, 'dist', 'hooks', 'gemini-hook.js');
  if (!fs.existsSync(source)) return false;
  fs.mkdirSync(path.dirname(scriptPath()), { recursive: true });
  fs.copyFileSync(source, scriptPath());
  return true;
}

async function mutate(install: boolean): Promise<void> {
  if (install && !fs.existsSync(scriptPath()))
    throw new Error('Gemini hook script is not installed');
  const { raw, settings } = read();
  // Only recover empty containers from our first-write backup. Never restore
  // values or hooks over the user's current settings during uninstall.
  let original: Record<string, unknown> = {};
  if (!install) {
    try {
      original = object(JSON.parse(fs.readFileSync(settingsPath() + '.pixel-agents.bak', 'utf8')));
    } catch {
      /* no prior settings or backup unavailable */
    }
  }
  const originalHooks = object(original.hooks);
  if (
    settings.hooks !== undefined &&
    (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))
  ) {
    throw new Error('Gemini hooks settings must be an object');
  }
  const hooks = object(settings.hooks);
  let removedAny = false;
  for (const event of EVENTS) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event]))
      throw new Error(`Gemini hooks.${event} must be an array`);
    const groups: unknown[] = [];
    let removed = false;
    for (const value of (hooks[event] as unknown[] | undefined) ?? []) {
      const group = object(value);
      if (!Array.isArray(group.hooks)) {
        groups.push(value);
        continue;
      }
      const remaining = group.hooks.filter((hook) => !ours(hook));
      if (remaining.length !== group.hooks.length) {
        removed = true;
        removedAny = true;
      }
      if (remaining.length === group.hooks.length) groups.push(value);
      else if (remaining.length) groups.push({ ...group, hooks: remaining });
    }
    if (install)
      groups.push({
        hooks: [{ name: NAME, type: 'command', command: hookCommand(), timeout: 3000 }],
      });
    if (groups.length) hooks[event] = groups;
    else if (removed) {
      if (Array.isArray(originalHooks[event]) && originalHooks[event].length === 0)
        hooks[event] = [];
      else delete hooks[event];
    }
  }
  if (!install && !removedAny) return;
  if (Object.keys(hooks).length || (original.hooks && Object.keys(originalHooks).length === 0))
    settings.hooks = hooks;
  else delete settings.hooks;
  if (JSON.stringify(settings) === JSON.stringify(raw === null ? {} : JSON.parse(raw))) return;
  const file = settingsPath();
  if (raw !== null && fs.lstatSync(file).isSymbolicLink())
    throw new Error('Gemini settings is a symlink; hook installation needs a regular file');
  const mode = raw === null ? 0o600 : fs.statSync(file).mode & 0o777;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Backup failure aborts the write. Never overwrite an earlier backup.
  if (raw !== null && !fs.existsSync(file + '.pixel-agents.bak'))
    fs.writeFileSync(file + '.pixel-agents.bak', raw, { flag: 'wx', mode });
  const tmp = `${file}.pixel-agents-${process.pid}-${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { flag: 'wx', mode });
    const current = read().raw;
    if (current !== raw)
      throw new Error('Gemini settings changed during hook installation; retry from Settings');
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

export async function installHooks(): Promise<void> {
  await mutate(true);
}
export async function uninstallHooks(): Promise<void> {
  await mutate(false);
}
export async function areHooksInstalled(): Promise<boolean> {
  const hooks = object(read().settings.hooks);
  return EVENTS.some(
    (event) =>
      Array.isArray(hooks[event]) &&
      (hooks[event] as unknown[]).some((group) => {
        const entries = object(group).hooks;
        return Array.isArray(entries) && entries.some(ours);
      }),
  );
}
