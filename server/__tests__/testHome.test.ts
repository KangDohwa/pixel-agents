import * as fs from 'fs';
import * as path from 'path';
import { expect, it, vi } from 'vitest';

it('isolates inherited debug logs and restores defined and absent environment values', async () => {
  const keys = ['HOME', 'USERPROFILE', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'PIXEL_AGENTS_DEBUG_LOG'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let cleanup: (() => void) | undefined;
  vi.doMock('vitest', () => ({ afterAll: (callback: () => void) => (cleanup = callback) }));
  try {
    for (const debugLog of [path.join(process.env.HOME!, 'inherited.log'), undefined]) {
      if (debugLog === undefined) delete process.env.PIXEL_AGENTS_DEBUG_LOG;
      else process.env.PIXEL_AGENTS_DEBUG_LOG = debugLog;
      const inherited = keys.map((key) => process.env[key]);
      vi.resetModules();
      await import('../testHome');
      const isolatedHome = process.env.HOME!;
      expect(isolatedHome).not.toBe(inherited[0]);
      expect(process.env.USERPROFILE).toBe(isolatedHome);
      expect(process.env.CODEX_HOME).toBe(path.join(isolatedHome, '.codex'));
      expect(process.env.GEMINI_CLI_HOME).toBe(isolatedHome);
      expect(process.env.PIXEL_AGENTS_DEBUG_LOG).toBeUndefined();
      expect(fs.existsSync(isolatedHome)).toBe(true);
      expect(cleanup).toBeTypeOf('function');
      cleanup!();
      cleanup = undefined;
      expect(keys.map((key) => process.env[key])).toEqual(inherited);
      expect(fs.existsSync(isolatedHome)).toBe(false);
    }
  } finally {
    cleanup?.();
    vi.doUnmock('vitest');
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
