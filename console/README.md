# QQ Agent Console

QQ Agent 的 React 控制台。Electron 默认入口是 `/console/`，旧版原生 UI 保留在 `/legacy/` 作为登录 / 回退通道。

技术栈：React 19 + TypeScript + Tailwind CSS + Radix UI/shadcn 风格组件 + Lucide + Prism（JSON 日志高亮）+ blueimp-md5（仅用于本地计算 QQ 密码 MD5）。

## 已实现

- **会话**：双栏列表 / 详情、搜索筛选、消息与工具调用、复制全部、重置情绪确认、运行中轮询、空 / 错 / 加载态。
- **模型 API**：预设 Radio Cards、参数滑块与数字输入联动、掩码密钥、保存状态、未保存导航守卫、高级路由 / 识图 / 联网搜索。
- **存档**：只读消息流 + **唤醒一次 / 标记已读 / 测试发送** 三个显式写操作（均有确认）。
- **SnowLuma**：状态卡、启停、终端日志、JSON 高亮、跟随暂停、**扫码登录 / 账号密码登录 / 快速登录 / 新人设备扫码 / 人机验证**。
- **能力总览**：真实状态卡、工具分组 Accordion、参数类型 / 必填 / 说明。
- **其余设置页**：人设、聊天白名单、聊天设置、语音音色、桌面端、OneBot 全部可编辑并保存。
- **白名单隐私保护**：默认隐藏真实群名、好友昵称、QQ 号和群号；显式二次确认后临时显示，切后台或 2 分钟后自动隐藏。
- **主题**：浅色 / 深色 / 跟随系统，语义化 Token。

## 运行

```bash
npm install
npm run dev
# http://127.0.0.1:5173
```

集成构建到 Electron：

```bash
npm run build:electron
# 产物输出到 ../ui-console
```

如果 Windows 下 esbuild postinstall 被权限策略拦截，可使用 `npm install --ignore-scripts`；若系统临时目录不可写，把 `TEMP` / `TMP` 指向仓库内 `.tmp`。

## 与 QQ Agent 集成

- Electron `electron/main.js` 默认加载 `http://127.0.0.1:${port}/console/`；
- 后端 `src/app.js` 新增 `/console/` 静态路由（`ui-console/`），`/legacy/` 继续服务原 `ui/`；
- 访问 `/` 会重定向到 `/console/`，构建缺失时自动回退 `/legacy/`；
- 临时回退旧版：设置环境变量 `QQAGENT_UI=legacy`；
- 旧版页面新增「新版控制台」入口，新版 Header 的「更多」菜单、SnowLuma 登录页、存档页和未迁移设置页均有旧版入口。

## 密钥与隐私

- **后端 `/api/config` 不再返回明文 API Key**：只返回掩码与 `hasKey / apiKeyConfigured`；
- 任何前端把掩码写回配置都会被 `stripMaskedSecrets` 丢弃，不会把 `••••` 保存成新密钥；
- 新增 `POST /api/providers/test-saved`：服务端使用**已保存密钥**测试当前服务商，密钥不出服务端，且只允许用于已保存的 Base URL；
- 新版测试按钮在没有输入新密钥时会调用该接口，并标注「使用已保存密钥」；
- 白名单隐私页读取的真实名单只存在页面内存；隐藏态下 DOM 不渲染真实名称 / 号码，搜索也会禁用；显示态不持久化、不写日志，2 分钟 / 切后台自动隐藏。底层 `/api/onebot/groups|friends` 仍会向同一来源返回名单，若需要防御 DevTools / XSS，需进一步做服务端别名令牌接口（见 DESIGN.md）。

## 数据源

- 集成入口 `/console/` 默认连接真实 `/api`；
- 单独 `npm run dev` 时默认演示数据，可在 Header 切换「本地服务」；
- `?mode=live` 可强制实时模式；
- 演示模式不会伪造登录 / 保存 / 发送成功，所有写操作都会明确提示未写入后端。

## 验证

```bash
# 独立开发 / 演示模式
npm run verify

# 集成构建环境（需后端 3210 运行、Chrome）
npm run verify:electron
npm run verify:settings
```

最近一次结果：演示模式 34/34、集成加载 8/8、设置与安全 18/18。截图在 `screenshots/`，详细设计见 [DESIGN.md](./DESIGN.md)。
