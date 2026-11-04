<script setup lang="ts">
// 设置「插件」页 · profile 插件安装（按当前实例的 profile 目录，pnpm）。
import { Button, Input, SectionTitle } from "../../../plugin-ui";

const spec = defineModel<string>("spec", { required: true });

defineProps<{
  installBusy: boolean;
  activeProfile: string;
}>();

const emit = defineEmits<{
  install: [];
}>();
</script>

<template>
  <SectionTitle title="安装 profile 插件（P4）" />
  <div class="install-row">
    <Input
      v-model="spec"
      class="install-input"
      size="sm"
      type="text"
      placeholder="file:../../examples/hello-tool 或 npm 包名 / git URL"
      :disabled="installBusy || activeProfile !== 'companion'"
      @keyup.enter="emit('install')"
    />
    <Button
      size="sm"
      :disabled="installBusy || !spec.trim() || activeProfile !== 'companion'"
      @click="emit('install')"
    >
      {{ installBusy ? "安装中…" : "安装" }}
    </Button>
  </div>
  <p class="hint">
    安装进该实例的 <code>$COS_HOME/profiles/&lt;active&gt;</code>（pnpm）。internal
    （<code>@diver/*</code> / 随包 plugins）不可卸载，只能禁用。<br />
    安装依赖系统 <code>pnpm</code>（需自行安装并在 PATH 中；路径不同可用环境变量
    <code>DIVER_PNPM</code> 指定），缺失时报「pnpm 不可用」。
  </p>
</template>

<style scoped>
.install-row {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
}
.install-input {
  flex: 1;
}
</style>
