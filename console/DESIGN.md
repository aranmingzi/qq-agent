# QQ Agent Console · 设计与实现说明

## 0. 背景与边界

现有 QQ Agent 后台的 UI 在 `C:\QQagent\ui`，是原生 HTML/CSS/JS（`app.js` + `schema.js` + `style.css`），数据与行为来自 `src/app.js` 暴露的 `/api/*`。本次按任务要求使用 React + TypeScript + Tailwind + Radix + Lucide 重构，因此新建了独立的 `qqagent-console`，**没有修改原 Electron 应用或原生 UI**。

- 保留的后端契约：`/api/status`、`/api/sessions`、`/api/sessions/:id`、`/api/moods`、`/api/moods/reset`、`/api/config`、`/api/presets`、`/api/presets/apply`、`/api/chats`、`/api/capabilities`、`/api/snowluma/*`、`/api/pause`、`/api/restart` 等。
- 页面、组件、Token 与状态均在 React 侧重建；没有改后端、没有改数据库、没有改权限规则。
- 现有 UI 是 vanilla JS，未使用 React/Radix；任务明确要求 React/TS/Tailwind，所以产生了这次“并行控制台”迁移，而不是在旧文件里替换技术栈。

---

## 1. 核心设计决策

| 决策 | 解决的问题 |
| --- | --- |
| **固定侧边栏 + 紧凑 Header** | 原后台用顶部 Tab 承载所有导航，深层设置只能横排；改为 248px 侧边栏保留「会话 / 存档 / SnowLuma / 设置」四个入口，设置展开子导航分组。QQ 账号、模型、连接、Token 用量集中在 Header 信息带，避免大号统计卡片抢占视觉焦点。 |
| **会话双栏 + 稳定列表宽** | 桌面端 344px 列表 + 弹性详情，列表切换不改变详情阅读宽度；窄屏列表/详情分层，避免把双栏硬压进手机宽度。 |
| **真实状态而非装饰图表** | 状态统一为 `StatusBadge`（图标 + 文案 + 颜色），情绪只展示后端已有 `label`，不渲染虚构分数/仪表盘；Token、轮数、调用次数都来自真实字段。 |
| **语义化 Token + 原生深色** | 所有表面、边框、文字、状态、日志色由 CSS 变量控制；深色模式不是反色：暗色表面、边框、日志底色单独定义，保持对比和层次。 |
| **预设卡 + 派生匹配** | 「快速 / 均衡 / 深度 / 教学」改为带图标、场景和参数摘要的 Radio Cards。预设数值来自现有 `brain-presets.js`；当前表单是否匹配某个预设是**实时推导**的，手动改参数后立即变成「自定义参数」，不会把旧预设错误高亮。 |
| **密钥「掩码 + 替换」而非回显** | 已保存密钥不回传组件，只显示掩码 + 尾号；只有输入新值时才出现显示/隐藏切换。测试连通性与获取模型列表也要求新密钥，避免为了按钮额外返回明文。 |
| **参数滑块与数字输入双向** | `ParameterControl` 同时提供 Slider 与 number input，空值/非法值/越界值均显式报错；不会产生 NaN 或静默提交。 |
| **保存状态机 + 导航守卫** | 明确「已同步 / 未保存 / 保存中 / 已保存 / 保存失败」；有未保存修改时切换导航会二次确认，离开浏览器也会触发 `beforeunload`。 |
| **终端式日志** | 日志独立于页面正文，等宽字体、最大高度、内部滚动；用户向上查看时暂停跟随，出现「返回最新日志」；清空只影响当前视图。JSON 行使用 `prism-react-renderer` 高亮，未手写解析器。 |
| **克制动效** | 仅使用 150–200ms 的淡入、滑入与状态过渡，`prefers-reduced-motion` 下全部关闭。 |

---

## 2. 设计 Token

实现位置：`src/index.css`、`tailwind.config.ts`。

### 2.1 颜色

| Token | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| `--background` | `#F8FAFC` / `248 250 252` | `#080B11` / `8 11 17` | 页面底色 |
| `--surface` | `#FFFFFF` | `#0F141E` | 内容卡片、输入框 |
| `--surface-muted` | `#F8FAFC` | `#131925` | 次级底、选中弱背景 |
| `--sidebar` | `#FCFDFF` | `#0A0E15` | 侧边栏 |
| `--foreground` | `#0F172A` | `#E2E8F0` | 正文 |
| `--muted` | `#64748B` | `#94A3B8` | 辅助文字 |
| `--border` | `#E2E8F0` | `#212937` | 常规边框 |
| `--border-strong` | `#CBD5E1` | `#334155` | hover / 强边框 |
| `--primary` | `#2563EB` | `#60A5FA` | 强调文字、图标、焦点 |
| `--primary-strong` | `#2563EB` | `#2563EB` | 主按钮底色（保证白字对比度） |
| `--primary-soft` | `#EFF6FF` | `#14223A` | 选中底、消息/标签弱底 |
| `--success` | `#16A34A` | `#4ADE80` | 已发言、在线、成功 |
| `--warning` | `#B45309` | `#FBBF24` | 未回复、演示、待配置 |
| `--danger` | `#DC2626` | `#F87171` | 出错、重置、危险操作 |
| `--info` | `#0369A1` | `#7DD3FC` | 信息提示 |

状态色始终同时带图标与文案，不依赖颜色单独表达。

### 2.2 字体、间距与圆角

- 字体：`Inter Variable`（本地打包）+ 中文回退 `PingFang SC / Hiragino Sans GB / Microsoft YaHei`。
- 等宽：`JetBrains Mono Variable` + `Consolas`，用于模型名、工具名、参数、日志。
- 页面标题 `22px / 32px`，区块标题 `14px / 24px`，正文 `13–14px / 22–24px`，辅助 `10.5–12px / 18–20px`，日志 `11px / 1.7`。
- 间距基准：4 / 8 / 12 / 16 / 20 / 24 / 32；卡片内边距 20px，双栏列表宽 344px，侧边栏 248px。
- 圆角：`--radius: 12px`；按钮/输入 8px，标签 6px，卡片 12px。
- 阴影：浅色 `0 1px 2px rgba(15,23,42,.04)`；深色只保留极轻投影，主要依靠边框区分层次。
- 焦点：2px `ring` + 2px offset，所有交互控件可键盘访问。

### 2.3 响应式

- ≥1280px：侧边栏 + 双栏（会话/存档）+ 模型页右侧摘要栏。
- 1024–1279px：侧边栏保留，模型页收起右侧摘要，预设卡 2 列。
- <1024px：侧边栏进入 Drawer；会话/存档切换为「列表 → 详情」分层。
- 手机端 Header 隐藏账号名、用量和模型文字，只保留连接状态、数据源、主题与暂停；核心操作不被折叠遮蔽。
- 长代码、工具结果、日志只在自身容器内滚动；页面不出现非必要横向滚动。

---

## 3. 组件结构

```text
App
├─ ThemeProvider / ToastProvider / ConsoleModeProvider
├─ NavigationGuardProvider / TooltipProvider
├─ AppSidebar（桌面固定 / 移动 Drawer 复用）
├─ ConsoleHeader
└─ RouteView
   ├─ SessionsPage
   │  ├─ ConversationList
   │  └─ ConversationDetail
   │     ├─ StatusBadge / MoodBadge / CopyButton
   │     └─ ToolCallCard
   ├─ ArchivePage
   ├─ SnowLumaPage
   │  └─ LogViewer
   ├─ CapabilitiesPage
   │  └─ ToolCard
   └─ ModelApiPage
      ├─ SectionCard / SaveIndicator
      ├─ PresetCard
      ├─ ParameterControl
      └─ SecretInput
```

共享 UI：`Button / Input / Label / Badge / Switch / Checkbox / Slider / Select / RadioGroup / Accordion / Dialog / ConfirmDialog / DropdownMenu / Tooltip / Skeleton / EmptyState / PageHeader / SectionCard`。集中实现于 `src/components/ui` 与 `src/components/*.tsx`。

### 3.1 关键 Props

```ts
interface AppSidebarProps {
  path: string;
  status: AppStatus | null;
  onNavigate?: () => void;
}

interface ConsoleHeaderProps {
  path: string;
  status: AppStatus | null;
  statusLoading: boolean;
  statusError: string | null;
  onOpenSidebar: () => void;
  onRefreshStatus: () => void;
}

interface StatusBadgeProps {
  status: SessionStatus;
  size?: 'sm' | 'md';
  showIcon?: boolean;
}

interface ConversationListProps {
  sessions: SessionSummary[];
  counts: Record<SessionFilter, number>;
  query: string;
  onQueryChange: (value: string) => void;
  filter: SessionFilter;
  onFilterChange: (filter: SessionFilter) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  error: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  mode: DataMode;
}

interface PresetCardProps {
  preset: BrainPreset;
  selected: boolean;
}

interface ParameterControlProps {
  id: string;
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  min: number;
  max: number;
  step: number;
  unit?: string;
  error?: string;
  disabled?: boolean;
}

interface SecretInputProps {
  label: string;
  configured: boolean;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  error?: string;
  disabled?: boolean;
  required?: boolean;
}

interface LogViewerProps {
  logs: SnowLumaLogLine[];
  loading?: boolean;
  onRefresh: () => void;
}
```

完整数据结构在 `src/types/index.ts`：`SessionSummary`、`SessionDetail`、`SessionMessage`、`Mood`、`ApiConfig`、`Provider`、`BrainPreset`、`ToolCapability`、`SnowLumaLogLine`、`AppStatus` 等，避免 `any`。

### 3.2 行为约定

- `ConversationList`：搜索/状态筛选是客户端行为，沿用后端 `limit=80`；没有新增分页接口，也没有改变业务规则。
- `ConversationDetail`：复制全部会话走 `sessionToText`；重置情绪先确认影响范围，再调用 `POST /api/moods/reset`；成功/失败都有 Toast，失败不会伪造成成功。
- `PresetCard`：只负责展示与选择；参数同步由 `applyPreset` 完成。
- `useModelConfig`：表单、基线、脏状态、校验、保存、测试、拉取模型、预设匹配、密钥掩码状态集中管理；页面只负责编排。
- `useSessions` / archive / capabilities 的加载、错误、空数据、刷新状态都是显式的 `loading | ready | error`，没有用静态占位冒充数据。
- 主题：`light / dark / system`，`localStorage` 仅存主题枚举，不存密钥。

---

## 4. P1 页面改造方案与复用

### 图2 · 会话存档（只读消息 + 显式写操作）

- 布局：左侧「消息存档」列表（聊天名、情绪、最新消息两行、消息数、时间、未读数），右侧消息流。
- 复用：`MoodBadge`、`EmptyState`、时间格式、`scrollbar-thin` 与状态骨架；消息侧使用只读气泡。
- 写操作：Header 中提供「标记已读」「唤醒一次」「测试发送」；三者都有确认对话框，明确影响范围（清空未读 / 触发模型费用 / 真实 QQ 发送）。
- 隐私：列表中的聊天名与号码不在白名单隐私页出现；存档页属于显式查看消息，仍展示聊天对象。
- 下一步抽象：把 `ConversationList` 与存档列表抽成泛型 `ListPane` + `ListItem`，共享 344px 宽度、选中态、搜索/筛选/空状态的布局，数据映射留给各自 feature。

### 图3 · SnowLuma 网关与运行日志（状态、日志与登录）

- 状态：SnowLuma 进程、OneBot WS、QQ 账号在线、WebUI 运行中/未运行；启动/关闭/打开目录/刷新。
- 日志：独立 `LogViewer`，等宽、最大高度 420px、内部滚动；自动滚动开关、向上查看暂停跟随、返回最新、复制、清空视图；JSON 行用 Prism 高亮；日志与复制前做 `sk-* / token / password / uin` 脱敏。
- 清空语义：确认文案明确「只清空当前浏览器视图，不删除服务端内存日志或 snowluma/logs 磁盘记录」。
- 登录：已接入扫码登录、账号密码登录、快速登录、新设备扫码轮询、人机验证（TCaptcha）；密码只在本机浏览器计算 MD5，不上传明文；登录成功以真实连接状态为准。
- 复用：`SectionCard`、`SecretInput`、`ConfirmDialog`、`CopyButton`、`LogViewer`。

### 图4 · 能力总览（已实现卡片 + Accordion）

- 顶部 4 张响应式能力卡：学习模式、知识库、联网搜索、定时任务；状态来自 `/api/capabilities` 的真实字段。
- 工具清单：按服务端 group 分组，Accordion 收起显示工具名 + 用途，展开显示参数名、类型、必填、说明；工具名/类型等宽。
- 数据缺口：`/api/capabilities` 目前对多数工具只返回参数名，不返回 type/required/description。UI 如实显示「未提供 / —」，并在有缺省时提示原因；演示数据中 12 个高频工具补全了类型（来自 `tools.js` schema），其余保持接口原样。建议扩展接口返回参数的 JSON Schema 子集。
- 复用：`SectionCard`、`Accordion`、`Badge`、`EmptyState`、`Skeleton`。

### 其余设置页

`人设 / 聊天白名单 / 聊天设置 / 语音音色 / 桌面端 / OneBot` 已全部迁移为可编辑页面，复用 `SectionCard + Field + ToggleRow + SelectField + NumberField + SecretInput + SaveStatus`，保存走现有 `/api/config`。桌面端和 OneBot 的连接类字段会提示需要重启生效。

### 白名单隐私层（新增）

- 默认隐藏：列表只渲染稳定别名（`群聊 01`、`好友 01`）与 `••••••••`，不渲染真实群名 / 好友昵称 / QQ 号 / 群号；
- 隐藏态下搜索框禁用，手动输入框使用 password 类型；选中标签也只显示别名；
- 显式点击「显示真实信息」才出现二次确认，确认后一次性渲染真实值；
- 显示状态只存在组件内存，不写 localStorage / 配置 / 日志；切到后台或 2 分钟后自动隐藏，保存成功后也会立即隐藏；
- 实现模块：`src/lib/privacy.ts`、`src/hooks/use-privacy-mode.ts`；
- 剩余风险：底层 `/api/onebot/groups|friends` 仍返回完整名单到页面内存，DevTools / XSS 仍可读取；更严格的做法是服务端返回不透明 token 并在保存时由服务端解析（后续建议）。

---

## 5. 必要假设与未接入接口

1. **技术栈迁移假设**：现有 UI 为原生 JS；本次已把 React 控制台接入 Electron（默认 `/console/`），旧版保留在 `/legacy/`。原 `ui/app.js` 未被覆盖，可通过 `QQAGENT_UI=legacy` 回退。
2. **预设数值来源**：`/api/presets` 只返回 `id/name/icon/desc`，不返回温度、输出上限、轮数、思考模式。前端按现有 `src/brain-presets.js` 的值补齐；**后端调整预设时必须同步这些值，或让接口返回完整参数**。这是当前最明显的契约缺口。
3. **密钥回传**：后端 `/api/config` 已改为只返回掩码与 `hasKey`；写入前会剥离掩码值。`/api/providers/test-saved` 使用服务端已保存密钥，密钥不出服务端，且只允许针对已保存的 Base URL 测试。
4. **获取模型列表仍需要新密钥**：`/api/providers/fetch-models` 在未输入新 Key 时使用同 Base URL 的已保存密钥；若 Base URL 被修改，必须重新输入密钥，避免把密钥发到任意地址。
5. **模型能力元数据**：后端未提供每个模型的 `supportsTemperature`、最大 token 等元数据；当前范围沿用现有表单范围（温度 0–2、轮数 1–40、普通输出 64–4096、复杂输出 64–8192），UI 已明确说明。不能用虚构的模型能力禁用字段。
6. **用量字段语义**：`usage.calls` 在后端表示模型调用次数，不是工具调用次数；摘要显示为「模型调用」，工具步骤数单独从消息记录统计。
7. **情绪**：只展示后端 `label`。`score` 有内部值但区间语义未公开，因此没有画进度条/仪表盘。
8. **会话列表分页**：沿用 `/api/sessions?limit=80`，没有新增分页；搜索与筛选是客户端行为，不改变后端规则。
9. **实时刷新**：未接入 SSE；状态 15s、会话 4s、运行中详情 1.5s、日志 5s 轮询。若后端已有 SSE，可替换为事件驱动。
10. **登录**：已接入扫码、账密（浏览器 MD5）、快速登录、新设备扫码、TCaptcha；未在验证中实际退出并重新登录，避免影响在线机器人。二维码 / 人机验证依赖 NapCat / 腾讯服务可用性。
11. **存档写操作**：已接入唤醒、标记已读、测试发送，均有确认；验证只打开对话框并取消，没有真实发送或触发模型。
12. **设置页**：六个人设 / 白名单 / 聊天 / 语音 / 桌面 / OneBot 页均已迁移；桌面自启等系统项保存后由 Electron 启动流程读取。
13. **白名单隐私层**：默认隐藏真实名单；但 `/api/onebot/groups|friends` 仍向页面返回完整数据，隐藏是渲染层保护。若威胁模型包含 XSS/DevTools，建议服务端改为不透明 token + 保存时解析。
14. **构建体积**：单 chunk 约 790KB（gzip 241KB），主要来自 Radix、Prism、MD5 与字体。若需进一步优化，可对 SnowLuma/设置页做 `React.lazy` 与 Prism 按需加载。
15. **剪贴板验证**：无头 Chrome 的 OS 剪贴板权限不稳定，`scripts/verify.mjs` 通过劫持 `navigator.clipboard.writeText` 验证应用层写入文本与按钮反馈；真实系统剪贴板行为由浏览器权限决定。

---

## 6. 验证情况

- `npm run build`：通过（tsc --noEmit + Vite build）。
- `node scripts/verify.mjs`：**34/34 通过**，覆盖：
  - 会话列表 8 条、自动选中、切换、详情状态/情绪；
  - 复制全部会话写入剪贴板 API、重置情绪确认与结果；
  - 浅色/深色切换；
  - 预设「深度」同步 0.6 / 1600 / 8 轮、匹配提示；手动修改后显示自定义；
  - 空值触发校验、不静默提交；本地演示保存反馈；
  - 已保存密钥不渲染明文、新密钥默认隐藏/可显示、未保存标记；
  - 未保存时切换导航二次确认；
  - JSON 日志高亮、向上滚动暂停跟随、清空视图确认与空态；
  - 能力总览、工具参数展开、存档只读边界；
  - 390px 移动端列表/详情分层；
  - 实时模式只读连接成功、密钥不进入 DOM、掩码存在。
- `node scripts/verify-electron.mjs`：**8/8 通过**，覆盖 `/console/` 加载、默认实时模式、真实会话、无前端异常/404、密钥不落 DOM、`/legacy/` 兼容页与旧版 CSS/JS 路由。
- `node scripts/verify-settings.mjs`：**18/18 通过**，覆盖六个人设/白名单/聊天/语音/桌面/OneBot 页、白名单默认隐藏真实群名/群号、二次确认显示/立即隐藏、`/api/providers/test-saved` 成功、存档写操作入口与确认框、SnowLuma 登录面板、无异常/404。
- 截图：`screenshots/final-sessions-light.png`、`final-sessions-dark.png`、`final-model-light.png`、`final-model-dark.png`、`final-model-parameters.png`、`final-snowluma-light.png`、`final-capabilities-light.png`、`final-archive-light.png`、`final-sessions-mobile-list.png`、`final-sessions-mobile-detail.png`、`final-sessions-1920.png`、`final-model-1280.png`。
- **未验证**：真实保存各设置页、真实暂停/重启、真实退出并重新登录、真实存档写操作（避免改动在线机器人）；系统跟随主题的媒体查询仅由代码路径保证，未单独截图；无自动化 a11y 扫描，仅人工检查焦点/标签/对比度。

---

## 7. 设计源码索引

- 设计 Token：`src/index.css`、`tailwind.config.ts`
- 全局布局：`src/App.tsx`、`src/components/app-sidebar.tsx`、`src/components/console-header.tsx`
- 会话面板：`src/features/sessions/`
- 模型 API：`src/features/settings/model-api/`
- 日志：`src/features/snowluma/log-viewer.tsx`
- 能力总览：`src/features/settings/capabilities/`
- 存档：`src/features/archive/`
- 白名单隐私：`src/lib/privacy.ts`、`src/hooks/use-privacy-mode.ts`
- 其余设置：`src/features/settings/{persona,allowlist,chat,voice,desktop,onebot}/`
- 登录：`src/features/snowluma/login-panel.tsx`
- 安全归一化：`src/lib/api.ts`、`src/lib/redact.ts`
- 交互验证：`scripts/verify.mjs`、`scripts/verify-electron.mjs`、`scripts/verify-settings.mjs`
