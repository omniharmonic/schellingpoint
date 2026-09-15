"""Fault injection: a failed dump must never be uploaded as a successful backup."""
from pathlib import Path
import os
import subprocess
import tempfile

source = Path('deploy/unconference/backup.sh').read_text()
for mode in ('once', 'loop'):
    with tempfile.TemporaryDirectory(prefix='unconference-backup-check-') as scratch:
        root = Path(scratch)
        commands = root / 'bin'
        commands.mkdir()
        (root / 'pds').mkdir()
        (root / 'pds' / 'account.sqlite').touch()
        for name, script in {
            'pg_dump': 'exit 42',
            'age': 'cat',
            'du': 'echo 12 scratch-backup',
            'sqlite3': 'exit 0',
            'aws': f'touch "{root / "uploaded"}"',
            'sleep': 'exit 17',
            'date': 'if [ "$2" = "+%H" ]; then echo 03; else echo test-backup; fi',
        }.items():
            path = commands / name
            path.write_text('#!/bin/sh\n' + script + '\n')
            path.chmod(0o700)
        executable = root / 'backup.sh'
        executable.write_text(source.replace('/usr/local/bin/backup.sh', str(executable))
            .replace('/backups', str(root / 'backups'))
            .replace('(cd /pds ', '(cd ' + str(root / 'pds') + ' ')
            .replace('"/pds/', '"' + str(root / 'pds') + '/')
            .replace('-d /pds/', '-d ' + str(root / 'pds') + '/')
            .replace('-C /pds ', '-C ' + str(root / 'pds') + ' '))
        executable.chmod(0o700)
        # Bash supplies pipefail on macOS; production uses Alpine's ash, which also supports it.
        env = {**os.environ, 'PATH': str(commands) + ':' + os.environ['PATH'],
               'BACKUP_AGE_RECIPIENT': 'test', 'BACKUP_S3_BUCKET': 'test', 'BACKUP_S3_ENDPOINT': 'test', 'BACKUP_HOUR_UTC': '3'}
        result = subprocess.run(['bash', str(executable)] + (['--loop'] if mode == 'loop' else []),
                                env=env, capture_output=True, timeout=10)
        assert result.returncode != 0, f'{mode}: dump failure was swallowed'
        assert not (root / 'uploaded').exists(), f'{mode}: broken backup was uploaded'
        print(f'PASS: {mode} backup refuses a failed database dump')
