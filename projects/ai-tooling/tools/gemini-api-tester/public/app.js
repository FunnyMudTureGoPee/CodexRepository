import { parseKeys } from './key-parser.js';

const $ = selector => document.querySelector(selector);
const uid = () => crypto.randomUUID();
const STORE = 'gemini-api-tester.config.v1';
const defaults = () => ({ id: uid(), enabled: true, name: 'Gemini 官方', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', keys: [{ id: uid(), label: 'Key 01', value: '' }], models: '' });
let profiles = [defaults()];
let mode = 'generate';
let results = [];
let running = false;
let stopped = false;
let controllers = new Set();
let discoveries = new Map();
let toastTimer;

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, className, action, title) {
  const node = el('button', className, text);
  node.type = 'button';
  if (title) { node.title = title; node.setAttribute('aria-label', title); }
  node.addEventListener('click', action);
  return node;
}
function field(labelText, control) {
  const label = el('label', '', labelText);
  label.append(control);
  return label;
}
function input(value, className = '', type = 'text') {
  const control = el('input', className);
  control.type = type;
  control.value = value;
  control.autocomplete = 'off';
  control.spellcheck = false;
  return control;
}
function modelsFor(profile) { return [...new Set(profile.models.split(/[\n,，]+/).map(s => s.trim().replace(/^models\//, '')).filter(Boolean))]; }
function importKeys(profile, text, target) {
  const parsed = parseKeys(text);
  if (parsed.error) return toast(parsed.error);
  if (!parsed.keys.length) return toast('未识别到完整 Key。请粘贴原始 Key、API Key 请求头、.env 或 JSON 配置；不要粘贴占位符。');
  // Never overwrite a field with a partial extraction from an ambiguous paste.
  if (target && parsed.ignored) return toast('粘贴内容有无法识别的部分，未修改当前 Key；请用下方智能批量导入检查。');
  const remaining = profile.keys.filter(k => k !== target && k.value);
  const known = new Set(remaining.map(k => k.value));
  const unique = parsed.keys.filter(k => { if (known.has(k.value)) return false; known.add(k.value); return true; });
  if (remaining.length + unique.length > 100) return toast('每个服务最多 100 个 Key，当前内容未导入');
  if (!unique.length) return toast('识别出的 Key 已存在，未重复添加');
  profile.keys = remaining;
  unique.forEach((key, index) => profile.keys.push({ id: index === 0 && target ? target.id : uid(), label: key.label || (index === 0 && target ? target.label : `Key ${String(profile.keys.length + 1).padStart(2, '0')}`), value: key.value }));
  renderProfiles(); save();
  toast(`已识别并添加 ${unique.length} 个 Key${parsed.duplicates + parsed.keys.length - unique.length ? '，重复项已跳过' : ''}${parsed.ignored ? `；另有 ${parsed.ignored} 项无法识别，未导入` : ''}`);
}
function normalizedKey(key, profile) {
  const parsed = parseKeys(key.value, { allowBareShort: true });
  if (parsed.keys.length !== 1 || parsed.ignored) throw new Error(`「${profile.name} / ${key.label}」Key 格式需要检查，请重新粘贴或使用智能导入`);
  return parsed.keys[0].value;
}
function savedData(withKeys = false) {
  return { version: 1, rememberKeys: withKeys, profiles: profiles.map(p => ({ ...p, keys: p.keys.map(k => ({ ...k, value: withKeys ? k.value : '' })) })), settings: { mode, prompt: $('#prompt').value, concurrency: $('#concurrency').value, timeout: $('#timeout').value, maxTokens: $('#max-tokens').value } };
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(savedData($('#remember-keys').checked))); }
  catch { toast('浏览器存储不可用或已满；当前页面仍可测试。'); }
  updateJobCount();
}
function parseConfig(data) {
  if (!data || data.version !== 1 || !Array.isArray(data.profiles) || !data.profiles.length || data.profiles.length > 50) throw new Error('配置格式无效：需要 version: 1 与 1–50 个服务');
  return data.profiles.map((p, i) => {
    if (!p || !['gemini', 'openai'].includes(p.protocol) || typeof p.baseUrl !== 'string' || typeof p.models !== 'string' || !Array.isArray(p.keys) || p.keys.length > 100) throw new Error(`第 ${i + 1} 个服务格式无效`);
    if (p.baseUrl.length > 2000 || p.models.length > 20000 || p.keys.some(k => !k || typeof k.value !== 'string' || k.value.length > 8192)) throw new Error('配置字段超过长度限制或 Key 格式无效');
    return { id: uid(), enabled: p.enabled !== false, name: String(p.name || `服务 ${i + 1}`).slice(0, 100), protocol: p.protocol, baseUrl: p.baseUrl, models: p.models, keys: p.keys.length ? p.keys.map((k, j) => ({ id: uid(), label: String(k.label || `Key ${j + 1}`).slice(0, 100), value: k.value })) : [{ id: uid(), label: 'Key 01', value: '' }] };
  });
}
function applySettings(settings = {}) {
  if (['generate', 'models'].includes(settings.mode)) mode = settings.mode;
  if (typeof settings.prompt === 'string') $('#prompt').value = settings.prompt.slice(0, 20000);
  if (['1', '2', '3', '5', '10'].includes(String(settings.concurrency))) $('#concurrency').value = settings.concurrency;
  if (+settings.timeout >= 1 && +settings.timeout <= 300) $('#timeout').value = settings.timeout;
  if (+settings.maxTokens >= 1 && +settings.maxTokens <= 8192) $('#max-tokens').value = settings.maxTokens;
}
try {
  const stored = JSON.parse(localStorage.getItem(STORE) || 'null');
  if (stored) {
    profiles = parseConfig(stored);
    $('#remember-keys').checked = stored.rememberKeys === true;
    if (!stored.rememberKeys) profiles.forEach(p => p.keys.forEach(k => { k.value = ''; }));
    applySettings(stored.settings);
  }
} catch { toast('已忽略无法读取的旧配置。'); }

function renderProfiles() {
  const host = $('#profiles');
  host.replaceChildren();
  $('#profile-count').textContent = `${profiles.length} 个服务`;
  for (const p of profiles) {
    const card = el('article', 'profile');
    const head = el('div', 'profile-head');
    const enabled = input('', '', 'checkbox');
    enabled.checked = p.enabled;
    enabled.setAttribute('aria-label', `启用服务 ${p.name}`);
    enabled.addEventListener('change', () => { p.enabled = enabled.checked; save(); });
    const name = input(p.name, 'profile-name');
    name.maxLength = 100;
    name.setAttribute('aria-label', '服务名称');
    name.addEventListener('input', () => { p.name = name.value; save(); });
    head.append(enabled, name, button('⧉', 'icon-button copy-button', () => {
      if (profiles.length >= 50) return toast('最多添加 50 个服务');
      profiles.push({ ...p, id: uid(), name: `${p.name} 副本`, keys: [{ id: uid(), label: 'Key 01', value: '' }] });
      renderProfiles(); save();
    }, '复制服务配置（不含 Key）'), button('×', 'icon-button', () => {
      if (profiles.length === 1) return toast('请至少保留一个服务；也可以取消勾选。');
      profiles = profiles.filter(item => item.id !== p.id); renderProfiles(); save();
    }, '删除服务'));
    card.append(head);
    const grid = el('div', 'field-grid');
    const protocol = el('select');
    for (const [value, text] of [['gemini', 'Gemini 原生 · generateContent'], ['openai', 'OpenAI 兼容 · chat/completions']]) {
      const option = el('option', '', text); option.value = value; protocol.append(option);
    }
    protocol.value = p.protocol;
    protocol.addEventListener('change', () => {
      if (p.baseUrl === 'https://generativelanguage.googleapis.com/v1beta' && protocol.value === 'openai') p.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai';
      else if (p.baseUrl === 'https://generativelanguage.googleapis.com/v1beta/openai' && protocol.value === 'gemini') p.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
      p.protocol = protocol.value; discoveries.delete(p.id); renderProfiles(); save();
    });
    grid.append(field('接口协议', protocol));
    const base = input(p.baseUrl, 'mono', 'url');
    base.placeholder = 'https://generativelanguage.googleapis.com/v1beta';
    base.addEventListener('input', () => { p.baseUrl = base.value.trim(); discoveries.delete(p.id); save(); });
    const baseLabel = field('API 基础地址', base);
    baseLabel.append(el('p', 'field-note', '填写版本路径（如 /v1beta 或 /v1），不含 /models 或 /chat/completions。'));
    grid.append(baseLabel);
    const keyGroup = el('div');
    const keyHeader = el('div', 'keys-label');
    keyHeader.append(el('label', '', `API Keys · ${p.keys.length}`), button('＋ 添加 Key', 'text-button', () => {
      if (p.keys.length >= 100) return toast('每个服务最多 100 个 Key');
      p.keys.push({ id: uid(), label: `Key ${String(p.keys.length + 1).padStart(2, '0')}`, value: '' }); renderProfiles(); save();
    }));
    keyGroup.append(keyHeader);
    for (const k of p.keys) {
      const row = el('div', 'key-row');
      const label = input(k.label, 'key-label'); label.maxLength = 100; label.setAttribute('aria-label', 'Key 备注');
      label.addEventListener('input', () => { k.label = label.value; save(); });
      const secret = input(k.value, 'key-value', 'password'); secret.placeholder = '粘贴 API Key'; secret.maxLength = 8192; secret.setAttribute('aria-label', `${p.name} ${k.label} API Key`);
      secret.addEventListener('input', () => { k.value = secret.value.trim(); secret.setCustomValidity(''); save(); });
      secret.addEventListener('paste', event => {
        const text = event.clipboardData?.getData('text');
        if (!text) return;
        event.preventDefault();
        importKeys(p, text, k);
      });
      secret.addEventListener('change', () => {
        if (!secret.value.trim()) return;
        const parsed = parseKeys(secret.value, { allowBareShort: true });
        if (parsed.keys.length === 1 && !parsed.ignored) {
          k.value = parsed.keys[0].value; secret.value = k.value; save();
        } else {
          secret.setCustomValidity('内容包含多个 Key 或无法识别，请使用智能批量导入');
          toast('Key 格式需要检查；可使用下方「智能识别 / 批量导入 Key」。');
        }
      });
      const reveal = button('显', 'icon-button reveal', () => { secret.type = secret.type === 'password' ? 'text' : 'password'; reveal.textContent = secret.type === 'password' ? '显' : '隐'; }, '显示或隐藏 Key');
      row.append(label, secret, reveal, button('×', 'icon-button remove-key', () => {
        if (p.keys.length === 1) { k.value = ''; } else p.keys = p.keys.filter(item => item.id !== k.id);
        renderProfiles(); save();
      }, '移除此 Key'));
      keyGroup.append(row);
    }
    const bulk = el('details', 'bulk-keys'); bulk.append(el('summary', '', '智能识别 / 批量导入 Key'));
    const bulkText = el('textarea'); bulkText.rows = 4; bulkText.maxLength = 100000; bulkText.placeholder = '直接粘贴 Key、请求头、.env、JSON 或带 key 的 URL\n支持换行、逗号、空格分隔，以及：备注 | Key'; bulkText.setAttribute('aria-label', '批量 Key 内容'); bulkText.autocomplete = 'off'; bulkText.spellcheck = false;
    const preview = el('p', 'field-note', '自动清理引号、Bearer 前缀与不可见字符；不自动删除 Key 内部空格。');
    preview.setAttribute('aria-live', 'polite');
    bulkText.addEventListener('input', () => {
      const parsed = parseKeys(bulkText.value);
      preview.textContent = parsed.error || `识别到 ${parsed.keys.length} 个 Key，重复 ${parsed.duplicates} 项，无法识别 ${parsed.ignored} 项。仅检查格式，实际可用性以测试结果为准。`;
    });
    bulk.append(bulkText, preview, button('自动识别并添加', 'button small', () => importKeys(p, bulkText.value)));
    keyGroup.append(el('p', 'field-note', '直接粘贴到 Key 输入框也能自动识别，并将多个 Key 分别添加。'));
    keyGroup.append(bulk); grid.append(keyGroup);
    const modelGroup = el('div'); const modelHeader = el('div', 'models-label');
    const discovery = discoveries.get(p.id);
    const discoverButton = button(discovery?.loading ? '获取中…' : '获取模型', 'text-button', () => discoverModels(p));
    discoverButton.disabled = Boolean(discovery?.loading);
    modelHeader.append(el('label', '', '模型 ID'), discoverButton);
    const models = el('textarea'); models.value = p.models; models.rows = 2; models.maxLength = 20000; models.placeholder = '每行一个模型 ID，或点击「获取模型」选择'; models.setAttribute('aria-label', `${p.name} 模型 ID`);
    models.addEventListener('input', () => { p.models = models.value; save(); syncChips(card, p); });
    modelGroup.append(modelHeader, models, el('p', 'field-note', '留空时仍可运行「连接检查」。生成测试需要填写模型。'));
    if (discovery) {
      const box = el('div', 'model-discovery');
      box.append(el('p', 'discovery-message', discovery.message));
      if (discovery.models?.length) {
        const chips = el('div', 'model-choices');
        for (const id of discovery.models) {
          const chip = button(id, 'model-chip', () => {
            const selected = new Set(modelsFor(p));
            if (selected.has(id)) selected.delete(id); else selected.add(id);
            p.models = [...selected].join('\n'); models.value = p.models; syncChips(card, p); save();
          });
          chip.dataset.model = id; chips.append(chip);
        }
        box.append(chips);
      }
      modelGroup.append(box);
    }
    grid.append(modelGroup); card.append(grid); host.append(card); syncChips(card, p);
  }
  setLocked(); updateJobCount();
}
function syncChips(card, p) {
  const selected = new Set(modelsFor(p));
  card.querySelectorAll('.model-chip').forEach(chip => { chip.classList.toggle('selected', selected.has(chip.dataset.model)); chip.setAttribute('aria-pressed', String(selected.has(chip.dataset.model))); });
}
function updateMode() {
  document.querySelectorAll('[data-mode]').forEach(node => { const active = node.dataset.mode === mode; node.classList.toggle('active', active); node.setAttribute('aria-pressed', String(active)); });
  $('#generation-settings').hidden = mode === 'models'; $('#tokens-field').hidden = mode === 'models';
  $('#mode-note').textContent = mode === 'models' ? '每个 Key 请求一次模型列表，不调用文本生成。列表可访问不等于每个模型都能生成。' : '会向每个组合发送一条短文本请求，可能消耗配额。思考模型无文本时可提高 Token 上限。';
  updateJobCount();
}
function updateJobCount() {
  const count = profiles.filter(p => p.enabled).reduce((sum, p) => sum + p.keys.filter(k => k.value.trim()).length * (mode === 'models' ? 1 : modelsFor(p).length), 0);
  $('#job-count').textContent = count ? `预计 ${count} 个请求组合` : '等待配置';
}
function setLocked() {
  const locked = running || [...discoveries.values()].some(d => d.loading);
  $('.configuration').classList.toggle('locked', locked);
  document.querySelectorAll('.configuration input,.configuration textarea,.configuration select,.configuration button,.controls input,.controls textarea,.controls select,[data-mode]').forEach(node => { node.disabled = locked; });
  $('#run').disabled = locked; $('#stop').disabled = !locked;
}
async function request(payload, controller) {
  const response = await fetch('/api/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `本机服务 HTTP ${response.status}`);
  return data;
}
function settings() { return { prompt: $('#prompt').value, timeout: Number($('#timeout').value), maxTokens: Number($('#max-tokens').value) }; }
function validateSettings(operation = mode) {
  const { timeout, maxTokens, prompt } = settings();
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300) throw new Error('超时必须为 1–300 秒');
  if (operation === 'generate' && (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192)) throw new Error('输出 Token 上限必须为 1–8192');
  if (operation === 'generate' && !prompt.trim()) throw new Error('请填写测试提示词');
}
async function discoverModels(p) {
  const key = p.keys.find(k => k.value.trim());
  if (!key) return toast('请先填写此服务的 API Key');
  let cleanKey;
  try { validateSettings('models'); cleanKey = normalizedKey(key, p); } catch (error) { return toast(error.message); }
  const controller = new AbortController(); controllers.add(controller);
  discoveries.set(p.id, { loading: true, message: `正在使用 ${key.label} 获取可用模型…` }); renderProfiles();
  try {
    const data = await request({ protocol: p.protocol, baseUrl: p.baseUrl, key: cleanKey, operation: 'models', ...settings() }, controller);
    discoveries.set(p.id, { loading: false, message: data.message, models: data.models });
  } catch (error) { discoveries.set(p.id, { loading: false, message: error.name === 'AbortError' ? '已停止获取模型' : error.message }); }
  finally { controllers.delete(controller); renderProfiles(); }
}
const states = { queued: '排队中', running: '测试中', success: '成功', failed: '失败', warning: '待检查', cancelled: '已停止' };
function sanitize(text) {
  let value = String(text);
  const keys = profiles.flatMap(p => p.keys.map(k => k.value)).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const key of keys) for (const secret of [key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)]) value = value.split(secret).join('[REDACTED]');
  return value;
}
function renderResults() {
  const total = results.length;
  const done = results.filter(r => !['queued', 'running'].includes(r.state));
  const success = results.filter(r => r.state === 'success').length;
  const attention = results.filter(r => ['failed', 'warning'].includes(r.state)).length;
  const timed = done.filter(r => typeof r.durationMs === 'number');
  $('#metric-total').textContent = total; $('#metric-success').textContent = success; $('#metric-failed').textContent = attention;
  $('#metric-time').replaceChildren(document.createTextNode(timed.length ? Math.round(timed.reduce((sum, r) => sum + r.durationMs, 0) / timed.length) : '—'), el('small', '', 'ms'));
  $('#progress-label').textContent = total ? `${done.length} / ${total}${running ? ' · 运行中' : ' · 已结束'}` : '尚未开始';
  $('#progress-bar').style.width = total ? `${done.length / total * 100}%` : '0%';
  $('#empty-state').hidden = total > 0; $('#table-wrap').hidden = !total; $('#export-results').disabled = !total;
  const filter = $('#result-filter').value;
  const visible = results.filter(r => filter === 'all' || (filter === 'attention' ? ['failed', 'warning'].includes(r.state) : filter === 'pending' ? ['queued', 'running'].includes(r.state) : r.state === filter));
  $('#no-match').hidden = visible.length > 0;
  const rows = document.createDocumentFragment();
  for (const r of visible) {
    const row = el('tr'); const service = el('td'); service.append(el('span', '', r.service), el('small', '', r.keyLabel));
    const model = el('td'); model.append(el('span', 'model-id', r.model || '模型列表'));
    const state = el('td'); state.append(el('span', `status-pill ${r.state}`, states[r.state] || r.state));
    if (r.httpStatus) state.append(el('small', '', `HTTP ${r.httpStatus}`));
    const time = el('td', 'mono', r.durationMs === undefined ? '—' : `${r.durationMs} ms`);
    const detail = el('td'); const btn = button('详情', 'text-button', () => showDetail(r)); btn.disabled = ['queued', 'running'].includes(r.state); detail.append(btn);
    row.append(service, model, state, time, detail); rows.append(row);
  }
  $('#results').replaceChildren(rows);
}
function showDetail(r) {
  const host = $('#detail-content'); host.replaceChildren();
  const meta = el('div', 'detail-meta');
  for (const line of [`服务：${r.service} / ${r.keyLabel}`, `协议：${r.protocol === 'gemini' ? 'Gemini 原生' : 'OpenAI 兼容'}`, `模型：${r.model || '模型列表'}`, `状态：${states[r.state]} · HTTP ${r.httpStatus ?? '—'} · ${r.durationMs ?? '—'} ms`, `请求地址：${r.endpoint || r.baseUrl}`, `时间：${r.timestamp ? new Date(r.timestamp).toLocaleString() : '—'}`]) meta.append(el('div', '', sanitize(line)));
  host.append(meta);
  for (const [title, value] of [['诊断信息', r.message], ['模型输出', r.output], ['可用模型', r.models?.join('\n')], ['Token 用量', r.usage ? JSON.stringify(r.usage, null, 2) : null], ['原始响应（已遮盖 Key）', r.raw]]) {
    if (!value) continue;
    const section = el('section', 'detail-section'); section.append(el('h3', '', title), el('pre', '', sanitize(value))); host.append(section);
  }
  $('#detail-dialog').showModal();
}
async function run() {
  let jobs = [];
  try {
    validateSettings();
    const active = profiles.filter(p => p.enabled);
    if (!active.length) throw new Error('请勾选至少一个服务');
    for (const p of active) {
      const keys = p.keys.filter(k => k.value.trim());
      if (!keys.length) throw new Error(`「${p.name}」还没有 API Key`);
      if (!p.baseUrl.trim()) throw new Error(`「${p.name}」还没有 API 地址`);
      const models = mode === 'models' ? [''] : modelsFor(p);
      if (!models.length) throw new Error(`请为「${p.name}」填写模型，或切换到连接检查`);
      if (jobs.length + keys.length * models.length > 2000) throw new Error('单次最多测试 2000 个组合，请减少 Key 或模型数量');
      for (const key of keys) {
        const cleanKey = normalizedKey(key, p);
        for (const model of models) jobs.push({ service: p.name || '未命名服务', keyLabel: key.label || 'Key', protocol: p.protocol, baseUrl: p.baseUrl, key: cleanKey, model, operation: mode, ...settings() });
      }
    }
  } catch (error) { return toast(error.message); }
  running = true; stopped = false; setLocked();
  results = jobs.map(({ key, ...job }, index) => ({ ...job, id: index, state: 'queued' }));
  renderResults();
  let index = 0;
  const worker = async () => {
    while (!stopped && index < jobs.length) {
      const current = index++; const result = results[current];
      result.state = 'running'; renderResults();
      const controller = new AbortController(); controllers.add(controller);
      const started = performance.now();
      try { Object.assign(result, await request(jobs[current], controller)); }
      catch (error) { Object.assign(result, { state: error.name === 'AbortError' ? 'cancelled' : 'failed', message: error.name === 'AbortError' ? '已停止；上游可能已接收请求，仍可能计费。' : sanitize(error.message), durationMs: Math.round(performance.now() - started), timestamp: new Date().toISOString() }); }
      finally { controllers.delete(controller); renderResults(); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Number($('#concurrency').value), jobs.length) }, worker));
  results.filter(r => r.state === 'queued').forEach(r => { r.state = 'cancelled'; r.message = '已停止，未发送请求'; });
  running = false; jobs = []; setLocked(); renderResults(); toast(stopped ? '测试已停止' : '批量测试完成');
}
function download(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob); const a = el('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('#add-profile').addEventListener('click', () => {
  if (profiles.length >= 50) return toast('最多添加 50 个服务');
  profiles.push({ ...defaults(), name: `API 服务 ${profiles.length + 1}` }); renderProfiles(); save();
});
document.querySelectorAll('[data-mode]').forEach(node => node.addEventListener('click', () => { mode = node.dataset.mode; updateMode(); save(); }));
for (const selector of ['#prompt', '#timeout', '#max-tokens', '#concurrency', '#remember-keys']) $(selector).addEventListener('change', save);
$('#clear-keys').addEventListener('click', () => {
  profiles.forEach(p => p.keys.forEach(k => { k.value = ''; })); $('#remember-keys').checked = false; discoveries.clear(); results = []; renderProfiles(); renderResults(); save(); toast('所有 Key 和测试结果已清除');
});
$('#run').addEventListener('click', run);
$('#stop').addEventListener('click', () => { stopped = true; controllers.forEach(c => c.abort()); });
$('#result-filter').addEventListener('change', renderResults);
$('#close-detail').addEventListener('click', () => $('#detail-dialog').close());
$('#detail-dialog').addEventListener('click', event => { if (event.target === $('#detail-dialog')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
$('#export-config').addEventListener('click', () => download('gemini-api-config.json', savedData(false)));
$('#export-results').addEventListener('click', () => {
  const report = results.map(({ prompt, maxTokens, timeout, ...r }) => r);
  // Redact string fields recursively, preserving valid JSON even for unusual Key characters.
  const clean = value => typeof value === 'string' ? sanitize(value) : Array.isArray(value) ? value.map(clean) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)])) : value;
  download('gemini-api-results.json', clean(report));
});
$('#import-config').addEventListener('click', () => $('#config-file').click());
$('#config-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('配置文件不能超过 2 MB');
    const data = JSON.parse(await file.text()); const parsed = parseConfig(data);
    profiles = parsed; discoveries.clear(); results = []; applySettings(data.settings); renderProfiles(); updateMode(); renderResults(); save(); toast('已导入配置（替换当前服务列表）');
  } catch (error) { toast(`导入失败：${error.message}`); }
  finally { event.target.value = ''; }
});
window.addEventListener('beforeunload', event => { if (running || controllers.size) { event.preventDefault(); event.returnValue = ''; } });
renderProfiles(); updateMode(); renderResults();
fetch('/api/health').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(() => { $('#server-status').textContent = '本机服务就绪'; }).catch(() => { $('#server-status').textContent = '服务未连接'; toast('本机服务未连接，请通过启动脚本打开网页。'); });
