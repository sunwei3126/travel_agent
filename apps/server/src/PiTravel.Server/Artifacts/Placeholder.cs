namespace PiTravel.Server.Artifacts;

/// <summary>
/// A neutral SVG shown when the model fails to produce a usable sketch.
/// Mirrors <c>placeholderSvg</c> in <c>apps/server/src/svg/placeholder.ts</c>.
/// </summary>
public static class Placeholder
{
    private const int Width = 1200;
    private const int Height = 800;

    public static string Build(string title)
    {
        var escaped = EscapeXml(title);
        return string.Concat(
            $"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {Width} {Height}\" width=\"{Width}\" height=\"{Height}\" role=\"img\" aria-label=\"{escaped}\">",
            $"<rect width=\"{Width}\" height=\"{Height}\" fill=\"#f3f4f6\"/>",
            $"<text x=\"{Width / 2}\" y=\"{Height / 2}\" text-anchor=\"middle\" font-family=\"sans-serif\" font-size=\"32\" fill=\"#6b7280\">{escaped}</text>",
            "</svg>");
    }

    private static string EscapeXml(string value) =>
        value
            .Replace("&", "&amp;", StringComparison.Ordinal)
            .Replace("<", "&lt;", StringComparison.Ordinal)
            .Replace(">", "&gt;", StringComparison.Ordinal)
            .Replace("\"", "&quot;", StringComparison.Ordinal)
            .Replace("'", "&apos;", StringComparison.Ordinal);
}
