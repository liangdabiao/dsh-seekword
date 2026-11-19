# 捕获生词 dsh-seekword

> 先学再看（Pre-exposure）：从任意语言内容里先捕获高价值生词、生成学习卡片，再带着上下文去阅读/观看——学得更快、记得更牢。
> 移植自 Chrome 扩展 [SeekWord](https://github.com/liangdabiao/SeekWord)（CaptiPrep 分支）为 dsh 插件。

deepseek harness插件，学习英语单词：捕获英语生词 · AI 驱动的生词预习与闪卡学习 dsh 插件：多来源捕获（粘贴/YouTube 字幕/本地字幕/网页）→ agent 筛选制卡 → 单词本面板。移植自 SeekWord。
<img width="2103" height="1368" alt="image" src="https://github.com/user-attachments/assets/993c3b0e-4858-4b4c-b2ff-2b8a96759672" />
<img width="1629" height="1329" alt="image" src="https://github.com/user-attachments/assets/adf001f7-1de2-49c7-b496-e15573bbafea" />
<img width="1737" height="1374" alt="image" src="https://github.com/user-attachments/assets/bad72268-6d6d-4f70-8093-d6871dc46af1" />



## 安装

```bash
dsh plugin --profile web add https://github.com/liangdabiao/dsh-seekword
```

## 能做什么

**面板主入口（v0.2.1）**：概览页四渠道导入区 → 每个材料常驻「下一步」执行按钮，全程不用自己想提示词：

```
选文件 / 贴原文 / 填链接 → 点「分析」= 开新对话，把材料线索写进草稿交给 agent
   ↓ 点「发送」后 agent 自己干活：读文件 / 转格式 / 抓字幕 / 提取正文 → seekword capture 入库
① 分析生词（材料上没有候选时，面板按钮再给一条草稿：read 通读 → 筛词 → save_candidates）
② 选词制卡（候选回到面板勾选 → 点按钮交给 agent 制卡）
   ↓ ③ 卡片入库自动刷新 → 闪卡学习（释义/例句直接显示 · ←/→ 切换 · 空格收藏 · 🔊 朗读生词与英文例句）
```

**插件独立工作区**：点「分析」开的对话都落在 `<数据目录>/workspace`（侧栏工作区区名「捕获生词」），文件读取/转换产生的临时文件都在这里，不占用你其它工作区。设置页能看到该路径。

**面板不做入库、不读文件、不抓网页**：四个渠道只负责把路径/原文/链接交给 agent；每行只有一个输入框加一个「分析」按钮，没有多余字段和说明文字。交接后每 2 秒轮询，agent 一把材料入库，概览与学习页自动刷新。文件路径由宿主弹系统原生「打开文件」对话框取得（Windows 桌面支持，其他平台改为手填路径）；txt/md/srt/vtt/json3 由 agent 直接读，pdf/docx/epub 由 agent 自己转换。

1. **多来源捕获**（`seekword` 工具 `action="capture"`）
   - **粘贴文本**：任意语言的文章/字幕/段落（最常用）
   - **YouTube 字幕**：给视频链接或 videoId，自动多客户端降级抓取（IOS → ANDROID_VR → MWEB InnerTube + timedtext json3/srv3/vtt + get_transcript 兜底，带诊断信息）；国内网络可在面板设置代理
   - **本地字幕文件**：`txt / md / srt / vtt / json3`
   - **网页文章**：http(s) 链接自动提取正文（剥 script/nav/footer）
2. **智能筛选**（agent 按 seekword 技能执行）：教学价值排序、语言门控、停用词排除、表面形式约束、证据校验——只挑真正值得学的新词/难词/习语/搭配
3. **学习卡片生成**（agent 按技能规则）：发音（英语美/英双音标、日语假名+音调、汉语拼音、韩语 RR、俄法德西 IPA）、词性、贴合原文语境的释义、两组双语例句、语法备注
4. **侧栏面板「捕获生词」**
   - **概览**：四渠道导入区（文件/粘贴/YouTube/网页，点「分析」只负责交给 agent）+ 材料列表（状态徽章与下一步执行按钮）
   - **学习**：材料状态机（①分析生词 → ②选词制卡 → ③闪卡）；闪卡释义与例句直接显示在单词下方（不用点开）、生词与英文例句各有 🔊 朗读（edge-tts 微软语音，译文不读）、键盘 ←/→ 切换与空格收藏、「✓ 学会了」归档、网格视图
   - **朗读**：生词与英文例句走 edge-tts（宿主 python -m edge_tts 合成、mp3 本地缓存；需 `pip install edge-tts`，缺失时自动回退浏览器语音）；中文译文不朗读。
   - **单词本**：未学会的卡片、来源过滤、搜索、收藏、导出 CSV（带 BOM，Excel 直接打开不乱码）
   - **学会了**：闪卡上点「✓ 学会了」把词归档到这里——它从学习与单词本里消失，随时可「撤销」放回
   - **设置**：释义语言（9 种）、英语口音（美/英）、候选词上限、抓取代理

## 与 Chrome 扩展版的关系

| 能力 | SeekWord 扩展 | dsh-seekword |
|---|---|---|
| 生词筛选/制卡 | 扩展内调 LLM API（双模型角色） | 对话 agent 按技能完成（创作归 LLM+技能，工具只做捕获/存储/机械校验） |
| YouTube 字幕 | 页面主世界注入 + pot 拦截 | Node 多客户端 InnerTube 降级 + 可选代理 |
| 朗读 | Edge TTS REST + Web Speech 兜底 | 宿主 edge-tts（Python `edge_tts`，微软在线语音、无需 key，mp3 本地缓存）+ 浏览器语音兜底 |
| 单词本 | 扩展独立标签页 | dsh 侧栏面板（学习/单词本/概览/设置） |
| 机械校验 | 后处理管线 | 同款移植：IPA 语言规则强制、POS 中文映射、例句两行规范化、证据核对（只 warn 不阻塞） |

## 大模型

无独立 API Key——筛选与制卡由 dsh 会话里的 agent（按 `seekword` 技能）完成，零额外配置、零额外费用。

## 开发

```bash
npm install
npm run build   # 打包 client.js → dist/
npm test        # 单元测试（29 项）
npm run smoke   # 离线冒烟：假 YouTube InnerTube + 假网页 + 工具直调 + 面板 API（55 项）
npm run dev     # 面板独立预览 http://127.0.0.1:5197/seekword/（DSH_HOME 隔离）
```

数据存于 `~/.dsh/seekword/`（`DSH_HOME` 可覆盖）：`contents/<id>/`（原文/候选/卡片）+ `favorites.json` + `settings.json` + `exports/*.csv`。

## 致谢

- 社区支持： https://linux.do
- 原项目：[SeekWord 捕获生词](https://github.com/liangdabiao/SeekWord)（继承自 [CaptiPrep](https://github.com/jeanchristophe13v/CaptiPrep)）
- YouTube 字幕方案参考：[youtube-caption-extractor](https://github.com/devhims/youtube-caption-extractor)、[read-frog](https://github.com/mengxi-ream/read-frog)

## License

MIT
