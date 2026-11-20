import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createMetrics } from '../src/metrics.js';
import { createMemoryRepository } from '../src/repositories/memory.js';

async function counterValue(metrics, name, labels = {}) {
  const metric = await metrics.register.getSingleMetric(name).get();

  const sample = metric.values.find((value) =>
    Object.entries(labels).every(
      ([key, expected]) => value.labels[key] === expected,
    ),
  );

  return sample ? sample.value : 0;
}

describe('Métriques Prometheus', () => {
  let app;
  let log;
  let metrics;

  beforeEach(() => {
    log = vi.fn();

    metrics = createMetrics({
      appVersion: '1.2.3',
      collectDefaults: false,
    });

    app = createApp({
      repository: createMemoryRepository(),
      appEnv: 'test',
      appVersion: '1.2.3',
      log,
      metrics,
    });
  });

  it('GET /metrics répond au format texte Prometheus', async () => {
    const response = await request(app).get('/metrics');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.text).toContain('# TYPE http_requests_total counter');
    expect(response.text).toContain(
      '# TYPE http_request_duration_seconds histogram',
    );
    expect(response.text).toContain('taskflow_build_info{version="1.2.3"} 1');
  });

  it('compte les requêtes par route normalisée', async () => {
    const created = await request(app)
      .post('/api/tasks')
      .send({ title: 'Mesurer' });

    await request(app).patch(`/api/tasks/${created.body.id}/toggle`);

    const response = await request(app).get('/metrics');

    expect(response.text).toContain('route="/api/tasks"');
    expect(response.text).toContain('route="/api/tasks/:id/toggle"');
    expect(response.text).not.toContain(`/api/tasks/${created.body.id}`);
  });

  it('regroupe les routes inconnues sous unmatched', async () => {
    await request(app).get('/une/url/inconnue');
    await request(app).get('/encore-une');

    const count = await counterValue(metrics, 'http_requests_total', {
      route: 'unmatched',
      status_code: '404',
    });

    expect(count).toBe(2);
  });

  it('mesure les erreurs 500', async () => {
    const failingRepository = {
      ...createMemoryRepository(),
      list: () => Promise.reject(new Error('base injoignable')),
    };

    const failingApp = createApp({
      repository: failingRepository,
      log,
      metrics,
    });

    await request(failingApp).get('/api/tasks');

    const count = await counterValue(metrics, 'http_requests_total', {
      method: 'GET',
      status_code: '500',
    });

    expect(count).toBe(1);
  });

  it('incrémente la métrique métier après une création réussie', async () => {
    await request(app).post('/api/tasks').send({ title: 'a' });
    await request(app).post('/api/tasks').send({ title: 'b' });
    await request(app).post('/api/tasks').send({ title: '' });

    expect(await counterValue(metrics, 'taskflow_tasks_created_total')).toBe(2);
  });

  it('ne logge pas et ne compte pas /metrics', async () => {
    await request(app).get('/metrics');
    await request(app).get('/metrics');

    expect(log).not.toHaveBeenCalled();

    const count = await counterValue(metrics, 'http_requests_total', {
      route: 'unmatched',
    });

    expect(count).toBe(0);
  });
});
