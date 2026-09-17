import { apiErrorSchema, REQUEST_ID_HEADER, type HealthResponse, healthResponseSchema } from '@howlow/shared';

const API_BASE = (import.meta.env['VITE_API_BASE_URL'] as string | undefined) ?? '/api/v1';

export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId?: string,
    /**
     * The `details` the API returned, unchanged.
     *
     * Carried because the transport code alone is not enough to say what went
     * wrong: several bid refusals share one status, and the stable code a
     * client branches on — `details.bidError` — lives here. Without it the
     * bidding UI could only ever show the server's own sentence.
     */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/**
 * The website's only way of reaching HOWLOW. It speaks the same API the
 * Telegram channel's services sit behind — there is no web-specific backend.
 */
export async function apiFetch<T>(
  path: string,
  parse: (value: unknown) => T,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: { Accept: 'application/json', ...init?.headers },
  });

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(body);
    throw new ApiRequestError(
      parsed.success ? parsed.data.error.code : 'INTERNAL',
      parsed.success ? parsed.data.error.message : `Request failed with status ${response.status}`,
      response.headers.get(REQUEST_ID_HEADER) ?? undefined,
      parsed.success ? parsed.data.error.details : undefined,
    );
  }

  return parse(body);
}

export function fetchHealth(): Promise<HealthResponse> {
  return apiFetch('/health/ready', (value) => healthResponseSchema.parse(value));
}
