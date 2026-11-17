# Anthropic IPO Pulse

Anthropic IPO Pulse is an orchestrator Actor that tracks how the internet talks about the Anthropic (Nasdaq: ANT) IPO. It collects posts from X, LinkedIn, YouTube, Threads and stock news. Each post is scored by an LLM for sentiment, relevance, how extreme the take is, and its topic. The Actor saves daily aggregates and the most over-optimistic and over-pessimistic quotes to a named key-value store, where a website can read them.

## What it does

| Step | Actor | Interface |
|---|---|---|
| X search, day by day (four 6-hour slices) or the live window | [xquik/x-tweet-scraper](https://apify.com/xquik/x-tweet-scraper) | Actor run |
| LinkedIn posts | [harvestapi/linkedin-post-search](https://apify.com/harvestapi/linkedin-post-search) | Actor run |
| YouTube videos | [streamers/youtube-scraper](https://apify.com/streamers/youtube-scraper) | Actor run |
| Threads posts (keyword search) | [lergassy/threads-scraper](https://apify.com/lergassy/threads-scraper) | Actor run |
| Stock news | [publicmoney/marketwatch-scraper](https://apify.com/publicmoney/marketwatch-scraper), [publicmoney/yahoo-finance-scraper](https://apify.com/publicmoney/yahoo-finance-scraper) (news mode) | Standby HTTP |
| Quotes | [publicmoney/yahoo-finance-scraper](https://apify.com/publicmoney/yahoo-finance-scraper), [publicmoney/nasdaq-scraper](https://apify.com/publicmoney/nasdaq-scraper) | Standby HTTP |
| Ticker news sentiment | [publicmoney/sentiment-mini](https://apify.com/publicmoney/sentiment-mini) | Standby HTTP |
| Post scoring | [apify/openrouter](https://apify.com/apify/openrouter) | Standby HTTP |

## Modes

- **backfill**: collects every day from `dateFrom` to `dateTo` and writes them to the baseline. Run it once.
- **daily**: collects yesterday. Schedule it at 00:15 UTC so LinkedIn's "newest first" results cover the day that just ended.
- **news**: sweeps MarketWatch and Yahoo Finance news only. Schedule it every 2 hours, because the feeds keep only about a day of stories.
- **rescore**: no scraping. Re-scores posts already saved in `<storeName>-posts` for the date range and rebuilds those days, storylines included. Use it when a run hit its LLM budget, or once to add topics to posts scored before topics existed (they are sent to the LLM again).
- **live**: snapshots the last `liveWindowMinutes` (default 15) for X and Threads, plus the news sweep and quotes. Schedule it every 15 minutes on IPO day. LinkedIn and YouTube stay daily-only.

## Sentiment sampling

The LLM scores up to `maxScoredPerPlatformDay` (default 300) posts per platform per UTC day: the most-engaged third, so the quote wall gets the strongest takes, plus an even spread of the rest. Volume counts every collected post; the relevant count is volume × the relevance rate of the scored sample. News is always scored in full.

## Topics and storylines

The scoring prompt also tags every relevant post with one topic:

| Topic | Covers |
|---|---|
| `valuation` | price, valuation, IPO pricing, first-day pop |
| `bubble` | AI bubble or overvaluation fears |
| `governance` | Long-Term Benefit Trust, founder control, public benefit corporation structure, board |
| `safety` | AI safety and Anthropic's mission |
| `access` | retail access, allocations, how and where to buy |
| `rivals` | comparisons with OpenAI, SpaceX, Nvidia or other listings |
| `business` | Claude products, revenue, customers, losses, compute |
| `insiders` | lockups, employee and investor selling, early backers |
| `macro` | rates, markets, Nasdaq mood |
| `other` | none of these |

After backfill, daily and rescore runs write a day's aggregates, the Actor makes one more LLM call per day. It sends up to 40 of the day's most-engaged relevant scored posts and asks for at most 3 storylines, each citing 1 to 4 of those posts. Links the LLM did not get are dropped, and so is a storyline left without a link. Days with fewer than 8 relevant scored posts are skipped. If the call fails, the day keeps its previous storylines and the run carries on.

## Output

The named key-value store (default `anthropic-ipo`) holds these records:

- `baseline`: per UTC day and per platform, the volume, relevant post count, engagement, sentiment sums, bull/bear/neutral counts, the top quotes on each side, and whether a page cap was hit. It also holds the daily quote and ticker-sentiment snapshots. Each day and platform also carries:
  - `topics`: per topic, `n` (judged relevant posts with a score) and `sentimentSum` (the sum of their scores). Divide to get the topic's average sentiment.
  - `extremeBull` and `extremeBear`: judged relevant posts with an extremeness of 0.7 or more, by stance.
  - `storylines`: per UTC day, up to 3 objects with `title` (70 characters at most), `summary` (one sentence, 180 characters at most), `stance`, `topic` and `urls` (1 to 4 source posts).
- `live` and `live-timeline`: the latest live window and its history. Timeline entries carry each platform's `topics` too.
- `costs`: the estimated Apify spend per step and per run.
- `meta`: the queries, model and Actors used.

Every scored post goes to the run's dataset and to the named dataset `<storeName>-posts`, with its `topic` (`null` when the post was not scored or is not about Anthropic).

## Cost control

Set **Max total charge (USD)** on the run. The budget is split evenly across the seven steps (X, LinkedIn, YouTube, Threads, news, markets, LLM). Each batch Actor run gets its share as `maxTotalChargeUsd`, and each Standby step stops once its estimated spend reaches its share. A daily run with default settings costs about $1, so give it a cap of about $3: the even split leaves each step about $0.43, enough for LinkedIn's roughly $0.30. A live snapshot costs about $0.25 (cap $1), so a 12-hour IPO day at 4 snapshots an hour is about $12.

Storylines add one LLM call per day, about $0.005 with the default model, so a daily run costs under a cent more. The topic field adds a few output tokens per scored post. A rescore that adds topics to posts scored before topics existed re-scores up to `maxScoredPerPlatformDay` posts per platform per day, about $0.10 per day of history. It only spends on the LLM step, which gets one eighth of the cap, so give it a cap of about 8 times the LLM spend you expect.

## Requirements

The account must be able to use `apify/openrouter` (it works on the free plan). If scoring fails, posts are still counted for volume but carry no sentiment.

## License

[MIT](LICENSE)
