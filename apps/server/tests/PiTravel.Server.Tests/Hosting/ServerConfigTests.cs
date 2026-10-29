using PiTravel.Server.Hosting;

namespace PiTravel.Server.Tests.Hosting;

/// <summary>
/// Locks <see cref="ServerConfig.FromEnvironment"/> to the environment contract in
/// <c>apps/server/src/main.ts</c> and <c>apps/server/src/model/magpie.ts</c>.
/// </summary>
public sealed class ServerConfigTests
{
    [Fact]
    public void MissingDeepSeekKeyThrowsAtStartup()
    {
        var error = Assert.Throws<InvalidOperationException>(() =>
            ServerConfig.FromEnvironment(new Dictionary<string, string?>()));

        Assert.Contains("DEEPSEEK_API_KEY", error.Message);
    }

    [Fact]
    public void DefaultsMatchTheDocumentedValues()
    {
        var config = ServerConfig.FromEnvironment(new Dictionary<string, string?>
        {
            ["DEEPSEEK_API_KEY"] = "test-key",
        });

        Assert.Equal("test-key", config.DeepSeekApiKey);
        Assert.Equal("https://api.deepseek.com", config.DeepSeekBaseUrl);
        Assert.Equal("./data", config.DataDir);
        Assert.Equal("http://127.0.0.1:3425", config.MagpieBaseUrl);
        Assert.Equal("deepseek/deepseek-flash", config.MagpieModelId);
        Assert.Equal("magpie", config.MagpieApiKey);
        Assert.Equal(393216, config.MagpieMaxTokens);
        Assert.Equal("low", config.ThinkingLevel);
    }

    [Fact]
    public void PortComesFromUrlsNotPortEnvVar()
    {
        var config = ServerConfig.FromEnvironment(new Dictionary<string, string?>
        {
            ["DEEPSEEK_API_KEY"] = "test-key",
            ["PORT"] = "9999",
            ["ASPNETCORE_URLS"] = "http://127.0.0.1:4321",
        });

        Assert.Equal("http://127.0.0.1:4321", config.Urls);
        Assert.Equal("http://127.0.0.1:4000", ServerConfig.DefaultUrls);
    }
}
