import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTerminalSelection } from '../src/lib/terminalSelection.js';

test('removes painted line padding and two leading spaces from every line', () => {
  assert.equal(
    normalizeTerminalSelection('  first line    \n  second line  \n  third line'),
    'first line\nsecond line\nthird line',
  );
});

test('preserves indentation beyond the first two spaces', () => {
  assert.equal(
    normalizeTerminalSelection('  if (ready) {  \n    run();    \n  }'),
    'if (ready) {\n  run();\n}',
  );
});

test('preserves line ending style and blank lines', () => {
  assert.equal(
    normalizeTerminalSelection('  alpha   \r\n  beta  \r\n  \r\n  gamma   '),
    'alpha\r\nbeta\r\n\r\ngamma',
  );
});

test('does not remove a single leading space', () => {
  assert.equal(normalizeTerminalSelection(' alpha  \n beta  '), ' alpha\n beta');
});

test('preserves internal spaces and a final line ending', () => {
  assert.equal(
    normalizeTerminalSelection('  alpha  beta   \n  gamma  \n'),
    'alpha  beta\ngamma\n',
  );
});
