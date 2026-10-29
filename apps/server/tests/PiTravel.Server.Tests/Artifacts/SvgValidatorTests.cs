using PiTravel.Server.Artifacts;

namespace PiTravel.Server.Tests.Artifacts;

/// <summary>
/// Locks SVG extraction, validation, sanitization, and placeholder rendering to
/// <c>apps/server/src/svg/validate.ts</c> and <c>apps/server/src/svg/placeholder.ts</c>.
/// </summary>
public sealed class SvgValidatorTests
{
    [Fact]
    public void ExtractsFencedSvgBlock()
    {
        const string raw = """
            Here is the sketch:
            ```svg
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="10" cy="10" r="5"/></svg>
            ```
            """;

        var extracted = SvgValidator.Extract(raw);

        Assert.NotNull(extracted);
        Assert.StartsWith("<svg", extracted, StringComparison.Ordinal);
        Assert.EndsWith("</svg>", extracted, StringComparison.Ordinal);
        Assert.True(SvgValidator.ValidateAndSanitize(raw).Ok);
    }

    [Fact]
    public void ExtractsRawSvgWithXmlDeclaration()
    {
        const string raw = """
            <?xml version="1.0" encoding="UTF-8"?>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="1" cy="1" r="1"/></svg>
            """;

        var extracted = SvgValidator.Extract(raw);

        Assert.NotNull(extracted);
        Assert.DoesNotContain("<?xml", extracted, StringComparison.OrdinalIgnoreCase);
        Assert.StartsWith("<svg", extracted, StringComparison.Ordinal);
        Assert.True(SvgValidator.ValidateAndSanitize(raw).Ok);
    }

    [Fact]
    public void ReturnsNullWhenNoSvgPresent()
    {
        Assert.Null(SvgValidator.Extract("No illustration available."));

        var check = SvgValidator.ValidateAndSanitize("No illustration available.");
        Assert.False(check.Ok);
        Assert.Null(check.Svg);
        Assert.Equal("No SVG found in response", check.Reason);
    }

    [Fact]
    public void RejectsMissingViewBox()
    {
        var check = SvgValidator.ValidateAndSanitize("<svg width=\"100\" height=\"100\"></svg>");

        Assert.False(check.Ok);
        Assert.Equal("SVG must have a valid viewBox", check.Reason);
    }

    [Fact]
    public void RejectsViewBoxLargerThan1200x800()
    {
        var tooWide = SvgValidator.ValidateAndSanitize("<svg viewBox=\"0 0 1201 800\"></svg>");
        var tooTall = SvgValidator.ValidateAndSanitize("<svg viewBox=\"0 0 1200 801\"></svg>");

        Assert.False(tooWide.Ok);
        Assert.Equal("SVG viewBox must not exceed 1200x800", tooWide.Reason);
        Assert.False(tooTall.Ok);
        Assert.Equal("SVG viewBox must not exceed 1200x800", tooTall.Reason);
    }

    [Fact]
    public void RejectsMalformedXml()
    {
        var unclosed = SvgValidator.ValidateAndSanitize("<svg viewBox=\"0 0 10 10\"><rect>");
        var unquoted = SvgValidator.ValidateAndSanitize("<svg viewBox=\"0 0 100 100\" width=100></svg>");

        Assert.False(unclosed.Ok);
        Assert.StartsWith("Malformed SVG:", unclosed.Reason, StringComparison.Ordinal);
        Assert.False(unquoted.Ok);
        Assert.StartsWith("Malformed SVG:", unquoted.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void RemovesScriptElements()
    {
        const string raw = "<svg viewBox=\"0 0 100 100\"><script>alert(1)</script><SCRIPT>alert(2)</SCRIPT><circle cx=\"5\" cy=\"5\" r=\"2\"/></svg>";

        var check = SvgValidator.ValidateAndSanitize(raw);

        Assert.True(check.Ok);
        Assert.NotNull(check.Svg);
        Assert.DoesNotContain("<script", check.Svg, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("circle", check.Svg, StringComparison.Ordinal);
    }

    [Fact]
    public void RemovesEventAttributes()
    {
        const string raw = "<svg viewBox=\"0 0 100 100\" onload=\"alert(1)\"><rect width=\"10\" height=\"10\" onclick=\"evil()\" ONMOUSEOVER=\"evil()\"/></svg>";

        var check = SvgValidator.ValidateAndSanitize(raw);

        Assert.True(check.Ok);
        Assert.NotNull(check.Svg);
        Assert.DoesNotContain("onclick=", check.Svg, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("onload=", check.Svg, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("onmouseover=", check.Svg, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void RemovesExternalHrefButKeepsFragmentHref()
    {
        const string raw = """
            <svg viewBox="0 0 100 100" xmlns:xlink="http://www.w3.org/1999/xlink">
              <g id="g1"><circle cx="5" cy="5" r="2"/></g>
              <a href="https://evil"><text>link</text></a>
              <use href="#g1"/>
              <use xlink:href="https://evil/other"/>
              <use xlink:href="#g1"/>
            </svg>
            """;

        var check = SvgValidator.ValidateAndSanitize(raw);

        Assert.True(check.Ok);
        Assert.NotNull(check.Svg);
        Assert.DoesNotContain("https://evil", check.Svg, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("href=\"#g1\"", check.Svg, StringComparison.Ordinal);
    }

    [Fact]
    public void RemovesImageWithExternalHref()
    {
        const string raw = "<svg viewBox=\"0 0 100 100\"><image href=\"https://evil.test/a.png\" width=\"10\" height=\"10\"/><rect width=\"5\" height=\"5\"/></svg>";

        var check = SvgValidator.ValidateAndSanitize(raw);

        Assert.True(check.Ok);
        Assert.NotNull(check.Svg);
        Assert.DoesNotContain("<image", check.Svg, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("https://evil.test", check.Svg, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void RemovesForeignObject()
    {
        const string raw = "<svg viewBox=\"0 0 100 100\"><foreignObject width=\"50\" height=\"50\"><div>html</div></foreignObject><rect width=\"10\" height=\"10\"/></svg>";

        var check = SvgValidator.ValidateAndSanitize(raw);

        Assert.True(check.Ok);
        Assert.NotNull(check.Svg);
        Assert.DoesNotContain("foreignObject", check.Svg, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("<div>", check.Svg, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void PlaceholderEscapesXmlCharactersInTitle()
    {
        var svg = Placeholder.Build("Day 1 <山> & \"海\" '风'");

        Assert.Contains("Day 1 &lt;山&gt; &amp; &quot;海&quot; &apos;风&apos;", svg, StringComparison.Ordinal);
        Assert.True(SvgValidator.ValidateAndSanitize(svg).Ok);
    }
}
