import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { RemixServer, isRouteErrorResponse } from "@remix-run/react";
import {
  createReadableStreamFromReadable,
  type EntryContext,
  type HandleErrorFunction,
} from "@remix-run/node";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";
import { captureError } from "./services/error-capture.server";

// Side-effect import: boots the in-process tracking-check scheduler exactly
// once per server lifetime (HMR-safe via a globalThis guard). See
// services/scheduler.server.ts.
import "./services/scheduler.server";

// Central server-side error hook (Remix v2): called for errors thrown from
// loaders, actions, and document rendering. captureError console.errors,
// dedupes into ErrorEvent, and emails OPS_ALERT_EMAIL, all fire-and-forget
// and never throwing, so this hook cannot slow down or fail a response.
export const handleError: HandleErrorFunction = (error, { request }) => {
  // Aborted requests are the client navigating away mid-load, not failures.
  if (request.signal.aborted) return;
  // Thrown Response instances are Remix control flow (redirects, the
  // authenticate.admin bounce, intentional 4xx), not errors.
  if (error instanceof Response) return;
  // Router-generated ErrorResponses (adversarial-review fix): Remix's router
  // delivers its INTERNAL 404s here as ErrorResponseImpl objects (neither
  // instanceof Response nor Error), one per unmatched path. A public host
  // gets scanned for /wp-login.php and friends daily; capturing those would
  // fill ErrorEvent with "[object Object]" rows and burn the 5-per-day alert
  // cap on noise, starving alerts for real errors. Genuine loader/action
  // errors never arrive as ErrorResponses in this setup, so nothing real is
  // skipped.
  if (isRouteErrorResponse(error)) return;
  captureError(`route:${new URL(request.url).pathname}`, error);
};

export const streamTimeout = 5000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext
) {
  addDocumentResponseHeaders(request, responseHeaders);
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? '')
    ? "onAllReady"
    : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <RemixServer
        context={remixContext}
        url={request.url}
      />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            })
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          console.error(error);
        },
      }
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}
