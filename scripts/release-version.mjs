export function findVersionMismatches(expectedVersion, entries) {
  return entries
    .filter(({ version }) => version !== expectedVersion)
    .map(({ name, version }) => `${name}: expected ${expectedVersion}, found ${version || '<missing>'}`);
}

export function versionFromReleaseTag(tag) {
  const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(String(tag || '').trim());
  if (!match) throw new Error('Release tag must match v<major>.<minor>.<patch>');
  return match[1];
}
