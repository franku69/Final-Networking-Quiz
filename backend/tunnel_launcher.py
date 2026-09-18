#!/usr/bin/env python3
"""Start Packet Quest and, optionally, a temporary public HTTPS tunnel.
No pip packages, administrator access, or changes to system firewall/settings.
"""
import argparse
import ctypes
import hashlib
import json
import os
import platform
import queue
import re
import shutil
import socket
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from urllib.parse import urlsplit

from server import ROOT, QuizStore, QuizHTTPServer, RuntimeLock

RELEASE_API = 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest'
MAX_BINARY = 200 * 1024 * 1024

def fetch_json(url, timeout=15):
    request = urllib.request.Request(url, headers={'User-Agent': 'PacketQuest-GitHub-Backend/7', 'Accept': 'application/json'})
    with urllib.request.urlopen(request, timeout=timeout) as r:
        return json.loads(r.read(2000000).decode('utf-8'))

def asset_name(system=None, machine=None):
    system, machine = system or platform.system(), (machine or platform.machine()).lower()
    arch = 'arm64' if machine in ('arm64', 'aarch64') else 'amd64' if machine in ('amd64', 'x86_64') else '386' if machine in ('i386', 'i686', 'x86') else None
    if not arch or system not in ('Windows', 'Linux', 'Darwin'):
        raise RuntimeError('Install the official cloudflared executable for your computer and place it on PATH. Automatic download does not support this teacher computer.')
    return 'cloudflared-' + {'Windows': 'windows', 'Linux': 'linux', 'Darwin': 'darwin'}[system] + '-' + arch + ('.exe' if system == 'Windows' else '.tgz' if system == 'Darwin' else '')

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1024*1024), b''):
            h.update(block)
    return h.hexdigest()

def download_cloudflared(directory):
    existing = shutil.which('cloudflared')
    if existing:
        print('Using your installed cloudflared: ' + existing, flush=True)
        return Path(existing)
    directory.mkdir(parents=True, exist_ok=True)
    executable = directory / ('cloudflared.exe' if os.name == 'nt' else 'cloudflared')
    manifest = directory / 'cloudflared-verified.json'
    if executable.exists() and manifest.exists():
        try:
            meta = json.loads(manifest.read_text(encoding='utf-8'))
            if sha256_file(executable) == meta['executableSha256']:
                print('Using previously verified cloudflared download.', flush=True)
                return executable
        except (ValueError, KeyError, OSError):
            pass
    print('Downloading Cloudflare tunnel helper from its official GitHub release (first setup only)...', flush=True)
    release = fetch_json(RELEASE_API)
    name = asset_name()
    asset = next((a for a in release.get('assets', []) if a['name'] == name), None)
    if not asset:
        raise RuntimeError('No official release asset matched ' + name + '. Install cloudflared manually from the official Cloudflare downloads page.')
    expected = (asset.get('digest') or '').removeprefix('sha256:')
    if not re.fullmatch(r'[a-fA-F0-9]{64}', expected):
        # Some releases publish checksums in the release description rather than the API digest.
        for line in release.get('body', '').splitlines():
            if name in line:
                match = re.search(r'\b([a-fA-F0-9]{64})\b', line)
                if match:
                    expected = match.group(1)
                    break
    if not re.fullmatch(r'[a-fA-F0-9]{64}', expected):
        raise RuntimeError('The official release did not provide a usable SHA-256 checksum. Automatic installation stopped rather than executing an unverified download. Install cloudflared from the official Cloudflare download instructions, then rerun.')
    url = asset['browser_download_url']
    if not url.startswith('https://github.com/cloudflare/cloudflared/releases/download/'):
        raise RuntimeError('Unexpected release download address; installation stopped.')
    target = directory / (name + '.part')
    request = urllib.request.Request(url, headers={'User-Agent': 'PacketQuest-GitHub-Backend/7'})
    count = 0
    try:
        with urllib.request.urlopen(request, timeout=45) as r, target.open('wb') as f:
            while True:
                chunk = r.read(1024*1024)
                if not chunk:
                    break
                count += len(chunk)
                if count > MAX_BINARY:
                    raise RuntimeError('Unexpectedly large helper download; stopped.')
                f.write(chunk)
        if sha256_file(target).lower() != expected.lower():
            raise RuntimeError('Cloudflared checksum did not match the official release. Download was not executed.')
        if name.endswith('.tgz'):
            with tarfile.open(target, 'r:gz') as archive:
                matches = [m for m in archive.getmembers() if m.isfile() and Path(m.name).name == 'cloudflared' and m.size < MAX_BINARY]
                if len(matches) != 1:
                    raise RuntimeError('Unexpected cloudflared archive contents.')
                with archive.extractfile(matches[0]) as src, executable.open('wb') as dst:
                    shutil.copyfileobj(src, dst)
        else:
            shutil.copyfile(target, executable)
        executable.chmod(0o700)
        manifest.write_text(json.dumps({'release': release.get('tag_name'), 'asset': name, 'downloadSha256': expected.lower(), 'executableSha256': sha256_file(executable)}, indent=2), encoding='utf-8')
    finally:
        if target.exists():
            target.unlink()
    return executable

def lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            # Connect selects a route; it does not send a packet.
            s.connect(('192.0.2.1', 9))
            return s.getsockname()[0]
    except OSError:
        return socket.gethostbyname(socket.gethostname())

def start_http(store, host, preferred_port):
    for port in range(preferred_port, min(65536, preferred_port + 20)):
        try:
            server = QuizHTTPServer((host, port), store)
            thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval':0.2}, daemon=True)
            thread.start()
            return server, thread
        except OSError:
            continue
    raise RuntimeError('No free quiz port found. Close a previous Packet Quest launcher or choose --port 9000. No process was killed.')

def check_public(url, store, timeout=90):
    end = time.monotonic() + timeout
    last = 'Waiting for tunnel...'
    while time.monotonic() < end:
        try:
            result = fetch_json(url.rstrip('/') + '/healthz', timeout=8)
            if result.get('instanceId') == store.instance_id and result.get('live') is True and result.get('bankId') == store.bank_id:
                return
            last = 'The address responded but did not point to this quiz server.'
        except (OSError, ValueError) as e:
            last = str(e)
        time.sleep(2)
    raise RuntimeError('The public address could not be verified. DO NOT share it yet. ' + last)

def start_tunnel(executable, local_url, runtime):
    logs = queue.Queue(maxsize=1000)
    # Explicit separate config avoids editing or consuming an existing tunnel config.
    config = runtime / 'quick-tunnel.yml'
    config.write_text('loglevel: info\n', encoding='utf-8')
    args = [str(executable), 'tunnel', '--config', str(config), '--no-autoupdate', '--protocol', 'http2', '--url', local_url]
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace', bufsize=1)
    logfile = runtime / 'tunnel.log'
    def reader():
        with logfile.open('w', encoding='utf-8') as f:
            for line in process.stdout:
                f.write(line); f.flush()
                try: logs.put_nowait(line)
                except queue.Full: pass
    threading.Thread(target=reader, daemon=True).start()
    deadline = time.monotonic() + 100
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError('Cloudflare helper exited. See runtime/tunnel.log. The network may block tunnels; no public link is ready.')
        try:
            line = logs.get(timeout=1)
            match = re.search(r'https://[a-z0-9-]+\.trycloudflare\.com\b', line)
            if match:
                return process, match.group(0)
        except queue.Empty:
            continue
    process.terminate()
    raise RuntimeError('Cloudflare did not produce a public link. Check Internet/firewall settings and runtime/tunnel.log; no settings were changed.')

def awake(enabled):
    if os.name == 'nt':
        try:
            ctypes.windll.kernel32.SetThreadExecutionState(0x80000001 if enabled else 0x80000000)
        except Exception:
            pass

def main():
    parser = argparse.ArgumentParser(description='Packet Quest temporary live backend launcher for GitHub Pages')
    parser.add_argument('--online', action='store_true', help='Start a temporary HTTPS Cloudflare quick tunnel')
    parser.add_argument('--local', action='store_true', help='Allow devices on the same reachable local network')
    parser.add_argument('--public-url', help='Use your already configured permanent HTTPS reverse proxy; no quick tunnel is started')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    if sys.version_info < (3,9):
        raise SystemExit('Python 3.9 or newer is required on the teacher computer only.')
    if not 1024 <= args.port <= 65515:
        raise SystemExit('Choose a port from 1024 to 65515.')
    guard = None
    try:
        data_dir = Path(os.environ.get('PACKET_DATA_DIR') or (ROOT / 'runtime'))
        guard = RuntimeLock(data_dir)
        store = QuizStore(private_dir=data_dir)
    except (OSError, RuntimeError) as e:
        if guard: guard.close()
        print('SETUP STOPPED: ' + str(e), flush=True)
        return 1
    httpd = None; thread = None; tunnel = None
    try:
        httpd, thread = start_http(store, '0.0.0.0' if args.local else '127.0.0.1', args.port)
        local = 'http://127.0.0.1:' + str(httpd.server_port)
        fetch_json(local + '/healthz')
        print('\nPACKET QUEST GITHUB BACKEND v7.1 | 30 MCQ | CS111 NETWORKING\n', flush=True)
        print('PRIVATE TEACHER KEY: ' + store.key, flush=True)
        print('LOCAL BACKEND TEST PAGE: ' + local + '/teacher/', flush=True)
        print('Keep this window open. Private records stay in the configured runtime folder.\n', flush=True)
        awake(True)
        public = args.public_url or (os.environ.get('PACKET_PUBLIC_URL') if not args.online else '')
        if public:
            parsed = urlsplit(public)
            if parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.query or parsed.fragment:
                raise RuntimeError('--public-url must be a plain HTTPS address for your configured reverse proxy.')
            check_public(public, store)
        elif args.online:
            print('ONLINE SETUP: Cloudflare will proxy this quiz through a temporary public HTTPS link.', flush=True)
            print('Quick tunnels are for testing, have no uptime SLA, and stop when this launcher closes.', flush=True)
            print('For an important graded class, a stable managed HTTPS deployment is preferable.\n', flush=True)
            helper = download_cloudflared(store.private / 'bin')
            tunnel, public = start_tunnel(helper, local, store.private)
            print('Checking the actual public quiz endpoint. Do not share a link until VERIFIED appears...', flush=True)
            check_public(public, store)
        elif args.local:
            public = 'http://' + lan_ip() + ':' + str(httpd.server_port)
            print('LOCAL NETWORK MODE: student devices must be on the same reachable network.', flush=True)
            print('If Windows asks, allow Python only on your trusted private classroom network.', flush=True)
        else:
            public = local
        store.public_url = public.rstrip('/')
        if args.online or args.public_url:
            print('\nLIVE BACKEND URL VERIFIED: ' + public, flush=True)
        else:
            print('\nLOCAL BACKEND URL: ' + public, flush=True)
        print('\n1. Open your GitHub Pages /teacher/ page.', flush=True)
        print('2. Connect it to the LIVE BACKEND URL above.', flush=True)
        print('3. Sign in with the PRIVATE TEACHER KEY above.', flush=True)
        print('4. Create a room and use COPY ROOM LINK. Students receive ONE GitHub Pages link.', flush=True)
        print('5. Keep this window open until everyone has submitted and you export scores.\n', flush=True)
        print('Do not sleep, shut down, or disconnect this teacher computer during the quiz.', flush=True)
        (store.private / 'CURRENT_BACKEND.txt').write_text('Backend: '+public+'\nPrivate key: keep your private deployment secret file; do not share.\n', encoding='utf-8')
        if not args.no_browser:
            site_file = ROOT.parent / 'MY_GITHUB_PAGES_URL.txt'
            if site_file.exists():
                site = site_file.read_text(encoding='utf-8').strip().rstrip('/')
                if site.startswith('https://') and 'YOUR-' not in site:
                    from urllib.parse import quote
                    webbrowser.open(site + '/teacher/?api=' + quote(public, safe=''))
        while True:
            if tunnel and tunnel.poll() is not None:
                print('\nPUBLIC TUNNEL STOPPED. Students cannot currently sync. Saved records remain on disk.', flush=True)
                print('Check runtime/tunnel.log. Restart the launcher and share its NEW link.', flush=True)
                print('Students returning on a different URL may need teacher device-recovery codes.', flush=True)
                tunnel = None
            time.sleep(1)
    except KeyboardInterrupt:
        print('\nStopping hosting. Recorded answers and scores remain in runtime/.', flush=True)
    except Exception as e:
        print('\nSETUP FAILED: ' + str(e), flush=True)
        print('No working public link has been promised. Do not start the graded quiz yet.', flush=True)
        print('For a local test, use RUN_LOCAL_BACKEND.bat. See QUICK_START.md.', flush=True)
        return 1
    finally:
        if tunnel and tunnel.poll() is None:
            tunnel.terminate()
            try: tunnel.wait(timeout=6)
            except subprocess.TimeoutExpired: tunnel.kill()
        if httpd:
            httpd.shutdown(); httpd.server_close()
        if thread: thread.join(timeout=3)
        store.close(); guard.close(); awake(False)
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
