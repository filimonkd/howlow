import { useState, type FormEvent, type ReactNode } from 'react';

/**
 * Deliberately plain forms. Phase 7 builds the real website; these exist to
 * exercise the authentication flows end to end.
 */
export function Panel({ title, children }: { title: string; children: ReactNode }): React.JSX.Element {
  return (
    <section className="rounded-lg border border-black/10 p-5 dark:border-white/15">
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
}): React.JSX.Element {
  return (
    <label className="mb-3 block text-sm">
      <span className="mb-1 block opacity-70">{label}</span>
      <input
        className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 dark:border-white/20"
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </label>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant = 'primary',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary';
}): React.JSX.Element {
  const base = 'rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50';
  const styles =
    variant === 'primary'
      ? 'bg-black text-white dark:bg-white dark:text-black'
      : 'border border-black/15 dark:border-white/20';
  return (
    <button
      type={onClick ? 'button' : 'submit'}
      className={`${base} ${styles}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function Notice({
  kind,
  children,
}: {
  kind: 'error' | 'info';
  children: ReactNode;
}): React.JSX.Element {
  const styles =
    kind === 'error'
      ? 'border-red-500/40 text-red-700 dark:text-red-300'
      : 'border-black/10 dark:border-white/15';
  return <p className={`mb-3 rounded-md border px-3 py-2 text-sm ${styles}`}>{children}</p>;
}

export function useForm<T extends Record<string, string>>(initial: T) {
  const [values, setValues] = useState<T>(initial);
  const set = (key: keyof T) => (value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
  };
  const onSubmit = (handler: () => void) => (event: FormEvent) => {
    event.preventDefault();
    handler();
  };
  return {
    values,
    set,
    onSubmit,
    reset: () => {
      setValues(initial);
    },
  };
}
