namespace ReplaySim.Standalone;

// Reconstruction of the native proposal, friend-block, reroute and commit
// phases, including mountain sliding, retreat and near-waypoint routing.
internal static class ReferenceMovement
{
    private static readonly Vec[] EdgeOffsets = [new(8, 0), new(5, 5), new(0, 8), new(-5, 5), new(-8, 0), new(-5, -5), new(0, -8), new(5, -5)];
    private static readonly Vec[] Perimeter = Enumerable.Range(0, 32).Select(i => new Vec(
        Simulator.NumpyRound(Math.Cos(i * (2 * Math.PI / 32)), 9),
        Simulator.NumpyRound(Math.Sin(i * (2 * Math.PI / 32)), 9))).ToArray();
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
        for (int i = 0; i < count; i++)
        {
            var unit = replay.Units[i];
            positions[i] = proposals[i] = unit.Position;
            unit.PreviousPosition = unit.Position;
            unit.SimulationPosition = unit.Position;
            unit.Fighting = false;
            unit.Speed = 0;
            unit.Retreating = unit.Retreated = false;
            unit.ShipLandBlocked = false;
            if (!unit.Active || unit.Health <= 0) continue;
            double roll = random();
            moving[i] = unit.HadObjective = unit.Active && unit.Health > 0 && unit.PathIndex < unit.Path.Count;
            double chance = (moving[i] ? 0 : 5) * unit.DamageReceived / Math.Sqrt(Math.Max(unit.Health, 1e-9))
                * (3 - 2 * (unit.Morale / 100));
            if (replay.Map.Surface!.At(unit.Position) == TerrainKind.City) chance = chance * chance * chance;
            var enemies = replay.Units.Where(u => u.Active && u.Health > 0 && u.Owner != unit.Owner
                && (u.Position - unit.Position).LengthSquared <= 36 * 36).ToArray();
            if (unit.DamageReceived > 0 && Simulator.NumpyRound(chance, 6) > Simulator.NumpyRound(roll, 6) && enemies.Length > 0)
            {
                var center = new Vec(Simulator.NumpyRound(enemies.Sum(u => u.Position.X) / enemies.Length, 4),
                    Simulator.NumpyRound(enemies.Sum(u => u.Position.Y) / enemies.Length, 4));
                var deltaToEnemy = center - unit.Position;
                goals[i] = unit.Position - deltaToEnemy * (100 / (deltaToEnemy.Length > 1e-9 ? deltaToEnemy.Length : 1));
                moving[i] = unit.HadObjective = unit.Retreating = true;
            }
            else if (moving[i]) goals[i] = unit.Path[unit.PathIndex];
            if (!moving[i]) continue;
            var delta = goals[i] - positions[i];
            double distance = delta.Length;
            directions[i] = delta * (1 / (distance > 1e-9 ? distance : 1));
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
            var push = new Vec(0, 0);
            foreach (var offset in Perimeter)
                if (replay.Map.Surface!.At(positions[i] + offset * 12) == TerrainKind.Mountain) push += offset;
            push = new(Simulator.PythonRound(push.X, 6), Simulator.PythonRound(push.Y, 6));
            var desired = proposals[i] - positions[i];
            if (push.Length <= 0) { proposals[i] = positions[i]; continue; }
            var into = push * (1 / push.Length);
            double component = desired.X * into.X + desired.Y * into.Y;
            if (component <= 0) continue;
            var slide = desired - into * component;
            double length = slide.Length;
            if (length <= .01) { proposals[i] = positions[i]; continue; }
            var candidate = positions[i] + slide * (speeds[i] / length);
            if (replay.Map.Surface!.At(candidate) == TerrainKind.Mountain) { proposals[i] = positions[i]; continue; }
            proposals[i] = candidate;
            directions[i] = slide * (1 / length);
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
            double length = tangent.Length;
            if (length < 1e-9) continue;
            var candidate = positions[i] + tangent * (speeds[i] / length);
            if (replay.Map.Surface?.At(candidate) == TerrainKind.Mountain) continue;
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
            unit.Retreated = unit.Retreating && commit;
            unit.Position = new(Simulator.NumpyRound(final.X, 2), Simulator.NumpyRound(final.Y, 2));
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
