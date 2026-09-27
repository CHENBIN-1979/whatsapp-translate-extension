# WhatsApp 实时翻译扩展（中印互译）

Chrome 扩展：WhatsApp 网页版消息实时翻译，**印尼语 ↔ 中文** 双向。
- 收到的外语消息 → 气泡下方插入**中文**译文
- 自己发出的中文 → 气泡下方插入**印尼语**译文（方便对方核对）
- 输入框右下角「译」按钮 → 把你打好的中文**直接替换进输入框**变成印尼语（再点一次还原原文），不自动发送
- 翻译走 **OpenAI 兼容的 LLM API**（Base URL / Key / Model 全部在设置页填，支持任何兼容服务商）
- 本地缓存去重：重复消息不重复计费

## 安装（3 分钟）

1. 把本文件夹整个复制到你要用的电脑上（不要解压到临时目录）。
2. Chrome 地址栏输入 `chrome://extensions`，打开右上角**开发者模式**。
3. 点**加载已解压的扩展程序**，选择本文件夹。
4. 工具栏出现蓝色「文A」图标即安装成功。

## 配置

1. 点工具栏图标，填写：
   - **API Base URL**：默认 `https://api.scnet.cn/api/llm/v1`（已内置，不用改）
   - **API Key**：你的 key（只存在本机浏览器 `chrome.storage.local`，不上传）
   - **模型**：默认 `Qwen3.8-Flash`（scnet 上实测可用）；换模型名须是所选 Base URL 服务支持的、支持 chat/completions 的任意模型
2. 点**测试连接** —— 显示「✔ 连接成功」才继续。
3. 打开 [web.whatsapp.com](https://web.whatsapp.com) 扫码登录，聊天里的消息下方会出现「译」色块。
4. 「启用自动翻译」开关可随时全局停用（气泡下方已显示的译文保留）。

## 工作原理 / 目录

| 文件 | 职责 |
|---|---|
| `manifest.json` | MV3 清单；权限仅 `storage` + 翻译 API 域名的 fetch 能力 |
| `background.js` | service worker：攒批(350ms 窗口)→ 调 LLM → 缓存(LRU 2000 条)；批量失败自动逐条降级重试 |
| `content.js` | 页面扫描（MutationObserver + 2s 兜底轮询）、译文行注入、输入框反向翻译按钮 |
| `content.css` | 注入样式（收=蓝色系 / 发=绿色系，失败=粉红可点击重试） |
| `popup.html/js` | 设置页：填 key、测试连接、开关、清缓存 |

## WhatsApp 改版后失效怎么办

WhatsApp 前端类名是混淆的、会定期变。v1.1.2 起扫描器自带三层防线：
1. **扫描根自动回退**：`#main` → `role="application"` → `body`（自动排除侧栏/标题/输入区）——实测 2026 版 WhatsApp 中 `#main` 存在但聊天区不在其内部，旧版在此直接扫 0 条。
2. **选择器阶梯**：`[data-id]` 气泡（跨版本稳定属性，`true_/false_` 前缀自带收发方向）∪ 旧版 `copyable-text/selectable-text` → 结构特征 `span[dir="auto"]` 兜底。
3. **popup「诊断」按钮**：显示扫描根/策略/命中数/失败数/DOM 锚点统计/首个气泡 HTML 样本。**不翻译时先点诊断**，把结果截图发给维护者即可定位，无需猜。

若仍失效：F12 控制台看 `[wTranslate]` 报错；诊断里 `sample` 字段就是真实消息节点的 HTML，按它的结构在 `content.js` 的 `SCAN` 段加一条选择器即可。

## 常见问题

**译文一直显示「翻译中…」不出结果？** v1.1.3 已修复三大成因：
批量一次塞太多条（现在自动按 12 条/组切分并发）、后台批量失败后串行逐条重试（现在并行 3 路、单条 12s 超时）、响应通道丢失（现在 90s 兜底显示「点击重试」）。
若仍出现：等 1~2 分钟（首次大批量），或点击「⚠ 翻译失败（点击重试）」行手动重试；也可把模型换成响应更快的（如非思考模式的轻量模型）。

- **所有气泡显示 ⚠ 未配置 API Key**：先点扩展图标保存配置。
- **⚠ 401/403/429**：key 无效 / 欠费 / 限流。换 key 或稍后自动重试（点失败行重试）。
- **输出被模型带上了多余解释**：极少见；把 temperature 调到 0 或在系统提示词（`background.js` 的 `SYSTEM_PROMPT`）里再加一条硬约束。
- **想同时给英文/印尼文都翻**：当前自动判定为「含中文→印尼语，否则→中文」；改 `detectTarget()` 即可扩展。
- **隐私**：仅消息文本发往你配置的 API 服务商，与 WhatsApp 官方无关；WhatsApp 账号、聊天列表一概不读取。
- **host 权限已收紧为 `https://api.scnet.cn/*`**：默认服务商写死在扩展里，弹窗里改 Base URL 只能填 api.scnet.cn 域名的地址。若要换其他服务商（如 OpenAI），需自己在 `manifest.json` 的 `host_permissions` 里加上对应域名再重新加载扩展。

## 版本更新记录

- 各版本简短更新/修复条目 + 安装包归档：[Releases 页面](https://github.com/CHENBIN-1979/whatsapp-translate-extension/releases)（v1.1.4 → v1.1.21 逐版本）
- 根因说明与实测细节（"为什么这么改"）：[CHANGELOG.md](CHANGELOG.md)
