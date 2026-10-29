using PiTravel.Server.Contracts;

namespace PiTravel.Server.Artifacts;

/// <summary>
/// Generates a single day's SVG sketch with one validation retry and placeholder fallback.
/// Mirrors <c>generateDaySketch</c> in <c>apps/server/src/svg/generate.ts</c>.
/// </summary>
public static class SketchGenerator
{
    public static async Task<SketchResult> GenerateAsync(
        DayCard day,
        Func<string, CancellationToken, Task<string>> generate,
        CancellationToken ct = default)
    {
        var prompt = BuildPrompt(day);
        if (string.Equals(
                Environment.GetEnvironmentVariable("PITRAVEL_TEST_SVG_MODE"),
                "invalid",
                StringComparison.Ordinal))
        {
            return new SketchResult(
                Placeholder.Build($"Day {day.DayIndex} · {day.Title}"),
                "failed",
                "PITRAVEL_TEST_SVG_MODE=invalid");
        }

        var first = await AttemptAsync(generate, prompt, ct).ConfigureAwait(false);
        if (first.Ok)
        {
            return new SketchResult(first.Svg!, "ok");
        }

        var retryLines = new List<string>
        {
            prompt,
            "",
            $"The previous response was rejected: {first.Reason}",
        };
        if (first.Raw.Length > 0)
        {
            retryLines.Add("Previous response:");
            retryLines.Add(first.Raw);
            retryLines.Add("");
        }
        retryLines.Add("Return corrected SVG only.");

        var retryPrompt = string.Join("\n", retryLines);

        var second = await AttemptAsync(generate, retryPrompt, ct).ConfigureAwait(false);
        if (second.Ok)
        {
            return new SketchResult(second.Svg!, "ok");
        }

        return new SketchResult(
            Placeholder.Build($"Day {day.DayIndex} · {day.Title}"),
            "failed",
            second.Reason);
    }

    private static string BuildPrompt(DayCard day)
    {
        var stops = day.Blocks.Take(5).Select(block => $"- {block.Title}").ToList();
        var lines = new List<string>
        {
            "Create a single illustration for one day of a travel itinerary.",
            $"Day {day.DayIndex}: {day.Title}",
        };
        if (stops.Count > 0)
        {
            lines.Add("Highlights:");
            lines.AddRange(stops);
        }
        lines.Add("Return valid SVG only. Include an xmlns and a viewBox no larger than 1200x800.");
        lines.Add("Do not include scripts, event handlers, or external references.");

        return string.Join("\n", lines);
    }

    private static async Task<Attempt> AttemptAsync(
        Func<string, CancellationToken, Task<string>> generate,
        string prompt,
        CancellationToken ct)
    {
        string raw;
        try
        {
            raw = await generate(prompt, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            return new Attempt(
                false,
                null,
                "",
                string.IsNullOrEmpty(ex.Message) ? "Sketch generation failed" : ex.Message);
        }

        var validated = SvgValidator.ValidateAndSanitize(raw);
        if (!validated.Ok)
        {
            return new Attempt(false, null, raw, validated.Reason ?? "Invalid SVG");
        }

        return new Attempt(true, validated.Svg!, raw, null);
    }

    private sealed record Attempt(bool Ok, string? Svg, string Raw, string? Reason);
}
