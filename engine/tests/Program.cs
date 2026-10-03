using System.IO.Compression;
using System.Text.Json;
using System.Text.Json.Nodes;
using ReplaySim.Standalone;

var tests = new (string, Action)[] {
    ("legacy custom map, nested mode and string labels", () => {
        var root = Fixture(); root["version"] = "1.2.18.3"; root["custom_map"] = root["map"]!.DeepClone(); root["map"] = "custom";
        root["custom_map"]!["mode"] = "v4";
        root["0"] = JsonNode.Parse("""{"production0":{"color":0,"rate":0.6,"ratio":0.35},"message":{"text":"hello"}}""");
        var replay = Read(root, compressed: true);
        Check(replay.Mode == "classic" && replay.SourceMode == "v4" && replay.LegacyProduction, "Legacy schema/rules not recognized");
        Check(replay.PlayerNames[0] == "Alice [Friend]" && replay.PlayerLabels[1][0] == "Боб", "String labels lost");
        Check(replay.Productions[0][0].Rate == 0.6 && replay.Productions[0][0].Ratio == 0.35, "Fractional production lost");
    }),
    ("future version and unfamiliar mode get a playback attempt", () => {
        var root = Fixture(); root["version"] = "99.3-preview"; root["mode"] = "future-mode";
        var replay = Read(root);
        Check(replay.Mode == "classic" && replay.ApproximateRules && replay.Version == "99.3-preview", "Version gate or missing provenance");
    }),
    ("flat and absent player metadata do not block playback", () => {
        var root = Fixture(); root["player_usernames"] = JsonNode.Parse("""["Alice",{"username":"Bob","title":"General"}]""");
        var replay = Read(root);
        Check(replay.PlayerLabels[0][0] == "Alice" && replay.PlayerLabels[1][0] == "Bob [General]", "Flat names lost");
        root["player_usernames"] = null;
        Check(Read(root).Units.Count == 2, "Optional metadata blocked replay");
    }),
    ("modern commands keep explicit unit selection", () => {
        var root = Fixture(); root["version"] = "1.4.1"; root["mode"] = "experiment";
        root["0"] = JsonNode.Parse("""{"production":{"color":1,"production_rate":0.8,"production_type":"motorised"}}""");
        var replay = Read(root);
        var economy = new ReferenceEconomy(replay, new ReferenceTerritory(replay));
        economy.SetProduction(replay.Productions[0][0]);
        Check(!replay.LegacyProduction && economy.ProductionTypes[1] == "motorised" && economy.ProductionRatios[1] == null, "Modern production changed");
    }),
    ("map IDs still explain the missing deployment", () => {
        var root = Fixture(); root["map"] = 44;
        try { Read(root); throw new Exception("Accepted a missing deployment"); }
        catch (FormatException error) { Check(error.Message.Contains("map number (44)") && error.Message.Contains("starting units"), "Unhelpful map error"); }
    }),
    ("numbered Fahero 24 uses the classic unit types and original IDs", () => {
        var root = Fixture(); root["map"] = 24; root["mode"] = "1v1"; root["version"] = "1.4.1";
        var replay = Read(root);
        Check(replay.Mode == "classic" && replay.Units.Count == 50, "Wrong classic profile/deployment");
        Check(replay.Map.Infantry.All(side => side.Count == 18) && replay.Map.Motorised.All(side => side.Count == 0), "Experimental roster leaked into classic");
        foreach (var (id, x, y, type) in new[] { (2,609,552,"infantry"), (17,533,413,"infantry"), (18,663,476,"tank"), (25,608,300,"infantry"), (42,775,309,"infantry"), (49,801,447,"tank") })
            Check(replay.Units[id].Type == type && replay.Units[id].Position == new Vec(x,y), $"Wrong classic unit {id}");
        Check(replay.Map.Cities.Count == 10 && replay.Map.Capitals.SequenceEqual(new[] {2,5}), "Map geometry missing");
    }),
    ("string map ID 24 resolves experimental separately", () => {
        var root = Fixture(); root["map"] = "24"; root["mode"] = "experiment"; root["version"] = "1.4.1";
        var replay = Read(root);
        Check(replay.Experimental && replay.Units.Count == 50, "Experimental map not resolved");
        Check(replay.Units[21].Type == "motorised" && replay.Units[21].Position == new Vec(533,413), "Wrong experimental unit IDs");
        Check(replay.Map.Infantry.All(side => side.Count == 14), "Classic roster leaked into experimental");
    }),
    ("numbered-map recovery also covers other roster sizes", () => {
        foreach (var (id, count) in new[] { (1,60), (16,40), (32,38) }) {
            var root = Fixture(); root["map"] = id; root["mode"] = "1v1";
            var replay = Read(root);
            Check(replay.Units.Count == count && !replay.Experimental, $"Wrong classic layout for map {id}");
        }
    }),
    ("explicit custom deployment wins over a known numeric ID", () => {
        var root = Fixture(); root["custom_map"] = root["map"]!.DeepClone(); root["map"] = 24;
        Check(Read(root).Units.Count == 2, "Catalog replaced a custom deployment");
    }),
    ("team format shares classic deployments across the catalog without losing teammates", () => {
        foreach (int id in Enumerable.Range(1,32).Where(id => id != 29)) {
            var root = Fixture(); root["map"] = id; root["mode"] = "1v1";
            var classic = Read(root);
            root["mode"] = "experiment"; var experimental = Read(root);
            root["mode"] = "2v2";
            root["player_usernames"] = JsonNode.Parse("""[["Alice","Friend"],["Bob","Teammate"]]""");
            var team = Read(root);
            root["mode"] = "1v1"; var again = Read(root);
            Check(team.Mode == "classic" && team.SourceMode == "2v2" && team.SideCount == 2, $"Team format rejected for map {id}");
            Check(team.PlayerLabels[0].Length == 2 && team.PlayerLabels[1].Length == 2, "Teammates were lost");
            var expected = classic.Units.Select(unit => (unit.Id, unit.Type, unit.Position)).ToArray();
            Check(team.Units.Select(unit => (unit.Id, unit.Type, unit.Position)).SequenceEqual(expected)
                && again.Units.Select(unit => (unit.Id, unit.Type, unit.Position)).SequenceEqual(expected), $"Mode lookup changed classic IDs on map {id}");
            Check(experimental.Experimental, $"Experimental profile lost on map {id}");
        }
    }),
    ("map and mode formatting does not change deployment or rules", () => {
        var root = Fixture(); root["map"] = " 013 "; root["mode"] = " 2V2 ";
        Check(Read(root).Units.Count == 60 && Read(root).Mode == "classic", "Formatted team mode rejected");
        root["mode"] = " Experiment ";
        Check(Read(root).Experimental, "Mode normalization differs between lookup and simulation");
    }),
    ("two-side catalog is not silently reused for four-color mode", () => {
        var root = Fixture(); root["map"] = 24; root["mode"] = "v4";
        try { Read(root); throw new Exception("Applied a two-side deployment to four colors"); }
        catch (FormatException error) { Check(error.Message.Contains("map and mode"), "Missing mode-specific explanation"); }
    }),
    ("invalid zone indices do not prevent playback", () => {
        var root = Fixture(); root["0"] = JsonNode.Parse("""{"production":{"color":0,"zone":[0,-1,99,0]}}""");
        Check(Read(root).Productions[0][0].Zone!.SequenceEqual(new[] { 0 }), "Zone was not normalized");
    }),
    ("legacy slider extremes and fractional mixture", () => {
        double NoDraw() => throw new Exception("Endpoint consumed RNG");
        Check(ReferenceEconomy.ChooseLegacyType(1, NoDraw) == "infantry", "Light endpoint");
        Check(ReferenceEconomy.ChooseLegacyType(0, NoDraw) == "tank", "Heavy endpoint");
        Check(ReferenceEconomy.ChooseLegacyType(.35, () => .2) == "infantry", "Fractional infantry");
        Check(ReferenceEconomy.ChooseLegacyType(.35, () => .4) == "tank", "Fractional tank");
    }),
    ("mixed production retains its queue while blocked and spends the spawned type's price", () => {
        var replay = Read(Fixture()); var economy = new ReferenceEconomy(replay, new ReferenceTerritory(replay));
        economy.CityGroups[0].Add([0]); economy.Funds[0] = 1000;
        economy.SetProduction(new Production(0, "infantry", 1, Ratio: .35));
        var initial = replay.Units.Count; int draws = 0;
        double Draw() { draws++; return .7; }
        // First queued unit is infantry; the successful birth selects a tank next.
        economy.Produce(Draw);
        Check(replay.Units.Count == initial + 1 && replay.Units[^1].Type == "infantry", "Wrong queued birth");
        Check(economy.Funds[0] == 800 && economy.ProductionTypes[0] == "tank", "Wrong price/next type");
        economy.Produce(Draw);
        Check(replay.Units.Count == initial + 1 && economy.Funds[0] == 800 && draws == 3, "Blocked attempt spent funds or rerolled type");
        replay.Units[^1].Position = new Vec(300, 450);
        economy.Produce(Draw);
        Check(replay.Units[^1].Type == "tank" && economy.Funds[0] == 400, "Tank queue not preserved");
    }),
    ("missing-unit orders defer, latest order wins, no invented unit", () => {
        var root = Fixture(); root["0"] = JsonNode.Parse("""{"2":[[200,450],[400,450]]}""");
        root["1"] = JsonNode.Parse("""{"2":[[200,450],[500,450]]}"""); root["end"] = 3;
        var replay = Read(root); var sim = new Simulator(replay);
        sim.Run(Options.Parse(["--no-combat"]), frame => {
            if (frame == 2) {
                Check(replay.Units.Count == 2 && sim.DeferredOrderCount == 2, "Orders created units or stopped playback");
                replay.Units.Add(new Unit(2, 0, "infantry", new Vec(200,450), 100));
            }
        });
        Check(sim.PendingOrderCount == 0 && replay.Units[2].Path[^1].X == 500, "Deferred latest order not applied");
    }),
};
foreach (var (name, test) in tests) { test(); Console.WriteLine($"PASS {name}"); }
Console.WriteLine($"{tests.Length} replay compatibility tests passed.");

static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
static JsonObject Fixture() => JsonNode.Parse(JsonSerializer.Serialize(new {
    version = "1.3.4", end = 0,
    player_usernames = new[] { new[] { "Alice [Friend]" }, new[] { "Боб" } },
    map = new {
        path = Path.GetFullPath("engine/repsim/maps/map1.png"),
        infantry = new[] { new[] { new[] { 100, 450 } }, new[] { new[] { 1500, 450 } } },
        cities = new[] { new[] { 200, 450 }, new[] { 1400, 450 } }, capitals = new[] { 0, 1 }
    }
}))!.AsObject();
static Replay Read(JsonObject root, bool compressed = false) {
    string path = Path.GetTempFileName();
    try {
        var bytes = System.Text.Encoding.UTF8.GetBytes(root.ToJsonString());
        if (compressed) { using var file = File.Create(path); using var gzip = new GZipStream(file, CompressionLevel.Fastest); gzip.Write(bytes); }
        else File.WriteAllBytes(path, bytes);
        return Replay.Read(path);
    } finally { File.Delete(path); }
}
