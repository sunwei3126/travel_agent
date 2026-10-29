namespace PiTravel.Server.Artifacts;

/// <summary>
/// Result of generating one day's SVG sketch; <see cref="Status"/> is <c>"ok"</c> or <c>"failed"</c>.
/// </summary>
public sealed record SketchResult(string Svg, string Status, string? Error = null);
