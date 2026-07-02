// Public route - no Shopify auth required.
// The privacy policy now lives on the marketing site; this route only
// redirects so old links (Partner Dashboard, App Store listing, in-app
// footers) keep working.
import { redirect } from "@remix-run/node";

export const loader = () => redirect("https://georise.app/privacy", 301);
