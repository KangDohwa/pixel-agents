import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { geminiProvider } from '../src/providers/index.js';

describe('optional Gemini hooks', () => {
  let root: string;
  let previous: Record<string, string | undefined>;
  const bundle = path.resolve(__dirname, '../..');
  const settings = () => path.join(root, '.gemini/settings.json');
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-hook-fixture-'));
    previous = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME,
    };
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    process.env.GEMINI_CLI_HOME = root;
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('checking is read-only; explicit install backs up and preserves settings, uninstall removes only owned hooks', async () => {
    expect(await geminiProvider.areHooksInstalled()).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
    fs.mkdirSync(path.dirname(settings()), { recursive: true });
    const original = {
      theme: 'synthetic',
      hooks: {
        SessionStart: [],
        SessionEnd: [null, { hooks: [] }],
        BeforeTool: [
          {
            matcher: 'read_file',
            hooks: [{ name: 'user-hook', type: 'command', command: 'echo keep' }],
          },
        ],
      },
    };
    const raw = JSON.stringify(original, null, 3);
    fs.writeFileSync(settings(), raw);
    expect(geminiProvider.prepareHooks!(bundle)).toBe(true);
    await geminiProvider.installHooks('', '');
    expect(await geminiProvider.areHooksInstalled()).toBe(true);
    expect(fs.readFileSync(settings() + '.pixel-agents.bak', 'utf8')).toBe(raw);
    const first = fs.readFileSync(settings(), 'utf8');
    expect(JSON.parse(first).theme).toBe('synthetic');
    await geminiProvider.installHooks('', '');
    expect(fs.readFileSync(settings(), 'utf8')).toBe(first);
    await geminiProvider.uninstallHooks();
    expect(JSON.parse(fs.readFileSync(settings(), 'utf8'))).toEqual(original);
    expect(await geminiProvider.areHooksInstalled()).toBe(false);
  });
  it('malformed/unsupported settings are never replaced and failed script preparation never installs', async () => {
    fs.mkdirSync(path.dirname(settings()), { recursive: true });
    fs.writeFileSync(settings(), '{ // unsupported JSONC');
    expect(geminiProvider.prepareHooks!(path.join(root, 'missing'))).toBe(false);
    await expect(geminiProvider.installHooks('', '')).rejects.toThrow();
    expect(fs.readFileSync(settings(), 'utf8')).toBe('{ // unsupported JSONC');
    expect(geminiProvider.prepareHooks!(bundle)).toBe(true);
    await expect(geminiProvider.installHooks('', '')).rejects.toThrow();
    expect(fs.readFileSync(settings(), 'utf8')).toBe('{ // unsupported JSONC');
    expect(fs.existsSync(settings() + '.pixel-agents.bak')).toBe(false);
  });
  it('partial or broken installs remain visible so the user can remove them', async () => {
    expect(geminiProvider.prepareHooks!(bundle)).toBe(true);
    await geminiProvider.installHooks('', '');
    const installed = JSON.parse(fs.readFileSync(settings(), 'utf8'));
    fs.writeFileSync(
      settings(),
      JSON.stringify({ hooks: { BeforeTool: installed.hooks.BeforeTool } }),
    );
    fs.unlinkSync(path.join(root, '.pixel-agents/hooks/gemini-hook.js'));
    expect(await geminiProvider.areHooksInstalled()).toBe(true);
    await geminiProvider.uninstallHooks();
    expect(JSON.parse(fs.readFileSync(settings(), 'utf8'))).toEqual({});
  });
  it('bundled hook sends only observation fields to authenticated loopback and returns neutral JSON', async () => {
    let body = '';
    let auth = '';
    let url = '';
    const server = http.createServer((req, res) => {
      auth = req.headers.authorization ?? '';
      url = req.url ?? '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      fs.mkdirSync(path.join(root, '.pixel-agents/servers'), { recursive: true });
      fs.writeFileSync(
        path.join(root, '.pixel-agents/servers/test.json'),
        JSON.stringify({ port, token: 'synthetic-test-token', pid: process.pid }),
      );
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(bundle, 'dist/hooks/gemini-hook.js')], {
          env: { ...process.env, HOME: root, USERPROFILE: root },
          stdio: 'pipe',
        });
        let stdout = '';
        child.stdout.on('data', (v) => {
          stdout += v;
        });
        child.on('error', reject);
        child.on('exit', (code) =>
          code === 0 ? resolve(stdout) : reject(new Error(`hook exited ${code}`)),
        );
        child.stdin.end(
          JSON.stringify({
            session_id: 'full-id',
            hook_event_name: 'BeforeTool',
            tool_name: 'read_file',
            cwd: root,
            prompt: 'DO NOT FORWARD',
            tool_input: { sensitive: 'DO NOT FORWARD' },
            tool_response: 'DO NOT FORWARD',
          }),
        );
      });
      expect(JSON.parse(output)).toEqual({});
      expect(auth).toBe('Bearer synthetic-test-token');
      expect(url).toBe('/api/hooks/gemini');
      expect(JSON.parse(body)).toEqual({
        session_id: 'full-id',
        hook_event_name: 'BeforeTool',
        tool_name: 'read_file',
        cwd: root,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
