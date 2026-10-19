import { useState } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useCalibreSyncStore } from '@/store/calibreSyncStore';
import { CalibreClient, normalizeCalibreUrl } from '@/services/calibre/client';
import { calibreErrorMessage, syncCalibreServer } from '@/services/calibre/librarySync';
import { isWebAppPlatform } from '@/services/environment';
import type { CalibreServer } from '@/types/calibre';
import { md5 } from '@/utils/md5';
import SubPageHeader from '../SubPageHeader';
import { BoxedList, SectionTitle, SettingsSwitchRow, Tips } from '../primitives';

export default function CalibreForm({ onBack }: { onBack: () => void }) {
  const _ = useTranslation();
  const { envConfig, appService } = useEnv();
  const servers = useSettingsStore((s) => s.settings.calibreServers);
  const statuses = useCalibreSyncStore((s) => s.byServer);
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState<CalibreServer['kind']>('calibre');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [libraries, setLibraries] = useState<{ id: string; name: string }[]>([]);
  const [libraryId, setLibraryId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const persist = async (next: CalibreServer[]) => {
    const store = useSettingsStore.getState();
    const settings = { ...store.settings, calibreServers: next };
    store.setSettings(settings);
    await store.saveSettings(envConfig, settings);
  };

  const patch = async (id: string, updates: Partial<CalibreServer>) => {
    try {
      await persist(
        (useSettingsStore.getState().settings.calibreServers ?? []).map((s) =>
          s.id === id ? { ...s, ...updates } : s,
        ),
      );
    } catch (cause) {
      setError(_(calibreErrorMessage(cause)));
    }
  };

  const connect = async () => {
    setBusy(true);
    setError('');
    try {
      const base = normalizeCalibreUrl(url);
      const draft: CalibreServer = {
        id: md5(`calibre:${kind}:${base}:${username}`),
        name: new URL(base).host,
        url: base,
        kind,
        username,
        password,
        libraryId,
        enabled: true,
        syncProgress: false,
      };
      if (!libraries.length) {
        const found = await new CalibreClient(draft).getLibraries();
        if (!found.length)
          throw new Error(_('No Calibre libraries are available for this account.'));
        setLibraries(found);
        setLibraryId(found.some((library) => library.id === libraryId) ? libraryId : found[0]!.id);
      } else {
        const current = useSettingsStore.getState().settings.calibreServers ?? [];
        const previous = current.find((s) => s.id === draft.id);
        const server = {
          ...draft,
          enabled: previous?.enabled ?? true,
          syncProgress: previous?.syncProgress ?? false,
          uploadBooks: previous?.uploadBooks,
        };
        await persist([...current.filter((s) => s.id !== server.id), server]);
        if (appService) void syncCalibreServer(appService, server, true);
        setPassword('');
        setLibraries([]);
        setUrl('');
        setUsername('');
      }
    } catch (cause) {
      setError(_(calibreErrorMessage(cause)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className='w-full space-y-5'>
      <SubPageHeader
        parentLabel={_('Integrations')}
        currentLabel={_('Calibre')}
        description={_('Browse and download books from Calibre or Calibre-Web in your library')}
        onBack={onBack}
      />
      {(servers ?? []).map((server) => {
        const status = statuses[server.id];
        return (
          <div key={server.id} className='space-y-3'>
            <BoxedList title={server.name} description={server.url}>
              <SettingsSwitchRow
                label={_('Automatic Library Sync')}
                checked={server.enabled}
                onChange={() => void patch(server.id, { enabled: !server.enabled })}
              />
              {server.kind === 'calibre' && (
                <SettingsSwitchRow
                  label={_('Sync Reading Position')}
                  checked={server.syncProgress}
                  disabled={!server.username}
                  onChange={() => void patch(server.id, { syncProgress: !server.syncProgress })}
                />
              )}
              <SettingsSwitchRow
                label={_('Send Local Books to Calibre')}
                checked={server.uploadBooks !== false}
                disabled={!server.username || (server.kind === 'calibre-web' && isWebAppPlatform())}
                onChange={() =>
                  void patch(server.id, { uploadBooks: server.uploadBooks === false })
                }
              />
            </BoxedList>
            <div role='status' aria-live='polite' className='px-1 text-[0.85em]'>
              {status?.running ? (
                <>
                  <p>
                    {status.sending
                      ? _('Sending books to Calibre: {{sent}}/{{total}}', {
                          sent: status.fetched,
                          total: status.total,
                        })
                      : _('Syncing Calibre: {{count}} books', { count: status.fetched })}
                  </p>
                  <progress
                    className='progress w-full'
                    aria-label={_('Library Sync Progress')}
                    value={status.total ? status.fetched : undefined}
                    max={status.total || undefined}
                  />
                </>
              ) : status?.error ? (
                <p className='text-error'>{_(status.error)}</p>
              ) : status?.finishedAt ? (
                <p>
                  {_('Last sync: {{time}}', { time: new Date(status.finishedAt).toLocaleString() })}
                  <br />
                  {_('Added: {{added}}, updated: {{updated}}, removed: {{removed}}', {
                    added: status.added ?? 0,
                    updated: status.updated ?? 0,
                    removed: status.removed ?? 0,
                  })}
                  {!!status.sent && (
                    <>
                      <br />
                      {_('Sent to Calibre: {{sent}}', { sent: status.sent })}
                    </>
                  )}
                </p>
              ) : null}
            </div>
            <div className='flex flex-wrap justify-end gap-2'>
              <button
                type='button'
                className='btn btn-ghost'
                disabled={status?.running}
                onClick={() => {
                  setUrl(server.url);
                  setKind(server.kind);
                  setUsername(server.username ?? '');
                  setPassword(server.password ?? '');
                  setLibraries([]);
                  setLibraryId(server.libraryId);
                }}
              >
                {_('Edit')}
              </button>
              <button
                type='button'
                className='btn btn-ghost'
                onClick={async () => {
                  if (
                    !appService ||
                    !(await appService.ask(
                      _('Disconnect Calibre? Downloaded books and reading data will be kept.'),
                    ))
                  )
                    return;
                  await persist(
                    (useSettingsStore.getState().settings.calibreServers ?? []).filter(
                      (s) => s.id !== server.id,
                    ),
                  );
                }}
              >
                {_('Disconnect')}
              </button>
              <button
                type='button'
                className='btn btn-contrast'
                disabled={status?.running || !appService}
                onClick={() => {
                  if (appService) void syncCalibreServer(appService, server, true);
                }}
              >
                {_('Sync Now')}
              </button>
            </div>
          </div>
        );
      })}
      <form
        className='space-y-4'
        onSubmit={(event) => {
          event.preventDefault();
          void connect();
        }}
      >
        <SectionTitle>{_('Connect to Calibre')}</SectionTitle>
        <div className='space-y-1.5'>
          <SectionTitle as='label' htmlFor='calibre-kind'>
            {_('Server Type')}
          </SectionTitle>
          <select
            id='calibre-kind'
            className='select eink-bordered settings-content w-full'
            value={kind}
            disabled={busy}
            onChange={(event) => {
              setKind(event.target.value as CalibreServer['kind']);
              setLibraries([]);
            }}
          >
            <option value='calibre'>{_('Calibre Content Server')}</option>
            <option value='calibre-web'>{_('Calibre-Web')}</option>
          </select>
        </div>
        <div className='space-y-1.5'>
          <SectionTitle as='label' htmlFor='calibre-url'>
            {_('Server URL')}
          </SectionTitle>
          <input
            id='calibre-url'
            type='url'
            required
            disabled={busy}
            value={url}
            placeholder='http://calibre.local:8080'
            spellCheck={false}
            className='input eink-bordered settings-content w-full'
            onChange={(e) => {
              setUrl(e.target.value);
              setLibraries([]);
            }}
          />
        </div>
        <div className='space-y-1.5'>
          <SectionTitle as='label' htmlFor='calibre-user'>
            {_('Username')}
          </SectionTitle>
          <input
            id='calibre-user'
            autoComplete='username'
            disabled={busy}
            value={username}
            spellCheck={false}
            className='input eink-bordered settings-content w-full'
            onChange={(e) => {
              setUsername(e.target.value);
              setLibraries([]);
            }}
          />
        </div>
        <div className='space-y-1.5'>
          <SectionTitle as='label' htmlFor='calibre-password'>
            {_('Password')}
          </SectionTitle>
          <input
            id='calibre-password'
            type='password'
            autoComplete='current-password'
            disabled={busy}
            value={password}
            className='input eink-bordered settings-content w-full'
            onChange={(e) => {
              setPassword(e.target.value);
              setLibraries([]);
            }}
          />
        </div>
        {libraries.length > 0 && (
          <div className='space-y-1.5'>
            <SectionTitle as='label' htmlFor='calibre-library'>
              {_('Library')}
            </SectionTitle>
            <select
              id='calibre-library'
              className='select eink-bordered settings-content w-full'
              value={libraryId}
              disabled={busy}
              onChange={(e) => setLibraryId(e.target.value)}
            >
              {libraries.map((library) => (
                <option key={library.id} value={library.id}>
                  {library.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {error && (
          <p role='alert' className='text-error text-[0.85em]'>
            {error}
          </p>
        )}
        <div className='flex justify-end'>
          <button type='submit' className='btn btn-contrast' disabled={busy || !url}>
            {busy ? _('Connecting...') : libraries.length ? _('Save') : _('Connect')}
          </button>
        </div>
      </form>
      <Tips>
        <li>
          {_(
            'Metadata and tags are imported from Calibre. Local edits are not sent to the server.',
          )}
        </li>
        <li>{_('Books already on the server are linked instead of sent again.')}</li>
        <li>
          {_(
            'Removed server books are marked unavailable; downloaded files and annotations are never deleted automatically.',
          )}
        </li>
        <li>
          {_(
            'EPUB reading-position sync requires a signed-in Calibre Content Server account with write access. Calibre-Web does not provide this API.',
          )}
        </li>
        <li>
          {_('Use HTTPS on untrusted networks. HTTP sends your credentials without encryption.')}
        </li>
        {isWebAppPlatform() && (
          <li>
            {_(
              'Browser connections require the server to allow this site in its CORS policy. HTTPS pages cannot connect to an HTTP server. Use the native app for local servers.',
            )}
          </li>
        )}
        {isWebAppPlatform() && (
          <li>{_('Sending books to Calibre-Web requires the desktop or mobile app.')}</li>
        )}
      </Tips>
    </div>
  );
}
