import { themePreferencePresentation } from './themePreference';

describe('native theme preference', () => {
  it('uses light system chrome for the light preference', () => {
    expect(themePreferencePresentation('light')).toEqual({ colorScheme: 'light', statusBar: 'dark' });
  });

  it('uses light status content over the dark preference', () => {
    expect(themePreferencePresentation('dark')).toEqual({ colorScheme: 'dark', statusBar: 'light' });
  });
});
