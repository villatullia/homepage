(function (global) {
  'use strict';
  const config = global.CRO_CONFIG || {};
  const siteId = config.siteId || document.documentElement.dataset.croSite;
  if (!siteId) return;
  const debug = config.debug === true || new URLSearchParams(location.search).get('cro_debug') === '1';
  const uuid = () => crypto.randomUUID();
  const read = (key, storage) => { try { return storage.getItem(key); } catch { return null; } };
  const write = (key, value, storage) => { try { storage.setItem(key, value); } catch {} };
  let visitorId = read('cro_visitor_id', localStorage) || uuid(); write('cro_visitor_id', visitorId, localStorage);
  let sessionId = read('cro_session_id', sessionStorage) || uuid(); write('cro_session_id', sessionId, sessionStorage);
  const params = new URLSearchParams(location.search);
  const firstTouchKey = `cro_utm_${siteId}`;
  let utm = {}; try { utm = JSON.parse(read(firstTouchKey, localStorage) || '{}'); } catch {}
  ['source','medium','campaign','term','content'].forEach(k => { const value=params.get(`utm_${k}`); if(value) utm[k]=value; });
  write(firstTouchKey, JSON.stringify(utm), localStorage);
  const deviceType = /iPad|Tablet/i.test(navigator.userAgent) ? 'tablet' : /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop';
  function track(eventName, properties) {
    let referrer=''; try { const url=new URL(document.referrer); referrer=url.origin+url.pathname; } catch {}
    const payload={siteId,visitorId,sessionId,eventName,page:location.pathname,referrer,deviceType,utm,properties:properties||{}};
    if(debug) console.debug('[CRO]', eventName, payload);
    const body=JSON.stringify(payload);
    if(navigator.sendBeacon) navigator.sendBeacon('/api/cro/events', new Blob([body], {type:'application/json'}));
    else fetch('/api/cro/events',{method:'POST',headers:{'Content-Type':'application/json'},body,keepalive:true}).catch(()=>{});
  }
  const trackedOnce = new Set();
  function trackOnce(key, eventName, properties) {
    if (trackedOnce.has(key)) return false;
    trackedOnce.add(key); track(eventName, properties); return true;
  }
  global.cro={track,trackOnce,visitorId,sessionId};
  track('page_view');
})(window);
