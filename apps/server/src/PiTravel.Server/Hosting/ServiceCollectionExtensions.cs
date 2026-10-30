using Pi.Ai.Api;
using Pi.Ai.Auth;
using Pi.Ai.Models;
using Pi.Ai.Types;
using Pi.Durable.Harness;
using PiTravel.Server.Agent;
using PiTravel.Server.Artifacts;
using PiTravel.Server.Harness;
using PiTravel.Server.Research;

namespace PiTravel.Server.Hosting;

/// <summary>
/// Builds the production service: the pi.net registry with the travel extension
/// installed, the magpie model, and the DeepSeek client. Tests never call this;
/// they pass a service into <see cref="Program.BuildApp"/>.
/// </summary>
public static class ServiceCollectionExtensions
{
    public static async Task<TravelService> CreateServiceAsync(ServerConfig config, CancellationToken ct)
    {
        var models = CreateModels(config);
        var model = models.GetModel("magpie", config.MagpieModelId)
            ?? throw new InvalidOperationException(
                $"Magpie model \"{config.MagpieModelId}\" is not registered on provider \"magpie\".");

        var requested = Enum.TryParse<ThinkingLevel>(config.ThinkingLevel, ignoreCase: true, out var parsed)
            ? parsed
            : ThinkingLevel.Low;
        var clamped = ThinkingLevels.Clamp(model, requested.ToString().ToLowerInvariant());
        var thinkingLevel = Enum.Parse<ThinkingLevel>(clamped, ignoreCase: true);

        var registry = Registry.CreateRegistry();
        registry.Install(TravelExtension.Create(CreateDeps(config, models, model)));

        return await TravelService.OpenAsync(
            new TravelServiceOptions
            {
                DataDir = config.DataDir,
                Models = models,
                Registry = registry,
                DefaultModel = new ModelRef(model.Provider, model.Id),
                ThinkingLevel = thinkingLevel,
            },
            ct);
    }

    private static Models CreateModels(ServerConfig config)
    {
        var model = new ModelSpec
        {
            Id = config.MagpieModelId,
            Name = config.MagpieModelId,
            Api = "anthropic-messages",
            Provider = "magpie",
            BaseUrl = config.MagpieBaseUrl,
            Reasoning = true,
            Headers = new Dictionary<string, string> { ["x-api-key"] = config.MagpieApiKey },
            Input = [ModelInput.Text],
            Cost = new ModelCostRates(0, 0, 0, 0),
            ContextWindow = 1_000_000,
            MaxTokens = config.MagpieMaxTokens,
        };

        var provider = ProviderFactory.Create(new CreateProviderOptions
        {
            Id = "magpie",
            Name = "Magpie",
            BaseUrl = config.MagpieBaseUrl,
            // Magpie accepts any local key, and a remote Anthropic-compatible
            // endpoint gets its real key through the model's x-api-key header.
            // The auth only has to resolve: an empty env list resolves to nothing,
            // which the harness reports as "Provider is not configured".
            Auth = new ProviderAuth
            {
                ApiKey = new EnvApiKeyAuth("Magpie", ["MAGPIE_API_KEY"]),
            },
            Models = [model],
            Api = LazyApis.AnthropicMessagesApi(),
        });

        var models = new Models();
        models.SetProvider(provider);
        return models;
    }

    private static TravelDeps CreateDeps(ServerConfig config, Models models, ModelSpec model)
    {
        var deepseek = new DeepSeekClient(new HttpClient(), config.DeepSeekApiKey, config.DeepSeekBaseUrl);
        return new TravelDeps(
            static () => DateTimeOffset.Now,
            deepseek,
            (day, ct) => SketchGenerator.GenerateAsync(
                day,
                (prompt, token) => CompleteAsync(models, model, prompt, token),
                ct));
    }

    private static async Task<string> CompleteAsync(
        Models models,
        ModelSpec model,
        string prompt,
        CancellationToken ct)
    {
        var message = await models.CompleteSimpleAsync(
            model,
            [new UserMessage([new TextContent(prompt)], DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())],
            new Dictionary<string, object?>(),
            ct);
        return string.Concat(message.Content.OfType<TextContent>().Select(block => block.Text));
    }
}
