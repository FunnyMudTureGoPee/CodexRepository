"""Local MCP app for the single Codex context-window configuration key."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import tomllib
from datetime import datetime

KEY = 'model_context_window'
URI = 'ui://codex-context-window/panel.html'
MIME = 'text/html;profile=mcp-app'
ROOT = Path(__file__).resolve().parent


class Settings:
    def __init__(self, home):
        self.path = Path(home) / 'config.toml'

    def read(self):
        raw = self.path.read_bytes() if self.path.exists() else b''
        data = tomllib.loads(raw.decode('utf-8-sig'))
        return raw, data

    def state(self):
        raw, data = self.read()
        value = data.get(KEY)
        return {'tokens': value, 'selectedK': min(1024, max(256, round(value / 1000))) if type(value) is int else 512,
                'defaultK': 512, 'minK': 256, 'maxK': 1024,
                'revision': hashlib.sha256(raw).hexdigest(), 'configPath': str(self.path),
                'model': data.get('model'), 'autoCompactTokens': data.get('model_auto_compact_token_limit'),
                'hasProfileOverrides': any(KEY in p for p in data.get('profiles', {}).values() if isinstance(p, dict))}

    def save(self, window_k, revision):
        if type(window_k) is not int or not 256 <= window_k <= 1024:
            raise ValueError('上下文窗口必须为 256–1024 之间的整数（k tokens）。')
        raw, data = self.read()
        if revision != hashlib.sha256(raw).hexdigest():
            raise ValueError('配置已在其他位置更改，请重新读取后再应用。')
        tokens = window_k * 1000
        if data.get(KEY) == tokens:
            return {**self.state(), 'saved': True, 'changed': False}
        source = raw.decode('utf-8-sig')
        expected = {**data, KEY: tokens}
        newline = '\r\n' if '\r\n' in source else '\n'
        if KEY not in data:
            updated = f'{KEY} = {tokens}{newline}' + source
        else:
            # Verify the complete parsed document after a surgical replacement.
            # This also excludes similarly named profile keys or multiline strings.
            pattern = r'(?m)^(\s*(?:model_context_window|"model_context_window"|\'model_context_window\')\s*=\s*)([^\r\n#]+)'
            updated = None
            for match in re.finditer(pattern, source):
                candidate = source[:match.start(2)] + str(tokens) + ' ' + source[match.end(2):]
                try:
                    if tomllib.loads(candidate) == expected:
                        updated = candidate
                        break
                except tomllib.TOMLDecodeError:
                    pass
            if updated is None:
                raise ValueError('无法保留原格式更新上下文配置，请检查该配置项的写法。')
        if tomllib.loads(updated) != expected:
            raise ValueError('配置验证失败，未保存。')
        output = (b'\xef\xbb\xbf' if raw.startswith(b'\xef\xbb\xbf') else b'') + updated.encode('utf-8')
        self.path.parent.mkdir(parents=True, exist_ok=True)
        backup = None
        if self.path.exists():
            backup = self.path.with_name('config.toml.context-backup-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
            backup.write_bytes(raw)
        descriptor, temporary = tempfile.mkstemp(prefix='.context-', suffix='.tmp', dir=self.path.parent)
        try:
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(output)
                stream.flush()
                os.fsync(stream.fileno())
            if self.read()[0] != raw:
                raise ValueError('保存前配置发生变化，请重新读取后再应用。')
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return {**self.state(), 'saved': True, 'changed': True, 'backupPath': str(backup) if backup else None}


EMPTY = {'type': 'object', 'properties': {}, 'additionalProperties': False}
TOOLS = [
    {'name': 'open_context_window', 'title': '上下文窗口',
     'description': 'Open the Codex context window slider (256k–1024k, default 512k).',
     'inputSchema': EMPTY, 'annotations': {'readOnlyHint': True, 'openWorldHint': False},
     '_meta': {'ui': {'resourceUri': URI}, 'openai/ui': {'entrypoints': [{'type': 'global'}, {'type': 'thread'}]}}},
    {'name': 'read_context_window', 'description': 'Read the saved local Codex context-window setting.',
     'inputSchema': EMPTY, 'annotations': {'readOnlyHint': True, 'openWorldHint': False}},
    {'name': 'set_context_window', 'description': 'Save the requested context window to local Codex config.toml, preserving other settings and creating a backup. Does not modify the active conversation or model capacity.',
     'inputSchema': {'type': 'object', 'properties': {'window_k': {'type': 'integer', 'minimum': 256, 'maximum': 1024}, 'revision': {'type': 'string'}}, 'required': ['window_k', 'revision'], 'additionalProperties': False},
     'annotations': {'readOnlyHint': False, 'destructiveHint': False, 'idempotentHint': True, 'openWorldHint': False}}
]


def resource():
    markup = (ROOT / 'panel.html').read_text(encoding='utf-8')
    script = (ROOT / 'panel.js').read_text(encoding='utf-8')
    return {'uri': URI, 'mimeType': MIME, 'text': markup.replace('<!-- SCRIPT -->', '<script>' + script + '</script>'),
            '_meta': {'ui': {'csp': {'connectDomains': [], 'resourceDomains': []}},
                      'openai/ui': {'availableDisplayModes': ['inline', 'fullscreen'], 'preferredDisplayMode': 'fullscreen'}}}


def dispatch(settings, method, params):
    if method == 'initialize':
        supported = ('2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25')
        version = params.get('protocolVersion')
        return {'protocolVersion': version if version in supported else supported[-1],
                'capabilities': {'tools': {}, 'resources': {}}, 'serverInfo': {'name': 'codex-context-window', 'version': '0.1.0'}}
    if method == 'ping':
        return {}
    if method == 'tools/list':
        return {'tools': TOOLS}
    if method == 'resources/list':
        return {'resources': [{'uri': URI, 'name': '上下文窗口', 'mimeType': MIME}]}
    if method == 'resources/templates/list':
        return {'resourceTemplates': []}
    if method == 'resources/read' and params.get('uri') == URI:
        return {'contents': [resource()]}
    if method == 'tools/call':
        try:
            name = params.get('name')
            args = params.get('arguments') or {}
            if name in ('open_context_window', 'read_context_window'):
                value = settings.state()
            elif name == 'set_context_window':
                value = settings.save(args['window_k'], args['revision'])
            else:
                raise ValueError('未知操作。')
            return {'content': [{'type': 'text', 'text': json.dumps(value, ensure_ascii=False)}], 'structuredContent': value}
        except (ValueError, TypeError, KeyError, OSError) as error:
            return {'isError': True, 'content': [{'type': 'text', 'text': str(error)}]}
    raise LookupError(method)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--codex-home', default=os.environ.get('CODEX_HOME') or str(Path.home() / '.codex'))
    parser.add_argument('--apply', type=int, help='Apply a value in k tokens without opening the panel.')
    args = parser.parse_args()
    settings = Settings(args.codex_home)
    if args.apply is not None:
        print(json.dumps(settings.save(args.apply, settings.state()['revision']), ensure_ascii=True))
        return
    for line in sys.stdin.buffer:
        try:
            message = json.loads(line)
        except (ValueError, UnicodeError):
            response = {'id': None, 'error': {'code': -32700, 'message': 'Parse error'}}
        else:
            if not isinstance(message, dict) or 'id' not in message:
                continue
            try:
                response = {'id': message['id'], 'result': dispatch(settings, message.get('method'), message.get('params') or {})}
            except LookupError:
                response = {'id': message['id'], 'error': {'code': -32601, 'message': 'Unknown method or resource'}}
            except Exception as error:
                print(str(error), file=sys.stderr)
                response = {'id': message['id'], 'error': {'code': -32603, 'message': 'Request failed'}}
        print(json.dumps({'jsonrpc': '2.0', **response}, ensure_ascii=True), flush=True)


if __name__ == '__main__':
    main()
