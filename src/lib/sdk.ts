// src/lib/sdk.ts
//
// Munshot Dashboard SDK client adapter. ONE module-scoped client, created at
// import time so its window 'message' listener is attached before host:init can
// arrive — the handshake is host-initiated and a late listener misses it.

export const DASHBOARD_ID = "muns-13f-fund-tracker";
export const DASHBOARD_NAME = "13F Fund Tracker";

export interface SessionContext {
  token: string | null; // JWT bearer for Munshot APIs
  userName: string | null;
  email: string | null;
  orgId: string | null;
  orgName: string | null;
}

export interface MarketContext {
  selectedTicker: string | null;
  selectedTickerCompany: string | null;
  selectedTickerCountry: string | null;
  selectedSymbol: string | null;
}

export interface AppContext {
  route: string | null;
  query: string | null;
  viewMode: string | null;
  selectedCategory: string | null;
  searchQuery: string | null;
}

export interface DashboardHostContext {
  session?: SessionContext;
  market?: MarketContext;
  app?: AppContext;
}

export interface DashboardSdkEnvelope {
  namespace: string;
  version: string;
  channelId: string;
  source: "host" | "dashboard";
  kind: string;
  timestamp: number;
  requestId?: string;
  payload?: unknown;
}

export interface NormalizedTopic {
  topic: string;
  data: unknown;
  metadata?: unknown;
}

export interface TopicMeta {
  origin: string;
  topic: string;
  requestId?: string;
}

export interface DashboardClientSdk {
  getContext(): DashboardHostContext | null;
  getChannelId(): string | null;
  onMessage(handler: (envelope: DashboardSdkEnvelope, meta: { origin: string }) => void): () => void;
  onTopic(topic: string, handler: (t: NormalizedTopic, meta: TopicMeta, env: DashboardSdkEnvelope) => void): () => void;
  onRequest(
    topic: string,
    handler: (t: NormalizedTopic, meta: TopicMeta, env: DashboardSdkEnvelope) => unknown | Promise<unknown>,
  ): () => void;
  /** Sent by the SDK itself from inside its host:init handler. Never call it. */
  ready(): boolean;
  /** Returns a BOOLEAN, not a Promise. Never await it. */
  requestContext(): boolean;
  publish(topic: string, data?: unknown, metadata?: unknown): boolean;
  request(topic: string, data?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  sendError(message: string, code?: string, details?: unknown): boolean;
  destroy(): void;
}

export interface CreateClientConfig {
  dashboardId: string;
  dashboardName?: string;
  autoReady?: boolean;
  requestTimeoutMs?: number;
  maxPayloadBytes?: number;
  lockOriginOnFirstMessage?: boolean;
  /** MUST be an array — the SDK checks `.length`, so a Set silently disables it. */
  allowedOrigins?: string[];
  targetWindow?: Window | null;
  targetOrigin?: string;
}

type SdkFactory = (config: CreateClientConfig) => DashboardClientSdk;
type SdkCtor = new (config: CreateClientConfig) => DashboardClientSdk;

declare global {
  interface Window {
    MunshotDashboardSDK?: {
      createDashboardClientSdk?: SdkFactory;
      createClient?: SdkFactory;
      DashboardClientSdk?: SdkCtor;
      Client?: SdkCtor;
    };
  }
}

/** True when we are inside any iframe (cross-origin access throws). */
export function isEmbedded(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

/**
 * How the SDK actually resolved. The distinction matters because the two
 * failure modes look identical on screen but mean opposite things:
 *
 *   "standalone"  running `npm run dev` outside the host. Expected. Render a
 *                 dev banner and carry on with bundled/mock data.
 *   "missing"     inside an iframe but window.MunshotDashboardSDK is absent —
 *                 the script failed to load, or SRI rejected it. This is a
 *                 PRODUCTION AUTH FAILURE, and the naive no-op fallback would
 *                 render a merely-empty dashboard instead of an error, which
 *                 reads to the user as "there is no data" rather than "this is
 *                 broken".
 */
export type SdkMode = "live" | "standalone" | "missing";

export let sdkMode: SdkMode = "live";

function createNoopSdk(): DashboardClientSdk {
  return {
    getContext: () => null,
    getChannelId: () => null,
    onMessage: () => () => {},
    onTopic: () => () => {},
    onRequest: () => () => {},
    ready: () => false,
    requestContext: () => false,
    publish: () => false,
    request: async () => null,
    sendError: () => false,
    destroy: () => {},
  };
}

function initSdk(): DashboardClientSdk {
  const g = window.MunshotDashboardSDK;
  const config: CreateClientConfig = {
    dashboardId: DASHBOARD_ID,
    dashboardName: DASHBOARD_NAME,
    // Leave autoReady at its default (true): the SDK emits dashboard:ready from
    // inside its own host:init handler, once it knows the channelId. Calling
    // ready() manually before that sends channelId "pending-channel".
  };

  // The shipped bundle exports `createDashboardClientSdk`. The documented
  // `createClient` does not exist on it — a trailing `var` in the bundle
  // clobbers the inner global. Probe in this order.
  const factory = g?.createDashboardClientSdk ?? g?.createClient;
  if (typeof factory === "function") {
    try {
      return factory(config);
    } catch (err) {
      console.error("[13f] SDK factory failed", err);
    }
  }

  const Ctor = g?.DashboardClientSdk ?? g?.Client;
  if (typeof Ctor === "function") {
    try {
      return new Ctor(config);
    } catch (err) {
      console.error("[13f] SDK constructor failed", err);
    }
  }

  if (isEmbedded()) {
    sdkMode = "missing";
    console.error(
      "[13f] Embedded in an iframe but window.MunshotDashboardSDK is absent. " +
        "The SDK script failed to load (network, or an SRI mismatch). The dashboard " +
        "has no session and cannot authenticate.",
    );
  } else {
    sdkMode = "standalone";
    console.warn("[13f] Running outside the Munshot host; using the no-op SDK.");
  }
  return createNoopSdk();
}

/** One client for the whole app. */
export const sdk: DashboardClientSdk = initSdk();

/**
 * Host-request handlers. Both must be registered and neither may throw — the
 * host awaits a response and surfaces nothing if one never arrives.
 *
 * The capture response is capped at 512 KB structured-cloneable. A full-page
 * PNG of a dense holdings table blows past that routinely, so size is checked
 * before returning rather than discovered as a silent host timeout.
 */
export const CAPTURE_MAX_BYTES = 512 * 1024;

export function registerCaptureHandlers(opts: {
  captureBlob: () => Promise<Blob | null>;
  snapshot: () => unknown;
}): () => void {
  const offVisual = sdk.onRequest("dashboard.capture.visual", async () => {
    try {
      const blob = await opts.captureBlob();
      if (!blob) throw new Error("capture root not found");
      if (blob.size > CAPTURE_MAX_BYTES) {
        return {
          ok: false,
          error: `snapshot ${Math.round(blob.size / 1024)}KB exceeds the ${CAPTURE_MAX_BYTES / 1024}KB host limit`,
        };
      }
      return { visualSnapshot: blob, capturedAt: new Date().toISOString() };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  const offSnapshot = sdk.onRequest("dashboard.capture.snapshot", () => {
    try {
      return opts.snapshot();
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  return () => {
    offVisual();
    offSnapshot();
  };
}
