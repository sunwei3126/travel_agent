using System.Globalization;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace PiTravel.Server.Artifacts;

/// <summary>
/// Result of validating and sanitizing a raw model response for an SVG document.
/// </summary>
public sealed record SvgCheck(bool Ok, string? Svg, string? Reason);

/// <summary>
/// Extracts, validates, and sanitizes model-generated SVG documents.
/// Mirrors <c>apps/server/src/svg/validate.ts</c>.
/// </summary>
public static class SvgValidator
{
    private const double MaxWidth = 1200;
    private const double MaxHeight = 800;

    private static readonly HashSet<string> RemovedElements = new(StringComparer.OrdinalIgnoreCase)
    {
        "script",
        "foreignobject",
        "iframe",
        "object",
        "embed",
    };

    private static readonly Regex FenceRegex = new(
        @"```(?:svg|xml)?[ \t]*\r?\n?([\s\S]*?)```",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex XmlDeclRegex = new(
        @"^\s*<\?xml[^>]*\?>",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex OpenSvgRegex = new(
        @"<svg(?=[\s/>])",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex CloseSvgRegex = new(
        @"</svg\s*>",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex ViewBoxSplitRegex = new(
        @"[\s,]+",
        RegexOptions.Compiled);

    private static readonly Regex LeadingFloatRegex = new(
        @"^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex ExternalCssUrlRegex = new(
        @"url\(\s*['""]?https?:",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>
    /// Pulls the SVG document out of a model response. Accepts raw <c>&lt;svg&gt;</c> blocks,
    /// <c>```svg</c> fenced blocks, and an optional leading XML declaration.
    /// </summary>
    public static string? Extract(string raw)
    {
        var text = raw.Trim();
        var fence = FenceRegex.Match(text);
        if (fence.Success)
        {
            text = fence.Groups[1].Value.Trim();
        }

        text = XmlDeclRegex.Replace(text, "", 1).Trim();

        var startMatch = OpenSvgRegex.Match(text);
        if (!startMatch.Success)
        {
            return null;
        }

        var start = startMatch.Index;
        var closingMatches = CloseSvgRegex.Matches(text);
        var end = closingMatches.Count > 0
            ? closingMatches[^1].Index + closingMatches[^1].Length
            : -1;

        var slice = end > start ? text[start..end] : text[start..];
        return slice.Trim();
    }

    /// <summary>
    /// Parses, validates, and sanitizes an SVG. The result is safe to embed: scripts,
    /// event handlers, and external references have been removed.
    /// </summary>
    public static SvgCheck ValidateAndSanitize(string raw)
    {
        var extracted = Extract(raw);
        if (string.IsNullOrEmpty(extracted))
        {
            return new SvgCheck(false, null, "No SVG found in response");
        }

        XDocument document;
        try
        {
            document = XDocument.Parse(extracted, LoadOptions.None);
        }
        catch (Exception ex)
        {
            return new SvgCheck(false, null, $"Malformed SVG: {ex.Message}");
        }

        var root = document.Root;
        if (root is null || !string.Equals(root.Name.LocalName, "svg", StringComparison.OrdinalIgnoreCase))
        {
            return new SvgCheck(false, null, "SVG root element is missing");
        }

        var viewBox = ParseViewBox(GetAttributeValue(root, "viewBox"));
        if (viewBox is null)
        {
            return new SvgCheck(false, null, "SVG must have a valid viewBox");
        }

        if (viewBox.Value.Width > MaxWidth || viewBox.Value.Height > MaxHeight)
        {
            return new SvgCheck(false, null, $"SVG viewBox must not exceed {MaxWidth}x{MaxHeight}");
        }

        var width = ParseLength(GetAttributeValue(root, "width"));
        var height = ParseLength(GetAttributeValue(root, "height"));
        if (width is > MaxWidth)
        {
            return new SvgCheck(false, null, $"SVG width must not exceed {MaxWidth}");
        }

        if (height is > MaxHeight)
        {
            return new SvgCheck(false, null, $"SVG height must not exceed {MaxHeight}");
        }

        Sanitize(document);

        return new SvgCheck(true, document.ToString(SaveOptions.DisableFormatting), null);
    }

    private static string? GetAttributeValue(XElement element, string localName) =>
        element.Attributes()
            .FirstOrDefault(a =>
                !a.IsNamespaceDeclaration &&
                string.Equals(a.Name.LocalName, localName, StringComparison.OrdinalIgnoreCase))
            ?.Value;

    private static (double Width, double Height)? ParseViewBox(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var parts = ViewBoxSplitRegex.Split(value.Trim());
        if (parts.Length != 4)
        {
            return null;
        }

        var numbers = new double[4];
        for (var i = 0; i < 4; i++)
        {
            if (parts[i].Length == 0 ||
                !double.TryParse(parts[i], NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) ||
                !double.IsFinite(parsed))
            {
                return null;
            }

            numbers[i] = parsed;
        }

        var width = numbers[2];
        var height = numbers[3];
        if (width <= 0 || height <= 0)
        {
            return null;
        }

        return (width, height);
    }

    private static double? ParseLength(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var match = LeadingFloatRegex.Match(value);
        if (!match.Success)
        {
            return null;
        }

        return double.TryParse(match.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) &&
               double.IsFinite(parsed)
            ? parsed
            : null;
    }

    private static void Sanitize(XDocument document)
    {
        foreach (var element in document.Descendants().ToList())
        {
            if (element.Document is null)
            {
                continue;
            }

            var tagName = element.Name.LocalName;
            if (RemovedElements.Contains(tagName))
            {
                element.Remove();
                continue;
            }

            var removeImage = false;
            foreach (var attribute in element.Attributes().ToList())
            {
                if (attribute.IsNamespaceDeclaration)
                {
                    continue;
                }

                var localName = attribute.Name.LocalName;
                var value = attribute.Value;

                if (localName.StartsWith("on", StringComparison.OrdinalIgnoreCase))
                {
                    attribute.Remove();
                    continue;
                }

                if (string.Equals(localName, "href", StringComparison.OrdinalIgnoreCase))
                {
                    if (!value.Trim().StartsWith('#'))
                    {
                        if (string.Equals(tagName, "image", StringComparison.OrdinalIgnoreCase))
                        {
                            removeImage = true;
                        }

                        attribute.Remove();
                    }

                    continue;
                }

                if (string.Equals(localName, "style", StringComparison.OrdinalIgnoreCase) &&
                    ExternalCssUrlRegex.IsMatch(value))
                {
                    attribute.Remove();
                }
            }

            if (removeImage)
            {
                element.Remove();
            }
        }
    }
}
