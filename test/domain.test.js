import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDomain } from '../src/domain.js';

const FIXTURE_URL = new URL('../fixtures/domain.json', import.meta.url);

async function loadFixture() {
  return JSON.parse(await readFile(FIXTURE_URL, 'utf8'));
}

// 在副本上篡改后期望校验失败，错误信息应包含给定片段。
function expectRejection(mutate, messageFragment) {
  return async () => {
    const value = await loadFixture();
    mutate(value);
    assert.throws(
      () => parseDomain(JSON.stringify(value)),
      (error) => error.message.includes(messageFragment),
    );
  };
}

test('示例资料通过全部领域校验', async () => {
  const raw = await readFile(FIXTURE_URL, 'utf8');
  const value = parseDomain(raw);
  assert.equal(value.domain, 'overseas-exhibition-fulfillment');
  assert.ok(value.version >= 2);
});

test('六类变更情形都留有带原因的记录', async () => {
  const value = await loadFixture();
  const types = new Set(value.change_events.map((event) => event.type));
  for (const type of value.event_types) {
    assert.ok(types.has(type), `缺少变更类型：${type}`);
  }
  assert.ok(value.change_events.every((event) => event.reason.trim().length > 0));
});

test('成效数字可由底层记录复算', async () => {
  const value = await loadFixture();
  // 解析通过即说明报告数字与证据清单全部可复算；再显式核对关键勾稽。
  const f = value.outcomes.conversion_funnel;
  assert.equal(f.name_cards_collected, value.name_cards.length);
  assert.equal(f.orders_won, value.orders.length);
  const amount = value.orders.reduce((sum, order) => sum + order.amount, 0);
  assert.ok(Math.abs(amount - f.order_amount_myr) <= 0.01);
});

test('篡改成交单数会被发现', expectRejection((value) => {
  value.outcomes.conversion_funnel.orders_won = 99;
}, 'orders_won 不可核验'));

test('篡改成效证据清单会被发现', expectRejection((value) => {
  value.outcomes.evidence.orders_won = ['order-01'];
}, 'orders_won'));

test('拆分数量合计不平会被发现', expectRejection((value) => {
  value.orders.find((order) => order.id === 'order-02').splits[1].qty = 700;
}, '拆分数量合计'));

test('拆分金额合计不平会被发现', expectRejection((value) => {
  value.orders.find((order) => order.id === 'order-02').splits[1].amount = 1;
}, '拆分金额合计'));

test('变更事件缺少原因会被发现', expectRejection((value) => {
  value.change_events.find((event) => event.id === 'evt-004').reason = '   ';
}, '缺少原因'));

test('需求引用已合并停用身份会被发现', expectRejection((value) => {
  value.demands.find((demand) => demand.id === 'dem-02').identity_id = 'id-buy-01a';
}, '已合并停用'));

test('缺少订单履约用途同意时下单会被发现', expectRejection((value) => {
  const contact = value.contacts.find((item) => item.id === 'contact-01');
  contact.purposes = contact.purposes.filter((purpose) => purpose !== 'order_fulfillment');
}, '订单履约'));

test('授权过期后继续跟进会被发现', expectRejection((value) => {
  value.sample_followups.find((item) => item.id === 'sf-01').last_action_at = '2027-01-15';
}, '联系授权已过期'));

test('材料类别与买家需求不匹配时不得对渠道可见', expectRejection((value) => {
  value.visibility_grants.find((grant) => grant.id === 'vg-01').material_id = 'mat-02';
}, '材料类别与买家需求不匹配'));

test('已过有效期的报价不得仍标记为有效', expectRejection((value) => {
  value.quotes.find((quote) => quote.id === 'quote-01').valid_until = '2026-09-01';
}, '已过有效期'));

test('未清关样品不得进入送测跟进', expectRejection((value) => {
  value.sample_followups.find((item) => item.id === 'sf-01').sample_id = 'samp-03';
}, '尚未清关'));

test('终止合作却不撤回授权会被发现', expectRejection((value) => {
  value.livestream_authorizations.find((auth) => auth.id === 'auth-02').status = 'active';
  delete value.livestream_authorizations.find((auth) => auth.id === 'auth-02').revoked_at;
  delete value.livestream_authorizations.find((auth) => auth.id === 'auth-02').revoke_event_id;
}, '合作已终止但授权'));
