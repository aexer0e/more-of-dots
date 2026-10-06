using System.Globalization;
using System.Text.Json;

namespace ReplaySim.Standalone;

// Terrain images do not contain unit IDs, types, cities or capitals. Number-only
// recordings need a deployment catalog as well as their PNG. Keep explicit map
// objects authoritative: custom scenarios may reuse an official terrain image.
internal static class BuiltInDeployments
{
    // Match format and simulation rules are separate: two teammates share each
    // color in 2v2, so its deployment is the same as a classic 1v1.
    internal static string NormalizeMode(string? mode) => mode?.Trim().ToLowerInvariant() ?? "";

    internal static string RulesMode(string? mode) => NormalizeMode(mode) switch
    {
        "experiment" => "experiment",
        "avalanche" => "avalanche",
        _ => "classic",
    };

    private static readonly Lazy<JsonElement> Catalog = new(() =>
    {
        using var stream = typeof(BuiltInDeployments).Assembly.GetManifestResourceStream("replay-deployments")
            ?? throw new InvalidOperationException("The built-in deployment catalog is missing.");
        using var document = JsonDocument.Parse(stream);
        return document.RootElement.Clone();
    });

    internal static bool TryResolve(JsonElement id, string? mode, out JsonElement map)
    {
        map = default;
        string? text = id.ValueKind switch
        {
            JsonValueKind.String => id.GetString(),
            JsonValueKind.Number => id.GetRawText(),
            _ => null,
        };
        if (!int.TryParse(text?.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out int number)) return false;
        // Special modes need their saved layout. A multi-color match may use
        // the classic catalog only when that roster has the requested colors.
        string? profile = NormalizeMode(mode) switch
        {
            "" or "1v1" or "2v2" or "classic" or "experiment" or "avalanche" => RulesMode(mode),
            "v3" or "v4" => "classic",
            _ => null,
        };
        if (profile is null || !Catalog.Value.TryGetProperty(number.ToString(CultureInfo.InvariantCulture), out var entry)
            || !entry.TryGetProperty(profile, out map)) return false;
        int requiredColors = NormalizeMode(mode) switch { "v3" => 3, "v4" => 4, _ => 0 };
        if (requiredColors > 0 && (!map.TryGetProperty("infantry", out var infantry)
            || infantry.GetArrayLength() != requiredColors))
        {
            map = default;
            return false;
        }
        return true;
    }
}
