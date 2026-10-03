using System.Runtime.InteropServices;

namespace ReplaySim.Standalone;

// SDL_ttf is a general font rasterizer. This code never imports game modules.
internal static class ReferenceText
{
    [StructLayout(LayoutKind.Sequential)] private struct Color { public byte R,G,B,A; }
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int X,Y,W,H; }
    [StructLayout(LayoutKind.Sequential)] private struct Surface
    {
        public uint Flags; public IntPtr Format; public int W,H,Pitch; public IntPtr Pixels,UserData;
        public int Locked; public IntPtr List; public Rect Clip; public IntPtr Map; public int RefCount;
    }
    [DllImport("sdl2_ttf.dll",CallingConvention=CallingConvention.Cdecl)] private static extern int TTF_Init();
    [DllImport("sdl2_ttf.dll",CallingConvention=CallingConvention.Cdecl)] private static extern IntPtr TTF_OpenFont([MarshalAs(UnmanagedType.LPUTF8Str)] string path,int size);
    [DllImport("sdl2_ttf.dll",CallingConvention=CallingConvention.Cdecl)] private static extern IntPtr TTF_RenderUTF8_Blended(IntPtr font,[MarshalAs(UnmanagedType.LPUTF8Str)] string text,Color color);
    [DllImport("sdl2_ttf.dll",CallingConvention=CallingConvention.Cdecl)] private static extern void TTF_CloseFont(IntPtr font);
    [DllImport("sdl2.dll",CallingConvention=CallingConvention.Cdecl)] private static extern IntPtr SDL_CreateRGBSurfaceWithFormat(uint flags,int width,int height,int depth,uint format);
    [DllImport("sdl2.dll",CallingConvention=CallingConvention.Cdecl)] private static extern int SDL_UpperBlit(IntPtr src,IntPtr srcRect,IntPtr destination,ref Rect destinationRect);
    [DllImport("sdl2.dll",CallingConvention=CallingConvention.Cdecl)] private static extern int SDL_FillRect(IntPtr dst,IntPtr rect,uint color);
    [DllImport("sdl2.dll",CallingConvention=CallingConvention.Cdecl)] private static extern void SDL_FreeSurface(IntPtr surface);
    [DllImport("sdl2.dll",CallingConvention=CallingConvention.Cdecl)] private static extern IntPtr SDL_ConvertSurfaceFormat(IntPtr surface,uint format,uint flags);
    private static readonly Color[] Colors = [new(){B=255,A=255},new(){R=255,A=255},new(){R=156,B=187,A=255},new(){R=255,G=140,B=57,A=255}];

    internal sealed record RenderedText(string text,int[] size,string image);
    public static RenderedText Render(string text,int side,int size,double outline) => Render(text,side<Colors.Length?new[]{(int)Colors[side].R,Colors[side].G,Colors[side].B}:new[]{200,200,200},size,outline);

    public static RenderedText Render(string text,int[] color,int size,double outline)
    {
        TTF_Init();
        string fonts=Environment.GetFolderPath(Environment.SpecialFolder.Fonts);
        string path=Path.Combine(fonts,"ARIALN.TTF");
        if (!File.Exists(path)) path=Path.Combine(fonts,"arial.ttf");
        IntPtr font=TTF_OpenFont(path,size);
        if(font==IntPtr.Zero)throw new InvalidOperationException("Cannot load the replay font.");
        IntPtr foreground=IntPtr.Zero,shadow=IntPtr.Zero,destination=IntPtr.Zero;
        try
        {
            foreground=TTF_RenderUTF8_Blended(font,text,new(){R=(byte)color[0],G=(byte)color[1],B=(byte)color[2],A=255});
            shadow=TTF_RenderUTF8_Blended(font,text,new(){A=255});
            if(foreground==IntPtr.Zero||shadow==IntPtr.Zero)throw new InvalidOperationException("Cannot render player name.");
            var content=Marshal.PtrToStructure<Surface>(foreground);
            int width=content.W+(int)(outline*2),height=content.H+(int)(outline*2);
            byte[] rgba=new byte[width*height*4];
            byte[] Read(IntPtr pointer)
            {
                IntPtr converted=SDL_ConvertSurfaceFormat(pointer,376840196,0);
                if(converted==IntPtr.Zero)throw new InvalidOperationException("Cannot convert text surface.");
                try {
                    var surface=Marshal.PtrToStructure<Surface>(converted);
                    byte[] result=new byte[surface.W*surface.H*4];
                    for(int y=0;y<surface.H;y++)Marshal.Copy(surface.Pixels+y*surface.Pitch,result,y*surface.W*4,surface.W*4);
                    return result;
                } finally {SDL_FreeSurface(converted);}
            }
            void Blit(byte[] source,int dx,int dy)
            {
                // pygame's SDL1-compatible straight-alpha blend.
                for(int y=0;y<content.H;y++)for(int x=0;x<content.W;x++)
                {
                    int s=(y*content.W+x)*4,d=((y+dy)*width+x+dx)*4;
                    int sa=source[s+3],da=rgba[d+3];
                    if(sa==255||da==0)Array.Copy(source,s,rgba,d,4);
                    else {
                        for(int channel=0;channel<3;channel++)rgba[d+channel]=(byte)(((rgba[d+channel]<<8)+(source[s+channel]-rgba[d+channel])*sa+source[s+channel])>>8);
                        rgba[d+3]=(byte)(sa+da-sa*da/255);
                    }
                }
            }
            var black=Read(shadow);var colored=Read(foreground);
            foreach(var (dx,dy) in new[]{(-1,0),(1,0),(0,-1),(0,1),(-1,-1),(-1,1),(1,-1),(1,1)})
            {
                Blit(black,(int)(outline+dx*outline),(int)(outline+dy*outline));
            }
            Blit(colored,(int)outline,(int)outline);
            return new RenderedText(text,new[]{width,height},MapSurfaceImage.EncodePng(rgba,width,height,4));
        }
        finally { if(destination!=IntPtr.Zero)SDL_FreeSurface(destination);if(shadow!=IntPtr.Zero)SDL_FreeSurface(shadow);if(foreground!=IntPtr.Zero)SDL_FreeSurface(foreground);TTF_CloseFont(font); }
    }
}
