(() => {
  const copy = {
    en:{launcher:'Ask Alex',title:'Chat with Alex',subtitle:'Ask about the villa or your stay',greeting:'Hi, I’m Alex. Ask me anything about Villa Tullia, availability or your stay.',placeholder:'Type your question…',note:'No contact details required. Keep this page open to receive Alex’s reply.',selected:'Your selected stay',awakeTime:(time)=>`It’s ${time} for Alex. He usually replies in less than one minute.`,sleepTime:(time)=>`It’s ${time} for Alex, so he may be asleep. Leave your email in your message if you’d like him to contact you later.`,delivered:'Message delivered to Alex on Telegram',saved:'Message saved. Alex will see it shortly.',offline:'Connection interrupted. Please try again—your question will not be sent twice.',typing:'Alex is typing'},
    de:{launcher:'Alex fragen',title:'Chat mit Alex',subtitle:'Fragen zur Villa oder zu Ihrem Aufenthalt',greeting:'Hallo, ich bin Alex. Fragen Sie mich alles über Villa Tullia, Verfügbarkeit oder Ihren Aufenthalt.',placeholder:'Ihre Frage…',note:'Keine Kontaktdaten erforderlich. Lassen Sie diese Seite geöffnet, um Alex’ Antwort zu erhalten.',selected:'Ihr gewählter Aufenthalt',awakeTime:(time)=>`Bei Alex ist es ${time} Uhr. Normalerweise antwortet er in weniger als einer Minute.`,sleepTime:(time)=>`Bei Alex ist es ${time} Uhr, möglicherweise schläft er gerade. Hinterlassen Sie Ihre E-Mail-Adresse in Ihrer Nachricht, wenn er Sie später kontaktieren soll.`,delivered:'Nachricht über Telegram an Alex gesendet',saved:'Nachricht gespeichert. Alex sieht sie in Kürze.',offline:'Verbindung unterbrochen. Versuchen Sie es erneut – Ihre Frage wird nicht doppelt gesendet.',typing:'Alex schreibt'},
    it:{launcher:'Chiedi ad Alex',title:'Chatta con Alex',subtitle:'Chiedi della villa o del tuo soggiorno',greeting:'Ciao, sono Alex. Chiedimi tutto su Villa Tullia, la disponibilità o il tuo soggiorno.',placeholder:'Scrivi la tua domanda…',note:'Non servono dati di contatto. Tieni aperta questa pagina per ricevere la risposta di Alex.',selected:'Il soggiorno scelto',awakeTime:(time)=>`Per Alex sono le ${time}. Di solito risponde in meno di un minuto.`,sleepTime:(time)=>`Per Alex sono le ${time}, quindi potrebbe dormire. Lascia la tua e-mail nel messaggio se vuoi essere ricontattato più tardi.`,delivered:'Messaggio inviato ad Alex su Telegram',saved:'Messaggio salvato. Alex lo vedrà a breve.',offline:'Connessione interrotta. Riprova: la domanda non verrà inviata due volte.',typing:'Alex sta scrivendo'},
    nl:{launcher:'Vraag Alex',title:'Chat met Alex',subtitle:'Vraag naar de villa of uw verblijf',greeting:'Hallo, ik ben Alex. Vraag me alles over Villa Tullia, beschikbaarheid of uw verblijf.',placeholder:'Typ uw vraag…',note:'Geen contactgegevens nodig. Houd deze pagina open om het antwoord van Alex te ontvangen.',selected:'Uw gekozen verblijf',awakeTime:(time)=>`Bij Alex is het ${time}. Meestal antwoordt hij binnen één minuut.`,sleepTime:(time)=>`Bij Alex is het ${time}, dus mogelijk slaapt hij. Laat uw e-mailadres achter in uw bericht als u later antwoord wilt ontvangen.`,delivered:'Bericht via Telegram naar Alex gestuurd',saved:'Bericht opgeslagen. Alex ziet het binnenkort.',offline:'Verbinding verbroken. Probeer opnieuw—uw vraag wordt niet dubbel verzonden.',typing:'Alex typt'},
  };
  const config = window.VILLA_CHAT_CONFIG || {};
  const locale = ['en','de','it','nl'].includes(config.locale) ? config.locale : (document.documentElement.lang || 'en').slice(0,2);
  const t = copy[locale] || copy.en;
  const sessionKey = 'villa_chat_session';
  const pendingKey = 'villa_chat_pending_message_v2';
  const interestKey = 'villa_chat_interest_notified_v1';
  const pendingInterestKey = 'villa_chat_interest_pending_v1';
  let session = null;
  let pendingMessage = null;
  let history = [];
  let context = {};
  let polling;
  let revealTimer;
  let initializedMessages = false;
  let pendingHistory = null;
  let lastTypingSignal = 0;
  let interestPromise = null;
  const knownMessageIds = new Set();
  try { session = JSON.parse(localStorage.getItem(sessionKey) || 'null'); } catch {}
  try { pendingMessage = JSON.parse(localStorage.getItem(pendingKey) || 'null'); } catch {}

  const root = document.createElement('div');
  root.innerHTML = `<button class="vt-chat-launcher" type="button"><i class="bi bi-chat-heart"></i><span>${t.launcher}</span></button><section class="vt-chat-panel" aria-label="${t.title}" hidden><header class="vt-chat-head"><img class="vt-chat-photo" src="/imgs/Foto/alex-pellegrini.png" alt="Alex Pellegrini"><div><strong>${t.title}</strong><small>${t.subtitle}</small></div><button class="vt-chat-close" type="button" aria-label="Close chat"><i class="bi bi-x-lg"></i></button></header><div class="vt-chat-context" hidden><div><span>${t.selected}</span><strong></strong></div><b></b></div><div class="vt-chat-presence" hidden><i class="bi bi-clock"></i><span></span></div><div class="vt-chat-messages" aria-live="polite"></div><form class="vt-chat-composer"><div class="vt-chat-composer-row"><textarea aria-label="${t.placeholder}" placeholder="${t.placeholder}" maxlength="1000" required></textarea><button class="vt-chat-send" type="submit" aria-label="Send message"><i class="bi bi-send-fill"></i></button></div><p class="vt-chat-note">${t.note}</p><div class="vt-chat-delivery" hidden></div></form></section>`;
  document.body.appendChild(root);
  const launcher = root.querySelector('.vt-chat-launcher');
  const panel = root.querySelector('.vt-chat-panel');
  const close = root.querySelector('.vt-chat-close');
  const contextBar = root.querySelector('.vt-chat-context');
  const contextWeek = contextBar.querySelector('strong');
  const contextPrice = contextBar.querySelector('b');
  const presence = root.querySelector('.vt-chat-presence');
  const presenceText = presence.querySelector('span');
  const messages = root.querySelector('.vt-chat-messages');
  const composer = root.querySelector('.vt-chat-composer');
  const input = composer.querySelector('textarea');
  const sendButton = composer.querySelector('.vt-chat-send');
  const delivery = composer.querySelector('.vt-chat-delivery');

  const currentContext = () => ({ page:location.pathname, ...(typeof config.getContext === 'function' ? config.getContext() : {}), ...context });
  const updateContextBar = () => {
    const value = currentContext();
    contextBar.hidden = !value.selectedWeek;
    contextWeek.textContent = value.selectedWeek || '';
    contextPrice.textContent = value.price || '';
  };
  const updatePresence = () => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Rome',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(now);
    const hour = Number(parts.find((part)=>part.type==='hour')?.value||0);
    const time = new Intl.DateTimeFormat(locale==='en'?'en-GB':locale,{timeZone:'Europe/Rome',hour:'2-digit',minute:'2-digit'}).format(now);
    presenceText.textContent = hour>=8&&hour<23 ? t.awakeTime(time) : t.sleepTime(time);
    presence.classList.toggle('is-late',hour<8||hour>=23);
    presence.hidden=false;
  };
  const saveSession = () => { try { localStorage.setItem(sessionKey, JSON.stringify(session)); } catch {} };
  const savePending = () => { try { localStorage.setItem(pendingKey, JSON.stringify(pendingMessage)); } catch {} };
  const clearPending = () => { pendingMessage = null; try { localStorage.removeItem(pendingKey); } catch {} };
  const newVisitorToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2,'0')).join('');
  const authenticatedFetch = (url, options={}) => fetch(url,{...options,headers:{'Content-Type':'application/json','X-Chat-Token':session?.token||'',...(options.headers||{})}});
  const formatTime = (value) => value ? new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : locale,{hour:'2-digit',minute:'2-digit'}).format(new Date(value)) : '';
  const remember = (items) => items.forEach((item) => { if (item.id) knownMessageIds.add(item.id); });
  const render = (showTyping=false) => {
    messages.innerHTML = '';
    [{sender:'owner',body:t.greeting,createdAt:null},...history].forEach((item) => {
      const row = document.createElement('div'); row.className = `vt-chat-message ${item.sender === 'owner' ? 'alex' : 'visitor'}`;
      const bubble = document.createElement('div'); bubble.className = 'vt-chat-bubble'; bubble.textContent = item.body;
      if (item.createdAt) { const time=document.createElement('small'); time.textContent=`${item.sender === 'owner' ? 'Alex · ' : ''}${formatTime(item.createdAt)}`; bubble.appendChild(time); }
      row.appendChild(bubble); messages.appendChild(row);
    });
    if (showTyping) { const row=document.createElement('div'); row.className='vt-chat-message alex'; const bubble=document.createElement('div'); bubble.className='vt-chat-typing'; bubble.setAttribute('role','status'); bubble.setAttribute('aria-label',t.typing); bubble.innerHTML='<i></i><i></i><i></i>'; row.appendChild(bubble); messages.appendChild(row); }
    messages.scrollTop = messages.scrollHeight;
  };
  const receive = (incoming) => {
    const newOwner = initializedMessages && incoming.some((item) => item.sender === 'owner' && item.id && !knownMessageIds.has(item.id));
    remember(incoming); initializedMessages = true;
    if (!newOwner) { clearTimeout(revealTimer); pendingHistory=null; history=incoming; render(); return; }
    pendingHistory=incoming; render(true); clearTimeout(revealTimer);
    revealTimer=window.setTimeout(() => { history=pendingHistory||history; pendingHistory=null; render(); },1400);
  };
  const refresh = async () => {
    if (!session?.conversationId || document.hidden) return;
    try { const response=await authenticatedFetch(`/api/chat/conversations/${encodeURIComponent(session.conversationId)}/messages`); if(response.status===404){session=null;localStorage.removeItem(sessionKey);history=[];render();return;} if(response.ok) receive((await response.json()).messages||[]); } catch {}
  };
  const open = (nextContext={}) => { context={...context,...nextContext}; updateContextBar(); updatePresence(); panel.hidden=false; launcher.hidden=true; render(); void refresh(); clearInterval(polling); polling=window.setInterval(refresh,4000); window.setTimeout(()=>input.focus(),50); if(window.cro) cro.track('chat_opened',{placement:config.placement||'site'}); };
  const closeChat = () => { panel.hidden=true; launcher.hidden=false; clearInterval(polling); };
  launcher.addEventListener('click',()=>open()); close.addEventListener('click',closeChat);
  const notifyInterest = async () => {
    const messageContext=currentContext();
    if(config.placement!=='availability'||!messageContext.selectedWeek)return;
    const notificationKey=`${messageContext.selectedWeek}|${messageContext.price||''}`;
    try{if(localStorage.getItem(interestKey)===notificationKey)return;}catch{}
    let pendingInterest;
    try{pendingInterest=JSON.parse(localStorage.getItem(pendingInterestKey)||'null');}catch{}
    if(!pendingInterest||pendingInterest.key!==notificationKey)pendingInterest={key:notificationKey,id:crypto.randomUUID(),clientToken:session?.token||newVisitorToken()};
    try{localStorage.setItem(pendingInterestKey,JSON.stringify(pendingInterest));}catch{}
    const response=await fetch('/api/chat/interests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({interestId:pendingInterest.id,clientToken:pendingInterest.clientToken,locale,context:messageContext})});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||'Interest notification unavailable');
    if(!session){session={conversationId:data.conversationId,token:data.token};saveSession();}
    if(data.telegramForwarded){try{localStorage.setItem(interestKey,notificationKey);localStorage.removeItem(pendingInterestKey);}catch{}}
  };
  document.querySelectorAll('[data-villa-chat-open]').forEach((trigger)=>trigger.addEventListener('click',()=>{
    open();
    interestPromise=notifyInterest().catch(()=>{}).finally(()=>{interestPromise=null;});
  }));
  composer.addEventListener('submit',async(event)=>{
    event.preventDefault(); const message=input.value.trim(); if(!message||sendButton.disabled)return;
    sendButton.disabled=true; delivery.hidden=true;
    try {
      if(interestPromise)await interestPromise;
      if(!pendingMessage||pendingMessage.message!==message||pendingMessage.conversationId!==(session?.conversationId||null)){pendingMessage={message,conversationId:session?.conversationId||null,clientMessageId:crypto.randomUUID(),clientToken:session?.token||newVisitorToken()};savePending();}
      const messageContext=currentContext();
      const response=session ? await authenticatedFetch(`/api/chat/conversations/${encodeURIComponent(session.conversationId)}/messages`,{method:'POST',body:JSON.stringify({message,clientMessageId:pendingMessage.clientMessageId,context:messageContext})}) : await fetch('/api/chat/conversations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message,clientMessageId:pendingMessage.clientMessageId,clientToken:pendingMessage.clientToken,locale,context:messageContext})});
      const data=await response.json(); if(!response.ok)throw new Error(data.error||'Message could not be sent');
      if(!session){session={conversationId:data.conversationId,token:data.token};saveSession();} clearPending(); history=data.messages||[];remember(history);initializedMessages=true;input.value='';delivery.innerHTML=`<i class="bi bi-check2-circle"></i> ${data.telegramForwarded?t.delivered:t.saved}`;delivery.hidden=false;render(); if(window.cro) cro.track('chat_message_sent',{placement:config.placement||'site',has_selected_week:Boolean(messageContext.selectedWeek)});
    } catch(error){delivery.textContent=error instanceof TypeError?t.offline:error instanceof Error?error.message:'Message could not be sent';delivery.hidden=false;} finally{sendButton.disabled=false;}
  });
  input.addEventListener('keydown',(event)=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();composer.requestSubmit();}});
  input.addEventListener('input',()=>{if(!session||!input.value.trim())return;const now=Date.now();if(now-lastTypingSignal<4000)return;lastTypingSignal=now;void authenticatedFetch(`/api/chat/conversations/${encodeURIComponent(session.conversationId)}/typing`,{method:'POST'}).catch(()=>{});});
  window.VillaChat={open,setContext:(nextContext={})=>{context={...context,...nextContext};updateContextBar();}};
  updateContextBar(); render(); void refresh();
})();
