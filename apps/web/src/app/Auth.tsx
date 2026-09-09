import { useState } from 'react';
import type { PublicUser } from '@howlow/shared';
import * as api from '../lib/auth-api.js';
import { Button, Field, Notice, Panel, useForm } from '../components/AuthForms.js';

type View = 'login' | 'register' | 'verify' | 'reset';

interface Props {
  readonly onAuthenticated: (user: PublicUser) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export function Auth({ onAuthenticated }: Props): React.JSX.Element {
  const [view, setView] = useState<View>('login');
  const [error, setError] = useState<string>();
  const [info, setInfo] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [pendingPhone, setPendingPhone] = useState('');

  const registerForm = useForm({ phone: '+251', displayName: '' });
  const verifyForm = useForm({ code: '' });
  const loginForm = useForm({ phone: '+251', code: '', password: '' });

  const run = (action: () => Promise<void>) => {
    setError(undefined);
    setBusy(true);
    void action()
      .catch((cause: unknown) => {
        setError(errorMessage(cause));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  // The development code comes back in the response so the flow is testable
  // without an SMS provider. The API omits it entirely when NODE_ENV=production.
  const showDevCode = (devCode?: string): void => {
    setInfo(
      devCode === undefined
        ? 'If that number has an account, a code has been sent.'
        : `Development code: ${devCode}`,
    );
  };

  return (
    <div className="mx-auto w-full max-w-md space-y-4">
      {error !== undefined && <Notice kind="error">{error}</Notice>}
      {info !== undefined && <Notice kind="info">{info}</Notice>}

      {view === 'register' && (
        <Panel title="Create your account">
          <form
            onSubmit={registerForm.onSubmit(() => {
              run(async () => {
                const result = await api.register(registerForm.values);
                setPendingPhone(registerForm.values.phone);
                showDevCode(result.devCode);
                setView('verify');
              });
            })}
          >
            <Field
              label="Phone number"
              value={registerForm.values.phone}
              onChange={registerForm.set('phone')}
              placeholder="+251911234567"
              autoComplete="tel"
            />
            <Field
              label="Display name"
              value={registerForm.values.displayName}
              onChange={registerForm.set('displayName')}
              autoComplete="name"
            />
            <div className="flex gap-2">
              <Button disabled={busy}>Send code</Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setView('login');
                }}
              >
                Sign in instead
              </Button>
            </div>
          </form>
        </Panel>
      )}

      {view === 'verify' && (
        <Panel title="Verify your phone">
          <p className="mb-3 text-sm opacity-70">Code sent to {pendingPhone}</p>
          <form
            onSubmit={verifyForm.onSubmit(() => {
              run(async () => {
                const result = await api.verifyPhone({ phone: pendingPhone, code: verifyForm.values.code });
                onAuthenticated(result.user);
              });
            })}
          >
            <Field
              label="6-digit code"
              value={verifyForm.values.code}
              onChange={verifyForm.set('code')}
              autoComplete="one-time-code"
            />
            <Button disabled={busy}>Verify</Button>
          </form>
        </Panel>
      )}

      {view === 'login' && (
        <Panel title="Sign in">
          <form
            onSubmit={loginForm.onSubmit(() => {
              run(async () => {
                if (loginForm.values.password !== '') {
                  const result = await api.login({
                    method: 'password',
                    phone: loginForm.values.phone,
                    password: loginForm.values.password,
                  });
                  onAuthenticated(result.user);
                  return;
                }
                if (loginForm.values.code !== '') {
                  const result = await api.login({
                    method: 'otp',
                    phone: loginForm.values.phone,
                    code: loginForm.values.code,
                  });
                  onAuthenticated(result.user);
                  return;
                }
                const dispatched = await api.requestLoginCode(loginForm.values.phone);
                showDevCode(dispatched.devCode);
              });
            })}
          >
            <Field
              label="Phone number"
              value={loginForm.values.phone}
              onChange={loginForm.set('phone')}
              autoComplete="tel"
            />
            <Field
              label="Code (leave blank to request one)"
              value={loginForm.values.code}
              onChange={loginForm.set('code')}
              autoComplete="one-time-code"
            />
            <Field
              label="Or password"
              value={loginForm.values.password}
              onChange={loginForm.set('password')}
              type="password"
              autoComplete="current-password"
            />
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy}>Continue</Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setView('register');
                }}
              >
                Create account
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setView('reset');
                }}
              >
                Forgot password
              </Button>
            </div>
          </form>
        </Panel>
      )}

      {view === 'reset' && (
        <ResetPassword
          busy={busy}
          run={run}
          showDevCode={showDevCode}
          onDone={() => {
            setView('login');
            setInfo('Password reset. You can sign in now.');
          }}
        />
      )}
    </div>
  );
}

function ResetPassword({
  busy,
  run,
  showDevCode,
  onDone,
}: {
  busy: boolean;
  run: (action: () => Promise<void>) => void;
  showDevCode: (devCode?: string) => void;
  onDone: () => void;
}): React.JSX.Element {
  const form = useForm({ phone: '+251', code: '', newPassword: '' });
  const [sent, setSent] = useState(false);

  return (
    <Panel title="Reset your password">
      <form
        onSubmit={form.onSubmit(() => {
          run(async () => {
            if (!sent) {
              const result = await api.requestPasswordReset(form.values.phone);
              showDevCode(result.devCode);
              setSent(true);
              return;
            }
            await api.resetPassword(form.values);
            onDone();
          });
        })}
      >
        <Field
          label="Phone number"
          value={form.values.phone}
          onChange={form.set('phone')}
          autoComplete="tel"
        />
        {sent && (
          <>
            <Field
              label="6-digit code"
              value={form.values.code}
              onChange={form.set('code')}
              autoComplete="one-time-code"
            />
            <Field
              label="New password (min 12 characters)"
              value={form.values.newPassword}
              onChange={form.set('newPassword')}
              type="password"
              autoComplete="new-password"
            />
          </>
        )}
        <Button disabled={busy}>{sent ? 'Set new password' : 'Send code'}</Button>
      </form>
    </Panel>
  );
}
