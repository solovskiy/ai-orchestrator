'use strict';
const assert = require('node:assert');
const { diffStatusLines } = require('../lib/agent.js');

assert.deepStrictEqual(
  diffStatusLines(['?? old-report.md'], ['?? old-report.md', '?? new-report.md']),
  ['?? new-report.md'],
  'pre-existing untracked file should NOT count as new',
);

assert.deepStrictEqual(
  diffStatusLines([], ['?? a.md', ' M b.ts']),
  ['?? a.md', ' M b.ts'],
  'empty pre (worktree, old behavior) — all lines are new',
);

assert.deepStrictEqual(
  diffStatusLines(['?? x.md'], ['?? x.md']),
  [],
  'nothing changed — empty result',
);

assert.deepStrictEqual(
  diffStatusLines([' M foo.ts', '?? old.md'], [' M foo.ts', '?? old.md', ' M bar.ts']),
  [' M bar.ts'],
  'only genuinely changed line appears',
);

assert.deepStrictEqual(
  diffStatusLines([], []),
  [],
  'both empty — empty result',
);

console.log('diff-status-lines: OK');
