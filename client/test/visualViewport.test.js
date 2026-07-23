import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mobileKeyboardHeight,
  readVisualViewport,
  viewportRectsEqual,
} from '../src/lib/visualViewport.js';

test('reads a visual viewport including its non-zero origin', () => {
  assert.deepEqual(readVisualViewport({
    innerWidth: 1024,
    innerHeight: 768,
    visualViewport: {
      offsetLeft: 12.5,
      offsetTop: 84,
      width: 390,
      height: 430.5,
    },
  }), {
    offsetLeft: 12.5,
    offsetTop: 84,
    width: 390,
    height: 430.5,
  });
});

test('falls back to the layout viewport when Visual Viewport is unavailable', () => {
  assert.deepEqual(readVisualViewport({ innerWidth: 390, innerHeight: 844 }), {
    offsetLeft: 0,
    offsetTop: 0,
    width: 390,
    height: 844,
  });
});

test('invalid visual viewport fields use safe layout viewport values', () => {
  assert.deepEqual(readVisualViewport({
    innerWidth: 412,
    innerHeight: 915,
    visualViewport: { offsetLeft: -2, offsetTop: NaN, width: undefined, height: Infinity },
  }), {
    offsetLeft: 0,
    offsetTop: 0,
    width: 412,
    height: 915,
  });
});

test('keyboard height is bounded while preserving terminal space', () => {
  assert.equal(mobileKeyboardHeight(844), 300);
  assert.equal(mobileKeyboardHeight(390), 164);
  assert.equal(mobileKeyboardHeight(240), 144);
  assert.equal(mobileKeyboardHeight(0), 0);
});

test('viewport equality includes position and dimensions', () => {
  const rect = { offsetLeft: 0, offsetTop: 40, width: 390, height: 600 };
  assert.equal(viewportRectsEqual(rect, { ...rect }), true);
  assert.equal(viewportRectsEqual(rect, { ...rect, offsetTop: 41 }), false);
  assert.equal(viewportRectsEqual(rect, { ...rect, height: 599 }), false);
});
