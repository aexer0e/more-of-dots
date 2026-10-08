using System.Globalization;
using System.IO.Compression;
using System.Text.Json;

namespace ReplaySim.Standalone;

internal static class Program
{
    private static int Main(string[] args)
    {
#if !BROWSER
        if(args.Length>0 && args[0]=="--render-worker")return ReferenceRenderer.Run();
#endif
        try
        {
            var options = Options.Parse(args);
            if (options.Help)
            {
                Options.PrintHelp();
                return 0;
            }

            if (string.IsNullOrWhiteSpace(options.Input))
                throw new ArgumentException("An input .rep file is required.");

            MapSurfaceImage.GameDirectories = options.GameDirectories;
#if !BROWSER
            if (options.ExportVideo) return VideoExport.Run(options);
#endif
            var replay = Replay.Read(options.Input);
            if (options.ExportTerrain is not null) replay.Map.Surface!.Export(options.ExportTerrain);
            var output = options.Output ?? Path.ChangeExtension(options.Input, ".repsim");
            if (output == "-")
            {
                // Streaming lets a viewer start on the first frames while later ones are simulated.
                using var stdout = Console.OpenStandardOutput();
                new Simulator(replay).Write(stdout, options);
                return 0;
            }
            if (Path.GetFullPath(output).Equals(Path.GetFullPath(options.Input), StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("The output must be a different file from the input replay.");
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(output))!);
            var simulator = new Simulator(replay);
            string temporary = Path.GetFullPath(output) + "." + Guid.NewGuid().ToString("N") + ".tmp";
            Simulator.Result result;
            try
            {
                result = simulator.Write(temporary, options);
                File.Move(temporary, output, overwrite: true);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
            if (options.ExportContours is not null) simulator.ExportContours(options.ExportContours);
            if (options.ExportRegions is not null) simulator.ExportRegions(options.ExportRegions);
            Console.WriteLine($"Generated {Path.GetFullPath(output)}");
            Console.WriteLine($"Replay: mode={replay.Mode} end={replay.EndTick} units={replay.Units.Count} orders={replay.OrderCount} production={replay.ProductionCount}");
            Console.WriteLine($"Output: frames={result.Frames} bytes={result.Bytes:N0} elapsed={result.Elapsed.TotalMilliseconds:F0} ms rate={result.Frames / Math.Max(result.Elapsed.TotalSeconds, 0.001):F0} frames/s");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"replay-sim: {ex.Message}");
            return 2;
        }
    }
}

internal sealed class Options
{
    public string? Input { get; private set; }
    public string? Output { get; private set; }
    public int? MaxFrame { get; private set; }
    public int SampleEvery { get; private set; } = 1;
    public bool NoCombat { get; private set; }
    public bool Help { get; private set; }
    public string? ExportTerrain { get; private set; }
    public string? ExportContours { get; private set; }
    public string? ExportRegions { get; private set; }
    public bool RenderState { get; private set; }
    public List<string> GameDirectories { get; } = [];
    public bool ExportVideo { get; private set; }
    public int Width { get; private set; } = 1920;
    public int Height { get; private set; } = 1080;
    public int Step { get; private set; } = 1;
    public HashSet<string> Layers { get; private set; } = ["orders", "health", "morale", "flags", "icons", "stats", "players"];
    public string? AssetsDirectory { get; private set; }
    public string? DumpDraws { get; private set; }

    public static Options Parse(string[] args)
    {
        var o = new Options();
        for (int i = 0; i < args.Length; i++)
        {
            string arg = args[i];
            switch (arg)
            {
                case "-h":
                case "--help": o.Help = true; break;
                case "-o":
                case "--output": o.Output = Next(args, ref i, arg); break;
                case "--max-frame": o.MaxFrame = int.Parse(Next(args, ref i, arg), CultureInfo.InvariantCulture); break;
                case "--sample-every": o.SampleEvery = int.Parse(Next(args, ref i, arg), CultureInfo.InvariantCulture); break;
                case "--no-combat": o.NoCombat = true; break;
                case "--recovered-movement": break;
                case "--export-terrain": o.ExportTerrain = Next(args, ref i, arg); break;
                case "--export-contours": o.ExportContours = Next(args, ref i, arg); break;
                case "--export-regions": o.ExportRegions = Next(args, ref i, arg); break;
                case "--render-state": o.RenderState = true; break;
                case "--game-dir": o.GameDirectories.Add(Next(args, ref i, arg)); break;
                case "--export-video": o.ExportVideo = true; o.RenderState = true; break;
                case "--width": o.Width = int.Parse(Next(args, ref i, arg), CultureInfo.InvariantCulture); break;
                case "--height": o.Height = int.Parse(Next(args, ref i, arg), CultureInfo.InvariantCulture); break;
                case "--step": o.Step = int.Parse(Next(args, ref i, arg), CultureInfo.InvariantCulture); break;
                case "--layers": o.Layers = Next(args, ref i, arg).Split(',', StringSplitOptions.RemoveEmptyEntries).ToHashSet(); break;
                case "--assets": o.AssetsDirectory = Next(args, ref i, arg); break;
                case "--dump-draws": o.DumpDraws = Next(args, ref i, arg); break;
                default:
                    if (arg.StartsWith('-')) throw new ArgumentException($"Unknown option: {arg}");
                    if (o.Input != null) throw new ArgumentException("Only one input replay may be supplied.");
                    o.Input = arg;
                    break;
            }
        }
        if (o.MaxFrame is < 0) throw new ArgumentException("--max-frame must be non-negative.");
        if (o.SampleEvery < 1) throw new ArgumentException("--sample-every must be positive.");
        if (o.Step < 1) throw new ArgumentException("--step must be positive.");
        if (o.Width is < 2 or > 3840 || o.Height is < 2 or > 2160 || o.Width % 2 != 0 || o.Height % 2 != 0)
            throw new ArgumentException("Video size must be even and at most 3840x2160.");
        return o;
    }

    private static string Next(string[] args, ref int index, string option)
        => ++index < args.Length ? args[index] : throw new ArgumentException($"Missing value for {option}.");

    public static void PrintHelp() => Console.WriteLine("""
        ReplaySim Standalone - offline War of Dots replay simulator

        Usage:
          ReplaySim.Standalone.exe input.rep [-o output.repsim]
          ReplaySim.Standalone.exe input.rep --render-state -o -   (stream to stdout)

        Options:
          --max-frame N       stop after frame N (development/parity probes)
          --sample-every N    write every Nth state frame (default: 1)
          --no-combat         disable combat while debugging movement
          --game-dir DIR      installed game folder for official maps (repeatable)
          --export-video      write raw RGB24 video frames to stdout, progress to stderr
            --width W --height H   frame size (default 1920x1080)
            --step N               draw every Nth simulated frame (playback speed)
            --layers a,b,...       orders,health,morale,flags,stats,icons,produce,players
            --assets DIR           unit artwork folder (default: player-assets)
          -h, --help          show this help

        The tool reads gzip or plain JSON .rep files and does not launch or require
        the game. Full output is viewer-compatible JSONL (.repsim).
        """);
}

internal sealed class Replay
{
    public required string Mode { get; init; }
    public required string Version { get; init; }
    public string SourceMode { get; init; } = "classic";
    public bool LegacyProduction { get; init; }
    public bool ConditionalRetreatRolls => System.Version.TryParse(Version, out var version)
        && version < new System.Version(1, 3);
    public bool RoundedRetreatComparison => !System.Version.TryParse(Version, out var version)
        || version >= new System.Version(1, 3);
    public bool FullPrecisionPositions => System.Version.TryParse(Version, out var version)
        && version < new System.Version(1, 2, 23);
    public bool RollProductionBeforeBlock => LegacyProduction && System.Version.TryParse(Version, out var version)
        && version >= new System.Version(1, 3);
    public bool ApproximateRules => Version != "1.4.1" || LegacyProduction
        || SourceMode is not ("classic" or "experiment" or "avalanche" or "1v1" or "2v2" or "v3" or "v4" or "ffa");
    public string SimulationProfile => LegacyProduction ? "wod-legacy-mixed-v1" : "wod-1.4.1-ea9225cf";
    public bool Experimental => Mode == "experiment";
    // Avalanche plays by the classic rules; the game only changes its starting funds.
    public bool Avalanche => Mode == "avalanche";
    public int SideCount => Map.Infantry.Length;
    public string[] Colors => new[] { "blue", "red", "purple", "orange" }[..SideCount];
    public required int EndTick { get; init; }
    // The recording player's result (1 win, 0 loss, 0.5 peace, -1 ...); it picks the end sound.
    public double? Result { get; init; }
    public required ReplayMap Map { get; init; }
    public required string[] PlayerNames { get; init; }
    public string[][] PlayerLabels { get; init; } = [];
    public required List<Unit> Units { get; init; }
    public required Dictionary<int, List<Order>> Orders { get; init; }
    public required Dictionary<int, List<Production>> Productions { get; init; }
    public int OrderCount => Orders.Values.Sum(x => x.Count);
    public int ProductionCount => Productions.Values.Sum(x => x.Count);

    public static Replay Read(string path)
    {
        using var stream = OpenDecoded(path);
        using var document = JsonDocument.Parse(stream);
        var root = document.RootElement;
        // Saved replays also use mode for the match format. 2v2 (two players per
        // color) and free-for-all use the classic rules.
        root.TryGetProperty("map", out var mapValue);
        if (mapValue.ValueKind != JsonValueKind.Object && root.TryGetProperty("custom_map", out var customMap)
            && customMap.ValueKind == JsonValueKind.Object) mapValue = customMap;
        if (mapValue.ValueKind != JsonValueKind.Object
            && BuiltInDeployments.TryResolve(mapValue, Text(root, "mode"), out var builtInMap)) mapValue = builtInMap;
        if (mapValue.ValueKind != JsonValueKind.Object)
        {
            // A PNG can exist even when its mode-specific deployment is unknown.
            string id = mapValue.ValueKind switch
            {
                JsonValueKind.String => mapValue.GetString() ?? "",
                JsonValueKind.Number => mapValue.GetRawText(),
                _ => "",
            };
            throw new FormatException(id.Length > 0
                ? $"This replay records map number ({id}), but the player has no layout of starting units and cities for this map and mode yet. A matching replay with a full map can provide that layout."
                : "This replay does not record its map, so it cannot be played back.");
        }
        string versionName = Text(root, "version") ?? "unknown";
        bool pygameCeRaster = !System.Version.TryParse(versionName, out var mapVersion)
            || mapVersion >= new System.Version(1, 3, 7);
        var map = ReplayMap.Read(mapValue, Path.GetDirectoryName(Path.GetFullPath(path)) ?? AppContext.BaseDirectory, pygameCeRaster);
        string matchMode = Text(root, "mode") ?? Text(mapValue, "mode") ?? "classic";
        string modeName = BuiltInDeployments.RulesMode(matchMode);
        // Files with new/unknown version strings still get a playback attempt. The
        // command schema determines production behavior, not an allowlist of versions.
        bool legacyProduction = false, modernProduction = false;
        foreach (var frame in root.EnumerateObject().Where(p => int.TryParse(p.Name, out _) && p.Value.ValueKind == JsonValueKind.Object))
        foreach (var entry in frame.Value.EnumerateObject().Where(p => p.Name.StartsWith("production", StringComparison.Ordinal) && p.Value.ValueKind == JsonValueKind.Object))
        {
            legacyProduction |= entry.Value.TryGetProperty("ratio", out _) || entry.Value.TryGetProperty("rate", out _);
            modernProduction |= entry.Value.TryGetProperty("production_type", out _);
            if (Text(entry.Value, "production_type") == "motorised") modeName = "experiment";
        }
        if (map.Motorised.Any(side => side.Count > 0)) modeName = "experiment";
        if (!legacyProduction && !modernProduction && System.Version.TryParse(versionName, out var version))
            legacyProduction = version < new System.Version(1, 4);
        var units = new List<Unit>();
        bool experimental = modeName == "experiment";
        for (int side = 0; side < map.Infantry.Length; side++) AddSide(units, map, side, experimental);
        if (units.Count == 0) throw new FormatException("The initial deployment contains no units.");
        var orders = new Dictionary<int, List<Order>>();
        var productions = new Dictionary<int, List<Production>>();
        foreach (var property in root.EnumerateObject())
        {
            if (!int.TryParse(property.Name, NumberStyles.Integer, CultureInfo.InvariantCulture, out int tick)
                || tick < 0 || property.Value.ValueKind != JsonValueKind.Object) continue;
            foreach (var entry in property.Value.EnumerateObject())
            {
                if (entry.Name.StartsWith("production", StringComparison.Ordinal))
                {
                    var payload = entry.Value;
                    if (payload.ValueKind != JsonValueKind.Object) continue;
                    int slot = payload.TryGetProperty("color", out var color) ? color.GetInt32() : 0;
                    if (slot < 0 || slot >= map.Infantry.Length) continue;
                    if (payload.TryGetProperty("zone", out var zoneValue))
                    {
                        int[] zone = zoneValue.EnumerateArray().Select(x => x.GetInt32()).ToArray();
                        zone = zone.Where(city => city >= 0 && city < map.Cities.Count).Distinct().ToArray();
                        Add(productions, tick, new Production(slot, "", 0, zone));
                        continue;
                    }
                    double rate = Number(payload, "production_rate") ?? Number(payload, "rate") ?? 0.7;
                    string type = Text(payload, "production_type") ?? "infantry";
                    double? ratio = Number(payload, "ratio");
                    if (type is not ("infantry" or "tank" or "motorised")) type = "infantry";
                    Add(productions, tick, new Production(slot, type, Math.Max(0, rate), Ratio: ratio is double r ? Math.Clamp(r, 0, 1) : null));
                    continue;
                }
                if (!int.TryParse(entry.Name, NumberStyles.Integer, CultureInfo.InvariantCulture, out int id)) continue;
                var points = entry.Value.EnumerateArray().Select(Point).ToArray();
                Add(orders, tick, new Order(id, points));
            }
        }
        int endTick = root.TryGetProperty("end", out var end) ? end.GetInt32() : orders.Keys.Concat(productions.Keys).DefaultIfEmpty(0).Max();
        if (endTick < 0) throw new FormatException("Replay end frame must be non-negative.");
        return new Replay
        {
            Version = versionName,
            SourceMode = matchMode,
            LegacyProduction = legacyProduction,
            Mode = modeName,
            EndTick = endTick,
            Result = root.TryGetProperty("result", out var result) ? result.ValueKind switch
            {
                JsonValueKind.Number => result.GetDouble(),
                JsonValueKind.True => 1,
                JsonValueKind.False => 0,
                _ => null,
            } : null,
            Map = map,
            PlayerNames = ReadPlayerNames(root),
            PlayerLabels = ReadPlayerLabels(root),
            Units = units,
            Orders = orders,
            Productions = productions
        };
    }

    private static string? Text(JsonElement value, string name) => value.ValueKind == JsonValueKind.Object
        && value.TryGetProperty(name, out var field) && field.ValueKind == JsonValueKind.String ? field.GetString() : null;

    private static double? Number(JsonElement value, string name) => value.TryGetProperty(name, out var field)
        && field.ValueKind == JsonValueKind.Number && field.TryGetDouble(out var number) && double.IsFinite(number) ? number : null;

    private static string[][] ReadPlayerLabels(JsonElement root)
    {
        if (!root.TryGetProperty("player_usernames", out var players) || players.ValueKind != JsonValueKind.Array) return [];
        static string Label(JsonElement player)
        {
            if (player.ValueKind == JsonValueKind.String) return player.GetString() ?? "";
            string name = Text(player, "username") ?? "";
            string title = Text(player, "title") ?? "";
            return title.Length > 0 ? name + " [" + title + "]" : name;
        }
        return players.EnumerateArray().Select(side => side.ValueKind == JsonValueKind.Array
            ? side.EnumerateArray().Select(Label).ToArray() : new[] { Label(side) }).ToArray();
    }

    private static string[] ReadPlayerNames(JsonElement root)
    {
        if (!root.TryGetProperty("player_usernames", out var value) || value.ValueKind != JsonValueKind.Array) return ["blue", "red"];
        var names = new List<string>();
        foreach (var side in value.EnumerateArray())
        {
            // A 2v2 side names both teammates.
            string? name = side.ValueKind == JsonValueKind.Array
                ? string.Join(" & ", side.EnumerateArray().Select(x => x.ValueKind == JsonValueKind.String ? x.GetString() : Text(x, "username")).Where(x => !string.IsNullOrWhiteSpace(x)))
                : side.ValueKind == JsonValueKind.String ? side.GetString() : Text(side, "username");
            names.Add(string.IsNullOrWhiteSpace(name) ? $"player{names.Count + 1}" : name!);
        }
        return names.Count == 0 ? ["blue", "red"] : names.ToArray();
    }

    private static Stream OpenDecoded(string path)
    {
        var file = File.OpenRead(path);
        Span<byte> header = stackalloc byte[2];
        if (file.Read(header) == 2) file.Position = 0;
        if (header[0] == 0x1f && header[1] == 0x8b) return new GZipStream(file, CompressionMode.Decompress);
        file.Position = 0;
        return file;
    }

    private static void AddSide(List<Unit> units, ReplayMap map, int side, bool experimental)
    {
        foreach (var p in map.Infantry[side]) units.Add(new Unit(units.Count, side, "infantry", p, 100));
        foreach (var p in map.Tanks[side]) units.Add(new Unit(units.Count, side, "tank", p, 200));
        if (experimental) foreach (var p in map.Motorised[side]) units.Add(new Unit(units.Count, side, "motorised", p, 100));
    }

    private static Vec Point(JsonElement value)
    {
        var values = value.EnumerateArray().ToArray();
        if (values.Length < 2) throw new FormatException("Replay point must contain x and y.");
        return new(values[0].GetDouble(), values[1].GetDouble());
    }

    private static void Add<T>(Dictionary<int, List<T>> map, int key, T value)
    {
        if (!map.TryGetValue(key, out var list)) map[key] = list = [];
        list.Add(value);
    }
}

internal sealed class ReplayMap
{
    public int Width { get; init; } = 1600;
    public int Height { get; init; } = 900;
    public required string? MapSurface { get; init; }
    public MapSurfaceImage? Surface { get; init; }
    public required List<Vec>[] Infantry { get; init; }
    public required List<Vec>[] Tanks { get; init; }
    public required List<Vec>[] Motorised { get; init; }
    public required List<Vec> Cities { get; init; }
    public int[] Capitals { get; init; } = [];

    public static ReplayMap Read(JsonElement map, string replayDirectory, bool pygameCeRaster)
    {
        static List<Vec>[] Sides(JsonElement map, string name, int sideCount = 2)
        {
            if (!map.TryGetProperty(name, out var value)) return Enumerable.Range(0, sideCount).Select(_ => new List<Vec>()).ToArray();
            return value.EnumerateArray().Select(side => side.EnumerateArray().Select(x =>
            {
                var a = x.EnumerateArray().ToArray();
                return new Vec(a[0].GetDouble(), a[1].GetDouble());
            }).ToList()).ToArray();
        }
        var cities = map.TryGetProperty("cities", out var cityValue)
            ? cityValue.EnumerateArray().Select(x => { var a = x.EnumerateArray().ToArray(); return new Vec(a[0].GetDouble(), a[1].GetDouble()); }).ToList()
            : [];
        var infantry = Sides(map, "infantry");
        if (infantry.Length is < 2 or > 4) throw new FormatException("The simulation profile supports two to four colors.");
        var tanks = Sides(map, "tanks", infantry.Length);
        var motorised = Sides(map, "motorised", infantry.Length);
        if (tanks.Length != infantry.Length || motorised.Length != infantry.Length)
            throw new FormatException("Deployment arrays must have the same number of colors.");
        string? mapPath = map.TryGetProperty("path", out var pathValue) ? pathValue.GetString() : null;
        bool embeddedSurface = map.TryGetProperty("map_surface", out var surfaceValue);
        var surface = embeddedSurface
            ? MapSurfaceImage.Decode(surfaceValue.GetString())
            : MapSurfaceImage.LoadExternal(mapPath, replayDirectory);
        if (surface is null) throw new FormatException($"Cannot decode terrain map '{mapPath}'.");
        var bridges = map.TryGetProperty("bridges", out var bridgeValue)
            ? bridgeValue.EnumerateArray().Select(x => x.EnumerateArray().Select(p =>
              { var a = p.EnumerateArray().ToArray(); return new Vec(a[0].GetDouble(), a[1].GetDouble()); }).ToArray()).ToArray()
            : [];
        int width = surface.Width == 960 ? 1600 : 1920, height = surface.Width == 960 ? 900 : 1080;
        surface = surface.Rasterize(cities, bridges, width, height, pygameCeRaster);
        string? sourceSurface = embeddedSurface
            ? surfaceValue.GetString()
            : MapSurfaceImage.ExternalBase64(mapPath, replayDirectory);
        return new ReplayMap
        {
            Width = width, Height = height,
            MapSurface = sourceSurface,
            Surface = surface,
            Infantry = infantry,
            Tanks = tanks,
            Motorised = motorised,
            Cities = cities,
            Capitals = map.TryGetProperty("capitals", out var capitalValues) ? capitalValues.EnumerateArray().Select(x => x.GetInt32()).ToArray() : []
        };
    }
}

internal sealed class MapSurfaceImage
{
    private readonly byte[] pixels;
    private readonly byte[]? terrainIds;
    public int Width { get; }
    public int Height { get; }

    private MapSurfaceImage(int width, int height, byte[] pixels, byte[]? terrainIds = null)
    {
        Width = width; Height = height; this.pixels = pixels; this.terrainIds = terrainIds;
    }

    public static MapSurfaceImage? Decode(string? encoded)
    {
        if (string.IsNullOrWhiteSpace(encoded)) return null;
        try
        {
            byte[] png = Convert.FromBase64String(encoded);
            if (png.Length < 33 || png[0] != 137 || png[1] != 80 || png[2] != 78 || png[3] != 71) return null;
            int width = ReadInt(png, 16), height = ReadInt(png, 20);
            byte bitDepth = png[24], colorType = png[25];
            int channels = colorType switch { 0 => 1, 2 => 3, 3 => 1, 4 => 2, 6 => 4, _ => 0 };
            if (width <= 0 || height <= 0 || bitDepth != 8 || channels == 0 || png[28] != 0) return null;
            byte[]? palette = null;
            using var compressed = new MemoryStream();
            int offset = 8;
            while (offset + 8 <= png.Length)
            {
                int length = ReadInt(png, offset); string type = System.Text.Encoding.ASCII.GetString(png, offset + 4, 4);
                if (length < 0 || (long)offset + 12 + length > png.Length) return null;
                if (type == "IDAT") compressed.Write(png, offset + 8, length);
                if (type == "PLTE") palette = png.AsSpan(offset + 8, length).ToArray();
                offset += 12 + length;
                if (type == "IEND") break;
            }
            compressed.Position = 0;
            using var zlib = new ZLibStream(compressed, CompressionMode.Decompress);
            int stride = checked(width * channels);
            byte[] filtered = new byte[checked((stride + 1) * height)];
            int read = 0;
            while (read < filtered.Length)
            {
                int n = zlib.Read(filtered, read, filtered.Length - read);
                if (n == 0) break;
                read += n;
            }
            if (read != filtered.Length) return null;
            byte[] scan = new byte[checked(width * height * 3)];
            var prior = new byte[stride];
            var current = new byte[stride];
            for (int y = 0; y < height; y++)
            {
                int filter = filtered[y * (stride + 1)];
                Buffer.BlockCopy(filtered, y * (stride + 1) + 1, current, 0, current.Length);
                for (int i = 0; i < current.Length; i++)
                {
                    byte left = i >= channels ? current[i - channels] : (byte)0;
                    byte up = prior[i];
                    byte upLeft = i >= channels ? prior[i - channels] : (byte)0;
                    current[i] = filter switch
                    {
                        0 => current[i],
                        1 => unchecked((byte)(current[i] + left)),
                        2 => unchecked((byte)(current[i] + up)),
                        3 => unchecked((byte)(current[i] + ((left + up) / 2))),
                        4 => unchecked((byte)(current[i] + Paeth(left, up, upLeft))),
                        _ => throw new FormatException($"Unsupported PNG filter {filter}.")
                    };
                }
                for (int x = 0; x < width; x++)
                {
                    int source = x * channels, destination = (y * width + x) * 3;
                    if (colorType == 3)
                    {
                        int index = current[source] * 3;
                        if (palette is null || index + 2 >= palette.Length) return null;
                        palette.AsSpan(index, 3).CopyTo(scan.AsSpan(destination, 3));
                    }
                    else if (colorType is 0 or 4) Array.Fill(scan, current[source], destination, 3);
                    else current.AsSpan(source, 3).CopyTo(scan.AsSpan(destination, 3));
                }
                (prior, current) = (current, prior);
            }
            return new MapSurfaceImage(width, height, scan);
        }
        catch (Exception) { return null; }
    }

    public static IReadOnlyList<string> GameDirectories { get; set; } = [];
    /// The last map file that was not found, so a host can supply it and retry.
    public static string? Unresolved { get; set; }
    internal byte[] Pixels => pixels;

    public static MapSurfaceImage? LoadExternal(string? replayPath, string replayDirectory)
    {
        string? path = ResolveExternal(replayPath, replayDirectory);
        return path is null ? null : DecodeBytes(File.ReadAllBytes(path));
    }

    public static string? ExternalBase64(string? replayPath, string replayDirectory)
    {
        string? path = ResolveExternal(replayPath, replayDirectory);
        return path is null ? null : Convert.ToBase64String(File.ReadAllBytes(path));
    }

    private static string? ResolveExternal(string? replayPath, string replayDirectory)
    {
        if (string.IsNullOrWhiteSpace(replayPath)) return null;
        string normalized = replayPath.Replace('\\', '/');
        string fileName = Path.GetFileName(normalized);
        string supplied = Path.IsPathRooted(replayPath) ? replayPath : Path.Combine(replayDirectory, normalized.Replace('/', Path.DirectorySeparatorChar));
        if (File.Exists(supplied)) return supplied;
        string companion = Path.Combine(replayDirectory, "maps", fileName);
        if (File.Exists(companion)) return companion;
        // Official maps (fahero, zolamare, eronion) come from the installed game when it is available.
        if (normalized.StartsWith("assets/", StringComparison.OrdinalIgnoreCase) && !normalized.Contains(".."))
        {
            foreach (string directory in GameDirectories)
            {
                string installed = Path.Combine(directory, normalized.Replace('/', Path.DirectorySeparatorChar));
                if (File.Exists(installed)) return installed;
            }
            // Keep each author's asset directory. Their numbered PNG filenames
            // can collide even though the native catalog paths differ.
            string bundledAsset = Path.Combine(AppContext.BaseDirectory, "maps", normalized.Replace('/', Path.DirectorySeparatorChar));
            if (File.Exists(bundledAsset)) return bundledAsset;
        }
        if (normalized.Equals(fileName, StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith("assets/fahero_maps/", StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith("assets/zolamare_maps/", StringComparison.OrdinalIgnoreCase)
            || normalized.StartsWith("assets/eronion_maps/", StringComparison.OrdinalIgnoreCase))
        {
            string bundled = Path.Combine(AppContext.BaseDirectory, "maps", fileName);
            if (File.Exists(bundled)) return bundled;
        }
        Unresolved = normalized;
        return null;
    }

    private static MapSurfaceImage? DecodeBytes(byte[] png)
    {
        string encoded = Convert.ToBase64String(png);
        return Decode(encoded);
    }

    // The native surface is scaled before lookup. Quantize world coordinates
    // only after scaling the complete RGB raster, then apply replay geometry.
    public MapSurfaceImage Rasterize(IReadOnlyList<Vec> cities, IReadOnlyList<Vec[]> bridges, int width, int height, bool pygameCeFill)
    {
        byte[] ids = new byte[width * height];
        byte[] raster = new byte[width * height * 3];
        for (int y = 0; y < height; y++)
        for (int x = 0; x < width; x++)
        {
            int index = ((y * Height / height) * Width + x * Width / width) * 3;
            // The presentation map samples pixel centers. Terrain lookup uses
            // the separate corner-aligned raster above.
            int renderIndex = (Math.Min(Height-1,(int)((y+.5)*Height/height))*Width
                + Math.Min(Width-1,(int)((x+.5)*Width/width)))*3;
            pixels.AsSpan(renderIndex,3).CopyTo(raster.AsSpan((y*width+x)*3,3));
            ids[y * width + x] = (pixels[index], pixels[index + 1], pixels[index + 2]) switch
            {
                (56, 131, 54) => 1, (238, 227, 176) => 2, (136, 138, 135) => 3,
                (227, 242, 242) => 4, (120, 75, 35) => 5, (39, 155, 255) => 6,
                (109, 107, 111) => 7, (100, 60, 10) => 8, (255, 255, 0) => 9,
                _ => 0
            };
        }
        foreach (var bridge in bridges)
        {
            if (bridge.Length != 2) throw new FormatException("A bridge must have two endpoints.");
            var delta = bridge[1] - bridge[0];
            if (delta.Length == 0) continue;
            var offset = new Vec(-delta.Y, delta.X) * 7.5 * (1 / (delta.Length + 0.01));
            var vertices = new[] { bridge[0] + offset, bridge[0] - offset, bridge[1] - offset, bridge[1] + offset }
                .Select(p => new Vec((int)p.X, (int)p.Y)).ToArray();
            FillPolygon(ids, vertices, 8, width, height, pygameCeFill);
        }
        // Native pygame radius-nine circle raster, relative to its center.
        // This fixed stencil has 240 pixels and asymmetric pixel endpoints.
        int[] halfWidths = [2, 4, 6, 7, 7, 8, 8, 9, 9, 9, 9, 8, 8, 7, 7, 6, 4, 2];
        foreach (var city in cities)
            for (int row = 0; row < halfWidths.Length; row++)
                Span(ids, (int)city.Y + row - 9, (int)city.X - halfWidths[row], (int)city.X + halfWidths[row] - 1, 9, width, height);
        for (int i=0; i<ids.Length; i++)
        {
            if (ids[i]==9) { raster[i*3]=255; raster[i*3+1]=255; raster[i*3+2]=0; }
            else if (ids[i]==8) { raster[i*3]=100; raster[i*3+1]=60; raster[i*3+2]=10; }
        }
        return new MapSurfaceImage(width, height, raster, ids);
    }

    private static void FillPolygon(byte[] ids, Vec[] vertices, byte kind, int width, int height, bool pygameCeFill)
    {
        int bottom = (int)vertices.Max(p => p.Y), top = (int)vertices.Min(p => p.Y);
        for (int y = Math.Max(top, 0); y <= Math.Min(bottom, height - 1); y++)
        {
            var crossings = new List<int>(vertices.Length);
            for (int edge = 0; edge < vertices.Length; edge++)
            {
                var a = vertices[(edge + vertices.Length - 1) % vertices.Length]; var b = vertices[edge];
                if (a.Y == b.Y) { if (a.Y == y) Span(ids, y, (int)Math.Min(a.X, b.X), (int)Math.Max(a.X, b.X), kind, width, height); continue; }
                if (a.Y > b.Y) (a, b) = (b, a);
                if ((y >= a.Y && y < b.Y) || (y == bottom && b.Y == bottom))
                {
                    if (pygameCeFill)
                    {
                        // Pygame CE rounds the float32 edge offset by encounter
                        // parity, then adds the origin and sorts intersections.
                        float offset = (float)((y - a.Y) * (b.X - a.X)) / (float)(b.Y - a.Y);
                        crossings.Add((int)(crossings.Count % 2 == 0 ? MathF.Floor(offset) : MathF.Ceiling(offset)) + (int)a.X);
                    }
                    else
                    {
                        double crossing = (y - a.Y) * (b.X - a.X) / (b.Y - a.Y) + a.X;
                        crossings.Add((int)crossing);
                    }
                }
            }
            crossings.Sort();
            for (int i = 0; i + 1 < crossings.Count; i += 2) Span(ids, y, crossings[i], crossings[i + 1], kind, width, height);
        }
    }

    private static void Span(byte[] ids, int y, int left, int right, byte kind, int width, int height)
    {
        if (y < 0 || y >= height || right < 0 || left >= width) return;
        Array.Fill(ids, kind, y * width + Math.Max(left, 0), Math.Min(right, width - 1) - Math.Max(left, 0) + 1);
    }

    public void Export(string path) => File.WriteAllBytes(path, terrainIds ?? throw new InvalidOperationException("Terrain has not been rasterized."));

    public string PngBase64() => EncodePng(pixels, Width, Height, 3);

    public static string EncodePng(byte[] pixels, int Width, int Height, int channels)
    {
        using var output = new MemoryStream();
        output.Write(new byte[] {137,80,78,71,13,10,26,10});
        void Chunk(string name, byte[] data)
        {
            Span<byte> integer = stackalloc byte[4];
            System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(integer, data.Length);
            output.Write(integer);
            byte[] type = System.Text.Encoding.ASCII.GetBytes(name);
            output.Write(type); output.Write(data);
            uint crc = 0xffffffff;
            foreach (byte value in type.Concat(data))
            {
                crc ^= value;
                for (int bit=0; bit<8; bit++) crc=(crc>>1)^((crc&1)!=0?0xedb88320u:0);
            }
            System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(integer, ~crc);
            output.Write(integer);
        }
        var header = new byte[13];
        System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(0,4), Width);
        System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(4,4), Height);
        header[8]=8; header[9]=channels==4?(byte)6:(byte)2;
        Chunk("IHDR",header);
        using var compressed = new MemoryStream();
        using (var zipper = new ZLibStream(compressed, CompressionLevel.Optimal, leaveOpen:true))
            for (int y=0; y<Height; y++) { zipper.WriteByte(0); zipper.Write(pixels,y*Width*channels,Width*channels); }
        Chunk("IDAT",compressed.ToArray()); Chunk("IEND",[]);
        return Convert.ToBase64String(output.ToArray());
    }

    public TerrainKind At(Vec world)
    {
        int x = Math.Clamp((int)Math.Floor(world.X), 0, Width - 1);
        int y = Math.Clamp((int)Math.Floor(world.Y), 0, Height - 1);
        if (terrainIds is not null)
        {
            return terrainIds[y * Width + x] switch
            {
                1 => TerrainKind.Forest,
                2 => TerrainKind.Sand,
                3 => TerrainKind.Hill,
                4 => TerrainKind.Snow,
                5 => TerrainKind.Mud,
                6 => TerrainKind.Water,
                7 => TerrainKind.Mountain,
                8 => TerrainKind.Bridge,
                9 => TerrainKind.City,
                _ => TerrainKind.Plains
            };
        }
        throw new InvalidOperationException("Terrain has not been rasterized.");
    }

    private static int ReadInt(byte[] data, int index) => (data[index] << 24) | (data[index + 1] << 16) | (data[index + 2] << 8) | data[index + 3];
    private static byte Paeth(byte a, byte b, byte c)
    {
        int p = a + b - c, pa = Math.Abs(p - a), pb = Math.Abs(p - b), pc = Math.Abs(p - c);
        return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
}

internal enum TerrainKind { Plains, Forest, Sand, Water, Mountain, Bridge, Hill, Snow, Mud, City }

internal sealed class Unit
{
    public int Id { get; }
    public int Owner { get; internal set; }
    public string Type { get; internal set; }
    public Vec Position;
    public double Health;
    public double MaxHealth { get; internal set; }
    public double Morale = 100;
    public bool InCity;
    public double DamageReceived;
    public bool Retreating;
    public bool Retreated;
    public bool Healing;
    public string Terrain = "plain";
    public int StuckTimer = 0;
    public int ObjectiveFrame;
    public List<Vec> Path = [];
    public int PathIndex;
    public bool Fighting;
    public double Speed;
    public bool Ship;
    public bool ShipLandBlocked;
    public bool Active = true;
    public int WaterTimer;
    public int ShipTimer;
    public int TargetId = -1;
    public bool Destroyed;
    public bool HadObjective;
    public Vec PreviousPosition;
    public Vec SimulationPosition;
    public Vec ContactPosition;
    public Vec Facing = new(1,0);
    public Vec VisualDirection = new(1,0);
    public Vec FirstVisualDirection = new(1,0);
    public double FirstVibration,SecondVibration;

    public Unit(int id, int owner, string type, Vec position, double maxHealth)
    {
        Id = id; Owner = owner; Type = type; Position = position; MaxHealth = maxHealth; Health = maxHealth; Ship = false;
        PreviousPosition = position;
        SimulationPosition = position;
    }
}

internal readonly record struct Vec(double X, double Y)
{
    public static Vec operator +(Vec a, Vec b) => new(a.X + b.X, a.Y + b.Y);
    public static Vec operator -(Vec a, Vec b) => new(a.X - b.X, a.Y - b.Y);
    public static Vec operator *(Vec a, double b) => new(a.X * b, a.Y * b);
    public double LengthSquared => X * X + Y * Y;
    public double Length => Math.Sqrt(LengthSquared);
    public Vec Normalize() => LengthSquared < 1e-18 ? new(0, 0) : this * (1 / Length);
}

internal readonly record struct Order(int UnitId, Vec[] Points);
// A production command either sets a side's rate and unit type, or (with Zone)
// chooses which of its cities produce.
internal readonly record struct Production(int Slot, string Type, double Rate, int[]? Zone = null, double? Ratio = null);

internal sealed class Simulator
{
    private bool renderState;
    internal void EnableRenderState() => renderState = true;
    private const double Contact = 36.0;
    private readonly Replay replay;
    private readonly ReferenceTerritory territory;
    private readonly ReferenceEconomy economy;
    private uint randomState = 1;
    private int[] strength;
    private int[] troopCasualties;
    private readonly List<object> deadDots = [];
    private readonly HashSet<int> recordedDeaths = [];
    private readonly int[] casualties;
    private readonly VisualRandom visualRandom=new(1729);
    // Sound cues for the latest tick: units in combat, and the sides that produced
    // units since the last written frame (bit per side).
    public int FightCount { get; private set; }
    private int producedSides;
    public int TakeProducedSides() { int sides = producedSides; producedSides = 0; return sides; }

    private void RecordDeaths(int tick)
    {
        foreach (var unit in replay.Units.Where(u => u.Destroyed).OrderByDescending(u => u.Id))
            if (recordedDeaths.Add(unit.Id))
            {
                deadDots.Add(new { frame = tick, position = new[] { unit.Position.X, unit.Position.Y }, color = unit.Owner, type = unit.Type, ship = unit.Ship });
                casualties[unit.Owner]++;
            }
    }

    private double NextRandom()
    {
        randomState ^= randomState << 13;
        randomState ^= randomState >> 17;
        randomState ^= randomState << 5;
        return randomState / 4294967296.0;
    }
    private readonly Dictionary<int, List<Order>> pendingOrders;
    private readonly Dictionary<int, Order> deferredOrders = [];
    public int DeferredOrderCount { get; private set; }
    public int PendingOrderCount => deferredOrders.Count;

    public Simulator(Replay replay)
    {
        this.replay = replay;
        strength = new int[replay.SideCount]; troopCasualties = new int[replay.SideCount]; casualties = new int[replay.SideCount];
        territory = new ReferenceTerritory(replay);
        economy = new ReferenceEconomy(replay, territory);
        pendingOrders = replay.Orders;
    }

    public Result Write(string output, Options options)
    {
        long frames;
        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        using (var file = File.Create(output)) frames = Write(file, options);
        stopwatch.Stop();
        return new Result(frames, new FileInfo(output).Length, stopwatch.Elapsed);
    }

    public long Write(Stream output, Options options)
    {
        long frames = 0;
        using var writer = new StreamWriter(output, new System.Text.UTF8Encoding(false), 1 << 16, leaveOpen: true);
        renderState = options.RenderState;
        WriteStatic(writer);
        Run(options, frame =>
        {
            WriteState(writer, frame);
            if (frame == 0) writer.Flush();
            frames++;
        });
        return frames;
    }

    /// Simulates the replay and calls frameReady for frame 0 and every sampled frame.
    /// The callback may serialize the current state with WriteState.
    public void Run(Options options, Action<int> frameReady)
    {
        renderState = options.RenderState;
        int maxTick = Math.Min(replay.EndTick, options.MaxFrame ?? replay.EndTick);
        frameReady(0);
        for (int tick = 0; tick < maxTick; tick++)
        {
            ApplyOrders(tick);
            if (replay.Productions.TryGetValue(tick, out var commands)) foreach (var command in commands) economy.SetProduction(command, NextRandom);
            var influenceUnits = replay.Units.Where(u => u.Active).Select(u => u.Id).ToHashSet();
            Step(options.NoCombat);
            territory.Update(influenceUnits);
            if (tick % 30 == 1)
            {
                economy.Pay();
                int before = replay.Units.Count;
                economy.Produce(NextRandom);
                for (int i = before; i < replay.Units.Count; i++) producedSides |= 1 << replay.Units[i].Owner;
                int[] nextStrength = new int[replay.SideCount];
                foreach (var unit in replay.Units.Where(u => u.Active)) nextStrength[unit.Owner] += (int)unit.Health;
                for (int side = 0; side < replay.SideCount; side++) troopCasualties[side] += Math.Max(strength[side] - nextStrength[side], 0);
                strength = nextStrength;
            }
            RecordDeaths(tick);
            FightCount = replay.Units.Count(u => u.Active && u.Fighting);
            if(renderState)
                for(int pass=0;pass<2;pass++)foreach(var unit in replay.Units.Where(u=>u.Active))
                {
                    unit.VisualDirection=(unit.VisualDirection+unit.Facing*.2).Normalize();
                    double vibration=unit.Fighting?visualRandom.Vibration()/1.5:0;
                    if(pass==0){unit.FirstVisualDirection=unit.VisualDirection;unit.FirstVibration=vibration;}
                    else unit.SecondVibration=vibration;
                }
            int frame = tick + 1;
            if (frame % options.SampleEvery == 0 || frame == maxTick) frameReady(frame);
        }
    }

    public void ExportContours(string path) => File.WriteAllText(path, JsonSerializer.Serialize(
        territory.Contours().Select(side => side.Select(polygon => polygon.Select(p => new[] { p.X, p.Y })))));

    public void ExportRegions(string path) => File.WriteAllBytes(path, territory.Regions ?? throw new InvalidOperationException("No territory update has occurred."));

    internal void WriteStatic(TextWriter writer)
    {
        writer.Write($"{{\"kind\":\"static\",\"static_core\":{{\"map_size\":[{replay.Map.Width},{replay.Map.Height}],\"city_positions\":[");
        for (int i = 0; i < replay.Map.Cities.Count; i++) { if (i != 0) writer.Write(','); WriteVec(writer, replay.Map.Cities[i]); }
        writer.Write("]}");
        writer.Write(",\"replay\":"); writer.Write(JsonSerializer.Serialize(new { version = replay.Version, mode = replay.Mode, source_mode = replay.SourceMode, end = replay.EndTick, result = replay.Result, player_names = replay.PlayerNames }));
        writer.Write(",\"simulation_profile\":"); WriteJsonString(writer, replay.SimulationProfile);
        writer.Write(",\"historical_rules_approximate\":"); writer.Write(replay.ApproximateRules ? "true" : "false");
        if (renderState)
        {
            writer.Write(",\"render_profile\":\"wod-1.4.1-ea9225cf\",\"rendered_map_surface\":");
            WriteJsonString(writer, replay.Map.Surface!.PngBase64());
            writer.Write(",\"player_labels\":");
#if BROWSER
            // The page draws the names itself; there is no SDL text renderer in a browser.
            writer.Write(JsonSerializer.Serialize(replay.PlayerLabels.Select(team => team.Select(label => new { text = label }))));
#else
            writer.Write(JsonSerializer.Serialize(replay.PlayerLabels.Select((team, side) => team.Select(label => ReferenceText.Render(label,side,60,1.5)))));
#endif
        }
        if (!string.IsNullOrWhiteSpace(replay.Map.MapSurface))
        {
            writer.Write(",\"source_map_surface\":");
            WriteJsonString(writer, replay.Map.MapSurface);
        }
        writer.WriteLine("}");
    }

    internal void WriteState(TextWriter writer, int frame)
    {
        writer.Write("{\"kind\":\"state\",\"frame\":"); writer.Write(frame.ToString(CultureInfo.InvariantCulture));
        // Keep the frequent cue fields first so the player can index them without
        // parsing the much larger simulation state. Readers still accept any order.
        writer.Write(",\"audio\":["); writer.Write(FightCount); writer.Write(','); writer.Write(TakeProducedSides()); writer.Write(']');
        writer.Write(",\"compatibility\":{\"deferred_orders\":"); writer.Write(DeferredOrderCount);
        writer.Write(",\"pending_orders\":"); writer.Write(PendingOrderCount); writer.Write('}');
        writer.Write(",\"dots\":[");
        bool firstDot = true;
        for (int i = 0; i < replay.Units.Count; i++)
        {
            var u = replay.Units[i];
            if (!u.Active) continue;
            if (!firstDot) writer.Write(',');
            firstDot = false;
            writer.Write("{\"id\":"); writer.Write(u.Id);
            writer.Write(",\"position\":["); WriteNumber(writer, u.Position.X); writer.Write(','); WriteNumber(writer, u.Position.Y);
            writer.Write("],\"color\":"); writer.Write(u.Owner);
            writer.Write(",\"type\":\""); writer.Write(u.Type); writer.Write("\",\"health\":"); WriteNumber(writer, Math.Max(0, u.Health));
            writer.Write(",\"max_health\":"); WriteNumber(writer, u.MaxHealth);
            writer.Write(",\"morale\":"); WriteNumber(writer, u.Morale);
            writer.Write(",\"water_timer\":"); writer.Write(u.WaterTimer);
            writer.Write(",\"ship_timer\":"); writer.Write(u.ShipTimer);
            writer.Write(",\"in_city\":"); writer.Write(u.InCity ? "true" : "false");
            writer.Write(",\"healing\":"); writer.Write(u.Healing ? "true" : "false");
            writer.Write(",\"zrtyqz\":"); WriteJsonString(writer, u.Terrain);
            writer.Write(",\"damage_received\":"); WriteNumber(writer, u.DamageReceived);
            writer.Write(",\"objective_frame\":"); writer.Write(u.ObjectiveFrame);
            writer.Write(",\"stuck_timer\":"); writer.Write(u.StuckTimer);
            writer.Write(",\"path\":"); writer.Write(JsonSerializer.Serialize(u.Path.Skip(u.PathIndex).Select(p => new[] { p.X, p.Y })));
            writer.Write(",\"znmqz\":"); writer.Write(JsonSerializer.Serialize(u.Path.Skip(u.PathIndex).Select(p => new[] { p.X, p.Y })));
            writer.Write(",\"target\":"); writer.Write(u.TargetId < 0 ? "null" : u.TargetId.ToString(CultureInfo.InvariantCulture));
            writer.Write(",\"fighting\":"); writer.Write(u.Fighting ? "true" : "false");
            writer.Write(",\"speed\":"); WriteNumber(writer, u.Speed);
            writer.Write(",\"ship\":"); writer.Write(u.Ship ? "true" : "false");
            writer.Write("}");
        }
        writer.Write("],\"core\":{\"frame\":"); writer.Write(frame.ToString(CultureInfo.InvariantCulture));
        writer.Write(",\"winner\":"); writer.Write(JsonSerializer.Serialize(economy.Winner));
        writer.Write(",\"economy\":"); writer.Write(JsonSerializer.Serialize(economy.Output()));
        writer.Write(",\"dead_dots\":"); writer.Write(JsonSerializer.Serialize(deadDots));
        writer.Write(",\"casualties\":"); writer.Write(JsonSerializer.Serialize(casualties));
        writer.Write(",\"troop_casualties\":"); writer.Write(JsonSerializer.Serialize(troopCasualties));
        writer.Write(",\"strength\":"); writer.Write(JsonSerializer.Serialize(strength));
        writer.Write(",\"psrandom\":{\"state\":"); writer.Write(randomState); writer.Write('}');
        writer.Write(",\"capitals\":"); writer.Write(JsonSerializer.Serialize(economy.Capitals.Select((city, side) => (city, side)).Where(c => economy.IsCity(c.city)).Select(c => new
            { position = new[] { replay.Map.Cities[c.city].X, replay.Map.Cities[c.city].Y }, color = c.side, city_index = c.city })));
        writer.Write(",\"city_positions\":[");
        for (int i = 0; i < replay.Map.Cities.Count; i++) { if (i != 0) writer.Write(','); WriteVec(writer, replay.Map.Cities[i]); }
        writer.Write("],\"regions_sha256\":");
        if (territory.Regions is null) writer.Write("null");
        else WriteJsonString(writer, Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(territory.Regions)).ToLowerInvariant());
        writer.Write(",\"cities\":[");
        for (int i = 0; i < replay.Map.Cities.Count; i++)
        {
            if (i != 0) writer.Write(',');
            writer.Write("{\"position\":"); WriteVec(writer, replay.Map.Cities[i]);
            writer.Write(",\"color\":"); writer.Write(territory.CityColors[i]); writer.Write(",\"flag_offset\":[9,-13]}");
        }
        writer.Write("],\"alive_dots\":[");
        bool first = true;
        foreach (var u in replay.Units) if (u.Active && u.Health > 0) { if (!first) writer.Write(','); first = false; writer.Write(u.Id); }
        writer.Write("]}");
        if (renderState)
        {
            writer.Write(",\"render\":{\"contours\":");
            writer.Write(territory.Regions is null ? "[]" : JsonSerializer.Serialize(territory.Contours().Select(side => side.Select(polygon => polygon.Select(p => new[] { p.X, p.Y })))));
            writer.Write(",\"directions\":");
            writer.Write(JsonSerializer.Serialize(replay.Units.Where(u=>u.Active).Select(u=>new { id=u.Id, facing=new[]{u.Facing.X,u.Facing.Y}, first_visual=new[]{u.FirstVisualDirection.X,u.FirstVisualDirection.Y}, visual=new[]{u.VisualDirection.X,u.VisualDirection.Y}, first_vibration=u.FirstVibration,second_vibration=u.SecondVibration })));
            writer.Write('}');
        }
        writer.Write('}'); writer.WriteLine();
    }

    private void ApplyOrders(int tick)
    {
        // Keep the latest order for a unit that has not spawned in this simulation
        // yet. Never invent a unit, color or type from an order's coordinates.
        var ready = deferredOrders.Values.Where(o => o.UnitId < replay.Units.Count).OrderBy(o => o.UnitId).ToList();
        foreach (var order in ready) deferredOrders.Remove(order.UnitId);
        if (pendingOrders.TryGetValue(tick, out var orders)) ready.AddRange(orders);
        foreach (var order in ready)
        {
            if (order.UnitId < 0) continue;
            if (order.UnitId >= replay.Units.Count)
            {
                deferredOrders[order.UnitId] = order;
                DeferredOrderCount++;
                continue;
            }
            var unit = replay.Units[order.UnitId];
            if (unit.Destroyed) continue;
            unit.Path = order.Points.Length > 1 ? order.Points.Skip(1).Select(p => new Vec((int)p.X, (int)p.Y)).ToList() : [];
            int closeWaypoint = unit.Path.FindIndex(0, Math.Max(0, unit.Path.Count - 1), p => (p - unit.Position).Length < 18);
            if (closeWaypoint >= 0) unit.Path = unit.Path.Skip(closeWaypoint + 1).ToList();
            unit.PathIndex = 0;
            unit.ObjectiveFrame = tick;
        }
    }

    private void Step(bool noCombat)
    {
        ReferenceMovement.Step(replay, SpeedFor, NextRandom);
        if (noCombat) return;
        var damage = new double[replay.Units.Count];
        // Native target selection retains an in-range living target. Replacement
        // uses the first enemy by global ID, not the closest enemy.
        for (int i = 0; i < replay.Units.Count; i++)
        {
            var attacker = replay.Units[i];
            if (!attacker.Active || attacker.Health <= 0) continue;
            int target = attacker.TargetId;
            int firstEnemy = replay.Units.FindIndex(enemy => enemy.Active && enemy.Health > 0 && enemy.Owner != attacker.Owner
                && (enemy.ContactPosition
                    - attacker.ContactPosition).LengthSquared <= Contact * Contact);
            if (firstEnemy < 0) continue;
            if (target < 0 || target >= replay.Units.Count || !replay.Units[target].Active || replay.Units[target].Health <= 0
                || (replay.Units[target].PreviousPosition
                    - attacker.PreviousPosition).LengthSquared > Contact * Contact)
                target = firstEnemy;
            attacker.TargetId = target;
            if (target < 0) continue;
            attacker.Fighting = true;
        }
        // Morale is updated before outgoing damage is calculated.
        foreach (var unit in replay.Units)
        {
            if (!unit.Active || unit.Health <= 0) continue;
            double drop = unit.HadObjective ? 0.15 : 0.1;
            if (unit.Fighting && unit.Morale > drop) unit.Morale -= drop;
            else if (!unit.Fighting && unit.Morale < 99) unit.Morale += 0.04;
        }
        for (int i = 0; i < replay.Units.Count; i++)
        {
            var attacker = replay.Units[i];
            int target = attacker.TargetId;
            if (!attacker.Active || attacker.Health <= 0 || !attacker.Fighting || target < 0) continue;
            double terrainDamage = DamageFor(attacker);
            double multiplier = Matchup(attacker.Type, replay.Units[target].Type);
            double condition = (0.8 * (attacker.Morale / 100.0) + 0.2) * Math.Sqrt(Math.Max(attacker.Health / attacker.MaxHealth, 1e-9));
            damage[target] += (terrainDamage * condition) * multiplier;
        }
        var healingContacts = replay.Units.Where(u => u.Active && u.Health > 0).ToArray();
        for (int i = 0; i < replay.Units.Count; i++)
        {
            var unit = replay.Units[i];
            if (!unit.Active) continue;
            var terrain = replay.Map.Surface?.At(unit.SimulationPosition) ?? TerrainKind.Plains;
            unit.InCity = terrain == TerrainKind.City;
            unit.Terrain = terrain switch { TerrainKind.Plains => "plain", TerrainKind.Water => "river", _ => terrain.ToString().ToLowerInvariant() };
            if (unit.Retreated) damage[i] = 0;
            bool healBlocked = healingContacts.Any(other => other.Owner != unit.Owner
                && (other.ContactPosition
                    - unit.ContactPosition).LengthSquared <= 100.0 * 100.0);
            double heal = !unit.Ship && unit.Health < unit.MaxHealth && !healBlocked
                ? (terrain == TerrainKind.City ? 0.02 : 0.01) : 0;
            if (!replay.Experimental && unit.Type == "tank") heal *= 1.2;
            unit.Healing = !unit.Ship && unit.Health < unit.MaxHealth && !healBlocked;
            unit.Health = unit.Health + heal - damage[i];
            if (terrain == TerrainKind.Water && !unit.Ship)
            {
                unit.WaterTimer++;
            }
            else unit.WaterTimer = 0;
            bool allEdgesRiver = terrain == TerrainKind.Water && new Vec[]
            {
                new(8, 0), new(5, 5), new(0, 8), new(-5, 5),
                new(-8, 0), new(-5, -5), new(0, -8), new(5, -5)
            }.All(offset => replay.Map.Surface?.At(unit.SimulationPosition + offset) == TerrainKind.Water);
            bool shipTick = !unit.Fighting && (unit.Ship
                ? unit.ShipLandBlocked && unit.HadObjective
                : allEdgesRiver && !unit.HadObjective);
            unit.ShipTimer = shipTick ? unit.ShipTimer + 1 : 0;
            if (unit.ShipTimer > 90) { unit.Ship = !unit.Ship; unit.ShipTimer = 0; }
            if (unit.WaterTimer > 0 && unit.ShipTimer == 0) unit.Health -= Math.Sqrt(unit.WaterTimer) / 500.0;
            if (unit.Ship) unit.Health -= 0.01;
            if (!replay.FullPrecisionPositions)
            {
                unit.Health = PythonRound(unit.Health, 3);
                unit.Morale = PythonRound(unit.Morale, 2);
            }
            unit.DamageReceived = replay.FullPrecisionPositions ? damage[i] : PythonRound(damage[i], 3);
            if (unit.Health <= 0) { unit.Active = false; unit.Destroyed = true; }
        }
    }

    private double SpeedFor(Unit unit)
    {
        if (unit.Ship) return unit.Type == "tank" ? 0.3 : 0.5;
        var terrain = replay.Map.Surface?.At(unit.Position) ?? TerrainKind.Plains;
        int type = TypeIndex(unit.Type);
        int terrainIndex = TerrainIndex(terrain);
        double[,] speed =
        {
            { 0.50, 0.50, 0.30, 0.50, 0.40, 0.20, 0.10, 0.01, 0.50, 0.50 },
            { 0.30, 0.20, 0.30, 0.20, 0.24, 0.10, 0.08, 0.01, 0.30, 0.30 },
            { 0.75, 0.75, 0.75, 0.75, 0.60, 0.30, 0.15, 0.01, 0.75, 0.75 }
        };
        return speed[type, terrainIndex];
    }


    internal double DamageFor(Unit unit)
    {
        if (unit.Ship && unit.TargetId >= 0)
        {
            if (replay.FullPrecisionPositions)
                return replay.Units[unit.TargetId].Ship
                    ? (unit.Type == "tank" ? 0.05 : 0.2)
                    : (unit.Type == "tank" ? 0.1 : 0.02);
            return replay.Units[unit.TargetId].Ship
                ? (unit.Type == "tank" ? 0.1 : 0.3)
                : (unit.Type == "tank" ? 0.16 : 0.04);
        }
        var terrain = replay.Map.Surface?.At(unit.SimulationPosition) ?? TerrainKind.Plains;
        double[,] damage =
        {
            { 0.08, 0.08, 0.08, 0.08, 0.06, 0.04, 0.02, 0.00, 0.08, 0.08 },
            { 0.16, 0.08, 0.16, 0.16, 0.12, 0.08, 0.02, 0.00, 0.16, 0.16 },
            { 0.08, 0.08, 0.08, 0.08, 0.06, 0.04, 0.02, 0.00, 0.08, 0.08 }
        };
        return damage[TypeIndex(unit.Type), TerrainIndex(terrain)];
    }

    private static int TypeIndex(string type) => type switch
    {
        "tank" => 1,
        "motorised" => 2,
        _ => 0
    };

    private static int TerrainIndex(TerrainKind terrain) => terrain switch
    {
        TerrainKind.Plains => 0,
        TerrainKind.Forest => 1,
        TerrainKind.Sand => 2,
        TerrainKind.Hill => 3,
        TerrainKind.Snow => 4,
        TerrainKind.Mud => 5,
        TerrainKind.Water => 6,
        TerrainKind.Mountain => 7,
        TerrainKind.Bridge => 8,
        TerrainKind.City => 9,
        _ => 0
    };

    private static double Matchup(string attacker, string target)
    {
        double[,] matrix =
        {
            { 1.0, 1.0, 1.5 },
            { 1.0, 1.0, 2.0 },
            { 3.0, 1.5, 3.0 }
        };
        return matrix[TypeIndex(attacker), TypeIndex(target)];
    }

    private static void WriteVec(TextWriter writer, Vec value)
    {
        writer.Write('['); WriteNumber(writer, value.X); writer.Write(','); WriteNumber(writer, value.Y); writer.Write(']');
    }

    private static void WriteJsonString(TextWriter writer, string value)
    {
        writer.Write('"');
        foreach (char c in value)
        {
            switch (c)
            {
                case '"': writer.Write("\\\""); break;
                case '\\': writer.Write("\\\\"); break;
                case '\n': writer.Write("\\n"); break;
                case '\r': writer.Write("\\r"); break;
                case '\t': writer.Write("\\t"); break;
                default:
                    if (c < 0x20) writer.Write($"\\u{(int)c:x4}");
                    else writer.Write(c);
                    break;
            }
        }
        writer.Write('"');
    }

    private static void WriteNumber(TextWriter writer, double value)
        => writer.Write(value.ToString("G17", CultureInfo.InvariantCulture));

    // Python's round(float, digits) rounds the exact binary input. Multiplying
    // by 10^digits first can turn a nearby value into a tie, as with 2.675.
    internal static double PythonRound(double value, int digits)
    {
        if (!double.IsFinite(value) || value == 0) return value;
        long bits = BitConverter.DoubleToInt64Bits(value);
        bool negative = bits < 0;
        int exponentBits = (int)((bits >> 52) & 0x7ff);
        ulong significand = (ulong)bits & 0x000f_ffff_ffff_ffff;
        int exponent = exponentBits == 0 ? -1074 : exponentBits - 1023 - 52;
        if (exponentBits != 0) significand |= 1UL << 52;
        var numerator = new System.Numerics.BigInteger(significand) * System.Numerics.BigInteger.Pow(10, digits);
        var denominator = System.Numerics.BigInteger.One;
        if (exponent >= 0) numerator <<= exponent;
        else denominator <<= -exponent;
        var quotient = System.Numerics.BigInteger.DivRem(numerator, denominator, out var remainder);
        int comparison = (remainder * 2).CompareTo(denominator);
        if (comparison > 0 || comparison == 0 && !quotient.IsEven) quotient++;
        double rounded = (double)quotient / Math.Pow(10, digits);
        return negative ? -rounded : rounded;
    }

    internal static double NativeMaskedMatrixSum(ReadOnlySpan<double> values, int row)
    {
        // The game's contiguous (living,living) @ (living,2) NumPy product
        // uses the SkylakeX small GEMM kernel. Its four-row reduction and
        // final one/two-row reduction combine the same eight lanes differently.
        // Keep zero entries: compacting the enemy list changes lane placement.
        if (values.Length < 16 || 2L * values.Length * values.Length > 1_000_000)
        {
            double serial = 0;
            foreach (double value in values) serial += value;
            return serial;
        }
        Span<double> lanes = stackalloc double[8];
        lanes.Clear();
        for (int i = 0; i < values.Length; i++) lanes[i & 7] += values[i];
        if (row < (values.Length & ~3))
            return ((lanes[0] + lanes[1]) + (lanes[2] + lanes[3]))
                + ((lanes[4] + lanes[5]) + (lanes[6] + lanes[7]));
        return ((lanes[0] + lanes[4]) + (lanes[2] + lanes[6]))
            + ((lanes[1] + lanes[5]) + (lanes[3] + lanes[7]));
    }

    internal static double PythonHypot(double x, double y)
    {
        x = Math.Abs(x); y = Math.Abs(y);
        double result = double.Hypot(x, y);
        if (!double.IsFinite(result) || result == 0) return result;
        // Check the library approximation against exact dyadic midpoint
        // squares. Python's scalar hypot chooses the nearest binary64 root;
        // the platform Hypot can differ by one ULP on replay collision vectors.
        static (System.Numerics.BigInteger Mantissa, int Exponent) Parts(double value)
        {
            ulong bits = (ulong)BitConverter.DoubleToInt64Bits(value);
            int exponent = (int)((bits >> 52) & 0x7ff);
            ulong mantissa = bits & 0x000f_ffff_ffff_ffff;
            if (exponent != 0) mantissa |= 1UL << 52;
            return (new System.Numerics.BigInteger(mantissa), exponent == 0 ? -1074 : exponent - 1023 - 52);
        }
        static int Compare(System.Numerics.BigInteger a, int ae, System.Numerics.BigInteger b, int be)
        {
            int common = Math.Min(ae, be);
            return (a << (ae - common)).CompareTo(b << (be - common));
        }
        var xp = Parts(x); var yp = Parts(y);
        int sumExponent = Math.Min(xp.Exponent * 2, yp.Exponent * 2);
        var sum = (xp.Mantissa * xp.Mantissa << (xp.Exponent * 2 - sumExponent))
            + (yp.Mantissa * yp.Mantissa << (yp.Exponent * 2 - sumExponent));
        int CompareMidpoint(double a, double b)
        {
            var ap = Parts(a); var bp = Parts(b);
            int exponent = Math.Min(ap.Exponent, bp.Exponent);
            var midpoint = (ap.Mantissa << (ap.Exponent - exponent)) + (bp.Mantissa << (bp.Exponent - exponent));
            return Compare(sum, sumExponent, midpoint * midpoint, (exponent - 1) * 2);
        }
        while (true)
        {
            bool odd = (BitConverter.DoubleToInt64Bits(result) & 1) != 0;
            double previous = Math.BitDecrement(result), next = Math.BitIncrement(result);
            int low = CompareMidpoint(previous, result);
            if (low < 0 || low == 0 && odd) { result = previous; continue; }
            if (double.IsFinite(next))
            {
                int high = CompareMidpoint(result, next);
                if (high > 0 || high == 0 && odd) { result = next; continue; }
            }
            return result;
        }
    }

    internal static double NumpyRound(double value, int digits)
    {
        double scale = Math.Pow(10, digits);
        return Math.Round(value * scale, MidpointRounding.ToEven) / scale;
    }

    public readonly record struct Result(long Frames, long Bytes, TimeSpan Elapsed);
}
