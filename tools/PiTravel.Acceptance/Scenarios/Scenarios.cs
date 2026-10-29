using Microsoft.Playwright;
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
        var searchKeys = Keys(before.Research.SearchAttempts);
        var fetchKeys = Keys(before.Research.FetchAttempts);
        var searchDone = Sum(before.Research.SearchAttempts);
        var fetchDone = Sum(before.Research.FetchAttempts);
        await stack.Evidence.SaveSnapshotAsync("C-before.json", before);

        stack.Server.Kill();
        stack.Evidence.Event("C", "server killed; restarting against the same DATA_DIR");
        await stack.Server.StartAsync(ct);
        await page.ReloadAsync(new() { WaitUntil = WaitUntilState.NetworkIdle });
        await page.GetByLabel("旅行助手").WaitForAsync();

        var resumed = false;
        var deadline = DateTimeOffset.UtcNow.AddMinutes(3);
        while (DateTimeOffset.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();
            var snapshot = await stack.Api.GetTripAsync(tripId, ct);
            if (snapshot.Running || await UiDriver.IsBusyAsync(page) || snapshot.Plan.Days.Count > before.Plan.Days.Count)
            {
                resumed = true;
                break;
            }

            await Task.Delay(1_000, ct);
        }

        if (!resumed)
        {
            stack.Evidence.Event(
                "C",
                "restarted run did not resume; pi.net parks a repeatedly killed task until RetryTaskAsync()");
            throw new InvalidOperationException(
                "Restarted run did not resume. pi.net 1.4.5 parks a killed task until RetryTaskAsync() is called.");
        }

        var after = await stack.Api.GetTripAsync(tripId, ct);
        await stack.Evidence.SaveSnapshotAsync("C-after.json", after);
        var lostSearch = searchKeys.Except(Keys(after.Research.SearchAttempts)).ToArray();
        var lostFetch = fetchKeys.Except(Keys(after.Research.FetchAttempts)).ToArray();
        if (lostSearch.Length > 0 || lostFetch.Length > 0)
        {
            throw new InvalidOperationException(
                $"Attempt keys were lost. search=[{string.Join(",", lostSearch)}] fetch=[{string.Join(",", lostFetch)}]");
        }

        if (Sum(after.Research.SearchAttempts) > searchDone || Sum(after.Research.FetchAttempts) > fetchDone)
        {
            throw new InvalidOperationException(
                $"Completed attempt counts grew (search {searchDone}->{Sum(after.Research.SearchAttempts)}, fetch {fetchDone}->{Sum(after.Research.FetchAttempts)}).");
        }

        await page.ScreenshotAsync(new() { Path = Path.Combine(stack.Evidence.Root, "C-resumed.png"), FullPage = true });
        stack.Evidence.Event("C", "passed; run resumed and completed attempts did not grow");
    }

    private static async Task<TripSnapshot> WaitForResearchAsync(Stack stack, string tripId, CancellationToken ct)
    {
        var deadline = DateTimeOffset.UtcNow.AddMinutes(8);
        while (DateTimeOffset.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();
            var snapshot = await stack.Api.GetTripAsync(tripId, ct);
            var attempts = (snapshot.Research.SearchAttempts?.Count ?? 0) + (snapshot.Research.FetchAttempts?.Count ?? 0);
            if (attempts > 0)
            {
                return snapshot;
            }

            await Task.Delay(1_000, ct);
        }

        throw new TimeoutException("Research did not start.");
    }

    private static HashSet<string> Keys(IReadOnlyDictionary<string, int>? attempts) =>
        attempts is null ? [] : attempts.Keys.ToHashSet(StringComparer.Ordinal);

    private static int Sum(IReadOnlyDictionary<string, int>? attempts) =>
        attempts?.Values.Sum() ?? 0;
}

/// <summary>D: reloading mid-run keeps the chat rows and day-card count.</summary>
public static class RefreshRecovery
{
    public static async Task RunAsync(Stack stack, CancellationToken ct)
    {
        var page = stack.Browser.Page;
        var tripId = await UiDriver.CreateTripAsync(page, stack.Web.BaseUrl, stack.Evidence, "D");
        await UiDriver.SendAsync(page, UiDriver.CompleteBrief);
        stack.Evidence.Event("D", "waiting for the first chat row or card");
        var deadline = DateTimeOffset.UtcNow.AddMinutes(8);
        while (DateTimeOffset.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();
            if (await page.Locator(".chat-message").CountAsync() > 0 || await page.GetByTestId("day-card").CountAsync() > 0)
            {
                break;
            }

            await Task.Delay(1_000, ct);
        }

        var rows = await page.Locator(".chat-message").CountAsync();
        var cards = await page.GetByTestId("day-card").CountAsync();
        stack.Evidence.Event("D", $"before reload rows={rows} cards={cards}");
        await page.ReloadAsync(new() { WaitUntil = WaitUntilState.NetworkIdle });
        await page.GetByLabel("旅行助手").WaitForAsync();
        var settle = DateTimeOffset.UtcNow.AddSeconds(30);
        var rowsAfter = 0;
        var cardsAfter = 0;
        while (DateTimeOffset.UtcNow < settle)
        {
            rowsAfter = await page.Locator(".chat-message").CountAsync();
            cardsAfter = await page.GetByTestId("day-card").CountAsync();
            if (rowsAfter >= rows && cardsAfter >= cards)
            {
                break;
            }

            await Task.Delay(1_000, ct);
        }

        if (rowsAfter != rows || cardsAfter != cards)
        {
            throw new InvalidOperationException(
                $"Reload changed the UI. rows {rows}->{rowsAfter}, cards {cards}->{cardsAfter}.");
        }

        await page.ScreenshotAsync(new() { Path = Path.Combine(stack.Evidence.Root, "D-reloaded.png"), FullPage = true });
        var snapshot = await stack.Api.GetTripAsync(tripId, ct);
        await stack.Evidence.SaveSnapshotAsync("D-snapshot.json", snapshot);
        stack.Evidence.Event("D", "passed; rows and cards match");
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
            if (snapshot.Plan.Days.Any(day => day.SvgStatus == "failed"))
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

        await page.GetByRole(AriaRole.Button, new() { Name = "重画" }).First.WaitForAsync(new() { Timeout = 60_000 });
        var placeholder = await page.Locator("img.day-card-svg").First.GetAttributeAsync("src");
        if (placeholder is null || !placeholder.StartsWith("data:image/svg+xml", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Failed card is not showing an SVG image.");
        }

        await page.ScreenshotAsync(new() { Path = Path.Combine(stack.Evidence.Root, "E-placeholder.png"), FullPage = true });
        await stack.Evidence.SaveSnapshotAsync("E-snapshot.json", failed);
        stack.Evidence.Event("E", "passed; placeholder is shown and 重画 is usable");
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
