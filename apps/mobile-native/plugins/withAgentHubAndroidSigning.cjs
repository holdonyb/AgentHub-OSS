const { withAppBuildGradle } = require('@expo/config-plugins');

function namedBlock(source, name, fromIndex = 0) {
  const pattern = new RegExp(`\\b${name}\\s*\\{`, 'g');
  pattern.lastIndex = fromIndex;
  const match = pattern.exec(source);
  if (!match) throw new Error(`Expected ${name} block in generated Android app build.gradle`);
  const open = source.indexOf('{', match.index);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return { start: match.index, open, close: index };
  }
  throw new Error(`Unclosed ${name} block in generated Android app build.gradle`);
}

function patchAndroidSigning(source) {
  const signingConfigs = namedBlock(source, 'signingConfigs');
  const signingBody = source.slice(signingConfigs.open + 1, signingConfigs.close);
  if (!/\bdebug\s*\{/.test(signingBody)) {
    throw new Error('Expected signingConfigs.debug in generated Android app build.gradle');
  }
  if (/\bagenthub\s*\{/.test(signingBody)) return source;

  const signingConfig = `
        agenthub {
            def agenthubKeystore = System.getenv("AGENTHUB_ANDROID_KEYSTORE_FILE")
            storeFile agenthubKeystore ? file(agenthubKeystore) : null
            storePassword System.getenv("AGENTHUB_ANDROID_KEYSTORE_PASSWORD")
            keyAlias System.getenv("AGENTHUB_ANDROID_KEY_ALIAS")
            keyPassword System.getenv("AGENTHUB_ANDROID_KEY_PASSWORD")
        }
`;
  let result = `${source.slice(0, signingConfigs.close)}${signingConfig}${source.slice(signingConfigs.close)}`;
  const release = namedBlock(result, 'release', namedBlock(result, 'buildTypes').open);
  const releaseBody = result.slice(release.open + 1, release.close);
  if (!/signingConfig\s+signingConfigs\.debug/.test(releaseBody)) {
    throw new Error('Expected release signingConfigs.debug in generated Android app build.gradle');
  }
  const patchedRelease = releaseBody.replace(
    /signingConfig\s+signingConfigs\.debug/,
    'signingConfig signingConfigs.agenthub',
  );
  result = `${result.slice(0, release.open + 1)}${patchedRelease}${result.slice(release.close)}`;
  return result;
}

function withAgentHubAndroidSigning(config) {
  return withAppBuildGradle(config, (nextConfig) => {
    if (nextConfig.modResults.language !== 'groovy') {
      throw new Error('AgentHub Android signing requires a Groovy app build.gradle');
    }
    nextConfig.modResults.contents = patchAndroidSigning(nextConfig.modResults.contents);
    return nextConfig;
  });
}

module.exports = withAgentHubAndroidSigning;
module.exports.patchAndroidSigning = patchAndroidSigning;
