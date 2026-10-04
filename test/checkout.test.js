import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createApp } from '../src/server.js';
import {
  normalizeItemInput,
  normalizeCheckoutInput,
  normalizeReturnInput,
  matchUsage,
  summarizeCheckout,
} from '../src/checkout.js';

let baseUrl;
let server;
let db;

before(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const { SCHEMA } = await import('../src/db.js');
  db.exec(SCHEMA);
  const app = createApp(db);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function call(method, p, body) {
  const res = await fetch(baseUrl + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({ error: 'not-json' }));
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString();
const cfg = { holes: 4, tolerance: 1, holeMaxMass: [100, 100, 100, 100] };
const tube = (id, mass) => ({ id, mass, usableHoles: [0, 1, 2, 3] });

async function makeReservation(batchNo, pubId, startMs, endMs) {
  const r = await call('POST', '/api/reservations', {
    batchNo,
    publicationId: pubId,
    startUtc: iso(startMs),
    endUtc: iso(endMs),
  });
  assert.equal(r.status, 201, `${batchNo}: ${JSON.stringify(r.json)}`);
  return r.json.id;
}

async function registerItem(serial, mass) {
  const r = await call('POST', '/api/weight-items', { serial, mass });
  assert.equal(r.status, 201, `${serial}: ${JSON.stringify(r.json)}`);
  return r.json;
}

async function checkout(reservationId, items) {
  return call('POST', '/api/checkouts', { reservationId, items });
}

let pubId;
const resv = {};

// ---------- 纯函数 ----------

test('纯函数：登记输入规整（合法/非法）', () => {
  const ok = normalizeItemInput({ serial: ' W-001 ', mass: 50 });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.clean, { serial: 'W-001', mass: 50 });

  for (const body of [
    null,
    {},
    { serial: '  ', mass: 50 },
    { serial: 'W', mass: 0 },
    { serial: 'W', mass: -1 },
    { serial: 'W', mass: '50' },
    { serial: 'W', mass: NaN },
    { serial: 'W' },
    { mass: 50 },
  ]) {
    const r = normalizeItemInput(body);
    assert.ok(r.errors.length > 0, JSON.stringify(body));
    assert.equal(r.clean, null);
  }
});

test('纯函数：领用输入规整（合法/非法）', () => {
  const ok = normalizeCheckoutInput({ reservationId: 2, items: [' A ', 'B'] });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.clean, { reservationId: 2, serials: ['A', 'B'] });

  for (const body of [
    null,
    {},
    { reservationId: 0, items: ['A'] },
    { reservationId: 1.5, items: ['A'] },
    { reservationId: 'x', items: ['A'] },
    { reservationId: 1 },
    { reservationId: 1, items: [] },
    { reservationId: 1, items: 'A' },
    { reservationId: 1, items: ['A', 'A'] },
    { reservationId: 1, items: ['A', 5] },
    { reservationId: 1, items: [' '] },
  ]) {
    const r = normalizeCheckoutInput(body);
    assert.ok(r.errors.length > 0, JSON.stringify(body));
    assert.equal(r.clean, null);
  }
});

test('纯函数：归还输入规整（合法/非法）', () => {
  const ok = normalizeReturnInput({
    items: [
      { serial: 'A', condition: 'intact' },
      { serial: ' B ', condition: 'damaged' },
    ],
  });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.clean, {
    items: [
      { serial: 'A', condition: 'intact' },
      { serial: 'B', condition: 'damaged' },
    ],
  });

  for (const body of [
    null,
    {},
    { items: [] },
    { items: 'A' },
    { items: [{ serial: 'A' }] },
    { items: [{ serial: 'A', condition: 'ok' }] },
    { items: [{ serial: ' ', condition: 'intact' }] },
    { items: [{ condition: 'intact' }] },
    { items: [{ serial: 'A', condition: 'intact' }, { serial: 'A', condition: 'damaged' }] },
    { items: ['A'] },
  ]) {
    const r = normalizeReturnInput(body);
    assert.ok(r.errors.length > 0, JSON.stringify(body));
    assert.equal(r.clean, null);
  }
});

test('纯函数：按规格精确匹配冻结占用量', () => {
  const usage = [
    { mass: 50, count: 2 },
    { mass: 100, count: 1 },
  ];
  const exact = matchUsage(
    [
      { serial: 'a', mass: 50 },
      { serial: 'b', mass: 50 },
      { serial: 'c', mass: 100 },
    ],
    usage,
  );
  assert.equal(exact.ok, true);

  // 数量不足
  assert.equal(matchUsage([{ serial: 'a', mass: 50 }], usage).ok, false);
  // 数量超出
  assert.equal(
    matchUsage(
      [
        { serial: 'a', mass: 50 },
        { serial: 'b', mass: 50 },
        { serial: 'c', mass: 50 },
        { serial: 'd', mass: 100 },
      ],
      usage,
    ).ok,
    false,
  );
  // 包含占用量之外的规格
  const extra = matchUsage(
    [
      { serial: 'a', mass: 50 },
      { serial: 'b', mass: 50 },
      { serial: 'c', mass: 100 },
      { serial: 'e', mass: 25 },
    ],
    usage,
  );
  assert.equal(extra.ok, false);
  assert.ok(extra.errors.join(' ').includes('25'));
  // 空占用量须空清单
  assert.equal(matchUsage([], []).ok, true);
  assert.equal(matchUsage([{ serial: 'a', mass: 50 }], []).ok, false);
});

test('纯函数：领用单汇总（未还件/逾期/完结）', () => {
  const endMs = Date.parse('2026-10-04T09:00:00.000Z');
  const items = [
    { serial: 'A', returnedAt: null },
    { serial: 'B', returnedAt: '2026-10-04T08:00:00.000Z' },
  ];
  const open = summarizeCheckout(items, endMs, Date.parse('2026-10-04T08:30:00.000Z'));
  assert.deepEqual(open, {
    total: 2,
    returnedCount: 1,
    unreturnedCount: 1,
    unreturned: ['A'],
    status: 'open',
    overdue: false,
    closedAt: null,
  });
  // 过了预约终点且仍有未还件 → 逾期
  const overdue = summarizeCheckout(items, endMs, Date.parse('2026-10-04T09:00:00.001Z'));
  assert.equal(overdue.overdue, true);
  assert.equal(overdue.status, 'open');
  // 恰在终点不算逾期（与运行超时口径一致）
  assert.equal(
    summarizeCheckout(items, endMs, endMs).overdue,
    false,
  );
  // 全部归还 → closed，closedAt 取最后一件归还时间
  const closed = summarizeCheckout(
    [
      { serial: 'A', returnedAt: '2026-10-04T10:00:00.000Z' },
      { serial: 'B', returnedAt: '2026-10-04T08:00:00.000Z' },
    ],
    endMs,
    Date.parse('2026-10-04T11:00:00.000Z'),
  );
  assert.equal(closed.status, 'closed');
  assert.equal(closed.overdue, false);
  assert.equal(closed.closedAt, '2026-10-04T10:00:00.000Z');
  assert.deepEqual(closed.unreturned, []);
});

// ---------- HTTP：准备 ----------

test('准备：配置、离心管、配重块与发布（冻结图占用 50 g × 1）', async () => {
  await call('PUT', '/api/config', cfg);
  await call('PUT', '/api/tubes', [tube('A', 50), tube('B', 50), tube('C', 50)]);
  await call('PUT', '/api/weights', [
    { mass: 50, quantity: 8 },
    { mass: 100, quantity: 1 },
  ]);
  await call('POST', '/api/solve');
  const p = await call('POST', '/api/publish');
  assert.equal(p.status, 201, JSON.stringify(p.json));
  pubId = p.json.id;
  assert.deepEqual(
    p.json.result.arrangement.filter((s) => s && s.kind === 'weight').map((s) => s.mass),
    [50],
  );
});

// ---------- HTTP：实物编号登记 ----------

test('登记：201 新建；同号同规格 200 幂等；同号异规格 409', async () => {
  const a = await registerItem('W50-A', 50);
  assert.equal(a.status, 'active');
  assert.equal(a.checkedOut, false);
  await registerItem('W50-B', 50);
  await registerItem('W100-A', 100);

  const replay = await call('POST', '/api/weight-items', { serial: 'W50-A', mass: 50 });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.serial, 'W50-A');

  const diff = await call('POST', '/api/weight-items', { serial: 'W50-A', mass: 100 });
  assert.equal(diff.status, 409);
  assert.ok(diff.json.errors.join(' ').includes('不同'));

  const list = await call('GET', '/api/weight-items');
  assert.equal(list.status, 200);
  assert.equal(list.json.length, 3);
});

test('登记：超库存 409；未知规格 400；非法输入 400；均不留记录', async () => {
  // 100 g 库存 1，已登记 W100-A
  const over = await call('POST', '/api/weight-items', { serial: 'W100-B', mass: 100 });
  assert.equal(over.status, 409);
  assert.ok(over.json.errors.join(' ').includes('超过库存'));
  assert.equal(over.json.detail.capacity, 1);
  assert.equal(over.json.detail.registered, 1);

  const unknown = await call('POST', '/api/weight-items', { serial: 'W-X', mass: 999 });
  assert.equal(unknown.status, 400);
  assert.ok(unknown.json.errors.join(' ').includes('未知质量规格'));

  for (const body of [{ serial: '', mass: 50 }, { serial: 'W-Y', mass: -5 }, {}]) {
    const r = await call('POST', '/api/weight-items', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const list = await call('GET', '/api/weight-items');
  assert.equal(list.json.length, 3);
});

// ---------- HTTP：领用 ----------

test('领用校验：未知预约/未登记实物/清单不符 400；时段外/已取消 409；不留记录', async () => {
  const now = Date.now();
  resv.ongoing1 = await makeReservation('CO-RESV-1', pubId, now - 3600_000, now + 3600_000);
  resv.future = await makeReservation('CO-RESV-FUT', pubId, now + 7200_000, now + 10800_000);
  resv.past = await makeReservation('CO-RESV-PAST', pubId, now - 10800_000, now - 7200_000);
  resv.cancel = await makeReservation('CO-RESV-CXL', pubId, now + 7200_000, now + 10800_000);
  const cx = await call('POST', `/api/reservations/${resv.cancel}/cancel`);
  assert.equal(cx.status, 200);

  // 未知预约
  let r = await checkout(999999, ['W50-A']);
  assert.equal(r.status, 400);
  // 非法输入
  for (const body of [
    {},
    { reservationId: resv.ongoing1 },
    { reservationId: resv.ongoing1, items: [] },
    { reservationId: resv.ongoing1, items: ['W50-A', 'W50-A'] },
  ]) {
    r = await call('POST', '/api/checkouts', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  // 未登记实物
  r = await checkout(resv.ongoing1, ['W-NOPE']);
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('未登记'));
  // 清单与冻结占用量不符：数量超出（冻结占用 50 g × 1）
  r = await checkout(resv.ongoing1, ['W50-A', 'W50-B']);
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('精确匹配'));
  // 清单与冻结占用量不符：规格不在占用量内
  r = await checkout(resv.ongoing1, ['W100-A']);
  assert.equal(r.status, 400);
  // 未到领用时段
  r = await checkout(resv.future, ['W50-A']);
  assert.equal(r.status, 409);
  assert.ok(r.json.errors.join(' ').includes('尚未到领用时段'));
  // 已过预约终点
  r = await checkout(resv.past, ['W50-A']);
  assert.equal(r.status, 409);
  assert.ok(r.json.errors.join(' ').includes('不能领用'));
  // 预约已取消
  r = await checkout(resv.cancel, ['W50-A']);
  assert.equal(r.status, 409);
  assert.ok(r.json.errors.join(' ').includes('已取消'));

  const list = await call('GET', '/api/checkouts');
  assert.equal(list.json.length, 0);
});

test('领用成功：201，冻结预约时段与占用量；查询展示未还件与状态', async () => {
  const r = await checkout(resv.ongoing1, ['W50-A']);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const co = r.json;
  assert.equal(co.reservationId, resv.ongoing1);
  assert.equal(co.batchNo, 'CO-RESV-1');
  assert.equal(co.status, 'open');
  assert.equal(co.overdue, false);
  assert.equal(co.closedAt, null);
  assert.deepEqual(co.unreturned, ['W50-A']);
  assert.equal(co.items.length, 1);
  assert.deepEqual(co.items[0], {
    serial: 'W50-A',
    mass: 50,
    state: 'out',
    returnedAt: null,
  });
  assert.deepEqual(co.reservation.usage, [{ mass: 50, count: 1 }]);
  assert.equal(co.reservation.currentStatus, 'active');
  resv.co1 = co.id;

  const got = await call('GET', `/api/checkouts/${co.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.json.id, co.id);

  const byResv = await call('GET', `/api/checkouts?reservationId=${resv.ongoing1}`);
  assert.equal(byResv.status, 200);
  assert.equal(byResv.json.length, 1);
  assert.equal(byResv.json[0].id, co.id);
  const badFilter = await call('GET', '/api/checkouts?reservationId=abc');
  assert.equal(badFilter.status, 400);

  const items = await call('GET', '/api/weight-items');
  const wa = items.json.find((i) => i.serial === 'W50-A');
  assert.equal(wa.checkedOut, true);
  assert.equal(wa.checkoutId, co.id);

  const notFound = await call('GET', '/api/checkouts/999999');
  assert.equal(notFound.status, 404);
});

test('同一预约只可领用一次：同内容 200 原单，异内容 409', async () => {
  const replay = await checkout(resv.ongoing1, ['W50-A']);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.id, resv.co1);

  const diff = await checkout(resv.ongoing1, ['W50-B']);
  assert.equal(diff.status, 409);
  assert.equal(diff.json.existingId, resv.co1);

  const list = await call('GET', '/api/checkouts');
  assert.equal(list.json.length, 1);
});

test('占用冲突：未归还实物不能被其他领用单占用', async () => {
  const now = Date.now();
  resv.ongoing2 = await makeReservation('CO-RESV-2', pubId, now - 3600_000, now + 3600_000);
  // W50-A 被领用单 #co1 占用
  const busy = await checkout(resv.ongoing2, ['W50-A']);
  assert.equal(busy.status, 409);
  assert.ok(busy.json.errors.join(' ').includes('占用'));
  // 换一件在册实物 → 成功
  const ok = await checkout(resv.ongoing2, ['W50-B']);
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  resv.co2 = ok.json.id;
});

// ---------- HTTP：归还 ----------

test('归还校验：未知领用单 404；非法输入 400；非本单实物 409', async () => {
  let r = await call('POST', '/api/checkouts/999999/return', {
    items: [{ serial: 'W50-B', condition: 'intact' }],
  });
  assert.equal(r.status, 404);

  for (const body of [
    {},
    { items: [] },
    { items: [{ serial: 'W50-B' }] },
    { items: [{ serial: 'W50-B', condition: 'ok' }] },
    { items: [{ serial: 'W50-B', condition: 'intact' }, { serial: 'W50-B', condition: 'intact' }] },
  ]) {
    r = await call('POST', `/api/checkouts/${resv.co2}/return`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }

  // W50-A 属于领用单 #co1，不属于 #co2（非本单实物，整次拒绝）
  r = await call('POST', `/api/checkouts/${resv.co2}/return`, {
    items: [{ serial: 'W50-A', condition: 'intact' }],
  });
  assert.equal(r.status, 409);
  assert.ok(r.json.errors.join(' ').includes('非本单实物'));

  // 整次拒绝不留部分记录：#co2 仍未归还
  const co2 = await call('GET', `/api/checkouts/${resv.co2}`);
  assert.equal(co2.json.status, 'open');
  assert.deepEqual(co2.json.unreturned, ['W50-B']);
});

test('归还成功：逐件标记完好，整单完结；重复归还 409', async () => {
  const r = await call('POST', `/api/checkouts/${resv.co2}/return`, {
    items: [{ serial: 'W50-B', condition: 'intact' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.status, 'closed');
  assert.deepEqual(r.json.unreturned, []);
  assert.ok(r.json.closedAt);
  assert.equal(r.json.items[0].state, 'intact');
  assert.ok(r.json.items[0].returnedAt);

  // 重复归还 → 409
  const dup = await call('POST', `/api/checkouts/${resv.co2}/return`, {
    items: [{ serial: 'W50-B', condition: 'intact' }],
  });
  assert.equal(dup.status, 409);
  assert.ok(dup.json.errors.join(' ').includes('重复归还'));

  // 实物回到在册可领用状态
  const items = await call('GET', '/api/weight-items');
  const wb = items.json.find((i) => i.serial === 'W50-B');
  assert.equal(wb.status, 'active');
  assert.equal(wb.checkedOut, false);
});

test('损坏归还：损坏件不得再次领用', async () => {
  const r = await call('POST', `/api/checkouts/${resv.co1}/return`, {
    items: [{ serial: 'W50-A', condition: 'damaged' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.items[0].state, 'damaged');

  const items = await call('GET', '/api/weight-items');
  assert.equal(items.json.find((i) => i.serial === 'W50-A').status, 'damaged');

  const now = Date.now();
  resv.ongoing3 = await makeReservation('CO-RESV-3', pubId, now - 3600_000, now + 3600_000);
  const damaged = await checkout(resv.ongoing3, ['W50-A']);
  assert.equal(damaged.status, 409);
  assert.ok(damaged.json.errors.join(' ').includes('损坏'));
  // 完好件可正常领用
  const ok = await checkout(resv.ongoing3, ['W50-B']);
  assert.equal(ok.status, 201);
  resv.co3 = ok.json.id;
});

test('预约结束后仍可归还；查询显示未还件与逾期状态', async () => {
  await registerItem('W50-C', 50);
  const now = Date.now();
  // 短窗口预约：400ms 后到期
  resv.short = await makeReservation('CO-RESV-SHORT', pubId, now - 300_000, now + 400);
  const co = await checkout(resv.short, ['W50-C']);
  assert.equal(co.status, 201, JSON.stringify(co.json));
  assert.equal(co.json.overdue, false);
  resv.coShort = co.json.id;

  await sleep(500);
  const during = await call('GET', `/api/checkouts/${resv.coShort}`);
  assert.equal(during.json.status, 'open');
  assert.equal(during.json.overdue, true);
  assert.deepEqual(during.json.unreturned, ['W50-C']);

  // 预约结束后仍可归还
  const ret = await call('POST', `/api/checkouts/${resv.coShort}/return`, {
    items: [{ serial: 'W50-C', condition: 'intact' }],
  });
  assert.equal(ret.status, 200, JSON.stringify(ret.json));
  assert.equal(ret.json.status, 'closed');
  assert.equal(ret.json.overdue, false);
});

// ---------- HTTP：注销 ----------

test('注销：已领出实物不能注销；归还后可注销；注销幂等；注销件不能领用', async () => {
  // W50-B 当前被领用单 #co3 占用
  const busy = await call('POST', '/api/weight-items/W50-B/retire');
  assert.equal(busy.status, 409);
  assert.ok(busy.json.errors.join(' ').includes('不能注销'));

  const ret = await call('POST', `/api/checkouts/${resv.co3}/return`, {
    items: [{ serial: 'W50-B', condition: 'intact' }],
  });
  assert.equal(ret.status, 200);

  const retired = await call('POST', '/api/weight-items/W50-B/retire');
  assert.equal(retired.status, 200);
  assert.equal(retired.json.status, 'retired');
  assert.ok(retired.json.retiredAt);

  // 幂等：已注销重复调用返回原记录
  const again = await call('POST', '/api/weight-items/W50-B/retire');
  assert.equal(again.status, 200);
  assert.equal(again.json.status, 'retired');

  const notFound = await call('POST', '/api/weight-items/W-NOPE/retire');
  assert.equal(notFound.status, 404);

  // 已注销实物不能领用
  const now = Date.now();
  resv.ongoing4 = await makeReservation('CO-RESV-4', pubId, now - 3600_000, now + 3600_000);
  const r = await checkout(resv.ongoing4, ['W50-B']);
  assert.equal(r.status, 409);
  assert.ok(r.json.errors.join(' ').includes('已注销'));
});

// ---------- HTTP：与运行接口兼容 ----------

test('兼容：领用不影响同预约的运行开始；运行状态变化不改写领还历史', async () => {
  // 完成核验（运行开始的前置条件）
  const created = await call('POST', '/api/verifications', { publicationId: pubId });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const vid = created.json.id;
  const pub = await call('GET', `/api/publications/${pubId}`);
  const entries = pub.json.result.arrangement.map((s, h) => ({
    hole: h,
    ref: s ? s.ref : '',
    mass: s ? s.mass : 0,
  }));
  const saved = await call('PUT', `/api/verifications/${vid}`, { version: 1, entries });
  assert.equal(saved.status, 200);
  const done = await call('POST', `/api/verifications/${vid}/complete`);
  assert.equal(done.status, 201);

  await registerItem('W50-D', 50);
  const now = Date.now();
  resv.run = await makeReservation('CO-RESV-RUN', pubId, now - 3600_000, now + 3600_000);
  const co = await checkout(resv.run, ['W50-D']);
  assert.equal(co.status, 201);
  resv.coRun = co.json.id;

  // 同一预约既可领用配重块，也可开始离心运行（互不影响）
  const run = await call('POST', '/api/runs', {
    runNo: 'RUN-CO-1',
    deviceNo: 'CO-DEV-1',
    verificationId: vid,
    reservationId: resv.run,
  });
  assert.equal(run.status, 201, JSON.stringify(run.json));
  const finished = await call('POST', `/api/runs/${run.json.id}/complete`, {
    outcome: 'completed',
  });
  assert.equal(finished.status, 201);

  // 运行完结不改写领还历史
  const after = await call('GET', `/api/checkouts/${resv.coRun}`);
  assert.equal(after.json.status, 'open');
  assert.deepEqual(after.json.unreturned, ['W50-D']);
  const ret = await call('POST', `/api/checkouts/${resv.coRun}/return`, {
    items: [{ serial: 'W50-D', condition: 'intact' }],
  });
  assert.equal(ret.status, 200);
});

// ---------- HTTP：库存缩减约束与历史不变 ----------

test('库存缩减若低于在册实物数则整次拒绝；库存调整不改写领还历史', async () => {
  // 在册（未注销）：50 g → W50-A（损坏）、W50-C、W50-D 共 3 件；100 g → W100-A 共 1 件
  const snapshot = await call('GET', `/api/checkouts/${resv.co1}`);

  // 缩减到 2 枚 < 在册 3 件 → 400 整次拒绝
  let r = await call('PUT', '/api/weights', [
    { mass: 50, quantity: 2 },
    { mass: 100, quantity: 1 },
  ]);
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('在册实物'));

  // 删除 100 g 规格（在册 1 件 > 0）→ 400 整次拒绝
  r = await call('PUT', '/api/weights', [{ mass: 50, quantity: 8 }]);
  assert.equal(r.status, 400);

  // 拒绝后库存保持原样
  let state = await call('GET', '/api/state');
  assert.deepEqual(state.json.data.weights, [
    { mass: 50, quantity: 8 },
    { mass: 100, quantity: 1 },
  ]);

  // 缩减到与在册数相等 → 允许
  r = await call('PUT', '/api/weights', [
    { mass: 50, quantity: 3 },
    { mass: 100, quantity: 1 },
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.json));

  // 注销损坏件后在册数下降，可进一步缩减
  const ret = await call('POST', '/api/weight-items/W50-A/retire');
  assert.equal(ret.status, 200);
  r = await call('PUT', '/api/weights', [
    { mass: 50, quantity: 2 },
    { mass: 100, quantity: 1 },
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  state = await call('GET', '/api/state');
  assert.deepEqual(state.json.data.weights, [
    { mass: 50, quantity: 2 },
    { mass: 100, quantity: 1 },
  ]);

  // 库存调整不改写领还历史：冻结时段、占用量与逐件记录保持一致
  const after = await call('GET', `/api/checkouts/${resv.co1}`);
  assert.equal(after.json.createdAt, snapshot.json.createdAt);
  assert.deepEqual(after.json.reservation, snapshot.json.reservation);
  assert.deepEqual(after.json.items, snapshot.json.items);
  assert.equal(after.json.status, 'closed');
});

test('/api/state 含实物编号与领还列表', async () => {
  const s = await call('GET', '/api/state');
  assert.equal(s.status, 200);
  assert.ok(Array.isArray(s.json.weightItems));
  assert.ok(Array.isArray(s.json.checkouts));
  assert.ok(s.json.weightItems.some((i) => i.serial === 'W50-A' && i.status === 'retired'));
  const co1 = s.json.checkouts.find((c) => c.id === resv.co1);
  assert.ok(co1);
  assert.equal(co1.status, 'closed');
  assert.equal(co1.reservationId, resv.ongoing1);
});
