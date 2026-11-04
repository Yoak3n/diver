// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { defineComponent, provide } from "vue";
import { mount } from "@vue/test-utils";
import { SLOT_REGISTRY_KEY } from "../injection";
import { SlotRegistry } from "../slots/registry";
import SlotOutlet from "./SlotOutlet.vue";

const A = defineComponent({ template: "<div>AAA</div>" });
const B = defineComponent({ template: "<div>BBB</div>" });

describe("SlotOutlet", () => {
  it("渲染 list 条目并按 only 过滤", () => {
    const registry = new SlotRegistry();
    registry.declare("settings.tab");
    registry.register({ name: "settings.tab", id: "a" }, A);
    registry.register({ name: "settings.tab", id: "b" }, B);
    const Wrapper = defineComponent({
      components: { SlotOutlet },
      setup() {
        provide(SLOT_REGISTRY_KEY, registry);
      },
      template: `<SlotOutlet name="settings.tab" :owner="{}" only="a" />`,
    });
    const wrapper = mount(Wrapper);
    expect(wrapper.text()).toContain("AAA");
    expect(wrapper.text()).not.toContain("BBB");
  });
});
