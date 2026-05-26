'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatBus } = require('../lib/chat-bus');

test('createChatBus exports a factory returning the documented API', () => {
  const bus = createChatBus();
  assert.equal(typeof bus.publish, 'function');
  assert.equal(typeof bus.subscribe, 'function');
  assert.equal(typeof bus.peekSequence, 'function');
  assert.equal(typeof bus.channels, 'function');
});

test('publish assigns monotonic per-channel sequence starting at 1', () => {
  const bus = createChatBus();
  const r1 = bus.publish('agent-x', { content: 'a' });
  const r2 = bus.publish('agent-x', { content: 'b' });
  const r3 = bus.publish('agent-y', { content: 'c' });
  const r4 = bus.publish('agent-x', { content: 'd' });
  assert.equal(r1.sequence, 1);
  assert.equal(r2.sequence, 2);
  assert.equal(r3.sequence, 1);
  assert.equal(r4.sequence, 3);
});

test('publish assigns ts from injected now() and enriches with channel + sequence + ts', () => {
  const bus = createChatBus({ now: () => '2026-05-11T00:00:00.000Z' });
  const result = bus.publish('agent-x', { content: 'hello', id: 'abc' });
  assert.equal(result.ts, '2026-05-11T00:00:00.000Z');
  assert.deepEqual(result.enriched, {
    content: 'hello',
    id: 'abc',
    channel: 'agent-x',
    sequence: 1,
    ts: '2026-05-11T00:00:00.000Z',
  });
});

test('subscribe receives messages published to the same channel', () => {
  const bus = createChatBus({ now: () => '2026-05-11T00:00:00.000Z' });
  const received = [];
  bus.subscribe('agent-x', (msg) => received.push(msg));
  bus.publish('agent-x', { content: 'first' });
  bus.publish('agent-x', { content: 'second' });
  assert.equal(received.length, 2);
  assert.equal(received[0].content, 'first');
  assert.equal(received[0].sequence, 1);
  assert.equal(received[1].content, 'second');
  assert.equal(received[1].sequence, 2);
});

test('channel isolation: subscribers do not receive messages for other channels', () => {
  const bus = createChatBus();
  const xReceived = [];
  const yReceived = [];
  bus.subscribe('agent-x', (msg) => xReceived.push(msg));
  bus.subscribe('agent-y', (msg) => yReceived.push(msg));
  bus.publish('agent-x', { content: 'x-only' });
  bus.publish('agent-y', { content: 'y-only' });
  assert.equal(xReceived.length, 1);
  assert.equal(yReceived.length, 1);
  assert.equal(xReceived[0].content, 'x-only');
  assert.equal(yReceived[0].content, 'y-only');
});

test('wildcard subscribers receive every published message', () => {
  const bus = createChatBus();
  const all = [];
  bus.subscribe('*', (msg) => all.push(msg));
  bus.publish('agent-x', { content: 'a' });
  bus.publish('agent-y', { content: 'b' });
  bus.publish('hivemind', { content: 'c' });
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((message) => message.channel), ['agent-x', 'agent-y', 'hivemind']);
});

test('unsubscribe removes a specific callback without affecting others', () => {
  const bus = createChatBus();
  const aReceived = [];
  const bReceived = [];
  const unsubscribeA = bus.subscribe('agent-x', (msg) => aReceived.push(msg));
  bus.subscribe('agent-x', (msg) => bReceived.push(msg));
  bus.publish('agent-x', { content: '1' });
  unsubscribeA();
  bus.publish('agent-x', { content: '2' });
  unsubscribeA();
  bus.publish('agent-x', { content: '3' });
  assert.equal(aReceived.length, 1);
  assert.equal(bReceived.length, 3);
});

test('subscriber throwing does not prevent other subscribers from firing', () => {
  const bus = createChatBus();
  const received = [];
  bus.subscribe('agent-x', () => {
    throw new Error('boom');
  });
  bus.subscribe('agent-x', (msg) => received.push(msg));
  bus.publish('agent-x', { content: 'still-delivered' });
  assert.equal(received.length, 1);
  assert.equal(received[0].content, 'still-delivered');
});

test('peekSequence returns 0 for unknown channel and high-water for known channel', () => {
  const bus = createChatBus();
  assert.equal(bus.peekSequence('unknown'), 0);
  bus.publish('agent-x', { content: 'a' });
  bus.publish('agent-x', { content: 'b' });
  bus.publish('agent-y', { content: 'c' });
  assert.equal(bus.peekSequence('agent-x'), 2);
  assert.equal(bus.peekSequence('agent-y'), 1);
  assert.equal(bus.peekSequence('unknown'), 0);
});

test('publish throws TypeError on bad inputs; subscribe throws TypeError on bad inputs', () => {
  const bus = createChatBus();
  assert.throws(() => bus.publish('', { content: 'x' }), { name: 'TypeError' });
  assert.throws(() => bus.publish(123, { content: 'x' }), { name: 'TypeError' });
  assert.throws(() => bus.publish('agent-x', null), { name: 'TypeError' });
  assert.throws(() => bus.publish('agent-x', 'not-an-object'), { name: 'TypeError' });
  assert.throws(() => bus.subscribe('', () => {}), { name: 'TypeError' });
  assert.throws(() => bus.subscribe('agent-x', null), { name: 'TypeError' });
  assert.throws(() => bus.subscribe('agent-x', 'not-a-function'), { name: 'TypeError' });
});
