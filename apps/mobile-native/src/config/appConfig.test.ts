import appConfig from '../../app.json';
import { buildAppConfig } from '../../app.config';

const { readFileSync } = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

const javaKeywords = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class',
  'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final',
  'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int',
  'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public',
  'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this',
  'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while',
]);

describe('Expo native identifiers', () => {
  it('uses a Java-safe Android package that matches the iOS bundle identifier', () => {
    const androidPackage = appConfig.expo.android.package;
    expect(androidPackage).toBe(appConfig.expo.ios.bundleIdentifier);
    expect(androidPackage.split('.').some((part) => javaKeywords.has(part))).toBe(false);
  });

  it('allows the saved appearance preference to switch native system chrome', () => {
    expect(appConfig.expo.userInterfaceStyle).toBe('automatic');
  });

  it('keeps release metadata inside the Expo configuration object', () => {
    expect(appConfig).not.toHaveProperty('version');
    expect(appConfig.expo.version).toBe('1.0.7');
  });

  it('limits the iOS insecure transport exception to Tailscale DNS', () => {
    const ats = appConfig.expo.ios.infoPlist.NSAppTransportSecurity;
    expect(ats.NSAllowsLocalNetworking).toBe(true);
    expect(ats.NSExceptionDomains).toEqual({
      'ts.net': {
        NSIncludesSubdomains: true,
        NSExceptionAllowsInsecureHTTPLoads: true,
      },
    });
  });
});

describe('Expo push configuration', () => {
  it('injects the self-host operator EAS project id without hardcoding one', () => {
    const configured = buildAppConfig({ EXPO_PUBLIC_EAS_PROJECT_ID: 'self-host-project' });

    expect(configured.extra).toEqual({ eas: { projectId: 'self-host-project' } });
    expect(appConfig.expo).not.toHaveProperty('extra.eas.projectId');
  });

  it('leaves push transport disabled when no EAS project id is configured', () => {
    expect(buildAppConfig({}).extra).toBeUndefined();
  });

  it('injects the Android Firebase registration file only when configured', () => {
    const configured = buildAppConfig({
      EXPO_PUBLIC_EAS_PROJECT_ID: 'self-host-project',
      GOOGLE_SERVICES_JSON: '/runner/google-services.json',
    });

    expect(configured.android?.googleServicesFile).toBe('/runner/google-services.json');
    expect(buildAppConfig({}).android?.googleServicesFile).toBeUndefined();
  });

  it('passes the repository EAS project id into Android and release builds', () => {
    const workflowRoot = `${process.cwd().replace(/\\/g, '/')}/../../.github/workflows`;
    for (const workflow of ['android-apk.yml', 'release.yml']) {
      const source = readFileSync(`${workflowRoot}/${workflow}`, 'utf8');
      expect(source).toContain('EXPO_PUBLIC_EAS_PROJECT_ID: ${{ vars.EXPO_PUBLIC_EAS_PROJECT_ID }}');
      expect(source).toContain('AGENTHUB_ANDROID_GOOGLE_SERVICES_JSON_BASE64');
      expect(source).toContain('GOOGLE_SERVICES_JSON=$RUNNER_TEMP/google-services.json');
    }
  });
});
