(function (global) {
  'use strict';
  const config = global.CRO_CONFIG || {};
  const siteId = config.siteId || document.documentElement.dataset.croSite;
  if (!siteId) return;
  const debug = config.debug === true || new URLSearchParams(location.search).get('cro_debug') === '1';
  const uuid = () => crypto.randomUUID();
  const read = (key, storage) => { try { return storage.getItem(key); } catch { return null; } };
  const write = (key, value, storage) => { try { storage.setItem(key, value); } catch {} };
  const existingVisitorId = read('cro_visitor_id', localStorage);
  let visitorId = existingVisitorId || uuid(); write('cro_visitor_id', visitorId, localStorage);
  let sessionId = read('cro_session_id', sessionStorage) || uuid(); write('cro_session_id', sessionId, sessionStorage);
  const firstSessionKey = `cro_first_session_${siteId}`;
  const firstSessionId = read(firstSessionKey, localStorage);
  const isReturningVisitor = firstSessionId ? firstSessionId !== sessionId : Boolean(existingVisitorId);
  if (!firstSessionId) write(firstSessionKey, existingVisitorId ? 'prior-session' : sessionId, localStorage);
  const params = new URLSearchParams(location.search);
  const firstTouchKey = `cro_utm_${siteId}`;
  let utm = {}; try { utm = JSON.parse(read(firstTouchKey, localStorage) || '{}'); } catch {}
  ['source','medium','campaign','term','content'].forEach(k => { const value=params.get(`utm_${k}`); if(value) utm[k]=value; });
  write(firstTouchKey, JSON.stringify(utm), localStorage);
  const deviceType = /iPad|Tablet/i.test(navigator.userAgent) ? 'tablet' : /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop';
  const browser = /Edg\//.test(navigator.userAgent) ? 'Edge' : /Firefox\//.test(navigator.userAgent) ? 'Firefox' : /CriOS|Chrome\//.test(navigator.userAgent) ? 'Chrome' : /Safari\//.test(navigator.userAgent) ? 'Safari' : 'Other';
  const operatingSystem = /Windows/i.test(navigator.userAgent) ? 'Windows' : /Android/i.test(navigator.userAgent) ? 'Android' : /iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'iOS' : /Mac OS/i.test(navigator.userAgent) ? 'macOS' : /Linux/i.test(navigator.userAgent) ? 'Linux' : 'Other';
  const width = Math.max(screen.width || 0, screen.height || 0);
  const screenSize = width < 768 ? 'small' : width < 1200 ? 'medium' : 'large';
  const context = { browser, operatingSystem, language:(navigator.language || '').slice(0,20), timezone:(Intl.DateTimeFormat().resolvedOptions().timeZone || '').slice(0,80), screenSize };
  function track(eventName, properties) {
    let referrer=''; try { const url=new URL(document.referrer); referrer=url.origin+url.pathname; } catch {}
    const payload={siteId,visitorId,sessionId,eventName,page:location.pathname,referrer,deviceType,utm,context,properties:{pageLanguage:(document.documentElement.lang||'').slice(0,10),...(properties||{})}};
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
  const activeTimeKey = `cro_active_ms_${siteId}`;
  let activeMs = Number(read(activeTimeKey, sessionStorage)) || 0;
  let visibleSince = document.visibilityState === 'visible' ? Date.now() : null;
  const settleVisibleTime = () => {
    if (visibleSince === null) return;
    activeMs += Math.max(0, Date.now() - visibleSince);
    visibleSince = null;
    write(activeTimeKey, String(activeMs), sessionStorage);
  };
  const reportVisitDuration = () => {
    const seconds = Math.max(0, Math.round((activeMs + (visibleSince === null ? 0 : Date.now() - visibleSince)) / 1000));
    track('visit_duration', { seconds });
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { settleVisibleTime(); reportVisitDuration(); }
    else if (visibleSince === null) visibleSince = Date.now();
  });
  global.addEventListener('pagehide', () => { settleVisibleTime(); reportVisitDuration(); });
  global.setInterval(() => { if (document.visibilityState === 'visible') reportVisitDuration(); }, 30000);
  global.cro={track,trackOnce,visitorId,sessionId,isReturningVisitor};
  track('page_view');
  const returningTrackedKey = `cro_returning_tracked_${siteId}`;
  if (isReturningVisitor && !read(returningTrackedKey, sessionStorage)) {
    write(returningTrackedKey, '1', sessionStorage);
    track('returning_visit');
  }
})(window);
