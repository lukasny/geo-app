# Bing indexing guidance + sitemap check (F5): design spec

Date: 2026-07-02. Evidence basis: docs/geo-evidence-2026-07.md F5 (Layer 1:
ChatGPT runs on the Bing index, about 87% of its citations match Bing top
10). Approved by Lukas ("verify IndexNow rules then build F5"; "keep going
with whatever the verification says").

## The verification verdict (gating, resolved)

Auto-submission to IndexNow is NOT honestly buildable from a Shopify app
today, confirmed in workflow wq96zzvaw against indexnow.org and bing.com:

- The app-proxy key path is structurally dead: IndexNow's directory-prefix
  rule (quoted verbatim, indexnow.org/documentation) means a key served at
  /a/llms-txt/{key}.txt can only authorize URLs under /a/llms-txt/, never
  /products/... . keyLocation does not rescue this.
- The root-redirect key path (urlRedirectCreate /{key}.txt to the proxy)
  hinges on whether IndexNow validators follow a 301, which NO official
  source documents (raw HTML of all three official pages grepped; the only
  redirect language is about submitting content URLs that redirect). The
  only "it works" claims are unofficial Shopify blogs, and the one
  longitudinal report says it degrades after a few batches.
- The Bing Webmaster Tools URL Submission API needs no key file but requires
  each merchant to create a BWT account, verify their domain (DNS or GSC
  import; Shopify merchants cannot use the XML-file method), and paste a
  personal API key that grants access to ALL their BWT sites: heavy friction
  plus a sensitive credential to store.

Per the brief's explicit gate ("do not claim this works until verified"), v1
ships the brief's PRIMARY sketch honestly (guide the merchant to Bing
Webmaster Tools with numbered steps) plus one automated, verifiable check
(sitemap reachability), and an HONEST IndexNow note. No auto-submission, no
key hosting, no redirect trick, no new scope, no writes, no theme change, no
schema change. If the redirect behavior is ever proven by a live dev-store
test, auto-submission becomes a separate v2.

## What the merchant gets

A new "Bing Indexing" page (own route, free on every plan, matching the
robots.txt checker as an acquisition hook). It explains why Bing matters for
AI shopping (ChatGPT runs on the Bing index), runs an automated sitemap
reachability check, gives numbered Bing Webmaster Tools setup steps, and
honestly describes IndexNow and why the app cannot auto-submit it.

## Service (add to app/services/crawler-access.server.ts)

That module already owns resolveStorefrontBase (primary-domain resolver via a
fresh offline token) and readBoundedText (streaming 512 KiB cap). Reuse both
in-module (no new export of internals). Lightly widen the file header comment
to "storefront public-file checks (robots.txt + sitemap)".

Add:
- `export interface SitemapCheckResult { fetched: boolean; sitemapUrl:
  string; kind: "index" | "urlset" | "unknown"; entryCount: number; }`
  where fetched is true only on a definitive 200 read; sitemapUrl is
  `${primaryBase}/sitemap.xml`; kind detects `<sitemapindex` vs `<urlset` in
  the body; entryCount counts `<loc>` occurrences (child sitemaps for an
  index, pages for a urlset).
- `export async function checkSitemap(shopifyDomain: string):
  Promise<SitemapCheckResult>`: resolve the base, fetch
  `${base}/sitemap.xml` with the same 5s AbortSignal + readBoundedText the
  robots checker uses (follows redirects; the target is the merchant's own
  resolved primary domain, so no new SSRF surface and no throttle needed,
  it is an authenticated admin loader), count with a bounded regex, never
  throw (on timeout/network/non-2xx return fetched false, entryCount 0,
  kind "unknown").

Shopify auto-generates /sitemap.xml as a sitemapindex pointing at child
sitemaps (products, collections, pages, blogs); it is small, well under the
cap. Report honestly: a live index with N child sitemaps, or "could not
reach your sitemap" on failure.

## Route (new app/routes/app.bing-indexing.tsx + nav in app/routes/app.tsx)

- Loader: authenticate.admin, narrow Store field pick (id, shopifyDomain;
  NEVER a ...store spread, token-leak guardrail), call checkSitemap(store
  .shopifyDomain), return the result plus the sitemap URL. No plan gate
  (free). No Date objects in the payload.
- Page (Polaris only, standard tones, no recolor, no Grid, honest copy, no
  em or en dashes):
  1. Intro Card: why this page exists. "ChatGPT and Copilot answer shopping
     questions from the Bing index. Getting your store indexed by Bing is
     how you show up there." Cite the plain fact (ChatGPT runs on Bing);
     never promise placement.
  2. Sitemap check Card: the automated part. On success, a Badge tone
     success "Sitemap is live" plus "Your store's sitemap is live at
     {sitemapUrl} and lists {entryCount} child sitemaps. Submit this URL to
     Bing Webmaster Tools below." with the URL as an external Link. On
     failure, Badge tone warning "Could not reach your sitemap" plus the URL
     and "Shopify generates this automatically; if it is unreachable, check
     that your primary domain is live." A subdued note: this checks the
     sitemap is reachable, not whether Bing has indexed it (only Bing
     Webmaster Tools shows that, next section).
  3. Bing Webmaster Tools steps Card: numbered list. (1) Sign in at
     bing.com/webmasters with a Microsoft, Google, or Facebook account and
     add your store domain; importing from Google Search Console is the
     fastest verification, otherwise use DNS verification (Shopify merchants
     cannot host the HTML/XML verification file). (2) Submit your sitemap URL
     (shown above). (3) Open Sitemaps and Index Coverage, or use URL
     Inspection on a product URL, to see what Bing has indexed. A subdued
     line: "The site: search operator is not a reliable way to check
     indexation; use Bing Webmaster Tools." External Link to
     bing.com/webmasters.
  4. IndexNow note Card (honest, no false capability): "IndexNow lets sites
     tell Bing about new and changed pages instantly. Shopify does not let
     apps host the key file at your domain root that IndexNow requires, so
     GEO Rise cannot submit your URLs for you without an unofficial redirect
     workaround we will not ship until it is proven reliable. If you want
     IndexNow now, Bing Webmaster Tools can enable it for your verified
     site." External Link to the BWT IndexNow help. Never say "we submit
     your URLs".
- Nav: add `<Link to="/app/bing-indexing">Bing Indexing</Link>` after the
  llms.txt Manager link in app/routes/app.tsx.

## Explicitly out of scope (v1)

Any IndexNow key hosting, key-file redirect, or URL auto-submission (gated
by an unverified redirect behavior; needs a live dev-store test first);
storing a merchant BWT API key and using the BWT URL Submission API
(credential-storage and onboarding friction, a separate opt-in feature);
counting individual product URLs across child sitemaps (extra fetches; the
index-level count is enough for v1); any Store column or new model (nothing
to persist).

## Verification

Central: prisma generate not needed (no schema change), tsc, build, em-dash
scan on changed files. Focused adversarial review (honesty of every claim
vs the verification verdict; no false IndexNow capability; SSRF/bounded-read
correctness on the sitemap fetch; no ...store spread; nav/route wiring;
dashes). Fix confirmed findings, single commit (small coherent feature),
push, Render health check. No deploy needed (no theme, no scope). Smoke on
boda-brands: open Bing Indexing, confirm the sitemap check reports live with
a child count and the guidance renders.
