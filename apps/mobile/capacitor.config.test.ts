import { describe, expect, it } from 'vitest';
import config, {
  DEFAULT_AGENTHUB_MOBILE_SERVER_URL,
  resolveAgentHubMobileServerUrl,
} from './capacitor.config';

describe('AgentHub Android wrapper config', () => {
  it('uses an unconfigured placeholder URL by default so first launch can ask for a server', () => {
    expect(config.appId).toBe('xin.ifix.agenthub');
    expect(config.appName).toBe('AgentHub');
    expect(DEFAULT_AGENTHUB_MOBILE_SERVER_URL).toBe('https://agenthub.invalid');
    expect(config.server?.url).toBe(DEFAULT_AGENTHUB_MOBILE_SERVER_URL);
    expect(config.server?.cleartext).toBe(false);
  });

  it('allows public and mobile-specific URL overrides for self-hosted builds', () => {
    expect(
      resolveAgentHubMobileServerUrl({
        AGENTHUB_PUBLIC_BASE_URL: 'https://agenthub.example.com/',
      }),
    ).toBe('https://agenthub.example.com');
    expect(
      resolveAgentHubMobileServerUrl({
        AGENTHUB_PUBLIC_BASE_URL: 'https://agenthub.example.com',
        AGENTHUB_MOBILE_SERVER_URL: 'https://m.agenthub.example.com/control/',
      }),
    ).toBe('https://m.agenthub.example.com/control');
  });

  it('configures the Android native notification status icon', () => {
    expect(config.plugins?.LocalNotifications).toMatchObject({
      smallIcon: 'ic_stat_agenthub',
      iconColor: '#2563eb',
    });
  });
});
