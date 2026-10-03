namespace ReplaySim.Standalone;

internal sealed class ReferenceEconomy
{
    private readonly Replay replay;
    private readonly ReferenceTerritory territory;
    public double[] Funds { get; }
    public double[] ProductionRates { get; }
    public string[] ProductionTypes { get; }
    public List<int>[] IndustrialZones { get; }
    public int[] Capitals { get; }
    public int[] CityCount { get; private set; }
    public int? Winner { get; private set; }
    public List<List<int>>[] DotGroups { get; private set; }
    public List<List<int>>[] CityGroups { get; private set; }
    public List<double>[] Balances { get; private set; }
    public bool HasPaid { get; private set; }
    public string[] ProductionQueue { get; }
    public double?[] ProductionRatios { get; }

    public ReferenceEconomy(Replay replay, ReferenceTerritory territory)
    {
        this.replay = replay; this.territory = territory;
        Funds = new double[replay.SideCount]; CityCount = new int[replay.SideCount];
        // Game scene setup: in avalanche every second color (1, 3) starts with 15000.
        if (replay.Avalanche)
            for (int side = 1; side < Funds.Length; side += 2) Funds[side] = 15000;
        ProductionRates = Enumerable.Repeat(0.7, replay.SideCount).ToArray();
        ProductionTypes = Enumerable.Repeat("infantry", replay.SideCount).ToArray();
        ProductionQueue = Enumerable.Repeat("infantry", replay.SideCount).ToArray();
        ProductionRatios = Enumerable.Repeat<double?>(replay.LegacyProduction ? 1 : null, replay.SideCount).ToArray();
        IndustrialZones = Enumerable.Range(0, replay.SideCount).Select(_ => new List<int>()).ToArray();
        DotGroups = Enumerable.Range(0, replay.SideCount).Select(_ => new List<List<int>>()).ToArray();
        CityGroups = Enumerable.Range(0, replay.SideCount).Select(_ => new List<List<int>>()).ToArray();
        Balances = Enumerable.Range(0, replay.SideCount).Select(_ => new List<double> { 0 }).ToArray();
        for (int i = 0; i < territory.CityColors.Length; i++) IndustrialZones[territory.CityColors[i]].Add(i);
        Capitals = replay.Map.Capitals.ToArray();
        // Avalanche maps drop cities but keep the original capital indices, which then
        // name no city: such a capital is never connected and never owned.
        for (int side = 0; side < Capitals.Length; side++)
            if (IsCity(Capitals[side]) && territory.CityColors[Capitals[side]] != side)
            {
                Capitals[side] = replay.Map.Capitals.FirstOrDefault(city => IsCity(city) && territory.CityColors[city] == side, IndustrialZones[side].FirstOrDefault(-1));
            }
    }

    public bool IsCity(int index) => index >= 0 && index < territory.CityColors.Length;

    public void SetProduction(Production command)
    {
        if (command.Zone is not null)
        {
            IndustrialZones[command.Slot] = command.Zone.Distinct().ToList();
            return;
        }
        ProductionRates[command.Slot] = command.Rate;
        ProductionRatios[command.Slot] = command.Ratio;
        if (command.Ratio is double ratio)
        {
            // Legacy slider: 1 is light infantry, 0 is heavy tanks. Fractional
            // settings choose the next unit after a successful birth, never on
            // blocked/underfunded attempts. Keep the queued type between births.
            if (ratio is 0 or 1) ProductionTypes[command.Slot] = ProductionQueue[command.Slot] = ratio == 1 ? "infantry" : "tank";
            return;
        }
        ProductionQueue[command.Slot] = command.Type;
        ProductionTypes[command.Slot] = command.Type;
    }

    public void Produce(Func<double> random)
    {
        for (int side = 0; side < replay.SideCount; side++)
        foreach (var group in CityGroups[side])
        {
            string type = ProductionTypes[side];
            double price = type == "infantry" ? 200 : 400;
            if (!(Funds[side] > Simulator.PythonRound(price / ProductionRates[side], 3))) continue;
            var candidates = group.Where(IndustrialZones[side].Contains).ToArray();
            if (candidates.Length == 0) continue;
            int city = candidates[(int)(random() * candidates.Length)];
            var point = replay.Map.Cities[city];
            bool blocked = replay.Units.Any(u => (u.Active || territory.InfluenceUnits.Contains(u.Id)) && Simulator.NumpyRound((u.Position - point).LengthSquared, 3)
                < (u.Owner == side ? (24 * 1.1) * (24 * 1.1) : (36 * 1.1) * (36 * 1.1)));
            if (blocked) continue;
            Funds[side] -= price;
            if (ProductionRatios[side] is double ratio)
                ProductionQueue[side] = ChooseLegacyType(ratio, random);
            ProductionTypes[side] = ProductionQueue[side];
            var unit = new Unit(replay.Units.Count, side, type, point, type == "tank" ? 200 : 100) { Health = 4, InCity = true };
            replay.Units.Add(unit);
        }
    }

    internal static string ChooseLegacyType(double infantryRatio, Func<double> random)
        => infantryRatio >= 1 ? "infantry" : infantryRatio <= 0 ? "tank" : random() < infantryRatio ? "infantry" : "tank";

    public void Pay()
    {
        HasPaid = true;
        (DotGroups, CityGroups) = territory.GridGroups();
        Balances = Enumerable.Range(0, replay.SideCount).Select(_ => new List<double>()).ToArray();
        for (int side = 0; side < replay.SideCount; side++)
        {
            IndustrialZones[side].RemoveAll(city => territory.CityColors[city] != side);
            bool capitalFound = false;
            int capitalGroup = -1;
            // A capital that names no city (avalanche) leaves the side's largest group
            // drawing on its funds; this matches the orders recorded in avalanche replays.
            bool hasCapital = Capitals.Length > side && IsCity(Capitals[side]);
            int fundedGroup = Capitals.Length <= side || hasCapital || DotGroups[side].Count == 0 ? -1
                : DotGroups[side].IndexOf(DotGroups[side].MaxBy(g => g.Count)!);
            for (int group = 0; group < DotGroups[side].Count; group++)
            {
                var paid = DotGroups[side][group].Select(id => replay.Units[id]).Where(u => !u.InCity && !u.Ship).ToArray();
                double income = CityGroups[side][group].Count * 5 - paid.Length;
                bool connected = hasCapital ? CityGroups[side][group].Contains(Capitals[side]) : group == fundedGroup;
                capitalFound |= connected;
                if (connected) capitalGroup = group;
                double balance = income + (connected ? Funds[side] : 0);
                if (connected) Funds[side] = Math.Max(balance, 0);
                if (balance < 0 && paid.Length > 0)
                {
                    var unit = paid[^1]; unit.Health += balance * 3;
                    if (unit.Health <= 0) { unit.Active = false; unit.Destroyed = true; }
                }
                Balances[side].Add(connected && balance < 0 ? balance : income);
            }
            if (!capitalFound && Balances[side].Count > 0) Balances[side][0] = Math.Max(Balances[side][0], 0);
            if (capitalGroup > 0)
            {
                (DotGroups[side][0], DotGroups[side][capitalGroup]) = (DotGroups[side][capitalGroup], DotGroups[side][0]);
                (CityGroups[side][0], CityGroups[side][capitalGroup]) = (CityGroups[side][capitalGroup], CityGroups[side][0]);
                (Balances[side][0], Balances[side][capitalGroup]) = (Balances[side][capitalGroup], Balances[side][0]);
            }
        }
        CityCount = Enumerable.Range(0, replay.SideCount).Select(side => territory.CityColors.Count(c => c == side)).ToArray();
        for (int side = 0; side < replay.SideCount; side++)
            if (CityCount.Sum() * 0.8 < CityCount[side] && Capitals.All(city => IsCity(city) && territory.CityColors[city] == side)) Winner = side;
    }

    public object Output() => new { fields = new Dictionary<string, object>
    {
        ["zyuixz"] = replay.Colors, ["zrtyz"] = Funds,
        ["city_count"] = CityCount, ["industrial_zone"] = IndustrialZones,
        ["production_queue"] = ProductionQueue, ["production_type"] = ProductionTypes,
        ["production_rate"] = ProductionRates,
        ["production_ratio"] = ProductionRatios,
        ["dot_enc"] = HasPaid ? DotGroups : Array.Empty<object>(),
        ["city_enc"] = HasPaid ? CityGroups : Array.Empty<object>(),
        ["zasdxz"] = Balances, ["available_units"] = replay.Experimental ? new[] { "infantry", "tank", "motorised" } : ["infantry", "tank"],
        ["price"] = new Dictionary<string, int> { ["infantry"] = 200, ["tank"] = 400, ["motorised"] = 400 }
    }};
}
