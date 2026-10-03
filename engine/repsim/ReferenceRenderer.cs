using System.Runtime.InteropServices;
using System.Text.Json;

namespace ReplaySim.Standalone;

// Independent presentation worker using public SDL and system OpenGL APIs.
// It accepts artwork and drawing primitives; no game binary or modules exist here.
internal static class ReferenceRenderer
{
    [StructLayout(LayoutKind.Sequential)] private struct SdlSurface { public uint Flags;public IntPtr Format;public int W,H,Pitch;public IntPtr Pixels; }
    [DllImport("sdl2.dll",CallingConvention=CallingConvention.Cdecl)] static extern int SDL_Init(uint flags);
    [DllImport("sdl2.dll",CallingConvention=CallingConvention.Cdecl)] static extern IntPtr SDL_CreateWindow(string title,int x,int y,int w,int h,uint flags);
    [DllImport("sdl2.dll",CallingConvention=CallingConvention.Cdecl)] static extern IntPtr SDL_GL_CreateContext(IntPtr window);
    [DllImport("sdl2.dll",CallingConvention=CallingConvention.Cdecl)] static extern void SDL_SetWindowSize(IntPtr window,int w,int h);
    [DllImport("sdl2.dll",CallingConvention=CallingConvention.Cdecl)] static extern IntPtr SDL_RWFromConstMem(IntPtr memory,int size);
    [DllImport("sdl2_image.dll",CallingConvention=CallingConvention.Cdecl)] static extern IntPtr IMG_Load_RW(IntPtr rw,int free);
    [DllImport("sdl2.dll",CallingConvention=CallingConvention.Cdecl)] static extern IntPtr SDL_ConvertSurfaceFormat(IntPtr surface,uint format,uint flags);
    [DllImport("sdl2.dll",CallingConvention=CallingConvention.Cdecl)] static extern void SDL_FreeSurface(IntPtr surface);
    [DllImport("sdl2.dll",CallingConvention=CallingConvention.Cdecl)] static extern void SDL_DestroyWindow(IntPtr window);
    [DllImport("sdl2.dll",CallingConvention=CallingConvention.Cdecl)] static extern void SDL_GL_DeleteContext(IntPtr context);
    [DllImport("sdl2.dll",CallingConvention=CallingConvention.Cdecl)] static extern void SDL_Quit();
    [DllImport("opengl32.dll")] static extern void glViewport(int x,int y,int w,int h);
    [DllImport("opengl32.dll")] static extern void glMatrixMode(uint mode);
    [DllImport("opengl32.dll")] static extern void glLoadIdentity();
    [DllImport("opengl32.dll")] static extern void glOrtho(double l,double r,double b,double t,double near,double far);
    [DllImport("opengl32.dll")] static extern void glClearColor(float r,float g,float b,float a);
    [DllImport("opengl32.dll")] static extern void glClear(uint mask);
    [DllImport("opengl32.dll")] static extern void glEnable(uint cap);
    [DllImport("opengl32.dll")] static extern void glDisable(uint cap);
    [DllImport("opengl32.dll")] static extern void glBlendFunc(uint source,uint destination);
    [DllImport("opengl32.dll")] static extern void glGenTextures(int count,out uint texture);
    [DllImport("opengl32.dll")] static extern void glDeleteTextures(int count,ref uint texture);
    [DllImport("opengl32.dll")] static extern void glBindTexture(uint target,uint texture);
    [DllImport("opengl32.dll")] static extern void glTexParameteri(uint target,uint name,int value);
    [DllImport("opengl32.dll")] static extern void glPixelStorei(uint name,int value);
    [DllImport("opengl32.dll")] static extern void glTexImage2D(uint target,int level,int format,int w,int h,int border,uint sourceFormat,uint sourceType,byte[] data);
    [DllImport("opengl32.dll")] static extern void glBegin(uint mode);
    [DllImport("opengl32.dll")] static extern void glEnd();
    [DllImport("opengl32.dll")] static extern void glTexCoord2f(float x,float y);
    [DllImport("opengl32.dll")] static extern void glVertex2f(float x,float y);
    [DllImport("opengl32.dll")] static extern void glColor4f(float r,float g,float b,float a);
    [DllImport("opengl32.dll")] static extern void glLineWidth(float width);
    [DllImport("opengl32.dll")] static extern void glHint(uint target,uint mode);
    [DllImport("opengl32.dll")] static extern void glFinish();
    [DllImport("opengl32.dll")] static extern void glReadPixels(int x,int y,int w,int h,uint format,uint type,byte[] pixels);

    public static int Run()
    {
        Console.InputEncoding=System.Text.Encoding.UTF8;Console.OutputEncoding=new System.Text.UTF8Encoding(false);
        using var output=Console.OpenStandardOutput();
        try {
            using var surface=new Surface(1920,1200);
            while(Console.ReadLine() is string command){
                try {
                    using var document=JsonDocument.Parse(command);var request=document.RootElement;
                    string kind=request.GetProperty("kind").GetString()!;
                    if(kind=="texture"){
                        string name=request.GetProperty("name").GetString()!;
                        byte[] encoded=request.TryGetProperty("path",out var path)?File.ReadAllBytes(path.GetString()!):Convert.FromBase64String(request.GetProperty("png").GetString()!);
                        surface.Texture(name,encoded);
                        Console.WriteLine("{\"ok\":true}");continue;
                    }
                    if(kind!="render")throw new InvalidOperationException("Unknown render request");
                    var top=surface.Render(request);
                    if(request.TryGetProperty("transport",out var transport)&&transport.GetString()=="rgb"){
                        Console.WriteLine(JsonSerializer.Serialize(new {ok=true,bytes=top.Length}));
                        Console.Out.Flush();output.Write(top);output.Flush();
                    } else Console.WriteLine(JsonSerializer.Serialize(new {ok=true,png=MapSurfaceImage.EncodePng(top,surface.Width,surface.Height,3)}));
                } catch(Exception error){Console.WriteLine(JsonSerializer.Serialize(new{ok=false,error=error.Message}));}
            }
            return 0;
        } catch(Exception error){Console.Error.WriteLine(error);return 2;}
    }

    /// A hidden OpenGL surface that draws render requests and reads back top-down RGB24.
    /// The worker and the video converter share it, so both produce identical frames.
    internal sealed class Surface : IDisposable
    {
        private readonly IntPtr window,context;
        private readonly Dictionary<string,uint> textures=new();
        private readonly Dictionary<string,(string signature,ReferenceText.RenderedText rendered)> textCache=new();
        private byte[] raw=Array.Empty<byte>(),top=Array.Empty<byte>();
        public int Width{get;private set;}
        public int Height{get;private set;}

        public Surface(int width,int height)
        {
            if(SDL_Init(32)!=0)throw new InvalidOperationException("Cannot initialize SDL video");
            window=SDL_CreateWindow("Replay renderer",0,0,width,height,10);
            if(window==IntPtr.Zero)throw new InvalidOperationException("Cannot create the render surface");
            context=SDL_GL_CreateContext(window);
            if(context==IntPtr.Zero)throw new InvalidOperationException("Cannot create an OpenGL context");
            Width=width;Height=height;
            glEnable(3042);glBlendFunc(770,771);glClearColor(0,0,0,1);glPixelStorei(3333,1);
            glEnable(2848);glHint(3154,4353);
        }

        public void Texture(string name,byte[] encoded)
        {
            if(textures.TryGetValue(name,out uint previous))glDeleteTextures(1,ref previous);
            textures[name]=LoadTexture(encoded);
        }

        /// Returns a buffer that the next call reuses.
        public byte[] Render(JsonElement request)
        {
            int width=request.GetProperty("width").GetInt32(),height=request.GetProperty("height").GetInt32();
            if(width!=Width||height!=Height){
                SDL_SetWindowSize(window,width,height);Width=width;Height=height;
            }
            glClear(16384);var map=Vector(request.GetProperty("mapSize"));
            double scale=Math.Min(width/map.X,height/map.Y);int vw=(int)(map.X*scale),vh=(int)(map.Y*scale);
            glViewport((width-vw)/2,(height-vh)/2,vw,vh);glMatrixMode(5889);glLoadIdentity();glOrtho(0,1,0,1,-1,1);glMatrixMode(5888);glLoadIdentity();
            foreach(var draw in request.GetProperty("draws").EnumerateArray()){
                string type=draw.GetProperty("type").GetString()!;
                if(type=="image"||type=="text"){
                    var pos=Vector(draw.GetProperty("position"));Vec size;
                    string name=draw.GetProperty("name").GetString()!;
                    if(type=="text"){
                        string signature=draw.GetRawText();
                        if(!textCache.TryGetValue(name,out var cached)||cached.signature!=signature){
                            var color=draw.GetProperty("color").EnumerateArray().Select(x=>x.GetInt32()).ToArray();
                            var rendered=ReferenceText.Render(draw.GetProperty("text").GetString()!,color,draw.GetProperty("fontSize").GetInt32(),draw.GetProperty("outline").GetDouble());
                            if(textures.TryGetValue(name,out uint previous))glDeleteTextures(1,ref previous);
                            textures[name]=LoadTexture(Convert.FromBase64String(rendered.image));cached=(signature,rendered);textCache[name]=cached;
                        }
                        size=new Vec(cached.rendered.size[0]*map.X/1920,cached.rendered.size[1]*map.Y/1080);
                        pos=new Vec(pos.X*map.X,(1-pos.Y)*map.Y);
                        string fix=draw.GetProperty("fix").GetString()!;
                        if(fix=="left")pos=new Vec(pos.X+size.X*.5,pos.Y);
                        if(fix=="right")pos=new Vec(pos.X-size.X*.5,pos.Y);
                    } else size=Vector(draw.GetProperty("size"));
                    bool screen=draw.TryGetProperty("screen",out var s)&&s.GetBoolean();
                    if(screen){pos=new((pos.X-(width-vw)/2.0)/scale,(pos.Y-(height-vh)/2.0)/scale);size=size*(1/scale);}
                    var direction=draw.TryGetProperty("direction",out var d)?Vector(d):new Vec(1,0);var perp=new Vec(-direction.Y,direction.X);
                    double alpha=draw.TryGetProperty("alpha",out var a)?a.GetDouble():1;
                    bool flipped=draw.TryGetProperty("flipY",out var flip)&&flip.GetBoolean();
                    glEnable(3553);glBindTexture(3553,textures[name]);glColor4f(1,1,1,(float)alpha);glBegin(7);
                    var corners=flipped?new[]{(-1,-1,0,1),(1,-1,1,1),(1,1,1,0),(-1,1,0,0)}:new[]{(-1,1,0,0),(1,1,1,0),(1,-1,1,1),(-1,-1,0,1)};
                    foreach(var (x,y,u,v) in corners){
                        var p=pos+direction*(size.X*x*.5)+perp*(size.Y*y*.5);
                        glTexCoord2f(u,flipped?1-v:v);glVertex2f((float)(p.X/map.X),(float)(1-p.Y/map.Y));
                    }
                    glEnd();glDisable(3553);glColor4f(1,1,1,1);
                } else if(type=="circle") {
                    var pos=Vector(draw.GetProperty("position"));double radius=draw.GetProperty("radius").GetDouble();
                    var color=draw.GetProperty("color").EnumerateArray().Select(x=>x.GetSingle()).ToArray();
                    glColor4f(color[0],color[1],color[2],color[3]);glBegin(6);
                    glVertex2f((float)(pos.X/map.X),(float)(1-pos.Y/map.Y));
                    for(int i=0;i<=32;i++){
                        double angle=i*2*3.1415926/32;
                        glVertex2f((float)((pos.X+radius*Math.Cos(angle))/map.X),(float)(1-(pos.Y-radius*Math.Sin(angle))/map.Y));
                    }
                    glEnd();glColor4f(1,1,1,1);
                } else {
                    var color=draw.GetProperty("color").EnumerateArray().Select(x=>x.GetSingle()).ToArray();glColor4f(color[0],color[1],color[2],color[3]);glLineWidth(draw.TryGetProperty("width",out var lineWidth)?Math.Max(lineWidth.GetSingle(),1):1);glBegin(type=="polygon"?9u:3u);
                    foreach(var point in draw.GetProperty("points").EnumerateArray()){var p=Vector(point);glVertex2f((float)(p.X/map.X),(float)(1-p.Y/map.Y));}
                    glEnd();glColor4f(1,1,1,1);
                }
            }
            glFinish();
            if(raw.Length!=width*height*3){raw=new byte[width*height*3];top=new byte[raw.Length];}
            glReadPixels(0,0,width,height,6407,5121,raw);
            for(int y=0;y<height;y++)Array.Copy(raw,y*width*3,top,(height-1-y)*width*3,width*3);
            return top;
        }

        public void Dispose()
        {
            if(context!=IntPtr.Zero)SDL_GL_DeleteContext(context);
            if(window!=IntPtr.Zero)SDL_DestroyWindow(window);
            SDL_Quit();
        }
    }

    private static Vec Vector(JsonElement element){var items=element.EnumerateArray().ToArray();return new(items[0].GetDouble(),items[1].GetDouble());}
    private static uint LoadTexture(byte[] encoded)
    {
        var handle=GCHandle.Alloc(encoded,GCHandleType.Pinned);IntPtr source=IntPtr.Zero,converted=IntPtr.Zero;
        try {
            source=IMG_Load_RW(SDL_RWFromConstMem(handle.AddrOfPinnedObject(),encoded.Length),1);
            if(source==IntPtr.Zero)throw new InvalidOperationException("Cannot decode artwork");
            converted=SDL_ConvertSurfaceFormat(source,376840196,0);
            if(converted==IntPtr.Zero)throw new InvalidOperationException("Cannot convert artwork");
            var surface=Marshal.PtrToStructure<SdlSurface>(converted);var pixels=new byte[surface.W*surface.H*4];
            for(int y=0;y<surface.H;y++)Marshal.Copy(surface.Pixels+y*surface.Pitch,pixels,(surface.H-1-y)*surface.W*4,surface.W*4);
            glGenTextures(1,out uint texture);glBindTexture(3553,texture);glTexParameteri(3553,10241,9729);glTexParameteri(3553,10240,9729);glTexParameteri(3553,10242,33071);glTexParameteri(3553,10243,33071);
            glTexImage2D(3553,0,6408,surface.W,surface.H,0,6408,5121,pixels);return texture;
        } finally {if(converted!=IntPtr.Zero)SDL_FreeSurface(converted);if(source!=IntPtr.Zero)SDL_FreeSurface(source);handle.Free();}
    }
}
