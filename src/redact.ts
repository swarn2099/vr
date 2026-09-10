export function redact(text: string): string {
  return text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      (m) => m.replace(/[^\n]/g, "*"),
    )
    .replace(
      /((?:password|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["'])([^"'\n]{8,})(["'])/gi,
      "$1[REDACTED]$3",
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g,
      "[REDACTED]",
    );
}
