import test from 'node:test';
import assert from 'node:assert/strict';
import { hourlyCycle } from './hourly.mjs';

test('failed, partial and overlapping collections cannot invoke remote publication', async () => {
  for (const status of ['failed', 'partial', 'busy']) {
    let uploads = 0;
    const result = await hourlyCycle({ publishUrl: 'https://example.org', token: 'test-only',
      collectAndPublish: async () => ({ status, published: false }), upload: async () => { uploads++; } });
    assert.equal(result.status, status);
    assert.equal(uploads, 0);
  }
});

test('failed remote delivery is visible independently from successful local capture', async () => {
  const result = await hourlyCycle({ publishUrl: 'https://example.org', token: 'test-only',
    collectAndPublish: async () => ({ status: 'success', published: true }),
    upload: async () => { throw new Error('transport failed'); } });
  assert.equal(result.remoteStatus, 'failed');
  assert.equal(result.published, true);
});
