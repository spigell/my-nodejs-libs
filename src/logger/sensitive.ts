const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|password|passwd|secret|token|credential|api[-_]?key|private[-_]?key|session)/i;

export const isSensitiveKey = (key: string): boolean =>
  SENSITIVE_KEY_PATTERN.test(key);
