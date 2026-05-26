const test = require('node:test');
const assert = require('node:assert');
const { pctToPdfRect } = require('../../lib/inkd-pdf-coords');

test('converts top-left percent rect to pdf-lib (bottom-left origin)', () => {
  // Page is 600pt wide, 800pt tall.
  // Field at x_pct=0.1, y_pct=0.2, width=0.3, height=0.05
  // Top-left of field in browser space: (60, 160). Bottom-left in PDF space: (60, 800 - 160 - 40) = (60, 600)
  // Width=180, height=40.
  const r = pctToPdfRect({ x_pct: 0.1, y_pct: 0.2, width_pct: 0.3, height_pct: 0.05 }, 600, 800);
  assert.deepStrictEqual(r, { x: 60, y: 600, width: 180, height: 40 });
});

test('handles 0,0 top-left correctly', () => {
  const r = pctToPdfRect({ x_pct: 0, y_pct: 0, width_pct: 0.1, height_pct: 0.1 }, 600, 800);
  // y = 800 - 0 - 80 = 720
  assert.deepStrictEqual(r, { x: 0, y: 720, width: 60, height: 80 });
});

test('handles bottom-right corner', () => {
  const r = pctToPdfRect({ x_pct: 0.9, y_pct: 0.9, width_pct: 0.1, height_pct: 0.1 }, 600, 800);
  // x = 540, y = 800 - 720 - 80 = 0
  assert.deepStrictEqual(r, { x: 540, y: 0, width: 60, height: 80 });
});
