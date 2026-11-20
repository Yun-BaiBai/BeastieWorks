'use strict';
// Owned process tree: a recycled parent PID must not adopt an older, unrelated process.
const test = require('node:test'), assert = require('node:assert/strict');
const {ownedTreeFrom} = require('./load-ts.cjs')('src/main/ownedProcessTree.ts');
const row = (pid, parent, started) => ({pid, parent, started});

test('descendants are collected through every level', () => {
  const all = [row(1, 0, '2026-11-12T00:00:00.000Z'), row(2, 1, '2026-11-12T00:00:01.000Z'), row(3, 2, '2026-11-12T00:00:02.000Z'), row(9, 5, '2026-11-12T00:00:03.000Z')];
  assert.deepEqual(ownedTreeFrom(all, 1).map(r => r.pid).sort(), [1, 2, 3]);
});

test('a process older than its claimed parent is not adopted, nor are its children', () => {
  // 14392 started today; 16200 started yesterday under a dead process that once had PID 14392.
  const all = [
    row(19108, 3900, '2026-11-12T00:06:01.8016810Z'),
    row(14392, 19108, '2026-11-12T00:06:01.9043180Z'),
    row(17200, 14392, '2026-11-12T00:06:01.9440780Z'),
    row(16200, 14392, '2026-11-11T10:38:05.7496660Z'),
    row(8528, 16200, '2026-11-11T10:38:39.6199690Z'),
  ];
  assert.deepEqual(ownedTreeFrom(all, 19108).map(r => r.pid), [19108, 14392, 17200]);
});

test('a child started in the same instant as its parent counts; unparseable times stay inclusive', () => {
  const all = [row(1, 0, '2026-11-12T00:00:00.000Z'), row(2, 1, '2026-11-12T00:00:00.000Z'), row(3, 1, 'unknown')];
  assert.deepEqual(ownedTreeFrom(all, 1).map(r => r.pid), [1, 2, 3]);
});

test('a missing root is an error, not an empty tree', () => {
  assert.throws(() => ownedTreeFrom([row(2, 1, 'x')], 1), /PROCESS_IDENTITY_UNAVAILABLE/);
});
