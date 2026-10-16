import type { NextRequest } from "next/server";
import { authFailure } from "@/lib/api";
import { authenticateAdmin } from "@/lib/auth";
import { config } from "@/lib/config";
import { getBus, snapshot } from "@/lib/store";
import type { StreamMessage } from "@/lib/types";
import { withApiLog } from "@/lib/api-log";

/**
 * GET /api/events - the Server-Sent Events stream behind the live dashboard.
 *
 * SSE rather than WebSockets: traffic is one-directional (commands travel as
 * ordinary POSTs), so we get automatic browser reconnection, plain-HTTP proxy
 * compatibility, and no second server process alongside Next.js.
 *
 * The first message is a full snapshot so a client that has just connected is
 * immediately consistent; after that each message carries only what changed.
 */
export const dynamic = "force-dynamic";

async function handleGET(request: NextRequest): Promise<Response> {
  const auth = authenticateAdmin(request);
  if (!auth.ok) return authFailure(auth);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;

      const send = (message: StreamMessage) => {
        if (!open) return;
        // This stream mirrors the heater fleet. A sensor board has its own
        // page and its own API, and must not appear here as a heater.
        if (message.kind === "device" && message.device.deviceType !== "heater") return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
        } catch {
          // The client vanished between the liveness check and the write.
          open = false;
        }
      };

      const initial = await snapshot();
      send({
        kind: "snapshot",
        devices: initial.devices,
        stats: initial.stats,
        t: initial.now,
      });

      const unsubscribe = getBus().subscribe(send);

      // Comment-only keep-alive. Idle SSE connections are otherwise reaped by
      // proxies and load balancers after a minute or so of silence, and a
      // quiet fleet is exactly when nothing has anything to say.
      const keepAlive = setInterval(() => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          open = false;
        }
      }, config.sseKeepAliveMs);

      const close = () => {
        if (!open) return;
        open = false;
        clearInterval(keepAlive);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      };

      request.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      // Nginx buffers proxied responses by default, which would hold every
      // event until the buffer filled and make a "live" dashboard lag by minutes.
      "x-accel-buffering": "no",
    },
  });
}

export const GET = withApiLog("/api/events", handleGET);
