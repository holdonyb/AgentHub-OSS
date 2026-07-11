function hasAll(env, keys) {
  return keys.every((key) => Boolean(String(env[key] || '').trim()));
}

export function hasNotarizationCredentials(env = process.env) {
  return (
    hasAll(env, ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) ||
    hasAll(env, ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) ||
    hasAll(env, ['APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE'])
  );
}

export function macBuilderArgs({ signed = false, notarized = false } = {}) {
  if (notarized && !signed) {
    throw new Error('macOS notarization requires a signed build');
  }
  const args = ['--mac', 'dmg', 'zip', '--x64', '--arm64', '--publish', 'never'];
  if (!signed) {
    args.push('--config.mac.identity=null', '--config.mac.hardenedRuntime=false');
  }
  args.push(`--config.mac.notarize=${notarized ? 'true' : 'false'}`);
  return args;
}

export function macArtifactName(version, arch, extension) {
  return `AgentHub-${version}-macos-${arch}.${extension}`;
}
