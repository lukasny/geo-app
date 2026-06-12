# GEO Rise: Product Roadmap (June 2026)

Distilled from the 2026-06-12 full-app review (merchant-journey pass + competitive gap analysis, both grounded in a complete read of the code). The 28 confirmed bugs and the pricing/revenue/email honesty fixes from that review shipped the same day (commit 14567c9); this doc is what to BUILD next.

## Position

The shipped surface is already broader than most Shopify GEO apps: llms.txt with multi-market support, JSON-LD embed, 100-point audit with auto-fix, multi-platform citation tracking, Intent Lab (signal-sourced prompt suggestions, genuinely differentiated), competitor monitoring, blog generator, bulk edit, weekly digests, half-active revenue attribution. Standalone AI-visibility SaaS tools (Profound, Peec, Otterly) cost 2x to 10x more and are not Shopify-native. The gaps below separate "broad" from "category-winning".

## Ranked build-next list

Effort assumes a Claude Code-assisted solo founder. Tiers push the $19 Growth upgrade (volume) and reserve analytics depth for Pro.

| # | Feature | Effort | Tier | Why |
|---|---|---|---|---|
| 1 | AI crawler access checker + robots.txt.liquid snippet generator | 2-3 days | Free checker / Growth config | The current "AI bot access" toggles only write comment lines into llms.txt that no crawler honors. Real control lives in robots.txt. Fetch {shop}/robots.txt, report per-bot allow/block (GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended), generate a matching robots.txt.liquid snippet, and warn when a WAF blocks AI bots. Converts the app's weakest credibility point into its best demo moment and a perfect free onboarding hook. |
| 2 | AI crawler analytics on the llms.txt proxy | 1-2 days | Free teaser / Growth detail | proxy.llms-txt.ts already receives real requests and logs nothing. One AiCrawlerHit table + user-agent classification = "GPTBot fetched your llms.txt 14 times this week", the most persuasive dashboard stat in the category. The data is currently thrown away. |
| 3 | AI traffic beacon (visits now, revenue later) | 2-3 days | Growth visits / Pro revenue | Theme extension pings an app-proxy endpoint on AI-referred visits, writing AiTrafficEvent rows with no protected-customer-data exposure. Lights up "127 AI-referred visits this month" TODAY while orders/paid awaits approval, and makes the Pro revenueAttribution flag mean something. |
| 4 | Product FAQ generator + FAQPage JSON-LD | 4-6 days | Growth, metered like blog posts | FAQ content is the most-extracted block in AI answers and every serious schema competitor ships it. The machinery exists: Claude generation + sanitizeLlmHtml + metafield writes + the theme embed. Also add shippingDetails and hasMerchantReturnPolicy to the Offer block. |
| 5 | GEO score history + trend | 1-2 days | All plans | One ScoreSnapshot row per audit, a sparkline on the dashboard hero, and a "54 to 61 this week" delta in the insight email. Creates the visible weekly payoff that justifies the habit and the subscription. The dashboard currently looks identical between visits. |
| 6 | llms-full.txt + per-entry updated dates | 1-2 days | Growth | Trivial extension of the generator (descriptions currently truncate at 300 chars); becoming table stakes among llms.txt apps. |
| 7 | Public shareable GEO score badge/page | 2-3 days | Free (it is marketing) | Store.geoScore renders only in the admin. A public badge page is a free acquisition loop; a "scan any store" teaser later is the classic top-of-funnel for this category. Nobody on the App Store does it yet. |
| 8 | Verify schema embed + llms.txt are actually live | 1-2 days | All plans | Replace the wizard's honor-system "I've enabled it" click with a server-side storefront fetch that looks for the embed's JSON-LD; create a /llms.txt to /a/llms-txt URL redirect via urlRedirectCreate on first generation (AI crawlers look at the root path, not the proxy path). The app's two foundational claims become provable. |
| 9 | Gemini tracking platform | 2-3 days | Pro | Adds a real fourth platform and a genuine Pro differentiator. |
| 10 | Brand entity pack (sameAs, logo, description in Organization schema) | 2-3 days | Growth | LLMs resolve brands through entity signals; current Organization schema emits only name, url, email. |
| 11 | Bing presence check + IndexNow on product change | 3-5 days | Pro | ChatGPT search leans on Bing's index. Design caveat: IndexNow key-file hosting via app proxy is awkward. |
| 12 | Shopify Flow triggers (score drop, critical issues, first citation) | 3-5 days | Enterprise | Only after 1-11; the pricing row was removed until this exists. |

Items 1+2 first: cheapest, fix the credibility gap, and generate the daily-changing numbers that drive retention.

## Retention fixes that are not new features

- Auto-fix and full audits run as single unbounded HTTP requests; for large catalogs (exactly the merchants who pay most) chunk auto-fix into client-driven batches of ~10 with "Fixed 40 of 120" progress (the maxIssues option already exists), and make runFullAudit write-then-swap so a mid-flight failure never leaves a half-empty issue list.
- Onboarding for trial merchants should auto-run Intent Lab and pre-create 2-3 weekly-scheduled prompts, so week-one emails and competitor pages are not empty.
- Alerting: first-ever citation, lost citation, competitor overtake. The data already sits in AiCitation; these are the emotionally resonant moments in the category and nothing notifies anyone today.

## Cut list (decided)

- contentEngine flag: removed 2026-06-12. The blog generator + bulk edit ARE the content engine; rebrand in marketing if desired, build nothing separate.
- euComplianceModule flag: removed 2026-06-12. Different product, real liability, no synergy; a distraction for a solo founder.
- Shopify Flow: deferred, pricing row removed until built.

## Known constraints to design around

- Revenue attribution stays half-active until Protected Customer Data approval; all surfaces now disclose this honestly.
- The retention engine (cron) is in-process on a single Render instance; deploys skip ticks. Acceptable now; revisit if instances scale.
- Free tier has no day-2 loop by design; conversion levers are the wizard wow-step, honest pricing, and (once built) the score trend visible during the 7-day trial.
