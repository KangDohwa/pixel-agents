import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import { openSettingsModal, setSettings } from '../../helpers/webview';

test('provider files reach UI; unknown stays silent; rewind corrects displayed usage', async ({
  page,
  standalone,
}) => {
  await setSettings(page, { alwaysShowLabels: true, watchAllSessions: true });
  const file = path.join(standalone.tmpHome, '.gemini/tmp/project/chats/session-short.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = (record: unknown) => JSON.stringify(record) + '\n';
  fs.writeFileSync(
    file,
    line({ sessionId: 'gemini-full-session', directories: [standalone.workspaceDir] }) +
      line({ id: 'a', type: 'gemini', content: [{ text: 'synthetic' }], tokens: { total: 20 } }),
  );
  await expect(page.getByText('Unknown (not observable)', { exact: true })).toBeVisible();
  await expect(page.getByText('Tokens: 20', { exact: true })).toBeVisible();
  fs.appendFileSync(file, line({ id: 'b', type: 'gemini', tokens: { total: 5 } }));
  await expect(page.getByText('Tokens: 25', { exact: true })).toBeVisible();
  fs.appendFileSync(file, line({ $rewindTo: 'b' }));
  await expect(page.getByText('Tokens: 20', { exact: true })).toBeVisible();
  const messages = await standalone.drainMessages();
  expect(messages).toContainEqual(
    expect.objectContaining({ type: 'agentCreated', providerId: 'gemini' }),
  );
  expect(messages.some((m) => m.type === 'agentStatus' && m.status === 'waiting')).toBe(false);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __pixelAgentsTestHooks?: { playedSounds?: unknown[] } })
          .__pixelAgentsTestHooks?.playedSounds ?? [],
    ),
  ).toEqual([]);

  const codex = path.join(standalone.tmpHome, '.codex/sessions/2026/09/29/rollout-synthetic.jsonl');
  fs.mkdirSync(path.dirname(codex), { recursive: true });
  fs.writeFileSync(
    codex,
    line({
      type: 'session_meta',
      payload: { id: 'codex-full-session', cwd: standalone.workspaceDir },
    }) +
      line({ type: 'event_msg', payload: { type: 'task_started' } }) +
      line({
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'c',
          name: 'read_file',
          arguments: '{"path":"synthetic.ts"}',
        },
      }),
  );
  await expect(page.getByText('read_file: synthetic.ts', { exact: true })).toBeVisible();
  fs.appendFileSync(codex, line({ type: 'event_msg', payload: { type: 'turn_aborted' } }));
  await expect(page.getByText('Turn interrupted', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __pixelAgentsTestHooks?: { playedSounds?: unknown[] } })
          .__pixelAgentsTestHooks?.playedSounds ?? [],
    ),
  ).toEqual([]);
});

test('VS Code webview provider selector sends the selected provider without bypass', async ({
  browser,
  standalone,
}) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      const target = window as unknown as {
        sent: unknown[];
        acquireVsCodeApi: () => { postMessage: (message: unknown) => void };
      };
      target.sent = [];
      const socket = new WebSocket(`ws://${location.host}/ws`);
      const pending: string[] = [];
      socket.onopen = () => {
        for (const message of pending) socket.send(message);
      };
      socket.onmessage = (event) => window.postMessage(JSON.parse(event.data), '*');
      target.acquireVsCodeApi = () => ({
        postMessage: (message) => {
          target.sent.push(message);
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
          else pending.push(JSON.stringify(message));
        },
      });
    });
    await page.goto(standalone.hostUrl);
    await expect(page.getByRole('button', { name: '+ Agent', exact: true })).toBeVisible();
    for (const providerId of ['codex', 'gemini']) {
      await page.getByRole('combobox', { name: 'Agent provider' }).selectOption(providerId);
      await page.getByRole('button', { name: '+ Agent', exact: true }).click();
      expect(
        await page.evaluate(() => (window as unknown as { sent: unknown[] }).sent.at(-1)),
      ).toEqual({ type: 'launchAgent', providerId });
    }
  } finally {
    await context.close();
  }
});

test('Gemini optional setup, authenticated hooks, permission and turn end reach the UI', async ({
  page,
  standalone,
}) => {
  await setSettings(page, { alwaysShowLabels: true, watchAllSessions: true });
  const modal = await openSettingsModal(page);
  const toggle = modal.getByRole('button', { name: /^Gemini CLI Hooks/ });
  await toggle.click();
  await expect(toggle.locator('span').last()).toHaveText('x');
  const settingsFile = path.join(standalone.tmpHome, '.gemini/settings.json');
  await expect.poll(() => fs.existsSync(settingsFile)).toBe(true);
  expect(fs.readFileSync(settingsFile, 'utf8')).toContain('pixel-agents-gemini');
  await modal.getByRole('button', { name: 'x', exact: true }).click();
  const file = path.join(standalone.tmpHome, '.gemini/tmp/test/chats/session-hooks.jsonl');
  async function hook(hook_event_name: string, extra: Record<string, string> = {}) {
    const response = await fetch(`${standalone.hostUrl}/api/hooks/gemini`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${standalone.hookServerConfig.token}`,
      },
      body: JSON.stringify({
        session_id: 'hooks-full',
        cwd: standalone.workspaceDir,
        transcript_path: file,
        hook_event_name,
        ...extra,
      }),
    });
    expect(response.ok).toBe(true);
  }
  await hook('BeforeAgent');
  await hook('BeforeTool', { tool_name: 'read_file' });
  await hook('Notification', { notification_type: 'ToolPermission' });
  await expect(page.getByText('Needs approval', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => window.__pixelAgentsTestHooks?.playedSounds?.map((s) => s.kind)),
  ).toEqual(['permission']);
  await page.reload();
  await expect(page.getByText('Needs approval', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__pixelAgentsTestHooks?.playedSounds ?? [])).toEqual([]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      sessionId: 'hooks-full',
      messages: [{ id: 'a', type: 'gemini', tokens: { total: 5 } }],
    }) + '\n',
  );
  await expect(page.getByText('Tokens: 5', { exact: true })).toBeVisible();
  await expect(page.getByText('Needs approval', { exact: true })).toBeVisible();
  await hook('AfterTool', { tool_name: 'read_file' });
  await expect(page.getByText('Needs approval', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Tokens: 5', { exact: true })).toBeVisible();
  await expect(page.getByText('Needs approval', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.__pixelAgentsTestHooks?.playedSounds ?? [])).toEqual([]);
  await hook('AfterAgent');
  await expect
    .poll(async () =>
      (await standalone.drainMessages()).some(
        (m) => m.type === 'agentStatus' && m.status === 'waiting',
      ),
    )
    .toBe(true);
  await hook('SessionEnd', { reason: 'exit' });
  await expect(page.getByTestId('agent-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await toggle.click();
  await expect(toggle.locator('span').last()).toHaveText('');
  expect(fs.readFileSync(settingsFile, 'utf8')).not.toContain('pixel-agents-gemini');
});
