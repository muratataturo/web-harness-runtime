"""Run on a Colab GPU via the pinned CLI. Configuration has no credentials.
Inspired by the user's referenced Strata/Colab session; no host auth is copied.
"""
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import urllib.request

ROOT = Path('/content/web-harness-strata')

def run(args, env=None, log=None):
    result = subprocess.run(args, env=env, stdout=log or subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, check=True)
    return result.stdout or ''

def main():
    os.umask(0o077)
    if not Path('/content').is_dir() or not shutil.which('nvidia-smi'):
        raise RuntimeError('A Colab NVIDIA GPU runtime is required')
    ROOT.mkdir(mode=0o700, exist_ok=True)
    config = json.loads((ROOT / 'bootstrap.json').read_text())
    if config['modelId'] != 'qwen3.8-flash-next-iq2_xs' or config['context'] != 65536:
        raise RuntimeError('Unverified model/context; no fallback')
    if config['action'] not in ('plan', 'start') or config['vision'] not in ('off', 'cpu', 'gpu'):
        raise RuntimeError('Invalid bootstrap options')
    if not 1024 <= config['remotePort'] <= 65535:
        raise RuntimeError('Invalid API port')
    gpu = run(['nvidia-smi', '--query-gpu=name,memory.total', '--format=csv,noheader']).strip()
    mem = {line.split(':')[0]: int(line.split()[1])*1024 for line in Path('/proc/meminfo').read_text().splitlines() if ':' in line and len(line.split())>=2 and line.split()[1].isdigit()}
    disk = shutil.disk_usage('/content').free
    if mem['MemAvailable'] < 20*2**30 or disk < 100*2**30:
        raise RuntimeError('At least 20 GiB available RAM and 100 GiB free disk are required before downloading')
    installer_url = f"https://github.com/Niko1221/Strata/releases/download/{config['strataRelease']}/install.sh"
    strata = Path.home() / '.local/bin/strata'
    with (ROOT / 'install.log').open('a') as log:
        if not strata.exists():
            data = urllib.request.urlopen(installer_url, timeout=60).read(2*1024*1024)
            if hashlib.sha256(data).hexdigest() != config['installerSha256']:
                raise RuntimeError('Installer SHA-256 mismatch')
            installer = ROOT / 'install.sh'; installer.write_bytes(data)
            env = dict(os.environ, STRATA_FEED=installer_url.rsplit('/',1)[0])
            run(['sh', str(installer)], env=env, log=log)
    common = [str(strata), 'launch', '--family', 'qwen', '--model', 'iq2_xs',
              '--context', '64k', '--parallel', '1', '--vision', config['vision'],
              '--set', 'vram-reserve-mib=3072', '--access', 'local',
              '--port', str(config['remotePort']), '--data-dir', '/content/strata-models']
    if config['action'] == 'plan':
        with (ROOT/'plan.log').open('w') as log: run(common+['--plan'],log=log)
        print('@whr-strata-result '+json.dumps({'phase':'planned','gpu':gpu,'availableRamGiB':round(mem['MemAvailable']/2**30,1),'freeDiskGiB':round(disk/2**30,1)}),flush=True)
        return
    key_file = ROOT / 'api-key'
    if not key_file.exists(): key_file.write_text(secrets.token_urlsafe(32))
    key_file.chmod(0o600)
    key = key_file.read_text().strip()
    env = dict(os.environ, STRATA_API_KEY=key)
    # Installer/launch output can contain credentials. Only private remote logs receive it.
    with (ROOT/'launch.log').open('a') as log:
        run(common+['--api-key-env','STRATA_API_KEY','--yes','--no-tui'],env=env,log=log)
    request = urllib.request.Request(f"http://127.0.0.1:{config['remotePort']}/v1/models",headers={'Authorization':'Bearer '+key})
    data = json.load(urllib.request.urlopen(request,timeout=120))
    selected = next((m for m in data['data'] if m['id']==config['modelId']), None)
    if not selected or selected.get('meta',{}).get('n_ctx') != 65536:
        raise RuntimeError('The exact model and 64K context were not reported')
    print('@whr-strata-result '+json.dumps({'phase':'ready','model':selected['id'],'context':65536,'gpu':gpu,'vision':config['vision']}),flush=True)

if __name__ == '__main__': main()
