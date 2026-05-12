import type { Message } from "../types";

export interface PrivacyFilterOptions {
  patterns: string[];
  maxQuoteLength: number;
}

const REDACTION = "[redacted]";

export function isInjectedContext(content: string, patterns: string[]): boolean {
  const lower = content.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern.toLowerCase()));
}

export function redactSensitiveText(content: string): string {
  return content
    .replace(/(api[_-]?key\s*[:=]\s*)(["']?)[^\s"',]+/gi, `$1$2${REDACTION}`)
    .replace(/(authorization\s*:\s*bearer\s+)[^\s"',]+/gi, `$1${REDACTION}`)
    .replace(/(password\s*[:=]\s*)(["']?)[^\s"',]+/gi, `$1$2${REDACTION}`)
    .replace(/(secret\s*[:=]\s*)(["']?)[^\s"',]+/gi, `$1$2${REDACTION}`)
    .replace(/(token\s*[:=]\s*)(["']?)[^\s"',]+/gi, `$1$2${REDACTION}`);
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
