import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const workflowUrl = new URL('../.github/workflows/feature-builder.md', import.meta.url);
const lockUrl = new URL('../.github/workflows/feature-builder.lock.yml', import.meta.url);

async function readActivationSteps() {
  const lock = await readFile(lockUrl, 'utf8');
  const activation = lock.match(/^ {2}activation:\n([\s\S]*?)(?=^ {2}[\w-]+:)/m)?.[1];

  assert.ok(activation, 'Compiled workflow must contain an activation job');
  return activation.split(/(?=^ {6}- )/m).slice(1);
}

function readValidationScript(source) {
  const step = source.match(/^ {6}- name: Validate issue number and required secrets\n([\s\S]*?)(?=^ {6}[-#] |^ {0,4}\S)/m)?.[1];
  const script = step?.split('script: |\n')[1]?.replace(/^ {12}/gm, '');

  assert.ok(script, 'Validation script must exist');
  assert.match(step, /COPILOT_TOKEN_PRESENT: \$\{\{ secrets\.COPILOT_GITHUB_TOKEN != '' \}\}/);
  assert.match(step, /PUBLICATION_TOKEN_PRESENT: \$\{\{ secrets\.GH_AW_GITHUB_TOKEN != '' \}\}/);
  return script;
}

// Runs the inline github-script body the same way actions/github-script wraps it.
async function validate(script, payload, { copilot = 'true', publication = 'true' } = {}) {
  const failures = [];
  await runInNewContext(`(async () => {\n${script}\n})()`, {
    context: { payload },
    core: { setFailed: (message) => failures.push(message) },
    process: { env: { COPILOT_TOKEN_PRESENT: copilot, PUBLICATION_TOKEN_PRESENT: publication } }
  });
  return failures;
}

test('Feature Builder checks out runtime imports in activation pre-steps', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const preSteps = workflow.match(/^ {4}pre-steps:\n([\s\S]*?)(?=^ {0,4}\S)/m)?.[1];

  assert.ok(preSteps, 'Activation needs pre-steps before prompt interpolation');
  assert.match(preSteps, /uses: actions\/checkout@/);
  assert.match(preSteps, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(preSteps, /sparse-checkout: \.github\/workflows/);
  assert.match(preSteps, /persist-credentials: false/);
});

test('compiled activation validates prerequisites before any other activation work', async () => {
  const names = (await readActivationSteps()).map((step) => step.match(/^ {6}- name: (.+)$/m)?.[1]);

  assert.deepEqual(names.slice(0, 3), [
    'Setup Scripts',
    'Validate issue number and required secrets',
    'Checkout workflow source for runtime imports'
  ]);
  for (const later of ['Check daily workflow token guardrail', 'Remove trigger label', 'Interpolate variables and render templates']) {
    assert.ok(names.indexOf(later) > 2, `${later} must run after validation`);
  }
});

test('activation validation accepts issue events and valid manual issue numbers', async () => {
  for (const url of [workflowUrl, lockUrl]) {
    const script = readValidationScript(await readFile(url, 'utf8'));

    assert.deepEqual(await validate(script, { issue: { number: 42 } }), []);
    assert.deepEqual(await validate(script, { inputs: { item_number: '42' } }), []);
    assert.deepEqual(await validate(script, { inputs: { item_number: '9007199254740991' } }), []);
  }
});

test('activation validation explains how to start a manual run without an issue number', async () => {
  for (const url of [workflowUrl, lockUrl]) {
    const script = readValidationScript(await readFile(url, 'utf8'));

    for (const payload of [{ inputs: { item_number: '' } }, { inputs: {} }, {}]) {
      const failures = await validate(script, payload);
      assert.equal(failures.length, 1);
      assert.match(failures[0], /^item_number is empty: start a new run from Actions > Feature Builder > Run workflow/);
      assert.match(failures[0], /apply the agent-build label/);
      assert.match(failures[0], /Re-running this run reuses its inputs/);
    }
    for (const item_number of ['0', '-1', '1.5', '1e2', '012', ' 42', '42 ', '#42', 'abc', '9007199254740992']) {
      const failures = await validate(script, { inputs: { item_number } });
      assert.equal(failures.length, 1, `${JSON.stringify(item_number)} must be rejected`);
      assert.match(failures[0], /^item_number is not a positive decimal integer: start a new run/);
    }
  }
});

test('activation validation names each missing secret', async () => {
  for (const url of [workflowUrl, lockUrl]) {
    const script = readValidationScript(await readFile(url, 'utf8'));
    const payload = { inputs: { item_number: '42' } };

    const [copilot] = await validate(script, payload, { copilot: 'false' });
    assert.match(copilot, /secret COPILOT_GITHUB_TOKEN for inference \(Settings > Secrets and variables > Actions\)/);
    assert.doesNotMatch(copilot, /GH_AW_GITHUB_TOKEN/);

    const [publication] = await validate(script, payload, { publication: 'false' });
    assert.match(publication, /secret GH_AW_GITHUB_TOKEN for pull request publication \(Settings/);
    assert.doesNotMatch(publication, /COPILOT_GITHUB_TOKEN/);

    const both = await validate(script, payload, { copilot: 'false', publication: 'false' });
    assert.equal(both.length, 1);
    assert.match(both[0], /secrets COPILOT_GITHUB_TOKEN for inference and GH_AW_GITHUB_TOKEN for pull request publication/);
  }
});

test('activation validation reports an empty manual issue number and a missing secret together', async () => {
  // Reproduces run 41646587672: a manual run without item_number and without GH_AW_GITHUB_TOKEN.
  for (const url of [workflowUrl, lockUrl]) {
    const script = readValidationScript(await readFile(url, 'utf8'));
    const failures = await validate(script, { inputs: { item_number: '', aw_context: '' } }, { publication: 'false' });

    assert.equal(failures.length, 2);
    assert.match(failures[0], /^item_number is empty/);
    assert.match(failures[1], /GH_AW_GITHUB_TOKEN for pull request publication/);
  }
});

test('source and compiled workflow run the same validation script', async () => {
  const source = readValidationScript(await readFile(workflowUrl, 'utf8'));
  const compiled = readValidationScript(await readFile(lockUrl, 'utf8'));

  assert.equal(compiled, source, 'Recompile with gh aw compile feature-builder');
});

test('manual dispatch keeps the optional item_number input generated by gh-aw', async () => {
  const lock = await readFile(lockUrl, 'utf8');
  const dispatch = lock.match(/^ {2}workflow_dispatch:\n((?:^ {4,}.*\n)+)/m)?.[1];
  const itemNumber = dispatch?.match(/^ {6}item_number:\n((?:^ {8}.*\n)+)/m)?.[1];

  assert.ok(itemNumber, 'Manual dispatch must offer item_number');
  assert.match(itemNumber, /^ {8}required: false$/m);
  // Declaring inputs in the source compiles to a "types" key that workflow_dispatch does not accept.
  assert.doesNotMatch(dispatch, /^ {4}types:/m);
  assert.doesNotMatch(await readFile(workflowUrl, 'utf8'), /^ {2}workflow_dispatch:\n {4}inputs:/m);
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
