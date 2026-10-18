import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { page } from 'vitest/browser';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {}, appService: { isDesktopApp: true } }),
}));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (key: string) => key }));
vi.mock('@/hooks/useQuotaStats', () => ({
  useQuotaStats: () => ({ userProfilePlan: 'free', customizationPurchased: false }),
}));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({
    settings: {},
    requestedSubPage: null,
    setRequestedSubPage: vi.fn(),
  }),
}));
vi.mock('@/app/opds/components/CatalogManager', () => ({
  CatalogManager: () => <div>OPDS catalog settings</div>,
}));

import IntegrationsPanel from '@/components/settings/IntegrationsPanel';

await import('@/styles/globals.css');

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-eink');
  document.documentElement.removeAttribute('dir');
});

describe('content source settings', () => {
  for (const width of [390, 1024]) {
    for (const dark of [false, true]) {
      for (const eink of [false, true]) {
        for (const rtl of [false, true]) {
          it(`uses OPDS without a separate Calibre row: width=${width}, dark=${dark}, eink=${eink}, rtl=${rtl}`, async () => {
            await page.viewport(width, 844);
            document.documentElement.setAttribute(
              'data-theme',
              dark ? 'default-dark' : 'default-light',
            );
            document.documentElement.setAttribute('data-eink', String(eink));
            document.documentElement.dir = rtl ? 'rtl' : 'ltr';
            const { container, getByText } = render(
              <div
                className='settings-content bg-base-200 p-4'
                style={{ width: 'min(100vw, 600px)' }}
              >
                <IntegrationsPanel />
              </div>,
            );
            const sources = container.querySelector(
              '[data-setting-id="settings.integrations.catalogs"]',
            ) as HTMLElement;
            expect(within(sources).queryByText('Calibre')).toBeNull();
            const opds = within(sources).getByRole('button', { name: /OPDS Catalogs/ });
            for (const control of sources.querySelectorAll('button')) {
              const bounds = control.getBoundingClientRect();
              expect(bounds.left).toBeGreaterThanOrEqual(0);
              expect(bounds.right).toBeLessThanOrEqual(width);
            }
            fireEvent.click(opds);
            expect(getByText('OPDS catalog settings')).toBeTruthy();
          });
        }
      }
    }
  }
});
