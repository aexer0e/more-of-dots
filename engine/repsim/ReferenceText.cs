using SkiaSharp;

namespace ReplaySim.Standalone;

// Player names and stats text, rasterized with Skia from the system's Arial Narrow
// (Arial where it is missing), the font the player asks the browser for.
internal static class ReferenceText
{
    private static readonly int[][] Colors = [[0, 0, 255], [255, 0, 0], [156, 0, 187], [255, 140, 57]];
    // macOS lists Arial Narrow as a family of its own; Windows lists it as condensed Arial.
    private static readonly Lazy<SKTypeface> Typeface = new(() =>
    {
        var candidates = new Func<SKTypeface?>[]
        {
            () => Named(SKTypeface.FromFamilyName("Arial Narrow"), "Arial Narrow"),
            () => SKTypeface.FromFamilyName("Arial", SKFontStyleWeight.Normal, SKFontStyleWidth.Condensed, SKFontStyleSlant.Upright) is { } condensed
                && condensed.FamilyName == "Arial" && condensed.FontStyle.Width == (int)SKFontStyleWidth.Condensed ? condensed : null,
            () => Named(SKTypeface.FromFamilyName("Arial"), "Arial"),
        };
        foreach (var candidate in candidates) if (candidate() is { } typeface) return typeface;
        return SKTypeface.Default;
    });

    private static SKTypeface? Named(SKTypeface? typeface, string family)
    {
        if (typeface is not null && typeface.FamilyName.Equals(family, StringComparison.OrdinalIgnoreCase)) return typeface;
        typeface?.Dispose();
        return null;
    }

    private static readonly System.Collections.Concurrent.ConcurrentDictionary<int,SKFont> Fonts=new();

    internal sealed record RenderedText(string text,int[] size,string image);
    /// Straight-alpha RGBA rows, top first.
    internal readonly record struct Raster(byte[] Rgba,int Width,int Height);
    public static RenderedText Render(string text,int side,int size,double outline) => Render(text,side<Colors.Length?Colors[side]:new[]{200,200,200},size,outline);

    public static RenderedText Render(string text,int[] color,int size,double outline)
    {
        var raster=Rasterize(text,color,size,outline);
        return new RenderedText(text,new[]{raster.Width,raster.Height},MapSurfaceImage.EncodePng(raster.Rgba,raster.Width,raster.Height,4));
    }

    public static Raster Rasterize(string text,int[] color,int size,double outline)
    {
        // A coverage mask of the text, as SDL_ttf's blended mode produced it:
        // the advance width by the font's ascent-to-descent height.
        var font=Fonts.GetOrAdd(size,size=>new SKFont(Typeface.Value,size){Edging=SKFontEdging.Antialias,Subpixel=false});
        var metrics=font.Metrics;
        int baseline=(int)Math.Ceiling(-metrics.Ascent);
        int contentWidth=Math.Max(1,(int)Math.Ceiling(font.MeasureText(text))),contentHeight=Math.Max(1,baseline+(int)Math.Ceiling(metrics.Descent));
        using var mask=new SKBitmap(new SKImageInfo(contentWidth,contentHeight,SKColorType.Alpha8,SKAlphaType.Premul));
        using (var canvas=new SKCanvas(mask))
        using (var paint=new SKPaint{IsAntialias=true,Color=SKColors.White})
        {
            canvas.Clear(SKColors.Transparent);
            canvas.DrawText(text,0,baseline,SKTextAlign.Left,font,paint);
        }
        var coverage=mask.GetPixelSpan().ToArray();
        int maskStride=mask.RowBytes;
        int width=contentWidth+(int)(outline*2),height=contentHeight+(int)(outline*2);
        byte[] rgba=new byte[width*height*4];
        void Blit(int r,int g,int b,int dx,int dy)
        {
            // pygame's SDL1-compatible straight-alpha blend.
            for(int y=0;y<contentHeight;y++)for(int x=0;x<contentWidth;x++)
            {
                int sa=coverage[y*maskStride+x];if(sa==0)continue;
                int d=((y+dy)*width+x+dx)*4,da=rgba[d+3];
                Span<int> source=[r,g,b];
                if(sa==255||da==0){for(int channel=0;channel<3;channel++)rgba[d+channel]=(byte)source[channel];rgba[d+3]=(byte)sa;}
                else {
                    for(int channel=0;channel<3;channel++)rgba[d+channel]=(byte)(((rgba[d+channel]<<8)+(source[channel]-rgba[d+channel])*sa+source[channel])>>8);
                    rgba[d+3]=(byte)(sa+da-sa*da/255);
                }
            }
        }
        foreach(var (dx,dy) in new[]{(-1,0),(1,0),(0,-1),(0,1),(-1,-1),(-1,1),(1,-1),(1,1)})
        {
            Blit(0,0,0,(int)(outline+dx*outline),(int)(outline+dy*outline));
        }
        Blit(color[0],color[1],color[2],(int)outline,(int)outline);
        return new Raster(rgba,width,height);
    }
}
