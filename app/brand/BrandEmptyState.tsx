// Reusable branded empty state: the RiseIllustration plus the standard copy
// pattern (what the feature is, how to get data into it, one primary action).
// Built from a Polaris Card + Text + Button used normally (not recolored) and
// the brand illustration; native centering, no Polaris Grid. Replaces bare or
// generic empty states across the app for one consistent look.

import { Card, Box, BlockStack, Text, Button } from "@shopify/polaris";
import { RiseIllustration } from "~/brand/RiseIllustration";

export interface BrandEmptyStateAction {
  content: string;
  /** Internal route or external href. */
  url?: string;
  onClick?: () => void;
  /** Open in a new tab (theme editor, Shopify admin deep links, etc.). */
  external?: boolean;
  loading?: boolean;
}

export function BrandEmptyState({
  heading,
  body,
  primaryAction,
  children,
}: {
  heading: string;
  /** One or two plain sentences: what the feature is and how to get data in. */
  body?: string;
  primaryAction?: BrandEmptyStateAction;
  /** Optional extra content (e.g. a secondary note) below the body. */
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <Box padding="800">
        <BlockStack gap="400" inlineAlign="center">
          <RiseIllustration />
          <Text as="h2" variant="headingMd" alignment="center">
            {heading}
          </Text>
          {body ? (
            <div style={{ maxWidth: "34rem" }}>
              <Text as="p" tone="subdued" alignment="center">
                {body}
              </Text>
            </div>
          ) : null}
          {children}
          {primaryAction ? (
            <Button
              variant="primary"
              url={primaryAction.url}
              target={primaryAction.external ? "_blank" : undefined}
              onClick={primaryAction.onClick}
              loading={primaryAction.loading}
            >
              {primaryAction.content}
            </Button>
          ) : null}
        </BlockStack>
      </Box>
    </Card>
  );
}
