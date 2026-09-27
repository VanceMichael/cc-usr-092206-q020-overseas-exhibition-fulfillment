import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runScenario } from '../src/scenario.js';
import { leadsByIntent, canUseContact, changesFor, quoteState, recordLead } from '../src/platform.js';

const fixture = new URL('../fixtures/kuala-lumpur-pet-scenario.json', import.meta.url);

async function load() {
  const raw = JSON.parse(await readFile(fixture, 'utf8'));
  return { raw, run: runScenario(raw.scenario) };
}

test('场景脚本完整回放，无未知操作', async () => {
  const { run } = await load();
  assert.ok(run.store.changes.length > 30);
  assert.equal(run.views.conversion.edition, 'Kuala Lumpur Merchandise Fair 2026 Autumn');
});

test('参展前：资质通过方可参展，驳回保留具体原因', async () => {
  const { run } = await load();
  const { store, refs } = run;
  assert.equal(store.parties[refs.mengzhua].qualification.status, 'approved');
  assert.equal(store.parties[refs.miaoxiang].qualification.status, 'rejected');
  assert.match(store.parties[refs.miaoxiang].qualification.reason, /进口准证/);
});

test('参展前：代表缺席、临时换展均保留原因且状态正确', async () => {
  const { run } = await load();
  const { store, refs } = run;
  const rep = store.parties[refs.mengzhua].representatives.find((r) => r.id === refs.repTan);
  assert.equal(rep.status, 'absent');
  assert.match(rep.reason, /签证/);

  assert.equal(store.exhibits[refs.foamSpray].status, 'swapped_out');
  assert.equal(store.exhibits[refs.foamSpray].replacedBy, refs.wipes);
  assert.equal(store.exhibits[refs.wipes].status, 'displayed');
  assert.match(store.exhibits[refs.foamSpray].reason, /限运品/);
});

test('参展前：样品入境一清一扣，未清关样品不得进入测试', async () => {
  const { run } = await load();
  const { store, refs } = run;
  assert.equal(store.samples[refs.sampleFood].importStatus, 'cleared');
  assert.equal(store.samples[refs.sampleToy].importStatus, 'held');
  assert.match(store.samples[refs.sampleToy].reason, /安全检测报告/);
  assert.equal(store.samples[refs.sampleFood].shipments[0].id, refs.shipPaw);
  assert.equal(store.samples[refs.sampleFood].shipments[0].outcome, 'passed');
  assert.equal(store.samples[refs.sampleToy].shipments.length, 0);
});

test('现场：名片按意向分级，谁浏览、谁测样、谁愿意承接一目了然', async () => {
  const { run } = await load();
  const { store, refs } = run;
  const grouped = leadsByIntent(store, refs.mengzhua);
  assert.deepEqual(grouped.browsing, [refs.leadChen]);
  assert.deepEqual(grouped.sample_testing.sort(), [refs.leadPawA, refs.leadPawB].sort());
  assert.deepEqual(grouped.channel_interest, [refs.leadJincheng]);
  // 寄送样品后浏览线索自动升级，且升级原因可在审计日志核验。
  const upgrade = store.changes.find((c) => c.action === 'lead.intent_upgraded' && c.refs.lead === refs.leadPawA);
  assert.equal(upgrade.reason, '已安排样品测试');
});

test('现场：翻译与洽谈纪要关联到准确主体（PawMart 同一位采购）', async () => {
  const { run } = await load();
  const { store, refs } = run;
  const meeting = Object.values(store.meetings).find((m) => m.id === refs.meetingPaw);
  assert.equal(meeting.buyerId, refs.pawA);
  assert.equal(meeting.translation.fromLanguage, 'zh');
  assert.match(meeting.minute.summary, /JAKIM/);
  assert.equal(meeting.minute.nextSteps.length, 3);
});

test('身份合并：两张名片确认为同一买家后，需求与报价全部并到主档', async () => {
  const { run } = await load();
  const { store, refs } = run;
  assert.equal(store.parties[refs.pawB].status, 'merged');
  assert.equal(store.parties[refs.pawB].mergedInto, refs.pawA);
  assert.equal(store.leads[refs.leadPawB].buyerId, refs.pawA);
  assert.equal(store.demands[refs.demandPaw].buyerId, refs.pawA);
  assert.equal(store.quotes[refs.quotePaw].buyerId, refs.pawA);
  assert.match(changesFor(store, refs.pawB).find((c) => c.action === 'buyer.merged').reason, /同一采购负责人/);
  // 已并入的档案不能再产生新线索，必须使用主档。
  assert.throws(
    () => recordLead(store, { exhibitorId: refs.mengzhua, buyerId: refs.pawB, intent: 'browsing' }),
    (err) => err.code === 'BUYER_MERGED',
  );
});

test('直播授权：撤回的切片消失，其余内容继续有效', async () => {
  const { run } = await load();
  const { store, refs, views } = run;
  const auth = store.livestreams[refs.liveNanyang];
  assert.equal(auth.status, 'active');
  assert.equal(auth.contents[0].status, 'active');
  assert.equal(auth.contents[1].status, 'withdrawn');
  assert.match(auth.contents[1].reason, /未获授权露出/);
  assert.deepEqual(views.nanyang.livestreams[0].contents.map((c) => c.title), ['冻干猫粮新品直播切片']);
});

test('报价：短有效期报价到期失效，成交报价锁定为已接受', async () => {
  const { run } = await load();
  const { store, refs } = run;
  assert.equal(quoteState(store, refs.quoteJincheng, '2026-09-25T10:00:00+08:00'), 'expired');
  assert.equal(quoteState(store, refs.quotePaw, '2026-09-25T10:00:00+08:00'), 'accepted');
});

test('订单拆分保留原因，两批分别履约并汇总进度', async () => {
  const { run } = await load();
  const { store, refs, views } = run;
  assert.equal(store.orders[refs.orderPaw].status, 'split');
  assert.match(store.orders[refs.orderPaw].splitReason, /分两批发货/);
  assert.equal(store.orders[refs.orderAir].status, 'fulfilled');
  assert.equal(store.orders[refs.orderSea].status, 'in_fulfillment');
  assert.deepEqual(views.fulfillment.orders.map((o) => o.orderId).sort(), [refs.orderAir, refs.orderSea].sort());
  assert.equal(views.fulfillment.totalUnits, 3000);
  assert.equal(views.fulfillment.fulfilledUnits, 1800);
  assert.equal(views.fulfillment.ratio, 0.6);
});

test('合作终止：金狮与萌爪终止对接后看不到萌爪材料，原因留存', async () => {
  const { run } = await load();
  const { store, refs, views } = run;
  assert.equal(views.jinshi.exhibitors.length, 0);
  assert.equal(views.jinshi.livestreams.length, 0);
  const entry = store.changes.find(
    (c) => c.action === 'cooperation.terminated' && c.refs.partyA === refs.mengzhua && c.refs.partyB === refs.jinshi,
  );
  assert.match(entry.reason, /返点与最低起订量/);
  // 双方都留下终止记录。
  assert.ok(store.parties[refs.mengzhua].terminatedWith.some((t) => t.partyId === refs.jinshi));
  assert.ok(store.parties[refs.jinshi].terminatedWith.some((t) => t.partyId === refs.mengzhua));
});

test('展后：马来西亚合作方只看到匹配且仍有效的材料', async () => {
  const { run } = await load();
  const { store, refs, views } = run;
  const nanyang = views.nanyang;
  // 只有资质通过、类别匹配且未终止合作的萌爪；喵享资质被驳回不出现。
  assert.deepEqual(nanyang.exhibitors.map((x) => x.exhibitorId), [refs.mengzhua]);
  // 可见展品：在展且类别匹配；被换下的喷雾与清洁湿巾（类别不匹配）均不出现。
  assert.deepEqual(
    nanyang.exhibitors[0].exhibits.map((x) => x.id).sort(),
    [refs.freezeDried, refs.teaser].sort(),
  );
  // 萌爪已就「渠道对接」用途授权，联系方式可见。
  assert.deepEqual(nanyang.exhibitors[0].contact, store.parties[refs.mengzhua].contact);
  // 采购需求按类别匹配；买家未授权「渠道对接」用途时联系方式不附带。
  assert.equal(nanyang.demands.length, 2);
  assert.ok(nanyang.demands.every((d) => d.buyerContact === null));
});

test('联系资料只按双方同意的用途延续：陈女士撤展后撤回授权', async () => {
  const { run } = await load();
  const { store, refs } = run;
  assert.equal(canUseContact(store, { fromId: refs.chen, toId: refs.mengzhua, purpose: '现场活动回访' }), false);
  const consent = store.consents[refs.consentChen];
  assert.equal(consent.status, 'revoked');
  assert.match(consent.reason, /要求停止联系/);
  // PawMart 授权的「样品与订单跟进」仍然有效，用途不混用。
  assert.equal(canUseContact(store, { fromId: refs.pawA, toId: refs.mengzhua, purpose: '样品与订单跟进' }), true);
  assert.equal(canUseContact(store, { fromId: refs.pawA, toId: refs.mengzhua, purpose: '现场活动回访' }), false);
});

test('参展商可循着样品与订单跟进同一买家', async () => {
  const { run } = await load();
  const { refs, views } = run;
  const follow = views.mengzhua;
  const pawShipment = follow.samples.find((s) => s.shipmentId === refs.shipPaw);
  assert.equal(pawShipment.buyerId, refs.pawA);
  assert.equal(pawShipment.outcome, 'passed');
  const pawOrders = follow.orders.filter((o) => o.buyerId === refs.pawA);
  assert.equal(pawOrders.length, 2);
});

test('成效以可核验的转化漏斗呈现，每阶段附记录编号', async () => {
  const { run } = await load();
  const { refs, views } = run;
  const { stages } = views.conversion;
  assert.equal(stages.leads.count, 4);
  assert.equal(stages.leads.byIntent.browsing, 1);
  assert.equal(stages.leads.byIntent.sample_testing, 2);
  assert.equal(stages.leads.byIntent.channel_interest, 1);
  assert.equal(stages.sampleTesting.count, 1);
  assert.deepEqual(stages.sampleTesting.refs, [refs.shipPaw]);
  assert.equal(stages.quoted.count, 2);
  assert.ok(!stages.quoted.stillValid.includes(refs.quoteJincheng));
  // 已拆分母单不计入成交，两个子单计入；其中空运急单已全部履约。
  assert.equal(stages.ordered.count, 2);
  assert.ok(!stages.ordered.refs.includes(refs.orderPaw));
  assert.deepEqual(stages.fulfilled.refs, [refs.orderAir]);
});

test('异常路径：合并后的买家与失效报价都会被拦截', async () => {
  const { run } = await load();
  const { store, refs } = run;
  assert.throws(
    () => recordLead(store, { exhibitorId: refs.mengzhua, buyerId: refs.pawB, intent: 'browsing' }),
    (err) => err.code === 'BUYER_MERGED',
  );
  const { acceptQuote } = await import('../src/platform.js');
  assert.throws(
    () => acceptQuote(store, refs.quoteJincheng, '2026-09-25T10:00:00+08:00'),
    (err) => err.code === 'QUOTE_NOT_VALID',
  );
});
