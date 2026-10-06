"""Record matrix operands in a diagnostic replay through an ndarray view.

The view's operator passes plain arrays to the original NumPy matmul kernel.
This trace is research only, not an authoritative capture.
"""
import json
from pathlib import Path

configuration=json.loads(Path(PARITY_CONFIG).read_text(encoding='utf-8-sig'))
source=Path(configuration['capture_source']).read_text(encoding='utf-8')
instrumentation='''
    research_matmul=[]
    original_asarray=np.asarray
    class MatrixResearchView(np.ndarray):
        __array_priority__=10000
        def __rmatmul__(self,left):
            right=original_asarray(self)
            result=original_asarray(left)@right
            if core.frame==config['math_frame']:
                research_matmul.append({'left':plain(left),'left_dtype':str(left.dtype),
                    'left_strides':list(left.strides),'right':plain(right),
                    'right_strides':list(right.strides),'result':plain(result),
                    'numpy_version':np.__version__})
            return result
    for constructor_name in ['array','asarray','stack','vstack','column_stack']:
        def make_constructor(fn):
            def research_array(*args,**kwargs):
                result=fn(*args,**kwargs)
                if result.ndim==2 and result.shape[1]==2 and result.dtype==np.float64:
                    return result.view(MatrixResearchView)
                return result
            return research_array
        patch(np,constructor_name,make_constructor(getattr(np,constructor_name)))
'''
source=source.replace('    initial = state(core)',instrumentation+'\n    initial = state(core)',1)
try:
    exec(compile(source,configuration['capture_source'],'exec'),globals())
finally:
    if 'research_matmul' in globals():
        Path(configuration['math_output']).write_text(json.dumps({'configuration':configuration,'calls':research_matmul}),encoding='utf-8')
