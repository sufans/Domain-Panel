import { CloudflareClient } from "../../cloudflare";
import type { CfZoneInfo } from "../../cloudflare";
import { DNSHEClient } from "../../dnshe";
import type { CreateDnsRecordParams, UpdateDnsRecordParams } from "../../dnshe";
import type { PlatformAdapter, PlatformCredentials, UnifiedDomain, UnifiedRecord } from "../types";
import { PlatformError, remainingDays } from "../types";

function mapDnsheDomain(item: Record<string, unknown>, accountId: number, accountAlias: string): UnifiedDomain {
  const expiresAt = typeof item.expires_at === "string" ? item.expires_at : null;
  const days = remainingDays(expiresAt);
  return {
    id: String(item.id), name: String(item.full_domain || `${item.subdomain || ""}.${item.rootdomain || ""}`), platform: "dnshe", accountId, accountAlias,
    status: String(item.status || "unknown"), createdAt: typeof item.created_at === "string" ? item.created_at : null,
    expiresAt, expired: String(item.status) === "expired" || (days !== null && days < 0), remainingDays: days,
    recordCount: typeof item.dns_count === "number" ? item.dns_count : null, raw: item
  };
}

function mapRecord(item: Record<string, unknown>, domainId: string): UnifiedRecord {
  return { id: String(item.id ?? item.record_id ?? ""), domainId, name: String(item.name || "@"), type: String(item.type || "A"), value: String(item.content || ""), line: item.line ? String(item.line) : null, ttl: Number(item.ttl || 600), priority: item.priority == null ? null : Number(item.priority), status: item.status === "paused" || item.status === "suspended" ? "paused" : "active", updatedAt: item.updated_at ? String(item.updated_at) : null, raw: item };
}

export function createDnsheAdapter(): PlatformAdapter {
  return {
    platform: "dnshe",
    async verify(credentials) {
      if (!credentials.apiKey || !credentials.apiSecret) throw new PlatformError("DNSHE 缺少 API Key 或 API Secret", 400, "invalid_credentials");
      await new DNSHEClient(credentials.apiKey, credentials.apiSecret).getQuota(8000);
      return {};
    },
    async listDomains(credentials, accountId, accountAlias) {
      const client = new DNSHEClient(credentials.apiKey || "", credentials.apiSecret || "");
      const domains = [];
      for (let page = 1; page <= 50; page++) {
        const response = await client.listSubdomains(page, 500, "", "", "id", "asc");
        domains.push(...(response.subdomains || []));
        if (!response.subdomains || response.subdomains.length < 500) break;
      }
      return domains.map((item) => mapDnsheDomain(item as unknown as Record<string, unknown>, accountId, accountAlias));
    },
    async listRecords(credentials, domainId) {
      const response = await new DNSHEClient(credentials.apiKey || "", credentials.apiSecret || "").listDnsRecords(domainId);
      return (response.records || []).map((item) => mapRecord(item as unknown as Record<string, unknown>, domainId));
    },
    async createRecord(credentials, domainId, input) {
      const response = await new DNSHEClient(credentials.apiKey || "", credentials.apiSecret || "").createDnsRecord({ subdomain_id: Number(domainId), type: input.type, name: input.name, content: input.content, ttl: input.ttl, priority: input.priority ?? undefined, line: input.line ?? undefined });
      return response.record ? mapRecord(response.record as unknown as Record<string, unknown>, domainId) : null;
    },
    async updateRecord(credentials, domainId, recordId, input) {
      await new DNSHEClient(credentials.apiKey || "", credentials.apiSecret || "").updateDnsRecord({ record_id: recordId, subdomain_id: Number(domainId), type: input.type, name: input.name, content: input.content, ttl: input.ttl, priority: input.priority ?? undefined, line: input.line ?? undefined });
      return null;
    },
    async deleteRecord(credentials, domainId, recordId) { await new DNSHEClient(credentials.apiKey || "", credentials.apiSecret || "").deleteDnsRecord(domainId, recordId); }
  };
}

function mapCfZone(zone: CfZoneInfo, accountId: number, accountAlias: string): UnifiedDomain {
  return { id: String(zone.id), name: zone.name, platform: "cloudflare", accountId, accountAlias, status: zone.status || "unknown", createdAt: zone.created_on || null, expiresAt: null, expired: false, remainingDays: null, recordCount: null, raw: zone };
}

export function createCloudflareAdapter(): PlatformAdapter {
  return {
    platform: "cloudflare",
    async verify(credentials) { const result = await new CloudflareClient(credentials.apiToken || "").verifyToken(); if (result.status && result.status.toLowerCase() !== "active") throw new PlatformError(`Cloudflare Token 状态异常（${result.status}）`, 400, "invalid_credentials"); return { identity: result.token_id }; },
    async listDomains(credentials, accountId, accountAlias) { const zones = await new CloudflareClient(credentials.apiToken || "").listZones(); return zones.map((zone) => mapCfZone(zone, accountId, accountAlias)); },
    async listRecords(credentials, domainId) { const response = await new CloudflareClient(credentials.apiToken || "").listDnsRecords(domainId); return (response.records || []).map((item) => mapRecord(item as unknown as Record<string, unknown>, domainId)); },
    async createRecord(credentials, domainId, input) { const response = await new CloudflareClient(credentials.apiToken || "").createDnsRecord({ zone_id: domainId, zone_name: input.zone_name || "", type: input.type, name: input.name || "@", content: input.content || "", ttl: input.ttl, priority: input.priority ?? undefined }); return response.record ? mapRecord(response.record as unknown as Record<string, unknown>, domainId) : null; },
    async updateRecord(credentials, domainId, recordId, input) { await new CloudflareClient(credentials.apiToken || "").updateDnsRecord({ zone_id: domainId, record_id: recordId, zone_name: input.zone_name || "", type: input.type, name: input.name || "@", content: input.content || "", ttl: input.ttl, priority: input.priority ?? undefined }); return null; },
    async deleteRecord(credentials, domainId, recordId) { await new CloudflareClient(credentials.apiToken || "").deleteDnsRecord(domainId, recordId); }
  };
}
