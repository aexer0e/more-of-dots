# Runs inside the game's Python interpreter. The game connects to the game
# server with the lowest measured latency, so every server except the chosen
# one fails its latency probe. Running it again only changes the chosen region.
#
# The game's server list is not in region order and can include servers that
# no longer answer, so each server's region comes from its reverse DNS name and
# the chosen one is the fastest server in that region that accepts connections.
#
# The Play screen keeps one connection open for its player counts and ping.
# Applying a region closes it, and the screen's next poll reconnects to the
# chosen region's server.
import gc
import inspect
import json
import os
import re
import socket
import sys
import time
import threading
import traceback
import weakref

OUTPUT_PATH = r'''__OUTPUT_PATH__'''
REGION = r'''__REGION__'''
# The server list from an earlier session, for when this game cannot provide one.
SAVED_SERVERS = json.loads(r'''__SAVED_SERVERS__''' or '[]')
REGION_NAMES = ['NA', 'EU', 'ASIA']
REGION_TITLES = {'NA': 'North America', 'EU': 'Europe', 'ASIA': 'Asia'}
# Cloud regions by name prefix, as in ec2-1-2-3-4.eu-central-1.compute.amazonaws.com.
CLOUD_REGION_PREFIXES = {'NA': ('us-', 'ca-'), 'EU': ('eu-',), 'ASIA': ('ap-',)}
# Host name labels that name a region, for servers without a cloud name.
REGION_LABELS = {'NA': ('na', 'us', 'america'), 'EU': ('eu', 'europe'), 'ASIA': ('asia', 'sg')}
CHECK_TIMEOUT = 2.0
CHECK_LIFETIME = 300
STEERING_KEY = '_more_of_dots_region_steering'
PLAYER_COUNT_FUNCTION = 'get_player_data'
LATENCY_FUNCTIONS = {'measure_ws_latency', 'pick_best_server'}
CREATE_CONNECTION_ORIGINAL = '_more_of_dots_original_create_connection'
GET_GAMESERVERS_ORIGINAL = '_more_of_dots_original_get_gameservers'
REQUEST_ORIGINAL = '_more_of_dots_original_request'
# A game server address, with or without the scheme the game adds itself.
SERVER_PATTERN = re.compile(r'^(?:wss?://[^\s/]+(?:/\S*)?|[A-Za-z0-9._-]+:\d{2,5}(?:/\S*)?)$')


def server_key(url):
    key = url.strip().lower()
    for scheme in ('ws://', 'wss://'):
        if key.startswith(scheme):
            key = key[len(scheme):]
    return key.rstrip('/')


def steering_state(module):
    state = getattr(module, STEERING_KEY, None)
    if not isinstance(state, dict):
        state = {}
        setattr(module, STEERING_KEY, state)
    state.setdefault('servers', [])
    state.setdefault('serversSource', None)
    state.setdefault('latencyUrls', [])
    state.setdefault('blockedLatencyUrls', [])
    state.setdefault('redirectedUrls', [])
    state.setdefault('playerCountSockets', [])
    state.setdefault('gameserversPreview', None)
    state.update({'region': REGION, 'updatedAt': int(time.time())})
    return state


def known_servers(state):
    # The list the game was given, or else the addresses its latency probes used.
    if state.get('servers'):
        return state['servers']
    latency = state.get('latencyUrls') or []
    return latency if len(latency) >= 2 else []


def check_server(url):
    address = server_key(url).split('/')[0]
    host, _, port = address.rpartition(':') if ':' in address else (address, '', '')
    info = {'url': url, 'host': host, 'cloudRegion': None, 'region': None, 'reachable': False, 'ms': None}
    try:
        name = socket.gethostbyaddr(host)[0].lower()
        match = re.search(r'\.([a-z]{2}-[a-z]+-\d+)\.compute', name)
        info['cloudRegion'] = match.group(1) if match else None
    except (OSError, UnicodeError):
        name = host.lower()
    if info['cloudRegion']:
        info['region'] = next((region for region, prefixes in CLOUD_REGION_PREFIXES.items()
                               if info['cloudRegion'].startswith(prefixes)), None)
    else:
        labels = set(re.split(r'[.:/_-]', name))
        info['region'] = next((region for region, names in REGION_LABELS.items() if labels & set(names)), None)
    start = time.perf_counter()
    try:
        socket.create_connection((host, int(port or 80)), timeout=CHECK_TIMEOUT).close()
        info['reachable'] = True
        info['ms'] = round((time.perf_counter() - start) * 1000)
    except (OSError, ValueError):
        pass
    return info


def server_info(state):
    # Checked in parallel and kept for a few minutes; the first check runs on
    # whichever thread asks, including the game's own network thread.
    servers = known_servers(state)
    if not servers:
        return []
    key = [server_key(server) for server in servers]
    if state.get('serverInfoKey') == key and time.time() - state.get('serverInfoAt', 0) < CHECK_LIFETIME:
        return state['serverInfo']
    found = [None] * len(servers)

    def check(index, server):
        found[index] = check_server(server)

    threads = [threading.Thread(target=check, args=item, daemon=True) for item in enumerate(servers)]
    for thread in threads:
        thread.start()
    deadline = time.time() + CHECK_TIMEOUT + 3
    for thread in threads:
        thread.join(max(0.0, deadline - time.time()))
    info = [item or {'url': server, 'host': None, 'cloudRegion': None, 'region': None, 'reachable': False, 'ms': None}
            for item, server in zip(found, servers)]
    state.update({'serverInfo': info, 'serverInfoKey': key, 'serverInfoAt': time.time()})
    log_event(state, 'checked', servers=info)
    return info


def selected_server(state):
    candidates = [item for item in server_info(state) if item['region'] == REGION and item['reachable']]
    return min(candidates, key=lambda item: item['ms'])['url'] if candidates else None


def full_url(state, server):
    # The address as the game itself connects to it.
    for url in state.get('latencyUrls') or []:
        if server_key(url) == server_key(server):
            return url
    return server if '://' in server else 'ws://' + server


EVENT_LIMIT = 300


def log_event(state, kind, **fields):
    if state.get('eventCount', 0) >= EVENT_LIMIT:
        return
    state['eventCount'] = state.get('eventCount', 0) + 1
    fields.update({'time': round(time.time(), 2), 'event': kind, 'thread': threading.current_thread().name})
    try:
        with open(os.path.join(os.path.dirname(OUTPUT_PATH), 'region-events.log'), 'a', encoding='utf-8') as handle:
            handle.write(json.dumps(fields, default=str) + '\n')
    except Exception:
        pass


def write_result(result):
    result['region'] = REGION
    result['writtenAt'] = int(time.time())
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    temp_path = OUTPUT_PATH + '.tmp'
    with open(temp_path, 'w', encoding='utf-8') as handle:
        json.dump(result, handle, indent=2, default=str)
    os.replace(temp_path, OUTPUT_PATH)


def normalize_servers(value):
    if not isinstance(value, (list, tuple)) or not value:
        return None
    servers = [item.strip() for item in value if isinstance(item, str) and SERVER_PATTERN.match(item.strip())]
    return servers if len(servers) == len(value) else None


def extract_gameservers(value, depth=5):
    if depth <= 0:
        return None
    servers = normalize_servers(value)
    if servers:
        return servers
    if isinstance(value, dict):
        for key in ('gameservers', 'game_servers', 'servers', 'content', 'data', 'response', 'result', 'payload'):
            if key in value:
                servers = extract_gameservers(value.get(key), depth - 1)
                if servers:
                    return servers
        for child in value.values():
            servers = extract_gameservers(child, depth - 1)
            if servers:
                return servers
    elif isinstance(value, (list, tuple)):
        for child in value:
            servers = extract_gameservers(child, depth - 1)
            if servers:
                return servers
    elif isinstance(value, str) and value.strip()[:1] in '[{':
        try:
            return extract_gameservers(json.loads(value), depth - 1)
        except ValueError:
            return None
    else:
        attrs = getattr(value, '__dict__', None)
        if isinstance(attrs, dict):
            return extract_gameservers(attrs, depth - 1)
    return None


def record_servers(module, value, source):
    servers = extract_gameservers(value)
    if not servers:
        return None
    state = getattr(module, STEERING_KEY)
    state['servers'] = list(servers)
    state['serversSource'] = source
    return servers


def collect_server_manager_classes(module):
    classes = []
    seen = set()

    def add_class(candidate):
        if not isinstance(candidate, type) or id(candidate) in seen:
            return
        if callable(getattr(candidate, 'get_gameservers', None)):
            seen.add(id(candidate))
            classes.append(candidate)

    add_class(getattr(module, 'ServerManager', None))
    for value in list(vars(module).values()):
        if type(value).__name__ == 'ServerManager':
            add_class(type(value))
    for value in gc.get_objects():
        try:
            if type(value).__name__ == 'ServerManager':
                add_class(type(value))
        except Exception:
            pass
    return classes


def patch_server_manager_classes(module, classes, result):
    def make_wrapper(cls, original):
        def get_gameservers(self, *args, **kwargs):
            value = original(self, *args, **kwargs)
            try:
                state = getattr(module, STEERING_KEY)
                state['gameserversPreview'] = repr(value)[:400]
                servers = record_servers(module, value, '%s.get_gameservers' % getattr(cls, '__name__', 'ServerManager'))
                log_event(state, 'get_gameservers', preview=repr(value)[:400], servers=servers, stack=call_stack()[:8])
            except Exception:
                pass
            return value
        return get_gameservers

    def make_request_wrapper(cls, original):
        def request(self, *args, **kwargs):
            value = original(self, *args, **kwargs)
            try:
                asked = repr((args, kwargs))[:300]
                if 'gameserver' in asked or 'gameserver' in repr(value)[:2000]:
                    state = getattr(module, STEERING_KEY)
                    state['gameserversPreview'] = repr(value)[:400]
                    servers = record_servers(module, value, '%s.request' % getattr(cls, '__name__', 'ServerManager'))
                    log_event(state, 'request', asked=asked, preview=repr(value)[:400], servers=servers, stack=call_stack()[:8])
            except Exception:
                pass
            return value
        return request

    for cls in classes:
        try:
            original = getattr(cls, REQUEST_ORIGINAL, None)
            if original is None:
                original = getattr(cls, 'request', None)
                setattr(cls, REQUEST_ORIGINAL, original)
            if callable(original):
                setattr(cls, 'request', make_request_wrapper(cls, original))
        except Exception as exc:
            result['notes'].append('Could not watch %s.request: %r' % (getattr(cls, '__name__', 'ServerManager'), exc))

    for cls in classes:
        name = getattr(cls, '__name__', 'ServerManager')
        try:
            original = getattr(cls, GET_GAMESERVERS_ORIGINAL, None)
            if original is None:
                original = getattr(cls, 'get_gameservers', None)
                setattr(cls, GET_GAMESERVERS_ORIGINAL, original)
            if callable(original):
                setattr(cls, 'get_gameservers', make_wrapper(cls, original))
                result['patchedServerManagerClasses'].append(name)
            else:
                result['notes'].append('%s.get_gameservers was not callable.' % name)
        except Exception as exc:
            result['notes'].append('Could not patch %s.get_gameservers: %r' % (name, exc))


def call_stack():
    # Function names from the innermost call outwards, without the probe's own.
    names = []
    frame = inspect.currentframe()
    while frame is not None:
        # PyRun_SimpleString names the probe's code <string>.
        if frame.f_code.co_filename not in ('<string>', 'payload'):
            names.append(frame.f_code.co_name)
        frame = frame.f_back
    return names


def call_stack_names():
    return set(call_stack())


def seed_servers(module):
    # The list is normally recorded when the game next asks for it. Until then,
    # a list the game already holds lets the first selection take effect.
    state = getattr(module, STEERING_KEY)
    if state.get('servers'):
        return
    own_lists = [item for item in state.values() if isinstance(item, list)]
    for value in gc.get_objects():
        try:
            if any(value is own for own in own_lists):
                continue
            if isinstance(value, list) and 2 <= len(value) <= 10 and normalize_servers(value) == value:
                record_servers(module, value, 'existing list')
                return
        except Exception:
            pass


def websocket_exception_class():
    for module_name in ('websocket', 'websocket._exceptions'):
        module = sys.modules.get(module_name)
        if module is None:
            continue
        for name in ('WebSocketException', 'WebSocketConnectionClosedException', 'WebSocketTimeoutException'):
            candidate = getattr(module, name, None)
            if isinstance(candidate, type):
                return candidate
    return RuntimeError


def remember(items, value, limit=12):
    if value not in items and len(items) < limit:
        items.append(value)


def make_create_connection_wrapper(module, original):
    def create_connection(*args, **kwargs):
        url = args[0] if args else kwargs.get('url')
        if not isinstance(url, str):
            return original(*args, **kwargs)
        state = getattr(module, STEERING_KEY)
        ordered = call_stack()
        stack = set(ordered)
        key = server_key(url)
        log_event(state, 'connect', url=url, stack=ordered[:8], selected=selected_server(state), known=known_servers(state))
        if stack & LATENCY_FUNCTIONS:
            if all(server_key(seen) != key for seen in state['latencyUrls']):
                remember(state['latencyUrls'], url)
            selected = selected_server(state)
            known = {server_key(server) for server in known_servers(state)}
            if selected and key in known and key != server_key(selected):
                remember(state['blockedLatencyUrls'], url)
                log_event(state, 'blocked', url=url)
                time.sleep(0.25)
                raise websocket_exception_class()('This server is outside the selected region.')
            return original(*args, **kwargs)
        if PLAYER_COUNT_FUNCTION in stack:
            # The first poll after a change may still have chosen by latency
            # alone; its connection goes to the chosen server instead.
            selected = selected_server(state)
            known = {server_key(server) for server in known_servers(state)}
            if selected and key in known and key != server_key(selected):
                remember(state['redirectedUrls'], url)
                url = full_url(state, selected)
                log_event(state, 'redirected', url=url)
                args = (url,) + tuple(args[1:]) if args else args
                if not args:
                    kwargs['url'] = url
            connection = original(*args, **kwargs)
            sockets = state['playerCountSockets']
            sockets[:] = [ref for ref in sockets if ref() is not None] + [weakref.ref(connection)]
            return connection
        return original(*args, **kwargs)
    return create_connection


def patch_create_connection(module, result):
    targets = (
        (module, '__main__.create_connection'),
        (sys.modules.get('websocket'), 'websocket.create_connection'),
        (sys.modules.get('websocket._core'), 'websocket._core.create_connection'),
    )
    for owner, label in targets:
        if owner is None:
            continue
        try:
            original = getattr(owner, CREATE_CONNECTION_ORIGINAL, None)
            if original is None:
                original = getattr(owner, 'create_connection', None)
                if not callable(original):
                    continue
                setattr(owner, CREATE_CONNECTION_ORIGINAL, original)
            setattr(owner, 'create_connection', make_create_connection_wrapper(module, original))
            result['patchedCreateConnectionTargets'].append(label)
        except Exception as exc:
            result['notes'].append('Could not patch %s: %r' % (label, exc))


def instances_of(class_name):
    found = []
    for value in gc.get_objects():
        try:
            if type(value).__name__ == class_name:
                found.append(value)
        except Exception:
            pass
    return found


def is_websocket(value):
    for module_name in ('websocket', 'websocket._core'):
        cls = getattr(sys.modules.get(module_name), 'WebSocket', None)
        if isinstance(cls, type) and isinstance(value, cls):
            return True
    return False


def owned_by_player_counts(connection, scene_holders, match_holders):
    # Walks a few steps up the objects holding the connection, looking for a
    # Play screen attribute or a closure of its player count function. A
    # connection held by a match is never touched.
    seen = set()
    level = [connection]
    for _ in range(3):
        next_level = []
        for item in level:
            for holder in gc.get_referrers(item):
                if id(holder) in seen or holder is level or inspect.isframe(holder):
                    continue
                seen.add(id(holder))
                if any(holder is match for match in match_holders):
                    return None
                if any(holder is scene for scene in scene_holders):
                    return 'PlayScene attribute'
                qualname = getattr(holder, '__qualname__', None)
                if isinstance(qualname, str) and PLAYER_COUNT_FUNCTION in qualname:
                    return qualname
                next_level.append(holder)
        level = next_level
    return None


def reconnect_player_counts(module, result):
    state = getattr(module, STEERING_KEY)
    scenes = instances_of('PlayScene')
    matches = instances_of('NetworkConnection')
    # Attributes may be held by the instance itself or by its __dict__.
    scene_holders = scenes + [vars(scene) for scene in scenes]
    match_holders = matches + [vars(match) for match in matches]
    closing = {}
    for ref in state['playerCountSockets']:
        connection = ref()
        if connection is not None:
            closing[id(connection)] = (connection, 'tracked')
    for value in gc.get_objects():
        try:
            if id(value) not in closing and is_websocket(value):
                owner = owned_by_player_counts(value, scene_holders, match_holders)
                if owner:
                    closing[id(value)] = (value, owner)
        except Exception:
            pass
    closed = []
    for connection, owner in closing.values():
        try:
            if getattr(connection, 'connected', True):
                connection.close(timeout=1)
                closed.append(owner)
        except Exception as exc:
            result['notes'].append('Could not close a player count connection: %r' % (exc,))
    state['playerCountSockets'] = []
    for scene in scenes:
        # Poll again now rather than at the next scheduled refresh.
        if isinstance(getattr(scene, 'network_thread_next_time', None), (int, float)):
            scene.network_thread_next_time = 0
    result['playScreens'] = [
        sorted(name for name in vars(scene) if name.startswith(('network', 'ping', 'player', 'socket', 'ws')))
        for scene in scenes
    ]
    result['closedPlayerCountConnections'] = closed


def server_like_strings(limit=20):
    found = []
    for value in gc.get_objects():
        try:
            if isinstance(value, dict):
                items = list(value.items())
            elif isinstance(value, (list, tuple)):
                items = list(enumerate(value))
            else:
                continue
            for key, item in items[:50]:
                if isinstance(item, str) and SERVER_PATTERN.match(item.strip()):
                    found.append({'in': type(value).__name__, 'key': str(key)[:40], 'value': item[:120], 'size': len(value)})
                    if len(found) >= limit:
                        return found
        except Exception:
            pass
    return found


def ask_for_servers(module, result):
    # The Play screen fetches the list once and then reuses its first choice,
    # so a game that picked before the probe arrived is asked again, the same
    # way the Play screen asks, from a thread of its own with a time limit.
    managers = instances_of('ServerManager')
    if not managers:
        return

    def ask():
        try:
            managers[0].get_gameservers()
        except Exception as exc:
            result['notes'].append('Could not ask for the server list: %r' % (exc,))

    thread = threading.Thread(target=ask, daemon=True)
    thread.start()
    thread.join(5)


def main():
    module = sys.modules.get('__main__')
    result = {
        'status': 'armed',
        'patchedServerManagerClasses': [],
        'patchedCreateConnectionTargets': [],
        'notes': [],
    }
    if module is None:
        result['status'] = 'failed'
        result['message'] = 'The game script was not available.'
        write_result(result)
        return
    if REGION not in REGION_NAMES:
        result['status'] = 'invalid_region'
        write_result(result)
        return

    state = steering_state(module)
    seed_servers(module)
    if not state.get('servers'):
        # Recorded by the get_gameservers wrapper, so it is installed first.
        patch_server_manager_classes(module, collect_server_manager_classes(module), result)
        ask_for_servers(module, result)
    if not state.get('servers') and normalize_servers(SAVED_SERVERS):
        record_servers(module, SAVED_SERVERS, 'saved')
    info = server_info(state)
    result['serverInfo'] = info
    if info and not selected_server(state):
        available = sorted({REGION_TITLES[item['region']] for item in info if item['region'] and item['reachable']})
        result['status'] = 'no_server'
        result['message'] = 'War of Dots has no reachable %s server right now.%s' % (
            REGION_TITLES.get(REGION, REGION),
            ' Available: %s.' % ', '.join(available) if available else '',
        )
        log_event(state, 'unavailable', region=REGION, servers=info)
        write_result(result)
        return
    result['pending'] = not info
    if not result['patchedServerManagerClasses']:
        patch_server_manager_classes(module, collect_server_manager_classes(module), result)
    patch_create_connection(module, result)
    if not result['patchedCreateConnectionTargets']:
        result['status'] = 'failed'
        result['message'] = 'This version of War of Dots does not support region selection.'
        write_result(result)
        return
    log_event(state, 'applied', region=REGION, server=selected_server(state))
    reconnect_player_counts(module, result)
    result['serverLikeStrings'] = server_like_strings()
    # What the game has shown so far, for diagnosing a selection that has no effect.
    result['selectedServerUrl'] = selected_server(state)
    for name in ('servers', 'serversSource', 'latencyUrls', 'blockedLatencyUrls', 'redirectedUrls', 'gameserversPreview'):
        result[name] = state.get(name)
    write_result(result)


try:
    main()
except Exception as exc:
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH + '.error.txt', 'w', encoding='utf-8') as handle:
        handle.write(repr(exc) + '\n' + traceback.format_exc())
