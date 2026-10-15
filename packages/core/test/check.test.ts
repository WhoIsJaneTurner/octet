import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkText } from '../../../scripts/check.ts';

test('check flags tabs, trailing whitespace and a missing final newline', () => {
  const msgs = (f: string, t: string) => checkText(f, t).map((x) => `${x.line}:${x.message}`);
  assert.deepEqual(msgs('a.ts', 'ok\n'), []);
  assert.deepEqual(msgs('a.ts', 'a\n\tb\n'), ['2:tab character']);
  assert.deepEqual(msgs('a.ts', 'a  \n'), ['1:trailing whitespace']);
  assert.deepEqual(msgs('a.ts', 'a'), ['1:missing final newline']);
});

test('console.log is rejected only in packages/core/src', () => {
  const t = 'console.log(1);\n';
  assert.equal(checkText('packages/core/src/x.ts', t).length, 1);
  assert.equal(checkText('packages/cli/src/x.ts', t).length, 0);
  assert.equal(checkText('packages/core/test/x.ts', t).length, 0);
  assert.equal(checkText('packages/core/src/x.ts', 'console.warn(1);\n').length, 0);
});
