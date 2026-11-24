import json
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
import unittest

from server import Settings


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.settings = Settings(self.directory.name)

    def save(self, value):
        return self.settings.save(value, self.settings.state()['revision'])

    def test_default_boundaries_backup_and_other_settings(self):
        self.assertEqual(self.settings.state()['selectedK'], 512)
        original = b'# preserve\r\nmodel = "demo"\r\n[features]\r\nenabled = true\r\n'
        self.settings.path.write_bytes(original)
        for value in [256, 512, 1024]:
            result = self.save(value)
            parsed = tomllib.loads(self.settings.path.read_text())
            self.assertEqual(parsed, {'model_context_window': value * 1000, 'model': 'demo', 'features': {'enabled': True}})
            self.assertEqual(self.settings.state()['selectedK'], value)
            self.assertTrue(Path(result['backupPath']).exists())
        backups = sorted(self.settings.path.parent.glob('config.toml.context-backup-*'))
        self.assertEqual(backups[0].read_bytes(), original)

    def test_profiles_multiline_comments_and_bom_preserved(self):
        original = ('# heading\n"model_context_window" = 400_000 # window\n'
                    'notes = """\nmodel_context_window = 200\n[looks_like_table]\n"""\n'
                    '[profiles.work]\nmodel_context_window = 300000\n')
        self.settings.path.write_bytes(b'\xef\xbb\xbf' + original.encode())
        self.save(512)
        updated = self.settings.path.read_bytes()
        expected = original.replace('400_000', '512000')
        self.assertEqual(updated, b'\xef\xbb\xbf' + expected.encode())

    def test_reject_invalid_and_stale_without_writing(self):
        self.save(512)
        initial = self.settings.path.read_bytes()
        revision = self.settings.state()['revision']
        for value in [255, 1025, 512.0, True, '512']:
            with self.assertRaises(ValueError):
                self.settings.save(value, revision)
        self.assertEqual(self.settings.path.read_bytes(), initial)
        self.settings.path.write_bytes(initial + b'\n# external edit\n')
        with self.assertRaises(ValueError):
            self.settings.save(256, revision)
        self.assertEqual(self.settings.path.read_bytes(), initial + b'\n# external edit\n')

    def test_malformed_config_is_not_overwritten(self):
        self.settings.path.write_bytes(b'model = [')
        with self.assertRaises(ValueError):
            self.save(512)
        self.assertEqual(self.settings.path.read_bytes(), b'model = [')

    def test_stdio_protocol_and_resource(self):
        messages = [
            {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-11-25'}},
            {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
            {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'read_context_window'}},
            {'jsonrpc': '2.0', 'id': 4, 'method': 'resources/read', 'params': {'uri': 'ui://codex-context-window/panel.html'}}]
        process = subprocess.run([sys.executable, '-B', str(Path(__file__).with_name('server.py')), '--codex-home', self.directory.name],
                                 input='\n'.join(map(json.dumps, messages))+'\n', capture_output=True, text=True, check=True)
        replies = [json.loads(line) for line in process.stdout.splitlines()]
        self.assertEqual([r['id'] for r in replies], [1, 2, 3, 4])
        self.assertEqual(len(replies[1]['result']['tools']), 3)
        self.assertEqual(replies[2]['result']['structuredContent']['selectedK'], 512)
        self.assertEqual(replies[3]['result']['contents'][0]['mimeType'], 'text/html;profile=mcp-app')


if __name__ == '__main__':
    unittest.main()
