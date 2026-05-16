// Public route — no Shopify auth required
export default function PrivacyPolicy() {
  return (
    <div
      style={{
        maxWidth: 760,
        margin: "0 auto",
        padding: "48px 24px",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color: "#202223",
        lineHeight: 1.7,
      }}
    >
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 4 }}>
        GEO Rise — Privacy Policy
      </h1>
      <p style={{ color: "#6D7175", marginBottom: 40 }}>
        Last updated: April 3, 2025
      </p>

      <Section title="1. Who we are">
        <p>
          GEO Rise is a Shopify app developed by Boda Apps (org. nr.
          placeholder). We help Shopify merchants improve their discoverability
          in AI-powered search engines such as ChatGPT, Gemini, and Perplexity.
          Questions about this policy can be directed to{" "}
          <a href="mailto:privacy@boda.no">privacy@boda.no</a>.
        </p>
      </Section>

      <Section title="2. Data we collect">
        <p>When you install GEO Rise, we collect and store:</p>
        <ul>
          <li>
            <strong>Store information:</strong> your Shopify store domain, store
            name, and contact email.
          </li>
          <li>
            <strong>Product data:</strong> product titles, descriptions, prices,
            images, and metadata — used to generate your llms.txt file and run
            AI readiness audits.
          </li>
          <li>
            <strong>Collection and blog data:</strong> collection names and blog
            post titles — included in llms.txt generation.
          </li>
          <li>
            <strong>Shopify access token:</strong> stored securely to make
            authenticated API calls on your behalf.
          </li>
          <li>
            <strong>Usage and analytics:</strong> audit scores, issue counts,
            and app activity — used to show you your GEO score and progress
            over time.
          </li>
        </ul>
        <p>
          We do <strong>not</strong> collect customer order data, customer
          personal information, or payment details.
        </p>
      </Section>

      <Section title="3. How we use your data">
        <p>Your data is used exclusively to provide the GEO Rise service:</p>
        <ul>
          <li>
            Generating your <code>llms.txt</code> file — a sitemap for AI
            engines.
          </li>
          <li>
            Running AI readiness audits on your products and generating your GEO
            score.
          </li>
          <li>
            Powering the AI Simulator feature, which shows how AI engines
            perceive your product pages.
          </li>
          <li>Tracking AI visibility and citation data (paid plans).</li>
          <li>Sending weekly insight emails (if enabled on paid plans).</li>
        </ul>
        <p>
          We do not sell, rent, or share your data with third parties for
          marketing purposes.
        </p>
      </Section>

      <Section title="4. Third-party services">
        <p>GEO Rise uses the following sub-processors:</p>
        <ul>
          <li>
            <strong>Anthropic (Claude API):</strong> Product descriptions and
            page content are sent to Anthropic&apos;s API to power the AI
            Simulator feature. Anthropic&apos;s privacy policy applies:{" "}
            <a
              href="https://www.anthropic.com/privacy"
              target="_blank"
              rel="noreferrer"
            >
              anthropic.com/privacy
            </a>
            .
          </li>
          <li>
            <strong>Neon.tech:</strong> Our PostgreSQL database is hosted on
            Neon&apos;s cloud infrastructure. Data is stored in the EU (Frankfurt
            region). Neon&apos;s privacy policy:{" "}
            <a href="https://neon.tech/privacy" target="_blank" rel="noreferrer">
              neon.tech/privacy
            </a>
            .
          </li>
          <li>
            <strong>Shopify:</strong> We access your store data through the
            Shopify Admin API under the scopes you grant at installation.
          </li>
        </ul>
      </Section>

      <Section title="5. Data retention">
        <p>
          We retain your store data for as long as GEO Rise is installed on your
          Shopify store. When you uninstall the app, we delete all your data
          from our systems within <strong>30 days</strong>.
        </p>
        <p>
          You can request immediate deletion at any time by contacting us at{" "}
          <a href="mailto:privacy@boda.no">privacy@boda.no</a>.
        </p>
      </Section>

      <Section title="6. GDPR compliance">
        <p>
          If you or your customers are located in the European Economic Area
          (EEA), you have the following rights under GDPR:
        </p>
        <ul>
          <li>
            <strong>Access:</strong> Request a copy of the data we hold about
            your store.
          </li>
          <li>
            <strong>Rectification:</strong> Request correction of inaccurate
            data.
          </li>
          <li>
            <strong>Erasure:</strong> Request deletion of your store data at any
            time.
          </li>
          <li>
            <strong>Portability:</strong> Request an export of your data in a
            machine-readable format.
          </li>
        </ul>
        <p>
          To exercise any of these rights, email{" "}
          <a href="mailto:privacy@boda.no">privacy@boda.no</a>. We will respond
          within 30 days.
        </p>
      </Section>

      <Section title="7. Security">
        <p>
          All data is transmitted over HTTPS. Shopify access tokens are stored
          encrypted. We follow Shopify&apos;s security best practices for app
          development. Our database provider (Neon) maintains SOC 2 compliance.
        </p>
      </Section>

      <Section title="8. Changes to this policy">
        <p>
          We may update this policy from time to time. If we make material
          changes, we will notify you via the GEO Rise admin panel. Continued
          use of the app after changes constitutes acceptance of the updated
          policy.
        </p>
      </Section>

      <Section title="9. Contact">
        <p>
          Boda Apps
          <br />
          Email: <a href="mailto:privacy@boda.no">privacy@boda.no</a>
          <br />
          Norway
        </p>
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 36 }}>
      <h2
        style={{
          fontSize: 18,
          fontWeight: 600,
          marginBottom: 12,
          borderBottom: "1px solid #E4E5E7",
          paddingBottom: 8,
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}
