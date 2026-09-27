// 读取并校验展会履约平台共享资料：
// 结构完整性之外，还校验主体引用、身份合并、变更留痕、
// 同意用途、材料可见性以及成效数字可由底层记录复算。

const REQUIRED_TOP_LEVEL = [
  'domain', 'version', 'sample_id', 'edition', 'as_of', 'actors', 'facts',
  'constraints', 'event_types', 'consent_purposes', 'organizations',
  'qualifications', 'product_catalog', 'samples', 'booths', 'show_activities',
  'activity_slots', 'representatives', 'identities', 'name_cards', 'contacts',
  'demands', 'interpretation_sessions', 'livestream_authorizations',
  'livestreams', 'livestream_retractions', 'meeting_minutes', 'quotes',
  'orders', 'collaborations', 'change_events', 'materials',
  'visibility_grants', 'sample_followups', 'outcomes',
];

const CHANGE_TYPES = [
  'exhibit_swap',
  'representative_absent',
  'identity_merge',
  'livestream_retraction',
  'order_split',
  'collaboration_terminated',
];

const CONSENT_PURPOSES = [
  'quotation_followup',
  'sample_test_followup',
  'order_fulfillment',
];

const day = (value) => String(value).slice(0, 10);
const moneyEqual = (a, b) => Math.abs(a - b) <= 0.01;
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

export function parseDomain(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('共享资料不是合法 JSON');
  }
  validateDomain(value);
  return value;
}

export function validateDomain(value) {
  const errors = [];
  const fail = (message) => errors.push(message);

  for (const field of REQUIRED_TOP_LEVEL) {
    if (value[field] === undefined) fail(`共享资料缺少必要字段：${field}`);
  }
  if (errors.length) throw new Error(errors.join('；'));

  if (value.domain !== 'overseas-exhibition-fulfillment') fail('领域标识不正确');
  if (!Number.isInteger(value.version) || value.version < 2) fail('资料版本须为不小于 2 的整数');

  const index = (rows, key = 'id') => new Map(rows.map((row) => [row[key], row]));
  const orgs = index(value.organizations);
  const products = index(value.product_catalog);
  const samples = index(value.samples);
  const booths = index(value.booths);
  const activities = index(value.show_activities);
  const slots = index(value.activity_slots);
  const reps = index(value.representatives);
  const identities = index(value.identities);
  const demands = index(value.demands);
  const interpretations = index(value.interpretation_sessions);
  const authorizations = index(value.livestream_authorizations);
  const livestreams = index(value.livestreams);
  const retractions = index(value.livestream_retractions);
  const quotes = index(value.quotes);
  const orders = index(value.orders);
  const collaborations = index(value.collaborations);
  const events = index(value.change_events);
  const materials = index(value.materials);
  const grants = index(value.visibility_grants);
  const followups = index(value.sample_followups);
  const nameCards = index(value.name_cards);
  const contacts = index(value.contacts);

  const requireOrg = (id, label) => {
    if (!orgs.has(id)) fail(`${label}引用了不存在的机构：${id}`);
  };

  // —— 主体与展前资料 ——

  for (const org of value.organizations) {
    if (org.country.length < 2) fail(`机构 ${org.id} 缺少国家/地区代码`);
  }

  for (const qual of value.qualifications) {
    const org = orgs.get(qual.org_id);
    if (!org) fail(`资质 ${qual.id} 引用了不存在的机构`);
    else if (org.role !== 'exhibitor') fail(`资质 ${qual.id} 只能属于参展企业`);
    const reviewer = orgs.get(qual.reviewed_by);
    if (!reviewer || reviewer.role !== 'host') fail(`资质 ${qual.id} 须由主办方核验`);
    if (qual.status === 'approved') {
      for (const product of value.product_catalog.filter((p) => p.org_id === qual.org_id)) {
        if (!qual.categories.includes(product.category)) {
          fail(`产品 ${product.id} 的类别不在已核准资质 ${qual.id} 范围内`);
        }
      }
    }
  }

  for (const product of value.product_catalog) {
    requireOrg(product.org_id, `产品 ${product.id}`);
  }

  for (const sample of value.samples) {
    if (!products.has(sample.product_id)) fail(`样品 ${sample.id} 引用了不存在的产品`);
    requireOrg(sample.org_id, `样品 ${sample.id}`);
    if (sample.customs_status === 'customs_cleared' && !sample.cleared_at) {
      fail(`样品 ${sample.id} 已清关但缺少清关日期`);
    }
    if (sample.customs_status === 'customs_held' && !sample.held_reason) {
      fail(`样品 ${sample.id} 被海关滞留但缺少滞留原因`);
    }
    if (sample.booth_id && !booths.has(sample.booth_id)) {
      fail(`样品 ${sample.id} 引用了不存在的展位`);
    }
  }

  for (const booth of value.booths) {
    requireOrg(booth.org_id, `展位 ${booth.id}`);
  }
  for (const activity of value.show_activities) {
    const host = orgs.get(activity.host_org_id);
    if (!host || host.role !== 'host') fail(`活动 ${activity.id} 须由主办方主办`);
  }
  for (const slot of value.activity_slots) {
    if (!activities.has(slot.activity_id)) fail(`档期 ${slot.id} 引用了不存在的活动`);
    requireOrg(slot.org_id, `档期 ${slot.id}`);
    if (slot.partner_org_id) requireOrg(slot.partner_org_id, `档期 ${slot.id}`);
    if (slot.assigned_rep_id && !reps.has(slot.assigned_rep_id)) {
      fail(`档期 ${slot.id} 指派了不存在的代表`);
    }
  }
  for (const rep of value.representatives) {
    requireOrg(rep.org_id, `代表 ${rep.id}`);
  }

  // —— 身份与名片合并 ——

  for (const identity of value.identities) {
    if (!orgs.has(identity.org_id)) fail(`身份 ${identity.id} 引用了不存在的机构`);
    if (identity.status === 'merged_away') {
      const survivor = identities.get(identity.merged_into);
      if (!survivor) fail(`已合并身份 ${identity.id} 缺少存续身份`);
      else if (survivor.status !== 'active') fail(`身份 ${identity.id} 合并目标 ${survivor.id} 不是存续身份`);
      else if (survivor.org_id !== identity.org_id) fail(`身份 ${identity.id} 跨机构合并不允许`);
    }
    if (identity.status === 'active' && identity.merged_from) {
      for (const oldId of identity.merged_from) {
        const old = identities.get(oldId);
        if (!old || old.status !== 'merged_away' || old.merged_into !== identity.id) {
          fail(`存续身份 ${identity.id} 的合并来源 ${oldId} 没有正确回指`);
        }
      }
    }
  }

  const activeIdentityRequired = (id, label) => {
    const identity = identities.get(id);
    if (!identity) fail(`${label}引用了不存在的身份：${id}`);
    else if (identity.status !== 'active') fail(`${label}引用了已合并停用的身份：${id}`);
  };

  for (const card of value.name_cards) {
    if (!booths.has(card.booth_id)) fail(`名片 ${card.id} 引用了不存在的展位`);
    activeIdentityRequired(card.identity_id, `名片 ${card.id}`);
    if (card.original_identity_id) {
      const original = identities.get(card.original_identity_id);
      if (!original || original.status !== 'merged_away' || original.merged_into !== card.identity_id) {
        fail(`名片 ${card.id} 记录的原始身份未正确合并到当前身份`);
      }
    }
  }

  // —— 联系资料与同意用途 ——

  for (const contact of value.contacts) {
    activeIdentityRequired(contact.identity_id, `联系方式 ${contact.id}`);
    if (day(contact.valid_until) < day(contact.granted_at)) {
      fail(`联系方式 ${contact.id} 有效期早于授权日期`);
    }
    for (const purpose of contact.purposes) {
      if (!CONSENT_PURPOSES.includes(purpose)) fail(`联系方式 ${contact.id} 含未知用途：${purpose}`);
    }
  }

  const consentAt = (identityId, purpose, date) =>
    value.contacts.some((contact) =>
      contact.identity_id === identityId &&
      contact.purposes.includes(purpose) &&
      day(contact.valid_until) >= day(date));

  // —— 现场需求、翻译、纪要、报价 ——

  for (const demand of value.demands) {
    activeIdentityRequired(demand.identity_id, `需求 ${demand.id}`);
    if (!reps.has(demand.captured_by)) fail(`需求 ${demand.id} 记录人不是有效代表`);
    if (demand.sample_followup_id) {
      const followup = followups.get(demand.sample_followup_id);
      if (!followup || followup.demand_id !== demand.id) {
        fail(`需求 ${demand.id} 的样品跟进缺失或没有回指`);
      }
    }
  }

  for (const session of value.interpretation_sessions) {
    if (!demands.has(session.demand_id)) fail(`翻译支持 ${session.id} 引用了不存在的需求`);
    const provider = orgs.get(session.provider_org_id);
    if (!provider || provider.role !== 'translation_provider') {
      fail(`翻译支持 ${session.id} 提供方须为翻译服务商`);
    }
  }

  for (const quote of value.quotes) {
    const demand = demands.get(quote.demand_id);
    if (!demand) fail(`报价 ${quote.id} 引用了不存在的需求`);
    activeIdentityRequired(quote.identity_id, `报价 ${quote.id}`);
    if (demand && quote.identity_id !== demand.identity_id) {
      fail(`报价 ${quote.id} 的主体与需求主体不一致`);
    }
    if (!products.has(quote.product_id)) fail(`报价 ${quote.id} 引用了不存在的产品`);
    if (!moneyEqual(quote.amount, quote.unit_price * quote.qty)) {
      fail(`报价 ${quote.id} 金额与单价×数量不符`);
    }
    const expired = day(quote.valid_until) < day(value.as_of);
    if (quote.status === 'valid' && expired) fail(`报价 ${quote.id} 已过有效期但仍标记为有效`);
    if (quote.status === 'expired' && !expired) fail(`报价 ${quote.id} 尚未过期却标记为过期`);
  }

  const demandOrderExists = (demandId) =>
    value.orders.some((order) => quotes.get(order.quote_id)?.demand_id === demandId);

  for (const demand of value.demands) {
    const demandQuotes = value.quotes.filter((quote) => quote.demand_id === demand.id);
    const hasOrder = demandOrderExists(demand.id);
    if (demand.stage === 'ordered' && !hasOrder) {
      fail(`需求 ${demand.id} 标记为已下单但找不到订单`);
    }
    if (demand.stage === 'quote_expired' && (hasOrder || demandQuotes.some((q) => q.status === 'valid'))) {
      fail(`需求 ${demand.id} 标记为报价过期，但仍有有效报价或订单`);
    }
    if (demand.stage === 'quoted' && !demandQuotes.some((q) => q.status === 'valid')) {
      fail(`需求 ${demand.id} 标记为已报价但没有有效报价`);
    }
  }

  for (const minutes of value.meeting_minutes) {
    const demand = demands.get(minutes.demand_id);
    if (!demand) fail(`纪要 ${minutes.id} 引用了不存在的需求`);
    if (!booths.has(minutes.booth_id)) fail(`纪要 ${minutes.id} 引用了不存在的展位`);
    if (demand && !minutes.attendee_identity_ids.includes(demand.identity_id)) {
      fail(`纪要 ${minutes.id} 的出席主体缺少需求所属买家`);
    }
    for (const identityId of minutes.attendee_identity_ids) activeIdentityRequired(identityId, `纪要 ${minutes.id}`);
    for (const repId of minutes.attendee_rep_ids) {
      if (!reps.has(repId)) fail(`纪要 ${minutes.id} 引用了不存在的代表`);
    }
    if (minutes.interpretation_session_id) {
      const session = interpretations.get(minutes.interpretation_session_id);
      if (!session || session.demand_id !== minutes.demand_id) {
        fail(`纪要 ${minutes.id} 关联的翻译支持不匹配`);
      }
    }
    for (const quoteId of minutes.quote_ids) {
      const quote = quotes.get(quoteId);
      if (!quote) fail(`纪要 ${minutes.id} 引用了不存在的报价`);
      else if (quote.demand_id !== minutes.demand_id) fail(`纪要 ${minutes.id} 关联了其他需求的报价`);
    }
  }

  // —— 直播授权与撤回 ——

  for (const authorization of value.livestream_authorizations) {
    requireOrg(authorization.org_id, `直播授权 ${authorization.id}`);
    const partner = orgs.get(authorization.partner_org_id);
    if (!partner || partner.role !== 'livestream_partner') {
      fail(`直播授权 ${authorization.id} 对方须为直播合作方`);
    }
    if (authorization.status === 'revoked') {
      if (!authorization.revoke_event_id) fail(`已撤回授权 ${authorization.id} 缺少撤回事件`);
      const event = events.get(authorization.revoke_event_id);
      if (!event || event.type !== 'collaboration_terminated') {
        fail(`已撤回授权 ${authorization.id} 的撤回事件不存在或类型不符`);
      }
    }
  }

  for (const stream of value.livestreams) {
    if (!slots.has(stream.slot_id)) fail(`直播 ${stream.id} 引用了不存在的档期`);
    requireOrg(stream.org_id, `直播 ${stream.id}`);
    requireOrg(stream.partner_org_id, `直播 ${stream.id}`);
    const authorization = authorizations.get(stream.authorization_id);
    if (!authorization) fail(`直播 ${stream.id} 引用了不存在的授权`);
    else if (authorization.status !== 'active' || authorization.partner_org_id !== stream.partner_org_id) {
      fail(`直播 ${stream.id} 的授权无效或合作方不一致`);
    }
    for (const productId of stream.product_ids) {
      if (!products.has(productId)) fail(`直播 ${stream.id} 引用了不存在的产品`);
    }
    for (const clip of stream.clips ?? []) {
      if (clip.status === 'retracted') {
        const retraction = retractions.get(clip.retraction_id);
        if (!retraction) fail(`片段 ${clip.id} 已撤回但缺少撤回记录`);
        else if (retraction.clip_id !== clip.id || retraction.livestream_id !== stream.id) {
          fail(`片段 ${clip.id} 的撤回记录交叉引用不一致`);
        }
      }
      if (clip.status === 'published' && clip.retraction_id) {
        fail(`片段 ${clip.id} 已发布却带有撤回编号`);
      }
    }
  }

  for (const retraction of value.livestream_retractions) {
    if (!livestreams.has(retraction.livestream_id)) fail(`撤回 ${retraction.id} 引用了不存在的直播`);
    requireOrg(retraction.requested_by, `撤回 ${retraction.id}`);
    const event = events.get(retraction.event_id);
    if (!event || event.type !== 'livestream_retraction' || event.retraction_id !== retraction.id) {
      fail(`撤回 ${retraction.id} 与变更事件未双向关联`);
    }
  }

  // —— 订单、拆分与合作 ——

  for (const order of value.orders) {
    const quote = quotes.get(order.quote_id);
    if (!quote) fail(`订单 ${order.id} 引用了不存在的报价`);
    activeIdentityRequired(order.identity_id, `订单 ${order.id}`);
    if (quote) {
      if (quote.identity_id !== order.identity_id) fail(`订单 ${order.id} 主体与报价主体不一致`);
      if (quote.product_id !== order.product_id) fail(`订单 ${order.id} 产品与报价产品不一致`);
      if (order.qty > quote.qty) fail(`订单 ${order.id} 数量超出报价数量`);
      if (!moneyEqual(order.amount, quote.unit_price * order.qty)) {
        fail(`订单 ${order.id} 金额与报价单价×数量不符`);
      }
    }
    if (!products.has(order.product_id)) fail(`订单 ${order.id} 引用了不存在的产品`);
    if (order.shipped_qty < 0 || order.shipped_qty > order.qty) fail(`订单 ${order.id} 已发数量越界`);
    if (order.status === 'completed' && order.shipped_qty !== order.qty) {
      fail(`订单 ${order.id} 标记完成但发货数量不足`);
    }
    if (order.status === 'partially_fulfilled' && !(order.shipped_qty > 0 && order.shipped_qty < order.qty)) {
      fail(`订单 ${order.id} 标记部分履约但发货数量不支持该状态`);
    }
    if (order.currency !== 'MYR') fail(`成效金额只统计 MYR 订单：${order.id}`);
    if (!consentAt(order.identity_id, 'order_fulfillment', order.placed_at)) {
      fail(`订单 ${order.id} 下单时缺少买家“订单履约”用途的有效同意`);
    }
    if (order.splits?.length) {
      if (!order.split_event_id) fail(`拆单订单 ${order.id} 缺少拆单事件`);
      const event = events.get(order.split_event_id);
      if (!event || event.type !== 'order_split' || event.order_id !== order.id) {
        fail(`订单 ${order.id} 与拆单事件未双向关联`);
      } else if (!sameSet(event.split_ids, order.splits.map((split) => split.id))) {
        fail(`订单 ${order.id} 的拆分清单与拆单事件不一致`);
      }
      const splitQty = order.splits.reduce((sum, split) => sum + split.qty, 0);
      const splitAmount = order.splits.reduce((sum, split) => sum + split.amount, 0);
      if (splitQty !== order.qty) fail(`订单 ${order.id} 拆分数量合计与订单数量不符`);
      if (!moneyEqual(splitAmount, order.amount)) fail(`订单 ${order.id} 拆分金额合计与订单金额不符`);
      for (const split of order.splits) {
        if (!orgs.has(split.assignee_org_id)) fail(`拆分 ${split.id} 承接方不存在`);
      }
    }
  }

  for (const collaboration of value.collaborations) {
    requireOrg(collaboration.org_id, `合作 ${collaboration.id}`);
    requireOrg(collaboration.partner_org_id, `合作 ${collaboration.id}`);
    if (collaboration.status === 'terminated') {
      const event = events.get(collaboration.terminated_event_id);
      if (!event || event.type !== 'collaboration_terminated' || event.collaboration_id !== collaboration.id) {
        fail(`合作 ${collaboration.id} 与终止事件未双向关联`);
      }
      for (const authId of collaboration.authorization_ids ?? []) {
        const authorization = authorizations.get(authId);
        if (!authorization) fail(`合作 ${collaboration.id} 引用了不存在的授权`);
        else if (authorization.status !== 'revoked') fail(`合作已终止但授权 ${authId} 未撤回`);
      }
      for (const authId of event?.revoked_authorization_ids ?? []) {
        if (!(collaboration.authorization_ids ?? []).includes(authId)) {
          fail(`终止事件撤回的授权 ${authId} 不属于合作 ${collaboration.id}`);
        }
      }
    }
  }

  // —— 变更事件：六类情形都要留原因 ——

  const seenTypes = new Set();
  for (const event of value.change_events) {
    if (!CHANGE_TYPES.includes(event.type)) fail(`变更事件 ${event.id} 类型未知：${event.type}`);
    if (!event.reason || !event.reason.trim()) fail(`变更事件 ${event.id} 缺少原因`);
    requireOrg(event.actor_org_id, `变更事件 ${event.id}`);
    if (event.actor_rep_id && !reps.has(event.actor_rep_id)) fail(`变更事件 ${event.id} 操作代表不存在`);
    seenTypes.add(event.type);

    if (event.type === 'exhibit_swap') {
      if (!samples.has(event.removed_sample_id) || !samples.has(event.added_sample_id)) {
        fail(`换展品事件 ${event.id} 缺少调换前后的样品`);
      }
      if (!booths.has(event.booth_id)) fail(`换展品事件 ${event.id} 缺少展位`);
      const approver = orgs.get(event.approved_by);
      if (!approver || approver.role !== 'host') fail(`换展品事件 ${event.id} 须经主办方批准`);
    }
    if (event.type === 'representative_absent') {
      const absent = reps.get(event.absent_rep_id);
      const replacement = reps.get(event.replacement_rep_id);
      if (!absent || !replacement) fail(`代表缺席事件 ${event.id} 缺少缺席或替代代表`);
      else if (absent.status === 'present') fail(`代表缺席事件 ${event.id} 的缺席代表状态仍为在场`);
      const slot = slots.get(event.activity_slot_id);
      if (!slot) fail(`代表缺席事件 ${event.id} 缺少活动档期`);
      else if (slot.assigned_rep_id !== replacement.id) {
        fail(`代表缺席事件 ${event.id} 的替代代表未实际承接档期`);
      }
    }
    if (event.type === 'identity_merge') {
      const merged = identities.get(event.merged_identity_id);
      const surviving = identities.get(event.surviving_identity_id);
      if (!merged || merged.status !== 'merged_away') fail(`合并事件 ${event.id} 的被合并身份无效`);
      if (!surviving || surviving.status !== 'active' || merged.merged_into !== surviving.id) {
        fail(`合并事件 ${event.id} 的存续身份无效`);
      }
      if (merged && surviving && merged.org_id !== surviving.org_id) {
        fail(`合并事件 ${event.id} 不允许跨机构合并`);
      }
    }
    if (event.type === 'livestream_retraction' && !retractions.has(event.retraction_id)) {
      fail(`直播撤回事件 ${event.id} 缺少撤回记录`);
    }
    if (event.type === 'order_split') {
      const order = orders.get(event.order_id);
      if (!order) fail(`拆单事件 ${event.id} 缺少订单`);
      else if (order.split_event_id !== event.id) fail(`拆单事件 ${event.id} 未被订单回指`);
      if (!event.split_ids?.length) fail(`拆单事件 ${event.id} 缺少拆分明细`);
    }
    if (event.type === 'collaboration_terminated') {
      const collaboration = collaborations.get(event.collaboration_id);
      if (!collaboration || collaboration.terminated_event_id !== event.id) {
        fail(`合作终止事件 ${event.id} 与合作记录未双向关联`);
      }
      for (const authId of event.revoked_authorization_ids ?? []) {
        if (!authorizations.has(authId)) fail(`合作终止事件 ${event.id} 撤回了不存在的授权`);
      }
    }
  }
  for (const type of CHANGE_TYPES) {
    if (!seenTypes.has(type)) fail(`缺少变更情形的留痕记录：${type}`);
  }

  // —— 跟进链：样品 → 需求 → 报价 → 订单 ——

  for (const followup of value.sample_followups) {
    activeIdentityRequired(followup.identity_id, `跟进 ${followup.id}`);
    const demand = demands.get(followup.demand_id);
    if (!demand || demand.identity_id !== followup.identity_id) {
      fail(`跟进 ${followup.id} 的需求主体不匹配`);
    }
    const contact = contacts.get(followup.contact_id);
    if (!contact) fail(`跟进 ${followup.id} 缺少联系授权记录`);
    else {
      if (contact.identity_id !== followup.identity_id) fail(`跟进 ${followup.id} 使用了他人的联系方式`);
      if (!contact.purposes.includes(followup.contact_purpose)) {
        fail(`跟进 ${followup.id} 的用途未经买家同意`);
      }
      if (day(contact.valid_until) < day(followup.last_action_at)) {
        fail(`跟进 ${followup.id} 最近动作时联系授权已过期`);
      }
    }
    if (followup.sample_id) {
      const sample = samples.get(followup.sample_id);
      if (!sample) fail(`跟进 ${followup.id} 引用了不存在的样品`);
      if (sample && sample.customs_status !== 'customs_cleared') {
        fail(`跟进 ${followup.id} 的样品尚未清关，不能安排测试`);
      }
    }
    if (followup.quote_id) {
      const quote = quotes.get(followup.quote_id);
      if (!quote || quote.demand_id !== followup.demand_id) fail(`跟进 ${followup.id} 的报价不匹配`);
    }
    if (followup.order_id) {
      const order = orders.get(followup.order_id);
      if (!order) fail(`跟进 ${followup.id} 引用了不存在的订单`);
      else {
        if (order.identity_id !== followup.identity_id) fail(`跟进 ${followup.id} 的订单主体不匹配`);
        if (followup.quote_id && order.quote_id !== followup.quote_id) {
          fail(`跟进 ${followup.id} 的订单不是基于其报价下达`);
        }
        const sample = followup.sample_id ? samples.get(followup.sample_id) : null;
        if (sample && sample.product_id !== order.product_id) {
          fail(`跟进 ${followup.id} 下单产品与送测样品不一致`);
        }
        if (followup.stage !== 'ordered') fail(`跟进 ${followup.id} 已产生订单但阶段不是 ordered`);
      }
    }
  }

  // —— 展后材料可见性：匹配且仍有效 ——

  for (const grant of value.visibility_grants) {
    const material = materials.get(grant.material_id);
    if (!material) fail(`可见性授权 ${grant.id} 引用了不存在的材料`);
    const recipient = identities.get(grant.recipient_identity_id);
    if (!recipient || recipient.status !== 'active') fail(`可见性授权 ${grant.id} 接收方身份无效`);
    const recipientOrg = recipient && orgs.get(recipient.org_id);
    if (recipientOrg && recipientOrg.country !== 'MY') {
      fail(`可见性授权 ${grant.id} 只面向马来西亚本地合作方`);
    }
    const basisDemand = demands.get(grant.basis_demand_id);
    if (!basisDemand) fail(`可见性授权 ${grant.id} 缺少需求匹配依据`);
    if (recipient && basisDemand && basisDemand.identity_id !== recipient.id) {
      fail(`可见性授权 ${grant.id} 与需求主体不匹配`);
    }
    if (material && basisDemand && material.category !== basisDemand.category) {
      fail(`可见性授权 ${grant.id} 的材料类别与买家需求不匹配`);
    }
    if (material) {
      for (const quoteId of material.quote_ids) {
        if (!quotes.has(quoteId)) fail(`材料 ${material.id} 引用了不存在的报价`);
      }
      for (const sampleId of material.sample_ids) {
        if (!samples.has(sampleId)) fail(`材料 ${material.id} 引用了不存在的样品`);
      }
      const hasValidQuote = material.quote_ids.some((quoteId) => quotes.get(quoteId).status === 'valid');
      if (grant.status === 'active' && !hasValidQuote) {
        fail(`可见性授权 ${grant.id} 仍有效，但材料没有任何有效报价`);
      }
      if (grant.status !== 'active' && hasValidQuote) {
        fail(`可见性授权 ${grant.id} 已失效，但材料仍挂着有效报价`);
      }
    }
    if (grant.status !== 'active' && (!grant.ended_at || !grant.end_reason)) {
      fail(`失效的可见性授权 ${grant.id} 必须记录结束时间与原因`);
    }
  }

  // —— 成效报告：所有数字都由底层记录复算 ——

  const outcomes = value.outcomes;
  if (outcomes.edition !== value.edition) fail('成效报告届会标识不一致');
  if (outcomes.as_of !== value.as_of) fail('成效报告统计日期不一致');
  if (outcomes.org_id && !orgs.has(outcomes.org_id)) fail('成效报告引用了不存在的机构');

  const f = outcomes.conversion_funnel;
  const p = outcomes.fulfillment_progress;
  const s = outcomes.sample_conversion;
  const e = outcomes.evidence;

  const expectCount = (actual, expected, label) => {
    if (actual !== expected) fail(`成效指标 ${label} 不可核验：报告 ${expected}，复算 ${actual}`);
  };
  const expectSet = (actualIds, expectedIds, label) => {
    if (!sameSet(actualIds, expectedIds)) {
      fail(`成效证据 ${label} 与底层记录不一致：报告 [${expectedIds.join(', ')}]，复算 [${actualIds.join(', ')}]`);
    }
  };

  const buyerIdentityIds = value.identities
    .filter((identity) => identity.kind === 'buyer' && identity.status === 'active')
    .map((identity) => identity.id);
  const arrangedFollowups = value.sample_followups.filter((followup) => followup.sample_id);
  const validQuoteIds = value.quotes.filter((quote) => quote.status === 'valid').map((quote) => quote.id);
  const wonOrders = value.orders.filter((order) =>
    ['in_fulfillment', 'partially_fulfilled', 'completed'].includes(order.status));
  const allSplits = value.orders.flatMap((order) => order.splits ?? []);
  const convertedFollowups = value.sample_followups.filter(
    (followup) => followup.stage === 'ordered' && followup.order_id);
  const testingFollowups = value.sample_followups.filter((followup) => followup.stage === 'testing');

  expectCount(value.name_cards.length, f.name_cards_collected, 'name_cards_collected');
  expectCount(buyerIdentityIds.length, f.unique_buyer_identities, 'unique_buyer_identities');
  expectCount(value.demands.length, f.demands_logged, 'demands_logged');
  expectCount(arrangedFollowups.length, f.samples_arranged, 'samples_arranged');
  expectCount(validQuoteIds.length, f.valid_quotes, 'valid_quotes');
  expectCount(wonOrders.length, f.orders_won, 'orders_won');
  const wonAmount = wonOrders.reduce((sum, order) => sum + order.amount, 0);
  if (!moneyEqual(wonAmount, f.order_amount_myr)) {
    fail(`成效指标 order_amount_myr 不可核验：报告 ${f.order_amount_myr}，复算 ${wonAmount}`);
  }

  expectCount(value.orders.length, p.orders_total, 'orders_total');
  expectCount(value.orders.filter((o) => o.status === 'in_fulfillment').length, p.in_fulfillment, 'in_fulfillment');
  expectCount(value.orders.filter((o) => o.status === 'partially_fulfilled').length, p.partially_fulfilled, 'partially_fulfilled');
  expectCount(value.orders.filter((o) => o.status === 'completed').length, p.completed, 'completed');
  expectCount(allSplits.length, p.split_legs_total, 'split_legs_total');
  expectCount(allSplits.filter((split) => split.status === 'fulfilled').length, p.split_legs_fulfilled, 'split_legs_fulfilled');
  expectCount(allSplits.filter((split) => split.status === 'pending').length, p.split_legs_pending, 'split_legs_pending');

  expectCount(testingFollowups.length, s.samples_in_testing, 'samples_in_testing');
  expectCount(convertedFollowups.length, s.samples_converted_to_order, 'samples_converted_to_order');

  expectSet(value.name_cards.map((card) => card.id), e.name_cards_collected, 'name_cards_collected');
  expectSet(buyerIdentityIds, e.unique_buyer_identities, 'unique_buyer_identities');
  expectSet(value.demands.map((demand) => demand.id), e.demands_logged, 'demands_logged');
  expectSet(arrangedFollowups.map((followup) => followup.id), e.samples_arranged, 'samples_arranged');
  expectSet(validQuoteIds, e.valid_quotes, 'valid_quotes');
  expectSet(wonOrders.map((order) => order.id), e.orders_won, 'orders_won');
  expectSet(allSplits.map((split) => split.id), e.split_legs, 'split_legs');
  expectSet(testingFollowups.map((followup) => followup.id), e.samples_in_testing, 'samples_in_testing');
  expectSet(convertedFollowups.map((followup) => followup.id), e.samples_converted_to_order, 'samples_converted_to_order');

  if (errors.length) throw new Error(errors.join('；'));
}
