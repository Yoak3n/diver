// OneBot 设置页状态：归属实例、运行态、连接状态轮询、configDecl 表单。
// 组合式函数在 SlotBoundary 的 setup 中调用，onBeforeUnmount 绑到该实例。

import { onBeforeUnmount, reactive, watch } from "vue";
import {
  buildPluginConfigValues,
  draftFromView,
  type ClientServices,
  type InstanceRow,
  type OnebotStatus,
  type PluginConfigDraft,
  type PluginConfigView,
} from "@diver/plugin-ui";
import { describeStatus, type StatusView } from "./status";

const STATUS_POLL_MS = 3000;

export interface OnebotPanelState {
  instances: readonly InstanceRow[];
  owner: string | null;
  ownerPick: string;
  runningIds: ReadonlySet<string>;
  notice: string;
  error: string;
  status: StatusView;
  statusBusy: boolean;
  config: PluginConfigView | null;
  draft: PluginConfigDraft;
  busy: boolean;
  cfgError: string;
  cfgNotice: string;
  pickOwner(): Promise<void>;
  reload(): Promise<void>;
  refreshStatus(): Promise<void>;
  save(): Promise<void>;
}

export function createOnebotPanel(ctx: ClientServices): OnebotPanelState {
  const state = reactive<OnebotPanelState>({
    instances: [],
    owner: ctx.instances.onebotOwner.value,
    ownerPick: ctx.instances.onebotOwner.value ?? "",
    runningIds: new Set(),
    notice: "",
    error: "",
    status: describeStatus({
      owner: null,
      ownerRunning: false,
      status: null,
      error: "",
    }),
    statusBusy: false,
    config: null,
    draft: {},
    busy: false,
    cfgError: "",
    cfgNotice: "",
    pickOwner,
    reload,
    refreshStatus,
    save,
  });

  let timer: number | undefined;

  function startPoll(): void {
    stopPoll();
    if (state.owner === null || !state.runningIds.has(state.owner)) return;
    timer = window.setInterval(() => {
      void refreshStatus();
    }, STATUS_POLL_MS);
  }

  function stopPoll(): void {
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
  }

  async function refreshStatus(): Promise<void> {
    const owner = state.owner;
    if (owner === null || !state.runningIds.has(owner)) {
      state.status = describeStatus({
        owner,
        ownerRunning: false,
        status: null,
        error: "",
      });
      state.statusBusy = false;
      return;
    }
    state.statusBusy = true;
    try {
      const status: OnebotStatus = await ctx.api.onebotStatus(owner);
      state.status = describeStatus({
        owner,
        ownerRunning: true,
        status,
        error: "",
      });
    } catch (err) {
      state.status = describeStatus({
        owner,
        ownerRunning: true,
        status: null,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      state.statusBusy = false;
    }
  }

  async function loadConfig(): Promise<void> {
    state.config = null;
    state.draft = {};
    state.cfgError = "";
    state.cfgNotice = "";
    const owner = state.owner;
    if (owner === null || !state.runningIds.has(owner)) return;
    state.busy = true;
    try {
      const res = await ctx.api.listPluginConfigs(owner);
      const view = res.plugins.find((plugin) => plugin.id === "onebot") ?? null;
      if (view === null || view.fields.length === 0) {
        state.cfgError = "该实例未暴露 OneBot 配置（插件可能已停用）";
        return;
      }
      state.config = view;
      state.draft = draftFromView(view);
    } catch (err) {
      state.cfgError = err instanceof Error ? err.message : String(err);
    } finally {
      state.busy = false;
    }
  }

  async function save(): Promise<void> {
    const view = state.config;
    const owner = state.owner;
    if (view === null || owner === null) return;
    state.busy = true;
    state.cfgError = "";
    state.cfgNotice = "";
    try {
      await ctx.api.savePluginConfig(
        "onebot",
        buildPluginConfigValues(view.fields, state.draft),
        owner,
      );
      state.cfgNotice = `配置已保存到实例 ${owner}，重启应用后生效`;
    } catch (err) {
      state.cfgError = err instanceof Error ? err.message : String(err);
    } finally {
      state.busy = false;
    }
  }

  async function pickOwner(): Promise<void> {
    const next = state.ownerPick === "" ? null : state.ownerPick;
    if (next === state.owner) return;
    await ctx.instances.setOnebotOwner(next);
    await reload();
  }

  async function reload(): Promise<void> {
    await ctx.instances.refresh();
    state.owner = ctx.instances.onebotOwner.value;
    state.ownerPick = state.owner ?? "";
    state.instances = ctx.instances.rows.value;
    state.runningIds = ctx.instances.runningIds.value;
    state.notice = ctx.instances.notice.value;
    state.error = ctx.instances.error.value;
    await Promise.all([loadConfig(), refreshStatus()]);
    startPoll();
  }

  watch(
    () => ctx.instances.rows.value,
    (rows) => {
      state.instances = rows;
    },
  );
  watch(
    () => ctx.instances.runningIds.value,
    (ids) => {
      state.runningIds = ids;
      startPoll();
    },
  );
  onBeforeUnmount(stopPoll);

  void reload();
  return state;
}
