// 声明式展会场景回放器：把 fixtures 中的脚本逐条映射到平台操作，
// 解析 ref（场景引用）到平台生成的记录编号，最后产出各角色视图与成效报告。
import {
  createPlatform,
  registerParty,
  submitQualification,
  reviewQualification,
  addRepresentative,
  markRepresentativeAbsent,
  registerExhibit,
  swapExhibit,
  declareSampleImport,
  reviewSampleImport,
  sendSampleForTesting,
  recordSampleOutcome,
  assignBooth,
  scheduleEvent,
  recordLead,
  recordDemand,
  holdMeeting,
  requestTranslation,
  recordMinute,
  authorizeLivestream,
  withdrawLivestream,
  issueQuote,
  acceptQuote,
  splitOrder,
  recordFulfillment,
  mergeBuyers,
  terminateCooperation,
  grantContactConsent,
  revokeContactConsent,
  visibleMaterialsForPartner,
  followUpsForExhibitor,
  conversionReport,
  fulfillmentReport,
} from './platform.js';

function bind(refs, name, value) {
  if (name) {
    if (name in refs) throw new Error(`场景引用重复：${name}`);
    refs[name] = value;
  }
  return value;
}

export function runScenario(scenario) {
  const store = createPlatform({ edition: scenario.edition, startAt: scenario.startAt });
  const refs = {};
  const id = (name) => {
    if (!(name in refs)) throw new Error(`场景引用未定义：${name}`);
    return refs[name];
  };

  for (const step of scenario.script) {
    const at = step.at ?? store.now;
    switch (step.op) {
      case 'party.register': {
        const party = registerParty(store, {
          kind: step.kind, name: step.name, country: step.country ?? null,
          categories: step.categories ?? [], regions: step.regions ?? [],
          contact: step.contact ?? null,
        }, at);
        bind(refs, step.ref, party.id);
        break;
      }
      case 'qualification.submit':
        submitQualification(store, id(step.exhibitor), step.documents, at);
        break;
      case 'qualification.review':
        reviewQualification(store, id(step.exhibitor), { approve: step.approve, reason: step.reason ?? null }, at);
        break;
      case 'representative.add': {
        const rep = addRepresentative(store, { exhibitorId: id(step.exhibitor), name: step.name, role: step.role ?? '参展代表' }, at);
        bind(refs, step.ref, rep.id);
        break;
      }
      case 'representative.absent':
        markRepresentativeAbsent(store, { representativeId: id(step.representative), reason: step.reason }, at);
        break;
      case 'exhibit.register': {
        const exhibit = registerExhibit(store, { exhibitorId: id(step.exhibitor), name: step.name, category: step.category }, at);
        bind(refs, step.ref, exhibit.id);
        break;
      }
      case 'exhibit.swap': {
        const fresh = swapExhibit(store, {
          exhibitId: id(step.exhibit),
          replacement: { name: step.replacement.name, category: step.replacement.category },
          reason: step.reason,
        }, at);
        bind(refs, step.replacement.ref, fresh.id);
        break;
      }
      case 'sample.import': {
        const sample = declareSampleImport(store, {
          exhibitorId: id(step.exhibitor), exhibitId: id(step.exhibit),
          quantity: step.quantity, customsRef: step.customsRef,
        }, at);
        bind(refs, step.ref, sample.id);
        break;
      }
      case 'sample.review':
        reviewSampleImport(store, id(step.sample), { approve: step.approve, reason: step.reason ?? null }, at);
        break;
      case 'sample.ship': {
        const shipment = sendSampleForTesting(store, { sampleId: id(step.sample), buyerId: id(step.buyer) }, at);
        bind(refs, step.ref, shipment.id);
        break;
      }
      case 'sample.outcome':
        recordSampleOutcome(store, { shipmentId: id(step.shipment), outcome: step.outcome, note: step.note ?? null }, at);
        break;
      case 'booth.assign':
        assignBooth(store, {
          exhibitorId: id(step.exhibitor), hall: step.hall, boothNo: step.boothNo,
          start: step.start, end: step.end,
        }, at);
        break;
      case 'event.schedule':
        scheduleEvent(store, { exhibitorId: id(step.exhibitor), title: step.title, start: step.start, end: step.end }, at);
        break;
      case 'lead.record': {
        const lead = recordLead(store, {
          exhibitorId: id(step.exhibitor), buyerId: id(step.buyer),
          intent: step.intent, note: step.note ?? null,
        }, at);
        bind(refs, step.ref, lead.id);
        break;
      }
      case 'demand.record': {
        const demand = recordDemand(store, {
          buyerId: id(step.buyer), categories: step.categories,
          quantity: step.quantity ?? null, budget: step.budget ?? null, note: step.note ?? null,
        }, at);
        bind(refs, step.ref, demand.id);
        break;
      }
      case 'meeting.hold': {
        const meeting = holdMeeting(store, { exhibitorId: id(step.exhibitor), buyerId: id(step.buyer) }, at);
        bind(refs, step.ref, meeting.id);
        break;
      }
      case 'translation.arrange':
        requestTranslation(store, { meetingId: id(step.meeting), fromLanguage: step.from, toLanguage: step.to }, at);
        break;
      case 'minute.record':
        recordMinute(store, { meetingId: id(step.meeting), summary: step.summary, nextSteps: step.nextSteps ?? [] }, at);
        break;
      case 'livestream.authorize': {
        const authorization = authorizeLivestream(store, {
          exhibitorId: id(step.exhibitor), partnerId: id(step.partner),
          scope: step.scope, contents: step.contents ?? [],
        }, at);
        bind(refs, step.ref, authorization.id);
        break;
      }
      case 'livestream.withdraw': {
        const authorizationId = id(step.authorization);
        const contentId = step.contentIndex != null
          ? `${authorizationId}-C${step.contentIndex + 1}`
          : null;
        withdrawLivestream(store, { authorizationId, contentId, reason: step.reason }, at);
        break;
      }
      case 'quote.issue': {
        const quote = issueQuote(store, {
          exhibitorId: id(step.exhibitor), buyerId: id(step.buyer),
          items: step.items, currency: step.currency ?? 'MYR', validDays: step.validDays ?? 7,
        }, at);
        bind(refs, step.ref, quote.id);
        break;
      }
      case 'quote.accept': {
        const order = acceptQuote(store, id(step.quote), at);
        bind(refs, step.ref, order.id);
        break;
      }
      case 'order.split': {
        const children = splitOrder(store, {
          orderId: id(step.order),
          reason: step.reason,
          splits: step.children.map((child) => ({
            label: child.label,
            items: child.items.map((item, itemIndex) => ({
              itemId: `${id(step.order)}-I${itemIndex + 1}`,
              quantity: item.quantity,
            })),
          })),
        }, at);
        step.children.forEach((child, i) => bind(refs, child.ref, children[i].id));
        break;
      }
      case 'order.fulfill':
        recordFulfillment(store, {
          orderId: id(step.order),
          itemId: `${id(step.order)}-I${(step.itemIndex ?? 0) + 1}`,
          quantity: step.quantity,
        }, at);
        break;
      case 'buyer.merge':
        mergeBuyers(store, { primaryId: id(step.primary), duplicateId: id(step.duplicate), reason: step.reason }, at);
        break;
      case 'cooperation.terminate':
        terminateCooperation(store, { partyAId: id(step.partyA), partyBId: id(step.partyB), reason: step.reason }, at);
        break;
      case 'consent.grant': {
        const consent = grantContactConsent(store, { fromId: id(step.from), toId: id(step.to), purpose: step.purpose }, at);
        bind(refs, step.ref, consent.id);
        break;
      }
      case 'consent.revoke':
        revokeContactConsent(store, { consentId: id(step.consent), reason: step.reason }, at);
        break;
      default:
        throw new Error(`未知场景操作：${step.op}`);
    }
  }

  return {
    store,
    refs,
    views: {
      nanyang: visibleMaterialsForPartner(store, refs.nanyang, scenario.reportAt),
      jinshi: visibleMaterialsForPartner(store, refs.jinshi, scenario.reportAt),
      mengzhua: followUpsForExhibitor(store, refs.mengzhua),
      conversion: conversionReport(store, scenario.reportAt),
      fulfillment: fulfillmentReport(store),
    },
  };
}
