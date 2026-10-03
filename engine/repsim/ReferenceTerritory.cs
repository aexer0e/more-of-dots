namespace ReplaySim.Standalone;

// Native influence grid: x-major float32 sums, then stable side-order argmax.
// The contour and supply polygon phases are recovered separately.
internal sealed class ReferenceTerritory
{
    private readonly Replay replay;
    private readonly int width, height;
    private static readonly float[] DotKernel = Kernel(12, 3, 5);
    private static readonly float[] CityKernel = Kernel(90, 2, 1);
    public byte[]? Regions { get; private set; }
    public int[] CityColors { get; }
    public HashSet<int> InfluenceUnits { get; private set; } = [];

    public ReferenceTerritory(Replay replay)
    {
        this.replay = replay;
        width = replay.Map.Width / 10; height = replay.Map.Height / 10;
        CityColors = replay.Map.Cities.Select(city => replay.Units.MinBy(u => (u.Position - city).LengthSquared)!.Owner).ToArray();
    }

    public void Update(HashSet<int> influenceUnits)
    {
        InfluenceUnits = influenceUnits;
        var influence = Enumerable.Range(0, replay.SideCount).Select(_ => new float[width * height]).ToArray();
        for (int side = 0; side < replay.SideCount; side++)
        {
            foreach (var unit in replay.Units)
                if (influenceUnits.Contains(unit.Id) && unit.Owner == side && !unit.Ship) Add(influence[side], unit.Position, DotKernel, 12);
            for (int city = 0; city < CityColors.Length; city++)
                if (CityColors[city] == side) Add(influence[side], replay.Map.Cities[city], CityKernel, 90);
        }
        var next = new byte[width * height];
        for (int i = 0; i < next.Length; i++)
        {
            float max = influence[0][i];
            for (int side = 1; side < replay.SideCount; side++) if (influence[side][i] >= max) { max = influence[side][i]; next[i] = (byte)side; }
            if (Regions is not null && next[i] != Regions[i] && max < 1e-5f)
                next[i] = Regions[i];
        }
        Regions = next;
        for (int i = 0; i < CityColors.Length; i++) CityColors[i] = OwnerAt(replay.Map.Cities[i]);
    }

    public int OwnerAt(Vec point) => Regions![Math.Clamp((int)(point.X / 10), 0, width - 1) * height + Math.Clamp((int)(point.Y / 10), 0, height - 1)];

    public List<Vec[]>[] Contours() => Enumerable.Range(0, replay.SideCount).Select(side => ReferenceContours.Extract(Regions!, side, width, height)).ToArray();

    public (List<List<int>>[] Dots, List<List<int>>[] Cities) GridGroups()
    {
        var dots = Enumerable.Range(0, replay.SideCount).Select(_ => new List<List<int>>()).ToArray();
        var cities = Enumerable.Range(0, replay.SideCount).Select(_ => new List<List<int>>()).ToArray();
        var contours = Contours();
        for (int side = 0; side < replay.SideCount; side++)
        for (int i = 0; i < contours[side].Count; i++)
        {
            var polygon = contours[side][i];
            var children = contours[side].Where(other => ReferenceContours.Inside(other[0], polygon)).ToArray();
            bool InGroup(Vec p) => ReferenceContours.Inside(p, polygon) && !children.Any(child => ReferenceContours.Inside(p, child));
            dots[side].Add(replay.Units.Where(u => InfluenceUnits.Contains(u.Id) && u.Owner == side && InGroup(u.Position)).Select(u => u.Id).ToList());
            cities[side].Add(Enumerable.Range(0, CityColors.Length).Where(city => CityColors[city] == side && InGroup(replay.Map.Cities[city])).ToList());
        }
        return (dots, cities);
    }

    private void Add(float[] influence, Vec point, float[] kernel, int radius)
    {
        int centerX = (int)(point.X / 10), centerY = (int)(point.Y / 10), size = 2 * radius + 1;
        for (int x = Math.Max(0, centerX - radius); x <= Math.Min(width - 1, centerX + radius); x++)
        for (int y = Math.Max(0, centerY - radius); y <= Math.Min(height - 1, centerY + radius); y++)
            influence[x * height + y] += kernel[(x - centerX + radius) * size + y - centerY + radius];
    }

    private static float[] Kernel(int radius, int power, double strength)
    {
        int size = 2 * radius + 1;
        var result = new float[size * size];
        for (int x = -radius; x <= radius; x++)
        for (int y = -radius; y <= radius; y++)
            result[(x + radius) * size + y + radius] = (float)(strength / (1 + Math.Pow(x * x + y * y, power)));
        return result;
    }
}
