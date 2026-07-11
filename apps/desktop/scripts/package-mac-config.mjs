export function macBuilderArgs({ signed = false } = {}) {
  const args = ['--mac', 'dmg', 'zip', '--x64', '--arm64', '--publish', 'never'];
  if (!signed) args.push('--config.mac.identity=null');
  return args;
}

export function macArtifactName(version, arch, extension) {
  return `AgentHub-${version}-macos-${arch}.${extension}`;
}
