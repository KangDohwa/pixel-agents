const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');

const workflow = YAML.parse(fs.readFileSync(path.join(__dirname, 'workflows/ci.yml'), 'utf8'));
const gate = workflow.jobs.ci.steps.find(
  (step) => step.name === 'Fail If Any Blocking Check Failed',
);

function runGate(outcomes = {}) {
  const env = { ...process.env };
  for (const [key, expression] of Object.entries(gate.env)) {
    const id = /steps\.([\w-]+)\.outcome/.exec(expression)[1];
    env[key] = outcomes[id] ?? 'success';
  }
  const result = spawnSync(
    process.env.WORKFLOW_TEST_BASH || 'bash',
    ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', gate.run],
    { env, encoding: 'utf8' },
  );
  if (result.error) throw result.error;
  assert.notEqual(result.status, null, result.stderr);
  return result.status;
}

test('CI gate passes successful checks and rejects failed or skipped protocol checks', () => {
  assert.equal(runGate(), 0);
  for (const id of ['validate_spec', 'messages_drift', 'e2e_inventory_drift']) {
    for (const outcome of ['failure', 'skipped']) {
      assert.notEqual(runGate({ [id]: outcome }), 0, `${id}: ${outcome} must block CI`);
    }
  }
});
