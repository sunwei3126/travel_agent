using Microsoft.Playwright;

namespace PiTravel.Acceptance.Infrastructure;

/// <summary>A headed-off Chromium session used by every scenario.</summary>
public sealed class BrowserSession : IAsyncDisposable
{
    private readonly IPlaywright _playwright;
    private readonly IBrowser _browser;

    private BrowserSession(IPlaywright playwright, IBrowser browser, IPage page)
    {
        _playwright = playwright;
        _browser = browser;
        Page = page;
    }

    public IPage Page { get; }

    public static async Task<BrowserSession> LaunchAsync()
    {
        var playwright = await Playwright.CreateAsync();
        var browser = await playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
        {
            Headless = true,
        });
        var page = await browser.NewPageAsync(new BrowserNewPageOptions
        {
            ViewportSize = new ViewportSize { Width = 1440, Height = 1100 },
        });
        page.SetDefaultTimeout(30_000);
        return new BrowserSession(playwright, browser, page);
    }

    public async ValueTask DisposeAsync()
    {
        await _browser.CloseAsync();
        _playwright.Dispose();
    }
}
