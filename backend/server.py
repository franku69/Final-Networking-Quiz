#!/usr/bin/env python3
"""Packet Quest Live — authenticated classroom service, Python 3.9+.

Only public/ is served. Questions, credentials, and SQLite records are NEVER
static files. Short HTTP polling is intentional: it works through ordinary
HTTPS proxies and does not depend on WebSockets or Server-Sent Events.
"""
import argparse
import csv
import hashlib
import hmac
import io
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import threading
import time
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
from cryptography.fernet import Fernet, InvalidToken

ROOT = Path(__file__).resolve().parent
SITE_ROOT = (ROOT.parent / 'docs').resolve()
VERSION = '7.1.0-stable'
TTL = 7 * 24 * 60 * 60 * 1000
ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

def now_ms():
    return int(time.time() * 1000)

def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()

def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)

def clean(value, limit=120):
    return ' '.join(value.split())[:limit] if isinstance(value, str) else ''

def random_code(n=6):
    return ''.join(secrets.choice(ALPHABET) for _ in range(n))

def load_bank(bank_path=None):
    """Load the private bank. Production repo stores only Fernet ciphertext."""
    if bank_path:
        path = Path(bank_path)
        if path.suffix.lower() == '.json':
            return json.loads(path.read_text(encoding='utf-8'))
        encrypted = path.read_bytes()
    else:
        encrypted = (ROOT / 'questions.enc').read_bytes()
    key = os.environ.get('PACKET_BANK_KEY', '').strip()
    if not key:
        raise RuntimeError('PACKET_BANK_KEY is required. Keep it in your hosting environment, never in GitHub.')
    try:
        raw = Fernet(key.encode('ascii')).decrypt(encrypted)
        return json.loads(raw.decode('utf-8'))
    except (InvalidToken, ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError('PACKET_BANK_KEY could not decrypt the quiz bank. Recheck the private deployment secret.') from exc

class ApiError(Exception):
    def __init__(self, message, status=400, code='invalid_request'):
        super().__init__(message)
        self.status, self.code = status, code

class RuntimeLock:
    """OS-released file lock: do not run two servers against one classroom DB."""
    def __init__(self, directory):
        directory = Path(directory); directory.mkdir(parents=True, exist_ok=True)
        self.file = (directory / '.server.lock').open('a+b')
        self.locked = False
        try:
            self.file.seek(0, 2)
            if self.file.tell() == 0:
                self.file.write(b'0'); self.file.flush()
            self.file.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.locked = True
        except OSError:
            self.file.close()
            raise RuntimeError('This folder already has a running quiz server. Use its existing window/link, or stop it before launching again. Do not open two launchers for the same class.')
    def close(self):
        if self.file.closed:
            return
        if self.locked:
            self.file.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(), fcntl.LOCK_UN)
        self.file.close(); self.locked = False

class QuizStore:
    """One process, bounded per-room state, indexed lookups, atomic SQLite writes."""
    def __init__(self, private_dir=None, bank_path=None, teacher_key=None, clock=now_ms):
        self.private = Path(private_dir or ROOT / 'runtime')
        self.private.mkdir(parents=True, exist_ok=True)
        try:
            self.private.chmod(0o700)
        except OSError:
            pass
        self.bank = load_bank(bank_path)
        self.bank_id = self.bank['id']
        self.questions = {q['id']: q for q in self.bank['questions']}
        if len(self.questions) != int(self.bank.get('count', 0)) or len(self.questions) != 30 or any(len(q['options']) != 4 or q['correct'] not in {o['id'] for o in q['options']} for q in self.questions.values()):
            raise RuntimeError('The decrypted source question bank is invalid. Restore the matching encrypted bank and secret.')
        self.clock = clock
        self.lock = threading.RLock()
        self.public_url = os.environ.get('PACKET_PUBLIC_URL', '').rstrip('/')
        self.instance_id = secrets.token_hex(12)
        self.allowed_origins = {x.strip().rstrip('/') for x in os.environ.get('PACKET_ALLOWED_ORIGINS', '').split(',') if x.strip()}
        self.allow_pages_origins = os.environ.get('PACKET_ALLOW_PAGES_ORIGINS', '1') == '1'
        self.db = sqlite3.connect(str(self.private / 'quiz.sqlite3'), check_same_thread=False, timeout=15)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, expires INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS room_expiry ON rooms(expires);
            CREATE TABLE IF NOT EXISTS attempts (
                id TEXT PRIMARY KEY, room TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
                identity TEXT NOT NULL, device TEXT NOT NULL, data TEXT NOT NULL,
                UNIQUE(room, identity), UNIQUE(room, device));
            CREATE INDEX IF NOT EXISTS attempts_room ON attempts(room);
            CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, expires INTEGER NOT NULL, result TEXT NOT NULL);
        ''')
        fingerprint = digest(compact(self.bank))
        old = self.db.execute('SELECT value FROM settings WHERE name=?', ('bank',)).fetchone()
        if old and old['value'] != fingerprint and self.db.execute('SELECT 1 FROM rooms LIMIT 1').fetchone():
            raise RuntimeError('Existing records use a different question bank. Export them before changing the bank. Do not regrade an active room.')
        self.db.execute('INSERT OR REPLACE INTO settings VALUES (?,?)', ('bank', fingerprint))
        keyfile = self.private / 'TEACHER_KEY.txt'
        self.key = teacher_key or os.environ.get('PACKET_TEACHER_KEY')
        if not self.key:
            if keyfile.exists():
                self.key = keyfile.read_text(encoding='utf-8').strip()
            else:
                self.key = secrets.token_urlsafe(30)
                keyfile.write_text(self.key + '\n', encoding='utf-8')
                try:
                    keyfile.chmod(0o600)
                except OSError:
                    pass
        if len(self.key) < 12:
            raise RuntimeError('Use a teacher key of at least 12 characters.')
        self.db.commit()
        self.last_cleanup = 0

    def close(self):
        with self.lock:
            self.db.close()

    def _room_save(self, room):
        self.db.execute('UPDATE rooms SET data=?,expires=? WHERE code=?', (compact(room), room['expires'], room['code']))

    def _attempt_save(self, a):
        self.db.execute('UPDATE attempts SET device=?,data=? WHERE id=?', (a['deviceHash'], compact(a), a['id']))

    def _all_attempts(self, code):
        return [json.loads(row['data']) for row in self.db.execute('SELECT data FROM attempts WHERE room=? ORDER BY rowid', (code,))]

    def _public_room(self, r):
        out = {k: r[k] for k in ('code', 'section', 'status', 'durationMinutes', 'createdAt', 'startedAt', 'deadline', 'expires', 'allowLateJoin')}
        out.update(questionCount=len(self.questions), bankId=self.bank_id, requiresCode=bool(r['roster']))
        return out

    def _finish(self, a, room, reason, stamp):
        if a['submitted']:
            return
        started = a['startedAt'] or room['startedAt'] or stamp
        a['submitted'] = True
        a['receipt'] = {
            'schema': 'packet-quest-receipt/v2', 'bankId': self.bank_id,
            'attemptId': a['id'], 'student': a['student'], 'roomCode': room['code'],
            'score': self._grade(a['answers']), 'total': len(self.questions),
            'answered': len(a['answers']), 'answers': a['answers'].copy(),
            'startedAt': started, 'submittedAt': max(started, stamp),
            'reason': reason, 'verification': 'Server graded and recorded'
        }
        self._attempt_save(a)

    def _room(self, code):
        code = clean(code, 12).upper()
        row = self.db.execute('SELECT data FROM rooms WHERE code=?', (code,)).fetchone()
        if not row:
            raise ApiError('Room not found. Check the room code and quiz link with your teacher.', 404, 'room_not_found')
        r = json.loads(row['data'])
        if r['expires'] <= self.clock():
            raise ApiError('This room has expired. Ask your teacher for the current room.', 410, 'room_expired')
        if r['status'] == 'running' and self.clock() >= r['deadline']:
            r['status'] = 'ended'
            for a in self._all_attempts(code):
                self._finish(a, r, 'time', r['deadline'])
            self._room_save(r)
        return r

    def _grade(self, answers):
        return sum(answers.get(qid) == q['correct'] for qid, q in self.questions.items())

    def _clean_answers(self, answers):
        if not isinstance(answers, dict) or len(answers) > len(self.questions):
            raise ApiError('Invalid answer data. Reload and resume your saved attempt.')
        result = {}
        for qid, choice in answers.items():
            if qid not in self.questions or not isinstance(choice, str) or choice not in {o['id'] for o in self.questions[qid]['options']}:
                raise ApiError('An answer does not belong to this quiz. Reload the correct quiz link.', 409, 'bank_mismatch')
            result[qid] = choice
        return result

    def _revision(self, value):
        if type(value) is not int or not 0 <= value <= 1_000_000_000:
            raise ApiError('Invalid answer revision.')
        return value

    def _identity(self, data, r):
        name, sid = clean(data.get('name')), clean(data.get('studentId'), 80)
        code = clean(data.get('seatCode'), 40).upper()
        if r['roster']:
            student = r['roster'].get(code)
            if not student:
                raise ApiError('Your personal student code was not accepted. Use the code your teacher assigned.', 401, 'seat_code')
            return 'roster:' + code, student.copy()
        if not name:
            raise ApiError('Enter your full name.')
        return ('id:' + sid if sid else 'name:' + name).casefold(), {'name': name, 'studentId': sid, 'section': r['section']}

    def _device(self, token):
        if not isinstance(token, str) or not re.fullmatch(r'[a-f0-9]{64}', token):
            raise ApiError('Device credentials are missing. Join using this browser first.', 401, 'authentication')
        return digest(token)

    def _get_attempt(self, data, token):
        aid = clean(data.get('attemptId'), 80)
        row = self.db.execute('SELECT data FROM attempts WHERE id=?', (aid,)).fetchone()
        if not row:
            raise ApiError('This saved attempt is no longer available. Ask your teacher to check the room.', 404, 'attempt_not_found')
        a = json.loads(row['data'])
        if not hmac.compare_digest(a['deviceHash'], self._device(token)):
            raise ApiError('This device is no longer authorized for the attempt. Ask your teacher for a recovery code.', 401, 'authentication')
        r = self._room(a['roomCode'])
        # Expiry may have finalized the attempt in _room.
        a = json.loads(self.db.execute('SELECT data FROM attempts WHERE id=?', (aid,)).fetchone()['data'])
        return a, r

    def _touch(self, a, data):
        a['lastSeen'] = self.clock()
        visible = data.get('visible')
        if type(visible) is bool:
            a['visible'] = visible
        index = data.get('currentPosition')
        if type(index) is int and 0 <= index <= len(self.questions):
            a['currentPosition'] = index

    def _snapshot(self, a, room, with_questions=False):
        view = {k: a[k] for k in ('id', 'student', 'answers', 'revision', 'submitted', 'receipt', 'startedAt')}
        result = {'bankId': self.bank_id, 'serverTime': self.clock(), 'room': self._public_room(room), 'attempt': view}
        if with_questions and room['status'] != 'waiting':
            result['questions'] = a['questions']
        return result

    def _dashboard(self, r):
        stamp = self.clock()
        rows = []
        for a in self._all_attempts(r['code']):
            state = 'submitted' if a['submitted'] else ('reconnecting' if stamp - a['lastSeen'] > 30000 else ('background' if not a['visible'] else ('waiting' if r['status'] == 'waiting' else 'active')))
            rows.append({
                'attemptId': a['id'], 'student': a['student'], 'answered': len(a['answers']),
                'currentPosition': a['currentPosition'], 'submitted': a['submitted'],
                'score': a['receipt']['score'] if a['submitted'] else None,
                'liveScore': self._grade(a['answers']), 'lastSeen': a['lastSeen'],
                'status': state, 'revision': a['revision'], 'joinedAt': a['joinedAt'],
                'startedAt': a['startedAt'], 'submittedAt': a['receipt']['submittedAt'] if a['submitted'] else None,
                'receipt': a['receipt']
            })
        return {'bankId': self.bank_id, 'serverTime': stamp, 'room': self._public_room(r), 'students': rows, 'studentBase': self.public_url}

    def _teacher(self, token):
        if not isinstance(token, str) or len(token) > 150:
            raise ApiError('Sign in to the teacher dashboard.', 401, 'teacher_login')
        row = self.db.execute('SELECT expires FROM sessions WHERE token=?', (digest(token),)).fetchone()
        if not row or row['expires'] <= self.clock():
            raise ApiError('Teacher session expired. Sign in again; room records are safe.', 401, 'teacher_login')

    def _operation(self, action, request_id):
        if not isinstance(request_id, str) or not re.fullmatch(r'[a-f0-9]{32,64}', request_id):
            raise ApiError('Missing request ID. Refresh the teacher page before retrying.')
        return action + ':' + request_id

    def _roster(self, value, section):
        if not isinstance(value, str) or len(value) > 60000:
            raise ApiError('Roster must be text with at most 60,000 characters.')
        result, ids = {}, set()
        for row in csv.reader(io.StringIO(value)):
            if not row or not any(x.strip() for x in row):
                continue
            if len(row) < 2:
                raise ApiError('Roster format: Student ID,Full Name on each line. No header is needed.')
            sid, name = clean(row[0], 80), clean(','.join(row[1:]))
            if not sid or not name or sid.casefold() in ids:
                raise ApiError('Each roster row needs a unique student ID and full name.')
            if len(result) >= 500:
                raise ApiError('Maximum roster size is 500 students.')
            ids.add(sid.casefold())
            code = random_code(10)
            while code in result:
                code = random_code(10)
            result[code] = {'name': name, 'studentId': sid, 'section': section}
        return result

    def call(self, data, token=''):
        if not isinstance(data, dict):
            raise ApiError('A JSON object is required.')
        with self.lock:
            try:
                result = self._dispatch(data, token)
                self.db.commit()
                return result
            except ApiError:
                # Deadline finalizations must survive even when the requested later edit is rejected.
                self.db.commit()
                raise
            except Exception:
                self.db.rollback()
                raise

    def _dispatch(self, data, token):
        stamp = self.clock()
        if stamp - self.last_cleanup > 60000:
            self.db.execute('DELETE FROM rooms WHERE expires<=?', (stamp,))
            self.db.execute('DELETE FROM sessions WHERE expires<=?', (stamp,))
            self.db.execute('DELETE FROM operations WHERE expires<=?', (stamp,))
            self.last_cleanup = stamp
        action = data.get('action')
        if action == 'info':
            return {'version': VERSION, 'bankId': self.bank_id, 'title': self.bank['title'], 'questionCount': len(self.questions), 'serverTime': stamp, 'instanceId': self.instance_id, 'live': True}
        if action == 'teacher_login':
            if not isinstance(token, str) or not hmac.compare_digest(token.encode('utf-8'), self.key.encode('utf-8')):
                raise ApiError('Teacher key not accepted. Use the key shown by this version’s launcher.', 401, 'teacher_login')
            session = secrets.token_urlsafe(32)
            self.db.execute('INSERT INTO sessions VALUES (?,?)', (digest(session), stamp + 12*3600000))
            return {'token': session, 'bankId': self.bank_id, 'expires': stamp + 12*3600000}
        if isinstance(action, str) and action.startswith('teacher_'):
            self._teacher(token)
            if action == 'teacher_logout':
                self.db.execute('DELETE FROM sessions WHERE token=?', (digest(token),))
                return {'ok': True}
            if action in ('teacher_info', 'teacher_rooms'):
                rooms = [self._public_room(self._room(row['code'])) for row in self.db.execute('SELECT code FROM rooms ORDER BY expires DESC').fetchall()]
                return {'rooms': rooms, 'bankId': self.bank_id, 'questionCount': len(self.questions), 'title': self.bank['title'], 'studentBase': self.public_url, 'serverTime': stamp, 'version': VERSION}
            if action == 'teacher_bank':
                return {'bank': self.bank, 'bankId': self.bank_id}
            if action == 'teacher_create':
                operation = self._operation(action, data.get('requestId'))
                old = self.db.execute('SELECT result FROM operations WHERE id=?', (operation,)).fetchone()
                if old:
                    return self._dashboard(self._room(json.loads(old['result'])['roomCode']))
                section = clean(data.get('section'), 80)
                minutes = data.get('durationMinutes', 30)
                if not section or type(minutes) is not int or not 1 <= minutes <= 180:
                    raise ApiError('Enter a section and a whole-number time limit from 1 to 180 minutes.')
                if self.db.execute('SELECT COUNT(*) FROM rooms').fetchone()[0] >= 40:
                    raise ApiError('Export and delete unused rooms before creating another.', 409)
                roster = self._roster(data.get('roster', ''), section)
                code = random_code()
                while self.db.execute('SELECT 1 FROM rooms WHERE code=?', (code,)).fetchone():
                    code = random_code()
                r = {'code': code, 'section': section, 'status': 'waiting', 'durationMinutes': minutes,
                     'createdAt': stamp, 'startedAt': None, 'deadline': None, 'expires': stamp + TTL,
                     'roster': roster, 'allowLateJoin': data.get('allowLateJoin', True) is True}
                self.db.execute('INSERT INTO rooms VALUES (?,?,?)', (code, r['expires'], compact(r)))
                self.db.execute('INSERT INTO operations VALUES (?,?,?)', (operation, stamp+TTL, compact({'roomCode': code})))
                return self._dashboard(r)
            r = self._room(data.get('roomCode'))
            if action == 'teacher_dashboard':
                return self._dashboard(r)
            if action == 'teacher_start':
                if r['status'] == 'ended':
                    raise ApiError('This quiz has ended. Create a new room rather than changing completed grades.', 409)
                if r['status'] == 'waiting':
                    r.update(status='running', startedAt=stamp, deadline=stamp + r['durationMinutes'] * 60000)
                    for a in self._all_attempts(r['code']):
                        a['startedAt'] = stamp
                        self._attempt_save(a)
                    self._room_save(r)
                return self._dashboard(r)
            if action == 'teacher_end':
                if r['status'] != 'ended':
                    r.update(status='ended', deadline=stamp)
                    for a in self._all_attempts(r['code']):
                        self._finish(a, r, 'teacher', stamp)
                    self._room_save(r)
                return self._dashboard(r)
            if action == 'teacher_extend':
                op = self._operation(action + ':' + r['code'], data.get('requestId'))
                if self.db.execute('SELECT 1 FROM operations WHERE id=?', (op,)).fetchone():
                    return self._dashboard(r)
                minutes = data.get('minutes')
                if r['status'] != 'running' or type(minutes) is not int or not 1 <= minutes <= 30:
                    raise ApiError('Only a running room can be extended, by 1–30 minutes.', 409)
                r['deadline'] += minutes * 60000
                self._room_save(r)
                self.db.execute('INSERT INTO operations VALUES (?,?,?)', (op, stamp+TTL, '{}'))
                return self._dashboard(r)
            if action == 'teacher_codes':
                return {'codes': [{'code': code, **student} for code, student in r['roster'].items()]}
            if action == 'teacher_recovery':
                aid = clean(data.get('attemptId'), 80)
                row = self.db.execute('SELECT data FROM attempts WHERE id=? AND room=?', (aid, r['code'])).fetchone()
                if not row:
                    raise ApiError('Student attempt not found.', 404)
                a = json.loads(row['data'])
                code = random_code(12)
                a['recoveryHash'], a['recoveryUntil'] = digest(code), stamp + 30*60000
                self._attempt_save(a)
                return {'recoveryCode': code, 'student': a['student'], 'expires': a['recoveryUntil']}
            if action == 'teacher_delete':
                if data.get('confirmation') != r['code']:
                    raise ApiError('Type the exact room code to delete its records.')
                if r['status'] == 'running':
                    raise ApiError('End and export the running room before deleting it.', 409)
                self.db.execute('DELETE FROM rooms WHERE code=?', (r['code'],))
                return {'deleted': True}
            raise ApiError('Unknown teacher action.')
        if action == 'room_info':
            r = self._room(data.get('roomCode'))
            return {'room': self._public_room(r), 'bankId': self.bank_id, 'serverTime': stamp}
        if action == 'join':
            r = self._room(data.get('roomCode'))
            device = self._device(token)
            identity, student = self._identity(data, r)
            row = self.db.execute('SELECT data FROM attempts WHERE room=? AND identity=?', (r['code'], identity)).fetchone()
            if row:
                a = json.loads(row['data'])
                if not hmac.compare_digest(a['deviceHash'], device):
                    recovery = clean(data.get('recoveryCode'), 40).upper()
                    if not recovery or a.get('recoveryUntil', 0) < stamp or not hmac.compare_digest(a.get('recoveryHash', ''), digest(recovery)):
                        raise ApiError('This student already joined on another browser. Resume there, or ask your teacher for a recovery code.', 409, 'duplicate_student')
                    other = self.db.execute('SELECT id FROM attempts WHERE room=? AND device=? AND id<>?', (r['code'], device, a['id'])).fetchone()
                    if other:
                        raise ApiError('Another student is using this browser. Use a separate browser profile.', 409)
                    a['deviceHash'] = device
                    a['recoveryHash'], a['recoveryUntil'] = '', 0
                self._touch(a, data)
                self._attempt_save(a)
                return self._snapshot(a, r, True)
            if self.db.execute('SELECT id FROM attempts WHERE room=? AND device=?', (r['code'], device)).fetchone():
                raise ApiError('This browser already has an attempt in this room. Resume that attempt instead.', 409, 'duplicate_device')
            if r['status'] == 'ended' or (r['status'] == 'running' and not r['allowLateJoin']):
                raise ApiError('This room is not accepting new students. Ask your teacher.', 409, 'room_closed')
            if self.db.execute('SELECT COUNT(*) FROM attempts WHERE room=?', (r['code'],)).fetchone()[0] >= 500:
                raise ApiError('The room has reached its student limit.', 409)
            questions = []
            rng = secrets.SystemRandom()
            for q in rng.sample(list(self.questions.values()), len(self.questions)):
                questions.append({'id': q['id'], 'number': q['number'], 'topic': q['topic'], 'prompt': q['prompt'], 'visual': q.get('visual', {}), 'options': rng.sample(q['options'], len(q['options']))})
            a = {'id': secrets.token_hex(16), 'roomCode': r['code'], 'deviceHash': device,
                 'student': student, 'questions': questions, 'answers': {}, 'revision': 0,
                 'submitted': False, 'receipt': None, 'joinedAt': stamp, 'lastSeen': stamp,
                 'visible': True, 'currentPosition': 0, 'startedAt': stamp if r['status'] == 'running' else None}
            self.db.execute('INSERT INTO attempts VALUES (?,?,?,?,?)', (a['id'], r['code'], identity, device, compact(a)))
            return self._snapshot(a, r, True)
        if action in ('state', 'save', 'submit'):
            a, r = self._get_attempt(data, token)
            self._touch(a, data)
            if not a['submitted'] and action in ('save', 'submit'):
                if r['status'] != 'running':
                    raise ApiError('Wait for your teacher to start the quiz.', 409, 'not_running')
                revision = self._revision(data.get('revision'))
                answers = self._clean_answers(data.get('answers'))
                if revision == a['revision'] and answers != a['answers']:
                    raise ApiError('Another tab has different answers at this revision. Resume the server copy before continuing.', 409, 'revision_conflict')
                if revision > a['revision']:
                    a['answers'], a['revision'] = answers, revision
                if action == 'submit':
                    if revision < a['revision']:
                        raise ApiError('Newer answers are already saved. Reload and review them before submitting.', 409, 'revision_conflict')
                    self._finish(a, r, 'student', stamp)
            self._attempt_save(a)
            return self._snapshot(a, r, data.get('needQuestions', False) is True)
        raise ApiError('Unknown API action.')

class QuizHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 128
    def __init__(self, address, store):
        self.store = store
        self.rate = defaultdict(deque)
        self.rate_lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(100)
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

class Handler(BaseHTTPRequestHandler):
    server_version = 'PacketQuestLive'
    protocol_version = 'HTTP/1.0'

    def setup(self):
        super().setup()
        self.connection.settimeout(20)

    def log_message(self, fmt, *args):
        # Do not log teacher tokens, student identities, answer data, or URL query strings.
        if os.environ.get('PACKET_DEBUG_HTTP') == '1':
            print('[HTTP] ' + fmt % args, flush=True)

    def _origin(self):
        origin = self.headers.get('Origin', '').rstrip('/')
        if not origin:
            return ''
        host = self.headers.get('Host', '')
        allowed = origin in ('http://' + host, 'https://' + host) or origin in self.server.store.allowed_origins or origin == self.server.store.public_url
        if not allowed and self.server.store.allow_pages_origins:
            try:
                u = urlsplit(origin)
                h = (u.hostname or '').lower()
                allowed = u.scheme == 'https' and (h.endswith('.github.io') or h.endswith('.pages.dev') or h.endswith('.netlify.app'))
            except ValueError:
                allowed = False
        if allowed:
            return origin
        raise ApiError('This website is not authorized to use the quiz server. Open the exact GitHub Pages room link from your teacher.', 403, 'origin')

    def _send(self, status, body=b'', mime='application/json; charset=utf-8', origin=''):
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
            self.send_header('Access-Control-Max-Age', '600')
        self.end_headers()
        if self.command != 'HEAD':
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _json(self, value, status=200, origin=''):
        self._send(status, compact(value).encode('utf-8'), origin=origin)

    def do_OPTIONS(self):
        try:
            self._send(204, origin=self._origin())
        except ApiError as e:
            self._json({'error': str(e), 'code': e.code}, e.status)

    def _limit(self, key, maximum, period=60):
        stamp = time.monotonic()
        with self.server.rate_lock:
            entries = self.server.rate[key]
            while entries and entries[0] < stamp-period:
                entries.popleft()
            if len(entries) >= maximum:
                raise ApiError('Too many requests. Wait a moment; saved answers have not been reset.', 429, 'rate_limit')
            entries.append(stamp)
            if len(self.server.rate) > 4000:
                for k, q in list(self.server.rate.items()):
                    if not q or q[-1] < stamp-600:
                        del self.server.rate[k]

    def do_POST(self):
        origin = ''
        try:
            if urlsplit(self.path).path not in ('/api/quiz', '/api/packet/v1'):
                raise ApiError('API route not found.', 404)
            origin = self._origin()
            if self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/json':
                raise ApiError('Use application/json.', 415)
            length = self.headers.get('Content-Length', '')
            if not length.isdigit() or not 0 < int(length) <= 100000:
                raise ApiError('Request is empty or too large.', 413)
            raw = self.rfile.read(int(length))
            try:
                data = json.loads(raw.decode('utf-8'), parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))
            except (ValueError, UnicodeDecodeError):
                raise ApiError('The request is not valid JSON.')
            auth = self.headers.get('Authorization', '')
            token = auth[7:] if auth.startswith('Bearer ') else ''
            action = data.get('action') if isinstance(data, dict) else None
            # A class may share one public IP. Authenticated limits are per credential, not per classroom IP.
            if action == 'teacher_login':
                self._limit('login:' + self.client_address[0], 60, 600)
            elif token:
                self._limit('token:' + digest(token), 240)
            else:
                self._limit('public:' + self.client_address[0], 1800)
            self._json(self.server.store.call(data, token), origin=origin)
        except ApiError as e:
            self._json({'error': str(e), 'code': e.code}, e.status, origin)
        except (TimeoutError, ConnectionResetError, BrokenPipeError):
            return
        except Exception as e:
            print('[server error] ' + type(e).__name__, flush=True)
            self._json({'error': 'The server could not complete this request. Your previous saved answers remain recorded. Retry shortly.', 'code': 'server_error'}, 500, origin)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        if path == '/healthz':
            origin = ''
            try:
                origin = self._origin()
            except ApiError as e:
                self._json({'error': str(e), 'code': e.code}, e.status)
                return
            self._json(self.server.store.call({'action': 'info'}), origin=origin)
            return
        if path in ('/', '/index.html'):
            rel = Path('index.html')
        elif path in ('/teacher', '/teacher/', '/teacher/index.html'):
            rel = Path('teacher/index.html')
        elif path in ('/sw.js', '/config.js', '/.nojekyll'):
            rel = Path(path.lstrip('/'))
        elif path.startswith('/assets/') and '..' not in Path(path).parts:
            rel = Path(path.lstrip('/'))
        else:
            self._json({'error': 'Not found.'}, 404)
            return
        root = SITE_ROOT
        target = (root / rel).resolve()
        if root not in target.parents or not target.is_file():
            self._json({'error': 'Not found.'}, 404)
            return
        mime = mimetypes.guess_type(str(target))[0] or 'application/octet-stream'
        if target.suffix in ('.js', '.css', '.html'):
            mime += '; charset=utf-8'
        self._send(200, target.read_bytes(), mime)

def main():
    parser = argparse.ArgumentParser(description='Packet Quest Live server')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=int(os.environ.get('PORT', '8765')))
    parser.add_argument('--data-dir')
    args = parser.parse_args()
    data_dir = args.data_dir or os.environ.get('PACKET_DATA_DIR') or (ROOT / 'runtime')
    guard = RuntimeLock(data_dir)
    try:
        store = QuizStore(private_dir=data_dir)
    except Exception:
        guard.close(); raise
    try:
        httpd = QuizHTTPServer((args.host, args.port), store)
    except OSError as e:
        store.close(); guard.close()
        raise SystemExit('Could not open that port. Use launcher.py or choose another --port. ' + str(e))
    print('Packet Quest GitHub Live | ' + VERSION, flush=True)
    print('Local teacher test: http://127.0.0.1:%d/teacher/' % httpd.server_port, flush=True)
    print('Private teacher key: ' + store.key, flush=True)
    print('Keep this process online during the quiz. Records expire after seven days unless exported.', flush=True)
    try:
        httpd.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        store.close(); guard.close()

if __name__ == '__main__':
    main()
