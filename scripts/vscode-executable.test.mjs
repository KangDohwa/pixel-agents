import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const sourceDir = process.env.VSCODE_SETUP_SOURCE_DIR
  ? path.resolve(process.env.VSCODE_SETUP_SOURCE_DIR)
  : fileURLToPath(new URL('../e2e', import.meta.url));
const compiled = Object.fromEntries(
  ['global-setup', 'run-config'].map((name) => [
    name,
    ts.transpileModule(fs.readFileSync(path.join(sourceDir, `${name}.ts`), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText,
  ]),
);

// Execute the complete setup; only platform, download, and lock timing are controlled.
function loadSetup(root, platform, download, onLock) {
  const io = {
    ...fs,
    mkdirSync(dir, options) {
      const result = fs.mkdirSync(dir, options);
      if (path.basename(dir) === 'download.lock') onLock();
      return result;
    },
  };
  function load(name) {
    const exports = {};
    vm.runInNewContext(compiled[name], {
      exports,
      __dirname: path.join(root, 'e2e'),
      process: { platform, pid: process.pid, env: {} },
      console: { log() {} },
      setTimeout,
      require(id) {
        if (id === '@vscode/test-electron') return { downloadAndUnzipVSCode: download };
        if (id === './run-config') return load('run-config');
        if (id === 'fs') return io;
        return require(id);
      },
    });
    return exports;
  }
  return load('global-setup');
}

async function checkSetup(platform, mode, files, returnedName, expectedName) {
  const tempRoot = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, 'vscode-path-'));
  try {
    const bin = path.join(root, 'Visual Studio Code.app', 'Contents', 'MacOS');
    const returnedPath = path.join(bin, returnedName);
    fs.mkdirSync(bin, { recursive: true });
    for (const name of files) fs.writeFileSync(path.join(bin, name), '');
    let downloads = 0;
    let locks = 0;
    const setup = loadSetup(
      root,
      platform,
      async (options) => {
        downloads++;
        assert.equal(options.version, 'stable');
        assert.equal(options.cachePath, setup.VSCODE_CACHE_DIR);
        return returnedPath;
      },
      () => {
        locks++;
        if (mode === 'cache-after-lock') {
          fs.writeFileSync(setup.VSCODE_PATH_FILE, returnedPath);
        }
      },
    );
    if (mode === 'cache') {
      fs.mkdirSync(setup.VSCODE_CACHE_DIR, { recursive: true });
      fs.writeFileSync(setup.VSCODE_PATH_FILE, `  ${returnedPath}\n`);
    }
    if (expectedName === null) {
      await assert.rejects(setup.default, { message: /VS Code executable not found/ });
      assert.equal(downloads, 1);
      assert.equal(locks, 1);
      if (mode === 'fresh') assert.equal(fs.existsSync(setup.VSCODE_PATH_FILE), false);
      else assert.equal(fs.readFileSync(setup.VSCODE_PATH_FILE, 'utf8').trim(), returnedPath);
    } else {
      await setup.default();
      const savedPath = fs.readFileSync(setup.VSCODE_PATH_FILE, 'utf8');
      assert.equal(savedPath, path.join(bin, expectedName));
      assert.equal(fs.existsSync(savedPath), files.includes(expectedName));
      const cacheHit = mode !== 'fresh' && files.includes(expectedName);
      assert.equal(downloads, cacheHit ? 0 : 1);
      assert.equal(locks, mode === 'cache' && cacheHit ? 0 : 1);
    }
    assert.equal(fs.existsSync(path.join(setup.VSCODE_CACHE_DIR, 'download.lock')), false);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), tempRoot);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const mode of ['cache', 'fresh', 'cache-after-lock']) {
  for (const [label, files, returnedName, expectedName] of [
    ['legacy Electron', ['Electron'], 'Electron', 'Electron'],
    ['new Code', ['Code'], 'Electron', 'Code'],
    ['neither executable', [], 'Electron', null],
    ['both executables', ['Electron', 'Code'], 'Electron', 'Electron'],
    ['Code path already resolved', ['Code'], 'Code', 'Code'],
    ['stale Code path', ['Electron'], 'Code', 'Electron'],
  ]) {
    test(`darwin ${mode}: ${label}`, () =>
      checkSetup('darwin', mode, files, returnedName, expectedName));
  }
}

for (const platform of ['win32', 'linux']) {
  for (const mode of ['cache', 'fresh', 'cache-after-lock']) {
    const executable = platform === 'win32' ? 'Code.exe' : 'code';
    test(`${platform} ${mode}: preserve returned path`, () =>
      checkSetup(platform, mode, [executable, 'Code', 'Electron'], executable, executable));
    test(`${platform} ${mode}: do not substitute a missing path with macOS binaries`, () =>
      checkSetup(platform, mode, ['Code', 'Electron'], 'missing-code', 'missing-code'));
  }
}
