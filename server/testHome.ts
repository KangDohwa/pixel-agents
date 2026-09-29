import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll } from 'vitest';

// A safety net for tests that do not provide their own home. Never inherit the
// operator's CLI history, credentials or settings into a test worker.
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-test-home-'));
const previousEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CODEX_HOME: process.env.CODEX_HOME,
  GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME,
  PIXEL_AGENTS_DEBUG_LOG: process.env.PIXEL_AGENTS_DEBUG_LOG,
};
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.CODEX_HOME = path.join(testHome, '.codex');
process.env.GEMINI_CLI_HOME = testHome;
delete process.env.PIXEL_AGENTS_DEBUG_LOG;
afterAll(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(testHome, { recursive: true, force: true });
});
