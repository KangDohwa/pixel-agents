import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import { isServerTarget, type ServerTarget } from '../../../../serverConfig.js';

async function main(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 1_048_576) return;
  }
  const raw = JSON.parse(input) as Record<string, unknown>;
  if (typeof raw.session_id !== 'string' || typeof raw.hook_event_name !== 'string') return;
  // Observe only. No prompt, response, arguments, result or notification text.
  const allowed = [
    'session_id',
    'hook_event_name',
    'transcript_path',
    'cwd',
    'timestamp',
    'tool_name',
    'notification_type',
    'source',
    'reason',
  ];
  const body = JSON.stringify(
    Object.fromEntries(
      allowed.filter((key) => typeof raw[key] === 'string').map((key) => [key, raw[key]]),
    ),
  );
  const root = path.join(os.homedir(), '.pixel-agents');
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(path.join(root, 'servers'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(root, 'servers', f));
  } catch {
    /* legacy server */
  }
  if (!files.length) files = [path.join(root, 'server.json')];
  const targets: ServerTarget[] = [];
  for (const file of files) {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (isServerTarget(value)) targets.push(value);
    } catch {
      /* stale registry entry */
    }
  }
  await Promise.all(
    targets.map(
      (target) =>
        new Promise<void>((resolve) => {
          const req = http.request(
            {
              hostname: '127.0.0.1',
              port: target.port,
              path: '/api/hooks/gemini',
              method: 'POST',
              timeout: 1500,
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                Authorization: `Bearer ${target.token}`,
              },
            },
            (res) => {
              res.resume();
              resolve();
            },
          );
          req.on('error', () => resolve());
          req.on('timeout', () => {
            req.destroy();
            resolve();
          });
          req.end(body);
        }),
    ),
  );
}

// Never change Gemini's decisions or fail a user's turn when the office is off.
void main()
  .catch(() => {})
  .finally(() => process.stdout.write('{}\n'));
