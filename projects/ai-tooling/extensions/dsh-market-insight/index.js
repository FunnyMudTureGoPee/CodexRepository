/**
 * Plugin Insight — Host half.
 *
 * Registers the read-only JSON API the «洞察 / Insight» tab reads:
 *   GET  /dsh-market-insight/api/status
 *   GET  /dsh-market-insight/api/search
 *   GET  /dsh-market-insight/api/entry
 *   POST /dsh-market-insight/api/refresh
 *
 * The data pipeline lives in `host/`; this file only wires it to the Host services and
 * owns the lifetime of the route registration.
 */
import { InsightStore } from './host/store.mjs';
import { createApiHandler, API_PREFIX } from './host/api.mjs';

/** The HTTP carrier is required; the market and manager services are waited for below. */
export const inject = ['webServer'];

/**
 * Register the API route, then load the market once both data services are available.
 * @param ctx - the Host plugin context.
 */
export function apply(ctx) {
  const store = new InsightStore({ logger: ctx.logger?.('market-insight') });

  ctx.effect(() => () => {
    store.dispose();
  }, 'market-insight: store');

  const handler = createApiHandler({ store });
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler,
  }), 'market-insight: http routes');

  ctx.effect(() => ctx.inject(['pluginMarket', 'pluginManager'], (injected) => {
    store.setServices({
      pluginMarket: injected.pluginMarket,
      pluginManager: injected.pluginManager,
    });
    store.start();
    return () => {
      store.dispose();
    };
  }), 'market-insight: market data');
}
