// src/hooks/useHostContext.ts
import { useEffect, useState } from "react";
import { sdk, type SessionContext, type MarketContext } from "../lib/sdk";

const EMPTY_SESSION: SessionContext = {
  token: null, userName: null, email: null, orgId: null, orgName: null,
};

/**
 * Mirror the host's context into React state.
 *
 * Two things that look like details and are not:
 *
 *  1. sdk.getContext() is SYNCHRONOUS and is called once on mount before any
 *     listener is attached. The handshake is host-initiated, so host:init has
 *     often already arrived and been cached by the time React renders — a
 *     listener-only implementation would sit empty until the next update.
 *
 *  2. sdk.requestContext() returns a BOOLEAN, not a Promise. Awaiting it
 *     resolves immediately to `true` and silently does nothing useful.
 */
export function useHostContext() {
  const [session, setSession] = useState<SessionContext>(EMPTY_SESSION);
  const [market, setMarket] = useState<MarketContext | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const sync = () => {
      const ctx = sdk.getContext();
      if (!ctx) return;
      if (ctx.session) setSession({ ...EMPTY_SESSION, ...ctx.session });
      if (ctx.market) setMarket(ctx.market);
      setReady(true);
    };

    sync();                      // apply anything host:init already cached
    const off = sdk.onMessage(sync); // then re-sync on every host message
    sdk.requestContext();        // nudge, in case the host is waiting on us
    return off;
  }, []);

  return { session, market, ready, token: session.token };
}
