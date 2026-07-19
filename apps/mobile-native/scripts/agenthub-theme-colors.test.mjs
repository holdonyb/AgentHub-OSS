import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { darkColors, lightColors, renderColorsXml } = require('../plugins/withAgentHubThemeColors.cjs');

test('renders readable light and dark semantic color resources', () => {
  assert.equal(lightColors.agenthub_canvas, '#F4F7FA');
  assert.equal(lightColors.agenthub_text, '#111827');
  assert.equal(darkColors.agenthub_canvas, '#101722');
  assert.equal(darkColors.agenthub_text, '#E7EDF5');
  assert.match(renderColorsXml(lightColors), /<color name="agenthub_text">#111827<\/color>/);
  assert.match(renderColorsXml(darkColors), /<color name="agenthub_surface">#172131<\/color>/);
});
