"""Check reconstructed masked matrix reduction against local NumPy/OpenBLAS."""
import json
import numpy as np

rng=np.random.default_rng(197)
failures=[]
for size in [2,7,15,16,17,19,32,43,52,63,64,100,127,128,251,400,707,708,800]:
    points=rng.uniform(0,1440,(size,2))
    mask=rng.random((size,size))<.12
    expected=mask@points
    actual=np.empty_like(expected)
    for row in range(size):
        values=np.where(mask[row,:,None],points,0)
        if size<16 or 2*size*size>1_000_000:
            result=[0.,0.]
            for value in values:result=[result[i]+float(value[i]) for i in range(2)]
        else:
            lanes=[[0.,0.] for _ in range(8)]
            for index,value in enumerate(values):
                for i in range(2):lanes[index&7][i]+=float(value[i])
            if row<(size&~3):
                result=[((lanes[0][i]+lanes[1][i])+(lanes[2][i]+lanes[3][i]))+((lanes[4][i]+lanes[5][i])+(lanes[6][i]+lanes[7][i])) for i in range(2)]
            else:
                result=[((lanes[0][i]+lanes[4][i])+(lanes[2][i]+lanes[6][i]))+((lanes[1][i]+lanes[5][i])+(lanes[3][i]+lanes[7][i])) for i in range(2)]
        actual[row]=result
    difference=np.argwhere(actual!=expected)
    print(json.dumps({'size':size,'differences':len(difference),'first':difference[0].tolist() if len(difference) else None}))
    if len(difference):failures.append(size)
print(json.dumps({'unresolved_sizes':failures,'numpy':np.__version__}))
