import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SystemSettings } from '@/types/settings';

const mocks = vi.hoisted(() => ({ saveSettings: vi.fn(), ask: vi.fn(), sync: vi.fn() }));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({
    envConfig: { getAppService: async () => ({ saveSettings: mocks.saveSettings }) },
    appService: { ask: mocks.ask },
  }),
}));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (key: string) => key }));
vi.mock('@/services/calibre/librarySync', () => ({
  syncCalibreServer: mocks.sync,
  calibreErrorMessage: (error: Error) => error.message,
}));
import CalibreForm from '@/components/settings/integrations/CalibreForm';
import { CalibreClient } from '@/services/calibre/client';
import { useSettingsStore } from '@/store/settingsStore';
import { useCalibreSyncStore } from '@/store/calibreSyncStore';

beforeEach(() => {
  useSettingsStore.setState({ settings: { calibreServers: [] } as unknown as SystemSettings });
  useCalibreSyncStore.setState({ byServer: {} });
  mocks.saveSettings.mockResolvedValue(undefined);
  mocks.ask.mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('Calibre connection settings', () => {
  it('retains the selected library when editing an existing connection', async () => {
    useSettingsStore.setState({
      settings: {
        calibreServers: [
          {
            id: 'existing',
            name: 'Existing',
            url: 'https://books.test',
            kind: 'calibre',
            libraryId: 'second',
            enabled: false,
            syncProgress: false,
          },
        ],
      } as SystemSettings,
    });
    vi.spyOn(CalibreClient.prototype, 'getLibraries').mockResolvedValue([
      { id: 'first', name: 'First' },
      { id: 'second', name: 'Second' },
    ]);
    render(<CalibreForm onBack={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByRole('button', { name: 'Save' });
    expect((screen.getByLabelText('Library') as HTMLSelectElement).value).toBe('second');
  });
  it('tests credentials, lets the user select a library, saves and requests a full sync', async () => {
    const libraries = vi.spyOn(CalibreClient.prototype, 'getLibraries').mockResolvedValue([
      { id: 'first', name: 'First Library' },
      { id: 'second', name: 'Second Library' },
    ]);
    render(<CalibreForm onBack={() => {}} />);
    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: 'https://books.test/mount/' },
    });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'reader' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByRole('button', { name: 'Save' });
    fireEvent.change(screen.getByLabelText('Library'), { target: { value: 'second' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1));
    expect(libraries).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().settings.calibreServers?.[0]).toMatchObject({
      url: 'https://books.test/mount',
      username: 'reader',
      password: 'secret',
      libraryId: 'second',
      syncProgress: false,
    });
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(useSettingsStore.getState().settings.calibreServers).toEqual([]));
  });
  it('does not save a failed connection or credentials embedded in a URL', async () => {
    const libraries = vi
      .spyOn(CalibreClient.prototype, 'getLibraries')
      .mockRejectedValue(new Error('Authentication failed'));
    render(<CalibreForm onBack={() => {}} />);
    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: 'https://books.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByRole('alert');
    expect(useSettingsStore.getState().settings.calibreServers).toEqual([]);
    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: 'https://user:pass@books.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('without credentials'),
    );
    expect(libraries).toHaveBeenCalledTimes(1);
  });
  it('requires a Kobo token before offering Calibre-Web position sync', () => {
    useSettingsStore.setState({
      settings: {
        calibreServers: [
          {
            id: 'web',
            name: 'Calibre-Web',
            url: 'https://books.test',
            kind: 'calibre-web',
            libraryId: 'calibre-web',
            enabled: true,
            syncProgress: false,
          },
        ],
      } as SystemSettings,
    });
    render(<CalibreForm onBack={() => {}} />);
    expect(
      screen.getByText('Sync Reading Position').closest('label')?.querySelector('input')?.disabled,
    ).toBe(true);
    expect(screen.getByText('Send Local Books to Calibre')).toBeTruthy();
    expect(screen.getByText('Automatic Library Sync')).toBeTruthy();
    fireEvent.click(screen.getByText('Automatic Library Sync'));
    expect(useSettingsStore.getState().settings.calibreServers?.[0]?.enabled).toBe(false);
  });
  it('saves and retains a Calibre-Web Kobo token and enables position sync without an OPDS username', async () => {
    const token = '0123456789abcdef0123456789abcdef';
    vi.spyOn(CalibreClient.prototype, 'getLibraries').mockResolvedValue([
      { id: 'calibre-web', name: 'Calibre-Web' },
    ]);
    render(<CalibreForm onBack={() => {}} />);
    fireEvent.change(screen.getByLabelText('Server Type'), { target: { value: 'calibre-web' } });
    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: 'https://books.test' },
    });
    const input = screen.getByLabelText('Kobo Sync Token') as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.change(input, { target: { value: token } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByRole('button', { name: 'Save' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1));
    expect(useSettingsStore.getState().settings.calibreServers?.[0]?.koboToken).toBe(token);
    expect(input.value).toBe('');
    const label = screen.getByText('Sync Reading Position');
    expect(label.closest('label')?.querySelector('input')?.disabled).toBe(false);
    fireEvent.click(label);
    expect(useSettingsStore.getState().settings.calibreServers?.[0]?.syncProgress).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect((screen.getByLabelText('Kobo Sync Token') as HTMLInputElement).value).toBe(token);
  });
  it('sends local books by default and lets the user turn it off', () => {
    useSettingsStore.setState({
      settings: {
        calibreServers: [
          {
            id: 'server',
            name: 'Calibre',
            url: 'https://books.test',
            kind: 'calibre',
            libraryId: 'library',
            username: 'reader',
            enabled: true,
            syncProgress: false,
          },
        ],
      } as SystemSettings,
    });
    render(<CalibreForm onBack={() => {}} />);
    const label = screen.getByText('Send Local Books to Calibre');
    expect(label.closest('label')?.querySelector('input')?.checked).toBe(true);
    fireEvent.click(label);
    expect(useSettingsStore.getState().settings.calibreServers?.[0]?.uploadBooks).toBe(false);
  });
});
