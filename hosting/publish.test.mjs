import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import worker from './worker.mjs';
import { sendSnapshot } from './send.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const time = hour => new Date(Date.UTC(2025, 5, 1, hour)).toISOString();
function fixture(hour, price = hour, version = 1, attributes = {}) {
  const observedAt = time(hour);
  const products = [{ shopToken: 'shop', shopName: '示例', goodsKey: 'abc', title: 'Team 10X',
    price, priceSymbol: '¥', stockCount: 2, minQuantity: 1, inStock: true, brand: 'unknown',
    brandInferred: false, form: 'account', imageUrl: null, itemUrl: 'https://wzyp.cn/item/abc',
    observedAt, changes: [], comparisonKey: null, specificationHash: null,
    ...(version === 2 ? {brand:'chatgpt', plan:'plus', brandEvidence:'title', specLabel:'成品账号'} : {}), ...attributes }];
  const snapshot = JSON.stringify({schemaVersion: version, checkedAt: observedAt, products}) + '\n';
  const sha256 = sha(snapshot);
  const manifest = { schemaVersion: version, ...(version === 2 ? {source:'live'} : {}), checkedFrom: observedAt, checkedAt: observedAt, productCount: 1,
    shopCount: 1, scopeCount: 1, sha256, snapshot: 'snapshots/' + sha256 + '.json',
    semanticHash: sha(JSON.stringify(products.map(({observedAt, ...values}) => values))),
    seenHash: sha('[]'), historyComplete: true };
  return { manifest, snapshot };
}

class MemoryBucket {
  values = new Map();
  stamp = 0;
  async head(key) {
    const record = this.values.get(key);
    return record ? { etag: record.etag, httpEtag: '"' + record.etag + '"' } : null;
  }
  async get(key) {
    const record = this.values.get(key);
    if (!record) return null;
    return { ...await this.head(key), body: record.value, json: async () => JSON.parse(record.value), text: async () => record.value };
  }
  async put(key, value, {onlyIf}) {
    if (this.intercept) await this.intercept(key);
    if (this.fail === key) throw new Error('simulated storage failure');
    if (onlyIf instanceof Headers) {
      assert.equal(onlyIf.get('If-None-Match'), '*');
      if (this.values.has(key)) return null;
    } else if (onlyIf.etagMatches !== this.values.get(key)?.etag) {
      return null;
    }
    this.values.set(key, { value, etag: String(++this.stamp) });
    return this.head(key);
  }
}

function site() {
  const QUOTES = new MemoryBucket();
  const url = 'https://site.test';
  const request = async (u, init) => worker.fetch(new Request(u, init), {QUOTES, PUBLISH_TOKEN: 'test-only',
    ASSETS: {fetch: () => new Response('static')}});
  const post = (envelope, token = 'test-only') => request(url + '/_publish', {
    method: 'POST', headers: {Authorization: 'Bearer ' + token}, body: JSON.stringify(envelope)});
  const read = name => request(url + '/data/' + name);
  return { QUOTES, url, request, post, read };
}

test('serves both generations and refuses archive uploads and contradictory v2 classifications', async () => {
  const {post, read} = site();
  const old = fixture(1), current = fixture(2, 1, 2);
  assert.equal((await post(old)).status, 200);
  assert.equal((await post({...current, manifest:{...current.manifest,source:'archive'}})).status, 400);
  for (const attrs of [{plan:'max'}, {brand:'codex'}, {brandEvidence:'category'}, {specLabel:''}]) {
    assert.equal((await post(fixture(2, 1, 2, attrs))).status, 400);
  }
  assert.deepEqual(await (await read('manifest.json')).json(), old.manifest);
  assert.equal((await post(current)).status, 200);
  assert.deepEqual(await (await read('manifest.json')).json(), current.manifest);
  assert.equal(await (await read(old.manifest.snapshot)).text(), old.snapshot);
  assert.equal((await post(fixture(3))).status, 409);
});

test('refuses invalid, unauthenticated or incomplete publication; reuses confirmed bytes on later round', async () => {
  const {post, read, QUOTES} = site();
  const f = fixture(1);
  assert.equal((await post(f, 'wrong')).status, 401);
  assert.equal((await post({manifest: f.manifest})).status, 428);
  assert.equal((await post({...f,snapshot: f.snapshot + ' '})).status, 400);
  assert.equal((await post({...f,manifest:{...f.manifest, productCount:3}})).status, 400);
  assert.equal((await post({...f,manifest:{...f.manifest, semanticHash:sha('oops')}})).status, 400);
  assert.equal((await read('manifest.json')).status, 404);
  assert.equal((await post(f)).status, 200);
  const oldTag = (await QUOTES.head(f.manifest.snapshot)).etag;
  const renewal = {...f.manifest, checkedFrom:time(2), checkedAt:time(2)};
  assert.equal((await post({manifest:renewal})).status, 200);
  assert.equal((await QUOTES.head(f.manifest.snapshot)).etag, oldTag);
  const before = (await QUOTES.head('manifest.json')).etag;
  assert.equal((await (await post({manifest:renewal})).json()).unchanged, true);
  assert.equal((await QUOTES.head('manifest.json')).etag, before);
  assert.equal(await (await read(f.manifest.snapshot)).text(), f.snapshot);
  assert.deepEqual(await (await read('manifest.json')).json(), renewal);
  assert.equal((await post(f)).status, 409);
});

test('both object and pointer write failures leave the previously published pair readable', async () => {
  const {post, read, QUOTES} = site();
  const a = fixture(1), b = fixture(2);
  await post(a);
  for (const key of [b.manifest.snapshot, 'manifest.json']) {
    QUOTES.fail = key;
    assert.equal((await post(b)).status, 503);
    assert.deepEqual(await (await read('manifest.json')).json(), a.manifest);
    assert.equal(await (await read(a.manifest.snapshot)).text(), a.snapshot);
  }
  QUOTES.fail = null;
  assert.equal((await post(b)).status, 200);
});

test('CAS rejects an older in-flight commit even if its bytes finish uploading last', async () => {
  const {post, read, QUOTES} = site();
  const a = fixture(1), b = fixture(2), c = fixture(3);
  await post(a);
  QUOTES.intercept = async key => {
    if (key !== 'manifest.json') return;
    QUOTES.intercept = null;
    assert.equal((await post(c)).status, 200);
  };
  assert.equal((await post(b)).status, 409);
  assert.deepEqual(await (await read('manifest.json')).json(), c.manifest);
  assert.equal((await post({...c,manifest:{...c.manifest,checkedFrom:time(2),checkedAt:time(4)}})).status, 409);
});

test('sender is opt-in, avoids redirects and sends only a manifest for a previously published snapshot', async t => {
  const {url, request, read} = site();
  const dir = await mkdtemp(join(tmpdir(),'team-price-publish-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const a = fixture(1);
  await mkdir(join(dir,'snapshots'));
  await writeFile(join(dir,'manifest.json'), JSON.stringify(a.manifest));
  await writeFile(join(dir,a.manifest.snapshot), a.snapshot);
  assert.equal((await sendSnapshot({outputDir:dir,url:'',token:''})).skipped, true);
  await assert.rejects(sendSnapshot({outputDir:dir,url,token:''}));
  await assert.rejects(sendSnapshot({outputDir:dir,url:'http://site.test',token:'test-only'}));
  const calls = [];
  const options = {outputDir:dir,url,token:'test-only',request: (u, init) => {
    assert.equal(init.redirect,'error'); calls.push(Boolean(JSON.parse(init.body).snapshot));
    return request(u, init);
  }};
  assert.equal((await sendSnapshot(options)).published, true);
  assert.equal((await sendSnapshot(options)).unchanged, true);
  assert.deepEqual(calls,[false,true,false]);
  assert.deepEqual(await (await read('manifest.json')).json(), a.manifest);
  await writeFile(join(dir,'manifest.json'), JSON.stringify({...a.manifest, schemaVersion:2, source:'archive'}));
  await assert.rejects(sendSnapshot(options), /历史回放/);
  assert.deepEqual(calls,[false,true,false]);
});
