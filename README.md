# AI 实时翻译助手（Chrome 扩展）

> 开发者：**RexTian** · 微博 [@太乙真人](https://weibo.com/132666987) · 网站 [https://www.rextian.com](https://www.rextian.com)

接入 **Kimi（月之暗面）**、**豆包（火山方舟）**、**DeepSeek**、**智谱 GLM** 等 AI 大模型，以及**阿里云机器翻译**、**百度翻译开放平台**（均含免费额度），支持网页文字翻译与 YouTube 直播/视频实时翻译。

## 功能

| 功能 | 说明 |
| --- | --- |
| 划词翻译 | 选中网页文字，点击浮动「译」按钮，弹出面板上显示译文 |
| 整页双语翻译 | 一键翻译整页，译文以蓝色边框块显示在原文下方；再点一次还原 |
| 自动翻译 | 打开网页自动检测语言并翻译（已是目标语言则跳过）；无限滚动页面自动增量翻译新内容 |
| 显示模式 | 双语对照（原文+译文）或仅显示译文，随时切换 |
| 中英双语界面 | 扩展 UI 支持中文 / English，可跟随浏览器或手动切换 |
| 多平台切换 | 弹窗中一键切换翻译平台，某个平台失效时可立即切换备用 |
| YouTube 字幕翻译 | 自动捕获视频/直播的 CC 字幕，译文浮层显示在播放器内 |
| 直播实时翻译（音频） | 捕获标签页音频 → 语音识别 → AI 翻译，实时字幕浮窗显示（可拖拽、支持全屏），原视频声音正常播放 |
| 右键菜单 | 右键可翻译选中内容或整个网页 |

## 安装

1. 打开 Chrome，访问 `chrome://extensions/`
2. 打开右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本项目的 `ai-translator-extension` 目录

## 配置（必做）

点击扩展图标 → 「⚙️ 设置 API Key」，或扩展管理页 → 详情 → 扩展程序选项。所有密钥仅存浏览器本地（chrome.storage.sync），不会上传任何第三方。

### 1. 翻译服务（文字翻译，七选一）

**AI 大模型（OpenAI 兼容协议）：**

| 服务商 | 说明 | 获取密钥 |
| --- | --- | --- |
| 智谱 GLM | `glm-4-flash` 完全免费，推荐 | https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys |
| Kimi（月之暗面） | 注册送额度 | https://platform.moonshot.cn/console/api-keys |
| 豆包（火山方舟） | 可填模型 ID 或接入点 ID（`ep-xxx`） | https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey |
| DeepSeek | 价格低 | https://platform.deepseek.com/api_keys |
| OpenAI | `gpt-4o-mini` 性价比高；**需海外网络** | https://platform.openai.com/api-keys |
| Gemini（Google） | `gemini-2.5-flash` 有免费额度；**需海外网络** | https://aistudio.google.com/apikey |
| 自定义 | 任意 OpenAI 兼容的 `/chat/completions` 接口 | — |

**专用翻译平台（免费额度）：**

| 服务商 | 说明 | 获取密钥 |
| --- | --- | --- |
| 阿里云机器翻译 | 通用版**每月 100 万字符免费**，使用国内站 endpoint（`mt.cn-hangzhou.aliyuncs.com`）。需先在 [机器翻译控制台](https://www.aliyun.com/product/ai/alimt) 开通服务，然后创建 AccessKey（建议用 RAM 子账号，仅授 `AliyunMTFullAccess` 权限） | https://ak-console.aliyun.com/#/accesskey |
| 百度翻译 | 标准版**每月 5 万字符免费**（高级版 100 万）。需在 [百度翻译开放平台](https://fanyi-api.baidu.com/product/11) 开通「通用文本翻译」，然后到开发者信息页拿 APP ID 和密钥 | https://fanyi-api.baidu.com/manage/developer |

> 注意：百度标准版限流 **QPS=1**，整页翻译时会自动降速逐组翻译；追求速度请用大模型或阿里云。

### 速度说明

- **追求 3~5 秒翻完整页：选「阿里云机器翻译」**。它是专用机器翻译模型（毫秒级响应），插件会把段落大组合并 + 16 路并发，绝大多数网页 1~2 秒翻完，体验最接近谷歌翻译。
- **AI 大模型**（Kimi/豆包/DeepSeek/智谱）：生成式模型逐字输出，物理上比 MT 慢。插件已做小组合并 + 12 路并发 + **视口优先**（先翻你正在看的区域，首屏 1~3 秒出译文，屏外后台续翻）。推荐智谱 `glm-4-flash`（免费且快）。
- **百度翻译**：受 QPS=1 限制，整页约 10~15 秒，适合作为备用平台。
- 高并发触发服务商限流（429）时会自动退避重试，不会失败。

### 2. 语音识别（仅直播实时翻译需要）

| 服务商 | 说明 |
| --- | --- |
| 硅基流动 | 有免费额度，`FunAudioLLM/SenseVoiceSmall` 中文识别效果好 |
| Groq | 免费 Whisper，速度快 |
| OpenAI | `whisper-1` / `gpt-4o-mini-transcribe`；**需海外网络** |
| Gemini（Google） | `gemini-2.5-flash` 音频转写，有免费额度；**需海外网络** |
| 自定义 | 任意 OpenAI 兼容的 `/audio/transcriptions` 接口 |

> 插件捕获的音频会统一转为 WAV（16kHz 单声道）再送识别，各平台格式全兼容。
> DeepSeek 没有语音识别产品，故语音侧无 DeepSeek 选项。

配置后点击「测试连接」验证可用性。

## 使用

### 翻译网页
- 划词：鼠标选中文字 → 点「译」
- 整页：点扩展图标 →「📄 翻译本页 / 还原」
- 自动：勾选「打开网页时自动翻译」，新网页打开后自动翻译；页面语言与目标语言相同时自动跳过（如目标是中文、页面本身是中文则不翻）；Twitter、Reddit 等无限滚动页面新增内容会自动增量翻译
- 显示模式：「双语对照」（原文下方显示译文）或「仅显示译文」（隐藏原文），弹窗和设置页均可切换
- 平台切换：弹窗中「翻译平台」下拉可随时切换服务商，某个平台失效或额度用完时立即切换备用平台

### 看 YouTube（有字幕）
1. 在视频/直播中**开启 CC 字幕**（播放器右下角按钮，可设为自动生成的英文字幕）
2. 译文会自动显示在播放器内的浮层中

### 看直播（无字幕 / 任意网站）
1. 在直播页面点击扩展图标 →「🔴 开始直播实时翻译」
2. 页面底部出现实时字幕浮窗（可拖动；全屏时自动跟随）
3. 再次点击按钮停止

> 延迟说明：默认每 6 秒音频为一段做识别+翻译，端到端延迟约 8~12 秒。可在设置中调整分段时长（越短越快但请求越多）。

## 目录结构

```
ai-translator-extension/
├── manifest.json            # MV3 配置
├── lib/
│   ├── presets.js           # 服务商预设、语言映射、默认设置
│   └── md5.js               # MD5 实现（百度翻译签名用）
├── background/
│   └── service-worker.js    # LLM/阿里云/百度翻译、ASR、直播会话、右键菜单
├── content/
│   ├── content.js           # 划词/整页/YouTube 字幕/直播浮窗
│   └── content.css
├── offscreen/
│   ├── offscreen.html       # 音频捕获（tabCapture + MediaRecorder）
│   └── offscreen.js
├── popup/                   # 扩展弹窗
├── options/                 # 设置页（按服务商类型动态切换字段）
├── icons/
└── tools/make_icons.py      # 图标生成脚本（可选重跑）
```

## 常见问题

- **提示"未配置密钥"**：到设置页填好对应服务商的密钥并点测试连接。
- **阿里云报 `SignatureDoesNotMatch`**：检查 AccessKey Secret 是否复制完整（不能有多余空格）。
- **阿里云报 `InvalidAccessKeyId.NotFound` 类错误**：确认已在机器翻译控制台开通服务，且 AccessKey 有机器翻译权限。
- **百度报 `54003`**：触发限流（标准版 QPS=1），稍等或换服务商。
- **百度报 `52003`**：APP ID 或密钥错误，或未开通「通用文本翻译」服务。
- **直播翻译没有结果**：确认页面在出声（静音/暂停时无音频可识别）；确认 ASR 的 Key 已配置且测试通过。
- **YouTube 字幕翻译不显示**：先开启视频的 CC 字幕；部分直播没有字幕流，请改用「直播实时翻译（音频）」。
- **chrome:// 、应用商店等页面**：Chrome 不允许扩展注入，无法翻译这类页面。
- **费用**：大模型与语音识别按各服务商 API 用量计费；阿里云/百度翻译有免费额度，超出后计费，请注意额度。

## 权限说明

- `storage`：保存你的密钥与设置（仅存浏览器本地）
- `tabCapture` + `offscreen`：捕获标签页音频用于直播实时翻译
- `contextMenus`：右键翻译菜单
- `host_permissions: <all_urls>`：向你配置的各 API 地址发起请求、在任意网页注入翻译 UI

## 作者

- 开发者：**RexTian**
- 微博：[@太乙真人](https://weibo.com/132666987)
- 网站：[https://www.rextian.com](https://www.rextian.com)

## License

[MIT](./LICENSE) © 2026 RexTian

