import type { Message, OperationDiagnostic, Provider, Session } from "../types";

export interface AdapterScanResult {
  sessions: Session[];
  diagnostics: OperationDiagnostic[];
}

export interface TranscriptAdapter {
  readonly provider: Provider;
  scan(roots: string[]): Promise<AdapterScanResult>;
  parseMessages(sourcePath: string, sessionId?: string): Promise<Message[]>;
}

export interface FileStatInfo {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface AdapterParseOptions {
  privacyPatterns: string[];
  maxQuoteLength: number;
}
