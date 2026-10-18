import { useEffect, type ComponentType, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const sync = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock('@/hooks/useCatalogAutoUpload', () => ({
  useCatalogAutoUpload: () =>
    useEffect(() => {
      sync.start();
      return () => sync.stop();
    }, []),
}));
const noop = () => {};
const pass = ({ children }: { children: ReactNode }) => children;
const settings = {
  globalViewSettings: { uiLanguage: 'en', isEink: false },
  telemetryEnabled: false,
};
const appService = { exists: async () => true, loadSettings: async () => settings };
const envConfig = {};
const lock = { isInitialized: true, isUnlocked: true, initialize: noop };

vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig, appService }) }));
vi.mock('@/i18n/i18n', () => ({ default: { on: noop, off: noop } }));
vi.mock('@/store/settingsStore', () => ({ useSettingsStore: () => ({ applyUILanguage: noop }) }));
vi.mock('@/store/customTextureStore', () => ({
  useCustomTextureStore: { getState: () => ({ setTextures: noop }) },
}));
vi.mock('@/store/themeStore', () => ({ loadDataTheme: noop, initSystemThemeListener: noop }));
vi.mock('@/store/appLockStore', () => ({ useAppLockStore: () => lock }));
vi.mock('@/hooks/useBackgroundTexture', () => ({
  useBackgroundTexture: () => ({ applyBackgroundTexture: noop }),
}));
vi.mock('@/hooks/useEinkMode', () => ({ useEinkMode: () => ({ applyEinkMode: noop }) }));
vi.mock('@/hooks/useResponsiveSize', () => ({ useDefaultIconSize: () => 20 }));
vi.mock('@/hooks/useSafeAreaInsets', () => ({ useSafeAreaInsets: noop }));
vi.mock('@/hooks/useSettingsSync', () => ({ useSettingsSync: noop }));
vi.mock('@/utils/misc', () => ({ getLocale: () => 'en' }));
vi.mock('@/utils/rtl', () => ({ getDirFromUILanguage: () => 'ltr' }));
vi.mock('@/utils/viewport', () => ({ getAndroidPatchedViewportContent: () => null }));
vi.mock('@/utils/telemetry', () => ({
  getTelemetryDecision: () => 'opted-out',
  reconcileTelemetryConsent: () => false,
  optInTelemetry: noop,
  optOutTelemetry: noop,
  rollIntoTelemetryPromptBucket: () => false,
  setTelemetryDecision: noop,
}));
vi.mock('@/helpers/settings', () => ({ getLibraryViewSettings: () => ({}) }));
vi.mock('@/services/constants', () => ({ SETTINGS_FILENAME: 'settings.json' }));
vi.mock('@/services/sync/replicaSettingsSync', () => ({ initSettingsSync: noop }));
vi.mock('@/libs/crypto/passphrase', () => ({ upgradeToKeychainIfAvailable: async () => {} }));
vi.mock('@/libs/crypto/session', () => ({
  cryptoSession: { tryRestoreFromStore: async () => {} },
}));
vi.mock('@tauri-apps/api/event', () => ({ emit: async () => {} }));
vi.mock('@/context/AuthContext', () => ({ AuthProvider: pass }));
vi.mock('@/context/PHContext', () => ({ CSPostHogProvider: pass, initPostHog: noop }));
vi.mock('@/context/SyncContext', () => ({ SyncProvider: pass }));
vi.mock('@/context/DropdownContext', () => ({ DropdownProvider: pass }));
vi.mock('@/components/command-palette', () => ({
  CommandPaletteProvider: pass,
  CommandPalette: () => null,
}));

let Providers: ComponentType<{ children: ReactNode }>;
beforeAll(async () => {
  for (const path of [
    '@/utils/polyfill',
    '@/components/WindowResizeHandles',
    '@/components/WindowOutline',
    '@/components/AtmosphereOverlay',
    '@/components/AppLockScreen',
    '@/components/CarMediaLibraryBridge',
    '@/components/FileSyncReport',
    '@/components/settings/AppLockDialog',
    '@/components/PassphrasePrompt',
    '@/components/TelemetryConsentDialog',
  ])
    vi.doMock(path, () => ({ default: () => null }));
  Providers = (await import('@/components/Providers')).default;
});
afterEach(cleanup);

describe('automatic catalog sync lifecycle', () => {
  it('stays active when the shared app switches from library to reader and settings', async () => {
    const view = render(
      <Providers>
        <div>Library route</div>
      </Providers>,
    );
    await waitFor(() => expect(sync.start).toHaveBeenCalledTimes(1));
    view.rerender(
      <Providers>
        <div>Reader route</div>
      </Providers>,
    );
    expect(screen.getByText('Reader route')).toBeTruthy();
    view.rerender(
      <Providers>
        <div>Settings route</div>
      </Providers>,
    );
    expect(screen.getByText('Settings route')).toBeTruthy();
    expect(sync.start).toHaveBeenCalledTimes(1);
    expect(sync.stop).not.toHaveBeenCalled();
    view.unmount();
    expect(sync.stop).toHaveBeenCalledTimes(1);
  });
});
