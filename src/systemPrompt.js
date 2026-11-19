// 系统提示注入：捕获生词工作流硬规则（筛选/制卡方法论在 seekword 技能里）。
export const SYSTEM_RULES = `## 捕获生词（seekword）

用户要「预习生词 / 生词卡片 / 闪卡 / 用字幕学语言 / 单词本 / 捕获生词」时：

**流程**：seekword(action="capture") 捕获原文（text 粘贴 / youtube 字幕 / file 字幕文件 / web 网页）→ action="read" 分段读原文 → 按 seekword 技能的筛选规则挑高价值生词 → action="save_candidates" 入库（面板「学习」页可见，用户勾选）→ 对选定词按技能制卡规则生成卡片 → action="save_cards"（selected 传用户选定的词）。

**硬规则**：
- 生词筛选与卡片生成由你按 seekword 技能完成（创作归你，工具只管捕获/存储/校验/导出）；term 必须是原文表面形式，宁缺毋滥。
- 长原文必须分段 read 完整读完再筛选，不要只看 capture 回执里的预览。
- save_cards 回执的 warnings（未命中原文/缺释义等）如实告知用户，不隐瞒。
- 卡片清单按技能输出规则呈现（表格 + 面板学习指引 + 页脚逐字附带）；释义/例句与入库内容逐字一致。
- 删除内容、导出 CSV、查单词本都要先确认对象（list / wordbook），删除类操作先跟用户确认。`

export function systemSection() {
  return {
    name: 'seekword:workflow',
    order: 110,
    text: SYSTEM_RULES,
  }
}
