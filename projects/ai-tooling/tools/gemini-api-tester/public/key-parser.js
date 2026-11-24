// Pure local parser. It identifies formatting, not whether a credential is valid.
const FIELD = /^(?:key|api[-_ ]?key|gemini[-_ ]?api[-_ ]?key|google[-_ ]?api[-_ ]?key|openai[-_ ]?api[-_ ]?key|x-goog-api-key|authorization)$/i;
const LIST = /^(?:keys|api[-_ ]?keys)$/i;
const TOKEN = /^[A-Za-z0-9_./~+\-=]+$/;

function unwrap(value) {
  let text = value.trim().replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
  const pairs = { '"': '"', "'": "'", '`': '`', '“': '”', '‘': '’' };
  // Strip punctuation outside quotes before removing matching wrapper quotes.
  text = text.replace(/[,;，；]+$/, '').trim();
  for (let i = 0; i < 4; i++) {
    if (pairs[text[0]] && text.at(-1) === pairs[text[0]]) text = text.slice(1, -1).trim();
    else break;
  }
  return text.replace(/^Bearer\s+/i, '').trim();
}

export function parseKeys(source, { allowBareShort = false } = {}) {
  const keys = [];
  const known = new Set();
  let ignored = 0, duplicates = 0;
  if (typeof source !== 'string' || source.length > 100000) return { keys, ignored: 1, duplicates, error: '粘贴内容过长，最多 100000 个字符' };
  const text = source.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim();
  const add = (raw, label = '', explicit = false) => {
    if (typeof raw !== 'string') { ignored++; return; }
    const value = unwrap(raw);
    // Explicit fields support relay-specific short tokens; free text is stricter.
    const plausible = explicit || allowBareShort || (/^(?:AIza|sk-)/.test(value) && value.length >= 8) || (value.length >= 4 && /[\d_./~+\-]/.test(value)) || value.length >= 20;
    if (!value || value.length > 8192 || !TOKEN.test(value) || !plausible || (/^AIza/.test(value) && !/^AIza[A-Za-z0-9_-]{35}$/.test(value)) || /^https?:/i.test(value) || /^\$|^YOUR[_-]|^<|^\.{2,}$|^(?:undefined|null|true|false|Bearer)$/i.test(value)) { ignored++; return; }
    if (known.has(value)) { duplicates++; return; }
    known.add(value); keys.push({ value, label: String(label).slice(0, 100) });
  };
  const lines = value => {
    for (let line of value.split(/\r?\n/)) {
      line = line.trim();
      if (!line || /^\s*(?:#|\/\/|```)/.test(line)) continue;
      let matched = false;
      // URL keys are decoded via URLSearchParams. Never import other URL values.
      const urls = line.match(/https?:\/\/[^\s"'<>`]+/g) || [];
      for (const raw of urls) {
        try {
          const url = new URL(raw);
          for (const [name, token] of url.searchParams) if (FIELD.test(name)) { add(token, '', true); matched = true; }
        } catch { /* Malformed URLs are counted as unrecognized below. */ }
      }
      // Request headers, .env assignments, JSON-like snippets, and curl -H.
      const assignment = /(?:^|[\s{"',])(?:export\s+|set\s+|\$env:)?["']?(api[-_ ]?key|gemini[-_ ]?api[-_ ]?key|google[-_ ]?api[-_ ]?key|openai[-_ ]?api[-_ ]?key|x-goog-api-key|authorization|key)["']?\s*[:=]\s*(?:["'“‘]\s*)?(?:Bearer\s+)?([^\s"'”’`,;，；}\]]+)/gi;
      for (const match of line.matchAll(assignment)) { add(match[2], '', true); matched = true; }
      if (matched) continue;
      if (/^Bearer\s+/i.test(unwrap(line))) { add(unwrap(line), '', true); continue; }
      // Bare Bearer values also work after unwrap removes the prefix.
      if (/^["'“‘`]?Bearer\s+/i.test(line)) { add(line, '', true); continue; }
      const pipe = line.indexOf('|');
      if (pipe !== -1) { add(line.slice(pipe + 1), unwrap(line.slice(0, pipe)), true); continue; }
      if (urls.length) { ignored++; continue; }
      const parts = line.split(/[,，;；\t ]+/).filter(Boolean);
      // Handle a whole delimiter-separated list before looking for keys in prose,
      // so a Google key does not hide a relay key on the same line.
      if (!/^[A-Za-z_][A-Za-z0-9_-]*=[^=]/.test(line) && parts.every(part => TOKEN.test(unwrap(part)))) {
        for (const part of parts) add(part);
        continue;
      }
      // Recognizable Google / common relay keys embedded in explanatory text.
      const embedded = [...line.matchAll(/(?:^|[\s"'“‘`:=,，;；(（])((?:AIza|sk-)[A-Za-z0-9_-]{8,})(?=$|[\s"'”’`,，;；)）])/g)];
      if (embedded.length) { for (const match of embedded) add(match[1]); continue; }
      if (/[:={}\[\]]/.test(line)) { ignored++; continue; }
      ignored++;
    }
  };
  if (!text) return { keys, ignored, duplicates };
  let data;
  try { data = JSON.parse(text); } catch { /* Also accept non-JSON formats. */ }
  if (data !== undefined) {
    const walk = (value, inList = false, depth = 0) => {
      if (depth > 12) { ignored++; return; }
      if (typeof value === 'string') { if (inList) add(value, '', true); else lines(value); return; }
      if (Array.isArray(value)) { value.forEach(item => walk(item, true, depth + 1)); return; }
      if (!value || typeof value !== 'object') return;
      const label = typeof value.label === 'string' ? value.label : typeof value.name === 'string' ? value.name : '';
      for (const [name, item] of Object.entries(value)) {
        if (FIELD.test(name) || (inList && name === 'value')) add(item, label, true);
        else if (LIST.test(name)) walk(item, true, depth + 1);
        else if (item && typeof item === 'object') walk(item, false, depth + 1);
      }
    };
    walk(data);
    if (!keys.length && !ignored) ignored++;
  } else lines(text);
  return { keys, ignored, duplicates };
}
