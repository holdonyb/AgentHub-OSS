import { describe, expect, it } from 'vitest';
import config from './capacitor.config.json';

describe('AgentHub Android wrapper config', () => {
  it('loads only the HTTPS AgentHub console', () => {
    expect(config.appId).toBe('xin.ifix.agenthub');
    expect(config.appName).toBe('AgentHub');
    expect(config.server?.url).toBe('https://agenthub.example.com');
    expect(config.server?.cleartext).toBe(false);
  });

  it('configures the Android native notification status icon', () => {
    expect(config.plugins?.LocalNotifications).toMatchObject({
      smallIcon: 'ic_stat_agenthub',
      iconColor: '#2563eb',
    });
  });
});
