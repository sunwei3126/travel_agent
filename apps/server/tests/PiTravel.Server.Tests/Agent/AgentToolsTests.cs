using System.Net;
using System.Text;
using System.Text.Json;
using Pi.Ai.Models;
using Pi.Ai.Providers;
using Pi.Ai.Types;
using Pi.Ai.Utils;
using Pi.Chord.Context;
using Pi.Durable.Env;
using Pi.Durable.Harness;
using Pi.Durable.Storage;
using Pi.Durable.Types;
using PiTravel.Server.Agent;
using PiTravel.Server.Agent.Tools;
using PiTravel.Server.Artifacts;
using PiTravel.Server.Contracts;
using PiTravel.Server.Harness;
using PiTravel.Server.Research;

namespace PiTravel.Server.Tests.Agent;

using DurableHarness = Pi.Durable.Harness.Harness;

public sealed class AgentToolsTests
{
    private static readonly DateTimeOffset FixedNow =
        new(2026, 10, 19, 0, 0, 0, TimeSpan.Zero);

    private static readonly Context Ctx = Context.Background;

    [Fact]
    public async Task EmitDayRefusesWhenBriefIncomplete()
    {
        await using var env = await ToolTestEnv.CreateAsync();
        await env.SeedBriefAsync(new TripBrief
        {
            Destination = "泰山",
            StartDate = "2026-10-26",
            Days = 3,
        });

        var tool = new EmitDayTool(env.Deps);
        var ex = await Assert.ThrowsAnyAsync<Exception>(() =>
            tool.ExecuteAsync(SampleEmitArgs(1, "第一天"), env.Api, Ctx));

        Assert.Contains("trip brief is incomplete", ex.Message);
        Assert.Contains("origin", ex.Message);

        var plan = await env.ReadPlanAsync();
        Assert.Empty(plan.Days);
    }

    [Fact]
    public async Task EmitDayRejectsUnfetchedSourceAsFact()
    {
        await using var env = await ToolTestEnv.CreateAsync();
        await env.SeedBriefAsync(CompleteBrief());

        var unfetchedId = SourceIds.ForUrl("https://example.com/taishan/tickets");
        await env.SeedSourcesAsync(new Dictionary<string, TripSource>
        {
            [unfetchedId] = new TripSource
            {
                Id = unfetchedId,
                Query = "泰山 门票",
                Title = "泰山门票",
                Url = "https://example.com/taishan/tickets",
                Snippet = "旺季门票 115 元",
                Kind = "search",
            },
        });

        var args = SampleEmitArgs(1, "第一天") with
        {
            Scenery =
            [
                new Claim
                {
                    Text = "旺季门票 115 元",
                    Kind = "fact",
                    SourceIds = [unfetchedId],
                },
            ],
            Sources = [unfetchedId],
        };

        var tool = new EmitDayTool(env.Deps);
        var ex = await Assert.ThrowsAnyAsync<Exception>(() =>
            tool.ExecuteAsync(args, env.Api, Ctx));

        Assert.Contains("unfetched source", ex.Message);
        Assert.Contains(unfetchedId, ex.Message);

        var plan = await env.ReadPlanAsync();
        Assert.Empty(plan.Days);
    }

    [Fact]
    public async Task SearchWritesSourcesCacheAndAttemptsInOneCommit()
    {
        var handler = new RoutingHttpHandler(
            onSearch: _ => JsonSearchResponse(
            [
                new SearchHit(
                    Title: "博客攻略",
                    Url: "https://example.com/blog",
                    Snippet: "红门徒步路线",
                    Date: "2026-09-01",
                    Authority: 1),
            ]),
            onFetch: url => JsonFetchResponse(url, $"正文-{url}"));

        await using var env = await ToolTestEnv.CreateAsync(handler);
        // Set fetchCount to cap so auto-fetch does not run an extra commit; we want to
        // verify the search commit itself writes sources, cache, and attempts atomically.
        await env.SeedResearchAsync(new TripResearch { SearchCount = 0, FetchCount = 30 });
        env.Api.ResetCommitCount();

        var tool = new SearchTool(env.Deps);
        var result = await tool.ExecuteAsync(new { query = "泰山 门票" }, env.Api, Ctx);

        Assert.Equal(1, env.Api.CommitCount);
        Assert.Equal(1, handler.SearchCalls);
        Assert.Equal(0, handler.FetchCalls);

        var expectedId = SourceIds.ForUrl("https://example.com/blog");
        var sources = await env.ReadSourcesAsync();
        Assert.True(sources.ContainsKey(expectedId));

        var cache = await env.ReadSearchCacheAsync();
        var cacheKey = SearchTool.SearchCacheKey("泰山 门票");
        Assert.True(cache.ContainsKey(cacheKey));
        Assert.Equal([expectedId], cache[cacheKey].SourceIds);

        var research = await env.ReadResearchAsync();
        Assert.Equal(1, research.SearchCount);
        Assert.NotNull(research.SearchAttempts);
        Assert.Equal(1, research.SearchAttempts[cacheKey]);

        var text = Text.ContentText(result.Content!);
        Assert.Contains($"[{expectedId}]", text);
    }

    [Fact]
    public async Task SearchServesRepeatedQueryFromCacheWithoutCallingDeepSeek()
    {
        var handler = new RoutingHttpHandler(
            onSearch: _ => JsonSearchResponse(
            [
                new SearchHit(
                    Title: "泰山景区官网",
                    Url: "https://example.com/taishan/tickets",
                    Snippet: "旺季门票 115 元",
                    Date: "2026-09-01",
                    Authority: 4,
                    RerankScore: 2),
            ]),
            onFetch: url => JsonFetchResponse(url, $"来自 {url} 的已抓取正文"));

        await using var env = await ToolTestEnv.CreateAsync(handler);
        var tool = new SearchTool(env.Deps);

        var first = await tool.ExecuteAsync(new { query = " 泰山   门票 " }, env.Api, Ctx);
        var second = await tool.ExecuteAsync(new { query = "泰山 门票" }, env.Api, Ctx);

        Assert.Equal(1, handler.SearchCalls);
        Assert.Equal(1, handler.FetchCalls);

        var research = await env.ReadResearchAsync();
        Assert.Equal(1, research.SearchCount);
        Assert.Equal(1, research.FetchCount);
        Assert.Contains("来自 https://example.com/taishan/tickets 的已抓取正文", Text.ContentText(first.Content!));
        Assert.Contains("来自 https://example.com/taishan/tickets 的已抓取正文", Text.ContentText(second.Content!));
    }

    [Fact]
    public async Task FetchRefusesUrlThatDidNotComeFromSearch()
    {
        var handler = new RoutingHttpHandler();
        await using var env = await ToolTestEnv.CreateAsync(handler);
        var tool = new FetchTool(env.Deps);

        var ex = await Assert.ThrowsAnyAsync<Exception>(() =>
            tool.ExecuteAsync(new { url = "https://evil.example/steal" }, env.Api, Ctx));

        Assert.Contains("must come from a deepseek_search result", ex.Message);
        Assert.Equal(0, handler.FetchCalls);
    }

    [Fact]
    public async Task FetchReturnsCachedContentWhenAlreadyFetched()
    {
        const string targetUrl = "https://example.com/taishan/tickets";
        var handler = new RoutingHttpHandler(
            onFetch: url => JsonFetchResponse(url, "红门开始徒步，中天门索道 100 元。"));

        await using var env = await ToolTestEnv.CreateAsync(handler);
        var seedSources = new Dictionary<string, TripSource>();
        Sources.AddSearch(
            seedSources,
            "泰山 门票",
            [new SearchHit("泰山官网", targetUrl, "门票信息", Authority: 4)]);
        await env.SeedSourcesAsync(seedSources);

        var tool = new FetchTool(env.Deps);
        var first = await tool.ExecuteAsync(new { url = targetUrl }, env.Api, Ctx);
        var second = await tool.ExecuteAsync(new { url = $"{targetUrl}/#section" }, env.Api, Ctx);

        Assert.Equal(1, handler.FetchCalls);
        var research = await env.ReadResearchAsync();
        Assert.Equal(1, research.FetchCount);
        Assert.Contains("红门开始徒步", Text.ContentText(first.Content!));
        Assert.Equal(Text.ContentText(first.Content!), Text.ContentText(second.Content!));
    }

    [Fact]
    public async Task SearchStopsAtFortyCalls()
    {
        var handler = new RoutingHttpHandler();
        await using var env = await ToolTestEnv.CreateAsync(handler);
        await env.SeedResearchAsync(new TripResearch { SearchCount = 40, FetchCount = 0 });

        var tool = new SearchTool(env.Deps);
        var ex = await Assert.ThrowsAnyAsync<Exception>(() =>
            tool.ExecuteAsync(new { query = "泰山 门票" }, env.Api, Ctx));

        Assert.Equal("search cap reached", ex.Message);
        Assert.Equal(0, handler.SearchCalls);
    }

    [Fact]
    public async Task FetchStopsAtThirtyCalls()
    {
        const string targetUrl = "https://example.com/taishan/tickets";
        var handler = new RoutingHttpHandler();
        await using var env = await ToolTestEnv.CreateAsync(handler);
        var seedSources = new Dictionary<string, TripSource>();
        Sources.AddSearch(
            seedSources,
            "泰山 门票",
            [new SearchHit("泰山官网", targetUrl, "门票信息", Authority: 4)]);
        await env.SeedSourcesAsync(seedSources);
        await env.SeedResearchAsync(new TripResearch { SearchCount = 1, FetchCount = 30 });

        var tool = new FetchTool(env.Deps);
        var ex = await Assert.ThrowsAnyAsync<Exception>(() =>
            tool.ExecuteAsync(new { url = targetUrl }, env.Api, Ctx));

        Assert.Equal("fetch cap reached", ex.Message);
        Assert.Equal(0, handler.FetchCalls);
    }

    [Fact]
    public async Task FinalizeThrowsWhenBriefHasNoBudget()
    {
        await using var env = await ToolTestEnv.CreateAsync();
        await env.SeedBriefAsync(new TripBrief { Destination = "泰山" });

        var tool = new FinalizeTool();
        var ex = await Assert.ThrowsAnyAsync<Exception>(() =>
            tool.ExecuteAsync(new Dictionary<string, object?>(), env.Api, Ctx));

        Assert.Contains("Cannot finalize: trip brief has no budgetCny", ex.Message);
    }

    [Fact]
    public async Task FinalizeStoresBudgetSummaryOnPlan()
    {
        await using var env = await ToolTestEnv.CreateAsync();
        await env.SeedBriefAsync(CompleteBrief());
        await env.SeedPlanAsync(new TripPlan
        {
            Days =
            [
                SampleDayCard(1, [400, 700]),
                SampleDayCard(2, [500, 900]),
                SampleDayCard(3, [300, 600]),
            ],
        });

        var tool = new FinalizeTool();
        var result = await tool.ExecuteAsync(new Dictionary<string, object?>(), env.Api, Ctx);

        var plan = await env.ReadPlanAsync();
        Assert.NotNull(plan.Budget);
        Assert.Equal(1200d, plan.Budget.Low);
        Assert.Equal(2200d, plan.Budget.High);
        Assert.Equal(3000d, plan.Budget.Cap);
        Assert.True(plan.Budget.WithinBudget);
        Assert.Contains(
            "Estimated 1200-2200 CNY against a 3000 CNY budget: within budget.",
            Text.ContentText(result.Content!));
    }

    [Fact]
    public async Task UpdateBriefMergesAndReportsMissingFields()
    {
        await using var env = await ToolTestEnv.CreateAsync();
        await env.SeedBriefAsync(new TripBrief
        {
            Destination = "泰山",
            StartDate = "2026-10-26",
            Days = 3,
        });

        var tool = new UpdateBriefTool(env.Deps);
        var partialResult = await tool.ExecuteAsync(
            new TripBrief { Origin = "上海虹桥", BudgetCny = 3000 },
            env.Api,
            Ctx);

        var briefAfterPartial = await env.ReadBriefAsync();
        Assert.Equal("泰山", briefAfterPartial.Destination);
        Assert.Equal("上海虹桥", briefAfterPartial.Origin);
        Assert.Equal(3000d, briefAfterPartial.BudgetCny);
        Assert.Contains(
            "Missing brief fields: companions, fitness, interests",
            Text.ContentText(partialResult.Content!));

        var completeResult = await tool.ExecuteAsync(
            new TripBrief
            {
                Companions = "情侣两人",
                Fitness = "average",
                Interests = ["日出", "徒步"],
            },
            env.Api,
            Ctx);

        Assert.Equal("Brief is complete.", Text.ContentText(completeResult.Content!));
    }

    [Fact]
    public async Task ValidationFlagIsReArmedPerCallAndIsolationKeepsTheDeclarationFull()
    {
        await using var env = await ToolTestEnv.CreateAsync();
        await env.SeedBriefAsync(new TripBrief { Destination = "泰山" });
        var tool = new UpdateBriefTool(env.Deps);

        string Declaration() => JsonSerializer.Serialize(
            Pi.Durable.Harness.Prompt.DeclarationOf(tool).Parameters.JsonSchema);
        string Parameters() => JsonSerializer.Serialize(tool.Parameters.JsonSchema);

        // Steady state: the model declaration carries the full items schema.
        Assert.Contains("\"items\":{\"type\":\"string\"}", Declaration());

        // A call whose validation fails settles without reaching ExecuteAsync.
        // Its flow sees the stripped schema, and cannot change this flow's view.
        await Task.Run(() =>
        {
            tool.PrepareArguments(new Dictionary<string, object?> { ["startDate"] = "2026-02-30" });
            Assert.DoesNotContain("\"items\"", Parameters());
        });
        Assert.Contains("\"items\":{\"type\":\"string\"}", Declaration());

        // A fresh call re-arms the flag instead of depending on the failed call
        // clearing it, so both of the framework's validation reads are stripped,
        // and the call itself still completes.
        var valid = new Dictionary<string, object?>
        {
            ["origin"] = "上海虹桥",
            ["interests"] = new[] { "登山" },
        };
        await Task.Run(async () =>
        {
            tool.PrepareArguments(valid);
            Assert.DoesNotContain("\"items\"", Parameters());
            Assert.DoesNotContain("\"items\"", Parameters());

            var result = await tool.ExecuteAsync(valid, env.Api, Ctx);
            Assert.Contains("Missing brief fields:", Text.ContentText(result.Content!));
        });

        // Validation state never escapes the call's own flow, so the model
        // declaration is the full schema in the steady state.
        Assert.Contains("\"items\":{\"type\":\"string\"}", Declaration());
    }

    [Fact]
    public async Task FailedValidationKeepsTheFullSchemaForTheNextDeclaration()
    {
        var deps = new TravelDeps(
            () => FixedNow,
            new DeepSeekClient(new HttpClient(new RoutingHttpHandler()), "test-key"),
            (_, _) => Task.FromResult(new SketchResult("<svg viewBox=\"0 0 100 100\"/>", "ok")));
        var extension = new TravelExtension(deps);
        var tool = extension.Tools.Single(registered => registered.Name == "trip_update_brief");

        var faux = Faux.CreateProvider();
        var model = faux.GetModel(null)!;
        var models = new Models();
        models.SetProvider(faux.Provider);
        var registry = Registry.CreateRegistry();
        registry.Install(Define.Extension(extension));

        var harness = await DurableHarness.OpenAsync(
            new MemoryStorage(),
            new HarnessOptions { Models = models, Registry = registry },
            Ctx);
        try
        {
            var conversation = await harness.CreateConversationAsync(
                new ConversationCreateOptions
                {
                    Ownership = new ConversationOwnership.Ownerless(),
                    Agent = new AgentChange { Model = new ModelRef(model.Provider, model.Id) },
                },
                Ctx);
            await conversation.CommitAsync(
                async tx =>
                {
                    Docs.Write(
                        await tx.DocAsync(Docs.TripBriefDoc, conversation.Id),
                        new TripBrief { Destination = "泰山" });
                    return true;
                },
                Ctx);

            // The framework validates before ExecuteAsync; a rejection settles the
            // call without ever reaching it, which is where a counter would leak.
            faux.SetResponses(
            [
                Faux.Response.ToolUse(
                    Faux.ToolCall(
                        "trip_update_brief",
                        new Dictionary<string, object?> { ["startDate"] = "2026-02-30" },
                        "call-invalid")),
                Faux.Response.ToolUse(
                    Faux.ToolCall(
                        "trip_update_brief",
                        new Dictionary<string, object?>
                        {
                            ["origin"] = "上海虹桥",
                            ["interests"] = new[] { "登山" },
                        },
                        "call-valid")),
                Faux.Response.Text("done"),
            ]);

            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var stream = await Events.WatchEventsAsync(harness, conversation.Id, Ctx);
            var runEnded = new TaskCompletionSource(
                TaskCreationOptions.RunContinuationsAsynchronously);
            stream.Start((batch, _) =>
            {
                if (batch.OfType<AgentEvent.RunEnd>().Any())
                {
                    runEnded.TrySetResult();
                }

                return Task.CompletedTask;
            });
            await conversation.SubmitAsync(
                new SubmissionDraft.Input { Content = [new TextContent("更新行程")] },
                Ctx);
            await runEnded.Task.WaitAsync(cts.Token);
            await stream.StopAsync();

            var watch = await conversation.WatchAsync(Ctx);
            try
            {
                var results = watch.Value.Entries
                    .Select(entry => entry.Model?.FirstOrDefault())
                    .OfType<ToolResultMessage>()
                    .ToList();
                Assert.Equal(2, results.Count);
                Assert.Contains(
                    "real calendar date",
                    Text.ContentText(results[0].Content!));
                Assert.Contains(
                    "Missing brief fields:",
                    Text.ContentText(results[1].Content!));
            }
            finally
            {
                await watch.Stop();
            }

            var brief = Docs.ReadBrief(
                await harness.SnapshotAsync(Docs.TripBriefDoc, conversation.Id, Ctx));
            Assert.Equal("上海虹桥", brief.Origin);
            Assert.Null(brief.StartDate);

            // After the rejected call the model declaration must still carry the
            // full items schema, not the stripped one used only while validating.
            var declared = JsonSerializer.Serialize(
                Pi.Durable.Harness.Prompt.DeclarationOf(tool).Parameters.JsonSchema);
            Assert.Contains("\"items\":{\"type\":\"string\"}", declared);
        }
        finally
        {
            await harness.CloseAsync(Ctx);
        }
    }

    [Fact]
    public async Task SketchDayStoresGeneratedSvgAndStatusOnDayCard()
    {
        await using var env = await ToolTestEnv.CreateAsync();
        await env.SeedPlanAsync(new TripPlan
        {
            Days = [SampleDayCard(1, [100, 200])],
        });

        var tool = new SketchDayTool(env.Deps);
        var result = await tool.ExecuteAsync(new { dayIndex = 1 }, env.Api, Ctx);

        Assert.Equal("Sketch for day 1 is ok.", Text.ContentText(result.Content!));
        var plan = await env.ReadPlanAsync();
        var card = Assert.Single(plan.Days);
        Assert.Equal("<svg viewBox=\"0 0 100 100\"/>", card.Svg);
        Assert.Equal("ok", card.SvgStatus);
    }

    [Fact]
    public async Task TravelExtensionRegistersSixSafeToolsAndRunsThroughFauxModel()
    {
        var handler = new RoutingHttpHandler(
            onSearch: _ => JsonSearchResponse(
            [
                new SearchHit("泰山官网", "https://example.com/gov", "门票信息", Authority: 4),
            ]),
            onFetch: url => JsonFetchResponse(url, $"正文来自 {url}"));

        using var http = new HttpClient(handler);
        var deepseek = new DeepSeekClient(
            http,
            "test-key",
            nowMs: static () => 0,
            delay: static _ => Task.CompletedTask);
        var deps = new TravelDeps(
            () => FixedNow,
            deepseek,
            (_, _) => Task.FromResult(new SketchResult("<svg viewBox=\"0 0 100 100\"/>", "ok")));

        var ext = new TravelExtension(deps);
        Assert.Equal("travel", ext.Name);
        Assert.Equal(
            [
                "trip_update_brief",
                "plan_emit_day",
                "plan_finalize",
                "deepseek_search",
                "deepseek_fetch",
                "sketch_day",
            ],
            ext.Tools.Select(t => t.Name).ToArray());
        Assert.All(ext.Tools, t => Assert.Equal("safe", t.Replay));
        Assert.Single(ext.Sections);

        var faux = Faux.CreateProvider();
        var model = faux.GetModel(null)!;
        var models = new Models();
        models.SetProvider(faux.Provider);
        var registry = Registry.CreateRegistry();
        registry.Install(Define.Extension(ext));

        var service = await TravelService.OpenAsync(new TravelServiceOptions
        {
            Storage = new MemoryStorage(),
            Models = models,
            Registry = registry,
            DefaultModel = new ModelRef(model.Provider, model.Id),
            Now = () => FixedNow,
        });

        try
        {
            var trip = await service.CreateTripAsync(
                new CreateTripInput("泰山", "泰山", "2026-10-26", 3));

            faux.SetResponses(
            [
                Faux.Response.ToolUse(
                    Faux.ToolCall(
                        "trip_update_brief",
                        new Dictionary<string, object?>
                        {
                            ["origin"] = "上海虹桥",
                            ["budgetCny"] = 3000,
                            ["companions"] = "情侣",
                            ["fitness"] = "average",
                            ["interests"] = new[] { "登山", "日出" },
                        },
                        "call-brief")),
                Faux.Response.ToolUse(
                    Faux.ToolCall(
                        "deepseek_search",
                        new Dictionary<string, object?> { ["query"] = "泰山 门票" },
                        "call-search")),
                Faux.Response.Text("研究完成"),
            ]);

            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await using var enumerator = service
                .WatchEventsAsync(trip.TripId, cts.Token)
                .GetAsyncEnumerator(cts.Token);
            Assert.True(await enumerator.MoveNextAsync());

            await service.SubmitMessageAsync(trip.TripId, "开始规划", "r1");
            while (await enumerator.MoveNextAsync())
            {
                if (enumerator.Current is AgentEvent.RunEnd)
                {
                    break;
                }
            }

            var snapshot = await service.GetSnapshotAsync(trip.TripId);
            Assert.Equal("上海虹桥", snapshot.Brief.Origin);
            Assert.Equal(["登山", "日出"], snapshot.Brief.Interests);
            Assert.Equal(1, snapshot.Research.SearchCount);
            Assert.Equal(1, snapshot.Research.FetchCount);
            Assert.Single(snapshot.Sources);
        }
        finally
        {
            await service.CloseAsync();
        }
    }

    private static TripBrief CompleteBrief() => new()
    {
        Destination = "泰山",
        Origin = "上海虹桥",
        StartDate = "2026-10-26",
        Days = 3,
        BudgetCny = 3000,
        Companions = "情侣两人",
        Fitness = "average",
        Interests = ["登山", "日出"],
    };

    private static EmitDayArgs SampleEmitArgs(int dayIndex, string title) => new()
    {
        DayIndex = dayIndex,
        Date = $"2026-10-{25 + dayIndex}",
        Title = title,
        Blocks = [],
        Scenery = [],
        Food = [],
        Transport = [],
        EstimatedCostCny = [100, 200],
        Sources = [],
    };

    private static DayCard SampleDayCard(int dayIndex, IReadOnlyList<double> cost) => new()
    {
        DayIndex = dayIndex,
        Date = $"2026-10-{25 + dayIndex}",
        Title = $"第 {dayIndex} 天",
        Blocks = [],
        Scenery = [],
        Food = [],
        Transport = [],
        EstimatedCostCny = cost,
        Sources = [],
        SvgStatus = "pending",
        UpdatedAt = "2026-10-19T00:00:00.000Z",
    };

    private static HttpResponseMessage JsonSearchResponse(IReadOnlyList<SearchHit> hits)
    {
        var payload = new
        {
            results = hits.Select(h => new
            {
                title = h.Title,
                url = h.Url,
                snippet = h.Snippet,
                summary = h.Summary,
                content = h.Content,
                date = h.Date,
                authority = h.Authority,
                rerank_score = h.RerankScore,
                site_name = h.SiteName,
            }),
        };
        return new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                JsonSerializer.Serialize(payload),
                Encoding.UTF8,
                "application/json"),
        };
    }

    private static HttpResponseMessage JsonFetchResponse(string url, string content) =>
        new(HttpStatusCode.OK)
        {
            Content = new StringContent(
                JsonSerializer.Serialize(new { title = $"页面 {url}", url, content }),
                Encoding.UTF8,
                "application/json"),
        };

    private sealed class RoutingHttpHandler : HttpMessageHandler
    {
        private readonly Func<string, HttpResponseMessage> _onSearch;
        private readonly Func<string, HttpResponseMessage> _onFetch;

        public RoutingHttpHandler(
            Func<string, HttpResponseMessage>? onSearch = null,
            Func<string, HttpResponseMessage>? onFetch = null)
        {
            _onSearch = onSearch ?? (_ => JsonSearchResponse([]));
            _onFetch = onFetch ?? (url => JsonFetchResponse(url, ""));
        }

        public int SearchCalls { get; private set; }
        public int FetchCalls { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var path = request.RequestUri?.AbsolutePath ?? "";
            var body = request.Content is null
                ? "{}"
                : await request.Content.ReadAsStringAsync(cancellationToken);
            using var doc = JsonDocument.Parse(body);

            if (path.EndsWith("/search", StringComparison.Ordinal))
            {
                SearchCalls++;
                var query = doc.RootElement.TryGetProperty("query", out var q)
                    ? q.GetString() ?? ""
                    : "";
                return _onSearch(query);
            }

            if (path.EndsWith("/fetch", StringComparison.Ordinal))
            {
                FetchCalls++;
                var url = doc.RootElement.TryGetProperty("url", out var u)
                    ? u.GetString() ?? ""
                    : "";
                return _onFetch(url);
            }

            throw new InvalidOperationException($"Unexpected path: {path}");
        }
    }

    private sealed class ToolTestEnv : IAsyncDisposable
    {
        private readonly HttpClient _http;
        private readonly HarnessImpl _harness;
        private readonly IConversation _conversation;

        private ToolTestEnv(
            HttpClient http,
            HarnessImpl harness,
            IConversation conversation,
            TravelDeps deps,
            DurableToolApi api)
        {
            _http = http;
            _harness = harness;
            _conversation = conversation;
            Deps = deps;
            Api = api;
        }

        public TravelDeps Deps { get; }
        public DurableToolApi Api { get; }

        public static async Task<ToolTestEnv> CreateAsync(HttpMessageHandler? handler = null)
        {
            var http = new HttpClient(handler ?? new RoutingHttpHandler());
            var deepseek = new DeepSeekClient(
                http,
                "test-key",
                nowMs: static () => 0,
                delay: static _ => Task.CompletedTask);
            var deps = new TravelDeps(
                () => FixedNow,
                deepseek,
                (_, _) => Task.FromResult(new SketchResult("<svg viewBox=\"0 0 100 100\"/>", "ok")));

            var storage = new MemoryStorage();
            var faux = Faux.CreateProvider();
            var model = faux.GetModel(null)!;
            var models = new Models();
            models.SetProvider(faux.Provider);
            var registry = Registry.CreateRegistry();
            var harness = await DurableHarness.OpenAsync(
                storage,
                new HarnessOptions
                {
                    Models = models,
                    Registry = registry,
                    Now = () => FixedNow.ToUnixTimeMilliseconds(),
                },
                Ctx);
            var conversation = await harness.CreateConversationAsync(
                new ConversationCreateOptions
                {
                    Ownership = new ConversationOwnership.Ownerless(),
                    Agent = new AgentChange { Model = new ModelRef(model.Provider, model.Id) },
                },
                Ctx);

            var api = new DurableToolApi(harness, conversation);
            return new ToolTestEnv(http, harness, conversation, deps, api);
        }

        public Task SeedBriefAsync(TripBrief brief) =>
            _conversation.CommitAsync(
                async tx =>
                {
                    var doc = await tx.DocAsync(Docs.TripBriefDoc, _conversation.Id);
                    Docs.Write(doc, brief);
                    return true;
                },
                Ctx);

        public Task SeedPlanAsync(TripPlan plan) =>
            _conversation.CommitAsync(
                async tx =>
                {
                    var doc = await tx.DocAsync(Docs.TripPlanDoc, _conversation.Id);
                    Docs.Write(doc, plan);
                    return true;
                },
                Ctx);

        public Task SeedSourcesAsync(Dictionary<string, TripSource> sources) =>
            _conversation.CommitAsync(
                async tx =>
                {
                    var doc = await tx.DocAsync(Docs.TripSourcesDoc, _conversation.Id);
                    Docs.Write(doc, sources);
                    return true;
                },
                Ctx);

        public Task SeedResearchAsync(TripResearch research) =>
            _conversation.CommitAsync(
                async tx =>
                {
                    var doc = await tx.DocAsync(Docs.TripResearchDoc, _conversation.Id);
                    Docs.Write(doc, research);
                    return true;
                },
                Ctx);

        public async Task<TripBrief> ReadBriefAsync() =>
            Docs.ReadBrief(await _harness.SnapshotAsync(Docs.TripBriefDoc, _conversation.Id, Ctx));

        public async Task<TripPlan> ReadPlanAsync() =>
            Docs.ReadPlan(await _harness.SnapshotAsync(Docs.TripPlanDoc, _conversation.Id, Ctx));

        public async Task<Dictionary<string, TripSource>> ReadSourcesAsync() =>
            Docs.ReadSources(await _harness.SnapshotAsync(Docs.TripSourcesDoc, _conversation.Id, Ctx));

        public async Task<TripResearch> ReadResearchAsync() =>
            Docs.ReadResearch(await _harness.SnapshotAsync(Docs.TripResearchDoc, _conversation.Id, Ctx));

        public async Task<Dictionary<string, SearchCacheEntry>> ReadSearchCacheAsync() =>
            Docs.ReadSearchCache(await _harness.SnapshotAsync(Docs.TripSearchCacheDoc, _conversation.Id, Ctx));

        public async ValueTask DisposeAsync()
        {
            await _harness.CloseAsync(Ctx);
            _http.Dispose();
        }
    }

    private sealed class DurableToolApi : IToolExecutionApi
    {
        private readonly HarnessImpl _harness;
        private readonly IConversation _conversation;

        public DurableToolApi(HarnessImpl harness, IConversation conversation)
        {
            _harness = harness;
            _conversation = conversation;
        }

        public int CommitCount { get; private set; }

        public void ResetCommitCount() => CommitCount = 0;

        public TaskId<object?> TaskId => default;
        public ConversationId ConversationId => _conversation.Id;
        public string CallId => "call-1";
        public IRegistrySnapshot Registry => throw new NotSupportedException();
        public IExecutionEnv Env => throw new NotSupportedException();
        public ShellOutputWindow OutputWindow => throw new NotSupportedException();

        public Task<Pi.Durable.Harness.Agent> AgentAsync(Context context) =>
            _conversation.AgentAsync(context);

        public ModelSpec? GetModel(string provider, string modelId) => null;
        public long Now() => FixedNow.ToUnixTimeMilliseconds();
        public void Output(string chunk, ShellOutputSkip? skipped = null) { }
        public void Output(byte[] chunk, ShellOutputSkip? skipped = null) { }
        public void Diagnostic(ToolDiagnostic diagnostic) { }
        public Task DetailsAsync(object? value, Context context) => Task.CompletedTask;

        public Task<T> CommitAsync<T>(Func<ITx, Task<T>> change, Context context)
        {
            CommitCount++;
            return _conversation.CommitAsync(change, context);
        }

        public Task<object?> MemoAsync(string name, Context context) =>
            Task.FromResult<object?>(null);

        public Task<object> MemoAsync(string name, object candidate, Context context) =>
            Task.FromResult(candidate);

        public Task<TaskId<object?>> CreateTaskAsync(
            AnyDurableTask task,
            object? input,
            TaskOptions options,
            Context context) =>
            throw new NotSupportedException();

        public Task<TaskRecord?> GetTaskAsync(TaskId<object?> id, Context context) =>
            throw new NotSupportedException();

        public Task<SettledTask> WaitForTaskAsync(TaskId<object?> id, Context context) =>
            throw new NotSupportedException();

        public Task<IConversationHandle?> ConversationAsync(ConversationId id, Context context) =>
            throw new NotSupportedException();

        public Task<IReadOnlyDictionary<string, object?>?> SnapshotAsync<T>(
            DocToken<T> token,
            Context context)
            where T : class, IReadOnlyDictionary<string, object?> =>
            _harness.SnapshotAsync(token, context);

        public Task<IReadOnlyDictionary<string, object?>?> SnapshotAsync<T>(
            DocToken<T> token,
            ConversationId conversationId,
            Context context)
            where T : class, IReadOnlyDictionary<string, object?> =>
            _harness.SnapshotAsync(token, conversationId, context);

        public Task<IReadOnlyDictionary<string, object?>?> SnapshotAsync<T>(
            DocToken<T> token,
            TaskId<object?> taskId,
            Context context)
            where T : class, IReadOnlyDictionary<string, object?> =>
            _harness.SnapshotAsync(token, taskId, context);

        public Task<IReadOnlyDictionary<string, object?>?> SnapshotAsync<T, TSeed>(
            DocFamilyToken<T, TSeed> token,
            string key,
            Context context)
            where T : class, IReadOnlyDictionary<string, object?> =>
            _harness.SnapshotAsync(token, key, context);

        public Task<IReadOnlyDictionary<string, object?>?> SnapshotAsync<T, TSeed>(
            DocFamilyToken<T, TSeed> token,
            ConversationId conversationId,
            string key,
            Context context)
            where T : class, IReadOnlyDictionary<string, object?> =>
            _harness.SnapshotAsync(token, conversationId, key, context);

        public Task<IReadOnlyDictionary<string, object?>?> SnapshotAsync<T, TSeed>(
            DocFamilyToken<T, TSeed> token,
            TaskId<object?> taskId,
            string key,
            Context context)
            where T : class, IReadOnlyDictionary<string, object?> =>
            _harness.SnapshotAsync(token, taskId, key, context);

        public Task<IReadOnlyDictionary<string, object?>?> SnapshotAsOfAsync<T>(
            DocToken<T> token,
            ConversationId conversationId,
            EntryId entryId,
            Context context)
            where T : class, IReadOnlyDictionary<string, object?> =>
            _harness.SnapshotAsOfAsync(token, conversationId, entryId, context);

        public Task<IReadOnlyDictionary<string, object?>?> SnapshotAsOfAsync<T, TSeed>(
            DocFamilyToken<T, TSeed> token,
            ConversationId conversationId,
            string key,
            EntryId entryId,
            Context context)
            where T : class, IReadOnlyDictionary<string, object?> =>
            _harness.SnapshotAsOfAsync(token, conversationId, key, entryId, context);

        public Task<IDocumentWatch<T>?> WatchDocAsync<T>(DocToken<T> token, Context context)
            where T : class, IReadOnlyDictionary<string, object?> =>
            _harness.WatchDocAsync(token, context);

        public Task<IDocumentWatch<T>?> WatchDocAsync<T>(
            DocToken<T> token,
            ConversationId conversationId,
            Context context)
            where T : class, IReadOnlyDictionary<string, object?> =>
            _harness.WatchDocAsync(token, conversationId, context);

        public Task<IDocumentWatch<T>?> WatchDocAsync<T>(
            DocToken<T> token,
            TaskId<object?> taskId,
            Context context)
            where T : class, IReadOnlyDictionary<string, object?> =>
            _harness.WatchDocAsync(token, taskId, context);

        public Task<IDocumentWatch<T>?> WatchDocAsync<T, TSeed>(
            DocFamilyToken<T, TSeed> token,
            string key,
            Context context)
            where T : class, IReadOnlyDictionary<string, object?> =>
            _harness.WatchDocAsync(token, key, context);

        public Task<IDocumentWatch<T>?> WatchDocAsync<T, TSeed>(
            DocFamilyToken<T, TSeed> token,
            ConversationId conversationId,
            string key,
            Context context)
            where T : class, IReadOnlyDictionary<string, object?> =>
            _harness.WatchDocAsync(token, conversationId, key, context);

        public Task<IDocumentWatch<T>?> WatchDocAsync<T, TSeed>(
            DocFamilyToken<T, TSeed> token,
            TaskId<object?> taskId,
            string key,
            Context context)
            where T : class, IReadOnlyDictionary<string, object?> =>
            _harness.WatchDocAsync(token, taskId, key, context);
    }
}
