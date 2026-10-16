"""Create a small deployment recovery point; wallpaper assets live in a shared backup."""
import argparse
from contextlib import closing
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
from datetime import datetime, timezone
from pathlib import Path


def create_backup(project, destination, wallpapers):
    project, destination, wallpapers = map(lambda path: Path(path).resolve(), (project, destination, wallpapers))
    if destination.exists():
        raise ValueError('Backup destination already exists')
    if not wallpapers.is_dir() or not (wallpapers.parent / 'manifest.json').is_file():
        raise ValueError('A verified, separate wallpaper backup is required')
    manifest = json.loads((wallpapers.parent / 'manifest.json').read_text(encoding='utf-8'))
    for folder in (wallpapers, project / 'data/themes'):
        actual = []
        for path in sorted(folder.rglob('*')):
            if path.is_symlink():
                raise ValueError('Wallpaper backups must not contain symlinks')
            if path.is_file():
                digest = hashlib.sha256()
                with path.open('rb') as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                        digest.update(chunk)
                actual.append([path.relative_to(folder).as_posix(), path.stat().st_size, digest.hexdigest()])
        if not actual or actual != manifest['files']:
            raise ValueError('Wallpaper backup does not match its manifest or current assets')
    destination.mkdir(parents=True, mode=0o700)
    os.chmod(destination, 0o700)
    try:
        commit = subprocess.check_output(['git', '-C', str(project), 'rev-parse', 'HEAD'], text=True).strip()
        (destination / 'previous-commit').write_text(commit + '\n', encoding='utf-8')
        bundle = destination / 'source.bundle'
        subprocess.run(['git', '-C', str(project), 'bundle', 'create', str(bundle), '--all'], check=True, capture_output=True)
        subprocess.run(['git', '-C', str(project), 'bundle', 'verify', str(bundle)], check=True, capture_output=True)
        # The source DB is live: use SQLite's snapshot API rather than copying its files.
        shutil.copytree(project / 'data', destination / 'data', symlinks=True, ignore=lambda folder, names: [
            name for name in names if (Path(folder) == project / 'data' and name in {'themes', 'backups', 'panel.db', 'panel.db-wal', 'panel.db-shm'})
        ])
        source_uri = (project / 'data/panel.db').as_uri() + '?mode=ro'
        with closing(sqlite3.connect(source_uri, uri=True)) as source, closing(sqlite3.connect(destination / 'data/panel.db')) as target:
            source.backup(target)
            target.execute('PRAGMA journal_mode=DELETE')
            if target.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise RuntimeError('Database backup integrity check failed')
        (destination / 'wallpaper-backup.json').write_text(json.dumps({'path': str(wallpapers)}, indent=2) + '\n', encoding='utf-8')
        (destination / 'manifest.json').write_text(json.dumps({
            'schema': 'cyan-panel/deploy-backup-v1', 'commit': commit,
            'created_at': datetime.now(timezone.utc).isoformat(),
            'wallpapers': str(wallpapers),
        }, indent=2) + '\n', encoding='utf-8')
        for path in destination.rglob('*'):
            if path.is_symlink():
                raise ValueError('Unexpected symlink in runtime data')
            os.chmod(path, 0o700 if path.is_dir() else 0o600)
    except Exception:
        # Preserve any partial snapshot for diagnosis, and do not start a deployment.
        raise
    return destination


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('project')
    parser.add_argument('destination')
    parser.add_argument('--wallpapers', required=True)
    args = parser.parse_args()
    print(create_backup(args.project, args.destination, args.wallpapers))
