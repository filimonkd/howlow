import { useEffect, useState } from 'react';
import type { PublicUser, TelegramStatus } from '@howlow/shared';
import * as api from '../lib/auth-api.js';
import { Button, Field, Notice, Panel, useForm } from '../components/AuthForms.js';

interface Props {
  readonly user: PublicUser;
  readonly onSignOut: () => void;
  readonly onUserChanged: (user: PublicUser) => void;
}

/**
 * Authenticated shell: who you are, your Telegram connection, and password
 * setup. Enough to verify Phase 2 end to end; the marketplace arrives later.
 */
export function Dashboard({ user, onSignOut, onUserChanged }: Props): React.JSX.Element {
  const [telegram, setTelegram] = useState<TelegramStatus>();
  const [deepLink, setDeepLink] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const passwordForm = useForm({ currentPassword: '', newPassword: '' });

  const refreshTelegram = (): void => {
    void api
      .telegramStatus()
      .then(setTelegram)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'Could not load Telegram status.');
      });
  };

  useEffect(refreshTelegram, []);

  const run = (action: () => Promise<void>) => {
    setError(undefined);
    setMessage(undefined);
    void action().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'Something went wrong.');
    });
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      {error !== undefined && <Notice kind="error">{error}</Notice>}
      {message !== undefined && <Notice kind="info">{message}</Notice>}

      <Panel title="Your HOWLOW account">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="opacity-70">Name</dt>
          <dd>{user.displayName}</dd>
          <dt className="opacity-70">Phone</dt>
          <dd>{user.phone ?? '—'}</dd>
          <dt className="opacity-70">Status</dt>
          <dd>{user.status}</dd>
          <dt className="opacity-70">Roles</dt>
          <dd>{user.roles.join(', ')}</dd>
          <dt className="opacity-70">Password</dt>
          <dd>{user.hasPassword ? 'set' : 'not set'}</dd>
        </dl>
        <div className="mt-4">
          <Button
            variant="secondary"
            onClick={() => {
              void api.logout().then(onSignOut);
            }}
          >
            Sign out
          </Button>
        </div>
      </Panel>

      <Panel title="Telegram">
        {telegram === undefined ? (
          <p className="text-sm opacity-70">Checking…</p>
        ) : telegram.linked ? (
          <>
            <p className="mb-3 text-sm">
              Connected{telegram.username === null ? '' : ` as @${telegram.username}`}. The bot and this
              website share one HOWLOW account.
            </p>
            <Button
              variant="secondary"
              onClick={() => {
                run(async () => {
                  await api.unlinkTelegram();
                  setMessage('Telegram disconnected.');
                  refreshTelegram();
                });
              }}
            >
              Disconnect Telegram
            </Button>
          </>
        ) : (
          <>
            <p className="mb-3 text-sm opacity-70">
              Connect Telegram to bid from the bot using this same account.
            </p>
            <Button
              onClick={() => {
                run(async () => {
                  const link = await api.createTelegramLink();
                  setDeepLink(link.deepLink);
                  setMessage(`Link valid for ${Math.round(link.expiresInSeconds / 60)} minutes.`);
                });
              }}
            >
              Connect Telegram
            </Button>
            {deepLink !== undefined && (
              <p className="mt-3 break-all text-sm">
                <a className="underline" href={deepLink} target="_blank" rel="noreferrer">
                  {deepLink}
                </a>
              </p>
            )}
          </>
        )}
      </Panel>

      <Panel title={user.hasPassword ? 'Change password' : 'Set a password'}>
        <p className="mb-3 text-sm opacity-70">
          Optional. A password lets you sign in on the website without waiting for a code.
        </p>
        <form
          onSubmit={passwordForm.onSubmit(() => {
            run(async () => {
              await api.setPassword({
                newPassword: passwordForm.values.newPassword,
                ...(user.hasPassword ? { currentPassword: passwordForm.values.currentPassword } : {}),
              });
              passwordForm.reset();
              setMessage(
                user.hasPassword ? 'Password changed. Other sessions were signed out.' : 'Password set.',
              );
              onUserChanged(await api.getMe());
            });
          })}
        >
          {user.hasPassword && (
            <Field
              label="Current password"
              type="password"
              value={passwordForm.values.currentPassword}
              onChange={passwordForm.set('currentPassword')}
              autoComplete="current-password"
            />
          )}
          <Field
            label="New password (min 12 characters)"
            type="password"
            value={passwordForm.values.newPassword}
            onChange={passwordForm.set('newPassword')}
            autoComplete="new-password"
          />
          <Button>{user.hasPassword ? 'Change password' : 'Set password'}</Button>
        </form>
      </Panel>
    </div>
  );
}
