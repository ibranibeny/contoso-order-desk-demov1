import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const workflow = readFileSync(new URL('../.github/workflows/feature-builder.lock.yml', import.meta.url), 'utf8');
const activation = workflow.match(/^  activation:\n([\s\S]*?)(?=^  \w+:)/m)[1];
const validationName = '      - name: Validate issue number and required secrets';
const checkoutName = '      - name: Checkout workflow source for prompt interpolation';
const interpolationName = '      - name: Interpolate variables and render templates';
const validation = activation.slice(activation.indexOf(validationName), activation.indexOf(checkoutName));
const script = validation.split('          script: |\n')[1].replace(/^            /gm, '');

test('Feature Builder validates inputs and checks out its prompt source before interpolation', () => {
  const validationIndex = activation.indexOf(validationName);
  const checkoutIndex = activation.indexOf(checkoutName);
  const interpolationIndex = activation.indexOf(interpolationName);
  assert.ok(validationIndex >= 0);
  assert.ok(checkoutIndex > validationIndex);
  assert.ok(interpolationIndex > checkoutIndex);

  const checkout = activation.slice(checkoutIndex).split('\n      - name:')[0];
  assert.match(checkout, /uses: actions\/checkout@[a-f0-9]{40}\b/);
  assert.match(checkout, /persist-credentials: false/);
  assert.match(checkout, /ref: \$\{\{ github.sha \}\}/);
  assert.match(checkout, /sparse-checkout: \.github\/workflows/);
  assert.match(activation, /\{\{#runtime-import \.github\/workflows\/feature-builder\.md\}\}/);
});

function validate(payload, env = { COPILOT_TOKEN_PRESENT: 'true', PUBLICATION_TOKEN_PRESENT: 'true' }) {
  const errors = [];
  runInNewContext(`(function () { ${script} })()`, {
    context: { payload },
    process: { env },
    core: { setFailed: (message) => errors.push(message) }
  });
  return errors;
}

test('Feature Builder accepts issue labels and dispatches with a valid issue number', () => {
  assert.deepEqual(validate({ issue: { number: 42 } }), []);
  assert.deepEqual(validate({ inputs: { item_number: '42' } }), []);
});

test('Feature Builder rejects missing or invalid issue numbers before checkout', () => {
  for (const item_number of ['', '0', '-1', '1.5', 'abc', '9007199254740992']) {
    assert.deepEqual(validate({ inputs: { item_number } }), [
      'item_number must be a positive decimal integer identifying a feature issue.'
    ]);
  }
  assert.equal(validate({}).length, 1);
});

test('Feature Builder rejects missing inference or publication secrets', () => {
  for (const missing of ['COPILOT_TOKEN_PRESENT', 'PUBLICATION_TOKEN_PRESENT']) {
    const env = { COPILOT_TOKEN_PRESENT: 'true', PUBLICATION_TOKEN_PRESENT: 'true', [missing]: 'false' };
    assert.deepEqual(validate({ inputs: { item_number: '42' } }, env), [
      'Configure COPILOT_GITHUB_TOKEN for inference and GH_AW_GITHUB_TOKEN for pull request publication before running Feature Builder.'
    ]);
  }
});
