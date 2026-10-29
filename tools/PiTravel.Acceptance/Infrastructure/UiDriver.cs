using Microsoft.Playwright;

namespace PiTravel.Acceptance.Infrastructure;

/// <summary>Drives the Chinese trip UI through roles and labels, not CSS selectors.</summary>
public static class UiDriver
{
    public const string CompleteBrief =
        "我们从上海虹桥出发，2026年11月6日去泰山玩三天，两人同行，体力中等，预算3000元人民币。" +
        "想看日出、走徒步或索道，也想安排当地美食。请按天给出费用分项。";

    public const string IncompleteBrief = "想出去玩几天，随便看看。";

    public static async Task<string> CreateTripAsync(IPage page, string webBase, Evidence evidence, string scenario)
    {
        evidence.Event(scenario, "opening home");
        await page.GotoAsync(webBase, new PageGotoOptions { WaitUntil = WaitUntilState.NetworkIdle });
        await page.GetByLabel("新建行程").WaitForAsync();
        await page.GetByLabel("标题").FillAsync("泰山三日游");
        await page.GetByLabel("目的地").FillAsync("泰山");
        await page.Locator("#trip-start-date").FillAsync("2026-11-06");
        await page.GetByLabel("天数").FillAsync("3");
        await page.GetByRole(AriaRole.Button, new() { Name = "创建行程" }).ClickAsync();
        await page.WaitForURLAsync("**/trips/**");
        await page.GetByLabel("旅行助手").WaitForAsync();
        var tripId = page.Url.TrimEnd('/').Split('/').Last();
        evidence.Event(scenario, $"trip created {tripId}");
        return tripId;
    }

    public static async Task SendAsync(IPage page, string text)
    {
        var input = page.GetByPlaceholder("说说你想去哪、玩几天、在意什么");
        await input.FillAsync(text);
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
