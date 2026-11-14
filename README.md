# Anthropic IPO Pulse

Anthropic IPO Pulse is an orchestrator Actor that tracks how the internet talks about the Anthropic (Nasdaq: ANT) IPO. It collects posts from X, LinkedIn, YouTube and stock news. Each post is scored by an LLM for sentiment, relevance and how extreme the take is. The Actor saves daily aggregates and the most over-optimistic and over-pessimistic quotes to a named key-value store, where a website can read them.

## What it does

| Step | Actor | Interface |
|---|---|---|
| X search, day by day or the last hour | [apidojo/x-api](https://apify.com/apidojo/x-api) | Standby HTTP |
| LinkedIn posts | [harvestapi/linkedin-post-search](https://apify.com/harvestapi/linkedin-post-search) | Actor run |
| YouTube videos | [streamers/youtube-scraper](https://apify.com/streamers/youtube-scraper) | Actor run |
| Threads posts (keyword search) | [lergassy/threads-scraper](https://apify.com/lergassy/threads-scraper) | Actor run |
| Truth Social posts (watch list of profiles) | [automation-lab/truth-social-scraper](https://apify.com/automation-lab/truth-social-scraper) | Actor run |
| Stock news | [publicmoney/marketwatch-scraper](https://apify.com/publicmoney/marketwatch-scraper), [publicmoney/yahoo-finance-scraper](https://apify.com/publicmoney/yahoo-finance-scraper) (news mode) | Standby HTTP |
| Quotes | [publicmoney/yahoo-finance-scraper](https://apify.com/publicmoney/yahoo-finance-scraper), [publicmoney/nasdaq-scraper](https://apify.com/publicmoney/nasdaq-scraper) | Standby HTTP |
| Ticker news sentiment | [publicmoney/sentiment-mini](https://apify.com/publicmoney/sentiment-mini) | Standby HTTP |
| Post scoring | [apify/openrouter](https://apify.com/apify/openrouter) | Standby HTTP |

## Modes

- **backfill**: collects every day from `dateFrom` to `dateTo` and writes them to the baseline. Run it once.
- **daily**: collects yesterday. Schedule it at 00:15 UTC so LinkedIn's "newest first" results cover the day that just ended.
- **news**: sweeps MarketWatch and Yahoo Finance news only. Schedule it every 2 hours, because the feeds keep only about a day of stories.
- **live**: snapshots the last `liveWindowMinutes` across every platform. Schedule it every 10 minutes on IPO day.

## Output

The named key-value store (default `anthropic-ipo`) holds these records:

- `baseline`: per UTC day and per platform, the volume, relevant post count, engagement, sentiment sums, bull/bear/neutral counts, the top quotes on each side, and whether a page cap was hit. It also holds the daily quote and ticker-sentiment snapshots.
- `live` and `live-timeline`: the latest live window and its history.
- `costs`: the estimated Apify spend per step and per run.
- `meta`: the queries, model and Actors used.

Every scored post goes to the run's dataset and to the named dataset `<storeName>-posts`.

## Cost control

Set **Max total charge (USD)** on the run. The budget is split evenly across the eight steps (X, LinkedIn, YouTube, Threads, Truth Social, news, markets, LLM). Each batch Actor run gets its share as `maxTotalChargeUsd`, and each Standby step stops once its estimated spend reaches its share. A daily run with default settings costs about $0.80–1.20, so give it a cap of about $3: the even split leaves each step about $0.37, enough for LinkedIn's roughly $0.30.

## Requirements

The account must be able to use `apify/openrouter`, which needs a paid plan. If scoring fails, posts are still counted for volume but carry no sentiment.
