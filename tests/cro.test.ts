import { afterEach, describe, expect, it } from 'vitest';
import { croDashboard, croEventSchema, recordCroEvent } from '../src/services/cro.js';
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
    expect(croDashboard(context.db,'villa-tullia')).toMatchObject({visitors:1,sessions:1,conversions:1,conversionRate:100});
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
      ctas:[{label:'hero_cta_clicked',clicks:1,rate:100}],
      scroll:[{milestone:50,sessions:1,rate:100}],
      sections:[{section:'reviews',visitors:1,reachRate:100,conversions:1,conversionRate:100}],
    });
  });
});
