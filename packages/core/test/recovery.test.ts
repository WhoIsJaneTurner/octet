import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileRunning, Store } from '../src/index.ts';

function seeded() {
  const store = new Store(':memory:');
  store.insertGoal({ id: 'g', project: 'p', title: 'g', branch: 'feat/g', worktree: '/w/g' });
  const mk = (id: string) => store.insertBead({ id, goalId: 'g', title: id, brief: 'x', dependsOn: [], branch: `b/${id}`, worktree: `/w/${id}` });
  return { store, mk };
}

test('beads left running by a crash are marked failed and logged; others are untouched', () => {
  const { store, mk } = seeded();
  mk('a'); mk('b'); mk('c');
  store.setBeadStatus('a', 'running');
  store.setBeadStatus('b', 'in_review');
  const ids = reconcileRunning(store);
  assert.deepEqual(ids, ['a']);
  assert.equal(store.getBead('a')!.status, 'failed');
  assert.equal(store.getBead('b')!.status, 'in_review');
  assert.equal(store.getBead('c')!.status, 'todo');
  assert.equal(store.lastEvent('bead.recovered', 'a')?.seat, 'engineer');
});

test('reconcile is a no-op when nothing is running', () => {
  const { store, mk } = seeded();
  mk('a');
  assert.deepEqual(reconcileRunning(store), []);
  assert.equal(store.events().length, 0);
});
