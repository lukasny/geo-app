# GEO Rise — Testing & Launch Checklist

---

## PART 1 — Local testing (run once before deploy)

### 1. Start the dev server

Open your terminal in VS Code (`Ctrl + `` `) and run:

```bash
cd ~/Desktop/geo-rise
npm run dev
```

Shopify CLI will:
- Print an installation URL like `https://partners.shopify.com/...`
- Open a tunnel to your localhost
- Auto-update `SHOPIFY_APP_URL` in your environment

### 2. Install on your dev store

Click the installation URL from the terminal output.
- Select your development store
- Click **Install**
- You should land on the GEO Rise onboarding wizard

---

## PART 2 — Feature testing checklist

Work through each item on your dev store. Check off as you go.

### A. Onboarding Wizard
- [ ] Fresh install shows the 4-step wizard (not the dashboard)
- [ ] Step 1: "Welcome" page loads with your store name
- [ ] Step 2: "Generate llms.txt" button works — shows spinner, then advances to step 3
- [ ] Skip button on step 2 advances to step 3
- [ ] Step 3: "Run Quick Audit" button works — shows spinner while running
- [ ] After audit: GEO score ring appears with your score
- [ ] "Continue →" advances to step 4 (theme extension)
- [ ] Step 4: "Open Theme Editor ↗" opens theme editor in a new tab
- [ ] "I've enabled it" button completes onboarding and loads dashboard
- [ ] "Skip for now" also completes onboarding

### B. Dashboard
- [ ] GEO score ring shows correct score
- [ ] Stats cards show: products audited count, issues found, llms.txt status
- [ ] "AI Citations" card shows lock icon on Free plan
- [ ] Quick Actions buttons work (Generate llms.txt, Re-run Audit)
- [ ] Upgrade callout shows for Free plan users
- [ ] Recent Activity list shows audit and llms.txt events
- [ ] Toast notifications appear after generating/auditing

### C. llms.txt Manager (`/app/llms-txt`)
- [ ] Page loads with stats (product count, file size, last generated date)
- [ ] Content settings (toggle products/collections/blogs) save correctly
- [ ] Bot access toggles save correctly
- [ ] "Generate" / "Regenerate" button works
- [ ] Preview section shows the generated content
- [ ] Copy button copies content to clipboard
- [ ] Download button downloads `llms.txt` file

### D. llms.txt public proxy
Open a new browser tab and visit:
`https://YOUR-STORE.myshopify.com/a/llms-txt`

- [ ] Returns plain text (not HTML)
- [ ] Shows your store name as `# heading`
- [ ] Shows `## Products` section with your products listed
- [ ] Shows `# AI Bot Access` section at the top
- [ ] File looks clean and readable

**Tip:** If you get a 404, the app proxy URL might not be deployed yet. This works fully after `shopify app deploy`.

### E. AI Readiness Audit (`/app/audit`)
- [ ] Page loads showing GEO score hero with ProgressBar
- [ ] Product table shows all products with score pills (colored by score)
- [ ] Search filter works (type a product name)
- [ ] Score range filter works (ChoiceList dropdown)
- [ ] Click a product row → modal opens showing all issues for that product
- [ ] Issues show severity badges (CRITICAL, HIGH, MEDIUM, LOW)
- [ ] "Run Audit" button at top runs a full re-audit
- [ ] "Auto-fix Issues" button runs auto-fix (generates meta descriptions + alt text)
- [ ] Free plan: only first 3 products are fully visible, rest are blurred

### F. AI Simulator (`/app/simulator`)
- [ ] Page loads with product picker dropdown
- [ ] Dropdown shows your products from the DB
- [ ] Select a product and click "Simulate"
- [ ] Loading skeleton appears while running
- [ ] Results show: visibility score banner, two-column layout
- [ ] Field rows show found/missing/partial status with icons
- [ ] Fix recommendations section shows specific advice per missing field

**Note:** If you get a timeout on the simulator, your dev store product page HTML might block the fetch (dev stores sometimes block external requests). The fallback mode (using Shopify data directly) will activate automatically.

### G. Pricing page (`/app/pricing`)
- [ ] All 4 plan cards show (Free, Growth $39, Pro $79, Enterprise $199)
- [ ] Growth has "MOST POPULAR" blue accent
- [ ] Free plan shows "CURRENT PLAN" if you haven't subscribed
- [ ] All 15 feature rows show correctly (green ✓ / gray ✗)
- [ ] "Start 7-day free trial" button redirects to Shopify billing page
- [ ] FAQ section loads at the bottom

### H. Billing flow (use test mode)
On the pricing page, click "Start 7-day free trial" for Growth:
- [ ] Redirects to Shopify billing confirmation page
- [ ] Shopify shows "GEO Rise - Growth" with $39/month price
- [ ] Shows 7-day trial period
- [ ] Click "Start free trial" to approve
- [ ] Redirects back to `/app/pricing?charge_id=...`
- [ ] App syncs subscription and shows "Plan updated successfully!" toast
- [ ] Current plan now shows as GROWTH with green "CURRENT PLAN" banner
- [ ] Dashboard: "AI Citations" card now shows a number (not lock icon)

**To test in test mode:** Shopify automatically uses test billing on dev stores. No real charges occur.

### I. Theme extension (JSON-LD schema)
1. Go to your dev store: Online Store → Themes → Customize
2. Click "App embeds" in the left sidebar
3. Toggle on "GEO Rise — AI Schema"
4. Click Save
5. Visit any product page on your storefront
6. Right-click → View Page Source → Ctrl+F for `application/ld+json`
- [ ] JSON-LD script tag is present in `<head>`
- [ ] Script contains `@type: "Product"` with your product details
- [ ] `name`, `description`, `offers` (price + availability) are present
- [ ] No Liquid errors in the page source

### J. Webhooks
**Products update:**
- Go to your Shopify admin → Products
- Edit any product title and save
- Check your dev server terminal — should see: `[GEO Rise] products/update webhook for your-store.myshopify.com`

**Subscription update:**
- Cancel your test subscription from the pricing page
- Terminal should show: `[GEO Rise] app_subscriptions/update webhook for your-store.myshopify.com`
- Plan should revert to FREE in the dashboard

**App uninstall** (test last!):
- Go to Shopify admin → Apps → GEO Rise → Delete
- Reinstall via `npm run dev` URL
- Onboarding wizard should appear (data was deleted)

---

## PART 3 — Deploy the theme extension

Once testing is complete, run this command once:

```bash
cd ~/Desktop/geo-rise
shopify app deploy --allow-updates
```

This uploads the theme extension to Shopify. After this:
- Merchants can find "GEO Rise — AI Schema" in their theme App Embeds
- The app proxy will work with your real production URL

---

## PART 4 — Shopify Partner Dashboard — Submission checklist

Log in at [partners.shopify.com](https://partners.shopify.com) and go to your GEO Rise app.

### App setup
- [ ] **App name:** GEO Rise
- [ ] **App URL:** Set to your production URL (Fly.io or Render — ask for help deploying)
- [ ] **Allowed redirection URL(s):** `https://YOUR-PRODUCTION-URL/auth/callback`
- [ ] **Privacy policy URL:** `https://YOUR-PRODUCTION-URL/privacy`
- [ ] **Terms of service URL:** `https://YOUR-PRODUCTION-URL/terms`
- [ ] **Support email:** hello@boda.no

### App listing
Go to: Distribution → Shopify App Store → Create listing

- [ ] **App name:** GEO Rise
- [ ] **Tagline:** Get your products recommended by ChatGPT, Gemini & AI search engines
- [ ] **Description:** Copy from `docs/app-store-listing.md`
- [ ] **Key benefits:** Copy the 6 bullet points from `docs/app-store-listing.md`
- [ ] **Category:** Search and discovery + Marketing and conversion
- [ ] **Pricing:** Add all 4 tiers (Free, $39/mo, $79/mo, $199/mo) with 7-day trial on paid

### Screenshots (minimum 3, maximum 8, size: 1600×900px)
Capture these from your dev store:
- [ ] Screenshot 1: Dashboard with GEO score ring
- [ ] Screenshot 2: AI Audit product table
- [ ] Screenshot 3: AI Simulator showing comparison
- [ ] Screenshot 4: llms.txt Manager
- [ ] Screenshot 5: Pricing page

**Tip:** Use a Mac screenshot: `Cmd+Shift+4` → select the area. Then resize to 1600×900 in Preview.

### App review requirements
Shopify reviews every app before publishing. Common rejection reasons:

- [ ] App loads in under 3 seconds (Shopify requirement)
- [ ] All features work on a real dev store
- [ ] Privacy policy is accessible without logging in (✅ `/privacy` is public)
- [ ] App doesn't request more scopes than it uses (we request `write_products`, `read_content`, `write_content`, `read_themes`, `read_orders` — be ready to justify each)
- [ ] Billing is implemented through Shopify's native billing API (✅ done)
- [ ] No external payment links
- [ ] App handles uninstall gracefully (✅ webhook deletes data)
- [ ] GDPR webhooks are handled (add these if not done — see below)

### GDPR webhooks (required for App Store)
Shopify requires 3 GDPR webhooks. Add these:

| Topic | What it does |
|---|---|
| `customers/data_request` | Merchant requests customer data — respond with what you have |
| `customers/redact` | Delete customer data for a specific customer |
| `shop/redact` | Delete all data for a shop (48h after uninstall) |

These are reviewed by Shopify but for GEO Rise (which doesn't collect *customer* data, only store/product data) the handlers can respond with 200 and log the request.

```
# Add to shopify.app.toml:
[[webhooks.subscriptions]]
topics = [ "customers/data_request" ]
uri = "/webhooks/customers/data_request"

[[webhooks.subscriptions]]
topics = [ "customers/redact" ]
uri = "/webhooks/customers/redact"

[[webhooks.subscriptions]]
topics = [ "shop/redact" ]
uri = "/webhooks/shop/redact"
```

### Before clicking Submit for Review
- [ ] App is deployed to production (not localhost)
- [ ] All 3 GDPR webhooks are implemented
- [ ] Tested billing flow end-to-end on a dev store
- [ ] Screenshots uploaded (1600×900px)
- [ ] Description and tagline filled in
- [ ] Privacy and Terms URLs point to live pages
- [ ] You have a test account set up for the Shopify review team to use

---

## PART 5 — Production deployment

When you're ready to deploy (not needed for testing, needed for App Store):

**Recommended: Fly.io** (fast, simple, Node.js friendly)

```bash
# Install Fly CLI
brew install flyctl

# Login
fly auth login

# Deploy from geo-rise folder
fly launch
fly deploy
```

Then set your environment variables on Fly:
```bash
fly secrets set DATABASE_URL="your-neon-connection-string"
fly secrets set ANTHROPIC_API_KEY="your-key"
fly secrets set SHOPIFY_API_KEY="your-key"
fly secrets set SHOPIFY_API_SECRET="your-secret"
fly secrets set SCOPES="write_products,read_content,write_content,read_themes,read_orders"
```

After deploy, update `application_url` in Shopify Partner Dashboard to your Fly.io URL.
