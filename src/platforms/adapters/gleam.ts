import { requestJson } from "./http";
import type { PlatformAdapter, PlatformCredentials, UnifiedDomain, UnifiedRecord } from "../types";
import { PlatformError } from "../types";

const BASE = "https://sld.0n.pub/api/v1/open";
type GleamResponse<T> = { code: number; message?: string; data: T };
type GleamDomain = { id: number; fqdn: string; status: string; created_at: string; updated_at: string; dns_records?: GleamRecord[] };
type GleamRecord = { id: number; type: string; name: string; content: string; ttl: number; provider_record_id: string; status: string; updated_at: string };

function headers(credentials: PlatformCredentials, json = false, idempotent = false): HeadersInit {
  if (!credentials.apiKey) throw new PlatformError("GLEAM 缺少 API Key", 400, "invalid_credentials");
  return {
    "X-API-Key": credentials.apiKey,
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(idempotent ? { "X-Idempotency-Key": crypto.randomUUID() } : {})
  };
}

async function request<T>(credentials: PlatformCredentials, path: string, init: RequestInit = {}): Promise<T> {
  const payload = await requestJson<GleamResponse<T>>(`${BASE}${path}`, { ...init, headers: { ...headers(credentials, init.body !== undefined, init.method !== undefined && init.method !== "GET"), ...(init.headers || {}) } });
  if (payload.code !== 0) throw new PlatformError(payload.message || "GLEAM API 调用失败", 502, "upstream_error");
  return payload.data;
}

function mapDomain(item: GleamDomain, accountId: number, accountAlias: string): UnifiedDomain {
  return { id: String(item.id), name: item.fqdn, platform: "gleam", accountId, accountAlias, status: item.status, createdAt: item.created_at || null, expiresAt: null, expired: false, remainingDays: null, recordCount: Array.isArray(item.dns_records) ? item.dns_records.length : null, raw: item };
}

function mapRecord(item: GleamRecord, domainId: string): UnifiedRecord {
  return { id: String(item.id), domainId, name: item.name, type: item.type, value: item.content, line: null, ttl: item.ttl, priority: null, status: item.status === "active" ? "active" : "paused", updatedAt: item.updated_at || null, raw: item };
}

export function createGleamAdapter(): PlatformAdapter {
  const allowedTypes = new Set(["A", "AAAA", "CNAME", "TXT"]);
  return {
    platform: "gleam",
    async verify(credentials) {
      const user = await request<{ id?: number; name?: string | null; email?: string | null }>(credentials, "/user/info");
      return { alias: user?.name || user?.email || null, identity: user?.id ? String(user.id) : null };
    },
    async listDomains(credentials, accountId, accountAlias) {
      const domains = new Map<string, GleamDomain>();
      for (let page = 1; page <= 50; page++) {
        const items = await request<GleamDomain[]>(credentials, `/subdomains?page=${page}&size=100`);
        const before = domains.size;
        for (const item of items) domains.set(String(item.id), item);
        if (items.length < 100 || domains.size === before) break;
      }
      return Array.from(domains.values()).map((item) => mapDomain(item, accountId, accountAlias));
    },
    async listRecords(credentials, domainId) { return (await request<GleamRecord[]>(credentials, `/dns-records/${encodeURIComponent(domainId)}`)).map((item) => mapRecord(item, domainId)); },
    async createRecord(credentials, domainId, input) {
      const type = String(input.type || "").toUpperCase();
      if (!allowedTypes.has(type)) throw new PlatformError(`GLEAM 只支持 A / AAAA / CNAME / TXT 记录（收到 ${type || "空类型"}）`, 400, "unsupported_record_type");
      // GLEAM 由服务商决定 TTL，不接受客户端传值；主机名固定为已认领的 fqdn，也不接受自定义 name。
      const record = await request<GleamRecord>(credentials, `/dns-records/${encodeURIComponent(domainId)}`, { method: "POST", body: JSON.stringify({ type, content: input.content }) });
      return record ? mapRecord(record, domainId) : null;
    },
    async updateRecord(credentials, domainId, recordId, input) { const record = await request<GleamRecord>(credentials, `/dns-records/${encodeURIComponent(domainId)}/${encodeURIComponent(recordId)}`, { method: "PUT", body: JSON.stringify({ content: input.content }) }); return record ? mapRecord(record, domainId) : null; },
    async deleteRecord(credentials, domainId, recordId) { await request<{ message: string }>(credentials, `/dns-records/${encodeURIComponent(domainId)}/${encodeURIComponent(recordId)}`, { method: "DELETE" }); }
  };
}
