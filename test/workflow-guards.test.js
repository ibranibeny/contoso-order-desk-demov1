import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const repository = 'ibranibeny/contoso-order-desk-demov1';
const workflowsUrl = new URL('../.github/workflows/', import.meta.url);

test('workflow repository guards target this repository so runs are not skipped', async () => {
  const files = (await readdir(workflowsUrl)).filter((name) => /\.(md|ya?ml)$/.test(name));
  let guards = 0;

  for (const name of files) {
    const source = await readFile(new URL(name, workflowsUrl), 'utf8');

    for (const [, target] of source.matchAll(/github\.repository == '([^']+)'/g)) {
      guards += 1;
      assert.equal(target, repository, `${name} guards on ${target}, so every run here is skipped`);
    }
  }

  assert.ok(guards > 0, 'Expected at least one repository guard');
});
