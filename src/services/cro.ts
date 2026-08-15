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
export function croDashboard(db: Database, siteId: string) {
  const scalar = (sql:string, ...args:string[]) => (db.prepare(sql).get(...args) as { n:number }).n;
  const visitors = scalar('SELECT COUNT(DISTINCT visitor_id) n FROM cro_events WHERE site_id=?', siteId);
  const sessions = scalar('SELECT COUNT(DISTINCT session_id) n FROM cro_events WHERE site_id=?', siteId);
  const conversions = scalar("SELECT COUNT(DISTINCT session_id) n FROM cro_events WHERE site_id=? AND event_name='enquiry_completed'", siteId);
  const stages = funnel.map((name) => ({ name, count:scalar('SELECT COUNT(DISTINCT session_id) n FROM cro_events WHERE site_id=? AND event_name=?', siteId, name) }));
  const stageLabels:Record<string,string> = { page_view:'Website visit', availability_clicked:'Availability link clicked', availability_page_view:'Availability page reached', year_selected:'Year selected', month_selected:'Month selected', week_selected:'Week selected', contact_step_reached:'Contact options reached', enquiry_completed:'Enquiry completed' };
  const stageRows = stages.map((stage, index) => {
    const previous = index > 0 ? stages[index - 1] : undefined;
    const dropoff = previous ? Math.max(0, previous.count - stage.count) : 0;
    return { ...stage, label:stageLabels[stage.name], dropoff, dropoffRate:previous?.count ? Math.round(dropoff * 1000 / previous.count) / 10 : 0 };
  });
  const performance = (column:string) => db.prepare(`SELECT COALESCE(${column}, 'Direct / unknown') label, COUNT(DISTINCT session_id) sessions, COUNT(DISTINCT CASE WHEN event_name='enquiry_completed' THEN session_id END) conversions FROM cro_events WHERE site_id=? GROUP BY label ORDER BY sessions DESC`).all(siteId).map((row:any) => ({...row, rate:row.sessions ? Math.round(row.conversions*1000/row.sessions)/10 : 0}));
  const devices = performance('device_type');
  const sources = performance("NULLIF(COALESCE(utm_source, referrer), '')");
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
  const insights:string[] = [];
  const biggest = stageRows.slice(1).sort((a,b)=>b.dropoffRate-a.dropoffRate)[0];
  if (biggest?.dropoff) insights.push(`Biggest funnel drop-off: ${biggest.dropoffRate}% before ${biggest.name.replaceAll('_',' ')}.`);
  const mobile:any = devices.find((row:any)=>row.label==='mobile'); const desktop:any = devices.find((row:any)=>row.label==='desktop');
  if (mobile?.sessions >= 5 && desktop?.sessions >= 5 && mobile.rate < desktop.rate) insights.push(`Mobile converts at ${mobile.rate}% versus ${desktop.rate}% on desktop.`);
  const overall = sessions ? conversions*100/sessions : 0;
  for (const source of sources.filter((row:any)=>row.sessions>=5)) if (Math.abs(source.rate-overall)>=5) insights.push(`${source.label} conversion is unusually ${source.rate>overall?'high':'low'} at ${source.rate}%.`);
  if (!insights.length) insights.push('More traffic is needed before reliable automatic insights are available.');
  return { visitors, sessions, conversions, conversionRate:sessions ? Math.round(conversions*1000/sessions)/10 : 0, stages:stageRows, devices, sources, homepage, visitorContext, insights };
}
