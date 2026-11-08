import type { CreateDnsRecordParams, UpdateDnsRecordParams } from "../../dnshe";
import { requestJson } from "./http";
import type { PlatformAdapter, PlatformCredentials, UnifiedDomain, UnifiedRecord } from "../types";
import { PlatformError, remainingDays } from "../types";

const BASE = "https://www.dnsneko.com/api/v1/dns";
type NekoResponse<T> = { code: number | string; message?: string; data: T | null };
type NekoDomain = { id: string; domain: string; status: number; expired: boolean; expireTime?: string; recordCount?: string; createTime?: string };
type NekoRecord = { id: string; name: string; type: string; value: string; line: string; ttl: number; priority: number | null; status: number; updateTime: string | null };

function headers(credentials: PlatformCredentials, json = false): HeadersInit {
  if (!credentials.username || !credentials.apiKey) throw new PlatformError("DNSNEKO 缺少 Username 或 API Key", 400, "invalid_credentials");
  return { "X-DNSNEKO-USERNAME": credentials.username, "X-DNSNEKO-API-KEY": credentials.apiKey, ...(json ? { "Content-Type": "application/json" } : {}) };
}

async function request<T>(credentials: PlatformCredentials, path: string, init: RequestInit = {}): Promise<T> {
  const payload = await requestJson<NekoResponse<T>>(`${BASE}${path}`, { ...init, headers: { ...headers(credentials, init.body !== undefined), ...(init.headers || {}) } });
  if (String(payload.code) !== "200") throw new PlatformError(payload.message || "DNSNEKO API 调用失败", Number(payload.code) || 502, "upstream_error");
  return payload.data as T;
}

export function createDnsNekoAdapter(): PlatformAdapter {
  return {
    platform: "dnsneko",
    async verify(credentials) {
      await request<{ domains?: NekoDomain[] }>(credentials, "/domains?page=1&size=1");
      return {};
    },
    async listDomains(credentials, accountId, accountAlias) {
      const domains: NekoDomain[] = [];
      for (let page = 1; page <= 50; page++) {
        const data = await request<{ domains?: NekoDomain[] }>(credentials, `/domains?page=${page}&size=100`);
        domains.push(...(data.domains || []));
        if (!data.domains || data.domains.length < 100) break;
      }
      return domains.map((item): UnifiedDomain => ({
        id: item.id, name: item.domain, platform: "dnsneko", accountId, accountAlias,
        status: String(item.status), createdAt: item.createTime || null, expiresAt: item.expireTime || null,
        expired: Boolean(item.expired), remainingDays: remainingDays(item.expireTime), recordCount: item.recordCount ? Number(item.recordCount) : null, raw: item
      }));
    },
    async listRecords(credentials, domainId) {
      const data = await request<{ records?: NekoRecord[] }>(credentials, `/records?domainId=${encodeURIComponent(domainId)}&page=1&size=100`);
      return (data.records || []).map((item): UnifiedRecord => ({ id: item.id, domainId, name: item.name, type: item.type, value: item.value, line: item.line || null, ttl: item.ttl, priority: item.priority, status: item.status === 1 ? "active" : "paused", updatedAt: item.updateTime, raw: item }));
    },
    async createRecord(credentials, domainId, input) {
      await request<null>(credentials, `/records/${encodeURIComponent(domainId)}`, { method: "POST", body: JSON.stringify({ name: input.name, type: input.type, value: input.content, line: input.line || "default", ttl: input.ttl, priority: input.priority ?? undefined }) });
      return null;
    },
    async updateRecord(credentials, domainId, recordId, input) {
      await request<null>(credentials, `/records/${encodeURIComponent(domainId)}/${encodeURIComponent(recordId)}`, { method: "PUT", body: JSON.stringify({ name: input.name, type: input.type, value: input.content, line: input.line || "default", ttl: input.ttl, priority: input.priority ?? undefined }) });
      return null;
    },
    async deleteRecord(credentials, domainId, recordId) {
      await request<null>(credentials, `/records/${encodeURIComponent(domainId)}/${encodeURIComponent(recordId)}`, { method: "DELETE" });
    },
    async batchOperation(credentials, domainId, operation, ids, value) {
      const body: Record<string, unknown> = { domainId: Number(domainId), ids: ids.map(Number) };
      if (operation === "status") body.status = value === true || value === 1 ? 1 : 0;
      if (operation === "ttl") body.ttl = Number(value);
      if (operation === "line") body.line = String(value || "default");
      await request<null>(credentials, `/records/batch/${operation === "delete" ? "delete" : operation}`, { method: "POST", body: JSON.stringify(body) });
    }
  };
}
