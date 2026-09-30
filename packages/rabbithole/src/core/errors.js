export class RabbitholeError extends Error {
  /** @param {string} message @param {{code?: string, status?: number, retryable?: boolean, userMessage?: string, cause?: unknown}} [options] */
  constructor(message, { code = "internal_error", status = 500, retryable = false, userMessage = message, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RabbitholeError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.userMessage = userMessage;
  }
}

/** @param {unknown} error @param {Partial<{code: string, status: number, retryable: boolean, userMessage: string}>} [fallback] */
export function normalizeRabbitholeError(error, fallback = {}) {
  if (error instanceof RabbitholeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new RabbitholeError(message, { ...fallback, cause: error });
}
