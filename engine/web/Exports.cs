using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;

namespace ReplaySim.Standalone;

/// The browser entry points. The page supplies the replay and any official map it
/// names, then receives the same JSONL stream the desktop player reads from stdout.
[SupportedOSPlatform("browser")]
internal static partial class WebEngine
{
    private static readonly string Input = Path.Combine(AppContext.BaseDirectory, "replay.rep");
    private static Replay? replay;

    [JSImport("write", "replay-host")]
    private static partial void Write([JSMarshalAs<JSType.MemoryView>] Span<byte> bytes);

    /// Stores a map where the engine looks for bundled maps.
    [JSExport]
    internal static void AddMap(string path, byte[] bytes)
    {
        string target = Path.Combine(AppContext.BaseDirectory, "maps", path);
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        File.WriteAllBytes(target, bytes);
    }

    /// Reads the replay. Returns the path of an official map the page still has to
    /// supply with AddMap before calling Open again, or null when it is ready.
    [JSExport]
    internal static string? Open(byte[] bytes)
    {
        replay = null;
        File.WriteAllBytes(Input, bytes);
        MapSurfaceImage.Unresolved = null;
        try { replay = Replay.Read(Input); }
        catch (FormatException) when (MapSurfaceImage.Unresolved is not null) { return MapSurfaceImage.Unresolved; }
        return null;
    }

    /// Simulates the opened replay, passing the output to the page as it is written.
    [JSExport]
    internal static void Run()
    {
        var opened = replay ?? throw new InvalidOperationException("Open a replay first.");
        replay = null;
        using var output = new HostStream();
        new Simulator(opened).Write(output, Options.Parse([Input, "--render-state"]));
    }

    private sealed class HostStream : Stream
    {
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => WebEngine.Write(buffer.AsSpan(offset, count));
        public override void Write(ReadOnlySpan<byte> buffer) => WebEngine.Write(System.Runtime.InteropServices.MemoryMarshal.CreateSpan(ref System.Runtime.InteropServices.MemoryMarshal.GetReference(buffer), buffer.Length));
    }
}
