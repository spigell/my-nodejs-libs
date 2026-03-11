export class RetryError extends Error {
  attempts: number;
  lastError: Error;

  constructor(message: string, attempts: number, lastError: Error) {
    super(message);
    this.name = 'RetryError';
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

export async function simple<T>(
  fn: () => Promise<T>,
  retries: number = 3,
  delay: number = 1000,
): Promise<{ result: T; tries: number }> {
  if (retries < 1) {
    throw new Error('The number of retries must be at least 1.');
  }

  let attempts = 0;
  let lastError: Error | null = null;

  while (attempts < retries) {
    try {
      attempts++;
      const result = await fn(); // Try the provided function
      return { result, tries: attempts }; // Return the result on success
    } catch (error) {
      lastError = error as Error; // Type assertion for the caught error
      if (attempts >= retries) {
        throw new RetryError(
          `Maximum retries reached (${retries}).`,
          attempts,
          lastError,
        );
      }
      // Exponential backoff with delay
      await new Promise((resolve) => setTimeout(resolve, delay * attempts));
    }
  }

  // Fallback, should not reach here
  throw new RetryError(
    'Unexpected exit from retry logic.',
    attempts,
    lastError!,
  );
}
