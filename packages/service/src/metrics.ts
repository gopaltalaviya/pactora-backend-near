import type {FastifyInstance} from 'fastify';
import {Counter, Gauge, Histogram, Registry, collectDefaultMetrics} from 'prom-client';
import {bearerMatches} from './http.js';

/**
 * Prometheus metrics.
 *
 * One registry per service, labelled with the service name, holding the Node
 * defaults (event loop lag, heap, GC) plus a request-duration histogram and
 * whatever counters the service defines. `/metrics` is guarded by
 * METRICS_TOKEN when one is set.
 */
export interface Metrics {
  registry: Registry;
  counter: <L extends string>(name: string, help: string, labelNames?: readonly L[]) => Counter<L>;
  gauge: <L extends string>(name: string, help: string, labelNames?: readonly L[]) => Gauge<L>;
}

export function createMetrics(service: string): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({service});
  collectDefaultMetrics({register: registry});
  return {
    registry,
    counter: (name, help, labelNames = []) =>
      new Counter({name, help, labelNames: [...labelNames], registers: [registry]}),
    gauge: (name, help, labelNames = []) =>
      new Gauge({name, help, labelNames: [...labelNames], registers: [registry]}),
  };
}

/**
 * @param opts.requireToken with no `token`, record durations but serve no
 *   `/metrics` at all. For a service with a public domain (the API): without
 *   it, every route name, status and request count was readable by anyone.
 */
export function registerMetrics(
  app: FastifyInstance,
  metrics: Metrics,
  opts: {token?: string; requireToken?: boolean} = {},
): void {
  const duration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration, by route template (never by raw URL — ids would explode the cardinality)',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [metrics.registry],
  });

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    if (route === '/metrics') return;
    duration.labels(request.method, route, String(reply.statusCode)).observe(reply.elapsedTime / 1000);
  });

  if (opts.requireToken && !opts.token) return;

  app.get('/metrics', async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, opts.token)) {
      return reply.status(401).send({code: 'UNAUTHORIZED', detail: 'metrics require METRICS_TOKEN'});
    }
    reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });
}
