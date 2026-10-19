import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { page } from 'vitest/browser';
import type { SystemSettings } from '@/types/settings';

vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig: {}, appService: {} }) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (key: string) => key }));
import CalibreForm from '@/components/settings/integrations/CalibreForm';
import { useSettingsStore } from '@/store/settingsStore';
import { useCalibreSyncStore } from '@/store/calibreSyncStore';

await import('@/styles/globals.css');

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-eink');
  document.documentElement.removeAttribute('dir');
});

describe('Calibre settings layout', () => {
  for (const width of [390, 1024]) {
    for (const dark of [false, true]) {
      for (const eink of [false, true]) {
        for (const rtl of [false, true]) {
          it(`keeps controls inside the panel: width=${width}, dark=${dark}, eink=${eink}, rtl=${rtl}`, async () => {
            await page.viewport(width, 844);
            document.documentElement.setAttribute(
              'data-theme',
              dark ? 'default-dark' : 'default-light',
            );
            document.documentElement.setAttribute('data-eink', String(eink));
            document.documentElement.dir = rtl ? 'rtl' : 'ltr';
            useSettingsStore.setState({
              settings: {
                calibreServers: [
                  {
                    id: 'server',
                    name: 'My Calibre library',
                    url: 'https://books.example.test/calibre',
                    kind: 'calibre',
                    libraryId: 'Library',
                    enabled: true,
                    syncProgress: false,
                    username: 'reader',
                  },
                ],
              } as SystemSettings,
            });
            useCalibreSyncStore.setState({
              byServer: { server: { running: true, fetched: 50, total: 100 } },
            });
            const { container, getByRole } = render(
              <div
                className='settings-content bg-base-200 p-4'
                style={{ width: 'min(100vw, 600px)' }}
              >
                <CalibreForm onBack={() => {}} />
              </div>,
            );
            for (const control of container.querySelectorAll('input, select, button, progress')) {
              const bounds = control.getBoundingClientRect();
              expect(bounds.left).toBeGreaterThanOrEqual(0);
              expect(bounds.right).toBeLessThanOrEqual(width);
            }
            const primary = getByRole('button', { name: 'Connect' });
            expect(getComputedStyle(primary).backgroundColor).not.toBe(
              getComputedStyle(primary).color,
            );
            if (eink) {
              expect(
                getComputedStyle(container.querySelector('.eink-bordered')!).borderTopWidth,
              ).toBe('1px');
            }
            if (width === 390 && eink && rtl) {
              await page.screenshot({
                path: `../../../../.next/calibre-${dark ? 'dark' : 'light'}-eink-rtl.png`,
                save: true,
              });
            }
          });
        }
      }
    }
  }
});
