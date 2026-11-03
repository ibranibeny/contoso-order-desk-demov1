import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const workflowUrl = new URL('../.github/workflows/feature-builder.md', import.meta.url);
const lockUrl = new URL('../.github/workflows/feature-builder.lock.yml', import.meta.url);

test('Feature Builder checks out runtime imports in activation pre-steps', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const preSteps = workflow.match(/^ {4}pre-steps:\n([\s\S]*?)(?=^\S)/m)?.[1];

  assert.ok(preSteps, 'Activation needs pre-steps before prompt interpolation');
  assert.match(preSteps, /uses: actions\/checkout@/);
  assert.match(preSteps, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(preSteps, /sparse-checkout: \.github\/workflows/);
  assert.match(preSteps, /persist-credentials: false/);
});

test('Feature Builder documents the manual issue number while allowing automatic label dispatch', async () => {
  for (const url of [workflowUrl, lockUrl]) {
    const workflow = await readFile(url, 'utf8');
    const input = workflow.match(/^ {6}item_number:\n((?:^ {8}.+\n)+)/m)?.[1];

    assert.ok(input, 'Manual dispatch must define item_number');
    assert.match(input, /^ {8}.*Required for manual runs: positive decimal feature issue number/m);
    assert.match(input, /^ {8}required: false$/m);
    assert.match(input, /^ {8}type: string$/m);
    assert.doesNotMatch(input, /^ {8}default:/m);
  }
});

test('compiled activation validates prerequisites before checkout and prompt rendering', async () => {
  const lock = await readFile(lockUrl, 'utf8');
  const activation = lock.match(/^ {2}activation:\n([\s\S]*?)(?=^ {2}[\w-]+:)/m)?.[1];
  const validationIndex = activation.indexOf('- name: Validate issue number and required secrets');
  const checkoutIndex = activation.indexOf('- name: Checkout workflow source for runtime imports');
  const interpolateIndex = activation.indexOf('interpolate_prompt.cjs');

  assert.ok(validationIndex >= 0);
  assert.ok(checkoutIndex > validationIndex);
  assert.ok(interpolateIndex > checkoutIndex);
});

test('activation validation accepts issue events and dispatches and reports all missing prerequisites', async () => {
  for (const url of [workflowUrl, lockUrl]) {
    const workflow = await readFile(url, 'utf8');
    const step = workflow.match(/- name: Validate issue number and required secrets\n([\s\S]*?)(?=^ {6}- name:)/m)?.[1];
    const script = step?.split('script: |\n')[1].replace(/^ {12}/gm, '');

    assert.ok(script, 'Validation script must exist');
    assert.match(step, /COPILOT_TOKEN_PRESENT: \$\{\{ secrets\.COPILOT_GITHUB_TOKEN != '' \}\}/);
    assert.match(step, /PUBLICATION_TOKEN_PRESENT: \$\{\{ secrets\.GH_AW_GITHUB_TOKEN != '' \}\}/);

    function validate(payload, copilot = 'true', publication = 'true') {
      const failures = [];
      runInNewContext(script, {
        context: { payload },
        process: { env: { COPILOT_TOKEN_PRESENT: copilot, PUBLICATION_TOKEN_PRESENT: publication } },
        core: { setFailed: (message) => failures.push(message) }
      });
      return failures;
    }

    assert.deepEqual(validate({ issue: { number: 42 } }), []);
    assert.deepEqual(validate({ inputs: { item_number: '42' } }), []);
    for (const item_number of ['', '0', '-1', '1.5', '1e2', ' 42 ', 'abc', '9007199254740992']) {
      assert.match(validate({ inputs: { item_number } })[0], /positive decimal integer/);
    }
    assert.match(validate({})[0], /positive decimal integer/);
    for (const tokens of [['false', 'true'], ['true', 'false'], ['false', 'false']]) {
      assert.match(validate({ inputs: { item_number: '42' } }, ...tokens)[0], /Configure COPILOT_GITHUB_TOKEN.*GH_AW_GITHUB_TOKEN/);
    }
    assert.equal(validate({}, 'true', 'false').length, 2);
  }
});

test('compiled activation checks out the workflow source before rendering runtime imports', async () => {
  const lock = await readFile(lockUrl, 'utf8');
  const activation = lock.match(/^ {2}activation:\n([\s\S]*?)(?=^ {2}[\w-]+:)/m)?.[1];

  assert.ok(activation, 'Compiled workflow must contain an activation job');
  const steps = activation.split(/(?=^ {6}- )/m);
  const checkoutIndex = steps.findIndex((step) => /uses: actions\/checkout@/.test(step));
  const interpolateIndex = steps.findIndex((step) => step.includes('interpolate_prompt.cjs'));

  assert.ok(checkoutIndex > 0, 'Activation must check out the workflow source');
  assert.ok(interpolateIndex > checkoutIndex, 'Checkout must run before prompt interpolation');
  assert.match(steps[checkoutIndex], /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(steps[checkoutIndex], /sparse-checkout: \.github\/workflows/);
  assert.match(steps[checkoutIndex], /persist-credentials: false/);
  assert.match(activation, /\{\{#runtime-import \.github\/workflows\/feature-builder\.md\}\}/);
});
