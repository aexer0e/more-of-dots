"""Diagnostic call logging around native methods; never used as parity evidence."""
import json
from pathlib import Path

configuration = json.loads(Path(PARITY_CONFIG).read_text(encoding='utf-8-sig'))
capture_source = Path(configuration['capture_source']).read_text(encoding='utf-8')
instrumentation = '''
    research_calls=[]
    research_methods={}
    research_context=[]
    for research_name,research_object in [('rng',core.psrandom),('economy',core.economy)]:
        research_type=type(research_object)
        research_methods[research_name]={name:list(getattr(fn,'__code__',None).co_varnames)
            for name,fn in vars(research_type).items() if callable(fn) and hasattr(fn,'__code__')}
        for research_method,research_function in list(vars(research_type).items()):
            if not callable(research_function) or not hasattr(research_function,'__code__') or research_method=='__init__':
                continue
            if research_name=='economy' and research_method not in ('update_production','produce_dots'):
                continue
            def make_research_wrapper(label,method,fn,obj):
                def research_wrapper(self,*args,**kwargs):
                    selected=self is obj and config.get('call_start',0)<=core.frame<=config.get('call_end',end)
                    if selected:
                        record={'object':label,'method':method,'frame':int(core.frame),
                            'arguments':plain(args) if method!='produce_dots' else ['native core'],
                            'context':list(research_context),'before':plain(self)}
                        research_calls.append(record)
                    research_context.append(label+'.'+method)
                    try:
                        value=fn(self,*args,**kwargs)
                    finally:
                        research_context.pop()
                    if selected:
                        record['result']=plain(value)
                        record['after']=plain(self)
                    return value
                return research_wrapper
            patch(research_type,research_method,make_research_wrapper(research_name,research_method,research_function,research_object))
    Path(config['calls']).write_text(json.dumps({'methods':research_methods}),encoding='utf-8')
'''
capture_source = capture_source.replace('    initial = state(core)', instrumentation+'\n    initial = state(core)', 1)
try:
    exec(compile(capture_source, configuration['capture_source'], 'exec'), globals())
finally:
    if 'research_calls' in globals():
        experiments=[]
        if 'core' in globals():
            for ratio in [0,0.35,0.5,1]:
                economy=type(core.economy)(core.zyuixz)
                rng=type(core.psrandom)(1)
                steps=[]
                for command in [{'color':0,'rate':1,'ratio':ratio},
                                {'color':0,'rate':0.7,'ratio':ratio},
                                {'color':0,'zone':[0]}]:
                    before=plain(rng)
                    economy.update_production(command,rng,core.cities)
                    steps.append({'command':command,'rng_before':before,'rng_after':plain(rng),'economy':plain(economy)})
                experiments.append({'ratio':ratio,'steps':steps})
        constants={name:plain(getattr(core,name)) for name in ['edge_offsets','precomputed_dot_perimeter_offsets','speed_lookup','damage_lookup','ship_land_damage_by_type','ship_sea_damage_by_type','max_health_by_type','healing_radius'] if hasattr(core,name)} if 'core' in globals() else {}
        Path(configuration['calls']).write_text(json.dumps({'configuration':configuration,'methods':research_methods,'calls':research_calls,'experiments':experiments,'constants':constants}),encoding='utf-8')
