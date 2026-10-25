"""Capture every native tick using the game's offline replay scene.

The injected wrapper supplies PARITY_CONFIG. Simulation methods are unmodified.
Rendering GL calls are stubbed because this development capture needs state only.
"""
import gzip
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import traceback
import numpy as np

config = json.loads(Path(PARITY_CONFIG).read_text(encoding='utf-8-sig'))
status = Path(config['status'])
main = sys.modules['__main__']

def plain(obj):
    if isinstance(obj, np.ndarray):
        return plain(obj.tolist())
    if isinstance(obj, np.generic):
        return obj.item()
    if isinstance(obj, (tuple, list)):
        return [plain(v) for v in obj]
    if isinstance(obj, dict):
        return {str(k): plain(v) for k,v in obj.items() if not callable(v)}
    if obj is None or isinstance(obj, (bool, int, float, str)):
        return obj
    return {k:plain(v) for k,v in vars(obj).items() if not callable(v)}

def state(core):
    identities = {id(d):i for i,d in enumerate(core.dots) if hasattr(d,'position')}
    dots = []
    for i,d in enumerate(core.dots):
        if not hasattr(d,'position'):
            dots.append(None)
            continue
        fields = {k:plain(getattr(d,k)) for k in (
            'position','color','type','health','max_health','morale','fighting','speed',
            'ship','water_timer','ship_timer','stuck_timer','objective_frame',
            'damage_received','in_city','healing','znmqz','zrtyqz') if hasattr(d,k)}
        fields['id'] = i
        if hasattr(d,'znmqz'):
            fields['path'] = plain(d.znmqz)
        if hasattr(d,'target'):
            fields['target'] = int(d.target) if isinstance(d.target,(int,np.integer)) else identities.get(id(d.target)) if d.target is not None else None
        dots.append(fields)
    fields = {k:plain(getattr(core,k)) for k in (
        'frame','winner','alive_dots','dead_dots','casualties','troop_casualties',
        'strength','capitals','cities','city_positions','psrandom') if hasattr(core,k)}
    if hasattr(core,'economy'):
        fields['economy'] = {'fields':plain(core.economy)}
    if hasattr(core,'line'):
        regions = core.line.regions
        fields['regions_sha256'] = hashlib.sha256(regions.tobytes()).hexdigest() if regions is not None else None
    return {'kind':'state','frame':int(core.frame),'dots':dots,'core':fields}

originals = []
try:
    deadline = time.monotonic()+60
    while not (hasattr(main,'aaadaa') and hasattr(main,'replay_manager') and hasattr(main,'sound_manager')):
        if time.monotonic() >= deadline:
            raise RuntimeError('Native scene class did not load')
        time.sleep(.25)
    # Globals are exported before old builds finish their normal main() startup.
    # Initialize the native configuration loader before constructing its scene.
    main.config_manager.load_config()
    source = Path(config['replay'])
    loaded_exe = Path(main.__compiled__.original_argv0)
    loaded_hash = hashlib.sha256(loaded_exe.read_bytes()).hexdigest()
    if loaded_hash != hashlib.sha256(Path(config['game_exe']).read_bytes()).hexdigest():
        raise RuntimeError('Loaded native executable does not match the preserved build')
    encoded = source.read_bytes()
    replay = json.loads(gzip.decompress(encoded) if encoded[:2]==b'\x1f\x8b' else encoded)
    end = min(int(replay['end']), int(config.get('max_frame', replay['end'])))
    def patch(owner,name,replacement):
        originals.append((owner,name,getattr(owner,name)))
        setattr(owner,name,replacement)
    def forbidden_network(*args,**kwargs):
        raise RuntimeError('Offline replay capture attempted a network connection')
    patch(main.NetworkConnection,'__init__',forbidden_network)
    patch(main.ReplayManager,'load_replay',lambda self,name:replay)
    # The native menu and the offscreen replay share a graphics-name cache.
    # A menu transition can remove a HUD texture while replay state is captured.
    # Deleting an already absent texture is harmless with GL disabled; keep all
    # simulation and ReplayConnection methods unchanged.
    graphics_type=type(main.opengl_manager)
    original_delete_image=graphics_type.delete_image
    def delete_offscreen_image(self,*args,**kwargs):
        try:
            return original_delete_image(self,*args,**kwargs)
        except KeyError:
            return None
    patch(graphics_type,'delete_image',delete_offscreen_image)
    for name,fn in list(vars(main).items()):
        if name.startswith('gl') and callable(fn):
            patch(main,name,lambda *args,**kwargs:0)
    status.write_text(json.dumps({'ok':False,'phase':'starting-scene'}))
    setup = {'type':'replay','mode':replay.get('mode','1v1'),'room':False,
        'room_info':{'code':None,'public_map_room':False},'custom_map':[],
        'campaign':False,'replay_file':str(source), 'skin':None,
        'palette':None,'wallpaper':None,'shader':None}
    if not hasattr(main,'GameCoreExperimental'):
        # Older scenes use mode="replay" to select ReplayConnection. Their
        # ordinary 1v1 mode constructs a live NetworkConnection instead.
        setup['mode']='replay'
    scene = main.aaadaa(setup)
    scene.start_game()
    cores = [(k,v) for k,v in vars(scene).items() if hasattr(v,'move_dots')]
    if len(cores)!=1:
        raise RuntimeError(f'Expected one native core: {[(k,type(v).__name__) for k,v in cores]}')
    core = cores[0][1]
    # Preserve actual native initial IDs and geometry for versioned map recovery.
    # Never substitute a deployment reconstructed from another game version.
    initial = state(core)
    initial['native_map_candidates'] = {
        owner_name+'.'+name:plain(value)
        for owner_name,owner in [('scene',scene),('core',core)]
        for name,value in vars(owner).items()
        if isinstance(value,dict) and (name in ('map','game_map','custom_map') or 'infantry' in value or 'tanks' in value or 'cities' in value)
    }
    initial['native_map_size']=plain(core.map_size) if hasattr(core,'map_size') else None
    initial['native_bridges']=plain(core.bridges) if hasattr(core,'bridges') else []
    if config.get('dump_terrain') and hasattr(core,'terrain_map'):
        terrain=core.terrain_map.astype('uint8')
        terrain_path=Path(config['scene_fields']).with_name('native-terrain.bin')
        terrain_path.write_bytes(terrain.tobytes())
        terrain_path.with_suffix('.json').write_text(json.dumps({'shape':list(terrain.shape),
            'terrain_colors_idx':plain(core.terrain_colors_idx),'bridges':plain(core.bridges)}),encoding='utf-8')
    Path(config['scene_fields']).with_name('native-initial.json').write_text(json.dumps(initial),encoding='utf-8')
    Path(config['scene_fields']).write_text(json.dumps({
        'scene':{k:type(v).__name__ for k,v in vars(scene).items()},
        'core':{k:type(v).__name__ for k,v in vars(core).items()},
        'unit':plain(vars(next(d for d in core.dots if hasattr(d,'position')))),
        'core_class':type(core).__name__, 'native_version':getattr(main,'version',None)
    },indent=2))
    output = Path(config['output'])
    temporary = output.with_name(output.name+'.partial')
    with gzip.open(temporary,'wt',encoding='utf-8',compresslevel=1) as stream:
        metadata = {'kind':'metadata','replay_sha256':hashlib.sha256(encoded).hexdigest(),
            'binary_sha256':loaded_hash,'executable':str(loaded_exe),'working_directory':os.getcwd(),
            'native_version':getattr(main,'version',None),'core_class':type(core).__name__,
            'method':'Native offline replay scene update and ReplayConnection; unmodified simulation; GL calls stubbed'}
        stream.write(json.dumps(metadata)+'\n')
        if int(core.frame)!=0:
            raise RuntimeError(f'Native initial frame is {core.frame}, expected zero')
        stream.write(json.dumps(state(core),separators=(',',':'))+'\n')
        original_tick = type(core).tick_frame
        captured={'next':1}
        def captured_tick(self,*args,**kwargs):
            result = original_tick(self,*args,**kwargs)
            if self is core and self.frame<=end:
                if int(self.frame)!=captured['next']:
                    raise RuntimeError(f'Native tick coverage gap: expected {captured["next"]}, got {self.frame}')
                stream.write(json.dumps(state(core),separators=(',',':'))+'\n')
                captured['next']+=1
            return result
        patch(type(core),'tick_frame',captured_tick)
        calls=0
        last_progress=-1
        while core.frame<end:
            before=core.frame
            scene.update()
            calls+=1
            if core.frame==before:
                raise RuntimeError(f'Native replay scene did not advance at frame {before}')
            if int(core.frame)//300 != last_progress:
                last_progress=int(core.frame)//300
                stream.flush()
                status.write_text(json.dumps({'ok':False,'phase':'capturing','frame':int(core.frame),'end':end}))
            if calls>end+10:
                raise RuntimeError('Native scene exceeded expected update count')
        if captured['next']!=end+1:
            raise RuntimeError(f'Native capture has {captured["next"]} states, expected {end+1}')
    temporary.replace(output)
    status.write_text(json.dumps({'ok':True,'phase':'completed','end':end,
                                 'frames':captured['next'],'scene_update_calls':calls,'output':str(output)}))
except Exception as error:
    details=[]
    tb=error.__traceback__
    while tb:
        if tb.tb_frame.f_code.co_name in ('__init__','start_game','update'):
            details.append({'method':tb.tb_frame.f_code.co_name,'line':tb.tb_lineno,
                'locals':{k:repr(v)[:2000] for k,v in tb.tb_frame.f_locals.items() if k in ('setup','default','content','zwerz')},
                'self_fields':sorted(vars(tb.tb_frame.f_locals['self'])) if 'self' in tb.tb_frame.f_locals and hasattr(tb.tb_frame.f_locals['self'],'__dict__') else []})
        tb=tb.tb_next
    status.write_text(json.dumps({'ok':False,'phase':'failed','error':traceback.format_exc(),'details':details}))
finally:
    for owner,name,fn in reversed(originals):
        setattr(owner,name,fn)
