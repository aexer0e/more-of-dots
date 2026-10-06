"""Export compiled built-in map data from an authenticated isolated game."""
import hashlib
import json
from pathlib import Path
import sys
import time
import numpy as np

config=json.loads(Path(PARITY_CONFIG).read_text(encoding='utf-8-sig'))
main=sys.modules['__main__']
deadline=time.monotonic()+60
while not hasattr(main,'maps'):
    if time.monotonic()>deadline:raise RuntimeError('Native built-in maps did not load')
    time.sleep(.25)
def plain(value):
    if isinstance(value,np.ndarray):return plain(value.tolist())
    if isinstance(value,np.generic):return value.item()
    if isinstance(value,dict):return {str(k):plain(v) for k,v in value.items()}
    if isinstance(value,(list,tuple)):return [plain(v) for v in value]
    if value is None or isinstance(value,(str,int,float,bool)):return value
    raise TypeError(f'Unexpected native catalog value: {type(value).__name__}')
loaded=Path(main.__compiled__.original_argv0)
actual=hashlib.sha256(loaded.read_bytes()).hexdigest()
if actual!=hashlib.sha256(Path(config['game_exe']).read_bytes()).hexdigest():
    raise RuntimeError('Loaded native executable differs from the authenticated build')
result={'executable':str(loaded),'binary_sha256':actual,'native_version':getattr(main,'version',None),
        'pygame_version':main.pygame.version.ver,
        'maps_type':type(main.maps).__name__,'maps':plain(main.maps)}
Path(config['output']).write_text(json.dumps(result,indent=2),encoding='utf-8')
