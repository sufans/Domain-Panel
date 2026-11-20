import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { usePageSearch } from "./PageSearch";

export type ManagedPlatformId = "dnsneko" | "gleam";

interface PlatformAccount {
  id: number;
  alias: string;
  provider?: string;
  api_key: string;
}

interface PlatformDefinition {
  id: string;
  name: string;
  capabilities: string[];
  recordTypes?: string[];
}

interface UnifiedDomain {
  id: string;
  name: string;
  platform: ManagedPlatformId;
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

interface UnifiedRecord {
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

interface AccountError {
  accountId: number;
  alias: string;
  platform: string;
  message: string;
}

interface RecordDraft {
  id: string | null;
  name: string;
  type: string;
  content: string;
  ttl: string;
  line: string;
  priority: string;
}

const EMPTY_DRAFT: RecordDraft = { id: null, name: "@", type: "A", content: "", ttl: "600", line: "default", priority: "" };
/** 首次打开表单时按平台给出合法默认类型，避免 GLEAM 提交它不支持的 MX 等类型。 */
const draftFor = (platform: ManagedPlatformId): RecordDraft => ({
  ...EMPTY_DRAFT,
  type: platform === "gleam" ? "A" : EMPTY_DRAFT.type,
});

const STATUS_LABEL: Record<string, string> = { "0": "正常", "1": "正常", active: "正常", paused: "已暂停", pending: "待激活" };
const PLATFORM_LABEL: Record<ManagedPlatformId, string> = { dnsneko: "DNSNEKO", gleam: "GLEAM" };

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value.replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("zh-CN");
}

function statusText(domain: UnifiedDomain) {
  if (domain.expired) return "已过期";
  return STATUS_LABEL[domain.status] || `状态 ${domain.status}`;
}

/**
 * DNSNEKO / GLEAM 的实时资产视图。
 *
 * 这两个平台不在 D1 快照里（没有挂到 domains_cache 的同步链路），
 * 所以用 /api/unified/* 直接读上游；能力按钮严格按 /api/platforms 的能力矩阵显隐，
 * 不靠「点下去再报 unsupported」来暴露差异。
 */
export function UnifiedPlatformAssets({
  accounts,
  definitions,
  apiFetch,
  onToast,
}: {
  accounts: PlatformAccount[];
  definitions: PlatformDefinition[];
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
  onToast: (type: "success" | "error" | "info" | "warning", message: string) => void;
}) {
  const managed = useMemo(
    () => accounts.filter((account): account is PlatformAccount & { provider: ManagedPlatformId } => account.provider === "dnsneko" || account.provider === "gleam"),
    [accounts]
  );
  const [domains, setDomains] = useState<UnifiedDomain[]>([]);
  const [errors, setErrors] = useState<AccountError[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [platformFilter, setPlatformFilter] = useState<"all" | ManagedPlatformId>("all");
  const [accountFilter, setAccountFilter] = useState("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState<number | null>(null);

  const [activeDomain, setActiveDomain] = useState<UnifiedDomain | null>(null);
  const [records, setRecords] = useState<UnifiedRecord[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsError, setRecordsError] = useState("");
  const [draft, setDraft] = useState<RecordDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchValue, setBatchValue] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);

  const { query } = usePageSearch();
  const normalized = query.trim().toLowerCase();

  const capabilityOf = (platform: string) => definitions.find((item) => item.id === platform)?.capabilities || [];
  const recordTypesOf = (platform?: ManagedPlatformId) => platform ? definitions.find((item) => item.id === platform)?.recordTypes || [] : [];

  const load = async (silent = false) => {
    if (managed.length === 0) {
      setDomains([]);
      setErrors([]);
      setLoaded(true);
      return;
    }
    if (!silent) setLoading(true);
    const platforms: ManagedPlatformId[] = Array.from(new Set(managed.map((account) => account.provider)));
    try {
      const responses = await Promise.all(platforms.map(async (platform) => {
        const res = await apiFetch(`/api/unified/domains?provider=${platform}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.message || `${PLATFORM_LABEL[platform]} 域名读取失败`);
        return {
          domains: (data.domains || []) as UnifiedDomain[],
          errors: (data.errors || []) as AccountError[],
        };
      }));
      setDomains(responses.flatMap((item) => item.domains));
      setErrors(responses.flatMap((item) => item.errors));
      setLoaded(true);
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "读取平台域名失败");
    } finally {
      setLoading(false);
    }
  };

  // 账号集合变化（新增/解绑）后重新读一次，避免展示已解绑账号的残留资产。
  useEffect(() => {
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managed.map((account) => `${account.id}:${account.alias}`).join(",")]);

  const groups = useMemo(() => {
    const visible = domains.filter((domain) => {
      if (platformFilter !== "all" && domain.platform !== platformFilter) return false;
      if (accountFilter !== "all" && String(domain.accountId) !== accountFilter) return false;
      if (!normalized) return true;
      return domain.name.toLowerCase().includes(normalized) || domain.accountAlias.toLowerCase().includes(normalized);
    });
    const map = new Map<number, { accountId: number; alias: string; platform: ManagedPlatformId; domains: UnifiedDomain[] }>();
    for (const account of managed) {
      if (platformFilter !== "all" && account.provider !== platformFilter) continue;
      if (accountFilter !== "all" && String(account.id) !== accountFilter) continue;
      map.set(account.id, { accountId: account.id, alias: account.alias, platform: account.provider, domains: [] });
    }
    for (const domain of visible) {
      const group = map.get(domain.accountId);
      if (group) group.domains.push(domain);
    }
    return Array.from(map.values());
  }, [domains, managed, platformFilter, accountFilter, normalized]);

  const totalShown = groups.reduce((sum, group) => sum + group.domains.length, 0);
  const errorByAccount = useMemo(() => new Map(errors.map((error) => [error.accountId, error])), [errors]);

  const loadRecords = async (domain: UnifiedDomain) => {
    setRecordsLoading(true);
    setRecordsError("");
    setSelected(new Set());
    try {
      const res = await apiFetch(`/api/unified/records/${domain.accountId}/${encodeURIComponent(domain.id)}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.message || "读取解析记录失败");
      setRecords((data.records || []) as UnifiedRecord[]);
    } catch (error) {
      setRecords([]);
      setRecordsError(error instanceof Error ? error.message : "读取解析记录失败");
    } finally {
      setRecordsLoading(false);
    }
  };

  const openDomain = (domain: UnifiedDomain) => {
    setActiveDomain(domain);
    setDraft(null);
    void loadRecords(domain);
  };

  const saveRecord = async () => {
    if (!activeDomain || !draft) return;
    if (!draft.type.trim() || !draft.content.trim()) {
      onToast("error", "记录类型与记录值不能为空");
      return;
    }
    setSaving(true);
    try {
      // GLEAM 的服务端契约只有 type + content；主机名固定为已认领子域名，
      // TTL 由服务商决定，多传字段会被上游拒绝，因此按平台裁剪请求体。
      const body = JSON.stringify(activeDomain.platform === "gleam"
        ? { type: draft.type.trim().toUpperCase(), content: draft.content.trim() }
        : {
            name: draft.name.trim() || "@",
            type: draft.type.trim().toUpperCase(),
            content: draft.content.trim(),
            ttl: Number(draft.ttl) > 0 ? Number(draft.ttl) : 600,
            line: draft.line.trim() || undefined,
            priority: draft.priority.trim() === "" ? undefined : Number(draft.priority),
          });
      const base = `/api/unified/records/${activeDomain.accountId}/${encodeURIComponent(activeDomain.id)}`;
      const res = await apiFetch(draft.id ? `${base}/${encodeURIComponent(draft.id)}` : base, {
        method: draft.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || "保存解析记录失败");
      onToast("success", draft.id ? "解析记录已更新" : "解析记录已创建");
      setDraft(null);
      await loadRecords(activeDomain);
      void load(true);
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "保存解析记录失败");
    } finally {
      setSaving(false);
    }
  };

  const deleteRecord = async (record: UnifiedRecord) => {
    if (!activeDomain) return;
    if (!window.confirm(`删除解析记录 ${record.name} ${record.type} → ${record.value}？`)) return;
    try {
      const res = await apiFetch(`/api/unified/records/${activeDomain.accountId}/${encodeURIComponent(activeDomain.id)}/${encodeURIComponent(record.id)}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || "删除解析记录失败");
      onToast("success", "解析记录已删除");
      await loadRecords(activeDomain);
      void load(true);
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "删除解析记录失败");
    }
  };

  const runBatch = async (operation: "delete" | "status" | "ttl" | "line", value?: string | number | boolean) => {
    if (!activeDomain || selected.size === 0) return;
    if (operation === "delete" && !window.confirm(`删除选中的 ${selected.size} 条解析记录？`)) return;
    setBatchBusy(true);
    try {
      const res = await apiFetch("/api/unified/records/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: activeDomain.accountId,
          domain_id: activeDomain.id,
          operation,
          ids: Array.from(selected),
          value,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || "批量操作失败");
      onToast("success", `批量操作完成：${data.count ?? selected.size} 条`);
      await loadRecords(activeDomain);
      void load(true);
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "批量操作失败");
    } finally {
      setBatchBusy(false);
    }
  };

  const checkAccount = async (accountId: number) => {
    setChecking(accountId);
    try {
      const res = await apiFetch(`/api/accounts/${accountId}/check`, { method: "POST" });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || "连接检测失败");
      onToast("success", `连接正常：${data.alias || "账号"}`);
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "连接检测失败");
    } finally {
      setChecking(null);
    }
  };

  const capabilities = activeDomain ? capabilityOf(activeDomain.platform) : [];
  const canCreate = capabilities.includes("records.create");
  const canUpdate = capabilities.includes("records.update");
  const canDelete = capabilities.includes("records.delete");
  const canBatch = capabilities.includes("records.batch");
  const draftPlatform = activeDomain?.platform;

  return (
    <section className="space-y-4" aria-label="DNSNEKO 与 GLEAM 平台资产">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold tracking-tight text-content-primary">平台实时资产</h3>
          <p className="text-xs text-content-muted mt-0.5">DNSNEKO / GLEAM 直接读取上游，不写入本地快照</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading || managed.length === 0}
          className="h-9 px-3 rounded border border-border-base bg-elevated hover:bg-hovered text-content-secondary text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          {loaded ? "刷新实时资产" : "读取平台资产"}
        </button>
      </div>

      {managed.length === 0 ? (
        <p className="p-4 rounded border border-dashed border-border-base text-xs text-content-muted">
          尚未绑定 DNSNEKO 或 GLEAM 账号。
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={platformFilter}
            onChange={(event) => { setPlatformFilter(event.target.value as "all" | ManagedPlatformId); setAccountFilter("all"); }}
            aria-label="按平台筛选"
            className="form-input px-3 h-9 rounded text-xs text-content-secondary"
          >
            <option value="all">全部平台</option>
            <option value="dnsneko">DNSNEKO</option>
            <option value="gleam">GLEAM</option>
          </select>
          <select
            value={accountFilter}
            onChange={(event) => setAccountFilter(event.target.value)}
            aria-label="按账号筛选"
            className="form-input px-3 h-9 rounded text-xs text-content-secondary max-w-[16rem]"
          >
            <option value="all">全部账号</option>
            {managed.filter((account) => platformFilter === "all" || account.provider === platformFilter).map((account) => (
              <option key={account.id} value={String(account.id)}>{account.alias}</option>
            ))}
          </select>
          <span className="text-[11px] text-content-muted font-mono">
            {loading ? "读取中…" : `${totalShown} 个域名 · ${groups.length} 个账号`}
          </span>
        </div>
      )}

      {groups.map((group) => {
        const key = String(group.accountId);
        const isCollapsed = collapsed.has(key);
        const failure = errorByAccount.get(group.accountId);
        return (
          <div key={key} className="bg-surface border border-border-base rounded">
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 sm:px-4 py-2.5 border-b border-border-base">
              <button
                type="button"
                onClick={() => setCollapsed((previous) => {
                  const next = new Set(previous);
                  if (next.has(key)) next.delete(key); else next.add(key);
                  return next;
                })}
                aria-expanded={!isCollapsed}
                className="flex items-center gap-1.5 min-w-0 text-left"
              >
                <ChevronDown className={`w-3.5 h-3.5 text-content-muted transition-transform ${isCollapsed ? "-rotate-90" : ""}`} />
                <span className="text-sm font-semibold text-content-primary truncate">{group.alias}</span>
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border border-border-base text-content-muted flex-shrink-0">{PLATFORM_LABEL[group.platform]}</span>
              </button>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-[11px] text-content-muted font-mono">{group.domains.length} 个</span>
                <button
                  type="button"
                  onClick={() => void checkAccount(group.accountId)}
                  disabled={checking === group.accountId}
                  className="text-[11px] font-semibold px-2 py-1 rounded border border-border-base text-content-secondary hover:bg-hovered disabled:opacity-50"
                >
                  {checking === group.accountId ? "检测中…" : "检测连接"}
                </button>
              </div>
            </div>
            {!isCollapsed && (
              <div>
                {failure && <p className="px-4 py-3 text-xs text-amber-700 dark:text-amber-400 break-all">{failure.message}</p>}
                {group.domains.length === 0 ? (
                  <p className="px-4 py-4 text-xs text-content-muted">{failure ? "该账号本次未返回域名。" : "该账号下暂无域名。"}</p>
                ) : (
                  <div className="divide-y divide-border-soft">
                    {group.domains.map((domain) => (
                      <div key={`${domain.platform}:${domain.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 sm:px-4 py-2.5">
                        <span className="font-mono text-sm text-content-primary break-all flex-1 min-w-[10rem]">{domain.name}</span>
                        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${domain.expired ? "border-rose-200 text-rose-600 dark:border-rose-900/60 dark:text-rose-400" : "border-border-base text-content-secondary"}`}>
                          {statusText(domain)}
                        </span>
                        <span className="text-[11px] text-content-muted whitespace-nowrap">记录 {domain.recordCount ?? "—"}</span>
                        <span className="text-[11px] text-content-muted whitespace-nowrap">到期 {formatDate(domain.expiresAt)}</span>
                        <button
                          type="button"
                          onClick={() => openDomain(domain)}
                          className="text-[11px] font-semibold px-2.5 py-1 rounded border border-border-base text-content-secondary hover:bg-hovered whitespace-nowrap"
                        >
                          管理解析
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {activeDomain && (
        <div role="dialog" aria-modal="true" data-app-modal="unified-dns" className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/55 backdrop-blur-[2px]">
          <div className="bg-surface border border-border-base w-full max-w-5xl max-h-[90dvh] rounded overflow-hidden flex flex-col shadow-sm">
            <div className="flex items-start justify-between gap-3 px-4 sm:px-6 py-4 border-b border-border-base bg-elevated flex-shrink-0">
              <div className="min-w-0">
                <h3 className="text-base sm:text-lg font-bold text-content-primary truncate">{activeDomain.name}</h3>
                <p className="text-[11px] text-content-muted mt-0.5 font-mono break-all">
                  {PLATFORM_LABEL[activeDomain.platform]} · {activeDomain.accountAlias} · {records.length} 条记录
                </p>
              </div>
              <button type="button" onClick={() => { setActiveDomain(null); setDraft(null); }} aria-label="关闭" className="p-2 rounded text-content-muted hover:text-content-primary hover:bg-hovered">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 sm:p-6 space-y-4 overflow-y-auto flex-1">
              {recordsError && <p className="text-xs text-rose-600 dark:text-rose-400 break-all">{recordsError}</p>}
              {recordsLoading ? (
                <div className="flex items-center justify-center py-10 text-content-muted text-sm gap-2"><RefreshCw className="w-4 h-4 animate-spin" /> 读取解析记录…</div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    {canCreate && (
                      <button type="button" onClick={() => activeDomain && setDraft(draftFor(activeDomain.platform))} className="h-9 px-3 rounded bg-primary text-primary-fg text-xs font-semibold inline-flex items-center gap-1.5">
                        <Plus className="w-3.5 h-3.5" /> 新增记录
                      </button>
                    )}
                    {!canBatch && records.length > 0 && (
                      <span className="text-[11px] text-content-muted">该平台不支持服务端批量操作，请逐条处理。</span>
                    )}
                    {canBatch && selected.size > 0 && (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[11px] text-content-muted">已选 {selected.size} 条</span>
                        <button type="button" disabled={batchBusy} onClick={() => void runBatch("delete")} className="h-8 px-2.5 rounded border border-rose-200 text-rose-600 text-[11px] font-semibold dark:border-rose-900/60 dark:text-rose-400 disabled:opacity-50">批量删除</button>
                        <button type="button" disabled={batchBusy} onClick={() => void runBatch("status", true)} className="h-8 px-2.5 rounded border border-border-base text-[11px] font-semibold text-content-secondary disabled:opacity-50">启用</button>
                        <button type="button" disabled={batchBusy} onClick={() => void runBatch("status", false)} className="h-8 px-2.5 rounded border border-border-base text-[11px] font-semibold text-content-secondary disabled:opacity-50">暂停</button>
                        <input value={batchValue} onChange={(event) => setBatchValue(event.target.value)} placeholder="TTL / 线路" className="form-input h-8 px-2 rounded text-[11px] w-28" />
                        <button type="button" disabled={batchBusy || !batchValue.trim()} onClick={() => void runBatch(/^\d+$/.test(batchValue.trim()) ? "ttl" : "line", /^\d+$/.test(batchValue.trim()) ? Number(batchValue.trim()) : batchValue.trim())} className="h-8 px-2.5 rounded border border-border-base text-[11px] font-semibold text-content-secondary disabled:opacity-50">
                          {/^\d+$/.test(batchValue.trim()) ? "改 TTL" : "改线路"}
                        </button>
                      </div>
                    )}
                  </div>

                  {draft && (
                    <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 p-3 border border-border-base rounded bg-elevated">
                      <label className="col-span-1 text-[10px] font-semibold text-content-muted">类型
                        {recordTypesOf(draftPlatform).length > 0 ? (
                          <select
                            value={draft.type}
                            onChange={(event) => setDraft({ ...draft, type: event.target.value })}
                            disabled={Boolean(draft.id)}
                            title={draft.id ? `${PLATFORM_LABEL[draftPlatform as ManagedPlatformId]} 记录创建后不可更改类型` : undefined}
                            className="mt-1 form-input w-full h-8 px-2 rounded text-xs uppercase disabled:opacity-60"
                          >
                            {recordTypesOf(draftPlatform).map((type) => <option key={type} value={type}>{type}</option>)}
                          </select>
                        ) : (
                          <input value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value })} className="mt-1 form-input w-full h-8 px-2 rounded text-xs uppercase" />
                        )}
                      </label>
                      {draftPlatform === "dnsneko" && (
                        <label className="col-span-1 text-[10px] font-semibold text-content-muted">主机
                          <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className="mt-1 form-input w-full h-8 px-2 rounded text-xs" />
                        </label>
                      )}
                      <label className="col-span-2 sm:col-span-2 text-[10px] font-semibold text-content-muted">记录值
                        <input value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} className="mt-1 form-input w-full h-8 px-2 rounded text-xs font-mono" />
                      </label>
                      {draftPlatform === "dnsneko" && (
                        <label className="col-span-1 text-[10px] font-semibold text-content-muted">TTL
                          <input value={draft.ttl} onChange={(event) => setDraft({ ...draft, ttl: event.target.value })} inputMode="numeric" className="mt-1 form-input w-full h-8 px-2 rounded text-xs" />
                        </label>
                      )}
                      {draftPlatform === "dnsneko" && (
                        <label className="col-span-1 text-[10px] font-semibold text-content-muted">线路
                          <input value={draft.line} onChange={(event) => setDraft({ ...draft, line: event.target.value })} className="mt-1 form-input w-full h-8 px-2 rounded text-xs" />
                        </label>
                      )}
                      {draftPlatform === "gleam" && (
                        <p className="col-span-2 sm:col-span-4 self-end text-[10px] text-content-muted leading-relaxed">
                          GLEAM 由服务商自动决定 TTL，主机名固定为已认领的子域名，记录类型创建后不可更改。
                        </p>
                      )}
                      <div className="col-span-2 sm:col-span-6 flex items-center justify-end gap-2">
                        <button type="button" onClick={() => setDraft(null)} className="h-8 px-3 rounded border border-border-base text-xs text-content-secondary">取消</button>
                        <button type="button" onClick={() => void saveRecord()} disabled={saving} className="h-8 px-3 rounded bg-primary text-primary-fg text-xs font-semibold disabled:opacity-50">{saving ? "保存中…" : draft.id ? "保存修改" : "创建记录"}</button>
                      </div>
                    </div>
                  )}

                  {records.length === 0 ? (
                    <p className="py-8 text-center text-sm text-content-muted">该域名下暂无解析记录。</p>
                  ) : (
                    <>
                      <div className="hidden md:block overflow-x-auto border border-border-base rounded">
                        <table className="w-full text-xs">
                          <thead className="bg-elevated text-content-muted">
                            <tr>
                              {canBatch && <th className="w-8 px-2 py-2"><input type="checkbox" aria-label="全选记录" checked={selected.size === records.length && records.length > 0} onChange={() => setSelected(selected.size === records.length ? new Set() : new Set(records.map((record) => record.id)))} className="accent-primary" /></th>}
                              <th className="text-left font-semibold px-3 py-2">类型</th>
                              <th className="text-left font-semibold px-3 py-2">主机</th>
                              <th className="text-left font-semibold px-3 py-2">记录值</th>
                              <th className="text-left font-semibold px-3 py-2">线路</th>
                              <th className="text-left font-semibold px-3 py-2">TTL</th>
                              <th className="text-left font-semibold px-3 py-2">状态</th>
                              <th className="text-right font-semibold px-3 py-2">操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {records.map((record) => (
                              <tr key={record.id} className="border-t border-border-soft">
                                {canBatch && <td className="px-2 py-2"><input type="checkbox" aria-label={`选择 ${record.name}`} checked={selected.has(record.id)} onChange={() => setSelected((previous) => { const next = new Set(previous); if (next.has(record.id)) next.delete(record.id); else next.add(record.id); return next; })} className="accent-primary" /></td>}
                                <td className="px-3 py-2 font-mono font-bold text-primary">{record.type}</td>
                                <td className="px-3 py-2 font-mono text-content-primary">{record.name}</td>
                                <td className="px-3 py-2 font-mono text-content-secondary break-all max-w-[22rem]">{record.value}</td>
                                <td className="px-3 py-2 text-content-muted">{record.line || "—"}</td>
                                <td className="px-3 py-2 font-mono text-content-muted">{record.ttl}</td>
                                <td className="px-3 py-2"><span className={record.status === "active" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>{record.status === "active" ? "启用" : "暂停"}</span></td>
                                <td className="px-3 py-2 text-right whitespace-nowrap">
                                  {canUpdate && <button type="button" onClick={() => setDraft({ id: record.id, name: record.name, type: record.type, content: record.value, ttl: String(record.ttl), line: record.line || "default", priority: record.priority === null ? "" : String(record.priority) })} className="text-primary hover:underline font-semibold px-1.5">编辑</button>}
                                  {canDelete && <button type="button" onClick={() => void deleteRecord(record)} className="text-rose-600 dark:text-rose-400 hover:underline font-semibold px-1.5" aria-label={`删除 ${record.name}`}><Trash2 className="w-3.5 h-3.5 inline" /></button>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="md:hidden space-y-2">
                        {records.map((record) => (
                          <div key={record.id} className="border border-border-base rounded p-3 space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono text-xs font-bold text-primary">{record.type} · {record.name}</span>
                              <span className={`text-[11px] ${record.status === "active" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>{record.status === "active" ? "启用" : "暂停"}</span>
                            </div>
                            <p className="font-mono text-xs text-content-secondary break-all">{record.value}</p>
                            <p className="text-[11px] text-content-muted font-mono">TTL {record.ttl}{record.line ? ` · ${record.line}` : ""}</p>
                            <div className="flex items-center gap-3 pt-1">
                              {canUpdate && <button type="button" onClick={() => setDraft({ id: record.id, name: record.name, type: record.type, content: record.value, ttl: String(record.ttl), line: record.line || "default", priority: record.priority === null ? "" : String(record.priority) })} className="text-[11px] font-semibold text-primary">编辑</button>}
                              {canDelete && <button type="button" onClick={() => void deleteRecord(record)} className="text-[11px] font-semibold text-rose-600 dark:text-rose-400">删除</button>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
            <div className="px-4 sm:px-6 py-3 border-t border-border-base bg-surface flex items-center justify-between gap-2 flex-shrink-0">
              <span className="text-[10px] text-content-muted">能力来源：平台注册表；不支持的操作不会显示按钮。</span>
              <button type="button" onClick={() => void loadRecords(activeDomain)} className="text-[11px] font-semibold text-content-secondary hover:text-content-primary">重新读取</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
