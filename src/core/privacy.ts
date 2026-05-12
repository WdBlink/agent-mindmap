import type { Message } from "../types";

export interface PrivacyFilterOptions {
  patterns: string[];
  maxQuoteLength: number;
}

const REDACTION = "[redacted]";
const SENSITIVE_KEY = /^(api[_-]?key|authorization|password|secret|token)$/i;

export function isInjectedContext(content: string, patterns: string[]): boolean {
  const lower = content.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern.toLowerCase()));
}

export function redactSensitiveText(content: string): string {
  return content
    .replace(/(\bapi[_-]?key\b["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, `$1${REDACTION}`)
    .replace(/(\bauthorization\b["']?\s*:\s*["']?bearer\s+)[^\s"',}]+/gi, `$1${REDACTION}`)
    .replace(/(\bpassword\b["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, `$1${REDACTION}`)
    .replace(/(\bsecret\b["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, `$1${REDACTION}`)
    .replace(/(\btoken\b["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, `$1${REDACTION}`);
}

export function redactSensitiveValue(value: unknown, keyHint?: string): unknown {
  if (keyHint && SENSITIVE_KEY.test(keyHint)) {
    return REDACTION;
  }
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValue(item));
  }
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      redacted[key] = redactSensitiveValue(child, key);
    }
    return redacted;
  }
  return value;
}

export function filterMessage(message: Message, options: PrivacyFilterOptions): Message | null {
  if (isInjectedContext(message.content, options.patterns)) {
    return null;
  }

  const content = redactSensitiveText(message.content);
  const blocks = message.blocks?.map((block) => {
    if (block.type === "text" || block.type === "thinking") {
      return { ...block, text: redactSensitiveText(block.text) };
    }
    if (block.type === "tool_result") {
      return { ...block, content: redactSensitiveText(block.content) };
    }
    if (block.type === "tool_use") {
      return { ...block, input: redactSensitiveValue(block.input) };
    }
    return block;
  });

  return { ...message, content, blocks };
}

export function quoteForTrace(content: string, maxQuoteLength: number): string {
  const cleaned = redactSensitiveText(content).replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxQuoteLength) {
    return cleaned;
  }
  return `${cleaned.slice(0, Math.max(0, maxQuoteLength - 1)).trimEnd()}…`;
}
