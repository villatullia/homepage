import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import nunjucks from 'nunjucks';
import { croDashboard, croEventSchema, recordCroEvent, resolveCountry } from '../src/services/cro.js';
import { createTestContext } from './helpers.js';

const cleanup:Array<()=>void>=[];
afterEach(()=>cleanup.splice(0).forEach(close=>close()));
const id1='11111111-1111-4111-8111-111111111111';
const id2='22222222-2222-4222-8222-222222222222';
function event(eventName:string, visitorId=id1, sessionId=id2) { return croEventSchema.parse({ siteId:'villa-tullia', visitorId, sessionId, eventName, page:'/', referrer:'', deviceType:'desktop', properties:{} }); }

describe('CRO tracking', () => {
  it('stores anonymous events and reports the funnel', () => {
    const context=createTestContext(); cleanup.push(context.close);
    for (const name of ['page_view','availability_clicked','availability_page_view','year_selected','month_selected','week_selected','contact_step_reached','enquiry_completed']) recordCroEvent(context.db,event(name));
    expect(context.db.prepare('SELECT properties_json FROM cro_events').all()).toHaveLength(8);
    const dashboard=croDashboard(context.db,'villa-tullia');
    expect(dashboard).toMatchObject({visitors:1,sessions:1,conversions:1,conversionRate:100});
    expect(dashboard.optimizationPrompt).toContain('- Completed enquiries: 1');
    expect(dashboard.optimizationPrompt).toContain('Do not implement changes yet');
  });
  it('reports distinct visitors alongside sessions at every funnel step', () => {
    const context=createTestContext(); cleanup.push(context.close);
    const secondSession='33333333-3333-4333-8333-333333333333';
    recordCroEvent(context.db,event('page_view'));
    recordCroEvent(context.db,event('availability_clicked'));
    recordCroEvent(context.db,event('page_view',id1,secondSession));
    recordCroEvent(context.db,event('availability_clicked',id1,secondSession));
    recordCroEvent(context.db,event('availability_page_view',id1,secondSession));

    expect(croDashboard(context.db,'villa-tullia').stages.slice(0,3)).toMatchObject([
      {name:'page_view',count:2,visitors:1,visitorDropoff:0,visitorDropoffRate:0},
      {name:'availability_clicked',count:2,visitors:1,dropoff:0,dropoffRate:0,visitorDropoff:0,visitorDropoffRate:0},
      {name:'availability_page_view',count:1,visitors:1,dropoff:1,dropoffRate:50,visitorDropoff:0,visitorDropoffRate:0},
    ]);
  });

  it('builds a chronological path for each anonymous visitor across sessions', () => {
    const context=createTestContext(); cleanup.push(context.close);
    const secondSession='00000000-0000-4000-8000-000000000099';
    recordCroEvent(context.db,{...event('page_view'),page:'/'});
    recordCroEvent(context.db,{...event('availability_clicked'),properties:{placement:'hero'}});
    recordCroEvent(context.db,{...event('availability_page_view',id1,secondSession),page:'/calendarw.html'});
    const journey=croDashboard(context.db,'villa-tullia').visitorJourneys[0];
    expect(journey).toMatchObject({label:'Visitor 11111111',converted:false,eventCount:3});
    expect(journey.sessions).toHaveLength(2);
    expect(journey.sessions[1].events.map((item:any)=>item.label)).toEqual(['Viewed page','Clicked availability']);
    expect(journey.sessions[1].events[1].details).toBe('placement: hero');
    expect(journey.sessions[0].events[0]).toMatchObject({label:'Viewed availability',page:'/calendarw.html'});
  });
  it('rejects personal data in event properties', () => {
    const context=createTestContext(); cleanup.push(context.close);
    expect(()=>recordCroEvent(context.db,{...event('form_started'),properties:{email:'private@example.test'}})).toThrow('Personal data');
  });
  it('reports homepage reach, scroll, CTA and downstream conversion without duplicate inflation', () => {
    const context=createTestContext(); cleanup.push(context.close);
    recordCroEvent(context.db,event('page_view'));
    recordCroEvent(context.db,{...event('hero_cta_clicked'),properties:{text:'Check availability',destination:'/calendarw.html'}});
    recordCroEvent(context.db,{...event('scroll_depth_reached'),properties:{percent:50}});
    recordCroEvent(context.db,{...event('scroll_depth_reached'),properties:{percent:50}});
    recordCroEvent(context.db,{...event('section_viewed'),properties:{section:'reviews'}});
    recordCroEvent(context.db,{...event('availability_page_view'),page:'/calendarw.html'});
    recordCroEvent(context.db,event('enquiry_completed'));
    expect(croDashboard(context.db,'villa-tullia').homepage).toMatchObject({
      visitors:1, sessions:1, availabilitySessions:1, availabilityRate:100,
      ctas:[{label:'Main availability button',clicks:1,rate:100}],
      scroll:[{milestone:50,sessions:1,rate:100}],
      sections:[{section:'reviews',visitors:1,reachRate:100,conversions:1,conversionRate:100}],
    });
  });
  it('stores coarse visitor context and accepts a trusted country header', async () => {
    const context=createTestContext(); cleanup.push(context.close);
    recordCroEvent(context.db, {...event('page_view'),context:{browser:'Firefox',operatingSystem:'Linux',language:'it-IT',timezone:'Europe/Rome',screenSize:'large'}}, {countryCode:'IT'});
    expect(context.db.prepare('SELECT country_code,browser,operating_system,language,timezone,screen_size FROM cro_events').get()).toMatchObject({country_code:'IT',browser:'Firefox',operating_system:'Linux',language:'it-IT',timezone:'Europe/Rome',screen_size:'large'});
    expect(await resolveCountry('203.0.113.10', {'cf-ipcountry':'DE'})).toBe('DE');
    const dashboard=croDashboard(context.db,'villa-tullia');
    expect(dashboard.visitorContext.countries[0]).toMatchObject({label:'IT',countryName:'Italy',iso3:'ITA',visitors:1});
    const html=nunjucks.configure(path.resolve(process.cwd(),'src/views'), {autoescape:true}).render('cro-dashboard.njk', {title:'CRO dashboard',admin:{display_name:'Test Owner'},csrf:'test',cro:dashboard});
    expect(html).toContain('Visitors around the world');
    expect(html).toContain('data-iso3="ITA" data-country="Italy" data-visitors="1"');
    expect(html).toContain('Darker blue means more visitors');
  });
  it('reports average engaged visit time and ranks selected stay dates', () => {
    const context=createTestContext(); cleanup.push(context.close);
    const secondVisitor='44444444-4444-4444-8444-444444444444';
    const secondSession='55555555-5555-4555-8555-555555555555';
    recordCroEvent(context.db,event('page_view'));
    recordCroEvent(context.db,{...event('visit_duration'),properties:{seconds:90}});
    recordCroEvent(context.db,{...event('week_selected'),properties:{checkIn:'2027-06-05',checkOut:'2027-06-12'}});
    recordCroEvent(context.db,{...event('week_selected',secondVisitor,secondSession),properties:{checkIn:'2027-06-05',checkOut:'2027-06-12'}});
    recordCroEvent(context.db,{...event('visit_duration',secondVisitor,secondSession),properties:{seconds:30}});
    recordCroEvent(context.db,{...event('month_selected'),properties:{year:2027,month:6}});
    recordCroEvent(context.db,{...event('year_selected'),properties:{year:2027}});
    const dashboard=croDashboard(context.db,'villa-tullia');
    expect(dashboard).toMatchObject({averageVisitDurationSeconds:60,averageVisitDurationFormatted:'1m 00s'});
    expect(dashboard.stayInterest.weeks[0]).toMatchObject({label:'5 Jun 2027 – 12 Jun 2027',clicks:2,visitors:2,barPercent:100});
    expect(dashboard.stayInterest.months[0]).toMatchObject({label:'June 2027',clicks:1});
    expect(dashboard.stayInterest.years[0]).toMatchObject({label:'2027',clicks:1});
  });
  it('excludes the owner test devices from every dashboard calculation', () => {
    const context=createTestContext(); cleanup.push(context.close);
    const ownerLaptop='41dd1afc-1111-4111-8111-111111111111';
    const ownerMobile='1c7b359f-2222-4222-8222-222222222222';
    recordCroEvent(context.db,event('page_view'));
    recordCroEvent(context.db,event('page_view',ownerLaptop,'66666666-6666-4666-8666-666666666666'));
    recordCroEvent(context.db,event('enquiry_completed',ownerLaptop,'66666666-6666-4666-8666-666666666666'));
    recordCroEvent(context.db,{...event('week_selected',ownerMobile,'77777777-7777-4777-8777-777777777777'),properties:{checkIn:'2027-08-07',checkOut:'2027-08-14'}});
    const dashboard=croDashboard(context.db,'villa-tullia');
    expect(dashboard).toMatchObject({visitors:1,sessions:1,conversions:0,conversionRate:0});
    expect(dashboard.stayInterest.weeks).toEqual([]);
    expect(dashboard.visitorJourneys.map(visitor=>visitor.label)).toEqual(['Visitor 11111111']);
  });
});
