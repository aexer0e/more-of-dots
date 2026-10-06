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
        economy.SetProduction(replay.Productions[0][0], () => throw new Exception("Modern command consumed RNG"));
        Check(!replay.LegacyProduction && economy.ProductionTypes[1] == "motorised" && economy.ProductionRatios[1] == null, "Modern production changed");
        var fields = JsonSerializer.SerializeToElement(economy.Output()).GetProperty("fields");
        Check(!fields.TryGetProperty("production_ratio", out _), "Legacy ratio diagnostics leaked into native modern economy fields");
    }),
    ("legacy economy preserves native initial ratio and field names", () => {
        var replay = Read(Fixture());
        var economy = new ReferenceEconomy(replay, new ReferenceTerritory(replay));
        Check(economy.ProductionRatios.All(ratio => ratio == 0.5), "Native legacy default is a half infantry/tank mixture");
        var fields = JsonSerializer.SerializeToElement(economy.Output()).GetProperty("fields");
        Check(fields.TryGetProperty("production_ratio", out _) && !fields.TryGetProperty("production_type", out _) && !fields.TryGetProperty("available_units", out _), "Modern-only fields leaked into legacy native state");
        Check(fields.GetProperty("price").EnumerateObject().Count() == 2, "Motorised price leaked into legacy native state");
    }),
    ("map IDs still explain the missing deployment", () => {
        var root = Fixture(); root["map"] = 999;
        try { Read(root); throw new Exception("Accepted a missing deployment"); }
        catch (FormatException error) { Check(error.Message.Contains("map number (999)") && error.Message.Contains("starting units"), "Unhelpful map error"); }
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
    ("native Zolamare maps preserve starting IDs and capital indices", () => {
        foreach (var (number, count, capitals, samples) in new[] {
            (42, 40, new[] {1,4}, new[] {(0,733,295,"infantry"),(16,792,466,"tank"),(20,843,418,"infantry"),(39,807,307,"tank")}),
            (35, 50, new[] {7,9}, new[] {(0,830,263,"infantry"),(20,598,648,"infantry"),(24,700,797,"tank"),(25,902,274,"infantry"),(49,877,286,"tank")})
        }) {
            var root = Fixture(); root["version"] = "1.2.23"; root["map"] = number; root["mode"] = "1v1";
            var replay = Read(root);
            Check(replay.Units.Count == count && replay.Map.Capitals.SequenceEqual(capitals), $"Wrong map {number} roster/capitals");
            foreach (var (id,x,y,type) in samples)
                Check(replay.Units[id].Position == new Vec(x,y) && replay.Units[id].Type == type, $"Wrong map {number} unit {id}");
        }
    }),
    ("bridge raster follows the game's pygame generation", () => {
        var root = Fixture(); root["map"] = 26; root["mode"] = "1v1"; root["version"] = "1.2.23";
        Check(Read(root).Map.Surface!.At(new Vec(675,313)) == TerrainKind.Bridge, "Classic pygame bridge endpoint");
        root["version"] = "1.4.1";
        Check(Read(root).Map.Surface!.At(new Vec(675,313)) == TerrainKind.Plains, "Pygame CE native bridge endpoint");
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
        int draws = 0;
        double Draw() { draws++; return .7; }
        Check(ReferenceEconomy.ChooseLegacyType(1, Draw) == "infantry", "Light endpoint");
        Check(ReferenceEconomy.ChooseLegacyType(0, Draw) == "tank", "Heavy endpoint");
        Check(draws == 2, "Native endpoint choices each consume RNG");
        Check(ReferenceEconomy.ChooseLegacyType(.35, () => .2) == "infantry", "Fractional infantry");
        Check(ReferenceEconomy.ChooseLegacyType(.35, () => .4) == "tank", "Fractional tank");
    }),
    ("legacy production commands reroll unchanged ratios, zones preserve RNG", () => {
        var replay = Read(Fixture()); var economy = new ReferenceEconomy(replay, new ReferenceTerritory(replay));
        int draws = 0;
        double Draw() { draws++; return draws == 1 ? .2 : .7; }
        economy.SetProduction(new Production(0, "", 1, Ratio: .35), Draw);
        Check(economy.ProductionQueue[0] == "infantry", "First slider selection");
        economy.SetProduction(new Production(0, "", .7, Ratio: .35), Draw);
        Check(economy.ProductionQueue[0] == "tank" && draws == 2, "Unchanged ratio did not reroll the queue");
        economy.SetProduction(new Production(0, "", 0, Zone: [0]), Draw);
        Check(economy.ProductionQueue[0] == "tank" && draws == 2, "Zone command changed queue or consumed RNG");
    }),
    ("legacy damage activates RNG draws for all living units", () => {
        var root = Fixture(); root["version"] = "1.2.23";
        var replay = Read(root);
        replay.Units.Add(new Unit(2, 0, "infantry", new Vec(800, 450), 100));
        replay.Units[0].DamageReceived = .08;
        int draws = 0;
        double Draw() { draws++; return .9; }
        ReferenceMovement.Step(replay, _ => .5, Draw);
        Check(draws == 3, "Historical RNG draws were restricted to damaged units");
        replay.Units[0].DamageReceived = 0;
        ReferenceMovement.Step(replay, _ => .5, Draw);
        Check(draws == 3, "Damage-free historical frame consumed RNG");
    }),
    ("historical mountain slide keeps native perimeter precision", () => {
        // Native June replay 0914efce, unit 24, frames 660 -> 661.
        var root = Fixture(); root["version"] = "1.2.18.3"; root["map"] = 31; root["mode"] = "1v1";
        var replay = Read(root);
        replay.Units.Clear();
        var unit = new Unit(0, 0, "tank", new Vec(1152.1141181803848, 50.93785177834481), 200);
        unit.Path = [new Vec(1111, 42)];
        replay.Units.Add(unit);
        ReferenceMovement.Step(replay, _ => .2, () => throw new Exception("Undamaged legacy tick consumed RNG"));
        Check(unit.Position == new Vec(1151.9377339275152, 50.843572430979606), "Mountain push/perimeter lost native precision");
    }),
    ("mountain normal preserves NumPy's selected-coordinate reduction", () => {
        // Native e3a15ea9, infantry 6, frames 7744 -> 7745. Eight selected
        // offsets expose a one-ULP difference from serial vector accumulation.
        var root = Fixture(); root["version"] = "1.2.18.3"; root["map"] = "19"; root["mode"] = "classic";
        var replay = Read(root); replay.Units.Clear();
        var unit = new Unit(0, 0, "infantry", new Vec(91.66203097355562,684.0899014956972), 100);
        unit.Path = [new Vec(137,751)]; replay.Units.Add(unit);
        ReferenceMovement.Step(replay, _ => .5, () => throw new Exception("Undamaged legacy tick consumed RNG"));
        Check(unit.Position == new Vec(91.51688863492839,684.5683716635633), "Native perimeter reduction lost one ULP");
    }),
    ("mountain projection divides before projecting the native scalar normal", () => {
        // Native 507f581e, tank 18, frame 9147. Recorded scalar hypot calls
        // expose both the push and projected slide without reconstructing them.
        var projected = ReferenceMovement.MountainProjection(
            new Vec(-0.2969848480983046, -0.04242640687118637),
            new Vec(-6.3479060193181285, -1.2626770142061488));
        Check(projected is not null, "Native mountain projection was skipped");
        var (slide,length,_) = projected!.Value;
        Check(slide == new Vec(-0.0031853712349619867, 0.01601394260660611), "Native projected vector differs");
        Check(length == 0.016327674289751057, "Native projected scalar hypot differs");
        Check(new Vec(577,429)+slide*(.3/length)==new Vec(576.9414729033952,429.294235584121), "Native slide position differs");
    }),
    ("mountain collision retry preserves native normalized direction", () => {
        // Native 5f2a4d69, tank 24, tick 8102. The initial friend check blocks
        // at radius 24, then the radius-22 retry accepts this forward step.
        var projected = ReferenceMovement.MountainProjection(
            new Vec(0.16505433159568383, 0.1129471895245473),
            new Vec(4.381494871788301, -3.5957999134012013));
        Check(projected is not null, "Native mountain retry projection was skipped");
        var (slide,length,direction) = projected!.Value;
        Check(slide == new Vec(0.12181538492155757,0.1484324759977742), "Native retry slide differs");
        Check(length == 0.19201871766683853, "Native retry scalar hypot differs");
        Check(new Vec(823.8573619719496,127.58317793760237)+direction*.2
            ==new Vec(823.9842406287822,127.73778002827493), "Native collision retry lost one ULP");
    }),
    ("historical retreat retains the native enemy centroid", () => {
        // Native June replay 0914efce, unit 11, frames 2184 -> 2185.
        var root = Fixture(); root["version"] = "1.2.18.3"; root["map"] = 31; root["mode"] = "1v1";
        var replay = Read(root); replay.Units.Clear();
        var unit = new Unit(0, 0, "infantry", new Vec(929, 60), 100) {
            Health = 92.39168244117664, Morale = 98.7300000000022, DamageReceived = .15812198609756645
        };
        replay.Units.Add(unit);
        replay.Units.Add(new Unit(1, 1, "tank", new Vec(963.6498353485159, 53.99324986866003), 200));
        ReferenceMovement.Step(replay, _ => .5, () => .01);
        Check(unit.Position == new Vec(928.2610217794175, 60.12810616497579), "Retreat centroid lost native precision");
    }),
    ("captured capital zeroes the first reported balance without spending reserve", () => {
        var root = Fixture(); root["version"] = "1.2.23";
        root["map"]!["cities"] = JsonNode.Parse("[[200,450],[1400,450],[1500,450]]");
        var replay = Read(root); var territory = new ReferenceTerritory(replay);
        var economy = new ReferenceEconomy(replay, territory);
        economy.Funds[1] = 123;
        territory.CityColors[1] = 0;
        territory.Update(replay.Units.Select(u => u.Id).ToHashSet());
        economy.Pay();
        Check(economy.CityGroups[1][0].Count > 0, "Fixture did not retain a productive region");
        Check(economy.Balances[1][0] == 0 && economy.Funds[1] == 123, "Missing-capital balance or reserve differed from native replay");
    }),
    ("historical city retreat compares the full probability", () => {
        // Native June replay 0914efce, unit 24, frames 3797 -> 3798.
        var root = Fixture(); root["version"] = "1.2.18.3"; root["map"] = 31; root["mode"] = "1v1";
        var replay = Read(root); replay.Units.Clear();
        var unit = new Unit(0, 0, "tank", new Vec(847, 66), 200) {
            Health = 181.98861048961405, Morale = 61.40000000000201, DamageReceived = .021930549076622476
        };
        replay.Units.Add(unit);
        replay.Units.Add(new Unit(1, 1, "tank", new Vec(881.0645024713372, 69.78201673072944), 200));
        ReferenceMovement.Step(replay, _ => .3, () => 2.5939662009477615e-6);
        Check(unit.Position == new Vec(846.5527481016339, 65.95034378782152), "Retreat probability was quantized before comparison");
    }),
    ("stale avalanche capital falls back to its side's first city", () => {
        // Original October replay c8113f04 stores capital 7 after its city list shrinks.
        var root=Fixture();root["version"]="1.4.1";root["mode"]="avalanche";
        root["map"]!["capitals"]=JsonNode.Parse("[0,7]");
        var replay=Read(root);var economy=new ReferenceEconomy(replay,new ReferenceTerritory(replay));
        Check(economy.Capitals.SequenceEqual(new[] {0,1}),"Stale capital did not resolve to an owned city");
        Check(economy.Funds.SequenceEqual(new double[] {0,15000}),"Avalanche setup funds changed");
    }),
    ("three-color numbered map retains the native roster", () => {
        // Original October replay 0599e04c uses the native map 103 in v3 mode.
        var root=Fixture();root["version"]="1.4.1";root["mode"]="v3";root["map"]="103";
        var replay=Read(root);
        Check(replay.SideCount==3 && replay.Units.Count==55 && replay.Map.Cities.Count==12,
            "Native three-color deployment was rejected or changed");
        Check(replay.Units[17].Position==new Vec(226,510) && replay.Units[37].Position==new Vec(964,383),
            "Three-color native unit order changed");
        Check(replay.Map.Capitals.SequenceEqual(new[] {1,7,10}),"Three-color map capital indices changed");
    }),
    ("numbered experimental map 45 preserves native motorised IDs", () => {
        // Original September replay 1e2f0ff9 has a separate experimental roster.
        var root=Fixture();root["version"]="1.4.1";root["mode"]="experiment";root["map"]="45";
        var replay=Read(root);
        Check(replay.Experimental && replay.Units.Count==46,"Experimental map roster changed");
        Check(replay.Units[20].Type=="motorised" && replay.Units[20].Position==new Vec(762,257)
            && replay.Units[43].Type=="motorised" && replay.Units[43].Position==new Vec(960,440),
            "Native motorised unit order changed");
    }),
    ("boundary rejection consumes the native attempted waypoint", () => {
        // Original October 0599e04c, frame 3096 -> 3097, plus native probes
        // of the same rule in the July 1.2.23 and 1.3.3 cores.
        var root=Fixture();root["version"]="1.4.1";root["map"]="103";root["mode"]="classic";
        foreach (bool nextLeg in new[] {false,true}) {
            var replay=Read(root);replay.Units.Clear();
            var unit=new Unit(0,0,"infantry",new Vec(161.62,12.03),100) {
                Health=72.954,Morale=99.01,Path=[new Vec(150,5)]
            };
            if (nextLeg) unit.Path.Add(new Vec(200,200));
            replay.Units.Add(unit);
            ReferenceMovement.Step(replay,_ => .5,() => .5);
            Check(unit.Position==new Vec(161.62,12.03) && unit.PathIndex==1 && unit.StuckTimer==1,
                "Boundary rejection moved the unit or retained its attempted waypoint");
        }
    }),
    ("eliminated side retains the native zero balance slot", () => {
        // Native June replay 442c34df loses its last red region at tick 34532.
        var root=Fixture();root["version"]="1.2.18.3";
        var replay=Read(root);var territory=new ReferenceTerritory(replay);
        var economy=new ReferenceEconomy(replay,territory);
        economy.Funds[1]=137;
        replay.Units[1].Health=0;replay.Units[1].Active=false;
        territory.CityColors[1]=0;
        territory.Update([replay.Units[0].Id]);
        economy.Pay();
        Check(economy.DotGroups[1].Count==0 && economy.CityGroups[1].Count==0,
            "Fixture retained an eliminated side's supply region");
        Check(economy.Balances[1].SequenceEqual(new double[] {0}) && economy.Funds[1]==137,
            "Eliminated side lost its native zero balance slot or reserve");
    }),
    ("historical retreat divides before scaling its escape waypoint", () => {
        // Native June replay 0914efce, unit 35, frames 5555 -> 5556.
        var root = Fixture(); root["version"] = "1.2.18.3"; root["map"] = 31; root["mode"] = "1v1";
        var replay = Read(root); replay.Units.Clear();
        var unit = new Unit(0, 1, "infantry", new Vec(930.6590227863416, 391.05379563563827), 100) {
            Health = 51.37959618663149, Morale = .05000000000127364, DamageReceived = .012659315166848435
        };
        replay.Units.Add(unit);
        replay.Units.Add(new Unit(1, 0, "infantry", new Vec(908.5989727606478, 364.81722645375044), 100));
        ReferenceMovement.Step(replay, _ => .5, () => .01);
        Check(unit.Position == new Vec(931.1416904456801, 391.6278443536306), "Escape waypoint operation order changed a native position");
    }),
    ("nearby mountain with no perimeter push keeps the forward proposal", () => {
        // Native June replay 0914efce, unit 30, frames 6797 -> 6798.
        var root = Fixture(); root["version"] = "1.2.18.3"; root["map"] = 31; root["mode"] = "1v1";
        var replay = Read(root); replay.Units.Clear();
        var unit = new Unit(0, 1, "infantry", new Vec(1101.1371279620544, 511.64073121173806), 100);
        unit.Path = [new Vec(1104, 528)]; replay.Units.Add(unit);
        ReferenceMovement.Step(replay, _ => .5, () => throw new Exception("Undamaged tick consumed RNG"));
        Check(unit.Position == new Vec(1101.2233181279305, 512.1332464453159) && unit.StuckTimer == 0, "Empty perimeter push blocked forward movement");
    }),
    ("historical collision retry uses the native hypot result", () => {
        // Native June replay 68170f63, unit 33, frames 470 -> 471.
        var root = Fixture(); root["version"] = "1.2.18.3"; root["map"] = 31; root["mode"] = "1v1";
        var replay = Read(root); replay.Units.Clear();
        var infantry = new Unit(0, 1, "infantry", new Vec(1361.415886968264,171.63543043944676), 100) {Path=[new Vec(1358,200)]};
        var tank = new Unit(1, 1, "tank", new Vec(1355.2555645771342,192.98012740510404), 200) {Path=[new Vec(1357,195)]};
        replay.Units.Add(infantry); replay.Units.Add(tank);
        ReferenceMovement.Step(replay, u => u.Type == "tank" ? .3 : .5, () => throw new Exception("Undamaged tick consumed RNG"));
        Check(infantry.Position == new Vec(1361.8962795904022,171.77407721580775), "Scalar tangent normalization lost native precision");
    }),
    ("scalar hypot matches native results on both sides of platform rounding", () => {
        Check(Simulator.PythonHypot(21.344696965657278,6.160322391129739)==22.21588756989901,"Native 68170f63 tangent length");
        Check(Simulator.PythonHypot(-20.89165037058467,-7.0565664831734125)==22.05121733007493,"Native f3bf6bf8 tangent length");
        Check(Simulator.PythonHypot(3,4)==5 && Simulator.PythonHypot(0,0)==0,"Exact scalar norm cases");
    }),
    ("retreat centroid preserves the native multi-enemy reduction", () => {
        // Native June replay 5e2f47a6, unit 29, frame 5821.
        var x = new double[52]; var y = new double[52];
        x[2]=726.2299298378151; x[13]=760.7106953022144; x[14]=739.4864827873632;
        y[2]=278.70041086975687; y[13]=253.5656656872756; y[14]=261.04606777662775;
        Check(Simulator.NativeMaskedMatrixSum(x,29)/3==742.1423693091309,"Three-enemy native x centroid");
        Check(Simulator.NativeMaskedMatrixSum(y,29)/3==264.4373814445534,"Three-enemy native y centroid");
        // Native 258a1e8d, frame 8993. A compensated sum rounds this down.
        x=new double[43];x[6]=702.9703021223644;x[13]=689.973435877384;x[16]=690.0857650660766;
        Check(Simulator.NativeMaskedMatrixSum(x,32)/3==694.3431676886084,"Four-row matrix reduction");
        Check(Simulator.NativeMaskedMatrixSum(x,42)/3==694.3431676886083,"Remaining-row matrix reduction");
    }),
    ("historical naval damage uses the authenticated June constants", () => {
        foreach (var (version,infLand,tankLand,infSea,tankSea) in new[] {
            ("1.2.18.3",.02,.1,.2,.05), ("1.2.23",.04,.16,.3,.1)
        }) {
            var root=Fixture();root["version"]=version;
            var replay=Read(root);var simulator=new Simulator(replay);
            var infantry=replay.Units[0];infantry.Ship=true;infantry.TargetId=1;
            var tank=new Unit(2,0,"tank",infantry.Position,200) {Ship=true,TargetId=1};replay.Units.Add(tank);
            Check(simulator.DamageFor(infantry)==infLand && simulator.DamageFor(tank)==tankLand, "Ship-to-land damage profile");
            replay.Units[1].Ship=true;
            Check(simulator.DamageFor(infantry)==infSea && simulator.DamageFor(tank)==tankSea, "Ship-to-ship damage profile");
        }
    }),
    ("rounded-position cores still compare retreat probability without quantizing", () => {
        // Native July replay 15b57632, unit 49, frames 6911 -> 6912.
        var root=Fixture();root["version"]="1.2.23";
        var replay=Read(root);replay.Units.Clear();
        var unit=new Unit(0,1,"tank",new Vec(567.15,694.42),200) {
            Health=159.505,Morale=62.23,DamageReceived=.138
        };
        replay.Units.Add(unit);
        replay.Units.Add(new Unit(1,0,"infantry",new Vec(533.95,702.71),100));
        replay.Units.Add(new Unit(2,0,"tank",new Vec(567.63,728.31),200));
        ReferenceMovement.Step(replay,_ => .3,() => .0959036978892982);
        Check(unit.Retreating && unit.HadObjective,"Rounding a valid retreat into a probability tie suppressed it");
    }),
    ("1.3 retreat probability and roll round to a strict tie", () => {
        // Original August core, d0d37247, unit 46, frames 4360 -> 4361.
        // Both native arrays round to .088901; the unit must stay in place.
        foreach (string version in new[] { "1.3.3", "1.3.4" }) {
            var root=Fixture();root["version"]=version;
            var replay=Read(root);replay.Units.Clear();
            var unit=new Unit(0,1,"tank",new Vec(960.52,593.51),200) {
                Health=135.395,Morale=.08,DamageReceived=.069
            };
            replay.Units.Add(unit);
            replay.Units.Add(new Unit(1,0,"tank",new Vec(932.77,573.46),200));
            ReferenceMovement.Step(replay,_ => .3,() => .08890081406570971);
            Check(!unit.Retreating && unit.Position==new Vec(960.52,593.51),
                "Native rounded retreat tie incorrectly moved the unit");
        }
    }),
    ("mixed production retains its queue while blocked and spends the spawned type's price", () => {
        var root = Fixture(); root["version"] = "1.2.23";
        var replay = Read(root); var economy = new ReferenceEconomy(replay, new ReferenceTerritory(replay));
        economy.CityGroups[0].Add([0]); economy.Funds[0] = 1000;
        economy.SetProduction(new Production(0, "infantry", 1, Ratio: .35), () => .2);
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
    ("1.3 blocked production consumes the reserved next-type roll", () => {
        var replay = Read(Fixture()); var economy = new ReferenceEconomy(replay, new ReferenceTerritory(replay));
        economy.CityGroups[0].Add([0]); economy.Funds[0] = 1000;
        economy.SetProduction(new Production(0, "", 1, Ratio: .35), () => .2);
        int draws = 0;
        double Draw() { draws++; return .7; }
        economy.Produce(Draw);
        Check(draws == 2 && economy.ProductionQueue[0] == "tank", "Successful birth queue selection");
        economy.Produce(Draw);
        Check(draws == 4 && economy.ProductionQueue[0] == "tank" && economy.Funds[0] == 800, "Blocked attempt skipped its roll or committed/spent production");
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
