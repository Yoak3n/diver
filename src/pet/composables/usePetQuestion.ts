// 桌宠侧 ask_user_question 临时选择状态。

import { ref } from "vue";
import type { UserQuestion } from "../../types";

export function usePetQuestion(
  pendingQuestion: { value: { requestId: string; questions: UserQuestion[] } | null },
  submit: (answers: { id: string; selected: string[]; custom?: string }[]) => Promise<unknown>,
) {
  const qSelections = ref<Record<string, string[]>>({});
  const qCustoms = ref<Record<string, string>>({});

  function toggleQOption(qId: string, label: string, multiSelect?: boolean) {
    const cur = qSelections.value[qId] ?? [];
    qSelections.value[qId] = multiSelect
      ? cur.includes(label)
        ? cur.filter((l) => l !== label)
        : [...cur, label]
      : [label];
  }

  function answerPending() {
    const q = pendingQuestion.value;
    if (!q) return;
    const answers = q.questions.map((item) => {
      const a: { id: string; selected: string[]; custom?: string } = {
        id: item.id,
        selected: qSelections.value[item.id] ?? [],
      };
      const custom = (qCustoms.value[item.id] ?? "").trim();
      if (custom) a.custom = custom;
      return a;
    });
    void submit(answers);
  }

  return { qSelections, qCustoms, toggleQOption, answerPending };
}
