namespace ReplaySim.Standalone;

// Binary marching squares with low-valued diagonal connectivity. Directed
// segment assembly preserves scan order and the first-created contour ID.
internal static class ReferenceContours
{
    private sealed class Chain(int id, Vec from, Vec to)
    {
        public int Id = id;
        public List<Vec> Points = [from, to];
    }

    public static List<Vec[]> Extract(byte[] regions, int side, int width, int height)
    {
        var chains = new SortedDictionary<int, Chain>();
        var starts = new Dictionary<Vec, Chain>();
        var ends = new Dictionary<Vec, Chain>();
        int nextId = 0;
        bool At(int x, int y) => x >= 1 && x <= width && y >= 1 && y <= height && regions[(x - 1) * height + y - 1] == side;
        void Segment(Vec from, Vec to)
        {
            starts.Remove(to, out var tail);
            ends.Remove(from, out var head);
            if (tail is null && head is null)
            {
                var chain = new Chain(nextId++, from, to);
                chains.Add(chain.Id, chain); starts[from] = chain; ends[to] = chain;
            }
            else if (head is null)
            {
                tail!.Points.Insert(0, from); starts[from] = tail;
            }
            else if (tail is null)
            {
                head.Points.Add(to); ends[to] = head;
            }
            else if (ReferenceEquals(head, tail)) head.Points.Add(to);
            else if (tail.Id > head.Id)
            {
                head.Points.AddRange(tail.Points); chains.Remove(tail.Id);
                starts[head.Points[0]] = head; ends[head.Points[^1]] = head;
            }
            else
            {
                tail.Points.InsertRange(0, head.Points); chains.Remove(head.Id);
                starts.Remove(head.Points[0]);
                starts[tail.Points[0]] = tail; ends[tail.Points[^1]] = tail;
            }
        }
        for (int x = 0; x < width + 1; x++)
        for (int y = 0; y < height + 1; y++)
        {
            int code = (At(x, y) ? 1 : 0) | (At(x, y + 1) ? 2 : 0)
                | (At(x + 1, y) ? 4 : 0) | (At(x + 1, y + 1) ? 8 : 0);
            Vec top = new(x, y + .5), bottom = new(x + 1, y + .5), left = new(x + .5, y), right = new(x + .5, y + 1);
            switch (code)
            {
                case 1: Segment(top, left); break;
                case 2: Segment(right, top); break;
                case 3: Segment(right, left); break;
                case 4: Segment(left, bottom); break;
                case 5: Segment(top, bottom); break;
                case 6: Segment(right, top); Segment(left, bottom); break;
                case 7: Segment(right, bottom); break;
                case 8: Segment(bottom, right); break;
                case 9: Segment(top, left); Segment(bottom, right); break;
                case 10: Segment(bottom, top); break;
                case 11: Segment(bottom, left); break;
                case 12: Segment(left, right); break;
                case 13: Segment(top, right); break;
                case 14: Segment(left, top); break;
            }
        }
        var polygons = chains.Values.Select(chain => Simplify(chain.Points, width, height)).ToList();
        if (side == 0)
            foreach (var polygon in polygons)
                if (polygon.Length > 2 && !polygon.Any(p => p.X == -10 || p.X == (width + 1) * 10 || p.Y == -10 || p.Y == (height + 1) * 10))
                {
                    polygon[0] = (polygon[0] - polygon[1]) * .5 * 3 + polygon[1];
                    polygon[^1] = (polygon[^1] - polygon[^2]) * .5 * 3 + polygon[^2];
                }
        return polygons;
    }

    private static Vec[] Simplify(List<Vec> source, int width, int height)
    {
        var points = source.Select(p => p - new Vec(.5, .5)).ToArray();
        var boundary = new bool[points.Length];
        var corners = new bool[points.Length];
        for (int i = 0; i < points.Length; i++)
        {
            var p = points[i];
            bool xEdge = p.X <= .5 || p.X >= width - .5, yEdge = p.Y <= .5 || p.Y >= height - .5;
            points[i] = new(p.X <= .5 ? -1 : p.X >= width - .5 ? width + 1 : p.X,
                p.Y <= .5 ? -1 : p.Y >= height - .5 ? height + 1 : p.Y);
            boundary[i] = xEdge || yEdge; corners[i] = xEdge && yEdge;
        }
        return points.Where((_, i) => corners[i] || !(boundary[i]
            && boundary[(i + points.Length - 1) % points.Length] && boundary[(i + 1) % points.Length])).Select(p => p * 10).ToArray();
    }

    public static bool Inside(Vec point, Vec[] polygon)
    {
        int crossings = 0;
        for (int i = 0; i < polygon.Length; i++)
        {
            var a = polygon[i]; var b = polygon[(i + 1) % polygon.Length];
            if (Math.Abs(point.X - a.X) <= 1e-8 + 1e-5 * Math.Abs(a.X)
                && Math.Abs(point.Y - a.Y) <= 1e-8 + 1e-5 * Math.Abs(a.Y)) return false;
            if ((a.Y > point.Y) != (b.Y > point.Y)
                && point.X < (b.X - a.X) * (point.Y - a.Y) / (b.Y - a.Y + 1e-12) + a.X) crossings++;
        }
        return crossings % 2 == 1;
    }
}
