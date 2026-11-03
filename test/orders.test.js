import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { app } from '../src/app.js';

async function get(path) {
  const server = app.listen(0);
  if (!server.listening) await once(server, 'listening');
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test('GET /api/orders/:orderId returns only allow-listed fields', async () => {
  const { status, body } = await get('/api/orders/ORD-100200');
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ['estimatedDelivery', 'id', 'lastUpdated', 'status']);
  assert.equal(body.id, 'ORD-100200');
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /@|customer|phone|payment|shipping/i);
});

test('GET /api/orders/:orderId rejects malformed ids with 400', async () => {
  for (const id of ['123', 'ORD-12345', 'ORD-1234567', 'ord-123456', 'ORD-12345a']) {
    const { status, body } = await get(`/api/orders/${id}`);
    assert.equal(status, 400, id);
    assert.deepEqual(body, { error: 'Order numbers look like ORD-123456' });
  }
});

test('GET /api/orders/:orderId returns 404 for unknown orders', async () => {
  const { status, body } = await get('/api/orders/ORD-000000');
  assert.equal(status, 404);
  assert.deepEqual(body, { error: 'Order not found' });
});
