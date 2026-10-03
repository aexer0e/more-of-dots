namespace ReplaySim.Standalone;

// MT19937 with Python's integer seeding and rejection sampling. Cosmetic only.
// See THIRD-PARTY-NOTICES for the original MT19937 attribution.
internal sealed class VisualRandom
{
    private readonly uint[] state=new uint[624];
    private int index=624;
    public VisualRandom(uint seed)
    {
        unchecked {
            state[0]=19650218;
            for(uint j=1;j<624;j++)state[j]=1812433253*(state[j-1]^(state[j-1]>>30))+j;
            int i=1;
            for(int k=624;k>0;k--){state[i]=(state[i]^((state[i-1]^(state[i-1]>>30))*1664525))+seed;if(++i>=624){state[0]=state[623];i=1;}}
            for(int k=623;k>0;k--){state[i]=(state[i]^((state[i-1]^(state[i-1]>>30))*1566083941))-(uint)i;if(++i>=624){state[0]=state[623];i=1;}}
            state[0]=0x80000000;
        }
    }
    private uint Next()
    {
        if(index>=624){
            for(int i=0;i<624;i++){uint y=(state[i]&0x80000000)|(state[(i+1)%624]&0x7fffffff);state[i]=state[(i+397)%624]^(y>>1)^((y&1)!=0?0x9908b0dfu:0);}
            index=0;
        }
        uint value=state[index++];value^=value>>11;value^=(value<<7)&0x9d2c5680;value^=(value<<15)&0xefc60000;value^=value>>18;return value;
    }
    public int Vibration(){uint value;do{value=Next()>>30;}while(value>=3);return (int)value-1;}
}
