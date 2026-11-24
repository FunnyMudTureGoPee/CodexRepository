"""Restore the exact T50 native project from release parts (standard library only)."""
import argparse
import hashlib
import json
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def matches(path, record):
    return path.is_file() and path.stat().st_size == record['bytes'] and sha256(path) == record['sha256']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--parts-dir', type=Path, help='Directory of already-downloaded parts; no download when set')
    parser.add_argument('--output', type=Path, default=ROOT / 'latest' / 'source')
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    manifest = json.loads((ROOT / 'BACKUP_MANIFEST.json').read_text(encoding='utf-8'))
    if args.verify_only:
        for name, record in manifest['git_files'].items():
            if not matches(ROOT / name, record):
                raise RuntimeError(f'File missing or checksum mismatch: {name}')
        print(f"Verified {len(manifest['git_files'])} archived files")
        return
    source = manifest['source']
    args.output.mkdir(parents=True, exist_ok=True)
    output = args.output / source['name']
    if output.exists():
        if matches(output, source):
            print(f'Already restored and verified: {output}')
            return
        raise FileExistsError(f'Refusing to overwrite a different file: {output}')
    parts_dir = args.parts_dir or ROOT / '.downloads'
    parts_dir.mkdir(parents=True, exist_ok=True)
    parts = []
    for part in source['parts']:
        if Path(part['name']).name != part['name']:
            raise ValueError('Invalid part name')
        path = parts_dir / part['name']
        if not matches(path, part):
            if args.parts_dir:
                raise RuntimeError(f'Missing or corrupt part: {path}')
            temporary = path.with_name(path.name + '.partial')
            request = urllib.request.Request(part['url'], headers={'User-Agent': 'Live2D-T50-restore'})
            print(f"Downloading {part['name']}", flush=True)
            with urllib.request.urlopen(request, timeout=120) as response, temporary.open('wb') as stream:
                while block := response.read(8 * 1024 * 1024):
                    stream.write(block)
            if not matches(temporary, part):
                raise RuntimeError(f'Checksum mismatch: {temporary}')
            temporary.replace(path)
        parts.append(path)
    temporary = output.with_name(output.name + '.partial')
    with temporary.open('wb') as stream:
        for path in parts:
            with path.open('rb') as part:
                while block := part.read(8 * 1024 * 1024):
                    stream.write(block)
    if not matches(temporary, source):
        raise RuntimeError('Combined source checksum mismatch')
    temporary.replace(output)
    print(f'Restored and SHA-256 verified: {output}')


if __name__ == '__main__':
    main()
