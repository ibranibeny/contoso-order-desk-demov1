import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflowUrl = new URL('../.github/workflows/feature-builder.md', import.meta.url);
const lockUrl = new URL('../.github/workflows/feature-builder.lock.yml', import.meta.url);

test('Feature Builder checks out runtime imports in activation pre-steps', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const preSteps = workflow.match(/^ {4}pre-steps:\n([\s\S]*?)(?=^ {4}steps:)/m)?.[1];

  assert.ok(preSteps, 'Activation needs pre-steps before prompt interpolation');
  assert.match(preSteps, /uses: actions\/checkout@/);
  assert.match(preSteps, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(preSteps, /sparse-checkout: \.github\/workflows/);
  assert.match(preSteps, /persist-credentials: false/);
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
