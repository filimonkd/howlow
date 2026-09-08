import type { HealthResponse } from '@howlow/shared';

interface Props {
  readonly state:
    | { readonly kind: 'loading' }
    | { readonly kind: 'ready'; readonly health: HealthResponse }
    | { readonly kind: 'error'; readonly message: string };
}

export function StatusPanel({ state }: Props): React.JSX.Element {
  if (state.kind === 'loading') {
    return <p className="text-sm opacity-70">Checking backend…</p>;
  }

  if (state.kind === 'error') {
    return (
      <p className="rounded-md border border-red-500/40 px-4 py-3 text-sm">
        Backend unreachable: {state.message}
      </p>
    );
  }

  const { health } = state;

  return (
    <section className="rounded-md border border-black/10 px-4 py-3 text-sm dark:border-white/15">
      <p className="font-medium">
        API {health.status} · v{health.version} · up {health.uptimeSeconds}s
      </p>
      <ul className="mt-2 space-y-1">
        {Object.entries(health.checks).map(([name, check]) => (
          <li key={name} className="flex justify-between gap-4">
            <span className="opacity-70">{name}</span>
            <span>
              {check.status}
              {check.latencyMs === undefined ? '' : ` · ${check.latencyMs}ms`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
