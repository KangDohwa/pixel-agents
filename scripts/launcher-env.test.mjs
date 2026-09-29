import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import ts from 'typescript';

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`Electron and external mock home helper isolates provider overrides on ${platform}`, () => {
    const file = 'e2e/helpers/mock-claude.ts';
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const declaration = source.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'applyMockHomeEnv',
    );
    assert.ok(declaration);
    const apply = vm.runInNewContext(
      `${ts.transpileModule(declaration.getText(source), {}).outputText}\napplyMockHomeEnv`,
      { exports: {}, process: { platform }, path },
    );
    const external = path.join(os.tmpdir(), 'external-home');
    const home = path.join(os.tmpdir(), 'isolated-home');
    const original = {
      HOME: external,
      USERPROFILE: external,
      CODEX_HOME: external,
      GEMINI_CLI_HOME: external,
      PIXEL_AGENTS_DEBUG_LOG: path.join(external, 'debug.log'),
      HOMEDRIVE: 'Z:',
      HOMEPATH: '\\external-home',
    };
    const env = apply(original, home);
    assert.equal(env.HOME, home);
    assert.equal(env.USERPROFILE, home);
    assert.equal(env.CODEX_HOME, path.join(home, '.codex'));
    assert.equal(env.GEMINI_CLI_HOME, home);
    assert.equal(env.PIXEL_AGENTS_DEBUG_LOG, path.join(home, '.pixel-agents', 'debug.log'));
    if (platform === 'win32') {
      assert.equal(env.HOMEDRIVE, undefined);
      assert.equal(env.HOMEPATH, undefined);
    }
    assert.equal(original.HOME, external);
    assert.equal(original.CODEX_HOME, external);
    assert.equal(original.PIXEL_AGENTS_DEBUG_LOG, path.join(external, 'debug.log'));
  });
}

for (const [file, functionName, envKey] of [
  ['scripts/verify-vsix-package.mjs', 'verifyExtensionHost', 'extensionTestsEnv'],
  ['e2e/helpers/standalone.ts', 'spawnStandaloneHost', 'env'],
]) {
  test(`${file} isolates child homes and debug logs`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-launcher-env-'));
    try {
      const home = path.join(root, 'home');
      const external = path.join(root, 'external');
      fs.mkdirSync(home);
      fs.mkdirSync(external);
      const sentinel = path.join(external, 'debug.log');
      fs.writeFileSync(sentinel, 'untouched');
      const parentEnv = {
        ...process.env,
        HOME: external,
        USERPROFILE: external,
        CODEX_HOME: external,
        GEMINI_CLI_HOME: external,
        PIXEL_AGENTS_DEBUG_LOG: sentinel,
      };
      const manifest = path.join(root, 'package.json');
      fs.writeFileSync(manifest, JSON.stringify({ publisher: 'test', name: 'test' }));
      const source = ts.createSourceFile(
        file,
        fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const declaration = source.statements.find(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === functionName,
      );
      assert.ok(declaration, `Missing launcher: ${functionName}`);
      let childEnv;
      const capture = (options) => {
        childEnv = options[envKey];
      };
      // Execute the actual launcher with only the process boundary stubbed.
      const launch = vm.runInNewContext(
        `${ts.transpileModule(declaration.getText(source), {}).outputText}\n${functionName}`,
        {
          fs,
          path,
          process: { env: parentEnv, platform: 'win32', execPath: process.execPath },
          REPO_ROOT: root,
          STANDALONE_CLI: manifest,
          writeExtensionSmokeRunner: () => {},
          runTests: capture,
          spawn: (_command, _args, options) => capture(options),
        },
      );
      if (envKey === 'extensionTestsEnv') await launch(root, root);
      else launch({ homeDir: home, hostPort: 12345, workspaceDir: root });
      assert.ok(childEnv);
      if (envKey === 'env') assert.equal(childEnv.NODE_PATH, path.join(root, 'node_modules'));
      assert.equal(parentEnv.NODE_PATH, process.env.NODE_PATH);
      assert.equal(childEnv.HOME, home);
      assert.equal(childEnv.USERPROFILE, home);
      assert.equal(childEnv.CODEX_HOME, path.join(home, '.codex'));
      assert.equal(childEnv.GEMINI_CLI_HOME, home);
      assert.equal(childEnv.PIXEL_AGENTS_DEBUG_LOG, path.join(home, 'debug.log'));
      execFileSync(
        process.execPath,
        [
          '-e',
          `
          const assert = require('node:assert/strict');
          const fs = require('node:fs');
          const path = require('node:path');
          assert.equal(require('node:os').homedir(), process.env.HOME);
          for (const key of ['CODEX_HOME', 'GEMINI_CLI_HOME']) {
            fs.mkdirSync(process.env[key], { recursive: true });
            fs.writeFileSync(path.join(process.env[key], 'probe'), 'isolated');
          }
          fs.appendFileSync(process.env.PIXEL_AGENTS_DEBUG_LOG, 'isolated');
        `,
        ],
        { cwd: root, env: childEnv, stdio: 'pipe' },
      );
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched');
      assert.deepEqual(fs.readdirSync(external), ['debug.log']);
      assert.equal(parentEnv.PIXEL_AGENTS_DEBUG_LOG, sentinel);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
