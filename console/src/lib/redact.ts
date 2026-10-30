const patterns: Array<[RegExp, string]> = [
  [/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, '$1••••'],
  [/((?:accessToken|apiKey|api_key|token|password|secret)["']?\s*[:=]\s*["'])([^"']{4,})(["'])/gi, '$1••••••••$3'],
  [/(Authorization:\s*Bearer\s+)[^\s]+/gi, '$1••••••••'],
  [/(uin=)[^&\s]+/gi, '$1••••'],
];

/** 日志展示与复制前的轻量脱敏；不尝试解析日志结构。 */
export function redactSecrets(input: string) {
  return patterns.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), input);
}
