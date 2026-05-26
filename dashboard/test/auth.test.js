'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createAuthMiddleware } = require('../middleware/auth');

const VALID_TOKEN = 'b'.repeat(64);

function makeReqRes(headers = {}, query = {}) {
  const req = { headers, query };
  let statusCode = null;
  let body = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };
  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };

  return { req, res, next, get: () => ({ statusCode, body, nextCalled }) };
}

test('auth: missing header → 401', () => {
  const mw = createAuthMiddleware(VALID_TOKEN);
  const ctx = makeReqRes({});

  mw(ctx.req, ctx.res, ctx.next);

  const result = ctx.get();
  assert.strictEqual(result.statusCode, 401);
  assert.strictEqual(result.nextCalled, false);
});

test('auth: malformed header (no Bearer) → 401', () => {
  const mw = createAuthMiddleware(VALID_TOKEN);
  const ctx = makeReqRes({ authorization: VALID_TOKEN });

  mw(ctx.req, ctx.res, ctx.next);

  assert.strictEqual(ctx.get().statusCode, 401);
});

test('auth: wrong-length token → 401 (timingSafeEqual fast-fail)', () => {
  const mw = createAuthMiddleware(VALID_TOKEN);
  const ctx = makeReqRes({ authorization: 'Bearer short' });

  mw(ctx.req, ctx.res, ctx.next);

  assert.strictEqual(ctx.get().statusCode, 401);
});

test('auth: same-length wrong token → 401', () => {
  const mw = createAuthMiddleware(VALID_TOKEN);
  const ctx = makeReqRes({ authorization: `Bearer ${'c'.repeat(64)}` });

  mw(ctx.req, ctx.res, ctx.next);

  assert.strictEqual(ctx.get().statusCode, 401);
});

test('auth: correct token → next() called', () => {
  const mw = createAuthMiddleware(VALID_TOKEN);
  const ctx = makeReqRes({ authorization: `Bearer ${VALID_TOKEN}` });

  mw(ctx.req, ctx.res, ctx.next);

  const result = ctx.get();
  assert.strictEqual(result.nextCalled, true);
  assert.strictEqual(result.statusCode, null);
});

test('auth: case-insensitive Bearer prefix → next() called', () => {
  const mw = createAuthMiddleware(VALID_TOKEN);
  const ctx = makeReqRes({ authorization: `bearer ${VALID_TOKEN}` });

  mw(ctx.req, ctx.res, ctx.next);

  assert.strictEqual(ctx.get().nextCalled, true);
});

test('auth: leading whitespace in token → 401 (no trim)', () => {
  const mw = createAuthMiddleware(VALID_TOKEN);
  const ctx = makeReqRes({ authorization: `Bearer  ${VALID_TOKEN}` });

  mw(ctx.req, ctx.res, ctx.next);

  assert.strictEqual(ctx.get().statusCode, 401);
});

test('auth: query token → next() called', () => {
  const mw = createAuthMiddleware(VALID_TOKEN);
  const ctx = makeReqRes({}, { token: VALID_TOKEN });

  mw(ctx.req, ctx.res, ctx.next);

  const result = ctx.get();
  assert.strictEqual(result.nextCalled, true);
  assert.strictEqual(result.statusCode, null);
});

test('auth: malformed header does not block valid query token', () => {
  const mw = createAuthMiddleware(VALID_TOKEN);
  const ctx = makeReqRes({ authorization: 'Basic nope' }, { token: VALID_TOKEN });

  mw(ctx.req, ctx.res, ctx.next);

  assert.strictEqual(ctx.get().nextCalled, true);
});

test('createAuthMiddleware: empty token throws', () => {
  assert.throws(() => createAuthMiddleware(''), /non-empty string/);
  assert.throws(() => createAuthMiddleware(null), /non-empty string/);
  assert.throws(() => createAuthMiddleware(undefined), /non-empty string/);
});
