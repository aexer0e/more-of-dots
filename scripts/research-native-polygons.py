"""Log actual native polygon arguments while retaining the original draw calls."""
import json
from pathlib import Path

configuration=json.loads(Path(PARITY_CONFIG).read_text(encoding='utf-8-sig'))
capture_source=Path(configuration['capture_source']).read_text(encoding='utf-8')
instrumentation='''
    research_polygons=[]
    for draw_name,draw_module,method in [('pygame.draw',main.pygame.draw,'polygon'),
            ('pygame.gfxdraw',getattr(main.pygame,'gfxdraw',None),'filled_polygon')]:
        if draw_module is None or not hasattr(draw_module,method):continue
        def make_polygon_logger(label,fn):
            def polygon_logger(surface,*args,**kwargs):
                research_polygons.append({'function':label,'surface_size':plain(surface.get_size()),
                    'arguments':plain(args),'keywords':plain(kwargs)})
                return fn(surface,*args,**kwargs)
            return polygon_logger
        patch(draw_module,method,make_polygon_logger(draw_name+'.'+method,getattr(draw_module,method)))
'''
capture_source=capture_source.replace('    scene = main.aaadaa(setup)',instrumentation+'\n    scene = main.aaadaa(setup)',1)
try:
    exec(compile(capture_source,configuration['capture_source'],'exec'),globals())
finally:
    if 'research_polygons' in globals():
        bridge=type(core.bridges[0]) if 'core' in globals() and len(core.bridges) else None
        methods={name:list(fn.__code__.co_varnames) for name,fn in vars(bridge).items()
                 if callable(fn) and hasattr(fn,'__code__')} if bridge else {}
        polygons=[r for r in research_polygons if r['surface_size']==[1600,900] and r['function']=='pygame.draw.polygon']
        for label in ['float','int']:
            surface=main.pygame.Surface((1600,900));surface.fill((0,0,0))
            for polygon in polygons:
                color,points=polygon['arguments'][:2]
                if label=='int':points=[[int(v) for v in point] for point in points]
                main.pygame.draw.polygon(surface,color,points)
            mask=(main.pygame.surfarray.array3d(surface)[:,:,0]!=0).astype('uint8')
            Path(configuration['polygons']).with_name('polygon-'+label+'.bin').write_bytes(mask.tobytes())
        Path(configuration['polygons']).write_text(json.dumps({'configuration':configuration,
            'pygame_version':main.pygame.version.ver,'polygons':research_polygons,'bridge_methods':methods}),encoding='utf-8')
