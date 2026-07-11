import appConfig from '../../app.json';

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

  it('keeps system chrome readable while the foundation uses a light-only theme', () => {
    expect(appConfig.expo.userInterfaceStyle).toBe('light');
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
