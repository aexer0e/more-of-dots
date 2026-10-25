"""Probe nearby waypoints with copies of a native core after capturing its prefix.

Controlled experiments are diagnostics, never full replay parity receipts.
"""
import copy
import json
from pathlib import Path

configuration=json.loads(Path(PARITY_CONFIG).read_text(encoding='utf-8-sig'))
source=Path(configuration['capture_source']).read_text(encoding='utf-8')
exec(compile(source,configuration['capture_source'],'exec'),globals())
if not json.loads(Path(configuration['status']).read_text()).get('ok'):
    raise RuntimeError('Original diagnostic capture did not complete')
try:
    experiments=[]
    cases=[(goal,[]) for goal in [[150,5],[140,5],[130,5],[150,25],[150,35]]]
    cases.append(([150,5],[[200,200]]))
    for goal,tail in cases:
        probe=copy.copy(core)
        for name,value in vars(core).items():
            if isinstance(value,np.ndarray):setattr(probe,name,value.copy())
        dot=copy.copy(core.dots[0]);vars(dot).update(copy.deepcopy(vars(core.dots[0])))
        dot.position=np.array([161.62,12.03],dtype=np.float64)
        dot.znmqz=np.array([goal,*tail],dtype=np.int64)
        dot.stuck_timer=0
        dot.target=None
        probe.dots=np.array([dot],dtype=object)
        probe.alive_dots=np.array([0],dtype=np.int64) if isinstance(core.alive_dots,np.ndarray) else [0]
        probe.dead_dots=[]
        before=plain(dot)
        type(probe).move_dots(probe)
        experiments.append({'goal':goal,'tail':tail,'before':before,'after':plain(dot)})
    Path(configuration['experiment_output']).write_text(json.dumps({'dot_radius':plain(core.dot_radius),
        'native_exe_sha256':loaded_hash,'experiments':experiments},indent=2),encoding='utf-8')

except Exception:
    import traceback
    Path(configuration["experiment_output"]).write_text(json.dumps({"error":traceback.format_exc()},indent=2),encoding="utf-8")
    raise
