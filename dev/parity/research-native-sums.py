"""Observe ndarray reductions without replacing their numerical implementation."""
import json
from pathlib import Path

configuration=json.loads(Path(PARITY_CONFIG).read_text(encoding='utf-8-sig'))
source=Path(configuration['capture_source']).read_text(encoding='utf-8')
instrumentation='''
    research_sums=[]
    original_array_sum=np.ndarray.sum
    class SumTraceArray(np.ndarray):
        def sum(self,*args,**kwargs):
            result=original_array_sum(self,*args,**kwargs)
            if core.frame==config['sum_frame']:
                research_sums.append({'shape':list(self.shape),'strides':list(self.strides),
                    'values':plain(self),'arguments':plain(args),'keywords':plain(kwargs),
                    'result':plain(result)})
            return result
    offset=getattr(core,'precomputed_dot_perimeter_offsets',None)
    research_offset_type=type(offset).__name__
    if isinstance(offset,np.ndarray):
        patch(core,'precomputed_dot_perimeter_offsets',offset.view(SumTraceArray))
    for array_name in ['array','asarray']:
        def make_array_logger(fn):
            def array_logger(*args,**kwargs):
                result=fn(*args,**kwargs)
                if core.frame==config['sum_frame'] and isinstance(result,np.ndarray):
                    return result.view(SumTraceArray)
                return result
            return array_logger
        patch(np,array_name,make_array_logger(getattr(np,array_name)))
'''
source=source.replace('    initial = state(core)',instrumentation+'\n    initial = state(core)',1)
try:
    exec(compile(source,configuration['capture_source'],'exec'),globals())
finally:
    if 'research_sums' in globals():
        Path(configuration['sum_output']).write_text(json.dumps({'configuration':configuration,
            'offset_type':research_offset_type,'calls':research_sums}),encoding='utf-8')
