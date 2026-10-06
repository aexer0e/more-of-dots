namespace ReplaySim.Standalone;

// Reconstruction of the native proposal, friend-block, reroute and commit
// phases, including mountain sliding, retreat and near-waypoint routing.
internal static class ReferenceMovement
{
    private static readonly Vec[] EdgeOffsets = [new(8, 0), new(5, 5), new(0, 8), new(-5, 5), new(-8, 0), new(-5, -5), new(0, -8), new(5, -5)];
    // Exact NumPy perimeter values from manifest-verified June and July cores.
    private static readonly Vec[] Perimeter = [
        new(1.0, 0.0),
        new(0.9807852804032304, 0.19509032201612825),
        new(0.9238795325112867, 0.3826834323650898),
        new(0.8314696123025452, 0.5555702330196022),
        new(0.7071067811865476, 0.7071067811865476),
        new(0.5555702330196023, 0.8314696123025452),
        new(0.38268343236508984, 0.9238795325112867),
        new(0.19509032201612833, 0.9807852804032304),
        new(6.123233995736766e-17, 1.0),
        new(-0.1950903220161282, 0.9807852804032304),
        new(-0.3826834323650897, 0.9238795325112867),
        new(-0.555570233019602, 0.8314696123025453),
        new(-0.7071067811865475, 0.7071067811865476),
        new(-0.8314696123025453, 0.5555702330196022),
        new(-0.9238795325112867, 0.3826834323650899),
        new(-0.9807852804032304, 0.1950903220161286),
        new(-1.0, 1.2246467991473532e-16),
        new(-0.9807852804032304, -0.19509032201612836),
        new(-0.9238795325112868, -0.38268343236508967),
        new(-0.8314696123025455, -0.555570233019602),
        new(-0.7071067811865477, -0.7071067811865475),
        new(-0.5555702330196022, -0.8314696123025452),
        new(-0.38268343236509034, -0.9238795325112865),
        new(-0.19509032201612866, -0.9807852804032303),
        new(-1.8369701987210297e-16, -1.0),
        new(0.1950903220161283, -0.9807852804032304),
        new(0.38268343236509, -0.9238795325112866),
        new(0.5555702330196018, -0.8314696123025455),
        new(0.7071067811865474, -0.7071067811865477),
        new(0.8314696123025452, -0.5555702330196022),
        new(0.9238795325112865, -0.3826834323650904),
        new(0.9807852804032303, -0.19509032201612872),
    ];
    internal static (Vec Slide, double Length, Vec Direction)? MountainProjection(Vec desired, Vec push)
    {
        double pushLength = Simulator.PythonHypot(push.X, push.Y);
        if (pushLength <= 0) return null;
        // Native scalar mountain routing divides each component by math.hypot.
        // A reciprocal changes the projected slide by one ULP.
        var into = new Vec(push.X / pushLength, push.Y / pushLength);
        double component = desired.X * into.X + desired.Y * into.Y;
        if (component <= 0) return null;
        var slide = desired - into * component;
        double length = Simulator.PythonHypot(slide.X, slide.Y);
        var direction = length > 0 ? new Vec(slide.X / length, slide.Y / length) : new Vec(0, 0);
        return (slide, length, direction);
    }
    private static double SumPerimeterOffsets(ReadOnlySpan<double> values)
    {
        // NumPy reduces each selected perimeter coordinate independently.
        // Its small pairwise kernel uses eight lanes, then adds the remainder.
        // The perimeter has at most 32 entries.
        if (values.Length < 8)
        {
            double sum = -0.0;
            foreach (double value in values) sum += value;
            return sum;
        }
        Span<double> lanes = stackalloc double[8];
        values[..8].CopyTo(lanes);
        int paired = values.Length & ~7;
        for (int i = 8; i < paired; i++) lanes[i & 7] += values[i];
        double result = ((lanes[0] + lanes[1]) + (lanes[2] + lanes[3]))
            + ((lanes[4] + lanes[5]) + (lanes[6] + lanes[7]));
        for (int i = paired; i < values.Length; i++) result += values[i];
        return result;
    }
    public static void Step(Replay replay, Func<Unit, double> speedFor, Func<double> random)
    {
        int count = replay.Units.Count;
        var positions = new Vec[count];
        var proposals = new Vec[count];
        var directions = new Vec[count];
        var goals = new Vec[count];
        var speeds = new double[count];
        var moving = new bool[count];
        var reached = new bool[count];
        var mountainHandled = new bool[count];
        var outside = new bool[count];
        var friendBlocked = new bool[count];
        var friendHits = new bool[count, count];
        var rerouted = new bool[count];
        var enemyBlocked = new bool[count];
        var enemyHits = new bool[count, count];
        var initialPathIndices = new int[count];
        var living = replay.Units.Where(u => u.Active && u.Health > 0).ToArray();
        bool drawRetreatRolls = !replay.ConditionalRetreatRolls
            || replay.Units.Any(unit => unit.Active && unit.Health > 0 && unit.DamageReceived > 0);
        for (int i = 0; i < count; i++)
        {
            var unit = replay.Units[i];
            initialPathIndices[i] = unit.PathIndex;
            positions[i] = proposals[i] = unit.Position;
            unit.PreviousPosition = unit.Position;
            unit.SimulationPosition = unit.Position;
            unit.Fighting = false;
            unit.Speed = 0;
            unit.Retreating = unit.Retreated = false;
            unit.ShipLandBlocked = false;
            if (!unit.Active || unit.Health <= 0) continue;
            moving[i] = unit.HadObjective = unit.Active && unit.Health > 0 && unit.PathIndex < unit.Path.Count;
            double chance = (moving[i] ? 0 : 5) * unit.DamageReceived / Math.Sqrt(Math.Max(unit.Health, 1e-9))
                * (3 - 2 * (unit.Morale / 100));
            if (replay.Map.Surface!.At(unit.Position) == TerrainKind.City) chance = chance * chance * chance;
            // Historical cores skip the whole roll array when no unit was
            // damaged. Otherwise they draw once for every living unit.
            double roll = drawRetreatRolls ? random() : 0;
            // The 1.3 cores round both arrays before the strict comparison.
            // Rounding only the chance, or neither value, changes rare retreats.
            if (replay.RoundedRetreatComparison)
            {
                chance = Simulator.NumpyRound(chance, 6);
                roll = Simulator.NumpyRound(roll, 6);
            }
            var enemies = replay.Units.Where(u => u.Active && u.Health > 0 && u.Owner != unit.Owner
                && (u.Position - unit.Position).LengthSquared <= 36 * 36).ToArray();
            bool retreat = chance > roll;
            if (unit.DamageReceived > 0 && retreat && enemies.Length > 0)
            {
                var enemyIds = enemies.Select(u => u.Id).ToHashSet();
                int row = Array.IndexOf(living, unit);
                var center = new Vec(
                    Simulator.NativeMaskedMatrixSum(living.Select(u => enemyIds.Contains(u.Id) ? u.Position.X : 0).ToArray(), row) / enemies.Length,
                    Simulator.NativeMaskedMatrixSum(living.Select(u => enemyIds.Contains(u.Id) ? u.Position.Y : 0).ToArray(), row) / enemies.Length);
                if (!replay.FullPrecisionPositions)
                    center = new Vec(Simulator.NumpyRound(center.X, 4), Simulator.NumpyRound(center.Y, 4));
                var deltaToEnemy = center - unit.Position;
                double enemyDistance = deltaToEnemy.Length > 1e-9 ? deltaToEnemy.Length : 1;
                goals[i] = unit.Position - new Vec(deltaToEnemy.X / enemyDistance, deltaToEnemy.Y / enemyDistance) * 100;
                moving[i] = unit.HadObjective = unit.Retreating = true;
            }
            else if (moving[i]) goals[i] = unit.Path[unit.PathIndex];
            if (!moving[i]) continue;
            var delta = goals[i] - positions[i];
            double distance = delta.Length;
            // Native NumPy divides each component. Multiplying by a reciprocal
            // differs by one ULP on historical cores that retain full positions.
            double divisor = distance > 1e-9 ? distance : 1;
            directions[i] = new Vec(delta.X / divisor, delta.Y / divisor);
            speeds[i] = speedFor(unit);
            if (unit.Retreating) speeds[i] *= 1.5;
            proposals[i] = positions[i] + directions[i] * speeds[i];
            if (distance < speeds[i] && !unit.Retreating)
            {
                proposals[i] = unit.Path[unit.PathIndex];
                reached[i] = true;
            }
            outside[i] = proposals[i].X < 12 || proposals[i].X > replay.Map.Width - 12 || proposals[i].Y < 12 || proposals[i].Y > replay.Map.Height - 12;
            if (outside[i]) proposals[i] = positions[i];
        }
        Span<double> mountainX = stackalloc double[Perimeter.Length];
        Span<double> mountainY = stackalloc double[Perimeter.Length];
        for (int i = 0; i < count; i++)
        {
            if (!moving[i]) continue;
            var p = new Vec((int)proposals[i].X, (int)proposals[i].Y);
            if (!EdgeOffsets.Any(offset => replay.Map.Surface!.At(p + offset) == TerrainKind.Mountain)) continue;
            mountainHandled[i] = true;
            var unit = replay.Units[i];
            if ((goals[i] - positions[i]).LengthSquared < 144)
            {
                if (!unit.Retreating) unit.PathIndex++;
                proposals[i] = positions[i];
                continue;
            }
            int selectedOffsets = 0;
            foreach (var offset in Perimeter)
                if (replay.Map.Surface!.At(positions[i] + offset * 12) == TerrainKind.Mountain)
                {
                    mountainX[selectedOffsets] = offset.X;
                    mountainY[selectedOffsets++] = offset.Y;
                }
            var push = new Vec(SumPerimeterOffsets(mountainX[..selectedOffsets]),
                SumPerimeterOffsets(mountainY[..selectedOffsets]));
            var desired = proposals[i] - positions[i];
            var projection = MountainProjection(desired, push);
            if (projection is null) continue;
            var (slide, length, direction) = projection.Value;
            if (length <= .01) { proposals[i] = positions[i]; continue; }
            var candidate = positions[i] + slide * (speeds[i] / length);
            if (replay.Map.Surface!.At(candidate) == TerrainKind.Mountain) { proposals[i] = positions[i]; continue; }
            proposals[i] = candidate;
            // The later 22-pixel collision retry reuses this normalized vector.
            // Preserve native component division there too.
            directions[i] = direction;
        }
        // Ships wait at a land proposal before they can disembark.
        for (int i = 0; i < count; i++)
            if (replay.Units[i].Ship && replay.Map.Surface!.At(proposals[i]) != TerrainKind.Water)
            {
                proposals[i] = positions[i];
                replay.Units[i].ShipLandBlocked = true;
            }
        // The native hard boundary is 24. Reroutes recheck at 22. Both checks
        // include equality. The hit matrix is built once before resetting any
        // blocked proposal, and retries proceed in stable unit order.
        for (int i = 0; i < count; i++)
        for (int j = 0; j < count; j++)
        {
            var a = replay.Units[i];
            var b = replay.Units[j];
            if (i == j || !a.Active || !b.Active || a.Health <= 0 || b.Health <= 0 || a.Owner != b.Owner) continue;
            friendHits[i, j] = (proposals[i] - proposals[j]).LengthSquared <= 576;
            friendBlocked[i] |= friendHits[i, j];
        }
        for (int i = 0; i < count; i++) if (friendBlocked[i]) proposals[i] = positions[i];
        for (int i = 0; i < count; i++)
        {
            if (!friendBlocked[i] || !moving[i] || outside[i] || replay.Units[i].ShipLandBlocked) continue;
            var forward = positions[i] + directions[i] * speeds[i];
            bool clear = true;
            for (int j = 0; j < count; j++)
                if (friendHits[i, j] && (proposals[j] - forward).LengthSquared <= 484) clear = false;
            if (clear)
            {
                proposals[i] = forward;
                rerouted[i] = true;
                continue;
            }
            double waypointSlack = 24 * 1.05 - (goals[i] - positions[i]).Length;
            if (waypointSlack > 0)
            {
                // A friendly unit occupying a nearby destination consumes
                // that waypoint without moving the blocked unit this tick.
                bool occupied = false;
                for (int j = 0; j < count; j++)
                {
                    var other = replay.Units[j];
                    if (j == i || !other.Active || other.Health <= 0 || other.Owner != replay.Units[i].Owner) continue;
                    var originalOther = moving[j] ? positions[j] + directions[j] * speeds[j] : positions[j];
                    if (reached[j]) originalOther = goals[j];
                    var originalSelf = reached[i] ? goals[i] : forward;
                    if ((originalOther - originalSelf).LengthSquared <= 36 * 36
                        && (positions[j] - goals[i]).LengthSquared < waypointSlack * waypointSlack) occupied = true;
                }
                if (occupied)
                {
                    if (!replay.Units[i].Retreating) replay.Units[i].PathIndex++;
                    continue;
                }
            }
            if (replay.Map.Surface!.At(positions[i]) == TerrainKind.Bridge) continue;
            int obstacle = -1;
            double nearest = double.PositiveInfinity;
            for (int j = 0; j < count; j++)
            {
                if (!friendHits[i, j]) continue;
                double distance = (proposals[j] - forward).LengthSquared;
                if (distance < nearest) { nearest = distance; obstacle = j; }
            }
            if (obstacle < 0) continue;
            var away = positions[i] - proposals[obstacle];
            var a = positions[i] + new Vec(-away.Y, away.X);
            var b = positions[i] + new Vec(away.Y, -away.X);
            var waypoint = goals[i];
            var tangent = (waypoint - a).LengthSquared <= (waypoint - b).LengthSquared
                ? new Vec(-away.Y, away.X) : new Vec(away.Y, -away.X);
            // Native scalar rerouting uses Python math.hypot, whose rounded
            // result can differ from sqrt(x*x + y*y) by one ULP.
            double length = Simulator.PythonHypot(tangent.X, tangent.Y);
            if (length < 1e-9) continue;
            var candidate = positions[i] + tangent * (speeds[i] / length);
            var candidateTerrain = replay.Map.Surface!.At(candidate);
            if (candidateTerrain == TerrainKind.Mountain
                || replay.Units[i].Ship && candidateTerrain != TerrainKind.Water) continue;
            double candidateMin = double.PositiveInfinity, previousMin = double.PositiveInfinity;
            for (int j = 0; j < count; j++)
                if (friendHits[i, j])
                {
                    candidateMin = Math.Min(candidateMin, (proposals[j] - candidate).LengthSquared);
                    previousMin = Math.Min(previousMin, (proposals[j] - positions[i]).LengthSquared);
                }
            if (candidateMin <= 484 && candidateMin <= previousMin) continue;
            proposals[i] = candidate;
            directions[i] = (candidate - positions[i]) * (1 / Math.Max(speeds[i], 1e-9));
            rerouted[i] = true;
        }
        for (int i = 0; i < count; i++)
            replay.Units[i].ContactPosition = proposals[i];
        for (int i = 0; i < count; i++)
        for (int j = 0; j < count; j++)
        {
            var a = replay.Units[i];
            var b = replay.Units[j];
            if (!a.Active || !b.Active || a.Health <= 0 || b.Health <= 0 || a.Owner == b.Owner) continue;
            enemyHits[i, j] = (proposals[i] - proposals[j]).LengthSquared <= (18 * 1.9) * (18 * 1.9);
            enemyBlocked[i] |= enemyHits[i, j];
        }
        var beforeEnemyReset = (Vec[])proposals.Clone();
        for (int i = 0; i < count; i++)
            if (enemyBlocked[i] && moving[i] && !replay.Units[i].Retreating) proposals[i] = positions[i];
        for (int i = 0; i < count; i++)
        {
            if (!enemyBlocked[i] || !moving[i] || replay.Units[i].Retreating) continue;
            double candidateMin = double.PositiveInfinity, oldMin = double.PositiveInfinity;
            for (int j = 0; j < count; j++)
                if (enemyHits[i, j])
                {
                    candidateMin = Math.Min(candidateMin, (proposals[j] - beforeEnemyReset[i]).LengthSquared);
                    oldMin = Math.Min(oldMin, (proposals[j] - positions[i]).LengthSquared);
                }
            if (candidateMin > (18 * 1.9) * (18 * 1.9) || candidateMin > oldMin)
            {
                proposals[i] = beforeEnemyReset[i];
                enemyBlocked[i] = false;
            }
        }
        for (int i = 0; i < count; i++)
        {
            var unit = replay.Units[i];
            if (!unit.Active || unit.Health <= 0) continue;
            bool commit = moving[i] && !(friendBlocked[i] && !rerouted[i]) && !enemyBlocked[i];
            if(commit && directions[i].LengthSquared>1e-18)unit.Facing=directions[i];
            var final = commit ? proposals[i] : positions[i];
            if (final.X < 12 || final.X >= replay.Map.Width - 12 || final.Y < 12 || final.Y >= replay.Map.Height - 12
                || replay.Map.Surface?.At(final) == TerrainKind.Mountain) final = positions[i];
            unit.SimulationPosition = final;
            unit.StuckTimer = moving[i] && mountainHandled[i] && final == positions[i] && !unit.Retreating && !unit.Ship
                ? unit.StuckTimer + 1 : 0;
            if (unit.StuckTimer >= 30)
            {
                if (!unit.Retreating && unit.PathIndex < unit.Path.Count) unit.PathIndex++;
                unit.StuckTimer = 0;
            }
            // Native boundary rejection consumes the attempted waypoint even
            // when the position cannot commit. Other routing branches may
            // already have consumed that same waypoint this tick.
            if (outside[i] && !unit.Retreating && unit.PathIndex == initialPathIndices[i]
                && unit.PathIndex < unit.Path.Count) unit.PathIndex++;
            unit.Retreated = unit.Retreating && commit;
            unit.Position = replay.FullPrecisionPositions ? final
                : new(Simulator.NumpyRound(final.X, 2), Simulator.NumpyRound(final.Y, 2));
            // The native commit snaps after collision retries. Combat still
            // uses the unsnapped proposal; the stored position and route use
            // the waypoint only when the movement mask permits the commit.
            if (commit && reached[i])
            {
                unit.Position = goals[i];
                unit.PathIndex++;
            }
        }
    }
}
