namespace PiTravel.Server.Hosting;

/// <summary>
/// Process configuration, mirroring the environment reads in
/// <c>apps/server/src/main.ts</c> and <c>apps/server/src/model/magpie.ts</c>.
/// The listen address comes from <c>ASPNETCORE_URLS</c>, never from <c>PORT</c>.
/// </summary>
public sealed record ServerConfig
{
    public const string DefaultUrls = "http://127.0.0.1:4000";

    public required string DeepSeekApiKey { get; init; }

    public required string DeepSeekBaseUrl { get; init; }

    public required string DataDir { get; init; }

    public required string MagpieBaseUrl { get; init; }

    public required string MagpieModelId { get; init; }

    public required string MagpieApiKey { get; init; }

    public required int MagpieMaxTokens { get; init; }

    public required string ThinkingLevel { get; init; }

    /// <summary>The address Kestrel binds. Tests read it; production uses the host's own urls.</summary>
    public required string Urls { get; init; }

    /// <summary>The clock trip-date validation uses. Production leaves it at the current time.</summary>
    public Func<DateTimeOffset> Now { get; init; } = static () => DateTimeOffset.Now;

    public static ServerConfig FromEnvironment(IDictionary<string, string?> env)
    {
        var apiKey = Value(env, "DEEPSEEK_API_KEY");
        if (string.IsNullOrEmpty(apiKey))
        {
            throw new InvalidOperationException("DEEPSEEK_API_KEY is required");
        }

        var configuredMaxTokens = Value(env, "MAGPIE_MAX_TOKENS");
        var maxTokens = int.TryParse(configuredMaxTokens, out var parsed) && parsed > 0 ? parsed : 393216;

        return new ServerConfig
        {
            DeepSeekApiKey = apiKey,
            DeepSeekBaseUrl = Value(env, "DEEPSEEK_BASE_URL") ?? "https://api.deepseek.com",
            DataDir = Value(env, "DATA_DIR") ?? "./data",
            MagpieBaseUrl = Value(env, "MAGPIE_BASE_URL") ?? "http://127.0.0.1:3425",
            MagpieModelId = Value(env, "MAGPIE_MODEL") ?? "deepseek/deepseek-flash",
            MagpieApiKey = Value(env, "MAGPIE_API_KEY") ?? "magpie",
            MagpieMaxTokens = maxTokens,
            ThinkingLevel = Value(env, "PI_THINKING_LEVEL") ?? "low",
            Urls = Value(env, "ASPNETCORE_URLS") ?? DefaultUrls,
        };
    }

    private static string? Value(IDictionary<string, string?> env, string name) =>
        env.TryGetValue(name, out var value) && !string.IsNullOrEmpty(value) ? value : null;
}
