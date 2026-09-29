import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import { launchStandalone } from '../../helpers/standalone';
import { openSettingsModal, setSettings } from '../../helpers/webview';
import type {} from '../../../webview-ui/src/testHooks';

test('Codex first parent link displays and persists the chosen parent appearance @area:standalone', async ({
  page,
  standalone,
}) => {
  await setSettings(page, { watchAllSessions: true });
  const dir = path.join(standalone.tmpHome, '.codex/sessions/2026/09/29');
  fs.mkdirSync(dir, { recursive: true });
  const write = (id: string, parent?: string) =>
    fs.writeFileSync(
      path.join(dir, `rollout-${id}.jsonl`),
      JSON.stringify({
        type: 'session_meta',
        payload: { id, cwd: standalone.workspaceDir, parent_thread_id: parent },
      }) + '\n',
    );
  const characters = () =>
    page.evaluate(() =>
      window.__pixelAgentsTestHooks!.getCharacters!().filter((c) => !c.isGreeter),
    );
  write('parent');
  await expect.poll(async () => (await characters()).length).toBe(1);
  const parent = (await characters())[0];
  const modal = await openSettingsModal(page);
  await modal.getByRole('combobox', { name: 'Head', exact: true }).selectOption('2');
  await modal.getByRole('combobox', { name: 'Body', exact: true }).selectOption('1');
  await modal.getByRole('combobox', { name: 'Clothes', exact: true }).selectOption('2');
  const chosen = { head: 2, body: 1, clothes: 2 };
  const statePath = path.join(standalone.tmpHome, '.pixel-agents/standalone-state.json');
  const saved = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  await expect.poll(() => saved().seats[parent.id]?.appearance).toEqual(chosen);
  write('child', 'parent');
  await expect.poll(async () => (await characters()).length).toBe(2);
  const child = (await characters()).find((c) => c.id !== parent.id)!;
  await expect
    .poll(async () => (await characters()).find((c) => c.id === child.id)?.appearance)
    .toEqual(chosen);
  await expect.poll(() => saved().seats[child.id]?.appearance).toEqual(chosen);
  await standalone.stopHost();
  await standalone.startHost();
  await page.reload();
  await expect
    .poll(async () => (await characters()).find((c) => c.id === child.id)?.appearance)
    .toEqual(chosen);
  expect(saved().seats[child.id]?.appearance).toEqual(chosen);
});

test('corrupt copied manifest delivers Legacy fallback without losing the saved choice @area:standalone', async ({
  page,
}) => {
  const tempRoot = path.resolve(os.tmpdir());
  const build = fs.mkdtempSync(path.join(tempRoot, 'pixel-assets-'));
  fs.cpSync(path.resolve(__dirname, '../../../dist'), build, { recursive: true });
  let standalone: Awaited<ReturnType<typeof launchStandalone>> | undefined;
  try {
    standalone = await launchStandalone(page, { cliPath: path.join(build, 'cli.js') });
    await setSettings(page, { watchAllSessions: true });
    const file = path.join(standalone.tmpHome, '.gemini/tmp/project/chats/session-corrupt.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ sessionId: 'corrupt-test', directories: [standalone.workspaceDir] }) + '\n',
    );
    const characters = () =>
      page.evaluate(() =>
        window.__pixelAgentsTestHooks!.getCharacters!().filter((c) => !c.isGreeter),
      );
    await expect.poll(async () => (await characters()).length).toBe(1);
    let modal = await openSettingsModal(page);
    await modal.getByRole('combobox', { name: 'Head', exact: true }).selectOption('2');
    const selected = (await characters())[0];
    const statePath = path.join(standalone.tmpHome, '.pixel-agents/standalone-state.json');
    await expect
      .poll(() => JSON.parse(fs.readFileSync(statePath, 'utf8')).seats[selected.id]?.appearance)
      .toEqual(selected.appearance);
    await standalone.stopHost();
    const manifestPath = path.join(build, 'assets/characters/layered/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.cells.heads[0][0] = [];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    await standalone.startHost();
    await page.reload();
    modal = await openSettingsModal(page);
    await expect(
      modal.getByText('Layered assets unavailable. Showing the legacy character.'),
    ).toBeVisible();
    await expect(modal.getByRole('combobox', { name: 'Head', exact: true })).toBeDisabled();
    expect((await characters())[0].appearance).toEqual(selected.appearance);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).seats[selected.id]?.appearance).toEqual(
      selected.appearance,
    );
    expect(
      await modal
        .locator('canvas')
        .evaluate((canvas) =>
          Array.from(
            (canvas as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 192, 128).data,
          ).some((v) => v > 0),
        ),
    ).toBe(true);
  } finally {
    await standalone?.cleanup();
    expect(path.dirname(path.resolve(build))).toBe(tempRoot);
    fs.rmSync(build, { recursive: true, force: true });
  }
});

test('layered character controls persist through reload, reconnect and restart; old saves stay Legacy @area:standalone', async ({
  page,
  standalone,
}, info) => {
  await setSettings(page, { watchAllSessions: true, alwaysShowLabels: true });
  const transcript = path.join(
    standalone.tmpHome,
    '.gemini/tmp/project/chats/session-appearance.jsonl',
  );
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(
    transcript,
    JSON.stringify({ sessionId: 'appearance-session', directories: [standalone.workspaceDir] }) +
      '\n' +
      JSON.stringify({ id: 'a', type: 'gemini', content: [{ text: 'synthetic' }] }) +
      '\n',
  );
  const characters = () =>
    page.evaluate(
      () => window.__pixelAgentsTestHooks?.getCharacters?.().filter((ch) => !ch.isGreeter) ?? [],
    );
  await expect.poll(async () => (await characters()).length).toBe(1);
  const initial = (await characters())[0];
  expect(initial.appearance).not.toBeNull();
  let modal = await openSettingsModal(page);
  await expect(modal.getByRole('combobox', { name: 'Character style' })).toHaveValue('layered');
  const chosen = { head: 2, body: 1, clothes: 2 };
  await modal.getByRole('combobox', { name: 'Head', exact: true }).selectOption('2');
  await modal.getByRole('combobox', { name: 'Body', exact: true }).selectOption('1');
  await modal.getByRole('combobox', { name: 'Clothes', exact: true }).selectOption('2');
  await expect.poll(async () => (await characters())[0].appearance).toEqual(chosen);
  const statePath = path.join(standalone.tmpHome, '.pixel-agents/standalone-state.json');
  const saved = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  await expect.poll(() => saved().seats[initial.id]?.appearance).toEqual(chosen);
  await page.screenshot({ path: info.outputPath('settings.png') });
  await modal.getByRole('button', { name: 'x', exact: true }).click();
  await setSettings(page, { alwaysShowLabels: false });
  await page
    .locator('canvas')
    .first()
    .click({ position: { x: 80, y: 80 } });
  await page.screenshot({ path: info.outputPath('office.png') });
  await page.reload();
  await expect.poll(async () => (await characters())[0]?.appearance).toEqual(chosen);
  await standalone.stopHost();
  await standalone.startHost();
  await expect.poll(async () => (await characters())[0]?.appearance).toEqual(chosen);
  // A full browser reload proves server restore, rather than retained in-memory UI.
  await page.reload();
  await expect.poll(async () => (await characters())[0]?.appearance).toEqual(chosen);
  modal = await openSettingsModal(page);
  await modal.getByRole('combobox', { name: 'Character style' }).selectOption('legacy');
  await expect.poll(() => saved().seats[initial.id]?.appearance).toBeNull();
  await page.reload();
  await expect.poll(async () => (await characters())[0]?.appearance).toBeNull();
  expect((await characters())[0].palette).toBe(initial.palette);

  // An actual pre-layer seat record has no appearance field at all.
  await standalone.stopHost();
  const old = saved();
  delete old.seats[initial.id].appearance;
  fs.writeFileSync(statePath, JSON.stringify(old));
  await standalone.startHost();
  await page.reload();
  await expect.poll(async () => (await characters())[0]?.appearance).toBeNull();
  expect((await characters())[0].palette).toBe(initial.palette);
});

test('layered character fallback and asset reload preserve selections @area:standalone', async ({
  page,
  standalone,
}) => {
  await setSettings(page, { watchAllSessions: true });
  const file = path.join(standalone.tmpHome, '.gemini/tmp/project/chats/session-fallback.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ sessionId: 'fallback-session', directories: [standalone.workspaceDir] }) +
      '\n' +
      JSON.stringify({ id: 'a', type: 'gemini' }) +
      '\n',
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__pixelAgentsTestHooks?.getCharacters?.().filter((ch) => !ch.isGreeter).length,
      ),
    )
    .toBe(1);
  const modal = await openSettingsModal(page);
  await modal.getByRole('combobox', { name: 'Head', exact: true }).selectOption('1');
  const before = await page.evaluate(
    () => window.__pixelAgentsTestHooks!.getCharacters!().find((ch) => !ch.isGreeter)!.appearance,
  );
  const dir = path.join(standalone.tmpHome, 'external-assets');
  fs.mkdirSync(dir);
  await modal.getByPlaceholder('Absolute asset directory path').fill(dir);
  await modal.getByRole('button', { name: 'Add', exact: true }).click();
  await expect
    .poll(async () =>
      (await standalone.drainMessages()).some((m) => m.type === 'characterSpritesLoaded'),
    )
    .toBe(true);
  await expect(modal.getByRole('combobox', { name: 'Head', exact: true })).toHaveValue('1');
  await page.routeWebSocket('**/ws*', (ws) => {
    const server = ws.connectToServer();
    server.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'characterSpritesLoaded') delete message.layeredCharacters;
      ws.send(JSON.stringify(message));
    });
  });
  await page.reload();
  const fallback = await openSettingsModal(page);
  await expect(
    fallback.getByText('Layered assets unavailable. Showing the legacy character.'),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => window.__pixelAgentsTestHooks!.getCharacters!().find((ch) => !ch.isGreeter)!.appearance,
    ),
  ).toEqual(before);
  await expect(fallback.getByRole('combobox', { name: 'Head', exact: true })).toBeDisabled();
  const pixels = await fallback
    .locator('canvas')
    .evaluate((canvas) =>
      Array.from(
        (canvas as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 192, 128).data,
      ).some((n) => n > 0),
    );
  expect(pixels).toBe(true);
});

test('layered character saves through the VS Code postMessage transport @area:standalone', async ({
  page,
  standalone,
}) => {
  await setSettings(page, { watchAllSessions: true });
  await page.addInitScript(() => {
    const target = window as unknown as {
      acquireVsCodeApi: () => { postMessage: (message: unknown) => void };
    };
    const socket = new WebSocket(`ws://${location.host}/ws${location.search}`);
    const pending: string[] = [];
    socket.onopen = () => {
      for (const message of pending) socket.send(message);
    };
    socket.onmessage = (event) => window.postMessage(JSON.parse(event.data), '*');
    target.acquireVsCodeApi = () => ({
      postMessage: (message) => {
        const json = JSON.stringify(message);
        if (socket.readyState === WebSocket.OPEN) socket.send(json);
        else pending.push(json);
      },
    });
  });
  await page.reload();
  const file = path.join(standalone.tmpHome, '.gemini/tmp/project/chats/session-vscode.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ sessionId: 'vscode-appearance', directories: [standalone.workspaceDir] }) +
      '\n' +
      JSON.stringify({ id: 'a', type: 'gemini' }) +
      '\n',
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__pixelAgentsTestHooks?.getCharacters?.().filter((ch) => !ch.isGreeter).length,
      ),
    )
    .toBe(1);
  const modal = await openSettingsModal(page);
  await modal.getByRole('combobox', { name: 'Head', exact: true }).selectOption('2');
  await modal.getByRole('combobox', { name: 'Body', exact: true }).selectOption('2');
  const statePath = path.join(standalone.tmpHome, '.pixel-agents/standalone-state.json');
  await expect
    .poll(() =>
      Object.values(JSON.parse(fs.readFileSync(statePath, 'utf8')).seats).some(
        (seat: any) => seat.appearance?.head === 2 && seat.appearance?.body === 2,
      ),
    )
    .toBe(true);
  await page.reload();
  const restored = await openSettingsModal(page);
  await expect(restored.getByRole('combobox', { name: 'Head', exact: true })).toHaveValue('2');
  await expect(restored.getByRole('combobox', { name: 'Body', exact: true })).toHaveValue('2');
});

test('Vite decoded and browser PNG fallback both load all layered combinations @area:standalone', async ({
  page,
}) => {
  const root = path.resolve(__dirname, '../../../webview-ui');
  const vite = spawn(
    process.execPath,
    [path.resolve(root, '../node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '0'],
    { cwd: root, windowsHide: true, stdio: 'pipe' },
  );
  let url: string | undefined;
  vite.stdout.on('data', (chunk) => {
    url ??= String(chunk).match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
  });
  try {
    await expect.poll(() => url).toBeTruthy();
    await page.addInitScript(() => {
      (window as unknown as { __PIXEL_AGENTS_E2E: boolean }).__PIXEL_AGENTS_E2E = true;
    });
    for (const fallback of [false, true]) {
      if (fallback) await page.route('**/assets/decoded/**', (route) => route.abort());
      await page.goto(url!);
      await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
      const result = await page.evaluate(async () => {
        const modulePath = '/src/office/sprites/spriteData.ts';
        const { getCharacterSprites } = await import(modulePath);
        const distinct = new Set<string>();
        const legacy = getCharacterSprites(0);
        for (let head = 0; head < 3; head++)
          for (let body = 0; body < 3; body++)
            for (let clothes = 0; clothes < 3; clothes++) {
              const sprites = getCharacterSprites(0, 0, { head, body, clothes });
              if (sprites === legacy) throw Error('Layer loading fell back to legacy');
              distinct.add(JSON.stringify(sprites));
            }
        return distinct.size;
      });
      expect(result).toBe(27);
    }
  } finally {
    if (vite.exitCode === null)
      await new Promise<void>((resolve) => {
        vite.once('exit', () => resolve());
        vite.kill();
      });
  }
});
