# QQ Agent（独立版 · 桌面端）

从 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 彻底改造而来的独立 QQ agent 应用：

- **完全脱离 DeepSeek Harness**：大脑换成任何 OpenAI 兼容 API（本机网关 / 中转站 / 官方 API 均可），模型在设置里自选。
- **无状态会话，按次计费**：模型不再携带跨次运行的对话历史（详见下文），每一次处理的 token 消耗恒定、可控。
- **桌面端应用**：Electron 壳 + 会话式控制台（每次 agent 处理 = 一个会话，完整留档可查）。

## 下载安装（Windows，给不想配环境的人）

不需要装 Node、不需要命令行，双击安装即可：

**[QQagent-Setup-1.0.0.exe](https://github.com/aranmingzi/qq-agent/releases/download/v1.0.0/QQagent-Setup-1.0.0.exe)**（120 MB）

- 装到当前用户目录（`%LOCALAPPDATA%\Programs\QQAgent`），默认**不需要管理员权限**；
- 装完桌面和开始菜单有图标，配置与聊天记录存在安装目录的 `data\`，卸载默认保留；
- 没做代码签名，第一次运行 Windows 会提示「未知发布者」——点「更多信息 → 仍要运行」即可，校验值见 Release 里的 `SHA256SUMS.txt`；
- 一键安装 / 首次扫码 / 更新回滚 / 卸载 / 排错，全在安装包附带的 [README.html](https://github.com/aranmingzi/qq-agent/releases/download/v1.0.0/README.html) 里；
- 免安装版：[QQagent-1.0.0-win.zip](https://github.com/aranmingzi/qq-agent/releases/download/v1.0.0/QQagent-1.0.0-win.zip)（173 MiB，解压即用）。

安装包与本仓库同源（`tools/make-installer.mjs` 从本仓库的 `git` HEAD 出包），装出来的就是这份代码。

## 架构：为什么便宜了

原版（DSH）把所有上下文堆在一个会话里：发言 + 工具调用 + 工具结果全部留存在会话中，下次发言时整个重发，且两次发言的间隔通常远超缓存 TTL，成本随发言次数近似平方增长。

本版的做法：

1. 群聊消息存进**不断增长的 JSON**（`data/messages/group_xxx.json`），每条带时间与已读状态。
2. 每次有新消息（或主动机会），**新开一个独立会话**，提示词 = 静态系统提示（人设/规则/策略，无历史）+ 用户消息：
   - 【当前时间】【会话标识】【角色设定】【此刻状态】
   - 【过去状态】（来自 JSON 存档的最近一段聊天记录，含自己的发言与时间）
   - 【本次唤醒】（本次触发的新消息，开始处理时全部自动标为已读）
   - 【参与度参考】【记忆】【可用表情包】【引导说明】
3. 会话结束即弃置，**LLM 层面零历史**；需要长期记住的东西走记忆工具（跨运行持久）。
4. 处理期间新来的消息只写 JSON（未读）；本次结束后发现未读 → 自动再开新会话处理 → 直到清空。确保每一条发言都被看到，又不会并发开一堆会话。
5. 原版的 5 分钟"沉睡前观察"、唤醒配置、等待工具全部移除——事件驱动天然替代了它们：想等后续就安静结束，新消息来了自然会再被叫起。

一次处理的成本 ≈ 系统提示 + 存档摘要，是**恒定小份**，不再随历史膨胀。

## 快速开始（三步）

### 前置：QQ 协议端

本项目**不含** QQ 协议端，需要你自行准备：

- **NapCat**（OneBot v11 实现）+ **LinuxQQ**（或 Windows 下的同类方案）
- 无头 Linux 环境还需 `xvfb`（LinuxQQ 需要 X 显示）

NapCat 装好后，在设置页把 OneBot 的 WS/HTTP 地址填对（默认 `ws://127.0.0.1:3001` / `http://127.0.0.1:3000`）。

应用会在**启动时**、以及每次**点「启动 QQ」前**自动把这两个端口写进 NapCat 的配置
（还会补一份**账号无关的模板** `config/onebot11.json`）—— 这样换小号登录也不会再出现
"QQ 登录了、机器人却一直离线"（NapCat 找不到带号配置时会自己生成一份**没有端口**的配置，
既不报错也不开端口）。修好的配置**需要重新扫码登录一次才生效**（协议端只在登录那一刻读它）。

### 三步跑起来

```bash
npm install        # 安装依赖（electron 仅桌面端需要）
npm run server     # headless：浏览器打开 http://127.0.0.1:3210
# 或
npm start          # Electron 桌面端
```

1. 首次启动会自动带到设置页，照着顶部**体检卡**走：
   填 API → 点"测试一下"看绿灯 → 点"选择群"从 QQ 账号直接勾选白名单 → 选模型。
2. 到"存档"页给目标群**手动发一条测试消息**验证链路。
3. 然后等群友说话就行。

## 控制台（React）

默认控制台已切换为 React + TypeScript + Tailwind + Radix + Lucide 版本：

- Electron 与浏览器默认入口：`/console/`（访问 `/` 会自动重定向）
- 源码目录：`console/`
- 开发：`npm --prefix console run dev`（Vite 代理 `/api` 到 `127.0.0.1:3210`）
- 集成构建：`npm --prefix console run build:electron`，产物输出到 `ui-console/`
- 旧版控制台保留在 `/legacy/` 作为兼容回退；新版已覆盖会话、模型 API、存档（含唤醒 / 标记已读 / 测试发送）、SnowLuma（状态 / 日志 / 扫码 / 账密 / 快速登录 / 新设备验证）、能力总览，以及人设、白名单、聊天、语音、桌面、OneBot 设置
- 临时回退旧版：启动 Electron 时设置环境变量 `QQAGENT_UI=legacy`
- 安全：`/api/config` 只返回掩码；`/api/providers/test-saved` 使用服务端已保存密钥测试，密钥不出服务端
- 隐私：白名单页默认隐藏真实群名 / 好友昵称 / QQ 号 / 群号；二次确认后临时显示，切后台或 2 分钟后自动隐藏

如果忘记构建 `ui-console/`，后端会自动把 `/console/` 重定向到 `/legacy/`，不会白屏。

验证：`node console/scripts/verify-electron.mjs`（8/8）与 `node console/scripts/verify-settings.mjs`（18/18）。

### 语音通话（控制台内）

控制台左侧「语音与连接 → 语音通话」（`/console/#/voice`）可以直接跟它打电话：按一下开始，
说话，自动断句 → 识别 → 按人设回复 → 用配置的音色念出来；它说话时你一开口就被打断（抢话）。

- **为什么不能在 QQ 里打**：QQ 的语音/视频通话走闭源 AVSDK/NTRTC，协议端（NapCat、Lagrange.Core）
  都没有对应接口；官方机器人 API 的语音能力只对 QQ 频道的语音子频道开放，且只能播不能收。
  这是协议层限制，不是没实现。真要在 QQ 里接电话，只能走下面那套操作系统层面的办法。
- **前提**：`audio.apiKey`（DashScope Key，识别和合成都用它）。缺 Key 时页面会直接说清楚缺什么，
  不会只给一个按不动的按钮。
- **麦克风**：浏览器只在 `localhost` / HTTPS 下给麦克风权限，请用 `http://127.0.0.1:3210/console/`
  打开；用局域网 IP 打开会拿不到权限，页面会提示原因。
- **传输**：复用现有 HTTP 服务上的 `/voice/ws`（`upgrade` 事件 + 已装的 `ws`），
  不新开端口、不加依赖。二进制帧是音频，文本帧是 JSON 控制消息。
- **关闭**：`config.voice.enabled=false`。

### QQ 通话（在真的 QQ 客户端里替你接电话）

控制台左侧「语音与连接 → QQ 通话」（`/console/#/qq-call`）。跟上面那个是两件事：
上面是"在控制台里跟它打电话"，这里是"QQ 响了它替你去接"。

协议层没有通话接口，所以在**操作系统层面**给它装了一副手、耳朵和嘴：

| 环节 | 做法 | 依赖 |
|---|---|---|
| 手 | UIA 无障碍接口找到「接听」按钮并点下去 | 纯 PowerShell，无 Python |
| 耳朵 | Electron `setDisplayMediaRequestHandler` 的 `audio: 'loopback'` 录系统混音 | Electron 44+（Windows 专用） |
| 嘴 | TTS 播进虚拟声卡，QQ 的麦克风选它 | 需自装 VB-Cable / VoiceMeeter |

- **默认全关**（`config.call.enabled=false`）：接电话是唯一不可回退的动作 —— 一旦接起来对方就在等了。
  打开总闸之后还有第二个开关 `autoAnswer`：只开总闸 = 只看不接，扫到来电只发事件。
- **先干跑一次**：面板上的「干跑一次扫描」不会点任何东西，只把当前窗口和按钮原样列出来。
  QQ 改版后接听按钮可能改名，改 `config.call.answerPattern` 即可（默认来自实测的 `接听|接受|接起`）。
- **前提**：必须跑在有图形界面的 Windows 上，且 QQ 已登录。纯浏览器打开控制台拿不到系统声音，
  状态接口会直说原因而不是给个按不动的按钮。
- **视频不做**：会开摄像头，而且这条链路原作者自己都没验证通过（`docs/QQ通话三步-2026-10-29.md`）。


## 手机轻量版（/m/）

电脑上的机器人保持不变，手机只当遥控器：看状态、改常用设置、暂停、重启。
零构建单文件 PWA，加到手机主屏即可，不用上架、不用另装 App。

开启（必须在运行 QQagent 的那台电脑上操作）：

1. 浏览器打开 `http://127.0.0.1:3210/m/`
2. 在「手机访问」卡片点「开启手机访问」——会生成访问令牌，并给出局域网地址与二维码
3. 点「重启生效」（监听地址是启动时定的，不重启不生效）
4. 手机连同一个 WiFi，扫二维码直接进入；令牌会自动带上，也可以手动输

随时可逆：同一张卡片点「关闭手机访问」，重启后回到只监听 `127.0.0.1`，并清空令牌。

- 目录：`ui-mobile/`（`index.html` + `manifest.webmanifest` + `icon.svg`，**没有构建步骤**）
- 只暴露常用设置：模型、人设、聊天行为、语音/唱歌、情绪/表情/日记/记忆/预算
- 写配置走 `POST /api/mobile/config`，由 `MOBILE_CONFIG_GROUPS` 白名单过滤；密钥、白名单、访问令牌、QQ 登录都不在手机权限内
- 鉴权：`POST /api/auth/login` 下发 HttpOnly cookie（`EventSource` 不能带自定义 header，只能靠同源 cookie），同时仍支持 `x-console-token`
- 开启/关闭手机访问的接口 `POST /api/mobile/enable` **只接受本机请求**，远程不能给自己开门
- 电脑上继续用 `/console/`；两边改的是同一份配置（同一进程内存单例），不存在双端互相覆盖
- 自检：`node test/test-mobile-console.mjs`（30 项，含隔离进程的端到端）

安全默认：`server.bindHost` 默认 `127.0.0.1`；一旦配成 `0.0.0.0` 而 `server.token` 为空，启动时会强制退回回环并打警告——宁可手机连不上，也不让同网段任何人改密钥、切 QQ 账号。

不在手机端做的：扫码登录（手机扫不了自己的屏幕）、会话长文阅读、日志终端、唱歌触发。


## 傻瓜式设计

- **体检卡**：设置页顶部列出模型/白名单/OneBot/API 连通性四个必要条件，缺什么亮什么；首次运行自动跳到设置页。
- **多提供商模型目录**：自动从 DSH 的 `settings.yaml` 导入全部提供商与模型（9 家 / 21 个），按提供商分组选择，选中即自动切换端点和密钥；密钥自动从环境变量解析（含 A6API_APIKEY、DASHSCOPE_API_KEY 等别名），缺的标注出来手动补。
- **白名单可视化**：从 QQ 账号拉群列表/好友列表直接勾选，不用查群号。
- **API 一键测试**：发个 "ping" 立刻验证 baseUrl/key/model，显示延迟和模型回复。
- **测试消息**：存档页可不经模型直接发一条消息到群里，配置完立刻验证全链路。
- **托盘常驻**：点关闭最小化到托盘不退出（可关），托盘菜单可暂停/恢复、退出；**开机自启**开关（Windows 登录后自动运行）。
- **预算保险丝**：设置今日成本上限（元），超限自动暂停并在顶部提示，调高后一键恢复；默认关闭。
- **人设模板**：默认即原版"**小鲸鱼**"角色卡（人格/梗/回复示例原样保留，旧架构指令已适配成新版机制）；另有傲娇助手（原版）、毒舌老哥等一键填充，填完可改。
- **端口自适应**：默认 3210，被占用自动往后找空位，不会启动失败。

## 界面

- **会话**：每次处理一个会话，显示完整提示词、思考、工具调用与结果、实际发到 QQ 的每一条、用量与成本。运行中的会话实时刷新。
- **存档**：每个群/好友的 JSON 消息库，含未读标记；可手动"唤醒一次处理"或"全部标为已读"。
- **设置**：模型/单价（成本展示用）、人设（角色设定 + 参与度）、白名单、节奏（防抖/批次间隔/并发）、发送保护（间隔/限频）、主动开话题、表情包开关、OneBot 地址。

## 工具集（会话内自动限定，无令牌）

发送工具绑定当前会话（模型无法发到别处，安全性优于令牌机制）：

- **发送**：`send_message`（分条/引用/@）、`send_sticker`、`send_poke`
- **表情包**：`list_stickers`、`get_sticker_image`、`sticker_note`、`collect_sticker`
- **上下文**：`get_recent_messages`、`get_active_members`、`get_message_detail`
- **图片输入（视觉模型）**：`get_message_images` —— 下载消息里的图片并以 `image_url`（data URL）注入模型。兼容性处理：tool 消息只带文本，图片以紧跟的 user 消息补发（兼容所有 OpenAI 兼容端点）。模型不支持图片时在设置里关掉"视觉"，工具自动移除。
- **联网搜索**：`web_search`（Bing 中文，无需 API key）+ `web_fetch`（抓网页正文，完整 SSRF 防护：DNS 校验、IP 固定防 rebinding、手动跟重定向、限量读取）
- **记忆**：`memory_append/query/remove`、`report_feedback`、`finish`

## 测试（不碰真实 QQ / 真实模型）

```bash
npm run test          # 20 项端到端审计：mock OneBot（WS+HTTP）+ mock LLM 全流程
npm run test:prompt   # 提示词组装单测
```

覆盖：零历史性质、drain 循环、白名单、引用解析、CQ 转义、记忆持久、表情包 SSRF 拦截、发送限频、暂停/恢复、私聊、拍一拍、联网搜索回传、web_fetch 拒内网、图片输入链路（tool 文本 + user image_url 补发）、vision 开关、HTTP API。真实 Bing 搜索已单独冒烟验证。

## 与原版的差异清单

| 项 | 原版 | 本版 |
|---|---|---|
| 大脑 | DeepSeek Harness（绑定） | 任意 OpenAI 兼容 API，模型自选 |
| 成本模型 | 单会话累积，平方级膨胀 | 每次新会话，恒定小份 |
| 沉睡/唤醒/等待工具 | 有（含 5 分钟沉睡前观察） | 移除，事件驱动 + 已读/未读替代 |
| 工具安全 | 会话令牌 + 白名单 | 工具天然绑定会话（更强）+ 白名单 |
| 字符上限 | 500 字/条 | 无（仅 QQ 硬限制切分兜底） |
| 不回复 | 需 mark_read 收尾 | 直接结束即可（正常选项） |
| 黑话学习 | 有 | 暂未移植 |
| 联网搜索 | web-search-safe MCP | `web_search`/`web_fetch` 原生工具（Bing + safe-fetch 全防护，实测可用） |
| 图片 | 按需工具获取 | `get_message_images`（image_url 注入，SSRF 防护 + vision 开关） |

安全边界（全部保留）：无本地工具；群友无管理权限；不泄露路径/凭据/配置；发送强制白名单 + 限频；图片地址禁内网。
