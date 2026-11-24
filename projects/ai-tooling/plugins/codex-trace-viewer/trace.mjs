import { createReadStream, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const home = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
const uuid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
export const threadIdPattern = new RegExp('^' + uuid + '$', 'i');
const filenamePattern = new RegExp('^rollout-.*-(' + uuid + ')\\.jsonl$', 'i');

const name = (value) => typeof value === 'string' && /^[\w.:/@-]{1,160}$/.test(value) ? value : '';
const preview = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
const time = (value) => typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value) || null;
const timeMs = (value) => typeof value === 'number' ? value : null;
const ms = (value) => Number.isFinite(value) && value >= 0 ? value : null;
const failureStatuses = new Set(['failed', 'declined', 'aborted', 'cancelled', 'canceled', 'timeout']);

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((entry) => typeof entry === 'string' ? entry : entry?.text || '').join('\n');
}

function resultError(result) {
  return result?.isError === true || result?.success === false || result?.structuredContent?.success === false ||
    Boolean(result?.error || result?.structuredContent?.error);
}

function errorMessage(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return [typeof value.code === 'number' || typeof value.code === 'string' ? String(value.code) : '',
    typeof value.message === 'string' ? value.message : '', typeof value.details === 'string' ? value.details : '']
    .filter(Boolean).join(' · ');
}

function diagnosticText(...parts) {
  const text = [...new Set(parts.map((part) => messageText(part).trim()).filter(Boolean))].join('\n')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/(\bBearer\s+)[^\s"',;]+/gi, '$1[已隐藏]')
    .replace(/\b(?:sk-[\w-]{16,}|gh[pousr]_[\w]{16,}|github_pat_[\w]{16,})\b/g, '[已隐藏]')
    .replace(/(["']?(?:api[_-]?key|(?:access|refresh)[_-]?token|password|secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, '$1[已隐藏]');
  return text.length <= 3600 ? text : text.slice(0, 1400) + '\n…（中间内容省略）…\n' + text.slice(-2100);
}

function diagnostic(status, exitCode, ...parts) {
  if (!failureStatuses.has(status)) return undefined;
  return { text: diagnosticText(...parts), exitCode: Number.isInteger(exitCode) ? exitCode : undefined };
}

function outputFailure(payload) {
  const { output } = payload;
  const text = messageText(output);
  let result = output;
  if (text.trimStart().startsWith('{')) {
    try { result = JSON.parse(text); } catch { /* Free-form tool output. */ }
  }
  const exit = /^(?:Process exited with code |Exit code:\s*)(-?\d+)\s*$/im.exec(text.trimStart().slice(0, 600));
  const exitCode = exit ? Number(exit[1]) : result?.exitCode ?? result?.exit_code;
  const failed = payload.is_error === true || payload.success === false || resultError(result) ||
    (Number.isInteger(exitCode) && exitCode !== 0) ||
    /^Script (?:failed|error)\b/i.test(text.trimStart());
  if (!failed) return undefined;
  return diagnostic('failed', exitCode, errorMessage(result?.error ?? result?.structuredContent?.error),
    messageText(result?.content) || errorMessage(result?.message) || (result === output ? text : ''));
}

function mcpLabels(server, tool) {
  const labels = ['工具', 'MCP 调用'];
  if ((server === 'codex_apps' && tool.includes('.')) || server.startsWith('codex_apps__')) {
    labels.push('插件调用', server === 'codex_apps' ? tool.split('.')[0] : server.split('__')[1]);
  } else if (server.startsWith('plugin:')) {
    labels.push('插件调用', server.split(':')[1]);
  }
  return labels.filter(Boolean);
}

function toolEvent(server, tool, status, duration) {
  return {
    lane: 'tool', title: server ? server + ' · ' + tool : tool,
    tags: server ? mcpLabels(server, tool) : ['工具'],
    status, duration
  };
}

function skillReads(command) {
  const line = Array.isArray(command) ? command.join(' ') : command;
  if (typeof line !== 'string' || !/\b(?:Get-Content|cat|type|head|sed|bat|more)\b/i.test(line)) return [];
  return [...new Set([...line.matchAll(/(?:^|[\\/'"\s])([\w.-]+)[\\/]SKILL\.md\b/gi)].map((m) => m[1]))];
}

export async function parseRollout(file) {
  const turns = new Map();
  let active;
  let seq = 0;
  const stream = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });

  function getTurn(id) {
    if (!turns.has(id)) turns.set(id, { id, started: null, ended: null, duration: null, status: 'unknown', rows: new Map() });
    return turns.get(id);
  }

  for await (const line of stream) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const p = record?.payload;
    if (!p || typeof p !== 'object') continue;
    const timestamp = time(record.timestamp);
    if (record.type === 'turn_context' || (record.type === 'event_msg' && ['task_started', 'turn_started'].includes(p.type))) {
      active = p.turn_id || active || 'legacy-' + seq;
      const turn = getTurn(active);
      turn.started ??= time(p.started_at) ?? timestamp;
      turn.status = 'running';
      continue;
    }

    const isItem = record.type === 'event_msg' && ['item_started', 'item_completed'].includes(p.type);
    const id = (isItem || record.type === 'event_msg') && p.turn_id || active;
    if (!id) continue;
    const turn = getTurn(id);
    if (record.type === 'event_msg' && ['task_complete', 'turn_completed', 'turn_aborted'].includes(p.type)) {
      turn.ended = time(p.completed_at) ?? timestamp;
      turn.duration = ms(p.duration_ms);
      turn.status = p.type === 'turn_aborted' ? 'aborted' : 'completed';
      if (id === active) active = null;
      continue;
    }

    function add(key, row, start = timestamp) {
      const previous = turn.rows.get(key);
      turn.rows.set(key, { ...previous, ...row, start: previous?.start ?? start, seq: previous?.seq ?? ++seq });
    }

    function addMessage(role, raw, key, source, phase, start = timestamp) {
      let content = messageText(raw);
      if (role === 'user') {
        content = content.replace(/<skill>\s*<name>([\w.:-]+)<\/name>\s*<path>[^<]*[\\/]SKILL\.md<\/path>[\s\S]*?<\/skill>/gi, (_, skill) => {
          add('skill-load:' + skill, { lane: 'tool', title: skill, tags: ['Skill', '已加载'] }, start);
          return '';
        });
        for (const match of content.matchAll(/\[(@[^\]\r\n]{1,100})\]\(plugin:\/\/[^)\s]+\)/g)) {
          add('plugin-ref:' + match[1], { lane: 'input', title: match[1], tags: ['插件提及'] }, start);
        }
      }
      const text = preview(content);
      if (text) add(key, {
        lane: role === 'user' ? 'input' : 'model', role, source,
        title: role === 'user' ? '用户输入' : phase === 'commentary' ? '助手进度' : '助手回复',
        text, tags: [role === 'user' ? '输入' : '助手']
      }, start);
    }

    if (isItem && p.item) {
      const item = p.item;
      const start = timeMs(p.started_at_ms) ?? timestamp;
      const end = timeMs(p.completed_at_ms);
      const pending = p.type === 'item_started';
      const duration = start !== null && end !== null ? ms(end - start) : null;
      let status = pending ? 'running' : name(item.status) || 'completed';
      const key = 'item:' + (item.id || seq);
      switch (item.type) {
        case 'UserMessage':
          addMessage('user', item.content, key, 'item', null, start);
          break;
        case 'AgentMessage':
          addMessage('assistant', item.content, key, 'item', item.phase, start);
          break;
        case 'McpToolCall':
        case 'DynamicToolCall': {
          const server = name(item.server);
          const tool = name(item.tool) || '工具调用';
          const result = item.result;
          if (status === 'completed' && resultError(result)) status = 'failed';
          add(key, { ...toolEvent(server, tool, status, duration), diagnostic: diagnostic(status, undefined,
            errorMessage(item.error ?? result?.error ?? result?.structuredContent?.error),
            result?.content ?? (typeof result === 'string' ? result : result?.structuredContent?.message)) }, start);
          if (item.id) turn.rows.delete('call:' + item.id);
          break;
        }
        case 'CommandExecution': {
          if (status === 'completed' && Number.isInteger(item.exit_code) && item.exit_code !== 0) status = 'failed';
          add(key, { lane: 'tool', title: 'Shell 命令', tags: ['工具', 'Shell'], status, duration,
            diagnostic: diagnostic(status, item.exit_code, item.stderr || item.aggregated_output, errorMessage(item.error)) }, start);
          if (!pending && status === 'completed' && (item.exit_code == null || item.exit_code === 0)) {
            for (const skill of skillReads(item.command)) {
              add(key + ':' + skill, { lane: 'tool', title: skill, tags: ['Skill', '读取线索'] }, end ?? start);
            }
          }
          break;
        }
        case 'Extension':
          if (status === 'completed' && item.failure) status = 'failed';
          add(key, { lane: 'tool', title: name(item.kind) || '扩展调用', tags: ['工具', '扩展'], status, duration,
            diagnostic: diagnostic(status, undefined, errorMessage(item.failure ?? item.error)) }, start);
          break;
        case 'WebSearch':
        case 'FileChange':
        case 'ImageView':
          add(key, {
            lane: 'tool', title: { WebSearch: '网页搜索', FileChange: '文件变更', ImageView: '查看图片' }[item.type],
            tags: ['工具'], status, duration, diagnostic: diagnostic(status, undefined, item.stderr, errorMessage(item.error))
          }, start);
          break;
        case 'ContextCompaction':
          add(key, { lane: 'model', title: '上下文压缩', tags: ['会话'], status, duration }, start);
          break;
      }
    } else if (record.type === 'response_item') {
      if (p.type === 'message' && ['assistant', 'user'].includes(p.role)) {
        addMessage(p.role, p.content, 'message:' + (p.id || seq), 'raw', p.phase);
      } else if (['function_call', 'custom_tool_call'].includes(p.type) && p.call_id) {
        const toolName = name(p.name) || '工具调用';
        const qualified = /^mcp__(.+?)__(.+)$/.exec(toolName);
        const row = toolEvent(qualified?.[1], qualified?.[2] || [name(p.namespace), toolName].filter(Boolean).join('.'), 'running', null);
        if (toolName === 'exec' && p.type === 'custom_tool_call' && (!p.namespace || p.namespace === 'functions')) {
          row.title = 'functions.exec';
          row.tags = ['工具', '批次'];
        }
        if (!turn.rows.has('item:' + p.call_id) && !turn.rows.has('item:' + p.id)) add('call:' + p.call_id, row);
      } else if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
        const row = turn.rows.get('call:' + p.call_id);
        if (row) {
          row.diagnostic = outputFailure(p);
          row.status = row.diagnostic ? 'failed' : 'returned';
          row.duration = row.start !== null && timestamp !== null ? ms(timestamp - row.start) : null;
        }
      }
    } else if (record.type === 'event_msg') {
      if (p.type === 'user_message') addMessage('user', p.message, 'legacy-user:' + seq, 'event');
      if (p.type === 'agent_message') addMessage('assistant', p.message, 'legacy-agent:' + seq, 'event', p.phase);
    }
  }

  return [...turns.values()].map((turn, index) => {
    const rows = [...turn.rows.values()];
    const best = {};
    const rank = { item: 3, raw: 2, event: 1 };
    for (const row of rows) {
      if (row.role) best[row.role] = Math.max(best[row.role] || 0, rank[row.source]);
    }
    const events = rows.filter((row) => !row.role || rank[row.source] === best[row.role])
      .sort((a, b) => (a.start ?? turn.started ?? 0) - (b.start ?? turn.started ?? 0) || a.seq - b.seq);
    const counts = { tools: 0, mcp: 0, batches: 0, failures: 0 };
    for (const event of events) {
      if (event.tags.includes('批次')) counts.batches++;
      else if (event.tags.includes('工具')) counts.tools++;
      if (event.tags.includes('MCP 调用')) counts.mcp++;
      if (event.diagnostic) {
        event.tags.push('失败');
        counts.failures++;
      }
    }
    return { ...turn, rows: undefined, number: index + 1, events, counts };
  });
}

let index, indexAt = 0;
function sessionIndex() {
  if (index && Date.now() - indexAt < 10_000) return index;
  const candidates = [];
  for (const dir of ['sessions', 'archived_sessions']) {
    const root = join(home, dir);
    let entries;
    try { entries = readdirSync(root, { recursive: true, withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      const match = filenamePattern.exec(entry.name);
      if (!entry.isFile() || !match) continue;
      candidates.push({ id: match[1].toLowerCase(), file: join(entry.parentPath, entry.name), root, archived: dir === 'archived_sessions' });
    }
  }
  // Rollout filenames start with an ISO-like creation timestamp.
  candidates.sort((a, b) => basename(b.file).localeCompare(basename(a.file)) || Number(a.archived) - Number(b.archived));
  index = new Map();
  for (const session of candidates) if (!index.has(session.id)) index.set(session.id, session);
  indexAt = Date.now();
  return index;
}

function safeFile(file, root) {
  const real = realpathSync(file);
  const offset = relative(realpathSync(home), real);
  const expected = relative(realpathSync(root), real);
  if (offset.startsWith('..') || isAbsolute(offset) || expected.startsWith('..') || isAbsolute(expected)) {
    throw new Error('会话文件超出本地日志目录。');
  }
  return real;
}

export function listSessions() {
  const titles = new Map();
  try {
    const file = join(home, 'session_index.jsonl');
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      try {
        const entry = JSON.parse(line);
        if (threadIdPattern.test(entry.id)) titles.set(entry.id.toLowerCase(), preview(entry.thread_name));
      } catch { /* A write may be in progress. */ }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  return [...sessionIndex().values()].slice(0, 60).map(({ id, file, archived }) => ({
    id, archived, title: titles.get(id) || '会话 ' + id.slice(0, 8),
    date: basename(file).slice(8, 18)
  }));
}

const cache = new Map();
export async function readTrace(id, requestedTurn) {
  if (typeof id !== 'string' || !threadIdPattern.test(id)) throw new Error('请填写有效的会话 UUID。');
  const session = sessionIndex().get(id.toLowerCase());
  if (!session) throw new Error('本机未找到该会话的 JSONL 日志。');
  const file = safeFile(session.file, session.root);
  const { mtimeMs, size } = statSync(file);
  const version = mtimeMs + ':' + size;
  let entry = cache.get(file);
  if (entry?.version !== version) {
    entry = { version, turns: parseRollout(file) };
    if (cache.size >= 5) cache.delete(cache.keys().next().value);
    cache.set(file, entry);
  }
  let turns;
  try { turns = await entry.turns; } catch (error) {
    if (cache.get(file) === entry) cache.delete(file);
    throw error;
  }
  const selected = requestedTurn ? turns.find((turn) => turn.id === requestedTurn) : turns.at(-1);
  if (requestedTurn && !selected) throw new Error('该轮次已不在此会话中。');

  return {
    id: session.id, version,
    turns: turns.map(({ id, number, started, ended, duration, status, events }) => ({
      id, number, started, ended, duration, status, events: events.length,
      title: events.find((event) => event.role === 'user')?.text?.slice(0, 65) || '无输入预览'
    })),
    selected: selected ? { ...selected, events: selected.events.slice(0, 800), totalEvents: selected.events.length } : null
  };
}
