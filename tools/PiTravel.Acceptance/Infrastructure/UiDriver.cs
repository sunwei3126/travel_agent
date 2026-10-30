using Microsoft.Playwright;

namespace PiTravel.Acceptance.Infrastructure;

/// <summary>Drives the Chinese trip UI through roles and labels, not CSS selectors.</summary>
public static class UiDriver
{
    private static readonly Dictionary<IPage, TaskCompletionSource> RuntimeReady = new();

    private static void TrackRuntime(IPage page)
    {
        if (RuntimeReady.ContainsKey(page)) return;
        RuntimeReady[page] = new(TaskCreationOptions.RunContinuationsAsynchronously);
        page.FrameNavigated += (_, frame) =>
        {
            if (frame == page.MainFrame)
                RuntimeReady[page] = new(TaskCreationOptions.RunContinuationsAsynchronously);
        };
        page.Response += (_, response) =>
        {
            if (response.Url.Contains("/api/copilotkit/", StringComparison.Ordinal)
                && response.Request.Method == "POST" && response.Ok)
                RuntimeReady[page].TrySetResult();
        };
    }
    public static string StartDate => DateTime.UtcNow.Date.AddDays(30).ToString("yyyy-MM-dd");

    public static string CompleteBrief =>
        $"我们从上海虹桥出发，{StartDate}去泰山玩三天，两人同行，体力中等，预算3000元人民币。" +
        "想看日出、走徒步或索道，也想安排当地美食。请按天给出费用分项。";

    public const string IncompleteBrief = "想出去玩几天，随便看看。";

    public static async Task<string> CreateTripAsync(IPage page, string webBase, Evidence evidence, string scenario)
    {
        TrackRuntime(page);
        evidence.Event(scenario, "opening home");
        await page.GotoAsync(webBase, new PageGotoOptions { WaitUntil = WaitUntilState.NetworkIdle });
        await page.GetByLabel("新建行程").WaitForAsync();
        await page.GetByLabel("标题").FillAsync("泰山三日游");
        await page.GetByLabel("目的地").FillAsync("泰山");
        await page.Locator("#trip-start-date").FillAsync(StartDate);
        await page.GetByLabel("天数").FillAsync("3");
        await page.GetByRole(AriaRole.Button, new() { Name = "创建行程" }).ClickAsync();
        // The first create compiles the trip route and opens the durable harness,
        // which on a cold dev server takes longer than the 30s default.
        await page.WaitForURLAsync("**/trips/**", new PageWaitForURLOptions { Timeout = 120_000 });
        await page.GetByLabel("旅行助手").WaitForAsync();
        var tripId = page.Url.TrimEnd('/').Split('/').Last();
        evidence.Event(scenario, $"trip created {tripId}");
        return tripId;
    }

    public static async Task SendAsync(IPage page, string text)
    {
        var input = page.GetByPlaceholder("说说你想去哪、玩几天、在意什么");
        // Track responses before navigation so readiness is retained even if the
        // runtime connects before the composer is used.
        TrackRuntime(page);
        await RuntimeReady[page].Task.WaitAsync(TimeSpan.FromSeconds(30));
        await input.ClickAsync();
        // The composer is a controlled React input, so FillAsync never reaches its
        // state and the send button stays disabled. Typing fires onChange.
        await input.PressSequentiallyAsync(text, new LocatorPressSequentiallyOptions { Delay = 20 });
        await page.GetByRole(AriaRole.Button, new() { Name = "发送" }).ClickAsync();
    }

    public static async Task WaitForAssistantTextAsync(IPage page, TimeSpan timeout)
    {
        await page.Locator(".chat-message-assistant .chat-bubble").First.WaitForAsync(
            new LocatorWaitForOptions { Timeout = (float)timeout.TotalMilliseconds });
    }

    public static async Task WaitForDayCardsAsync(IPage page, int count, TimeSpan timeout)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            var cards = await page.GetByTestId("day-card").CountAsync();
            if (cards >= count)
            {
                return;
            }

            await page.WaitForTimeoutAsync(2_000);
        }

        var seen = await page.GetByTestId("day-card").CountAsync();
        throw new TimeoutException($"Expected {count} day cards, saw {seen}.");
    }

    public static async Task<bool> IsBusyAsync(IPage page)
    {
        return await page.GetByText("助手正在思考").CountAsync() > 0
            || await page.GetByText("研究中").CountAsync() > 0;
    }
}
