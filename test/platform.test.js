import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlatform, registerParty, submitQualification, reviewQualification,
  addRepresentative, markRepresentativeAbsent,
  registerExhibit, swapExhibit, declareSampleImport, reviewSampleImport,
  sendSampleForTesting, recordSampleOutcome,
  assignBooth, scheduleEvent,
  recordLead, leadsByIntent, recordDemand,
  holdMeeting, requestTranslation, recordMinute,
  authorizeLivestream, withdrawLivestream,
  issueQuote, quoteState, validQuotesForBuyer, acceptQuote,
  createOrder, splitOrder, recordFulfillment,
  mergeBuyers, terminateCooperation,
  grantContactConsent, revokeContactConsent, canUseContact,
  visibleMaterialsForPartner, followUpsForExhibitor,
  conversionReport, fulfillmentReport, changesFor,
  PlatformError,
} from '../src/platform.js';

const T0 = '2026-09-10T09:00:00+08:00';

function newStore() {
  return createPlatform({ edition: 'test-edition', startAt: T0 });
}

function approvedExhibitor(store, { categories = ['宠物食品', '宠物玩具'], contact = null } = {}) {
  const e = registerParty(store, { kind: 'exhibitor', name: '测试参展企业', country: '中国', categories, contact });
  submitQualification(store, e.id, ['营业执照']);
  reviewQualification(store, e.id, { approve: true });
  return e;
}

function buyer(store, name = '测试买家') {
  return registerParty(store, { kind: 'buyer', name, country: '马来西亚', contact: { channel: 'email', value: 'b@example.test' } });
}

function assertRejects(code, fn) {
  assert.throws(fn, (err) => err instanceof PlatformError && err.code === code, `应抛出 ${code}`);
}

test('资质未通过审核不能登记展品或申报样品', () => {
  const store = newStore();
  const e = registerParty(store, { kind: 'exhibitor', name: '待审企业', categories: ['宠物食品'] });
  submitQualification(store, e.id, ['营业执照']);
  assertRejects('QUALIFICATION_NOT_APPROVED', () =>
    registerExhibit(store, { exhibitorId: e.id, name: '猫粮', category: '宠物食品' }));
  reviewQualification(store, e.id, { approve: false, reason: '材料不全' });
  assertRejects('QUALIFICATION_NOT_APPROVED', () =>
    registerExhibit(store, { exhibitorId: e.id, name: '猫粮', category: '宠物食品' }));
});

test('驳回资质必须填写原因，并记入审计日志', () => {
  const store = newStore();
  const e = registerParty(store, { kind: 'exhibitor', name: '待审企业', categories: ['宠物食品'] });
  submitQualification(store, e.id, ['营业执照']);
  assertRejects('REASON_REQUIRED', () => reviewQualification(store, e.id, { approve: false }));
  reviewQualification(store, e.id, { approve: false, reason: '缺少出口备案' });
  const entry = store.changes.find((c) => c.action === 'qualification.rejected');
  assert.equal(entry.reason, '缺少出口备案');
});

test('展品类别必须在企业申报类别内', () => {
  const store = newStore();
  const e = approvedExhibitor(store);
  assertRejects('CATEGORY_NOT_DECLARED', () =>
    registerExhibit(store, { exhibitorId: e.id, name: '陌生商品', category: '宠物电器' }));
});

test('临时换展保留原因，旧展品下架并被替换展品继承', () => {
  const store = newStore();
  const e = approvedExhibitor(store, { categories: ['宠物清洁'] });
  const old = registerExhibit(store, { exhibitorId: e.id, name: '喷雾', category: '宠物清洁' });
  assertRejects('REASON_REQUIRED', () =>
    swapExhibit(store, { exhibitId: old.id, replacement: { name: '湿巾', category: '宠物清洁' } }));
  const fresh = swapExhibit(store, {
    exhibitId: old.id,
    replacement: { name: '湿巾', category: '宠物清洁' },
    reason: '喷雾罐限运',
  });
  assert.equal(store.exhibits[old.id].status, 'swapped_out');
  assert.equal(store.exhibits[old.id].replacedBy, fresh.id);
  assert.equal(fresh.status, 'displayed');
  assert.equal(changesFor(store, old.id).find((c) => c.action === 'exhibit.swapped').reason, '喷雾罐限运');
});

test('样品须清关后才能寄送，未清关被拦截', () => {
  const store = newStore();
  const e = approvedExhibitor(store);
  const ex = registerExhibit(store, { exhibitorId: e.id, name: '猫粮', category: '宠物食品' });
  const b = buyer(store);
  const held = declareSampleImport(store, { exhibitorId: e.id, exhibitId: ex.id, quantity: 10, customsRef: 'ATA-1' });
  reviewSampleImport(store, held.id, { approve: false, reason: '缺检测报告' });
  assertRejects('SAMPLE_NOT_CLEARED', () => sendSampleForTesting(store, { sampleId: held.id, buyerId: b.id }));

  const ok = declareSampleImport(store, { exhibitorId: e.id, exhibitId: ex.id, quantity: 10, customsRef: 'ATA-2' });
  reviewSampleImport(store, ok.id, { approve: true });
  const shipment = sendSampleForTesting(store, { sampleId: ok.id, buyerId: b.id });
  assert.equal(shipment.status, 'testing');
  recordSampleOutcome(store, { shipmentId: shipment.id, outcome: 'passed' });
  assert.equal(store.samples[ok.id].shipments[0].status, 'done');
});

test('展位档期冲突被拦截；同一参展商活动时间重叠被拦截', () => {
  const store = newStore();
  const e = approvedExhibitor(store);
  assignBooth(store, { exhibitorId: e.id, hall: 'B', boothNo: 'B-1', start: '2026-09-10T09:00:00+08:00', end: '2026-09-12T18:00:00+08:00' });
  assertRejects('BOOTH_CONFLICT', () =>
    assignBooth(store, { exhibitorId: e.id, hall: 'B', boothNo: 'B-1', start: '2026-09-11T09:00:00+08:00', end: '2026-09-11T12:00:00+08:00' }));
  scheduleEvent(store, { exhibitorId: e.id, title: '发布会', start: '2026-09-11T11:00:00+08:00', end: '2026-09-11T12:00:00+08:00' });
  assertRejects('EVENT_CONFLICT', () =>
    scheduleEvent(store, { exhibitorId: e.id, title: '签售会', start: '2026-09-11T11:30:00+08:00', end: '2026-09-11T12:30:00+08:00' }));
});

test('线索按意向分级，寄送样品后浏览线索升级为样品测试', () => {
  const store = newStore();
  const e = approvedExhibitor(store);
  const ex = registerExhibit(store, { exhibitorId: e.id, name: '猫粮', category: '宠物食品' });
  const b1 = buyer(store, '浏览者');
  const b2 = buyer(store, '渠道商');
  recordLead(store, { exhibitorId: e.id, buyerId: b1.id, intent: 'browsing' });
  recordLead(store, { exhibitorId: e.id, buyerId: b2.id, intent: 'channel_interest' });
  const sample = declareSampleImport(store, { exhibitorId: e.id, exhibitId: ex.id, quantity: 5, customsRef: 'ATA-3' });
  reviewSampleImport(store, sample.id, { approve: true });
  sendSampleForTesting(store, { sampleId: sample.id, buyerId: b1.id });
  const grouped = leadsByIntent(store, e.id);
  assert.deepEqual(grouped.browsing, []);
  assert.equal(grouped.sample_testing.length, 1);
  assert.equal(grouped.channel_interest.length, 1);
});

test('翻译支持与洽谈纪要挂在准确的洽谈主体上', () => {
  const store = newStore();
  const e = approvedExhibitor(store);
  const b = buyer(store);
  const m = holdMeeting(store, { exhibitorId: e.id, buyerId: b.id });
  requestTranslation(store, { meetingId: m.id, fromLanguage: 'zh', toLanguage: 'English' });
  assertRejects('SUMMARY_REQUIRED', () => recordMinute(store, { meetingId: m.id, summary: '' }));
  recordMinute(store, { meetingId: m.id, summary: '讨论首批试单', nextSteps: ['下周报价'] });
  assert.equal(store.meetings[m.id].translation.status, 'arranged');
  assert.equal(store.meetings[m.id].minute.summary, '讨论首批试单');
});

test('报价在有效期内可成交，过期后买家不可见也不能成交', () => {
  const store = newStore();
  const e = approvedExhibitor(store);
  const b = buyer(store);
  const q = issueQuote(store, {
    exhibitorId: e.id, buyerId: b.id,
    items: [{ name: '猫粮', quantity: 100, unitPrice: 20 }], validDays: 7,
  }, '2026-09-10T09:00:00+08:00');
  assert.equal(quoteState(store, q.id, '2026-09-17T08:59:00+08:00'), 'valid');
  assert.equal(quoteState(store, q.id, '2026-09-17T09:01:00+08:00'), 'expired');
  assert.equal(validQuotesForBuyer(store, b.id, '2026-09-17T09:01:00+08:00').length, 0);
  assertRejects('QUOTE_NOT_VALID', () => acceptQuote(store, q.id, '2026-09-18T09:00:00+08:00'));
  const order = acceptQuote(store, q.id, '2026-09-12T09:00:00+08:00');
  assert.equal(order.quoteId, q.id);
  assert.equal(quoteState(store, q.id, '2026-09-30T00:00:00+08:00'), 'accepted');
});

test('订单拆分必须恰好覆盖原单，母单保留拆分原因', () => {
  const store = newStore();
  const e = approvedExhibitor(store);
  const b = buyer(store);
  const order = createOrder(store, {
    exhibitorId: e.id, buyerId: b.id,
    items: [{ name: '猫粮', quantity: 100 }, { name: '玩具', quantity: 20 }],
  });
  assertRejects('REASON_REQUIRED', () => splitOrder(store, { orderId: order.id, splits: [] }));
  assertRejects('SPLIT_ITEMS_MISMATCH', () => splitOrder(store, {
    orderId: order.id, reason: '分批',
    splits: [
      { label: 'A', items: [{ itemId: order.items[0].id, quantity: 60 }] },
      { label: 'B', items: [{ itemId: order.items[0].id, quantity: 30 }, { itemId: order.items[1].id, quantity: 20 }] },
    ],
  }));
  const children = splitOrder(store, {
    orderId: order.id, reason: '按清关档期分两批',
    splits: [
      { label: '首批', items: [{ itemId: order.items[0].id, quantity: 100 }] },
      { label: '次批', items: [{ itemId: order.items[1].id, quantity: 20 }] },
    ],
  });
  assert.equal(store.orders[order.id].status, 'split');
  assert.equal(store.orders[order.id].splitReason, '按清关档期分两批');
  assertRejects('ORDER_SPLIT', () =>
    recordFulfillment(store, { orderId: order.id, itemId: order.items[0].id, quantity: 1 }));
  assertRejects('OVER_FULFILLED', () =>
    recordFulfillment(store, { orderId: children[0].id, itemId: children[0].items[0].id, quantity: 101 }));
  recordFulfillment(store, { orderId: children[0].id, itemId: children[0].items[0].id, quantity: 40 });
  assert.equal(store.orders[children[0].id].status, 'in_fulfillment');
  recordFulfillment(store, { orderId: children[0].id, itemId: children[0].items[0].id, quantity: 60 });
  assert.equal(store.orders[children[0].id].status, 'fulfilled');
});

test('同一买家身份合并后，全部关联记录改挂主档，重复档案停用', () => {
  const store = newStore();
  const e = approvedExhibitor(store);
  const primary = buyer(store, '王先生（主档）');
  const dup = buyer(store, '王先生（第二张名片）');
  const lead = recordLead(store, { exhibitorId: e.id, buyerId: dup.id, intent: 'sample_testing' });
  recordDemand(store, { buyerId: dup.id, categories: ['宠物食品'], quantity: 10 });
  const q = issueQuote(store, { exhibitorId: e.id, buyerId: dup.id, items: [{ name: '猫粮', quantity: 10, unitPrice: 1 }] });
  assertRejects('REASON_REQUIRED', () => mergeBuyers(store, { primaryId: primary.id, duplicateId: dup.id }));
  mergeBuyers(store, { primaryId: primary.id, duplicateId: dup.id, reason: '两张名片确认为同一人' });
  assert.equal(store.leads[lead.id].buyerId, primary.id);
  assert.equal(store.demands[Object.values(store.demands)[0].id].buyerId, primary.id);
  assert.equal(store.quotes[q.id].buyerId, primary.id);
  assert.equal(store.parties[dup.id].status, 'merged');
  assert.equal(store.parties[dup.id].mergedInto, primary.id);
  assertRejects('BUYER_MERGED', () => recordLead(store, { exhibitorId: e.id, buyerId: dup.id, intent: 'browsing' }));
});

test('直播撤回的内容不再对渠道可见，撤回授权须有原因', () => {
  const store = newStore();
  const e = approvedExhibitor(store);
  const p = registerParty(store, { kind: 'channel_partner', name: '本地渠道', categories: ['宠物食品'] });
  const auth = authorizeLivestream(store, {
    exhibitorId: e.id, partnerId: p.id, scope: '新品发布',
    contents: ['切片一', '切片二'],
  });
  assertRejects('REASON_REQUIRED', () => withdrawLivestream(store, { authorizationId: auth.id, contentId: auth.contents[0].id }));
  withdrawLivestream(store, { authorizationId: auth.id, contentId: auth.contents[0].id, reason: '出现未授权品牌标识' });
  let view = visibleMaterialsForPartner(store, p.id);
  assert.deepEqual(view.livestreams[0].contents.map((c) => c.title), ['切片二']);
  withdrawLivestream(store, { authorizationId: auth.id, reason: '合作生变，整体撤回' });
  view = visibleMaterialsForPartner(store, p.id);
  assert.equal(view.livestreams.length, 0);
});

test('合作终止后渠道看不到对方材料，且终止须记录原因', () => {
  const store = newStore();
  const e = approvedExhibitor(store);
  registerExhibit(store, { exhibitorId: e.id, name: '猫粮', category: '宠物食品' });
  const p = registerParty(store, { kind: 'channel_partner', name: '渠道', categories: ['宠物食品'] });
  assert.equal(visibleMaterialsForPartner(store, p.id).exhibitors.length, 1);
  assertRejects('REASON_REQUIRED', () => terminateCooperation(store, { partyAId: e.id, partyBId: p.id }));
  terminateCooperation(store, { partyAId: e.id, partyBId: p.id, reason: '返点未达成一致' });
  assert.equal(visibleMaterialsForPartner(store, p.id).exhibitors.length, 0);
  const entry = store.changes.find((c) => c.action === 'cooperation.terminated');
  assert.equal(entry.reason, '返点未达成一致');
});

test('联系资料仅在双方约定用途下可见，撤回授权后立即失效', () => {
  const store = newStore();
  const e = approvedExhibitor(store, { contact: { channel: 'email', value: 'e@example.test' } });
  registerExhibit(store, { exhibitorId: e.id, name: '猫粮', category: '宠物食品' });
  const p = registerParty(store, { kind: 'channel_partner', name: '渠道', categories: ['宠物食品'] });

  assert.equal(canUseContact(store, { fromId: e.id, toId: p.id, purpose: '渠道对接' }), false);
  assert.equal(visibleMaterialsForPartner(store, p.id).exhibitors[0].contact, null);

  grantContactConsent(store, { fromId: e.id, toId: p.id, purpose: '渠道对接' });
  assert.equal(canUseContact(store, { fromId: e.id, toId: p.id, purpose: '渠道对接' }), true);
  assert.equal(canUseContact(store, { fromId: e.id, toId: p.id, purpose: '其他用途' }), false);
  assert.deepEqual(visibleMaterialsForPartner(store, p.id).exhibitors[0].contact, { channel: 'email', value: 'e@example.test' });

  const consent = Object.values(store.consents)[0];
  revokeContactConsent(store, { consentId: consent.id, reason: '企业要求停止分享' });
  assert.equal(canUseContact(store, { fromId: e.id, toId: p.id, purpose: '渠道对接' }), false);
  assert.equal(visibleMaterialsForPartner(store, p.id).exhibitors[0].contact, null);
});

test('代表缺席必须保留原因', () => {
  const store = newStore();
  const e = approvedExhibitor(store);
  const rep = addRepresentative(store, { exhibitorId: e.id, name: '张某' });
  assertRejects('REASON_REQUIRED', () => markRepresentativeAbsent(store, { representativeId: rep.id }));
  markRepresentativeAbsent(store, { representativeId: rep.id, reason: '航班取消' });
  assert.equal(e.representatives[0].status, 'absent');
  assert.equal(e.representatives[0].reason, '航班取消');
});

test('可核验转化报告各阶段附带记录编号，已拆分母单不重复计入', () => {
  const store = newStore();
  const e = approvedExhibitor(store);
  const ex = registerExhibit(store, { exhibitorId: e.id, name: '猫粮', category: '宠物食品' });
  const b = buyer(store);
  recordLead(store, { exhibitorId: e.id, buyerId: b.id, intent: 'browsing' });
  const sample = declareSampleImport(store, { exhibitorId: e.id, exhibitId: ex.id, quantity: 5, customsRef: 'ATA-9' });
  reviewSampleImport(store, sample.id, { approve: true });
  const shipment = sendSampleForTesting(store, { sampleId: sample.id, buyerId: b.id });
  recordSampleOutcome(store, { shipmentId: shipment.id, outcome: 'passed' });
  const q = issueQuote(store, { exhibitorId: e.id, buyerId: b.id, items: [{ name: '猫粮', quantity: 100, unitPrice: 20 }], validDays: 30 });
  const order = acceptQuote(store, q.id);
  splitOrder(store, {
    orderId: order.id, reason: '分批',
    splits: [
      { label: 'A', items: [{ itemId: order.items[0].id, quantity: 60 }] },
      { label: 'B', items: [{ itemId: order.items[0].id, quantity: 40 }] },
    ],
  });
  const children = store.orders[order.id].children;
  recordFulfillment(store, { orderId: children[0], itemId: `${children[0]}-I1`, quantity: 60 });

  const report = conversionReport(store);
  assert.equal(report.stages.leads.count, 1);
  assert.equal(report.stages.sampleTesting.count, 1);
  assert.ok(report.stages.sampleTesting.refs.includes(shipment.id));
  assert.equal(report.stages.ordered.count, 2);
  assert.ok(!report.stages.ordered.refs.includes(order.id));
  assert.equal(report.stages.fulfilled.count, 1);

  const progress = fulfillmentReport(store);
  assert.equal(progress.totalUnits, 100);
  assert.equal(progress.fulfilledUnits, 60);
  assert.equal(progress.ratio, 0.6);
});

test('参展商跟进视图同时给出线索、样品寄送与订单进度', () => {
  const store = newStore();
  const e = approvedExhibitor(store);
  const b = buyer(store);
  recordLead(store, { exhibitorId: e.id, buyerId: b.id, intent: 'channel_interest' });
  const follow = followUpsForExhibitor(store, e.id);
  assert.equal(follow.leads.length, 1);
  assert.equal(follow.samples.length, 0);
  assert.equal(follow.orders.length, 0);
});
