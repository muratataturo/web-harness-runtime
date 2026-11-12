"""Pinned Colab SSH bridge. Missing/replaced sessions NEVER auto-allocate a VM."""
import importlib.metadata
import json
from pathlib import Path
import sys


def main():
    state = json.loads(Path(sys.argv[1]).read_text())
    if importlib.metadata.version('google-colab-cli') != '0.7.5':
        raise SystemExit('The SSH guard requires google-colab-cli 0.7.5')
    from colab_cli.commands import ssh
    from colab_cli.cli import main as cli_main
    original_resolve = ssh._resolve_session
    original_bridge = ssh._run_proxy_bridge
    def refuse_allocation(*args, **kwargs):
        raise SystemExit('Session absent: the SSH bridge never allocates a replacement')
    def validate(session):
        if session.endpoint != state['endpoint']:
            raise SystemExit('Session endpoint changed: refusing replacement')
        return session
    def resolve(name):
        if name != state['session']: raise SystemExit('Unexpected SSH session')
        return validate(original_resolve(name))
    def bridge(session, identity, remove):
        if remove: raise SystemExit('SSH bridge cannot implicitly stop Colab')
        return original_bridge(validate(session), identity, False)
    ssh._auto_create_session = refuse_allocation
    ssh._resolve_session = resolve
    ssh._run_proxy_bridge = bridge
    sys.argv = ['colab','ssh','--proxy-mode','-s',state['session'],'-i',state['sshKeyFile']]
    cli_main()

if __name__ == '__main__': main()
