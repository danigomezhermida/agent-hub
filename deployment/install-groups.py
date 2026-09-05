"""Explicit local plugin activation. Requires user production approval.

Does not restart services, push Git, or modify the database. Backend first;
verify authenticated canary before frontend publication. Shared adapter remains
pinned to limpatexdev-cloud (never replace it with the profile API source).
"""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import hashlib
import shutil


def install():
    repo=Path(__file__).resolve().parents[1]
    source=repo/'hermes-plugin'
    profile=Path('/opt/data/profiles/limpatexdev-cloud/plugins/agent-hub')
    shared=Path('/opt/data/plugins/agent-hub')
    backup=Path('/opt/data/profiles/limpatexdev-cloud/backups')/('agenthub-before-groups-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    if not (shared/'dashboard/plugin_api.py').is_file():
        raise RuntimeError('Shared profile adapter missing; do not guess startup layout')
    for name,target in [('profile',profile),('shared',shared)]:
        shutil.copytree(target,backup/name,ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
        for old in target.rglob('*'):
            if old.is_file() and '__pycache__' not in old.parts and old.suffix!='.pyc':
                if old.read_bytes() != (backup/name/old.relative_to(target)).read_bytes():
                    raise RuntimeError('Backup verification failed; installation aborted')
    def copy(src,dst):
        dst.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(src,dst)
        if hashlib.sha256(src.read_bytes()).digest()!=hashlib.sha256(dst.read_bytes()).digest():
            raise RuntimeError('Installed bytes differ')
    files=[p for p in source.rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.suffix!='.pyc']
    for src in files:
        rel=src.relative_to(source)
        copy(src,profile/rel)
        if src.suffix!='.py':
            copy(src,shared/rel)
    copy(repo/'deployment/shared_plugin_api.py',shared/'dashboard/plugin_api.py')
    copy(repo/'deployment/group-release-check.html',shared/'dashboard/group-release-check.html')
    print('BACKUP',backup)
    print('PROFILE_AND_SHARED_PLUGIN_BYTES_VERIFIED',len(files))
    print('Restart dashboard explicitly; authenticate and verify group canary before frontend push.')


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--apply',action='store_true',required=True)
    parser.parse_args()
    install()
