import type { DnsRecordInfo, CreateDnsRecordParams, UpdateDnsRecordParams } from "../dnshe";

export type PlatformId = "dnshe" | "cloudflare" | "dnsneko" | "gleam";

export type PlatformCapability =
  | "domains.read"
  | "records.read"
  | "records.create"
  | "records.update"
  | "records.delete"
  | "records.batch"
  | "domains.register"
  | "domains.renew"
  | "zones.manage"
  | "quota.read";

export interface PlatformCredentialField {
  key: "api_key" | "api_secret" | "api_token" | "username";
  label: string;
  secret?: boolean;
  required: boolean;
  placeholder?: string;
}

export interface PlatformDefinition {
  id: PlatformId;
  name: string;
  description: string;
  credentialFields: PlatformCredentialField[];
  capabilities: PlatformCapability[];
  upstreamHosts: string[];
  rateLimit: { requests: number; windowSeconds: number };
}

export interface UnifiedDomain {
  id: string;
  name: string;
  platform: PlatformId;
  accountId: number;
  accountAlias: string;
  status: string;
  createdAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  remainingDays: number | null;
  recordCount: number | null;
  raw: unknown;
}

export interface UnifiedRecord {
  id: string;
  domainId: string;
  name: string;
  type: string;
  value: string;
  line: string | null;
  ttl: number;
  priority: number | null;
  status: "active" | "paused";
  updatedAt: string | null;
  raw: unknown;
}

export interface PlatformCredentials {
  apiKey?: string;
  apiSecret?: string;
  apiToken?: string;
  username?: string;
}

export interface PlatformAdapter {
  readonly platform: PlatformId;
  verify(credentials: PlatformCredentials): Promise<{ alias?: string | null; identity?: string | null }>;
  listDomains(credentials: PlatformCredentials, accountId: number, accountAlias: string): Promise<UnifiedDomain[]>;
  listRecords(credentials: PlatformCredentials, domainId: string): Promise<UnifiedRecord[]>;
  createRecord(credentials: PlatformCredentials, domainId: string, input: CreateDnsRecordParams): Promise<UnifiedRecord | null>;
  updateRecord(credentials: PlatformCredentials, domainId: string, recordId: string, input: UpdateDnsRecordParams): Promise<UnifiedRecord | null>;
  deleteRecord(credentials: PlatformCredentials, domainId: string, recordId: string): Promise<void>;
  batchOperation?(credentials: PlatformCredentials, domainId: string, operation: "delete" | "status" | "ttl" | "line", ids: string[], value?: string | number | boolean): Promise<void>;
}

export class PlatformError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code = "platform_error"
  ) {
    super(message);
    this.name = "PlatformError";
  }
}

export function remainingDays(expiresAt?: string | null): number | null {
  if (!expiresAt) return null;
  const timestamp = new Date(expiresAt.replace(" ", "T")).getTime();
  return Number.isFinite(timestamp) ? Math.ceil((timestamp - Date.now()) / 86400000) : null;
}

export function safePlatformError(error: unknown): PlatformError {
  if (error instanceof PlatformError) return error;
  return new PlatformError(error instanceof Error ? error.message : "平台 API 调用失败");
}
