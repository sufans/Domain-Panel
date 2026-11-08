import { requestJson } from "./http";
import type { PlatformAdapter, PlatformCredentials, UnifiedDomain, UnifiedRecord } from "../types";
import { PlatformError } from "../types";

const BASE = "https://sld.0n.pub/api/v1/open";
type GleamResponse<T> = { code: number; message?: string; data: T };
type GleamDomain = { id: number; fqdn: string; status: string; created_at: string; updated_at: string; dns_records?: GleamRecord[] };
type GleamRecord = { id: number; type: string; name: string; content: string; ttl: number; provider_record_id: string; status: string; updated_at: string };

function headers(credentials: PlatformCredentials, json = false): HeadersInit {
  if (!credentials.apiKey) throw new PlatformError("GLEAM 缺少 API Key", 400, "invalid_credentials");
  return { "X-API-Key": credentials.apiKey, ...(json ? { "Content-Type": "application/json" } : {}) };
}

async function request<T>(credentials: PlatformCredentials, path: string, init: RequestInit = {}): Promise<T> {
  const payload = await requestJson<GleamResponse<T>>(`${BASE}${path}`, { ...init, headers: { ...headers(credentials, init.body !== undefined), ...(init.headers || {}) } });
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
  return {
    platform: "gleam",
    async verify(credentials) { await request<GleamDomain[]>(credentials, "/subdomains?page=1&size=1"); return {}; },
    async listDomains(credentials, accountId, accountAlias) {
      const domains: GleamDomain[] = [];
      for (let page = 1; page <= 50; page++) {
        const items = await request<GleamDomain[]>(credentials, `/subdomains?page=${page}&size=100`);
        domains.push(...items);
        if (items.length < 100) break;
      }
      return domains.map((item) => mapDomain(item, accountId, accountAlias));
    },
    async listRecords(credentials, domainId) { return (await request<GleamRecord[]>(credentials, `/dns-records/${encodeURIComponent(domainId)}`)).map((item) => mapRecord(item, domainId)); },
    async createRecord(credentials, domainId, input) { const record = await request<GleamRecord>(credentials, `/dns-records/${encodeURIComponent(domainId)}`, { method: "POST", body: JSON.stringify({ type: input.type, content: input.content, ttl: input.ttl }) }); return record ? mapRecord(record, domainId) : null; },
    async updateRecord(credentials, domainId, recordId, input) { const record = await request<GleamRecord>(credentials, `/dns-records/${encodeURIComponent(domainId)}/${encodeURIComponent(recordId)}`, { method: "PUT", body: JSON.stringify({ content: input.content }) }); return record ? mapRecord(record, domainId) : null; },
    async deleteRecord(credentials, domainId, recordId) { await request<{ message: string }>(credentials, `/dns-records/${encodeURIComponent(domainId)}/${encodeURIComponent(recordId)}`, { method: "DELETE" }); }
  };
}
