"""Log native normalization calls at a selected tick, returning original results."""
import builtins
import json
import math
from pathlib import Path

configuration=json.loads(Path(PARITY_CONFIG).read_text(encoding='utf-8-sig'))
source=Path(configuration['capture_source']).read_text(encoding='utf-8')
instrumentation='''
    research_math=[]
    for math_label,math_owner,math_name in [('numpy.hypot',np,'hypot'),('numpy.sqrt',np,'sqrt'),
            ('numpy.linalg.norm',np.linalg,'norm'),('math.hypot',math,'hypot'),
            ('numpy.sum',np,'sum'),('numpy.dot',np,'dot'),('numpy.matmul',np,'matmul'),
            ('builtins.sum',builtins,'sum'),('numpy.round',np,'round')]:
        def make_math_logger(label,fn):
            def math_logger(*args,**kwargs):
                result=fn(*args,**kwargs)
                if core.frame==config['math_frame']:
                    try:
                        arguments=plain(args)
                    except TypeError:
                        arguments=[repr(arg) for arg in args]
                    research_math.append({'function':label,'arguments':arguments,
                        'argument_types':[type(arg).__name__ for arg in args],
                        'keywords':plain(kwargs),'result':plain(result)})
                return result
            return math_logger
        patch(math_owner,math_name,make_math_logger(math_label,getattr(math_owner,math_name)))
'''
source=source.replace('    initial = state(core)',instrumentation+'\n    initial = state(core)',1)
try:
    exec(compile(source,configuration['capture_source'],'exec'),globals())
finally:
    if 'research_math' in globals():
        Path(configuration['math_output']).write_text(json.dumps({'configuration':configuration,'calls':research_math}),encoding='utf-8')
