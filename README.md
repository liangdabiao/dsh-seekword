# 捕获生词 dsh-seekword

> 先学再看（Pre-exposure）：从任意语言内容里先捕获高价值生词、生成学习卡片，再带着上下文去阅读/观看——学得更快、记得更牢。
> 移植自 Chrome 扩展 [SeekWord](https://github.com/liangdabiao/SeekWord)（CaptiPrep 分支）为 dsh 插件。

## 安装

```bash
dsh plugin --profile web add https://github.com/liangdabiao/dsh-seekword
```

## 能做什么

**面板主入口（v0.2.0）**：概览页四渠道导入区 → 每个材料常驻「下一步」执行按钮，全程不用自己想提示词：

```
导入内容（📁选择文件 / 粘贴文本 / YouTube / 网页）
   ↓ ① 分析生词（面板按钮 → 指令草稿填进新对话，agent 按技能筛选候选）
② 选词制卡（候选回到面板勾选 → 点按钮交给 agent 制卡）
   ↓ ③ 卡片入库自动刷新 → 闪卡学习（←/→ 切换 · 空格收藏 · 🔊 朗读）
```

点执行按钮后面板每 2 秒轻量轮询，agent 入库即自动刷新视图；「选择文件」在桌面端直接取本地路径交给工具，浏览器里自动降级为读内容导入。

1. **多来源捕获**（`seekword` 工具 `action="capture"`）
   - **粘贴文本**：任意语言的文章/字幕/段落（最常用）
   - **YouTube 字幕**：给视频链接或 videoId，自动多客户端降级抓取（IOS → ANDROID_VR → MWEB InnerTube + timedtext json3/srv3/vtt + get_transcript 兜底，带诊断信息）；国内网络可在面板设置代理
   - **本地字幕文件**：`txt / md / srt / vtt / json3`
   - **网页文章**：http(s) 链接自动提取正文（剥 script/nav/footer）
2. **智能筛选**（agent 按 seekword 技能执行）：教学价值排序、语言门控、停用词排除、表面形式约束、证据校验——只挑真正值得学的新词/难词/习语/搭配
3. **学习卡片生成**（agent 按技能规则）：发音（英语美/英双音标、日语假名+音调、汉语拼音、韩语 RR、俄法德西 IPA）、词性、贴合原文语境的释义、两组双语例句、语法备注
4. **侧栏面板「捕获生词」**
   - **概览**：四渠道导入区（文件/粘贴/YouTube/网页）+ 材料列表（状态徽章与下一步执行按钮）
   - **学习**：材料状态机（①分析生词 → ②选词制卡 → ③闪卡）、键盘导航（←/→ 切换、空格收藏）、🔊 浏览器本地语音朗读、网格视图
   - **单词本**：全部卡片、来源过滤、搜索、收藏、导出 CSV（带 BOM，Excel 直接打开不乱码）
   - **设置**：释义语言（9 种）、英语口音（美/英）、候选词上限、抓取代理

## 与 Chrome 扩展版的关系

| 能力 | SeekWord 扩展 | dsh-seekword |
|---|---|---|
| 生词筛选/制卡 | 扩展内调 LLM API（双模型角色） | 对话 agent 按技能完成（创作归 LLM+技能，工具只做捕获/存储/机械校验） |
| YouTube 字幕 | 页面主世界注入 + pot 拦截 | Node 多客户端 InnerTube 降级 + 可选代理 |
| 朗读 | Edge TTS REST + Web Speech 兜底 | 浏览器本地语音（Web Speech，无需任何 key） |
| 单词本 | 扩展独立标签页 | dsh 侧栏面板（学习/单词本/概览/设置） |
| 机械校验 | 后处理管线 | 同款移植：IPA 语言规则强制、POS 中文映射、例句两行规范化、证据核对（只 warn 不阻塞） |

## 大模型

无独立 API Key——筛选与制卡由 dsh 会话里的 agent（按 `seekword` 技能）完成，零额外配置、零额外费用。

## 开发

```bash
npm install
npm run build   # 打包 client.js → dist/
npm test        # 单元测试（21 项）
npm run smoke   # 离线冒烟：假 YouTube InnerTube + 假网页 + 工具直调 + 面板 API（47 项）
npm run dev     # 面板独立预览 http://127.0.0.1:5197/seekword/（DSH_HOME 隔离）
```

数据存于 `~/.dsh/seekword/`（`DSH_HOME` 可覆盖）：`contents/<id>/`（原文/候选/卡片）+ `favorites.json` + `settings.json` + `exports/*.csv`。

## 致谢

- 原项目：[SeekWord 捕获生词](https://github.com/liangdabiao/SeekWord)（继承自 [CaptiPrep](https://github.com/jeanchristophe13v/CaptiPrep)）
- YouTube 字幕方案参考：[youtube-caption-extractor](https://github.com/devhims/youtube-caption-extractor)、[read-frog](https://github.com/mengxi-ream/read-frog)

## License

MIT
