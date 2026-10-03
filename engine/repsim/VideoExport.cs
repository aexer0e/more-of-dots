using System.Buffers;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace ReplaySim.Standalone;

/// Converts a replay straight to raw video frames: simulate, build the player's
/// draw list, render offscreen and write top-down RGB24 frames to stdout.
/// Progress lines ("progress done total") go to stderr.
internal static class VideoExport
{
    public static int Run(Options options)
    {
        var replay = Replay.Read(options.Input!);
        var simulator = new Simulator(replay);
        simulator.EnableRenderState();
        var staticWriter = new StringWriter();
        simulator.WriteStatic(staticWriter);
        using var staticDocument = JsonDocument.Parse(staticWriter.ToString());
        var staticRecord = staticDocument.RootElement;
        var mapSize = staticRecord.GetProperty("static_core").GetProperty("map_size");
        double worldWidth = mapSize[0].GetDouble(), worldHeight = mapSize[1].GetDouble();

        using var surface = new ReferenceRenderer.Surface(options.Width, options.Height);
        string assets = options.AssetsDirectory ?? Path.Combine(AppContext.BaseDirectory, "player-assets");
        foreach (string file in Directory.EnumerateFiles(assets, "*.png"))
            surface.Texture(Path.GetFileNameWithoutExtension(file), File.ReadAllBytes(file));
        string surfaceData = staticRecord.TryGetProperty("rendered_map_surface", out var rendered)
            ? rendered.GetString()!
            : staticRecord.GetProperty("source_map_surface").GetString()!;
        surface.Texture("map", MapTexture(surfaceData, (int)worldWidth, (int)worldHeight));
        var labels = new List<FrameDraws.Label>();
        if (staticRecord.TryGetProperty("player_labels", out var teams))
            foreach (var (team, side) in teams.EnumerateArray().Select((team, side) => (team, side)))
                foreach (var (label, slot) in team.EnumerateArray().Select((label, slot) => (label, slot)))
                {
                    string key = $"player-{side}-{slot}";
                    surface.Texture(key, Convert.FromBase64String(label.GetProperty("image").GetString()!));
                    var size = label.GetProperty("size");
                    // One line per player, teams in order.
                    labels.Add(new FrameDraws.Label(key, size[0].GetDouble(), size[1].GetDouble(), labels.Count));
                }

        var draws = new FrameDraws(options.Width, options.Height, worldWidth, worldHeight, options.Layers, labels);
        int step = options.Step, end = Math.Min(replay.EndTick, options.MaxFrame ?? replay.EndTick);
        int total = end / step + 1, written = 0;
        var stateText = new StringWriter(new StringBuilder(1 << 16));
        using var output = Console.OpenStandardOutput();
        Console.Error.WriteLine($"progress 0 {total}");
        // Sound cues for every simulated tick ("sound frame fighting producedSides"),
        // then the replay result, which picks the end sound.
        var cues = new StringBuilder();
        simulator.Run(options, frame =>
        {
            cues.Append("sound ").Append(frame).Append(' ').Append(simulator.FightCount).Append(' ').Append(simulator.TakeProducedSides()).Append('\n');
            if (frame % step != 0) return;
            Console.Error.Write(cues.ToString());
            cues.Clear();
            stateText.GetStringBuilder().Clear();
            simulator.WriteState(stateText, frame);
            using var state = JsonDocument.Parse(stateText.GetStringBuilder().ToString());
            // The parsed request reads the builder's buffer, so render before the next Build.
            var bytes = draws.Build(state.RootElement);
            if (options.DumpDraws is not null)
                File.AppendAllText(options.DumpDraws, Encoding.UTF8.GetString(bytes.Span) + "\n");
            using var request = JsonDocument.Parse(bytes);
            output.Write(surface.Render(request.RootElement));
            if (++written % 15 == 0 || written == total) Console.Error.WriteLine($"progress {written} {total}");
        });
        Console.Error.Write(cues.ToString());
        Console.Error.WriteLine(replay.Result is double result ? $"result {result.ToString(CultureInfo.InvariantCulture)}" : "result none");
        output.Flush();
        return 0;
    }

    // The player draws the map scaled to world size without smoothing.
    private static byte[] MapTexture(string base64, int width, int height)
    {
        byte[] png = Convert.FromBase64String(base64);
        var image = MapSurfaceImage.Decode(base64) ?? throw new FormatException("Cannot decode the replay map.");
        if (image.Width == width && image.Height == height) return png;
        byte[] source = image.Pixels, scaled = new byte[width * height * 3];
        for (int y = 0; y < height; y++)
        for (int x = 0; x < width; x++)
        {
            int sx = Math.Min(image.Width - 1, (int)((x + .5) * image.Width / width));
            int sy = Math.Min(image.Height - 1, (int)((y + .5) * image.Height / height));
            source.AsSpan((sy * image.Width + sx) * 3, 3).CopyTo(scaled.AsSpan((y * width + x) * 3, 3));
        }
        return Convert.FromBase64String(MapSurfaceImage.EncodePng(scaled, width, height, 3));
    }
}

/// C# port of the player's draw-list builder (src/player/engine.js paint,
/// overlays.js and frontline.js). Keep the two in step: the converter's video
/// must look like the player.
internal sealed class FrameDraws
{
    internal readonly record struct Label(string Key, double Width, double Height, int Line);
    private static readonly string[] Colors = ["blue", "red", "purple", "orange"];
    private static readonly int[][] Rgb = [[0, 0, 255], [255, 0, 0], [156, 0, 187], [255, 140, 57]];
    private readonly int width, height;
    private readonly double worldWidth, worldHeight;
    private readonly HashSet<string> layers;
    private readonly List<Label> labels;
    private readonly ArrayBufferWriter<byte> buffer = new(1 << 17);
    private Utf8JsonWriter json = null!;

    public FrameDraws(int width, int height, double worldWidth, double worldHeight, HashSet<string> layers, List<Label> labels)
    {
        (this.width, this.height, this.worldWidth, this.worldHeight, this.layers, this.labels) =
            (width, height, worldWidth, worldHeight, layers, labels);
    }

    public ReadOnlyMemory<byte> Build(JsonElement state)
    {
        buffer.Clear();
        using (json = new Utf8JsonWriter(buffer))
        {
            json.WriteStartObject();
            json.WriteString("kind", "render");
            json.WriteNumber("width", width);
            json.WriteNumber("height", height);
            json.WritePropertyName("mapSize");
            json.WriteStartArray(); json.WriteNumberValue(worldWidth); json.WriteNumberValue(worldHeight); json.WriteEndArray();
            json.WritePropertyName("draws");
            json.WriteStartArray();
            Paint(state);
            json.WriteEndArray();
            json.WriteEndObject();
        }
        return buffer.WrittenMemory;
    }

    private static double[] P(JsonElement point) => [point[0].GetDouble(), point[1].GetDouble()];
    // JavaScript's `object?.name`, with null and missing values treated alike.
    private static bool Has(JsonElement element, string name, out JsonElement value)
    {
        if (element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out value) && value.ValueKind != JsonValueKind.Null)
            return true;
        value = default;
        return false;
    }
    private static double Num(JsonElement element, string name) =>
        Has(element, name, out var value) && value.ValueKind == JsonValueKind.Number ? value.GetDouble() : 0;
    private static bool Truthy(JsonElement element, string name) =>
        Has(element, name, out var value) && value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.Number => value.GetDouble() != 0,
            JsonValueKind.String => value.GetString()!.Length > 0,
            JsonValueKind.Array or JsonValueKind.Object => true,
            _ => false,
        };

    private static string UnitSprite(JsonElement dot)
    {
        string color = Colors[(int)Num(dot, "color")], type = dot.GetProperty("type").GetString()!;
        if (Truthy(dot, "ship")) return $"{color}_{(type == "tank" ? "heavy_ship" : "ship")}";
        double ratio = Num(dot, "health") / Num(dot, "max_health");
        return $"{color}_{type}_{(ratio > 0.5 ? 100 : ratio > 0.15 ? 50 : 15)}";
    }

    private static double[] UnitSize(JsonElement dot)
    {
        double timer = Num(dot, "ship_timer");
        double scale = timer > 0 ? 1 + Math.Sin(timer / 4) / 12 : 1;
        return Truthy(dot, "ship") ? [36 * scale, 18 * scale] : [24 * scale, 24 * scale];
    }

    private static (string name, double[] size)? IconFor(JsonElement dot)
    {
        if (Num(dot, "ship_timer") > 0) return ("ship_icon", [32, 26]);
        if (Num(dot, "water_timer") > 0) return ("water_icon", [32, 31]);
        if (Truthy(dot, "in_city")) return ("city_icon", [36, 34]);
        if (Truthy(dot, "healing")) return ("healing_icon", [32, 31]);
        if (dot.GetProperty("type").GetString() == "tank" && Has(dot, "zrtyqz", out var terrain)
            && terrain.ValueKind == JsonValueKind.String && terrain.GetString() == "forest")
            return ("forest_icon", [32, 36]);
        return null;
    }

    private void Paint(JsonElement state)
    {
        var core = state.GetProperty("core");
        var dots = state.GetProperty("dots").EnumerateArray().ToArray();
        double frame = state.GetProperty("frame").GetDouble();
        var fading = new List<(JsonElement dot, double alpha)>();
        if (Has(core, "dead_dots", out var dead))
            foreach (var dot in dead.EnumerateArray())
            {
                double alpha = 0.75 - (frame - Num(dot, "frame")) * 0.01;
                if (alpha > 0) fading.Add((dot, alpha));
            }

        Image("map", [worldWidth / 2, worldHeight / 2], [worldWidth, worldHeight]);
        var contours = Has(state, "render", out var render) && Has(render, "contours", out var c) ? c : default;
        foreach (var line in FrontLines(contours, dots)) Line(line);
        if (Has(core, "capitals", out var capitals))
            foreach (var city in capitals.EnumerateArray())
                if (Has(city, "position", out var position))
                {
                    var p = P(position);
                    Image("capital", [p[0], p[1] - 2], [35, 33]);
                }
        foreach (var (dot, alpha) in fading)
        {
            string color = Colors[(int)Num(dot, "color")], type = dot.GetProperty("type").GetString()!;
            string name = Truthy(dot, "ship") ? $"{color}_{(type == "tank" ? "heavy_ship" : "ship")}" : $"{color}_{type}_15";
            Image(name, P(dot.GetProperty("position")), UnitSize(dot), alpha);
        }
        var directions = new Dictionary<double, JsonElement>();
        if (Has(state, "render", out render) && Has(render, "directions", out var list))
            foreach (var direction in list.EnumerateArray()) directions[direction.GetProperty("id").GetDouble()] = direction;
        for (int pass = 0; pass < 2; pass++)
            foreach (var dot in dots)
            {
                if (dot.ValueKind != JsonValueKind.Object || !(Num(dot, "health") > 0)) continue;
                bool hasVisual = directions.TryGetValue(dot.GetProperty("id").GetDouble(), out var visual);
                double vibration = hasVisual ? Num(visual, pass == 0 ? "first_vibration" : "second_vibration") : 0;
                var facing = hasVisual && Has(visual, "facing", out var f) ? P(f) : [0, 0];
                var position = P(dot.GetProperty("position"));
                double[] pos = [position[0] + facing[0] * vibration, position[1] + facing[1] * vibration];
                double[] dir = [1, 0];
                if (hasVisual && Has(visual, pass == 0 ? "first_visual" : "visual", out var chosen)) dir = P(chosen);
                else if (hasVisual && Has(visual, "visual", out var fallback)) dir = P(fallback);
                Image(UnitSprite(dot), pos, UnitSize(dot), 1, dir, false, true);
            }
        if (layers.Contains("orders"))
            foreach (var dot in dots)
            {
                if (dot.ValueKind != JsonValueKind.Object || Num(dot, "health") <= 0 || !Has(dot, "path", out var pathValue)) continue;
                var steps = pathValue.EnumerateArray().Select(P).ToList();
                if (steps.Count == 0) continue;
                var path = new List<double[]> { P(dot.GetProperty("position")) };
                path.AddRange(steps);
                double[] half = [0, 0, 0, 0.5];
                Line(path.Take(2).ToList(), half, 5, 2);
                if (steps.Count > 1) Line(steps, half, 5, 2);
                double[] end = path[^1], previous = path[^2];
                double dx = previous[0] - end[0], dy = previous[1] - end[1];
                double length = Math.Sqrt(dx * dx + dy * dy) + 0.01, ux = dx / length, uy = dy / length;
                foreach (int side in new[] { -1, 1 })
                    Line([end,
                        [end[0] + 9 * ux - side * 6 * uy, end[1] + 9 * uy + side * 6 * ux],
                        [end[0] + 12 * ux - side * 12 * uy, end[1] + 12 * uy + side * 12 * ux]], half, 5, 2);
            }
        foreach (var dot in dots)
            if (Num(dot, "health") > 0) Bars(dot);
        if (layers.Contains("flags") && Has(core, "cities", out var cities))
            foreach (var city in cities.EnumerateArray())
            {
                var p = P(city.GetProperty("position"));
                Image($"{Colors[(int)Num(city, "color")]}_flag", [p[0] + 9, p[1] - 13], [21, 27]);
            }
        if (layers.Contains("icons"))
            foreach (var dot in dots)
            {
                var icon = IconFor(dot);
                if (Num(dot, "health") > 0 && icon is { } found)
                {
                    var p = P(dot.GetProperty("position"));
                    Image(found.name, [p[0] + 20, p[1] - 10], found.size);
                }
            }
        if (layers.Contains("stats")) Stats(state, core, frame);
        double viewScale = Math.Min(width / worldWidth, height / worldHeight), viewWidth = worldWidth * viewScale, viewHeight = worldHeight * viewScale;
        if (layers.Contains("players"))
            foreach (var label in labels)
            {
                double w = label.Width * viewWidth / 1920, h = label.Height * viewHeight / 1080;
                Image(label.Key,
                    [(width - viewWidth) / 2 + viewWidth * 0.00313 + w / 2,
                     (height - viewHeight) / 2 + viewHeight * (1.0 / 30 + label.Line / 18.0)],
                    [w, h], 1, [1, 0], true);
            }
        if (layers.Contains("produce")) Production(core);
    }

    private void Bars(JsonElement dot)
    {
        bool health = layers.Contains("health"), morale = layers.Contains("morale");
        if (!health && !morale) return;
        var p = P(dot.GetProperty("position"));
        double x = p[0], y = p[1];
        bool both = health && morale;
        double top = y - (both ? 22.8 : 20.8), bottom = y - (both ? 10.8 : 12.8);
        void Rect(double x1, double y1, double x2, double y2, double[] color) =>
            Polygon([[x1, y1], [x1, y2], [x2, y2], [x2, y1]], color);
        Rect(x - 14.4, top, x + 14.4, bottom, [0, 0, 0, 1]);
        Rect(x - 12, top + 2, x + 12, bottom - 2, [0.3, 0.3, 0.3, 1]);
        if (morale)
            Rect(x - 12, bottom - 6, x - 12 + 24 * Math.Max(0, Num(dot, "morale")) / 100, bottom - 2, [0, 1, 0.94, 1]);
        if (health)
        {
            double fraction = Num(dot, "health") / Num(dot, "max_health");
            Rect(x - 12, top + 2, x - 12 + 24 * fraction, top + 6,
                fraction > 0.5 ? [0, 1, 0, 1] : fraction > 0.15 ? [1, 1, 0, 1] : [1, 0.498, 0.314, 1]);
        }
    }

    private static JsonElement Fields(JsonElement core) =>
        Has(core, "economy", out var economy) && Has(economy, "fields", out var fields) ? fields : default;

    private void Production(JsonElement core)
    {
        var economy = Fields(core);
        var cities = Has(core, "city_positions", out var positions) ? positions.EnumerateArray().Select(P).ToArray() : [];
        var zones = Has(economy, "industrial_zone", out var zoneValue)
            ? zoneValue.EnumerateArray().Select(side => side.EnumerateArray().Select(x => x.GetInt32()).ToList()).ToList()
            : [];
        List<List<List<int>>> groupsBySide = Has(economy, "city_enc", out var encoded) && encoded.GetArrayLength() > 0
            ? encoded.EnumerateArray().Select(side => side.EnumerateArray().Select(group => group.EnumerateArray().Select(x => x.GetInt32()).ToList()).ToList()).ToList()
            : zones.Select(indices => new List<List<int>> { indices }).ToList();
        double[] gray = [0.2, 0.2, 0.2, 0.8];
        for (int side = 0; side < groupsBySide.Count; side++)
            foreach (var group in groupsBySide[side])
            {
                var zone = side < zones.Count ? zones[side] : [];
                var indices = group.Where(zone.Contains).ToList();
                if (indices.Count == 1) Circle(cities[indices[0]], 10, gray);
                for (int i = 0; i < indices.Count; i++)
                    for (int j = i + 1; j < indices.Count; j++)
                        Line([cities[indices[i]], cities[indices[j]]], gray, 10, 2);
            }
    }

    private void Stats(JsonElement state, JsonElement core, double frame)
    {
        var economy = Fields(core);
        int sides = Has(core, "strength", out var strength) && strength.GetArrayLength() > 0 ? strength.GetArrayLength() : 2;
        int[] gray = [200, 200, 200];
        Text("tcasualties", "Casualties: ", [0.00313, 0.05 * (sides + 1)], gray);
        Text("tstrength", "Troops:  ", [0.99688, 0.05 * (sides + 1)], gray, "right");
        Text("tmoney", "Funds:  ", [0.99688, 0.95], gray, "right");
        double At(JsonElement array, int index) =>
            array.ValueKind == JsonValueKind.Array && index < array.GetArrayLength() && array[index].ValueKind == JsonValueKind.Number ? array[index].GetDouble() : 0;
        string Count(double value, bool includeZero = false) =>
            frame > 1 && (value != 0 || includeZero) ? $"~{Locale(value * 100)} " : "0";
        var casualties = Has(core, "troop_casualties", out var c) ? c : default;
        var incomes = Has(economy, "zasdxz", out var z) ? z : default;
        var funds = Has(economy, "zrtyz", out var m) ? m : default;
        for (int side = sides - 1; side >= 0; side--)
        {
            double y = 0.05 * (sides - side);
            double income = incomes.ValueKind == JsonValueKind.Array && side < incomes.GetArrayLength() ? At(incomes[side], 0) : 0;
            string arrow = income > 0 ? "▲" : income < 0 ? "▼" : "►";
            Text($"{side}casualties", Count(At(casualties, side)), [0.00313, y], Rgb[side]);
            Text($"{side}strength", Count(At(strength, side), true), [0.99688, y], Rgb[side], "right");
            Text($"{side}money", $"{arrow}{Math.Floor(At(funds, side) + 0.5).ToString(CultureInfo.InvariantCulture)} ",
                [0.99688, 0.95 - 0.05 * (sides - side)], Rgb[side], "right");
        }
    }

    // Number.prototype.toLocaleString("en-US"): grouped, at most three decimals.
    private static string Locale(double value) => value.ToString("#,##0.###", CultureInfo.InvariantCulture);

    private static string Key(double[] p) => string.Create(CultureInfo.InvariantCulture, $"{p[0]},{p[1]}");

    private static List<double[]> Smooth(List<double[]> points, bool loop)
    {
        int count = points.Count;
        var result = new List<double[]>(count + 1);
        for (int i = 0; i < count; i++)
        {
            double sx = 0, sy = 0;
            for (int delta = -2; delta <= 2; delta++)
            {
                int index = loop ? (i + delta + count) % count : Math.Max(0, Math.Min(count - 1, i + delta));
                sx += points[index][0] * 0.2;
                sy += points[index][1] * 0.2;
            }
            result.Add([sx, sy]);
        }
        if (loop) result.Add([result[0][0], result[0][1]]);
        else
        {
            result[0] = [points[0][0], points[0][1]];
            result[count - 1] = [points[count - 1][0], points[count - 1][1]];
        }
        return result;
    }

    private static List<double[]> Pushout(List<double[]> points, List<double[]> positions, double radius = 18)
    {
        if (positions.Count == 0) return points;
        return points.Select(point =>
        {
            double[]? closest = null;
            double distance2 = double.PositiveInfinity;
            foreach (var dot in positions)
            {
                double dx = point[0] - dot[0], dy = point[1] - dot[1], distance = dx * dx + dy * dy;
                if (distance < distance2) { distance2 = distance; closest = dot; }
            }
            if (distance2 >= radius * radius) return point;
            if (distance2 == 0) return new[] { closest![0] + radius, closest[1] };
            double scale = radius / Math.Sqrt(distance2);
            return new[] { closest![0] + (point[0] - closest[0]) * scale, closest[1] + (point[1] - closest[1]) * scale };
        }).ToList();
    }

    private List<List<double[]>> FrontLines(JsonElement contourValue, JsonElement[] dots)
    {
        var contours = new List<List<List<double[]>>>();
        if (contourValue.ValueKind == JsonValueKind.Array)
            foreach (var (side, color) in contourValue.EnumerateArray().Select((side, color) => (side, color)))
            {
                var polygons = new List<List<double[]>>();
                foreach (var polygon in side.EnumerateArray())
                {
                    var p = polygon.EnumerateArray().Select(P).ToList();
                    int last = p.Count - 1;
                    if (color == 0 && last > 1 && Key(p[0]) != Key(p[last])
                        && p.All(v => v[0] >= 0 && v[1] >= 0 && v[0] <= worldWidth && v[1] <= worldHeight))
                    {
                        p[0] = [(p[0][0] + 0.5 * p[1][0]) / 1.5, (p[0][1] + 0.5 * p[1][1]) / 1.5];
                        p[last] = [(p[last][0] + 0.5 * p[last - 1][0]) / 1.5, (p[last][1] + 0.5 * p[last - 1][1]) / 1.5];
                    }
                    polygons.Add(p);
                }
                contours.Add(polygons);
            }
        var lines = new List<List<double[]>>();
        var positions = contours.Select((_, color) => dots
            .Where(d => d.ValueKind == JsonValueKind.Object && Num(d, "health") > 0 && !Truthy(d, "ship") && Num(d, "color") == color)
            .Select(d => P(d.GetProperty("position"))).ToList()).ToList();
        var sets = contours.Select(polygons => polygons.SelectMany(polygon => polygon).Select(Key).ToHashSet()).ToList();
        for (int side = 0; side < contours.Count; side++)
            for (int other = side + 1; other < contours.Count; other++)
                foreach (var polygon in contours[side])
                {
                    var mask = polygon.Select(p => sets[other].Contains(Key(p))).ToArray();
                    var segments = new List<(List<double[]> points, bool loop)>();
                    if (mask.All(x => x)) segments.Add((polygon.Select(p => new[] { p[0], p[1] }).ToList(), true));
                    else
                        for (int i = 0; i < mask.Length; i++)
                        {
                            if (!mask[i] || mask[(i + mask.Length - 1) % mask.Length]) continue;
                            var points = new List<double[]>();
                            int j = i;
                            do
                            {
                                points.Add([polygon[j][0], polygon[j][1]]);
                                j = (j + 1) % mask.Length;
                            } while (mask[j] && j != i);
                            if (points.Count > 1) segments.Add((points, false));
                        }
                    foreach (var (p, loop) in segments)
                    {
                        p[0] = [(p[0][0] - p[1][0]) * 1.5 + p[1][0], (p[0][1] - p[1][1]) * 1.5 + p[1][1]];
                        int last = p.Count - 1;
                        p[last] = [(p[last][0] - p[last - 1][0]) * 1.5 + p[last - 1][0], (p[last][1] - p[last - 1][1]) * 1.5 + p[last - 1][1]];
                        var line = Smooth(p, loop);
                        foreach (int color in new[] { side, other }) line = Pushout(line, positions[color]);
                        lines.Add(line);
                    }
                }
        return lines;
    }

    private void Point(double[] point)
    {
        json.WriteStartArray(); json.WriteNumberValue(point[0]); json.WriteNumberValue(point[1]); json.WriteEndArray();
    }

    private void Numbers(string name, double[] values)
    {
        json.WritePropertyName(name);
        json.WriteStartArray();
        foreach (double value in values) json.WriteNumberValue(value);
        json.WriteEndArray();
    }

    private void Image(string name, double[] position, double[] size, double alpha = 1, double[]? direction = null, bool screen = false, bool flipY = false)
    {
        json.WriteStartObject();
        json.WriteString("type", "image");
        json.WriteString("name", name);
        Numbers("position", position);
        Numbers("size", size);
        json.WriteNumber("alpha", alpha);
        Numbers("direction", direction ?? [1, 0]);
        json.WriteBoolean("screen", screen);
        json.WriteBoolean("flipY", flipY);
        json.WriteEndObject();
    }

    private void Polygon(double[][] points, double[] color)
    {
        json.WriteStartObject();
        json.WriteString("type", "polygon");
        json.WritePropertyName("points");
        json.WriteStartArray();
        foreach (var point in points) Point(point);
        json.WriteEndArray();
        Numbers("color", color);
        json.WriteEndObject();
    }

    private void Circle(double[] position, double radius, double[] color)
    {
        json.WriteStartObject();
        json.WriteString("type", "circle");
        Numbers("position", position);
        json.WriteNumber("radius", radius);
        Numbers("color", color);
        json.WriteEndObject();
    }

    private void Text(string name, string text, double[] position, int[] color, string fix = "left", int fontSize = 60, double outline = 1.5)
    {
        json.WriteStartObject();
        json.WriteString("type", "text");
        json.WriteString("name", name);
        json.WriteString("text", text);
        Numbers("position", position);
        json.WritePropertyName("color");
        json.WriteStartArray();
        foreach (int value in color) json.WriteNumberValue(value);
        json.WriteEndArray();
        json.WriteString("fix", fix);
        json.WriteNumber("fontSize", fontSize);
        json.WriteNumber("outline", outline);
        json.WriteEndObject();
    }

    // renderer.line: each smoothing pass subdivides in float32, as Math.fround does.
    private void Line(List<double[]> points, double[]? color = null, double lineWidth = 8, int smooth = 1)
    {
        if (points.Count < 2) return;
        static double F(double value) => (float)value;
        for (int pass = 0; pass < smooth; pass++)
        {
            var refined = new List<double[]>(points.Count * 2) { new[] { F(points[0][0]), F(points[0][1]) } };
            double Blend(double a, double b, double weight) =>
                pass == 0 ? F(a * weight + b * (1 - weight)) : F(F(a * weight) + F(b * (1 - weight)));
            for (int i = 0; i < points.Count - 1; i++)
            {
                double[] a = points[i], b = points[i + 1];
                refined.Add([Blend(a[0], b[0], 0.75), Blend(a[1], b[1], 0.75)]);
                refined.Add([Blend(a[0], b[0], 0.25), Blend(a[1], b[1], 0.25)]);
            }
            refined.Add([F(points[^1][0]), F(points[^1][1])]);
            points = refined;
        }
        json.WriteStartObject();
        json.WriteString("type", "line");
        json.WritePropertyName("points");
        json.WriteStartArray();
        foreach (var point in points) Point(point);
        json.WriteEndArray();
        Numbers("color", color ?? [0, 0, 0, 1]);
        json.WriteNumber("width", lineWidth);
        json.WriteEndObject();
    }
}
