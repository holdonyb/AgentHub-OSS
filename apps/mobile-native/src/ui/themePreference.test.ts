import { Appearance } from 'react-native';
import { loadAndApplyThemePreference, themePreferencePresentation } from './themePreference';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('native theme preference', () => {
  it('uses light system chrome for the light preference', () => {
    expect(themePreferencePresentation('light')).toEqual({ colorScheme: 'light', statusBar: 'dark' });
  });

  it('uses light status content over the dark preference', () => {
    expect(themePreferencePresentation('dark')).toEqual({ colorScheme: 'dark', statusBar: 'light' });
  });

  it('loads and applies the account theme before the main console mounts', async () => {
    const setColorScheme = jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => undefined);

    await expect(loadAndApplyThemePreference(async () => 'dark')).resolves.toBe(true);

    expect(setColorScheme).toHaveBeenCalledWith('dark');
  });

  it('falls back without blocking startup when settings cannot be loaded', async () => {
    const setColorScheme = jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => undefined);

    await expect(loadAndApplyThemePreference(async () => {
      throw new Error('offline');
    })).resolves.toBe(false);

    expect(setColorScheme).not.toHaveBeenCalled();
  });
});
