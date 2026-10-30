// 后端：切换服务商时密钥/端点是否跟着搬（只跑一次往返，最后恢复原状）
const BASE = process.env.QQAGENT_BASE || 'http://127.0.0.1:3210';

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

async function getConfig() {
  return (await fetch(`${BASE}/api/config`)).json();
}
async function postConfig(patch) {
  const res = await fetch(`${BASE}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return res.json();
}

const before = await getConfig();
const providers = (await (await fetch(`${BASE}/api/providers`)).json()).providers || [];
const current = providers.find((p) => p.id === before.api.provider);
const other = providers.find((p) => p.id !== before.api.provider && p.hasKey && p.models.length);

if (!current || !other) {
  console.log('跳过：需要至少两个已配置密钥的服务商');
  process.exit(0);
}

const original = {
  provider: before.api.provider,
  model: before.api.model,
  baseUrl: before.api.baseUrl,
  apiKey: before.api.apiKey,
};

// 1) 切到另一个服务商，故意不传 apiKey / baseUrl（模拟界面里只选了模型）
const switched = await postConfig({
  api: { provider: other.id, model: other.models[0] },
  });
const nowKey = switched.config?.api?.apiKey ?? '';
check(
  '切服务商后自动套用该服务商的密钥',
  nowKey === other.apiKey && nowKey !== original.apiKey,
  `apiKey=${nowKey} 期望=${other.apiKey}`,
);
check(
  '切服务商后自动套用该服务商的 Base URL',
  switched.config?.api?.baseUrl === other.baseURL,
  `${switched.config?.api?.baseUrl} 期望=${other.baseURL}`,
);

// 2) 切回原来的服务商（同样不传 key），应该把原密钥搬回来
const restored = await postConfig({
  api: { provider: original.provider, model: original.model, baseUrl: original.baseUrl },
});
const restoredKey = restored.config?.api?.apiKey ?? '';
check('切回原服务商后密钥恢复', restoredKey === original.apiKey, `apiKey=${restoredKey} 期望=${original.apiKey}`);
check(
  '切回后其它字段不变',
  restored.config?.api?.model === original.model &&
    restored.config?.api?.baseUrl === original.baseUrl,
  `${restored.config?.api?.model} @ ${restored.config?.api?.baseUrl}`,
);

const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`);
if (failed.length) process.exitCode = 1;
