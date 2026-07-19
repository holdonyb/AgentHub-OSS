const fs = require('node:fs/promises');
const path = require('node:path');
const { withDangerousMod } = require('@expo/config-plugins');

const lightColors = Object.freeze({
  agenthub_canvas: '#F4F7FA',
  agenthub_surface: '#FFFFFF',
  agenthub_surface_muted: '#EAF0F6',
  agenthub_text: '#111827',
  agenthub_muted: '#667085',
  agenthub_border: '#D4DCE6',
});

const darkColors = Object.freeze({
  agenthub_canvas: '#101722',
  agenthub_surface: '#172131',
  agenthub_surface_muted: '#243247',
  agenthub_text: '#E7EDF5',
  agenthub_muted: '#A7B3C4',
  agenthub_border: '#334258',
});

function renderColorsXml(colors) {
  const entries = Object.entries(colors)
    .map(([name, value]) => `  <color name="${name}">${value}</color>`)
    .join('\n');
  return `<resources>\n${entries}\n</resources>\n`;
}

async function writeThemeColors(projectRoot) {
  const resourceRoot = path.join(projectRoot, 'app', 'src', 'main', 'res');
  const lightRoot = path.join(resourceRoot, 'values');
  const darkRoot = path.join(resourceRoot, 'values-night');
  await Promise.all([
    fs.mkdir(lightRoot, { recursive: true }),
    fs.mkdir(darkRoot, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(lightRoot, 'agenthub_colors.xml'), renderColorsXml(lightColors), 'utf8'),
    fs.writeFile(path.join(darkRoot, 'agenthub_colors.xml'), renderColorsXml(darkColors), 'utf8'),
  ]);
}

function withAgentHubThemeColors(config) {
  return withDangerousMod(config, [
    'android',
    async (nextConfig) => {
      await writeThemeColors(nextConfig.modRequest.platformProjectRoot);
      return nextConfig;
    },
  ]);
}

module.exports = withAgentHubThemeColors;
module.exports.darkColors = darkColors;
module.exports.lightColors = lightColors;
module.exports.renderColorsXml = renderColorsXml;
module.exports.writeThemeColors = writeThemeColors;
