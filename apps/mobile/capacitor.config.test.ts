import { describe, expect, it } from 'vitest';
import config from './capacitor.config.json';

describe('AgentHub Android wrapper config', () => {
  it('ships a local shell and relies on runtime server setup', () => {
    expect(config.appId).toBe('xin.ifix.agenthub');
    expect(config.appName).toBe('AgentHub');
    expect(config.server).toBeUndefined();
  });

  it('configures the Android native notification status icon', () => {
    expect(config.plugins?.LocalNotifications).toMatchObject({
      smallIcon: 'ic_stat_agenthub',
      iconColor: '#2563eb',
    });
  });
});
