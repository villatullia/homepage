import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../db.js';
import { nowIso } from '../lib/format.js';
import { sha256 } from '../lib/crypto.js';

export const croEventSchema = z.object({
  siteId: z.string().min(1).max(80), visitorId: z.string().uuid(), sessionId: z.string().uuid(),
  eventName: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), page: z.string().max(500),
  referrer: z.string().max(1000).optional().default(''), deviceType: z.enum(['mobile', 'tablet', 'desktop']),
  utm: z.object({ source:z.string().max(200).optional(), medium:z.string().max(200).optional(), campaign:z.string().max(200).optional(), term:z.string().max(200).optional(), content:z.string().max(200).optional() }).optional().default({}),
  context: z.object({ browser:z.string().max(30).optional(), operatingSystem:z.string().max(30).optional(), language:z.string().max(20).optional(), timezone:z.string().max(80).optional(), screenSize:z.enum(['small','medium','large']).optional() }).optional().default({}),
  properties: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).optional().default({}),
});

export function recordCroEvent(db: Database, input: z.infer<typeof croEventSchema>, serverContext: { countryCode?: string } = {}) {
  const event = croEventSchema.parse(input);
  const forbidden = /^(name|full_?name|email|phone|message|password|address|form|contents?)$/i;
  if (Object.keys(event.properties).some((key) => forbidden.test(key))) throw Object.assign(new Error('Personal data is not accepted'), { statusCode: 400 });
  const site = db.prepare('SELECT 1 FROM cro_sites WHERE id = ?').get(event.siteId);
  if (!site) throw Object.assign(new Error('Unknown site'), { statusCode: 400 });
  db.prepare(`INSERT INTO cro_events (id,site_id,visitor_id,session_id,event_name,occurred_at,page,referrer,device_type,utm_source,utm_medium,utm_campaign,utm_term,utm_content,properties_json,country_code,browser,operating_system,language,timezone,screen_size)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), event.siteId, event.visitorId, event.sessionId, event.eventName, nowIso(), event.page, event.referrer || null, event.deviceType, event.utm.source ?? null, event.utm.medium ?? null, event.utm.campaign ?? null, event.utm.term ?? null, event.utm.content ?? null, JSON.stringify(event.properties), serverContext.countryCode ?? null, event.context.browser ?? null, event.context.operatingSystem ?? null, event.context.language ?? null, event.context.timezone ?? null, event.context.screenSize ?? null);
}

const countryCache = new Map<string, { country?: string; expires:number }>();
export async function resolveCountry(ip: string, headers: Record<string, string | string[] | undefined>): Promise<string | undefined> {
  const supplied = [headers['cf-ipcountry'], headers['x-vercel-ip-country'], headers['cloudfront-viewer-country']].find(value => typeof value === 'string');
  if (typeof supplied === 'string' && /^[A-Z]{2}$/.test(supplied)) return supplied;
  if (ip === '127.0.0.1' || ip === '::1') return undefined;
  const cacheKey=sha256(ip);
  const cached = countryCache.get(cacheKey); if (cached && cached.expires > Date.now()) return cached.country;
  let country:string|undefined;
  try {
    const response = await fetch(`https://api.country.is/${encodeURIComponent(ip)}`, { signal:AbortSignal.timeout(1500) });
    if (response.ok) { const data=await response.json() as {country?:string}; if (data.country && /^[A-Z]{2}$/.test(data.country)) country=data.country; }
  } catch { /* Tracking must never interfere with the visitor experience. */ }
  countryCache.set(cacheKey, { country, expires:Date.now()+24*60*60*1000 });
  return country;
}

const funnel = ['page_view','availability_clicked','availability_page_view','year_selected','month_selected','week_selected','contact_step_reached','enquiry_completed'];

function optimizationPrompt(data: {
  visitors:number; sessions:number; conversions:number; conversionRate:number;
  stages:Array<{label:string;count:number;dropoffRate:number;visitors:number;visitorDropoffRate:number}>;
  devices:Array<any>; sources:Array<any>; homepage:any; visitorContext:any; insights:string[];
  averageVisitDurationFormatted:string; stayInterest:any;
}) {
  const rows = (items:Array<Record<string, unknown>>, format:(row:Record<string, any>)=>string, empty='No data yet') =>
    items.length ? items.slice(0, 10).map(format).join('\n') : `- ${empty}`;
  return `Act as a conversion-rate optimization consultant for Villa Tullia, a direct-booking holiday villa website on Lake Garda. Analyze the privacy-safe analytics below and, if you have access to the website files in the current workspace, inspect the actual pages and booking journey before making recommendations.

Please provide:
1. A concise diagnosis of the most important conversion bottlenecks, citing the data behind each finding.
2. A prioritized list of improvements, ranked by likely impact, confidence, and implementation effort.
3. Specific A/B tests with a hypothesis, exact change, primary metric, guardrail metric, and suggested minimum evidence needed to decide.
4. Concrete copy, CTA, layout, trust, mobile, and booking-flow suggestions where relevant.
5. Any tracking gaps or data-quality issues that should be fixed before drawing stronger conclusions.

Do not treat correlation as causation. Be explicit about uncertainty, especially when sample sizes are small. Distinguish visitors from sessions. Do not implement changes yet; recommend them first.

OVERALL
- Visitors: ${data.visitors}
- Sessions: ${data.sessions}
- Completed enquiries: ${data.conversions}
- Session conversion rate: ${data.conversionRate}%
- Average engaged visit time: ${data.averageVisitDurationFormatted}

AUTOMATIC SIGNALS
${data.insights.map(value=>`- ${value}`).join('\n')}

BOOKING FUNNEL
${rows(data.stages, row=>`- ${row.label}: ${row.count} sessions, ${row.visitors} visitors; drop-off from prior step ${row.dropoffRate}% of sessions / ${row.visitorDropoffRate}% of visitors`)}

MOST SELECTED WEEKS
${rows(data.stayInterest.weeks, row=>`- ${row.label}: ${row.clicks} selections by ${row.visitors} visitors`)}

HOMEPAGE
- ${data.homepage.visitors} visitors / ${data.homepage.sessions} sessions
- Homepage to availability page: ${data.homepage.availabilitySessions} sessions (${data.homepage.availabilityRate}%)
CTA interactions:
${rows(data.homepage.ctas, row=>`- ${row.label}: ${row.clicks} sessions (${row.rate}% of homepage sessions)`)}
Scroll depth:
${rows(data.homepage.scroll, row=>`- ${row.milestone}%: ${row.sessions} sessions (${row.rate}% of homepage sessions)`)}
Section exposure and later enquiry rate:
${rows(data.homepage.sections, row=>`- ${row.section}: ${row.visitors} visitors reached it (${row.reachRate}%); ${row.conversions} later enquired (${row.conversionRate}%)`)}

DEVICE PERFORMANCE
${rows(data.devices, row=>`- ${row.label}: ${row.sessions} sessions, ${row.conversions} enquiries (${row.rate}%)`)}

TOP TRAFFIC SOURCES / REFERRERS
${rows(data.sources, row=>`- ${row.label}: ${row.sessions} sessions, ${row.conversions} enquiries (${row.rate}%)`)}

VISITOR CONTEXT (visitor-level enquiry rate)
Countries:
${rows(data.visitorContext.countries, row=>`- ${row.label}: ${row.visitors} visitors, ${row.conversions} enquiries (${row.rate}%)`)}
Languages:
${rows(data.visitorContext.languages, row=>`- ${row.label}: ${row.visitors} visitors, ${row.conversions} enquiries (${row.rate}%)`)}
Browsers:
${rows(data.visitorContext.browsers, row=>`- ${row.label}: ${row.visitors} visitors, ${row.conversions} enquiries (${row.rate}%)`)}
Operating systems:
${rows(data.visitorContext.operatingSystems, row=>`- ${row.label}: ${row.visitors} visitors, ${row.conversions} enquiries (${row.rate}%)`)}`;
}

export function croDashboard(db: Database, siteId: string) {
  const scalar = (sql:string, ...args:string[]) => (db.prepare(sql).get(...args) as { n:number }).n;
  const visitors = scalar('SELECT COUNT(DISTINCT visitor_id) n FROM cro_events WHERE site_id=?', siteId);
  const sessions = scalar('SELECT COUNT(DISTINCT session_id) n FROM cro_events WHERE site_id=?', siteId);
  const conversions = scalar("SELECT COUNT(DISTINCT session_id) n FROM cro_events WHERE site_id=? AND event_name='enquiry_completed'", siteId);
  const stages = funnel.map((name) => ({
    name,
    count:scalar('SELECT COUNT(DISTINCT session_id) n FROM cro_events WHERE site_id=? AND event_name=?', siteId, name),
    visitors:scalar('SELECT COUNT(DISTINCT visitor_id) n FROM cro_events WHERE site_id=? AND event_name=?', siteId, name),
  }));
  const stageLabels:Record<string,string> = { page_view:'Website visit', availability_clicked:'Availability link clicked', availability_page_view:'Availability page reached', year_selected:'Year selected', month_selected:'Month selected', week_selected:'Week selected', contact_step_reached:'Contact options reached', enquiry_completed:'Enquiry completed' };
  const stageRows = stages.map((stage, index) => {
    const previous = index > 0 ? stages[index - 1] : undefined;
    const dropoff = previous ? Math.max(0, previous.count - stage.count) : 0;
    const visitorDropoff = previous ? Math.max(0, previous.visitors - stage.visitors) : 0;
    return {
      ...stage,
      label:stageLabels[stage.name] ?? stage.name,
      dropoff,
      dropoffRate:previous?.count ? Math.round(dropoff * 1000 / previous.count) / 10 : 0,
      visitorDropoff,
      visitorDropoffRate:previous?.visitors ? Math.round(visitorDropoff * 1000 / previous.visitors) / 10 : 0,
    };
  });
  const performance = (column:string) => db.prepare(`SELECT COALESCE(${column}, 'Direct / unknown') label, COUNT(DISTINCT session_id) sessions, COUNT(DISTINCT CASE WHEN event_name='enquiry_completed' THEN session_id END) conversions FROM cro_events WHERE site_id=? GROUP BY label ORDER BY sessions DESC`).all(siteId).map((row:any) => ({...row, rate:row.sessions ? Math.round(row.conversions*1000/row.sessions)/10 : 0}));
  const devices = performance('device_type');
  const sources = performance("NULLIF(COALESCE(utm_source, referrer), '')");
  const durationRows = db.prepare(`SELECT session_id,
      MAX(CASE WHEN event_name='visit_duration' THEN CAST(json_extract(properties_json,'$.seconds') AS REAL) END) tracked_seconds,
      MAX(0, (julianday(MAX(occurred_at)) - julianday(MIN(occurred_at))) * 86400.0) observed_seconds
    FROM cro_events WHERE site_id=? GROUP BY session_id`).all(siteId) as Array<{session_id:string;tracked_seconds:number|null;observed_seconds:number}>;
  const averageVisitDurationSeconds = durationRows.length ? Math.round(durationRows.reduce((total, row) => total + Math.max(0, row.tracked_seconds ?? row.observed_seconds ?? 0), 0) / durationRows.length) : 0;
  const formatDuration = (seconds:number) => seconds >= 3600
    ? `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  const dateLabel = (value:string) => new Intl.DateTimeFormat('en-GB', { timeZone:'UTC', day:'numeric', month:'short', year:'numeric' }).format(new Date(`${value}T00:00:00Z`));
  const weekRows = db.prepare(`SELECT json_extract(properties_json,'$.checkIn') check_in, json_extract(properties_json,'$.checkOut') check_out,
      COUNT(*) clicks, COUNT(DISTINCT visitor_id) visitors
    FROM cro_events WHERE site_id=? AND event_name='week_selected' AND json_extract(properties_json,'$.checkIn') IS NOT NULL
    GROUP BY check_in, check_out ORDER BY clicks DESC, check_in ASC LIMIT 10`).all(siteId) as Array<{check_in:string;check_out:string;clicks:number;visitors:number}>;
  const maxWeekClicks = Math.max(0, ...weekRows.map(row => row.clicks));
  const monthRows = db.prepare(`SELECT CAST(json_extract(properties_json,'$.year') AS INTEGER) year, CAST(json_extract(properties_json,'$.month') AS INTEGER) month,
      COUNT(*) clicks, COUNT(DISTINCT visitor_id) visitors
    FROM cro_events WHERE site_id=? AND event_name='month_selected' AND json_extract(properties_json,'$.year') IS NOT NULL
    GROUP BY year, month ORDER BY clicks DESC, year ASC, month ASC LIMIT 6`).all(siteId) as Array<{year:number;month:number;clicks:number;visitors:number}>;
  const yearRows = db.prepare(`SELECT CAST(json_extract(properties_json,'$.year') AS INTEGER) year, COUNT(*) clicks, COUNT(DISTINCT visitor_id) visitors
    FROM cro_events WHERE site_id=? AND event_name='year_selected' AND json_extract(properties_json,'$.year') IS NOT NULL
    GROUP BY year ORDER BY clicks DESC, year ASC`).all(siteId) as Array<{year:number;clicks:number;visitors:number}>;
  const stayInterest = {
    weeks:weekRows.map(row => ({ ...row, label:`${dateLabel(row.check_in)} – ${dateLabel(row.check_out)}`, barPercent:maxWeekClicks ? Math.round(row.clicks * 100 / maxWeekClicks) : 0 })),
    months:monthRows.map(row => ({ ...row, label:new Intl.DateTimeFormat('en-GB', { month:'long', year:'numeric', timeZone:'UTC' }).format(new Date(Date.UTC(row.year, row.month - 1, 1))) })),
    years:yearRows.map(row => ({ ...row, label:String(row.year) })),
  };
  const homepageSessions = scalar("SELECT COUNT(DISTINCT session_id) n FROM cro_events WHERE site_id=? AND event_name='page_view' AND page IN ('/','/index.html')", siteId);
  const homepageVisitors = scalar("SELECT COUNT(DISTINCT visitor_id) n FROM cro_events WHERE site_id=? AND event_name='page_view' AND page IN ('/','/index.html')", siteId);
  const homepageToAvailability = scalar(`SELECT COUNT(DISTINCT h.session_id) n FROM cro_events h WHERE h.site_id=? AND h.event_name='page_view' AND h.page IN ('/','/index.html') AND EXISTS (SELECT 1 FROM cro_events a WHERE a.site_id=h.site_id AND a.session_id=h.session_id AND a.event_name='availability_page_view')`, siteId);
  const ctaRows = db.prepare(`SELECT event_name label, COUNT(DISTINCT session_id) clicks FROM cro_events WHERE site_id=? AND event_name IN ('hero_cta_clicked','secondary_cta_clicked','contact_clicked','location_clicked') GROUP BY event_name ORDER BY clicks DESC`).all(siteId) as Array<{label:string;clicks:number}>;
  const homepage = {
    visitors:homepageVisitors, sessions:homepageSessions,
    availabilitySessions:homepageToAvailability,
    availabilityRate:homepageSessions ? Math.round(homepageToAvailability*1000/homepageSessions)/10 : 0,
    ctas:ctaRows.map(row=>({...row, label:({hero_cta_clicked:'Main availability button',secondary_cta_clicked:'Secondary homepage buttons',contact_clicked:'Contact links',location_clicked:'Directions link'} as Record<string,string>)[row.label] ?? row.label, rate:homepageSessions ? Math.round(row.clicks*1000/homepageSessions)/10 : 0})),
    scroll:(db.prepare(`SELECT CAST(json_extract(properties_json,'$.percent') AS INTEGER) milestone, COUNT(DISTINCT session_id) sessions FROM cro_events WHERE site_id=? AND event_name='scroll_depth_reached' GROUP BY milestone ORDER BY milestone`).all(siteId) as Array<{milestone:number;sessions:number}>).map(row=>({...row, rate:homepageSessions ? Math.round(row.sessions*1000/homepageSessions)/10 : 0})),
    sections:(db.prepare(`WITH exposures AS (
      SELECT visitor_id, json_extract(properties_json,'$.section') section, MIN(occurred_at) seen_at
      FROM cro_events WHERE site_id=? AND event_name='section_viewed' GROUP BY visitor_id, section
    ) SELECT section, COUNT(*) visitors,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM cro_events c WHERE c.site_id=? AND c.visitor_id=exposures.visitor_id AND c.event_name='enquiry_completed' AND c.occurred_at>=exposures.seen_at) THEN 1 ELSE 0 END) conversions
      FROM exposures GROUP BY section ORDER BY visitors DESC`).all(siteId, siteId) as Array<{section:string;visitors:number;conversions:number}>).map(row=>({...row, reachRate:homepageVisitors ? Math.round(row.visitors*1000/homepageVisitors)/10 : 0, conversionRate:row.visitors ? Math.round(row.conversions*1000/row.visitors)/10 : 0})),
  };
  const contextPerformance = (column:string) => (db.prepare(`SELECT COALESCE(${column}, 'Unknown') label, COUNT(DISTINCT visitor_id) visitors, COUNT(DISTINCT CASE WHEN event_name='enquiry_completed' THEN visitor_id END) conversions FROM cro_events WHERE site_id=? GROUP BY label ORDER BY visitors DESC`).all(siteId) as Array<{label:string;visitors:number;conversions:number}>).map(row=>({...row, rate:row.visitors ? Math.round(row.conversions*1000/row.visitors)/10 : 0}));
  const visitorContext = { countries:contextPerformance('country_code'), browsers:contextPerformance('browser'), operatingSystems:contextPerformance('operating_system'), languages:contextPerformance('language'), screenSizes:contextPerformance('screen_size') };
  type JourneyEventRow = {
    visitor_id:string; session_id:string; event_name:string; occurred_at:string; page:string;
    properties_json:string; country_code:string|null; browser:string|null; operating_system:string|null;
    language:string|null; device_type:string|null; referrer:string|null; utm_source:string|null;
  };
  const journeyEventLabels:Record<string,string> = {
    page_view:'Viewed page', availability_clicked:'Clicked availability', availability_page_view:'Viewed availability',
    year_selected:'Selected year', month_selected:'Selected month', week_selected:'Selected week',
    contact_step_reached:'Reached contact options', email_form_started:'Started email enquiry',
    email_form_submitted:'Submitted email enquiry', enquiry_completed:'Completed enquiry',
    hero_cta_clicked:'Clicked main button', secondary_cta_clicked:'Clicked secondary button',
    contact_clicked:'Clicked contact link', whatsapp_clicked:'Clicked WhatsApp', location_clicked:'Opened directions',
    gallery_opened:'Opened gallery', gallery_interacted:'Used gallery', reviews_viewed:'Viewed reviews',
    reviews_interacted:'Used reviews', section_viewed:'Viewed section', scroll_depth_reached:'Reached scroll depth',
    language_suggestion_shown:'Saw language suggestion', language_selected:'Changed language',
  };
  const formatJourneyTime = (value:string) => new Intl.DateTimeFormat('en-GB', {
    timeZone:'Europe/Rome', day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit',
  }).format(new Date(value));
  const journeyRows = db.prepare(`SELECT visitor_id,session_id,event_name,occurred_at,page,properties_json,country_code,browser,operating_system,language,device_type,referrer,utm_source
    FROM cro_events WHERE site_id=? AND event_name!='visit_duration' ORDER BY occurred_at ASC, rowid ASC`).all(siteId) as JourneyEventRow[];
  const journeyMap = new Map<string, any>();
  for (const row of journeyRows) {
    let visitor = journeyMap.get(row.visitor_id);
    if (!visitor) {
      visitor = { id:row.visitor_id, label:`Visitor ${row.visitor_id.slice(0, 8).toUpperCase()}`, firstSeen:row.occurred_at, lastSeen:row.occurred_at, sessions:new Map<string, any>(), country:row.country_code ?? 'Unknown', browser:row.browser ?? 'Unknown', operatingSystem:row.operating_system ?? 'Unknown', language:row.language ?? 'Unknown', device:row.device_type ?? 'Unknown', source:row.utm_source || row.referrer || 'Direct / unknown', converted:false };
      journeyMap.set(row.visitor_id, visitor);
    }
    visitor.lastSeen = row.occurred_at;
    visitor.country = row.country_code ?? visitor.country;
    visitor.browser = row.browser ?? visitor.browser;
    visitor.operatingSystem = row.operating_system ?? visitor.operatingSystem;
    visitor.language = row.language ?? visitor.language;
    visitor.device = row.device_type ?? visitor.device;
    visitor.converted ||= row.event_name === 'enquiry_completed';
    let session = visitor.sessions.get(row.session_id);
    if (!session) {
      session = { id:row.session_id, firstSeen:row.occurred_at, lastSeen:row.occurred_at, events:[] };
      visitor.sessions.set(row.session_id, session);
    }
    session.lastSeen = row.occurred_at;
    let properties:Record<string, string|number|boolean|null> = {};
    try { properties = JSON.parse(row.properties_json) as typeof properties; } catch { /* Old malformed event data should not break the dashboard. */ }
    session.events.push({
      name:row.event_name, label:journeyEventLabels[row.event_name] ?? row.event_name.replaceAll('_', ' '),
      occurredAt:row.occurred_at, time:formatJourneyTime(row.occurred_at), page:row.page,
      details:Object.entries(properties).map(([key, value]) => `${key.replaceAll('_', ' ')}: ${String(value)}`).join(' · '),
    });
  }
  const visitorJourneys = [...journeyMap.values()].map(visitor => ({
    ...visitor, firstSeenFormatted:formatJourneyTime(visitor.firstSeen), lastSeenFormatted:formatJourneyTime(visitor.lastSeen),
    eventCount:[...visitor.sessions.values()].reduce((total:number, session:any) => total + session.events.length, 0),
    sessions:[...visitor.sessions.values()].reverse().map((session:any, index:number, sessions:any[]) => ({
      ...session, number:sessions.length-index, firstSeenFormatted:formatJourneyTime(session.firstSeen), eventCount:session.events.length,
    })),
  })).sort((a,b) => b.lastSeen.localeCompare(a.lastSeen));
  const insights:string[] = [];
  const biggest = stageRows.slice(1).sort((a,b)=>b.dropoffRate-a.dropoffRate)[0];
  if (biggest?.dropoff) insights.push(`Biggest funnel drop-off: ${biggest.dropoffRate}% before ${biggest.name.replaceAll('_',' ')}.`);
  const mobile:any = devices.find((row:any)=>row.label==='mobile'); const desktop:any = devices.find((row:any)=>row.label==='desktop');
  if (mobile?.sessions >= 5 && desktop?.sessions >= 5 && mobile.rate < desktop.rate) insights.push(`Mobile converts at ${mobile.rate}% versus ${desktop.rate}% on desktop.`);
  const overall = sessions ? conversions*100/sessions : 0;
  for (const source of sources.filter((row:any)=>row.sessions>=5)) if (Math.abs(source.rate-overall)>=5) insights.push(`${source.label} conversion is unusually ${source.rate>overall?'high':'low'} at ${source.rate}%.`);
  if (!insights.length) insights.push('More traffic is needed before reliable automatic insights are available.');
  const dashboard = { visitors, sessions, conversions, conversionRate:sessions ? Math.round(conversions*1000/sessions)/10 : 0, averageVisitDurationSeconds, averageVisitDurationFormatted:formatDuration(averageVisitDurationSeconds), stayInterest, stages:stageRows, devices, sources, homepage, visitorContext, visitorJourneys, insights };
  return { ...dashboard, optimizationPrompt:optimizationPrompt(dashboard) };
}
