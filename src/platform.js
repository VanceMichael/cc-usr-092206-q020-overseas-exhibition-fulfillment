// 展会履约平台核心领域逻辑。
//
// 覆盖三个阶段：
// - 参展前：企业资质、产品类别、样品入境、展位与活动档期；
// - 现场：线索分级、采购需求、翻译支持、直播授权、洽谈纪要、有效报价；
// - 展后：渠道可见材料、样品与订单跟进、可核验的转化与履约报告。
//
// 设计约定：
// - 全部为纯数据操作，直接修改传入的 store 并返回受影响记录，无外部依赖；
// - 变更类操作（换展、缺席、身份合并、内容撤回、订单拆分、合作终止、撤回授权）
//   必须填写原因；所有操作写入审计日志 store.changes；
// - 联系资料只在双方约定的用途下可见，撤回授权即失效；
// - 时间均可显式传入（ISO 字符串），缺省使用 store.now，便于测试复现。

export class PlatformError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlatformError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PlatformError(code, message);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// 线索意向：现场浏览 / 已安排样品测试 / 本地渠道愿意承接订单
export const LEAD_INTENTS = ['browsing', 'sample_testing', 'channel_interest'];

const PARTY_KINDS = ['exhibitor', 'buyer', 'channel_partner', 'organizer'];
const ID_PREFIX = { exhibitor: 'EXH', buyer: 'BUY', channel_partner: 'CHP', organizer: 'ORG' };

export function createPlatform({ edition, startAt } = {}) {
  if (!edition) fail('EDITION_REQUIRED', '必须指定展会届次');
  if (!startAt) fail('START_AT_REQUIRED', '必须指定起始时间');
  return {
    edition,
    now: startAt,
    seq: 0,
    parties: {},
    exhibits: {},
    samples: {},
    booths: {},
    events: {},
    leads: {},
    demands: {},
    meetings: {},
    livestreams: {},
    quotes: {},
    orders: {},
    consents: {},
    changes: [],
  };
}

function when(store, at) {
  return at ?? store.now;
}

function nextId(store, prefix) {
  store.seq += 1;
  return `${prefix}-${String(store.seq).padStart(3, '0')}`;
}

function log(store, at, action, refs, reason = null) {
  store.changes.push({ seq: store.changes.length + 1, at, action, refs, reason });
}

function needReason(reason, label) {
  if (typeof reason !== 'string' || reason.trim() === '') {
    fail('REASON_REQUIRED', `${label}必须填写原因`);
  }
  return reason.trim();
}

function getParty(store, id, kind = null) {
  const party = store.parties[id];
  if (!party) fail('PARTY_NOT_FOUND', `主体不存在：${id}`);
  if (kind && party.kind !== kind) fail('WRONG_PARTY_KIND', `主体 ${id} 不是 ${kind}`);
  return party;
}

function ensureApproved(exhibitor) {
  if (exhibitor.qualification?.status !== 'approved') {
    fail('QUALIFICATION_NOT_APPROVED', `参展企业 ${exhibitor.id} 资质未通过审核`);
  }
}

function ensureActiveBuyer(buyer) {
  if (buyer.mergedInto) {
    fail('BUYER_MERGED', `买家 ${buyer.id} 已并入 ${buyer.mergedInto}，请使用主档`);
  }
}

function isTerminated(a, b) {
  return a.terminatedWith.some((t) => t.partyId === b.id);
}

// ---------- 主体与资质 ----------

export function registerParty(store, input, at) {
  const { kind, name, country = null, categories = [], regions = [], contact = null } = input;
  if (!PARTY_KINDS.includes(kind)) fail('UNKNOWN_PARTY_KIND', `未知主体类型：${kind}`);
  if (!name) fail('NAME_REQUIRED', '主体必须填写名称');
  const id = nextId(store, ID_PREFIX[kind]);
  const party = {
    id, kind, name, country,
    categories: [...categories],
    regions: [...regions],
    contact,
    status: 'active',
    terminatedWith: [],
  };
  if (kind === 'exhibitor') {
    party.qualification = { status: 'pending', documents: [], reason: null, reviewer: null };
    party.representatives = [];
  }
  if (kind === 'buyer') {
    party.mergedInto = null;
  }
  store.parties[id] = party;
  log(store, when(store, at), 'party.registered', { party: id });
  return party;
}

export function submitQualification(store, exhibitorId, documents, at) {
  const exhibitor = getParty(store, exhibitorId, 'exhibitor');
  if (!Array.isArray(documents) || documents.length === 0) {
    fail('DOCUMENTS_REQUIRED', '资质材料不能为空');
  }
  exhibitor.qualification = { status: 'submitted', documents: [...documents], reason: null, reviewer: null };
  log(store, when(store, at), 'qualification.submitted', { exhibitor: exhibitorId });
  return exhibitor.qualification;
}

export function reviewQualification(store, exhibitorId, { approve, reason = null, reviewer = 'organizer' } = {}, at) {
  const exhibitor = getParty(store, exhibitorId, 'exhibitor');
  if (exhibitor.qualification.status !== 'submitted') {
    fail('QUALIFICATION_NOT_SUBMITTED', `参展企业 ${exhibitorId} 尚未提交资质材料`);
  }
  if (!approve) reason = needReason(reason, '驳回资质');
  exhibitor.qualification.status = approve ? 'approved' : 'rejected';
  exhibitor.qualification.reason = reason;
  exhibitor.qualification.reviewer = reviewer;
  log(store, when(store, at), approve ? 'qualification.approved' : 'qualification.rejected', { exhibitor: exhibitorId }, reason);
  return exhibitor.qualification;
}

export function addRepresentative(store, { exhibitorId, name, role = '参展代表' } = {}, at) {
  const exhibitor = getParty(store, exhibitorId, 'exhibitor');
  if (!name) fail('NAME_REQUIRED', '代表必须填写姓名');
  const id = nextId(store, 'REP');
  const rep = { id, exhibitorId, name, role, status: 'present', reason: null };
  exhibitor.representatives.push(rep);
  log(store, when(store, at), 'representative.added', { exhibitor: exhibitorId, representative: id });
  return rep;
}

export function markRepresentativeAbsent(store, { representativeId, reason } = {}, at) {
  let found = null;
  for (const party of Object.values(store.parties)) {
    if (party.kind !== 'exhibitor') continue;
    const rep = party.representatives.find((r) => r.id === representativeId);
    if (rep) { found = { exhibitor: party, rep }; break; }
  }
  if (!found) fail('REPRESENTATIVE_NOT_FOUND', `代表不存在：${representativeId}`);
  reason = needReason(reason, '代表缺席');
  found.rep.status = 'absent';
  found.rep.reason = reason;
  log(store, when(store, at), 'representative.absent', { exhibitor: found.exhibitor.id, representative: representativeId }, reason);
  return found.rep;
}

// ---------- 展品与样品入境 ----------

export function registerExhibit(store, { exhibitorId, name, category } = {}, at) {
  const exhibitor = getParty(store, exhibitorId, 'exhibitor');
  ensureApproved(exhibitor);
  if (!exhibitor.categories.includes(category)) {
    fail('CATEGORY_NOT_DECLARED', `展品类别「${category}」不在企业申报类别内`);
  }
  const id = nextId(store, 'EXB');
  const exhibit = { id, exhibitorId, name, category, status: 'displayed', replacedBy: null, reason: null };
  store.exhibits[id] = exhibit;
  log(store, when(store, at), 'exhibit.registered', { exhibit: id, exhibitor: exhibitorId });
  return exhibit;
}

// 临时换展：旧展品下架并保留原因，替换展品继承展位继续展示。
export function swapExhibit(store, { exhibitId, replacement, reason } = {}, at) {
  const old = store.exhibits[exhibitId];
  if (!old) fail('EXHIBIT_NOT_FOUND', `展品不存在：${exhibitId}`);
  if (old.status !== 'displayed') fail('EXHIBIT_NOT_DISPLAYED', `展品 ${exhibitId} 当前不可更换`);
  reason = needReason(reason, '临时换展');
  const exhibitor = getParty(store, old.exhibitorId, 'exhibitor');
  if (!exhibitor.categories.includes(replacement?.category)) {
    fail('CATEGORY_NOT_DECLARED', `替换展品类别「${replacement?.category}」不在企业申报类别内`);
  }
  const id = nextId(store, 'EXB');
  const fresh = { id, exhibitorId: exhibitor.id, name: replacement.name, category: replacement.category, status: 'displayed', replacedBy: null, reason: null };
  store.exhibits[id] = fresh;
  old.status = 'swapped_out';
  old.replacedBy = id;
  old.reason = reason;
  log(store, when(store, at), 'exhibit.swapped', { exhibit: exhibitId, replacement: id }, reason);
  return fresh;
}

export function declareSampleImport(store, { exhibitorId, exhibitId, quantity, customsRef } = {}, at) {
  const exhibitor = getParty(store, exhibitorId, 'exhibitor');
  ensureApproved(exhibitor);
  const exhibit = store.exhibits[exhibitId];
  if (!exhibit || exhibit.exhibitorId !== exhibitorId) {
    fail('EXHIBIT_NOT_FOUND', `展品 ${exhibitId} 不属于参展企业 ${exhibitorId}`);
  }
  const id = nextId(store, 'SMP');
  const sample = { id, exhibitorId, exhibitId, quantity, customsRef, importStatus: 'declared', reason: null, shipments: [] };
  store.samples[id] = sample;
  log(store, when(store, at), 'sample.import_declared', { sample: id, exhibitor: exhibitorId });
  return sample;
}

export function reviewSampleImport(store, sampleId, { approve, reason = null } = {}, at) {
  const sample = store.samples[sampleId];
  if (!sample) fail('SAMPLE_NOT_FOUND', `样品不存在：${sampleId}`);
  if (sample.importStatus !== 'declared') {
    fail('SAMPLE_NOT_DECLARED', `样品 ${sampleId} 不在待审核状态`);
  }
  if (!approve) reason = needReason(reason, '样品入境暂扣');
  sample.importStatus = approve ? 'cleared' : 'held';
  sample.reason = reason;
  log(store, when(store, at), approve ? 'sample.import_cleared' : 'sample.import_held', { sample: sampleId }, reason);
  return sample;
}

// 样品寄送买家测试：要求已清关；寄送后相关线索意向升级为「样品测试」。
export function sendSampleForTesting(store, { sampleId, buyerId } = {}, at) {
  const sample = store.samples[sampleId];
  if (!sample) fail('SAMPLE_NOT_FOUND', `样品不存在：${sampleId}`);
  if (sample.importStatus !== 'cleared') {
    fail('SAMPLE_NOT_CLEARED', `样品 ${sampleId} 尚未完成入境清关，不能寄送`);
  }
  const buyer = getParty(store, buyerId, 'buyer');
  ensureActiveBuyer(buyer);
  const t = when(store, at);
  const shipment = { id: nextId(store, 'SHP'), sampleId, buyerId, sentAt: t, status: 'testing', outcome: null, note: null };
  sample.shipments.push(shipment);
  for (const lead of Object.values(store.leads)) {
    if (lead.buyerId === buyerId && lead.exhibitorId === sample.exhibitorId && lead.intent === 'browsing') {
      lead.intent = 'sample_testing';
      log(store, t, 'lead.intent_upgraded', { lead: lead.id }, '已安排样品测试');
    }
  }
  log(store, t, 'sample.shipped', { sample: sampleId, shipment: shipment.id, buyer: buyerId });
  return shipment;
}

export function recordSampleOutcome(store, { shipmentId, outcome, note = null } = {}, at) {
  let found = null;
  for (const sample of Object.values(store.samples)) {
    const shipment = sample.shipments.find((s) => s.id === shipmentId);
    if (shipment) { found = { sample, shipment }; break; }
  }
  if (!found) fail('SHIPMENT_NOT_FOUND', `样品寄送记录不存在：${shipmentId}`);
  if (!['passed', 'failed'].includes(outcome)) fail('UNKNOWN_OUTCOME', `未知测试结果：${outcome}`);
  found.shipment.status = 'done';
  found.shipment.outcome = outcome;
  found.shipment.note = note;
  log(store, when(store, at), 'sample.outcome_recorded', { sample: found.sample.id, shipment: shipmentId });
  return found.shipment;
}

// ---------- 展位与活动档期 ----------

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

export function assignBooth(store, { exhibitorId, hall, boothNo, start, end } = {}, at) {
  getParty(store, exhibitorId, 'exhibitor');
  for (const booth of Object.values(store.booths)) {
    if (booth.hall === hall && booth.boothNo === boothNo && overlaps(booth, { start, end })) {
      fail('BOOTH_CONFLICT', `展位 ${hall}/${boothNo} 在该时段已被占用`);
    }
  }
  const id = nextId(store, 'BTH');
  const booth = { id, exhibitorId, hall, boothNo, start, end };
  store.booths[id] = booth;
  log(store, when(store, at), 'booth.assigned', { booth: id, exhibitor: exhibitorId });
  return booth;
}

export function scheduleEvent(store, { exhibitorId, title, start, end } = {}, at) {
  getParty(store, exhibitorId, 'exhibitor');
  for (const event of Object.values(store.events)) {
    if (event.exhibitorId === exhibitorId && overlaps(event, { start, end })) {
      fail('EVENT_CONFLICT', `参展企业 ${exhibitorId} 在该时段已有活动「${event.title}」`);
    }
  }
  const id = nextId(store, 'EVT');
  const event = { id, exhibitorId, title, start, end };
  store.events[id] = event;
  log(store, when(store, at), 'event.scheduled', { event: id, exhibitor: exhibitorId });
  return event;
}

// ---------- 现场对接 ----------

// 记录名片线索：按意向分级（现场浏览 / 样品测试 / 渠道承接），
// 可关联已有买家，也可现场新建买家档案。
export function recordLead(store, { exhibitorId, buyerId = null, buyerName = null, buyerContact = null, intent, note = null } = {}, at) {
  getParty(store, exhibitorId, 'exhibitor');
  if (!LEAD_INTENTS.includes(intent)) fail('UNKNOWN_INTENT', `未知线索意向：${intent}`);
  let buyer;
  if (buyerId) {
    buyer = getParty(store, buyerId, 'buyer');
    ensureActiveBuyer(buyer);
  } else {
    if (!buyerName) fail('BUYER_REQUIRED', '新线索必须提供买家姓名或已有买家编号');
    buyer = registerParty(store, { kind: 'buyer', name: buyerName, contact: buyerContact }, at);
  }
  const t = when(store, at);
  const id = nextId(store, 'LED');
  const lead = { id, exhibitorId, buyerId: buyer.id, intent, note, createdAt: t };
  store.leads[id] = lead;
  log(store, t, 'lead.recorded', { lead: id, exhibitor: exhibitorId, buyer: buyer.id });
  return lead;
}

// 按意向分级查看线索，回答「谁只是浏览、谁在测样、哪个渠道愿意承接」。
export function leadsByIntent(store, exhibitorId = null) {
  const result = { browsing: [], sample_testing: [], channel_interest: [] };
  for (const lead of Object.values(store.leads)) {
    if (exhibitorId && lead.exhibitorId !== exhibitorId) continue;
    result[lead.intent].push(lead.id);
  }
  return result;
}

export function recordDemand(store, { buyerId, categories, quantity = null, budget = null, note = null } = {}, at) {
  const buyer = getParty(store, buyerId, 'buyer');
  ensureActiveBuyer(buyer);
  if (!Array.isArray(categories) || categories.length === 0) {
    fail('CATEGORIES_REQUIRED', '采购需求必须指定类别');
  }
  const t = when(store, at);
  const id = nextId(store, 'DMD');
  const demand = { id, buyerId, categories: [...categories], quantity, budget, note, status: 'open', createdAt: t };
  store.demands[id] = demand;
  log(store, t, 'demand.recorded', { demand: id, buyer: buyerId });
  return demand;
}

export function holdMeeting(store, { exhibitorId, buyerId } = {}, at) {
  getParty(store, exhibitorId, 'exhibitor');
  const buyer = getParty(store, buyerId, 'buyer');
  ensureActiveBuyer(buyer);
  const t = when(store, at);
  const id = nextId(store, 'MTG');
  const meeting = { id, exhibitorId, buyerId, heldAt: t, translation: null, minute: null };
  store.meetings[id] = meeting;
  log(store, t, 'meeting.held', { meeting: id, exhibitor: exhibitorId, buyer: buyerId });
  return meeting;
}

export function requestTranslation(store, { meetingId, fromLanguage, toLanguage } = {}, at) {
  const meeting = store.meetings[meetingId];
  if (!meeting) fail('MEETING_NOT_FOUND', `洽谈不存在：${meetingId}`);
  meeting.translation = { fromLanguage, toLanguage, status: 'arranged' };
  log(store, when(store, at), 'translation.arranged', { meeting: meetingId });
  return meeting.translation;
}

export function recordMinute(store, { meetingId, summary, nextSteps = [] } = {}, at) {
  const meeting = store.meetings[meetingId];
  if (!meeting) fail('MEETING_NOT_FOUND', `洽谈不存在：${meetingId}`);
  if (!summary) fail('SUMMARY_REQUIRED', '洽谈纪要必须填写摘要');
  meeting.minute = { summary, nextSteps: [...nextSteps], recordedAt: when(store, at) };
  log(store, when(store, at), 'minute.recorded', { meeting: meetingId });
  return meeting.minute;
}

// ---------- 直播合作授权 ----------

export function authorizeLivestream(store, { exhibitorId, partnerId, scope, contents = [] } = {}, at) {
  getParty(store, exhibitorId, 'exhibitor');
  getParty(store, partnerId, 'channel_partner');
  const id = nextId(store, 'LVS');
  const authorization = {
    id, exhibitorId, partnerId, scope,
    status: 'active',
    reason: null,
    contents: contents.map((c, i) => ({
      id: `${id}-C${i + 1}`,
      title: c.title ?? String(c),
      status: 'active',
      reason: null,
    })),
  };
  store.livestreams[id] = authorization;
  log(store, when(store, at), 'livestream.authorized', { livestream: id, exhibitor: exhibitorId, partner: partnerId });
  return authorization;
}

// 撤回单条内容或整个授权：内容不再对渠道可见，原因保留。
export function withdrawLivestream(store, { authorizationId, contentId = null, reason } = {}, at) {
  const authorization = store.livestreams[authorizationId];
  if (!authorization) fail('LIVESTREAM_NOT_FOUND', `直播授权不存在：${authorizationId}`);
  reason = needReason(reason, '直播内容撤回');
  if (contentId) {
    const content = authorization.contents.find((c) => c.id === contentId);
    if (!content) fail('CONTENT_NOT_FOUND', `直播内容不存在：${contentId}`);
    if (content.status === 'withdrawn') fail('ALREADY_WITHDRAWN', `内容 ${contentId} 已撤回`);
    content.status = 'withdrawn';
    content.reason = reason;
    log(store, when(store, at), 'livestream.content_withdrawn', { livestream: authorizationId, content: contentId }, reason);
  } else {
    if (authorization.status === 'withdrawn') fail('ALREADY_WITHDRAWN', `授权 ${authorizationId} 已撤回`);
    authorization.status = 'withdrawn';
    authorization.reason = reason;
    for (const content of authorization.contents) {
      if (content.status === 'active') {
        content.status = 'withdrawn';
        content.reason = reason;
      }
    }
    log(store, when(store, at), 'livestream.withdrawn', { livestream: authorizationId }, reason);
  }
  return authorization;
}

// ---------- 报价与订单 ----------

export function issueQuote(store, { exhibitorId, buyerId, items, currency = 'MYR', validDays = 7 } = {}, at) {
  getParty(store, exhibitorId, 'exhibitor');
  const buyer = getParty(store, buyerId, 'buyer');
  ensureActiveBuyer(buyer);
  if (!Array.isArray(items) || items.length === 0) fail('ITEMS_REQUIRED', '报价必须包含明细');
  const t = when(store, at);
  const id = nextId(store, 'QTO');
  const quote = {
    id, exhibitorId, buyerId, currency,
    items: items.map((it, i) => ({ id: `${id}-I${i + 1}`, name: it.name, quantity: it.quantity, unitPrice: it.unitPrice })),
    issuedAt: t,
    validUntil: new Date(Date.parse(t) + validDays * DAY_MS).toISOString(),
    status: 'open',
  };
  store.quotes[id] = quote;
  log(store, t, 'quote.issued', { quote: id, exhibitor: exhibitorId, buyer: buyerId });
  return quote;
}

// 报价状态：accepted 一经成交不变；否则按有效期计算 valid / expired。
export function quoteState(store, quoteId, at) {
  const quote = store.quotes[quoteId];
  if (!quote) fail('QUOTE_NOT_FOUND', `报价不存在：${quoteId}`);
  if (quote.status === 'accepted') return 'accepted';
  return Date.parse(when(store, at)) <= Date.parse(quote.validUntil) ? 'valid' : 'expired';
}

// 买家只看到仍有效的报价。
export function validQuotesForBuyer(store, buyerId, at) {
  getParty(store, buyerId, 'buyer');
  const t = when(store, at);
  return Object.values(store.quotes).filter((q) => q.buyerId === buyerId && quoteState(store, q.id, t) === 'valid');
}

export function acceptQuote(store, quoteId, at) {
  const quote = store.quotes[quoteId];
  if (!quote) fail('QUOTE_NOT_FOUND', `报价不存在：${quoteId}`);
  if (quoteState(store, quoteId, at) !== 'valid') {
    fail('QUOTE_NOT_VALID', `报价 ${quoteId} 已失效，不能成交`);
  }
  quote.status = 'accepted';
  const order = createOrder(store, {
    exhibitorId: quote.exhibitorId,
    buyerId: quote.buyerId,
    items: quote.items,
    quoteId,
  }, at);
  log(store, when(store, at), 'quote.accepted', { quote: quoteId, order: order.id });
  return order;
}

export function createOrder(store, { exhibitorId, buyerId, items, quoteId = null, parentId = null } = {}, at) {
  getParty(store, exhibitorId, 'exhibitor');
  const buyer = getParty(store, buyerId, 'buyer');
  ensureActiveBuyer(buyer);
  if (!Array.isArray(items) || items.length === 0) fail('ITEMS_REQUIRED', '订单必须包含明细');
  const t = when(store, at);
  const id = nextId(store, 'ORD');
  const order = {
    id, exhibitorId, buyerId, quoteId, parentId,
    items: items.map((it, i) => ({ id: `${id}-I${i + 1}`, name: it.name, quantity: it.quantity, fulfilled: 0 })),
    status: 'placed',
    label: null,
    splitReason: null,
    children: [],
    createdAt: t,
  };
  store.orders[id] = order;
  log(store, t, 'order.created', { order: id, exhibitor: exhibitorId, buyer: buyerId });
  return order;
}

// 订单拆分：子单必须恰好覆盖母单全部明细；母单标记为已拆分并保留原因。
export function splitOrder(store, { orderId, splits, reason } = {}, at) {
  const order = store.orders[orderId];
  if (!order) fail('ORDER_NOT_FOUND', `订单不存在：${orderId}`);
  if (order.status === 'split') fail('ALREADY_SPLIT', `订单 ${orderId} 已拆分`);
  reason = needReason(reason, '订单拆分');
  if (!Array.isArray(splits) || splits.length < 2) {
    fail('SPLIT_TOO_FEW', '订单拆分至少需要两个子单');
  }
  const covered = new Map();
  for (const split of splits) {
    for (const item of split.items ?? []) {
      const source = order.items.find((i) => i.id === item.itemId);
      if (!source) fail('SPLIT_ITEM_UNKNOWN', `子单引用了不存在的明细 ${item.itemId}`);
      covered.set(item.itemId, (covered.get(item.itemId) ?? 0) + (item.quantity ?? source.quantity));
    }
  }
  for (const source of order.items) {
    if (covered.get(source.id) !== source.quantity) {
      fail('SPLIT_ITEMS_MISMATCH', `拆分数量必须恰好覆盖原单明细 ${source.id}`);
    }
  }
  const t = when(store, at);
  const children = splits.map((split) => {
    const child = createOrder(store, {
      exhibitorId: order.exhibitorId,
      buyerId: order.buyerId,
      items: split.items.map((item) => {
        const source = order.items.find((i) => i.id === item.itemId);
        return { name: source.name, quantity: item.quantity ?? source.quantity };
      }),
      quoteId: order.quoteId,
      parentId: orderId,
    }, t);
    child.label = split.label ?? null;
    return child;
  });
  order.status = 'split';
  order.splitReason = reason;
  order.children = children.map((c) => c.id);
  log(store, t, 'order.split', { order: orderId, children: order.children }, reason);
  return children;
}

export function recordFulfillment(store, { orderId, itemId, quantity } = {}, at) {
  const order = store.orders[orderId];
  if (!order) fail('ORDER_NOT_FOUND', `订单不存在：${orderId}`);
  if (order.status === 'split') fail('ORDER_SPLIT', '订单已拆分，请对子单履约');
  if (!Number.isFinite(quantity) || quantity <= 0) fail('INVALID_QUANTITY', '履约数量必须为正数');
  const item = order.items.find((i) => i.id === itemId);
  if (!item) fail('ITEM_NOT_FOUND', `订单 ${orderId} 没有明细 ${itemId}`);
  if (item.fulfilled + quantity > item.quantity) {
    fail('OVER_FULFILLED', `明细 ${itemId} 履约数量超出订单数量`);
  }
  item.fulfilled += quantity;
  order.status = order.items.every((i) => i.fulfilled === i.quantity) ? 'fulfilled'
    : order.items.some((i) => i.fulfilled > 0) ? 'in_fulfillment'
      : 'placed';
  log(store, when(store, at), 'order.fulfillment_recorded', { order: orderId, item: itemId });
  return order;
}

// ---------- 身份合并与合作终止 ----------

// 同一买家多次留名片：合并到主档，全部关联记录改挂主档，原因保留。
export function mergeBuyers(store, { primaryId, duplicateId, reason } = {}, at) {
  const primary = getParty(store, primaryId, 'buyer');
  const duplicate = getParty(store, duplicateId, 'buyer');
  if (primaryId === duplicateId) fail('MERGE_SELF', '不能将买家合并到自身');
  ensureActiveBuyer(primary);
  if (duplicate.mergedInto) fail('ALREADY_MERGED', `买家 ${duplicateId} 已并入 ${duplicate.mergedInto}`);
  reason = needReason(reason, '买家身份合并');
  for (const lead of Object.values(store.leads)) {
    if (lead.buyerId === duplicateId) lead.buyerId = primaryId;
  }
  for (const demand of Object.values(store.demands)) {
    if (demand.buyerId === duplicateId) demand.buyerId = primaryId;
  }
  for (const meeting of Object.values(store.meetings)) {
    if (meeting.buyerId === duplicateId) meeting.buyerId = primaryId;
  }
  for (const quote of Object.values(store.quotes)) {
    if (quote.buyerId === duplicateId) quote.buyerId = primaryId;
  }
  for (const order of Object.values(store.orders)) {
    if (order.buyerId === duplicateId) order.buyerId = primaryId;
  }
  for (const sample of Object.values(store.samples)) {
    for (const shipment of sample.shipments) {
      if (shipment.buyerId === duplicateId) shipment.buyerId = primaryId;
    }
  }
  duplicate.status = 'merged';
  duplicate.mergedInto = primaryId;
  duplicate.mergeReason = reason;
  log(store, when(store, at), 'buyer.merged', { buyer: primaryId, duplicate: duplicateId }, reason);
  return primary;
}

// 合作终止：双方互留终止记录与原因，此后渠道不再看到对方材料。
export function terminateCooperation(store, { partyAId, partyBId, reason } = {}, at) {
  const a = getParty(store, partyAId);
  const b = getParty(store, partyBId);
  reason = needReason(reason, '合作终止');
  const t = when(store, at);
  a.terminatedWith.push({ partyId: partyBId, reason, at: t });
  b.terminatedWith.push({ partyId: partyAId, reason, at: t });
  log(store, t, 'cooperation.terminated', { partyA: partyAId, partyB: partyBId }, reason);
  return { partyAId, partyBId, reason };
}

// ---------- 联系资料用途授权 ----------

// 联系资料只按双方同意的用途延续：from 为资料所有方，to 为使用方。
export function grantContactConsent(store, { fromId, toId, purpose } = {}, at) {
  getParty(store, fromId);
  getParty(store, toId);
  if (!purpose) fail('PURPOSE_REQUIRED', '必须注明联系资料用途');
  const t = when(store, at);
  const id = nextId(store, 'CNS');
  const consent = { id, fromId, toId, purpose, status: 'active', grantedAt: t, revokedAt: null, reason: null };
  store.consents[id] = consent;
  log(store, t, 'consent.granted', { consent: id, from: fromId, to: toId });
  return consent;
}

export function revokeContactConsent(store, { consentId, reason } = {}, at) {
  const consent = store.consents[consentId];
  if (!consent) fail('CONSENT_NOT_FOUND', `授权不存在：${consentId}`);
  reason = needReason(reason, '撤回联系授权');
  if (consent.status === 'revoked') fail('ALREADY_REVOKED', `授权 ${consentId} 已撤回`);
  consent.status = 'revoked';
  consent.revokedAt = when(store, at);
  consent.reason = reason;
  log(store, when(store, at), 'consent.revoked', { consent: consentId }, reason);
  return consent;
}

export function canUseContact(store, { fromId, toId, purpose } = {}) {
  return Object.values(store.consents).some((c) =>
    c.fromId === fromId && c.toId === toId && c.purpose === purpose && c.status === 'active');
}

// ---------- 展后：渠道可见材料 ----------

// 马来西亚合作方只看到「与自己匹配且仍有效」的材料：
// 资质已通过、类别匹配、合作未终止的参展企业及其在展展品；
// 对自己仍有效的直播授权（已撤回内容不出现）；
// 类别匹配且未关闭的采购需求。
// 联系资料仅在双方有有效用途授权时附带。
export function visibleMaterialsForPartner(store, partnerId, at) {
  const partner = getParty(store, partnerId, 'channel_partner');
  const t = when(store, at);
  const exhibitors = [];
  for (const party of Object.values(store.parties)) {
    if (party.kind !== 'exhibitor') continue;
    if (party.qualification?.status !== 'approved') continue;
    if (isTerminated(party, partner) || isTerminated(partner, party)) continue;
    const matchedCategories = party.categories.filter((c) => partner.categories.includes(c));
    if (matchedCategories.length === 0) continue;
    const exhibits = Object.values(store.exhibits)
      .filter((e) => e.exhibitorId === party.id && e.status === 'displayed' && partner.categories.includes(e.category))
      .map((e) => ({ id: e.id, name: e.name, category: e.category }));
    exhibitors.push({
      exhibitorId: party.id,
      name: party.name,
      matchedCategories,
      exhibits,
      contact: canUseContact(store, { fromId: party.id, toId: partnerId, purpose: '渠道对接' }) ? party.contact : null,
    });
  }
  const livestreams = Object.values(store.livestreams)
    .filter((l) => l.partnerId === partnerId && l.status === 'active')
    .map((l) => ({
      id: l.id,
      exhibitorId: l.exhibitorId,
      scope: l.scope,
      contents: l.contents.filter((c) => c.status === 'active'),
    }));
  const demands = Object.values(store.demands)
    .filter((d) => d.status === 'open' && d.categories.some((c) => partner.categories.includes(c)))
    .map((d) => ({
      id: d.id,
      categories: d.categories,
      quantity: d.quantity,
      budget: d.budget,
      buyerContact: canUseContact(store, { fromId: d.buyerId, toId: partnerId, purpose: '渠道对接' })
        ? store.parties[d.buyerId].contact
        : null,
    }));
  return { partnerId, at: t, exhibitors, livestreams, demands };
}

// ---------- 展后：参展商跟进与成效报告 ----------

function orderProgress(order) {
  const total = order.items.reduce((n, i) => n + i.quantity, 0);
  const done = order.items.reduce((n, i) => n + i.fulfilled, 0);
  return { total, done, ratio: total === 0 ? 0 : done / total };
}

// 参展商循着样品和订单跟进。
export function followUpsForExhibitor(store, exhibitorId) {
  getParty(store, exhibitorId, 'exhibitor');
  const samples = [];
  for (const sample of Object.values(store.samples)) {
    if (sample.exhibitorId !== exhibitorId) continue;
    for (const shipment of sample.shipments) {
      samples.push({
        shipmentId: shipment.id,
        sampleId: sample.id,
        exhibitId: sample.exhibitId,
        buyerId: shipment.buyerId,
        status: shipment.status,
        outcome: shipment.outcome,
      });
    }
  }
  const orders = Object.values(store.orders)
    .filter((o) => o.exhibitorId === exhibitorId && o.status !== 'split')
    .map((o) => ({ orderId: o.id, buyerId: o.buyerId, status: o.status, progress: orderProgress(o) }));
  const leads = Object.values(store.leads)
    .filter((l) => l.exhibitorId === exhibitorId)
    .map((l) => ({ leadId: l.id, buyerId: l.buyerId, intent: l.intent }));
  return { exhibitorId, leads, samples, orders };
}

// 可核验的客户转化：每个阶段的数量都附带构成它的记录编号。
// 已拆分的母单不计入成交，避免与子单重复。
export function conversionReport(store, at) {
  const t = when(store, at);
  const leads = Object.values(store.leads);
  const shipments = Object.values(store.samples).flatMap((s) => s.shipments);
  const quotes = Object.values(store.quotes);
  const orders = Object.values(store.orders).filter((o) => o.status !== 'split');
  const fulfilled = orders.filter((o) => o.status === 'fulfilled');
  const byIntent = { browsing: 0, sample_testing: 0, channel_interest: 0 };
  for (const lead of leads) byIntent[lead.intent] += 1;
  return {
    edition: store.edition,
    at: t,
    stages: {
      leads: { count: leads.length, refs: leads.map((l) => l.id), byIntent },
      sampleTesting: { count: shipments.length, refs: shipments.map((s) => s.id) },
      quoted: {
        count: quotes.length,
        refs: quotes.map((q) => q.id),
        stillValid: quotes.filter((q) => quoteState(store, q.id, t) === 'valid').map((q) => q.id),
      },
      ordered: { count: orders.length, refs: orders.map((o) => o.id) },
      fulfilled: { count: fulfilled.length, refs: fulfilled.map((o) => o.id) },
    },
  };
}

// 履约进度：按订单与总量两个粒度呈现。
export function fulfillmentReport(store) {
  const orders = Object.values(store.orders)
    .filter((o) => o.status !== 'split')
    .map((o) => ({
      orderId: o.id,
      exhibitorId: o.exhibitorId,
      buyerId: o.buyerId,
      status: o.status,
      ...orderProgress(o),
    }));
  const totalUnits = orders.reduce((n, o) => n + o.total, 0);
  const fulfilledUnits = orders.reduce((n, o) => n + o.done, 0);
  return {
    edition: store.edition,
    orders,
    totalUnits,
    fulfilledUnits,
    ratio: totalUnits === 0 ? 0 : fulfilledUnits / totalUnits,
  };
}

// 按记录编号追溯审计日志（含原因）。
export function changesFor(store, refId) {
  return store.changes.filter((c) => Object.values(c.refs).flat().includes(refId));
}
