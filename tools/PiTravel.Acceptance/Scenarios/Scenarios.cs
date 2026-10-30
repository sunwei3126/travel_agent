using Microsoft.Playwright;
using PiTravel.Server.Artifacts;
using PiTravel.Acceptance.Infrastructure;
using PiTravel.Server.Contracts;

namespace PiTravel.Acceptance.Scenarios;

/// <summary>A: a complete brief through the UI yields three sourced, budgeted day cards.</summary>
public static class CompleteBrief
{
    public static async Task<string> RunAsync(Stack stack, CancellationToken ct)
    {
        var page = stack.Browser.Page;
        var tripId = await UiDriver.CreateTripAsync(page, stack.Web.BaseUrl, stack.Evidence, "A");
        await UiDriver.SendAsync(page, UiDriver.CompleteBrief);
        stack.Evidence.Event("A", "brief sent; waiting for three day cards");
        await UiDriver.WaitForDayCardsAsync(page, 3, TimeSpan.FromMinutes(15));
        await WaitUntilSettledAsync(stack, tripId, ct);

        var cards = page.GetByTestId("day-card");
        var count = await cards.CountAsync();
        if (count < 3)
        {
            throw new InvalidOperationException($"Scenario A expected 3 cards, saw {count}.");
        }

        for (var index = 0; index < 3; index++)
        {
            var card = cards.Nth(index);
            if (await card.Locator("img.day-card-svg").CountAsync() == 0)
            {
                throw new InvalidOperationException($"Card {index + 1} has no SVG.");
            }

            if (await card.Locator(".source-chip").CountAsync() == 0)
            {
                throw new InvalidOperationException($"Card {index + 1} has no source chips.");
            }

            var cost = await card.Locator(".day-card-cost").InnerTextAsync();
            if (!cost.Contains('–', StringComparison.Ordinal) && !cost.Contains('-', StringComparison.Ordinal))
            {
                throw new InvalidOperationException($"Card {index + 1} has no cost range: {cost}");
            }

            await card.ScreenshotAsync(new() { Path = Path.Combine(stack.Evidence.Root, $"A-card-{index + 1}.png") });
        }

        await page.ScreenshotAsync(new()
        {
            Path = Path.Combine(stack.Evidence.Root, "A-trip.png"),
            FullPage = true,
        });

        var snapshot = await stack.Api.GetTripAsync(tripId, ct);
        await stack.Evidence.SaveSnapshotAsync("A-snapshot.json", snapshot);
        var budget = snapshot.Plan.Budget
            ?? throw new InvalidOperationException("Scenario A snapshot has no plan.budget.");
        if (budget.High > 3000)
        {
            throw new InvalidOperationException($"plan.budget.high is {budget.High}, expected <= 3000.");
        }

        if (!budget.WithinBudget)
        {
            throw new InvalidOperationException("plan.budget.withinBudget is false.");
        }

        stack.Evidence.Event("A", $"passed trip {tripId}, budget high {budget.High}");
        return tripId;
    }

    private static async Task WaitUntilSettledAsync(Stack stack, string tripId, CancellationToken ct)
    {
        var deadline = DateTimeOffset.UtcNow.AddMinutes(15);
        while (DateTimeOffset.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();
            var snapshot = await stack.Api.GetTripAsync(tripId, ct);
            var busy = snapshot.Running || await UiDriver.IsBusyAsync(stack.Browser.Page);
            if (!busy && snapshot.Plan.Days.Count >= 3 && snapshot.Plan.Budget is not null)
            {
                return;
            }

            await Task.Delay(2_000, ct);
        }

        throw new TimeoutException("Scenario A did not settle with three day cards and a budget.");
    }
}

/// <summary>B: an incomplete brief makes the assistant ask before any day is written.</summary>
public static class IncompleteBrief
{
    public static async Task RunAsync(Stack stack, CancellationToken ct)
    {
        var page = stack.Browser.Page;
        var tripId = await UiDriver.CreateTripAsync(page, stack.Web.BaseUrl, stack.Evidence, "B");
        await UiDriver.SendAsync(page, UiDriver.IncompleteBrief);
        stack.Evidence.Event("B", "incomplete brief sent; waiting for a question");
        await UiDriver.WaitForAssistantTextAsync(page, TimeSpan.FromMinutes(8));
        await WaitUntilIdleAsync(stack, tripId, ct);

        var snapshot = await stack.Api.GetTripAsync(tripId, ct);
        if (snapshot.Plan.Days.Count != 0)
        {
            throw new InvalidOperationException($"plan.days has {snapshot.Plan.Days.Count} entries; expected empty.");
        }

        var transcript = await stack.Api.GetTranscriptAsync(tripId, ct);
        var asked = false;
        foreach (var entry in transcript.EnumerateArray())
        {
            if (entry.TryGetProperty("role", out var role)
                && role.GetString() == "assistant"
                && entry.TryGetProperty("content", out var content)
                && content.GetString() is { Length: > 0 } text
                && (text.Contains('？') || text.Contains('?')))
            {
                asked = true;
            }
        }

        if (!asked)
        {
            throw new InvalidOperationException("Assistant did not ask a question before planning.");
        }

        await page.ScreenshotAsync(new()
        {
            Path = Path.Combine(stack.Evidence.Root, "B-clarification.png"),
            FullPage = true,
        });
        await stack.Evidence.SaveSnapshotAsync("B-snapshot.json", snapshot);
        stack.Evidence.Event("B", "passed; assistant asked and plan.days is empty");
    }

    private static async Task WaitUntilIdleAsync(Stack stack, string tripId, CancellationToken ct)
    {
        var deadline = DateTimeOffset.UtcNow.AddMinutes(8);
        while (DateTimeOffset.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();
            if (!await stack.Api.IsRunningAsync(tripId, ct) && !await UiDriver.IsBusyAsync(stack.Browser.Page))
            {
                return;
            }

            await Task.Delay(1_000, ct);
        }

        throw new TimeoutException("Scenario B did not become idle.");
    }
}

/// <summary>C: killing the server mid-research resumes the same run without losing completed attempts.</summary>
public static class CrashResume
{
    public static async Task RunAsync(Stack stack, CancellationToken ct)
    {
        var page = stack.Browser.Page;
        var tripId = await UiDriver.CreateTripAsync(page, stack.Web.BaseUrl, stack.Evidence, "C");
        await UiDriver.SendAsync(page, UiDriver.CompleteBrief);
        stack.Evidence.Event("C", "waiting for research to start");
        var before = await WaitForResearchAsync(stack, tripId, ct);
        await stack.Evidence.SaveSnapshotAsync("C-before.json", before);

        stack.Server.Kill();
        stack.Evidence.Event("C", "server killed; restarting against the same DATA_DIR");
        await stack.Server.StartAsync(ct);
        await page.ReloadAsync(new() { WaitUntil = WaitUntilState.NetworkIdle });
        await page.GetByLabel("旅行助手").WaitForAsync();

        TripSnapshot? after = null;
        var deadline = DateTimeOffset.UtcNow.AddMinutes(15);
        while (DateTimeOffset.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();
            var snapshot = await stack.Api.GetTripAsync(tripId, ct);
            if (!snapshot.Running && snapshot.Plan.Days.Count >= 3)
            {
                after = snapshot;
                break;
            }
            await Task.Delay(2_000, ct);
        }

        if (after is null)
            throw new TimeoutException("Restarted run did not complete with three day cards.");

        await stack.Evidence.SaveSnapshotAsync("C-after.json", after);
        CheckAttempts("search", before.Research.SearchAttempts, after.Research.SearchAttempts);
        CheckAttempts("fetch", before.Research.FetchAttempts, after.Research.FetchAttempts);
        await UiDriver.WaitForDayCardsAsync(page, 3, TimeSpan.FromMinutes(1));
        await page.ScreenshotAsync(new() { Path = Path.Combine(stack.Evidence.Root, "C-resumed.png"), FullPage = true });
        stack.Evidence.Event("C", "passed; run completed and committed attempts were not repeated");
    }

    private static async Task<TripSnapshot> WaitForResearchAsync(Stack stack, string tripId, CancellationToken ct)
    {
        var deadline = DateTimeOffset.UtcNow.AddMinutes(8);
        while (DateTimeOffset.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();
            var snapshot = await stack.Api.GetTripAsync(tripId, ct);
            var attempts = (snapshot.Research.SearchAttempts?.Count ?? 0) + (snapshot.Research.FetchAttempts?.Count ?? 0);
            if (snapshot.Running && attempts > 0 && snapshot.Plan.Days.Count < 3)
            {
                return snapshot;
            }

            await Task.Delay(1_000, ct);
        }

        throw new TimeoutException("Research did not start.");
    }

    private static void CheckAttempts(string kind, IReadOnlyDictionary<string, int>? before, IReadOnlyDictionary<string, int>? after)
    {
        foreach (var (key, count) in before ?? new Dictionary<string, int>())
        {
            var actual = after is not null && after.TryGetValue(key, out var value) ? value : -1;
            if (actual != count)
                throw new InvalidOperationException($"Committed {kind} attempt {key} changed after restart (before {count}, after {actual}).");
        }
        foreach (var (key, count) in after ?? new Dictionary<string, int>())
        {
            if ((before is null || !before.ContainsKey(key)) && count > 1)
                throw new InvalidOperationException($"New {kind} attempt {key} was committed {count} times.");
        }
    }
}

/// <summary>D: reloading mid-run keeps the chat rows and day-card count.</summary>
public static class RefreshRecovery
{
    public static async Task RunAsync(Stack stack, CancellationToken ct)
    {
        var page = stack.Browser.Page;
        var tripId = await UiDriver.CreateTripAsync(page, stack.Web.BaseUrl, stack.Evidence, "D");
        await UiDriver.SendAsync(page, UiDriver.CompleteBrief);
        stack.Evidence.Event("D", "waiting for a card during the active run");
        var deadline = DateTimeOffset.UtcNow.AddMinutes(15);
        TripSnapshot? before = null;
        while (DateTimeOffset.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();
            var current = await stack.Api.GetTripAsync(tripId, ct);
            if (current.Running && current.Plan.Days.Count > 0
                && await page.GetByTestId("day-card").CountAsync() > 0
                && await page.Locator(".chat-message-user").CountAsync() > 0)
            {
                before = current;
                break;
            }
            await Task.Delay(1_000, ct);
        }
        if (before is null) throw new TimeoutException("No rendered card appeared during the active run.");

        var userText = await page.Locator(".chat-message-user").First.InnerTextAsync();
        var assistantTexts = (await page.Locator(".chat-message-assistant .chat-bubble").AllInnerTextsAsync())
            .Where(text => !string.IsNullOrWhiteSpace(text)).ToArray();
        var blockTitles = (await page.Locator(".day-card .day-block strong").AllInnerTextsAsync())
            .Where(text => !string.IsNullOrWhiteSpace(text)).ToArray();
        var titles = before.Plan.Days.Select(day => day.Title).ToArray();
        await stack.Evidence.SaveSnapshotAsync("D-before.json", before);
        await page.ReloadAsync(new() { WaitUntil = WaitUntilState.NetworkIdle });
        await page.GetByLabel("旅行助手").WaitForAsync();
        await page.GetByText(userText, new() { Exact = true }).First.WaitForAsync(new() { Timeout = 60_000 });
        foreach (var text in assistantTexts)
            await page.Locator(".chat-message-assistant .chat-bubble").Filter(new() { HasText = text })
                .First.WaitForAsync(new() { Timeout = 60_000 });
        foreach (var title in titles)
            await page.GetByTestId("day-card").GetByRole(AriaRole.Heading, new() { Name = title, Exact = true })
                .First.WaitForAsync(new() { Timeout = 60_000 });
        foreach (var title in blockTitles)
            await page.Locator(".day-card .day-block strong").Filter(new() { HasText = title })
                .First.WaitForAsync(new() { Timeout = 60_000 });

        var snapshot = await stack.Api.GetTripAsync(tripId, ct);
        foreach (var day in before.Plan.Days)
        {
            var restored = snapshot.Plan.Days.FirstOrDefault(item => item.DayIndex == day.DayIndex);
            if (restored is null || restored.Title != day.Title)
                throw new InvalidOperationException($"Day {day.DayIndex} was lost or changed during refresh.");
        }
        await page.ScreenshotAsync(new() { Path = Path.Combine(stack.Evidence.Root, "D-reloaded.png"), FullPage = true });
        await stack.Evidence.SaveSnapshotAsync("D-snapshot.json", snapshot);
        stack.Evidence.Event("D", "passed; user message and existing card titles restored");
    }
}

/// <summary>E: the invalid-SVG switch shows the placeholder and keeps redraw usable.</summary>
public static class SvgFallback
{
    public static async Task RunAsync(Stack stack, CancellationToken ct)
    {
        var page = stack.Browser.Page;
        var tripId = await UiDriver.CreateTripAsync(page, stack.Web.BaseUrl, stack.Evidence, "E");
        await UiDriver.SendAsync(page, UiDriver.CompleteBrief);
        stack.Evidence.Event("E", "waiting for a failed sketch");
        TripSnapshot? failed = null;
        var deadline = DateTimeOffset.UtcNow.AddMinutes(15);
        while (DateTimeOffset.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();
            var snapshot = await stack.Api.GetTripAsync(tripId, ct);
            if (!snapshot.Running && snapshot.Plan.Days.Any(day => day.SvgStatus == "failed"))
            {
                failed = snapshot;
                break;
            }

            await Task.Delay(2_000, ct);
        }

        if (failed is null)
        {
            throw new TimeoutException("No day card reached svgStatus failed.");
        }

        var day = failed.Plan.Days.First(item => item.SvgStatus == "failed");
        var expected = Placeholder.Build($"Day {day.DayIndex} · {day.Title}");
        if (day.Svg != expected) throw new InvalidOperationException("Failed sketch is not the expected placeholder.");
        var card = page.GetByTestId("day-card").Filter(new() { Has = page.GetByRole(AriaRole.Heading, new() { Name = day.Title, Exact = true }) });
        var redraw = card.GetByRole(AriaRole.Button, new() { Name = "重画" });
        await redraw.WaitForAsync(new() { Timeout = 60_000 });
        var src = await card.Locator("img.day-card-svg").GetAttributeAsync("src");
        var expectedSrc = "data:image/svg+xml;base64," + Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(expected));
        if (src != expectedSrc) throw new InvalidOperationException("Rendered SVG does not match the failed card's placeholder.");

        await page.ScreenshotAsync(new() { Path = Path.Combine(stack.Evidence.Root, "E-placeholder.png"), FullPage = true });
        await stack.Evidence.SaveSnapshotAsync("E-snapshot.json", failed);
        var request = $"请重画第 {day.DayIndex} 天的草图，其他天不要动。";
        var priorTranscript = await stack.Api.GetTranscriptAsync(tripId, ct);
        var priorIds = priorTranscript.EnumerateArray().Select(entry => entry.GetProperty("id").GetString()).ToHashSet();
        var prior = await page.GetByText(request, new() { Exact = true }).CountAsync();
        await redraw.ClickAsync();
        await page.GetByText(request, new() { Exact = true }).Nth(prior).WaitForAsync(new() { Timeout = 60_000 });
        var redrawDeadline = DateTimeOffset.UtcNow.AddMinutes(15);
        DayCard? redrawn = null;
        while (DateTimeOffset.UtcNow < redrawDeadline)
        {
            ct.ThrowIfCancellationRequested();
            var transcript = await stack.Api.GetTranscriptAsync(tripId, ct);
            var entries = transcript.EnumerateArray().ToArray();
            var callIds = entries.Where(entry => !priorIds.Contains(entry.GetProperty("id").GetString())
                    && entry.TryGetProperty("toolCalls", out var calls) && calls.ValueKind == System.Text.Json.JsonValueKind.Array)
                .SelectMany(entry => entry.GetProperty("toolCalls").EnumerateArray().ToArray())
                .Where(call => call.GetProperty("function").GetProperty("name").GetString() == "sketch_day")
                .Where(call => System.Text.Json.JsonDocument.Parse(call.GetProperty("function").GetProperty("arguments").GetString()!).RootElement
                    .GetProperty("dayIndex").GetInt32() == day.DayIndex)
                .Select(call => call.GetProperty("id").GetString()).ToHashSet();
            var completed = entries.Any(entry => entry.TryGetProperty("toolCallId", out var id)
                && callIds.Contains(id.GetString()) && entry.GetProperty("role").GetString() == "tool"
                && (!entry.TryGetProperty("error", out var error) || error.ValueKind == System.Text.Json.JsonValueKind.Null)
                && entry.GetProperty("content").GetString() == $"Sketch for day {day.DayIndex} is failed.");
            var current = await stack.Api.GetTripAsync(tripId, ct);
            if (completed && !current.Running)
            {
                redrawn = current.Plan.Days.FirstOrDefault(item => item.DayIndex == day.DayIndex);
                await stack.Evidence.SaveSnapshotAsync("E-redrawn.json", current);
                await stack.Evidence.SaveJsonAsync("E-redraw-transcript.json", transcript);
                break;
            }
            await Task.Delay(2_000, ct);
        }
        if (redrawn is null || redrawn.SvgStatus != "failed" || redrawn.Svg != Placeholder.Build($"Day {redrawn.DayIndex} · {redrawn.Title}"))
            throw new InvalidOperationException("Redraw did not complete with a new failed placeholder.");
        await redraw.WaitForAsync(new() { Timeout = 60_000 });
        stack.Evidence.Event("E", "passed; placeholder rendered and redraw completed with the injected failure");
    }
}

/// <summary>F: asking to ease day 3 changes only that card's updatedAt.</summary>
public static class TargetedEdit
{
    public static async Task RunAsync(Stack stack, string tripId, CancellationToken ct)
    {
        var page = stack.Browser.Page;
        await page.GotoAsync($"{stack.Web.BaseUrl}/trips/{tripId}", new() { WaitUntil = WaitUntilState.NetworkIdle });
        var before = await stack.Api.GetTripAsync(tripId, ct);
        var day3 = before.Plan.Days.FirstOrDefault(day => day.DayIndex == 3)
            ?? throw new InvalidOperationException("Scenario F needs A's day 3.");
        var beforeJson = await stack.Api.GetTripJsonAsync(tripId, ct);
        var day1Before = DayJson(beforeJson, 1).GetRawText();
        var day2Before = DayJson(beforeJson, 2).GetRawText();
        await stack.Evidence.SaveTextAsync("F-day-1-before.json", day1Before);
        await stack.Evidence.SaveTextAsync("F-day-2-before.json", day2Before);

        await UiDriver.SendAsync(page, "第三天轻松一点");
        stack.Evidence.Event("F", "edit sent; waiting for day 3 to change");
        var deadline = DateTimeOffset.UtcNow.AddMinutes(15);
        TripSnapshot? after = null;
        while (DateTimeOffset.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();
            var snapshot = await stack.Api.GetTripAsync(tripId, ct);
            var updated = snapshot.Plan.Days.FirstOrDefault(day => day.DayIndex == 3);
            if (updated is not null && updated.UpdatedAt != day3.UpdatedAt && !snapshot.Running)
            {
                after = snapshot;
                break;
            }

            await Task.Delay(2_000, ct);
        }

        if (after is null)
        {
            throw new TimeoutException("Day 3 updatedAt did not change.");
        }
        var raw = await stack.Api.GetTripJsonAsync(tripId, ct);
        if (DayJson(raw, 1).GetRawText() != day1Before || DayJson(raw, 2).GetRawText() != day2Before)
        {
            var changed = DayJson(raw, 1).GetRawText() != day1Before ? 1 : 2;
            throw new InvalidOperationException($"Day {changed} changed; expected byte-for-byte unchanged.");
        }

        if (after.Plan.Days.Where(day => day.DayIndex != 3).Any(day =>
                before.Plan.Days.First(other => other.DayIndex == day.DayIndex).UpdatedAt != day.UpdatedAt))
        {
            throw new InvalidOperationException("A day other than day 3 changed updatedAt.");
        }

        await page.ScreenshotAsync(new() { Path = Path.Combine(stack.Evidence.Root, "F-edited.png"), FullPage = true });
        await stack.Evidence.SaveSnapshotAsync("F-snapshot.json", after);
        stack.Evidence.Event("F", "passed; only day 3 changed");
    }

    private static System.Text.Json.JsonElement DayJson(System.Text.Json.JsonElement snapshot, int dayIndex)
    {
        foreach (var day in snapshot.GetProperty("plan").GetProperty("days").EnumerateArray())
        {
            if (day.GetProperty("dayIndex").GetInt32() == dayIndex)
            {
                return day.Clone();
            }
        }

        throw new InvalidOperationException($"Day {dayIndex} is missing.");
    }
}

/// <summary>G: every verified fact in A's snapshot cites a source that exists.</summary>
public static class Citations
{
    public static async Task RunAsync(Stack stack, string tripId, CancellationToken ct)
    {
        var snapshot = await stack.Api.GetTripAsync(tripId, ct);
        var missing = new List<string>();
        foreach (var day in snapshot.Plan.Days)
        {
            foreach (var claim in day.Scenery.Concat(day.Food).Concat(day.Transport).Concat(day.Blocks.SelectMany(block => block.Claims)))
            {
                if (claim.Kind != "fact" || claim.Unverified == true)
                {
                    continue;
                }

                if (claim.SourceIds.Count == 0 || claim.SourceIds.Any(id => !snapshot.Sources.ContainsKey(id)))
                {
                    missing.Add($"day {day.DayIndex}: {claim.Text}");
                }
            }
        }

        await stack.Evidence.SaveSnapshotAsync("G-snapshot.json", snapshot);
        if (missing.Count > 0)
        {
            throw new InvalidOperationException(
                "Verified facts are missing source ids: " + string.Join(" | ", missing));
        }

        stack.Evidence.Event("G", "passed; every verified fact cites an existing source");
    }
}

/// <summary>H: write the human-review evidence. Content is not scored.</summary>
public static class ContentCoverage
{
    public static readonly string[] Checklist = ["虹桥往返", "住宿区域", "徒步索道", "日出", "美食", "预算分项"];

    public static async Task RunAsync(Stack stack, string tripId, CancellationToken ct)
    {
        var snapshot = await stack.Api.GetTripJsonAsync(tripId, ct);
        var transcript = await stack.Api.GetTranscriptAsync(tripId, ct);
        await stack.Evidence.SaveJsonAsync("H-transcript.json", transcript);
        await stack.Evidence.SaveJsonAsync("H-snapshot.json", snapshot);
        foreach (var day in snapshot.GetProperty("plan").GetProperty("days").EnumerateArray())
        {
            var index = day.GetProperty("dayIndex").GetInt32();
            await stack.Evidence.SaveJsonAsync($"H-card-{index}.json", day);
        }

        var page = stack.Browser.Page;
        if (!page.Url.Contains(tripId, StringComparison.Ordinal))
        {
            await page.GotoAsync($"{stack.Web.BaseUrl}/trips/{tripId}", new() { WaitUntil = WaitUntilState.NetworkIdle });
        }

        await page.ScreenshotAsync(new() { Path = Path.Combine(stack.Evidence.Root, "H-trip.png"), FullPage = true });
        Console.WriteLine($"H evidence: {stack.Evidence.Root}");
        Console.WriteLine("人工核对清单:");
        foreach (var item in Checklist)
        {
            Console.WriteLine($"- {item}");
        }

        stack.Evidence.Event("H", "evidence written; checklist printed");
    }
}
