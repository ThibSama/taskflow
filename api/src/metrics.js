import client from 'prom-client';

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2];

function routeLabel(req) {
  if (!req.route) return 'unmatched';

  const route = `${req.baseUrl}${req.route.path}`;
  return route.length > 1 ? route.replace(/\/$/, '') : route;
}

export function createMetrics({
  appVersion = 'dev',
  collectDefaults = true,
} = {}) {
  const register = new client.Registry();

  if (collectDefaults) {
    client.collectDefaultMetrics({ register });
  }

  const httpRequestsTotal = new client.Counter({
    name: 'http_requests_total',
    help: 'Nombre de requêtes HTTP traitées',
    labelNames: ['method', 'route', 'status_code'],
    registers: [register],
  });

  const httpRequestDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Durée de traitement des requêtes HTTP en secondes',
    labelNames: ['method', 'route', 'status_code'],
    buckets: DURATION_BUCKETS,
    registers: [register],
  });

  const tasksCreatedTotal = new client.Counter({
    name: 'taskflow_tasks_created_total',
    help: 'Nombre de tâches créées depuis le démarrage',
    registers: [register],
  });

  const buildInfo = new client.Gauge({
    name: 'taskflow_build_info',
    help: "Version de l'API actuellement exécutée",
    labelNames: ['version'],
    registers: [register],
  });

  buildInfo.set({ version: appVersion }, 1);

  function middleware(req, res, next) {
    const stopTimer = httpRequestDuration.startTimer();

    res.on('finish', () => {
      const labels = {
        method: req.method,
        route: routeLabel(req),
        status_code: String(res.statusCode),
      };

      httpRequestsTotal.inc(labels);
      stopTimer(labels);
    });

    next();
  }

  async function handler(_req, res) {
    res.set('Content-Type', register.contentType);
    res.send(await register.metrics());
  }

  return Object.freeze({
    register,
    middleware,
    handler,
    taskCreated: () => tasksCreatedTotal.inc(),
  });
}
