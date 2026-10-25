using System.Runtime.InteropServices;
using System.Runtime.Intrinsics;
using System.Runtime.Intrinsics.Arm;
using System.Runtime.Intrinsics.X86;
using System.Text.Json;
using SkiaSharp;

namespace ReplaySim.Standalone;

// Independent presentation worker drawn with Skia on the CPU, so every platform
// produces the same pixels without a window or GPU. It accepts artwork and
// drawing primitives; no game binary or modules exist here.
internal static class ReferenceRenderer
{
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

    /// An offscreen raster surface that draws render requests and returns top-down RGB24.
    /// The worker and the video converter share it, so both produce identical frames.
    internal sealed class Surface : IDisposable
    {
        // The game's maps are pixel art, so the map is sampled without smoothing.
        private static readonly SKSamplingOptions Sharp=new(SKFilterMode.Nearest,SKMipmapMode.None),Smooth=new(SKFilterMode.Linear,SKMipmapMode.None);
        private readonly Dictionary<string,SKImage> textures=new();
        private readonly Dictionary<string,(string signature,int width,int height)> textCache=new();
        private readonly SKPaint image=new(){IsAntialias=false},fill=new(){IsAntialias=false,Style=SKPaintStyle.Fill};
        private readonly SKPaint stroke=new(){Style=SKPaintStyle.Stroke,StrokeCap=SKStrokeCap.Butt,IsAntialias=true,StrokeJoin=SKStrokeJoin.Miter};
        private readonly SKPathBuilder path=new();
        private SKBitmap bitmap=null!;
        private SKCanvas canvas=null!;
        private byte[] top=Array.Empty<byte>();
        private byte[]? background;
        private string? backgroundKey;
        private int mapVersion;
        public int Width{get;private set;}
        public int Height{get;private set;}

        public Surface(int width,int height)=>Resize(width,height);

        private void Resize(int width,int height)
        {
            canvas?.Dispose();bitmap?.Dispose();
            bitmap=new SKBitmap(new SKImageInfo(width,height,SKColorType.Rgba8888,SKAlphaType.Premul));
            canvas=new SKCanvas(bitmap);
            background=null;
            Width=width;Height=height;
        }

        public void Texture(string name,byte[] encoded)
        {
            if(textures.Remove(name,out var previous))previous.Dispose();
            if(name=="map")mapVersion++;
            textures[name]=SKImage.FromEncodedData(encoded)?.ToRasterImage(true)??throw new InvalidOperationException("Cannot decode artwork");
        }

        /// Returns a buffer that the next call reuses.
        public byte[] Render(JsonElement request)
        {
            int width=request.GetProperty("width").GetInt32(),height=request.GetProperty("height").GetInt32();
            if(width!=Width||height!=Height)Resize(width,height);
            var view=new View(width,height,Vector(request.GetProperty("mapSize")));
            var draws=request.GetProperty("draws");
            int skip=0;
            // Every frame starts with the same scaled map, so it is drawn once and copied after that.
            if(draws.GetArrayLength()>0&&IsBackground(draws[0])){
                string key=$"{width}x{height}:{mapVersion}:{draws[0].GetRawText()}";
                if(background is null||backgroundKey!=key){
                    Begin(view);DrawItem(draws[0],view);canvas.Restore();canvas.Flush();
                    background=bitmap.GetPixelSpan().ToArray();backgroundKey=key;
                } else Marshal.Copy(background,0,bitmap.GetPixels(),background.Length);
                skip=1;
                canvas.ResetMatrix();canvas.Save();canvas.ClipRect(view.Clip);canvas.SetMatrix(view.World);
            } else Begin(view);
            foreach(var draw in draws.EnumerateArray().Skip(skip))DrawItem(draw,view);
            canvas.Restore();canvas.Flush();
            if(top.Length!=width*height*3)top=new byte[width*height*3];
            // The canvas is opaque black underneath, so premultiplied colour is the final colour.
            Rgb(bitmap.GetPixels(),top,width*height);
            return top;
        }

        private void Begin(View view)
        {
            canvas.ResetMatrix();canvas.Clear(SKColors.Black);
            canvas.Save();canvas.ClipRect(view.Clip);canvas.SetMatrix(view.World);
        }

        private static bool IsBackground(JsonElement draw)=>
            draw.GetProperty("type").GetString()=="image"&&draw.GetProperty("name").GetString()=="map"
            &&!(draw.TryGetProperty("alpha",out var alpha)&&alpha.GetDouble()!=1)
            &&!(draw.TryGetProperty("screen",out var screen)&&screen.GetBoolean());

        private readonly struct View
        {
            public readonly int Width,Height,ViewWidth,ViewHeight;
            public readonly double Scale;
            public readonly Vec Map;
            public readonly SKMatrix World;
            public readonly SKRect Clip;
            public View(int width,int height,Vec map)
            {
                Width=width;Height=height;Map=map;
                Scale=Math.Min(width/map.X,height/map.Y);ViewWidth=(int)(map.X*Scale);ViewHeight=(int)(map.Y*Scale);
                // The viewport is centred as OpenGL placed it: offsets round towards the left and bottom.
                int left=(width-ViewWidth)/2,top=height-ViewHeight-(height-ViewHeight)/2;
                World=SKMatrix.CreateScaleTranslation((float)(ViewWidth/map.X),(float)(ViewHeight/map.Y),left,top);
                Clip=SKRect.Create(left,top,ViewWidth,ViewHeight);
            }
        }

        private void DrawItem(JsonElement draw,View view)
        {
            var map=view.Map;int width=view.Width,height=view.Height,vw=view.ViewWidth,vh=view.ViewHeight;double scale=view.Scale;
            string type=draw.GetProperty("type").GetString()!;
            if(type=="image"||type=="text"){
                var pos=Vector(draw.GetProperty("position"));Vec size;
                string name=draw.GetProperty("name").GetString()!;
                if(type=="text"){
                    string signature=draw.GetRawText();
                    if(!textCache.TryGetValue(name,out var cached)||cached.signature!=signature){
                        var color=draw.GetProperty("color").EnumerateArray().Select(x=>x.GetInt32()).ToArray();
                        var raster=ReferenceText.Rasterize(draw.GetProperty("text").GetString()!,color,draw.GetProperty("fontSize").GetInt32(),draw.GetProperty("outline").GetDouble());
                        if(textures.Remove(name,out var previous))previous.Dispose();
                        textures[name]=SKImage.FromPixelCopy(new SKImageInfo(raster.Width,raster.Height,SKColorType.Rgba8888,SKAlphaType.Unpremul),raster.Rgba)!;
                        cached=(signature,raster.Width,raster.Height);textCache[name]=cached;
                    }
                    size=new Vec(cached.width*map.X/1920,cached.height*map.Y/1080);
                    pos=new Vec(pos.X*map.X,(1-pos.Y)*map.Y);
                    string fix=draw.GetProperty("fix").GetString()!;
                    if(fix=="left")pos=new Vec(pos.X+size.X*.5,pos.Y);
                    if(fix=="right")pos=new Vec(pos.X-size.X*.5,pos.Y);
                } else size=Vector(draw.GetProperty("size"));
                bool screen=draw.TryGetProperty("screen",out var s)&&s.GetBoolean();
                if(screen){pos=new((pos.X-(width-vw)/2.0)/scale,(pos.Y-(height-vh)/2.0)/scale);size=size*(1/scale);}
                var direction=draw.TryGetProperty("direction",out var d)?Vector(d):new Vec(1,0);var perp=new Vec(-direction.Y,direction.X);
                double alpha=draw.TryGetProperty("alpha",out var a)?a.GetDouble():1;
                // Flipped images run their rows against the perpendicular, as the player's units do.
                bool flipped=draw.TryGetProperty("flipY",out var flip)&&flip.GetBoolean();
                var texture=textures[name];double sign=flipped?-1:1;
                double ux=direction.X*size.X/texture.Width,uy=direction.Y*size.X/texture.Width;
                double vx=perp.X*sign*size.Y/texture.Height,vy=perp.Y*sign*size.Y/texture.Height;
                var placement=new SKMatrix((float)ux,(float)vx,(float)(pos.X-(direction.X*size.X+perp.X*sign*size.Y)*.5),
                    (float)uy,(float)vy,(float)(pos.Y-(direction.Y*size.X+perp.Y*sign*size.Y)*.5),0,0,1);
                canvas.Save();canvas.Concat(in placement);
                image.Color=SKColors.White.WithAlpha((byte)Math.Clamp(Math.Round(alpha*255),0,255));
                canvas.DrawImage(texture,0,0,name=="map"?Sharp:Smooth,image);
                canvas.Restore();
            } else if(type=="circle") {
                var pos=Vector(draw.GetProperty("position"));double radius=draw.GetProperty("radius").GetDouble();
                fill.Color=Color(draw.GetProperty("color"));path.Reset();
                for(int i=0;i<=32;i++){
                    double angle=i*2*3.1415926/32;
                    var p=new SKPoint((float)(pos.X+radius*Math.Cos(angle)),(float)(pos.Y-radius*Math.Sin(angle)));
                    if(i==0)path.MoveTo(p);else path.LineTo(p);
                }
                path.Close();Draw(fill);
            } else {
                var points=draw.GetProperty("points").EnumerateArray().Select(Vector).ToArray();
                if(points.Length==0)return;
                path.Reset();
                if(type=="polygon"){
                    // Filled shapes in world units, without edge smoothing.
                    fill.Color=Color(draw.GetProperty("color"));
                    path.MoveTo((float)points[0].X,(float)points[0].Y);
                    foreach(var p in points.Skip(1))path.LineTo((float)p.X,(float)p.Y);
                    path.Close();Draw(fill);
                } else {
                    // Line widths are screen pixels whatever the video size, as OpenGL drew them.
                    stroke.Color=Color(draw.GetProperty("color"));
                    stroke.StrokeWidth=draw.TryGetProperty("width",out var lineWidth)?Math.Max(lineWidth.GetSingle(),1):1;
                    path.MoveTo(view.World.MapPoint((float)points[0].X,(float)points[0].Y));
                    foreach(var p in points.Skip(1))path.LineTo(view.World.MapPoint((float)p.X,(float)p.Y));
                    canvas.Save();canvas.ResetMatrix();Draw(stroke);canvas.Restore();
                }
            }
        }

        // RGBA to RGB, four pixels per shuffle, in bands across cores.
        private static unsafe void Rgb(IntPtr rgba,byte[] rgb,int pixels)
        {
            fixed(byte* destination=rgb){
                nint to=(nint)destination,from=rgba;
                int bands=Math.Clamp(Environment.ProcessorCount,1,8);
                Parallel.For(0,bands,band=>{
                    byte* s=(byte*)from,d=(byte*)to;
                    int start=(int)((long)pixels*band/bands),end=(int)((long)pixels*(band+1)/bands),i=start;
                    var mask=Vector128.Create((byte)0,1,2,4,5,6,8,9,10,12,13,14,128,128,128,128);
                    // The last pixels of each band are copied one by one, so a 16-byte store never passes its end.
                    if(Ssse3.IsSupported)for(;i+5<=end;i+=4)Ssse3.Shuffle(Vector128.Load(s+i*4),mask).Store(d+i*3);
                    else if(AdvSimd.Arm64.IsSupported)for(;i+5<=end;i+=4)AdvSimd.Arm64.VectorTableLookup(Vector128.Load(s+i*4),mask).Store(d+i*3);
                    for(;i<end;i++){d[i*3]=s[i*4];d[i*3+1]=s[i*4+1];d[i*3+2]=s[i*4+2];}
                });
            }
        }

        private void Draw(SKPaint paint)
        {
            using var shape=path.Detach();
            canvas.DrawPath(shape,paint);
        }

        private static SKColor Color(JsonElement value)
        {
            var c=value.EnumerateArray().Select(x=>x.GetSingle()).ToArray();
            static byte Channel(float v)=>(byte)Math.Clamp(MathF.Round(v*255),0,255);
            return new SKColor(Channel(c[0]),Channel(c[1]),Channel(c[2]),Channel(c[3]));
        }

        public void Dispose()
        {
            foreach(var texture in textures.Values)texture.Dispose();
            textures.Clear();
            image.Dispose();fill.Dispose();stroke.Dispose();path.Dispose();canvas.Dispose();bitmap.Dispose();
        }
    }

    private static Vec Vector(JsonElement element){var items=element.EnumerateArray().ToArray();return new(items[0].GetDouble(),items[1].GetDouble());}
}
