"use strict";

const byId = id => document.getElementById(id);
const state = {scope: "global", sources: [], entries: [], revision: null, loading: false};
const entries = byId("entries");
const editor = byId("editor");
const entryForm = byId("entry-form");
const projectDialog = byId("project-dialog");

let hostOrigin = "*";
let nextId = 0;
const pending = new Map();

function post(message) {
  window.parent.postMessage({jsonrpc: "2.0", ...message}, hostOrigin);
}

function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Codex 界面连接超时，请重新打开记忆工作台。"));
    }, 15000);
    pending.set(id, {resolve, reject, timeout});
    post({id, method, params});
  });
}

window.addEventListener("message", event => {
  if (event.source !== window.parent || (hostOrigin !== "*" && event.origin !== hostOrigin)) return;
  const response = event.data;
  if (response?.jsonrpc !== "2.0") return;
  if (response.method === "ping" || response.method === "ui/resource-teardown") {
    if (response.id != null) post({id: response.id, result: {}});
    return;
  }
  const call = pending.get(response.id);
  if (!call) return;
  if (hostOrigin === "*" && event.origin !== "null") hostOrigin = event.origin;
  clearTimeout(call.timeout);
  pending.delete(response.id);
  if (response.error) call.reject(new Error(response.error.message));
  else call.resolve(response.result);
});

const ready = window.parent === window
  ? Promise.resolve(false)
  : request("ui/initialize", {
      appInfo: {name: "memory-workbench", version: "0.3.1"},
      appCapabilities: {availableDisplayModes: ["inline", "fullscreen"]},
      protocolVersion: "2026-01-26",
    }).then(() => {
      post({method: "ui/notifications/initialized"});
      return true;
    });

async function memory(name, action, fields = {}) {
  if (!await ready) throw new Error("请从 Codex 左侧应用菜单打开「记忆工作台」。");
  const result = await request("tools/call", {name, arguments: {action, ...fields}});
  if (result.isError) throw new Error(result.content?.[0]?.text || "记忆操作失败。");
  if (!Object.hasOwn(result._meta || {}, "workbench")) throw new Error("Codex 未返回台账数据。");
  return result._meta.workbench;
}

function confirmAction(text) {
  const dialog = byId("confirmation");
  byId("confirmation-text").textContent = text;
  dialog.returnValue = "cancel";
  return new Promise(resolve => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), {once: true});
    dialog.showModal();
  });
}

function element(tag, text, className) {
  const item = document.createElement(tag);
  item.textContent = text;
  if (className) item.className = className;
  return item;
}

function message(text) {
  byId("message").hidden = !text;
  byId("message").textContent = text;
}

function selectScope(scope) {
  if (scope === state.scope) return;
  state.scope = scope;
  state.revision = null;
  state.entries = [];
  entries.replaceChildren();
  byId("new-entry").disabled = true;
  refresh(true);
}

function renderNavigation() {
  byId("sources").replaceChildren(...[...state.sources, {id: "history", label: "Codex 自动记忆"}].map(source => {
    const button = element("button", source.label);
    button.type = "button";
    button.title = source.root || source.label;
    button.setAttribute("aria-current", String(source.id === state.scope));
    button.addEventListener("click", () => selectScope(source.id));
    return button;
  }));
}

function renderEntries() {
  const history = state.scope === "history";
  const terms = byId("query").value.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  const status = history ? "" : byId("status").value;
  const expanded = new Set([...entries.querySelectorAll("article:has(details[open])")].map(article => article.dataset.id));
  const filtered = state.entries.filter(entry => {
    const text = Object.values(entry).join(" ").toLocaleLowerCase();
    return (!status || status === entry.status) && terms.every(term => text.includes(term));
  });
  const cards = filtered.map(entry => {
    const article = document.createElement("article");
    article.dataset.id = entry.id;
    const head = document.createElement("div");
    head.className = "entry-head";
    head.append(element("h3", entry.title));
    if (!history) {
      const edit = element("button", "编辑");
      edit.type = "button";
      edit.addEventListener("click", () => editEntry(entry));
      head.append(edit);
    }
    article.append(head);
    const meta = element("p", history ? entry.module : [entry.module, entry.id, entry.updated].join(" · "), "muted");
    if (entry.status) {
      const badge = element("span", entry.status, "badge");
      badge.dataset.status = entry.status;
      meta.append("  ", badge);
    }
    article.append(meta);
    const details = document.createElement("details");
    details.open = expanded.has(entry.id);
    details.append(element("summary", "查看正文"), element("p", entry.body || "暂无正文", "body"));
    article.append(details);
    return article;
  });
  const emptyText = terms.length || status ? "没有匹配的记忆" : (history ? "此 Codex 主目录还没有自动记忆索引" : "这里还没有记忆。点击「新建记忆」添加第一条。");
  entries.replaceChildren(...(cards.length ? cards : [element("p", emptyText, "empty muted")]));
  byId("count").textContent = "显示 " + filtered.length + " / " + state.entries.length + " 条";
}

function formatHistory(files) {
  return files.flatMap(file => file.body.split(/\n(?=#{1,5} )/).filter(Boolean).map((section, index) => {
    const title = section.split("\n", 1)[0].replace(/^#{1,5}\s+/u, "");
    return {id: file.label + ":" + index, title, module: file.label, body: section.trim()};
  }));
}

async function refresh(force = false) {
  if (state.loading) {
    if (force) state.refreshAgain = true;
    return;
  }
  if (editor.open || projectDialog.open) return;
  state.loading = true;
  const scope = state.scope;
  try {
    if (force || !state.sources.length) {
      state.sources = await memory("read_memory", "sources");
      if (scope !== state.scope) return;
      if (scope !== "history" && !state.sources.some(source => source.id === scope)) {
        selectScope("global");
        return;
      }
    }
    const history = scope === "history";
    const result = history ? await memory("read_memory", "history") : await memory("read_memory", "ledger", {scope});
    if (scope !== state.scope || editor.open) return;
    const source = state.sources.find(item => item.id === scope);
    const version = history ? JSON.stringify(result) : result.revision;
    if (force || version !== state.revision) {
      state.revision = version;
      state.entries = history ? formatHistory(result) : result.entries.sort((a, b) => b.updated.localeCompare(a.updated));
      renderNavigation();
      renderEntries();
    }
    byId("scope-title").textContent = history ? "Codex 自动记忆" : source.label;
    byId("path").textContent = history ? "Codex 自动生成的本地索引 · 只读" : source.path;
    byId("remove-project").hidden = !source?.root;
    byId("new-entry").hidden = history;
    byId("new-entry").disabled = history;
    byId("status").hidden = history;
    byId("connection").textContent = "● 本机已连接";
    message("");
  } catch (error) {
    if (scope !== state.scope) return;
    byId("connection").textContent = "○ 等待刷新";
    message(error.message);
    renderNavigation();
  } finally {
    state.loading = false;
    if (state.refreshAgain) {
      state.refreshAgain = false;
      refresh(true);
    }
  }
}

function editEntry(entry) {
  const existing = Boolean(entry);
  if (state.revision === null) return;
  state.edit = {scope: state.scope, revision: state.revision, existing};
  entryForm.reset();
  for (const field of ["id", "title", "module", "status", "body"]) {
    if (existing) entryForm.elements[field].value = entry[field];
  }
  entryForm.elements.id.readOnly = existing;
  byId("editor-title").textContent = existing ? "编辑记忆" : "新建记忆";
  byId("delete-entry").hidden = !existing;
  byId("editor-error").textContent = "";
  editor.showModal();
}

async function saveEntry(remove) {
  const button = byId("save-entry");
  const deleteButton = byId("delete-entry");
  if (button.disabled || (!remove && !entryForm.reportValidity())) return;
  const data = {...state.edit, ...Object.fromEntries(new FormData(entryForm))};
  if (remove && !await confirmAction("删除条目 " + data.id + "？")) return;
  button.disabled = deleteButton.disabled = true;
  try {
    await memory("manage_memory", remove ? "delete" : "save", data);
    editor.close();
    await refresh(true);
  } catch (error) {
    byId("editor-error").textContent = error.message;
  } finally {
    button.disabled = deleteButton.disabled = false;
  }
}

for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => byId(button.dataset.close).close());
}
byId("query").addEventListener("input", renderEntries);
byId("status").addEventListener("change", renderEntries);
byId("refresh").addEventListener("click", () => refresh(true));
byId("new-entry").addEventListener("click", () => editEntry());
byId("save-entry").addEventListener("click", () => saveEntry(false));
byId("delete-entry").addEventListener("click", () => saveEntry(true));
byId("confirm-action").addEventListener("click", () => byId("confirmation").close("confirm"));
byId("add-project").addEventListener("click", () => {
  byId("project-form").reset();
  byId("project-error").textContent = "";
  projectDialog.showModal();
});
byId("save-project").addEventListener("click", async () => {
  const button = byId("save-project");
  if (button.disabled || !byId("project-form").reportValidity()) return;
  button.disabled = true;
  try {
    const {scope} = await memory("manage_memory", "add-project", {path: byId("project-path").value});
    projectDialog.close();
    if (scope === state.scope) await refresh(true);
    else selectScope(scope);
  } catch (error) {
    byId("project-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
for (const [form, button] of [[entryForm, byId("save-entry")], [byId("project-form"), byId("save-project")]]) {
  form.addEventListener("submit", event => event.preventDefault());
  form.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.target.tagName !== "INPUT" || event.isComposing) return;
    event.preventDefault();
    button.click();
  });
}
byId("remove-project").addEventListener("click", async () => {
  const source = state.sources.find(item => item.id === state.scope);
  if (!source?.root || !await confirmAction("从工作台移除 " + source.label + "？仓库里的台账文件会保留。")) return;
  try {
    await memory("manage_memory", "remove-project", {path: source.root});
    selectScope("global");
  } catch (error) {
    message(error.message);
  }
});

refresh(true);
setInterval(() => { if (!document.hidden) refresh(); }, 5000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(true); });
