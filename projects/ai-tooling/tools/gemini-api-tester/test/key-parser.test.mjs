import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKeys } from '../public/key-parser.js';

const google = 'AIza' + 'A'.repeat(35);
const relay = 'sk-demo_1234567890';
const values = text => parseKeys(text).keys.map(k => k.value);

test('recognizes raw, quoted and invisible-character keys', () => {
  for (const input of [google, ` "${google}" `, `‘${google}’`, `\uFEFF${google.slice(0, 10)}\u200B${google.slice(10)}`]) assert.deepEqual(values(input), [google]);
});
test('supports newline, comma, Chinese comma, semicolon and spaces; removes duplicates', () => {
  const result = parseKeys(`${google}, ${relay}\n${google}；demo-valid-key`);
  assert.deepEqual(result.keys.map(k => k.value), [google, relay, 'demo-valid-key']); assert.equal(result.duplicates, 1);
});
test('extracts headers, Bearer and curl without importing other header values', () => {
  for (const input of [`Bearer ${relay}`, `"Bearer ${relay}"`, `Authorization: Bearer ${relay}`, `x-goog-api-key: ${google}`, `curl https://example.com -H "Content-Type: application/json" -H 'x-goog-api-key: ${google}' -d '{}'`]) assert.deepEqual(values(input), [input.includes(google) ? google : relay]);
});
test('supports env, export, Windows and PowerShell assignments', () => {
  for (const input of [`GEMINI_API_KEY="${google}"`, `export GOOGLE_API_KEY='${google}'`, `set OPENAI_API_KEY=${relay}`, `$env:GEMINI_API_KEY = '${google}'`, `api_key: "${relay}"`]) assert.deepEqual(values(input), [input.includes(google) ? google : relay]);
});
test('reads URL key query only and decodes it without importing the URL', () => {
  assert.deepEqual(values(`https://example.com/v1beta/models?key=${google}&model=wrong`), [google]);
  assert.deepEqual(values('https://example.com?api_key=custom%2Bkey%3D'), ['custom+key=']);
  assert.deepEqual(values('https://example.com?model=mock-flash'), []);
});
test('JSON recognizes known fields and key arrays; ignores unrelated strings', () => {
  const result = parseKeys(JSON.stringify({ model: 'mock-flash', url: 'https://example.com', password: 'dont-import-password', settings: { apiKey: google }, keys: [{ label: '中转', value: relay }, { name: '重复', key: google }] }));
  assert.deepEqual(result.keys, [{ value: google, label: '' }, { value: relay, label: '中转' }]); assert.equal(result.duplicates, 1);
  assert.deepEqual(values(JSON.stringify([google, relay])), [google, relay]);
  assert.deepEqual(values(JSON.stringify({ authorization: `Bearer ${relay}` })), [relay]);
});
test('preserves optional remarks and supports JSON-like config lines', () => {
  assert.deepEqual(parseKeys(`官方 | "${google}"`).keys, [{ label: '官方', value: google }]);
  assert.deepEqual(values(`"apiKey": "${relay}",`), [relay]);
});
test('rejects placeholders, unknown config fields and incomplete Google keys', () => {
  for (const input of ['YOUR_API_KEY', '${GEMINI_API_KEY}', 'Bearer', 'api_key=YOUR_API_KEY', 'model=mock-flash', 'Content-Type: application/json', 'AIzaTooShort', `key=${google}EXTRA`, 'this is ordinary explanatory prose']) assert.deepEqual(values(input), [], input);
});
test('never joins internal spaces to manufacture a credential', () => {
  const broken = google.slice(0, 20) + ' ' + google.slice(20);
  assert.ok(!values(broken).includes(google)); assert.ok(parseKeys(broken).ignored > 0);
  assert.deepEqual(values(`api_key="${broken}"`), []);
});
test('reports mixed invalid items and limits input size', () => {
  const result = parseKeys(`${relay}\nnot a credential\n${google}`);
  assert.equal(result.keys.length, 2); assert.ok(result.ignored > 0);
  assert.ok(parseKeys('x'.repeat(100001)).error);
});
test('explicit short relay tokens remain usable after normalization', () => {
  const [key] = parseKeys('api_key=abc').keys;
  assert.equal(key.value, 'abc');
  assert.deepEqual(parseKeys(key.value, { allowBareShort: true }).keys.map(k => k.value), ['abc']);
  assert.deepEqual(parseKeys('YOUR_API_KEY', { allowBareShort: true }).keys, []);
});
