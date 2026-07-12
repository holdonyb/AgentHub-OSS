const { patchAndroidSigning } = require('../../plugins/withAgentHubAndroidSigning.cjs') as {
  patchAndroidSigning(source: string): string;
};

describe('native Android release signing plugin', () => {
  it('adds environment-backed release signing without changing debug signing', () => {
    const source = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
        }
    }
}`;

    const result = patchAndroidSigning(source);

    expect(result).toContain('agenthub {');
    expect(result).toContain('System.getenv("AGENTHUB_ANDROID_KEYSTORE_FILE")');
    expect(result).toContain('System.getenv("AGENTHUB_ANDROID_KEYSTORE_PASSWORD")');
    expect(result).toContain('System.getenv("AGENTHUB_ANDROID_KEY_ALIAS")');
    expect(result).toContain('System.getenv("AGENTHUB_ANDROID_KEY_PASSWORD")');
    expect(result).toContain('debug {\n            signingConfig signingConfigs.debug');
    expect(result).toContain('release {\n            signingConfig signingConfigs.agenthub');
  });

  it('fails loudly when the expected Expo Gradle template changes', () => {
    expect(() => patchAndroidSigning('android { buildTypes {} }')).toThrow(
      /generated Android app build\.gradle/i,
    );
  });
});
