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
// `issues` maps an issue number to its REST data, or to an HTTP status the lookup fails with;
// unlisted numbers are open issues. `openIssues` is what the open-issue query returns.
async function validate(script, payload, {
  copilot = 'true',
  publication = 'true',
  issues = {},
  openIssues = [],
  listError
} = {}) {
  const failures = [];
  const warnings = [];
  const lookups = [];
  const github = {
    rest: {
      issues: {
        get: async ({ owner, repo, issue_number }) => {
          lookups.push(`${owner}/${repo}#${issue_number}`);
          const issue = issues[issue_number] ?? { number: issue_number, state: 'open' };
          if (typeof issue === 'number') {
            throw Object.assign(new Error(`HTTP ${issue}`), { status: issue });
          }
          return { data: issue };
        }
      }
    },
    graphql: async (query, { owner, repo }) => {
      assert.match(query, /issues\(states: OPEN, first: 10/);
      assert.deepEqual({ owner, repo }, { owner: 'contoso', repo: 'order-desk' });
      if (listError) {
        throw listError;
      }
      return { repository: { issues: { totalCount: openIssues.length, nodes: openIssues.slice(0, 10) } } };
    }
  };
  await runInNewContext(`(async () => {\n${script}\n})()`, {
    context: { payload, repo: { owner: 'contoso', repo: 'order-desk' } },
    core: { setFailed: (message) => failures.push(message), warning: (message) => warnings.push(message) },
    github,
    process: { env: { COPILOT_TOKEN_PRESENT: copilot, PUBLICATION_TOKEN_PRESENT: publication } }
  });
  return { failures, warnings, lookups };
}

const demoIssues = [
  { number: 12, title: 'Audit log of order lookups' },
  { number: 11, title: 'Agent lookup page' },
  { number: 10, title: 'Order lookup API' },
  { number: 9, title: '[Feature]: Order Desk: look up an order\'s status and delivery date' }
];

async function readValidationScripts() {
  return Promise.all([workflowUrl, lockUrl].map(async (url) => readValidationScript(await readFile(url, 'utf8'))));
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

test('activation validation accepts open issues from label events and manual runs', async () => {
  for (const script of await readValidationScripts()) {
    assert.deepEqual(
      await validate(script, { issue: { number: 42, state: 'open' } }),
      { failures: [], warnings: [], lookups: [] },
      'A label event already carries the issue'
    );
    assert.deepEqual(
      await validate(script, { inputs: { item_number: '42' } }),
      { failures: [], warnings: [], lookups: ['contoso/order-desk#42'] }
    );
    assert.deepEqual((await validate(script, { inputs: { item_number: '9007199254740991' } })).failures, []);
  }
});

test('activation validation lists open issues when a manual run has no valid issue number', async () => {
  for (const script of await readValidationScripts()) {
    for (const payload of [{ inputs: { item_number: '' } }, { inputs: {} }, {}]) {
      const { failures, lookups } = await validate(script, payload, { openIssues: demoIssues });
      assert.equal(failures.length, 1);
      assert.match(failures[0], /^item_number is empty: start a new run from Actions > Feature Builder > Run workflow/);
      assert.match(failures[0], /apply the agent-build label/);
      assert.match(
        failures[0],
        /Re-running this run reuses its inputs\. Open issues: #12 Audit log of order lookups; #11 Agent lookup page; #10 Order lookup API; #9 \[Feature\]: Order Desk: look up an order's status and delivery date\.$/
      );
      assert.deepEqual(lookups, []);
    }
    for (const item_number of ['0', '-1', '1.5', '1e2', '012', ' 42', '42 ', '#42', 'abc', '9007199254740992']) {
      const { failures, lookups } = await validate(script, { inputs: { item_number } }, { openIssues: demoIssues });
      assert.equal(failures.length, 1, `${JSON.stringify(item_number)} must be rejected`);
      assert.match(failures[0], /^item_number is not a positive decimal integer: start a new run/);
      assert.match(failures[0], /Open issues: #12 Audit log of order lookups; /);
      assert.deepEqual(lookups, [], 'Invalid numbers must not be looked up');
    }
  }
});

test('activation validation asks for a feature issue when the repository has none', async () => {
  // Reproduces run 41655166590: a manual run without item_number in a repository without issues.
  for (const script of await readValidationScripts()) {
    const { failures } = await validate(script, { inputs: { item_number: '', aw_context: '' } });

    assert.equal(failures.length, 1);
    assert.match(failures[0], /^item_number is empty: start a new run/);
    assert.match(
      failures[0],
      /This repository has no open issues: create the feature issue first \(Issues > New issue > Feature request\)\.$/
    );
  }
});

test('activation validation shortens a long list of open issues', async () => {
  const openIssues = Array.from({ length: 12 }, (_, index) => ({ number: 100 - index, title: `Feature ${100 - index}` }));

  for (const script of await readValidationScripts()) {
    const { failures } = await validate(script, {}, { openIssues });

    assert.match(failures[0], /Open issues: #100 Feature 100; #99 Feature 99; .*; #91 Feature 91; and 2 more\.$/);
  }
});

test('activation validation still explains a missing issue number when open issues cannot be listed', async () => {
  for (const script of await readValidationScripts()) {
    const { failures, warnings } = await validate(script, {}, { listError: new Error('Service unavailable') });

    assert.equal(failures.length, 1);
    assert.match(failures[0], /^item_number is empty: .*Re-running this run reuses its inputs\.$/);
    assert.deepEqual(warnings, ['Could not list open issues: Service unavailable']);
  }
});

test('activation validation rejects numbers that are not open issues', async () => {
  const cases = [
    [{ inputs: { item_number: '8' } }, { 8: { number: 8, state: 'closed', pull_request: {} } }, /^#8 is a pull request, not an issue: start a new run/],
    [{ inputs: { item_number: '7' } }, { 7: { number: 7, state: 'closed' } }, /^issue #7 is closed: start a new run/],
    [{ inputs: { item_number: '404' } }, { 404: 404 }, /^#404 was not found in contoso\/order-desk: start a new run/],
    [{ inputs: { item_number: '5' } }, { 5: 410 }, /^#5 was not found in contoso\/order-desk: start a new run/],
    [{ issue: { number: 7, state: 'closed' } }, {}, /^issue #7 is closed: start a new run/]
  ];

  for (const script of await readValidationScripts()) {
    for (const [payload, issues, expected] of cases) {
      const { failures, warnings } = await validate(script, payload, { issues, openIssues: demoIssues });
      assert.equal(failures.length, 1, `${JSON.stringify(payload)} must be rejected`);
      assert.match(failures[0], expected);
      assert.match(failures[0], /Open issues: #12 Audit log of order lookups; /);
      assert.deepEqual(warnings, []);
    }
  }
});

test('activation validation leaves the issue check to the agent when GitHub cannot answer', async () => {
  for (const script of await readValidationScripts()) {
    const { failures, warnings } = await validate(script, { inputs: { item_number: '42' } }, { issues: { 42: 502 } });

    assert.deepEqual(failures, []);
    assert.deepEqual(warnings, ['Could not check issue #42, so the agent checks it instead: HTTP 502']);
  }
});

test('activation validation names each missing secret', async () => {
  for (const script of await readValidationScripts()) {
    const payload = { inputs: { item_number: '42' } };

    const { failures: [copilot] } = await validate(script, payload, { copilot: 'false' });
    assert.match(copilot, /secret COPILOT_GITHUB_TOKEN for inference \(Settings > Secrets and variables > Actions\)/);
    assert.doesNotMatch(copilot, /GH_AW_GITHUB_TOKEN/);

    const { failures: [publication] } = await validate(script, payload, { publication: 'false' });
    assert.match(publication, /secret GH_AW_GITHUB_TOKEN for pull request publication \(Settings/);
    assert.doesNotMatch(publication, /COPILOT_GITHUB_TOKEN/);

    const { failures: both } = await validate(script, payload, { copilot: 'false', publication: 'false' });
    assert.equal(both.length, 1);
    assert.match(both[0], /secrets COPILOT_GITHUB_TOKEN for inference and GH_AW_GITHUB_TOKEN for pull request publication/);
  }
});

test('activation validation reports an empty manual issue number and a missing secret together', async () => {
  // Reproduces run 41646587672: a manual run without item_number and without GH_AW_GITHUB_TOKEN.
  for (const script of await readValidationScripts()) {
    const { failures } = await validate(script, { inputs: { item_number: '', aw_context: '' } }, { publication: 'false' });

    assert.equal(failures.length, 2);
    assert.match(failures[0], /^item_number is empty/);
    assert.match(failures[1], /GH_AW_GITHUB_TOKEN for pull request publication/);
  }
});

test('source and compiled workflow run the same validation script', async () => {
  const [source, compiled] = await readValidationScripts();

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
