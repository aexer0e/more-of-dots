"""Read native replay entry points in an isolated game process.

Executed by the development probe; PARITY_CONFIG is supplied by its wrapper.
"""
import gc
import hashlib
import inspect
import json
from pathlib import Path
import sys
import time
import traceback

config = json.loads(Path(PARITY_CONFIG).read_text(encoding='utf-8-sig'))
output = Path(config['output'])
try:
    main = sys.modules['__main__']
    deadline = time.monotonic() + 60
    while not any(isinstance(v, type) and hasattr(v, 'move_dots') for v in list(vars(main).values())):
        if time.monotonic() >= deadline:
            raise RuntimeError('Game did not finish loading its simulation classes')
        time.sleep(0.25)
    def describe(fn):
        code = getattr(fn, '__code__', None)
        try:
            signature = str(inspect.signature(fn))
        except Exception:
            signature = None
        return dict(signature=signature, locals=list(getattr(code, 'co_varnames', [])),
                    line=getattr(code, 'co_firstlineno', None))
    classes = {}
    for name, cls in list(vars(main).items()):
        if not isinstance(cls, type):
            continue
        methods = {name: describe(fn) for name, fn in vars(cls).items()
                   if callable(fn) and hasattr(fn, '__code__')}
        if (hasattr(cls, 'move_dots') or hasattr(cls, 'start_game')
                or any(token in name.lower() for token in ('replay', 'core', 'econom', 'map', 'connection', 'config'))):
            classes[name] = dict(name=cls.__name__, methods=methods)
    loaded_exe = Path(main.__compiled__.original_argv0)
    loaded_hash = hashlib.sha256(loaded_exe.read_bytes()).hexdigest()
    if loaded_hash != hashlib.sha256(Path(config['game_exe']).read_bytes()).hexdigest():
        raise RuntimeError('Loaded native executable does not match the preserved build')
    result = dict(ok=True, executable=str(loaded_exe), python=sys.version,
        binary_sha256=loaded_hash,
        main_names=sorted(vars(main)), classes=classes,
        constants={k:v for k,v in vars(main).items() if isinstance(v,(str,int,float,bool))
                   and any(token in k.lower() for token in ('version', 'fps', 'frame', 'tick'))},
        scenes=sorted({type(o).__name__ for o in gc.get_objects() if 'scene' in type(o).__name__.lower()}))
    result['config_manager']={k:(str(v)[:300] if not isinstance(v,dict) else list(v))
        for k,v in vars(main.config_manager).items()} if hasattr(main,'config_manager') else None
    result['scene_manager']={k:type(v).__name__ for k,v in vars(main.scene_manager).items()} if hasattr(main,'scene_manager') else None
except Exception:
    result = dict(ok=False, error=traceback.format_exc())
output.write_text(json.dumps(result, indent=2), encoding='utf-8')
