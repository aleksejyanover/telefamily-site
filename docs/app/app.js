/* ============ TeleFamily — клиент ============ */
'use strict';

const $ = id => document.getElementById(id);

const PLAN_LABEL = { free: 'Бесплатный', start: 'Старт', plus: 'Плюс', family: 'Семья', pro: 'Про' };
const PLAN_SIZE  = { free: 25, start: 100, plus: 300, family: 300, pro: 512 };
const PLAN_PRICE = { free: 0, start: 99, plus: 199, family: 349, pro: 699 };

function luhnValid(num) {
  let sum = 0, alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = num.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return num.length >= 13 && sum % 10 === 0;
}
const state = {
  token: localStorage.getItem('tg_token') || null,
  me: null,
  chats: [],
  chatById: {},
  current: null,       // id открытого чата
  msgs: [],            // сообщения открытого чата
  ws: null,
  replyTo: null,
  typing: {},          // chatId -> [userId]
  users: {},           // id -> user (кэш из чатов)
  recording: null,
  reconnectT: 0,
};

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = ts => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const fmtDur = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtSize = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' МБ' : Math.max(1, Math.round(b / 1024)) + ' КБ';
function fmtDay(ts) {
  const d = new Date(ts), n = new Date();
  const same = d.toDateString() === n.toDateString();
  const y = new Date(n - 864e5).toDateString() === d.toDateString();
  if (same) return 'Сегодня';
  if (y) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}
function ago(ts) {
  if (!ts) return 'давно';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'только что';
  if (s < 3600) return Math.floor(s / 60) + ' мин назад';
  if (s < 86400) return Math.floor(s / 3600) + ' ч назад';
  return Math.floor(s / 86400) + ' дн назад';
}
const initials = name => (String(name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('') || '?').toUpperCase();

/* -------------------------------------------------------------- утилиты UI */
function toast(text, err) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = '.4s'; setTimeout(() => el.remove(), 400); }, 2600);
}
function avatarEl(src, name, cls = 'avatar') {
  if (src) return `<img class="${cls}" src="${esc(src)}" alt="">`;
  return `<div class="${cls}">${esc(initials(name))}</div>`;
}
function openModal(html) {
  $('modalBox').innerHTML = html;
  $('modalRoot').hidden = false;
  return $('modalBox');
}
function closeModal() { $('modalRoot').hidden = true; $('modalBox').innerHTML = ''; }
$('modalRoot').addEventListener('click', e => { if (e.target === $('modalRoot')) closeModal(); });

function beep() {
  try {
    const ctx = beep.ctx = beep.ctx || new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = 880;
    g.gain.setValueAtTime(0.001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.36);
    setTimeout(() => { o.frequency.value = 1180; }, 120);
  } catch (e) {}
}
function notify(title, body) {
  beep();
  if (document.hidden && window.Notification && Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: 'icon.png' }); } catch (e) {}
  }
}

/* -------------------------------------------------------------- API */
const IS_APP = !!(window.Capacitor);
function apiBase() {
  if (IS_APP) return localStorage.getItem('tf_server') || window.__TFSERVER__ || '';
  /* HTML живёт на GitHub Pages (вечно, без warning Serveo) — тогда API идём
     по сохранённому/вшитому адресу; если страницу отдал сам сервер — его же origin */
  if (location.hostname.endsWith('.github.io')) return localStorage.getItem('tf_server') || window.__TFSERVER__ || '';
  return '';
}
function wsBase() {
  const b = apiBase();
  if (!b) return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  const u = new URL(b);
  return (u.protocol === 'https:' ? 'wss://' : 'ws://') + u.host;
}

/* ---- авто-восстановление адреса сервера ----
   Адрес туннеля меняется: если текущий умер, спрашиваем актуальный адрес
   у сайта на GitHub (raw-файл обновляется мгновенно, сайт — с задержкой сборки). */
const T_HUB_RAW = 'https://raw.githubusercontent.com/aleksejyanover/telefamily-site/main/docs/index.html';
const T_HUB = 'https://aleksejyanover.github.io/telefamily-site/';
async function tfDiscover() {
  /* адрес-кандидат = origin; запросы вида /?serveo-skip-browser-warning=true&app=1
     приводим к чистому origin (и старый вид /?app=1 тоже) */
  const base = u => {
    try { return new URL(u).origin; } catch (e) { return (u || '').replace(/\/\?.*$/, '').replace(/\/+$/, ''); }
  };
  for (const src of [T_HUB_RAW, T_HUB]) {
    try {
      const html = await (await fetch(src, { cache: 'no-store' })).text();
      const m1 = html.match(/var CHAT = "([^"]+)"/);
      const m2 = html.match(/var CHAT2 = "([^"]+)"/);
      /* PING всегда указывает на живой API-адрес (вечная дверь) — берём его origin */
      const m3 = html.match(/var PING = "([^"]+)"/);
      const out = [base(m1 && m1[1]), base(m2 && m2[1]), base(m3 && m3[1])].filter(Boolean);
      if (out.length) return out;
    } catch (e) {}
  }
  return [];
}
async function tfAlive(url) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 6000);
    try {
      const r = await fetch(url + '/api/ping', { cache: 'no-store', signal: ctrl.signal });
      return r.ok;
    } finally { clearTimeout(to); }
  } catch (e) { return false; }
}
function tfOrigin(u) { try { return new URL(u).origin; } catch (e) { return ''; } }
/* все кандидаты-адреса: сохранённый, вшитые в приложение, свежие с GitHub */
async function tfCandidates() {
  const list = [];
  const push = u => {
    u = String(u || '').replace(/\/+$/, '');
    if (u.indexOf('https://') !== 0 || list.indexOf(u) >= 0) return;
    if (u.indexOf('.github.io') >= 0) return; /* GitHub Pages — статика, не сервер */
    list.push(u);
  };
  push(localStorage.getItem('tf_server'));
  push(window.__TFSERVER__);
  push(window.__TFSERVER2__);
  for (const u of await tfDiscover()) push(u);
  return list;
}
async function tfRecover() {
  for (const u of await tfCandidates()) {
    if (!(await tfAlive(u))) continue;
    if (IS_APP) {
      /* приложение (APK): запоминаем живой адрес и повторяем запрос */
      try { localStorage.setItem('tf_server', u); } catch (e) {}
      return true;
    }
    /* браузер: если адрес тот же, что ожил — просто повторяем; иначе переезжаем целиком */
    if (tfOrigin(u) === location.origin) return true;
    const q = new URLSearchParams(location.search);
    if (state.token) q.set('token', state.token);
    /* Serveo у вечно двери показывает warning-страницу первому визиту без cookie —
       параметр в ссылке ставит cookie (на год) и открывает приложение сразу */
    if (u.indexOf('serveousercontent.com') >= 0) q.set('serveo-skip-browser-warning', 'true');
    location.replace(u + '/?' + q.toString());
    return false;
  }
  return false;
}
/* токен из ссылки (?token=) — чтобы переезд на новый адрес не разлогинивал */
try {
  const _tk = new URLSearchParams(location.search).get('token');
  if (_tk) {
    state.token = _tk;
    localStorage.setItem('tg_token', _tk);
    const _q = new URLSearchParams(location.search); _q.delete('token');
    history.replaceState(null, '', location.pathname + '?' + _q.toString() + location.hash);
  }
} catch (e) {}

/* предпроверка адреса при запуске (приложение): если адрес мёртв —
   находим живой заранее, чтобы первый запрос (вход/регистрация) уже шёл туда */
async function tfPreflight() {
  if (!IS_APP) return;
  const list = await tfCandidates();
  if (!list.length) return;
  for (const u of list) {
    if (await tfAlive(u)) { try { localStorage.setItem('tf_server', u); } catch (e) {} return; }
  }
}
tfPreflight();

/* кнопка во время запроса: «Подключаюсь…», а не молчание */
async function withBusy(btn, fn) {
  if (!btn) return fn();
  const old = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = 'Подключаюсь…';
  try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = old; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* относительные ссылки на медиа (/uploads/…, /clips/…) → абсолютные по адресу API:
   чтобы картинки, голосовые и видео грузились и с GitHub Pages, и в APK (своя origin) */
function fixU(o) {
  if (typeof o === 'string') {
    return (o.indexOf('/uploads/') === 0 || o.indexOf('/clips/') === 0) ? apiBase() + o : o;
  }
  if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) o[i] = fixU(o[i]); return o; }
  if (o && typeof o === 'object') { for (const k in o) o[k] = fixU(o[k]); return o; }
  return o;
}

async function api(method, path, body) {
  const reqId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const opt = {
    method,
    headers: { Authorization: 'Bearer ' + state.token, 'X-Req-Id': reqId },
  };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  for (let attempt = 0; attempt < 8; attempt++) {
    let r;
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 20000);
      try { r = await fetch(apiBase() + path, Object.assign({}, opt, { signal: ctrl.signal })); }
      finally { clearTimeout(to); }
    } catch (e) {
      /* адрес умер — ищем живой через GitHub и повторяем */
      if (await tfRecover()) { await sleep(300); continue; }
      throw new Error('Нет связи с сервером — проверь интернет и повтори через минуту');
    }
    if (r.status === 401 && path !== '/api/login' && path !== '/api/register' && path !== '/api/github') { if (state.me) forgetAccount(state.me.username); logout(true); throw new Error('session'); }
    if (!r.ok && (r.status === 502 || r.status === 503 || r.status === 504) && attempt < 7) {
      await sleep(2000); /* туннель/сервер переподключается — ждём и повторяем (X-Req-Id защитит от дублей) */
      continue;
    }
    let data = {};
    try { data = fixU(await r.json()); } catch (e) {}
    if (!r.ok) throw new Error(data.error || 'Ошибка ' + r.status);
    return data;
  }
  throw new Error('Сервер пока не отвечает — повтори через минуту');
}
async function upload(file) {
  const doFetch = () => fetch(apiBase() + '/api/upload', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + state.token, 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  let r;
  try { r = await doFetch(); }
  catch (e) {
    if (!(await tfRecover())) throw new Error('Сервер недоступен — повтори через минуту');
    r = await doFetch();
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Не удалось загрузить файл');
  return data;
}

/* -------------------------------------------------------------- авторизация */
$('authTabs').addEventListener('click', e => {
  const t = e.target.closest('.tab'); if (!t) return;
  document.querySelectorAll('#authTabs .tab').forEach(x => x.classList.toggle('active', x === t));
  $('formLogin').hidden = t.dataset.tab !== 'login';
  $('formRegister').hidden = t.dataset.tab !== 'register';
  $('formGithub').hidden = t.dataset.tab !== 'github';
  $('authError').hidden = true;
});
function authFail(msg) { const e = $('authError'); e.textContent = msg; e.hidden = false; }

async function afterAuth(data) {
  state.token = data.token; state.me = data.user;
  localStorage.setItem('tg_token', data.token);
  rememberAccount(data.user, data.token);
  try {
    if (window.Notification && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  } catch (e) {}
  startApp();
}
$('formLogin').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const btn = e.target.querySelector('button[type=submit]');
  try { await withBusy(btn, async () => { await afterAuth(await api('POST', '/api/login', { username: f.get('username'), password: f.get('password') })); }); }
  catch (err) { authFail(err.message); }
});
$('formRegister').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const btn = e.target.querySelector('button[type=submit]');
  try {
    await withBusy(btn, async () => {
      try { await afterAuth(await api('POST', '/api/register', { username: f.get('username'), name: f.get('name'), password: f.get('password') })); }
      catch (err) {
        /* если «занят» после сбоя связи — аккаунт, возможно, уже создался: пробуем войти */
        if (String(err.message).includes('занят')) {
          try { await afterAuth(await api('POST', '/api/login', { username: f.get('username'), password: f.get('password') })); }
          catch (_) { throw new Error('Такой юзернейм уже занят — попробуй другой'); }
          return;
        }
        throw err;
      }
    });
  } catch (err) { authFail(err.message); }
});
$('formGithub').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const btn = e.target.querySelector('button[type=submit]');
  try { await withBusy(btn, async () => { await afterAuth(await api('POST', '/api/github', { github: f.get('github') })); }); }
  catch (err) { authFail(err.message); }
});

function logout(silent) {
  localStorage.removeItem('tg_token');
  try { localStorage.removeItem('tf_last'); } catch (e) {}
  state.token = null; state.me = null;
  if (state.ws) try { state.ws.close(); } catch (e) {}
  $('app').hidden = true; $('auth').hidden = false;
  if (!silent) toast('Ты вышел из аккаунта');
}
/* ---- аккаунты, запоминаемые на ЭТОМ телефоне (токены, без паролей) ---- */
function getAccounts() { try { return JSON.parse(localStorage.getItem('tf_accounts') || '[]'); } catch (e) { return []; } }
function setAccounts(a) { try { localStorage.setItem('tf_accounts', JSON.stringify(a)); } catch (e) {} }
function rememberAccount(user, token) {
  const list = getAccounts().filter(x => x.username !== user.username);
  list.unshift({ username: user.username, name: user.name || user.username, avatar: user.avatar || null, token });
  setAccounts(list.slice(0, 8));
  try { localStorage.setItem('tf_last', user.username); } catch (e) {}
}
function forgetAccount(username) {
  if (!username) return;
  setAccounts(getAccounts().filter(x => x.username !== username));
  try { if (localStorage.getItem('tf_last') === username) localStorage.removeItem('tf_last'); } catch (e) {}
}
async function switchAccount(username) {
  const acc = getAccounts().find(x => x.username === username);
  if (!acc || !acc.token) return;
  closeModal();
  if (state.me && state.me.username === username) return;
  toast('Переключаюсь на @' + username + '…');
  localStorage.setItem('tg_token', acc.token);
  try { localStorage.setItem('tf_last', username); } catch (e) {}
  state.token = acc.token; state.me = null;
  if (state.ws) try { state.ws.close(); } catch (e) {}
  await startApp();
}
function accountsModal() {
  const list = getAccounts();
  const cur = state.me && state.me.username;
  const box = openModal(`<div class="accts"><h3>🔄 Аккаунты на этом телефоне</h3>
    <p class="sub">Телефон помнит, кто входил — переключайся без пароля. На другом телефоне нужно входить заново.</p>
    <div class="list-scroll">${list.length ? list.map(a => `
      <div class="search-result" data-acc="${esc(a.username)}" style="cursor:pointer">
        <div class="avatar-wrap">${avatarEl(a.avatar, a.name, 'avatar sm')}</div>
        <div><div class="sr-name">${esc(a.name)}${a.username === cur ? ' · <b style="color:var(--accent2)">сейчас</b>' : ''}</div>
        <div class="sr-nick">@${esc(a.username)}</div></div>
        <button class="cm-del" data-forget="${esc(a.username)}" title="Убрать аккаунт с телефона" style="margin-left:auto">🗑</button>
      </div>`).join('') : '<div class="cm-empty">Пока никого не запомнили</div>'}</div>
    <div class="modal-actions">
      <button class="btn ghost" id="accAdd">➕ Другой аккаунт</button>
      <button class="btn primary" id="accClose">Закрыть</button>
    </div></div>`);
  $('accClose').onclick = closeModal;
  $('accAdd').onclick = () => { closeModal(); logout(); };
  box.querySelector('.accts').addEventListener('click', e => {
    const fb = e.target.closest('[data-forget]');
    if (fb) { e.stopPropagation(); forgetAccount(fb.dataset.forget); accountsModal(); return; }
    const row = e.target.closest('[data-acc]');
    if (row) switchAccount(row.dataset.acc);
  });
}

/* -------------------------------------------------------------- загрузка */
async function startApp() {
  try {
    const me = await api('GET', '/api/me');
    state.me = me.user;
  } catch (e) {
    if (e.message === 'session') {
      /* токен невалиден — убираем аккаунт с телефона и просим войти */
      const u = (state.me && state.me.username) || localStorage.getItem('tf_last') || '';
      forgetAccount(u);
      localStorage.removeItem('tg_token'); state.token = null;
      $('app').hidden = true; $('auth').hidden = false;
      authFail('Сессия закончилась — войди заново');
      return;
    }
    /* НЕТ СВЯЗИ — не выкидываем, показываем приложение и пробуем снова */
    $('auth').hidden = true; $('app').hidden = false;
    if (!startApp._warned) { startApp._warned = 1; toast('Нет связи с сервером — подключаемся…', true); }
    setTimeout(() => { if (state.token) startApp(); }, 4000);
    return;
  }
  startApp._warned = 0;
  $('auth').hidden = true; $('app').hidden = false;
  renderMe();
  await loadChats();
  connectWS();
}

function renderMe() {
  const m = state.me;
  $('myName').textContent = m.name || m.username;
  $('myBadge').hidden = !m.premium;
  $('myBadge').textContent = m.owner ? 'OWNER' : (PLAN_LABEL[m.plan] || 'ПЛЮС').toUpperCase();
  if ($('menuItemServer')) $('menuItemServer').hidden = !IS_APP;
  $('menuName').textContent = m.name || m.username;
  $('menuNick').textContent = '@' + m.username + (m.owner ? ' · 👑 Владелец'
    : (m.premium ? ' · тариф «' + (PLAN_LABEL[m.plan] || 'Плюс') + '»' : ''));
  for (const id of ['myAvatar', 'menuAvatar']) {
    const el = $(id);
    if (m.avatar) { el.outerHTML = `<img id="${id}" class="${id === 'menuAvatar' ? 'avatar big' : 'avatar'}" src="${esc(m.avatar)}" alt="">`; }
    else { el.outerHTML = `<div id="${id}" class="${id === 'menuAvatar' ? 'avatar big' : 'avatar'}">${esc(initials(m.name || m.username))}</div>`; }
  }
  document.body.dataset.theme = localStorage.getItem('tg_theme') || 'dark';
}

async function loadChats() {
  const d = await api('GET', '/api/chats');
  state.chats = d.chats;
  indexChats();
  renderChatList();
}
function indexChats() {
  state.chatById = {};
  for (const c of state.chats) {
    state.chatById[c.id] = c;
    for (const u of c.members || []) state.users[u.id] = u;
  }
}
function sortChats() {
  state.chats.sort((a, b) => (b.last ? b.last.createdAt : b.createdAt) - (a.last ? a.last.createdAt : a.createdAt));
}

function previewText(c) {
  const l = c.last;
  if (!l) return 'Нет сообщений';
  const who = l.userId === state.me.id ? 'Ты: ' : (c.type === 'group' ? l.authorName + ': ' : '');
  if (l.deleted) return who + '🗑 Сообщение удалено';
  const body = {
    text: l.text, image: '📷 Фото', video: '📹 Видео', voice: '🎤 Голосовое ' + fmtDur(l.duration),
    videonote: '⭕ Кружок', file: '📄 ' + (l.fileName || 'Файл'), call: '📞 ' + (l.text || 'Звонок'),
  }[l.type] || l.text;
  return who + body;
}

async function renderChatList() {
  sortChats();
  const q = $('search').value.trim().toLowerCase();
  const list = state.chats.filter(c => !q || c.title.toLowerCase().includes(q) || (c.members || []).some(u => u.username.includes(q)));
  const box = $('chatList');
  const people = await peopleHTML(q);
  const chatsHTML = list.length ? list.map(c => {
      const other = c.type === 'dm' ? c.members.find(u => u.id !== state.me.id) : null;
      const av = c.avatar || (other && other.avatar);
      const online = other && other.online;
      const typingHere = (state.typing[c.id] || []).length > 0;
      let sub = '';
      if (typingHere) sub = '<i style="font-style:normal">печатает…</i>';
      return `<div class="chat-item ${state.current === c.id ? 'active' : ''}" data-id="${c.id}">
        <div class="avatar-wrap">${avatarEl(av, c.title)}${online ? '<span class="online-dot"></span>' : ''}</div>
        <div class="ci-body">
          <div class="ci-top"><span class="ci-name">${esc(c.title)}${c.type === 'group' ? ' <span style="opacity:.6">👥</span>' : ''}</span>
          <span class="ci-meta">${c.last ? fmtTime(c.last.createdAt) : ''}</span></div>
          <div class="ci-bottom"><span class="ci-preview">${sub || esc(previewText(c))}</span>
          ${c.unread ? `<span class="ci-unread">${c.unread}</span>` : ''}</div>
        </div>
      </div>`;
    }).join('')
    : `<div style="padding:26px 16px;color:var(--muted);text-align:center;font-size:14px;line-height:1.6">
      ${q ? 'Чатов не найдено' : 'Пока пусто.<br>Нажми <b>+</b> и найди друга по юзернейму,<br>или создай группу в меню ☰'}</div>`;
  box.innerHTML = people + chatsHTML;
}

async function peopleHTML(qRaw) {
  let q = qRaw;
  if (q.startsWith('@')) q = q.slice(1);
  if (q.length < 2) return '';
  let users = [];
  try { users = (await api('GET', '/api/search?q=' + encodeURIComponent(q))).users.filter(u => u.id !== state.me.id); } catch (e) {}
  if (!users.length || $('search').value.trim().toLowerCase() !== qRaw) return '';
  return `<div style="padding:8px 12px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:1px">Люди</div>` +
    users.slice(0, 8).map(u => `<div class="chat-item" data-user="${esc(u.username)}">
      <div class="avatar-wrap">${avatarEl(u.avatar, u.name)}${u.online ? '<span class="online-dot"></span>' : ''}</div>
      <div class="ci-body"><div class="ci-top"><span class="ci-name">${esc(u.name)} ${u.premium ? '⭐' : ''}</span></div>
      <div class="ci-bottom"><span class="ci-preview">@${esc(u.username)}</span></div></div>
    </div>`).join('');
}

async function openDm(username) {
  try {
    const d = await api('POST', '/api/chats', { type: 'dm', username });
    upsertChat(d.chat);
    $('search').value = ''; renderChatList();
    openChat(d.chat.id);
  } catch (err) { toast(err.message, true); }
}

$('search').addEventListener('input', () => renderChatList());
$('chatList').addEventListener('click', e => {
  const it = e.target.closest('.chat-item'); if (!it) return;
  if (it.dataset.user) return openDm(it.dataset.user);
  if (it.dataset.id) openChat(it.dataset.id);
});
function upsertChat(chat) {
  const i = state.chats.findIndex(c => c.id === chat.id);
  if (i >= 0) state.chats[i] = chat; else state.chats.push(chat);
  indexChats();
}
function removeChat(id) {
  delete state.chatById[id];
  state.chats = state.chats.filter(c => c.id !== id);
  if (state.current === id) {
    state.current = null;
    $('app').classList.remove('chat-open');
    $('chatView').hidden = true;
    $('emptyState').hidden = false;
    state.msgs = [];
  }
  renderChatList();
}

/* -------------------------------------------------------------- WebSocket */
function connectWS() {
  if (!state.token) return;
  if (state.ws) {   /* закрываем старый сокет — иначе остаётся «зомби» от прошлой сессии */
    const old = state.ws;
    state.ws = null;
    old.onclose = null; old.onerror = null; old.onmessage = null; old.onopen = null;
    try { old.close(); } catch (e) {}
  }
  let ws;
  try { ws = new WebSocket(`${wsBase()}?token=${encodeURIComponent(state.token)}`); }
  catch (e) { return scheduleReconnect(); }
  state.ws = ws;
  ws.onopen = () => { state.reconnectT = 0; };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    m = fixU(m);
    handleEvent(m);
  };
  ws.onclose = () => { if (state.call) endCall('Связь потеряна', { send: false }); scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}
function scheduleReconnect() {
  if (!state.token) return;
  state.reconnectT = Math.min(15000, (state.reconnectT || 800) * 1.7);
  setTimeout(() => { if (state.token) connectWS(); }, state.reconnectT);
}
function wsSend(obj) { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj)); }

/* -------------------------------------------------------------- Звонки (WebRTC) */
const RTC_CFG = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };
state.call = null;

function callPeerOf(chat) { return chat && chat.type === 'dm' ? chat.members.find(u => u.id !== state.me.id) : null; }

/* --- рингтоны --- */
let _ringT = null;
function ringStart(kind) {
  ringStop();
  const tone = (f, at, dur, vol) => {
    try {
      const ctx = beep.ctx = beep.ctx || new (window.AudioContext || window.webkitAudioContext)();
      const t = ctx.currentTime;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(vol, t + at + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      o.connect(g).connect(ctx.destination);
      o.start(t + at); o.stop(t + at + dur + 0.05);
    } catch (e) {}
  };
  const tick = () => {
    if (kind === 'in') { tone(660, 0, 0.3, 0.16); tone(880, 0.35, 0.3, 0.16); }
    else { tone(425, 0, 0.4, 0.13); tone(425, 0.7, 0.4, 0.13); }
  };
  tick();
  _ringT = setInterval(tick, kind === 'in' ? 1800 : 2400);
}
function ringStop() { if (_ringT) { clearInterval(_ringT); _ringT = null; } }

/* --- окно звонка --- */
function openCallWindow() {
  const c = state.call; if (!c) return;
  const root = $('callRoot');
  if (c.group) {   /* групповой звонок: сетка участников */
    root.hidden = false;
    root.classList.remove('audio-only');
    $('callName').textContent = c.title;
    $('callAvatar').hidden = true;
    $('callTime').hidden = !c.connectedAt;
    if (c.connectedAt) $('callTime').textContent = fmtDur(Math.floor((Date.now() - c.connectedAt) / 1000));
    $('ccMic').classList.toggle('off', !c.mic);
    $('ccCam').classList.toggle('off', !c.cam);
    const scr = $('ccScreen'); if (scr) scr.classList.toggle('active', !!c.screen);
    refreshScreenBadge();
    renderCallGrid();
    const lv = $('callLocal');
    if (c.local && c.local.getVideoTracks().length && c.cam) { lv.hidden = false; lv.srcObject = c.local; lv.play().catch(() => {}); }
    else lv.hidden = true;
    return;
  }
  const hasVideo = !!(c.local && c.local.getVideoTracks().length);
  root.hidden = false;
  root.classList.toggle('audio-only', !hasVideo);
  $('callName').textContent = c.peerName;
  $('callAvatar').innerHTML = esc(initials(c.peerName));
  $('callAvatar').hidden = false;
  $('callTime').hidden = true; $('callTime').textContent = '0:00';
  $('ccMic').classList.toggle('off', !c.mic);
  $('ccCam').classList.toggle('off', !c.cam);
  const lv = $('callLocal');
  lv.hidden = !hasVideo;
  if (hasVideo) { lv.srcObject = c.local; lv.play().catch(() => {}); }
}
function hideCallWindow() {
  $('callRoot').hidden = true;
  try { $('callLocal').srcObject = null; $('callRemote').srcObject = null; } catch (e) {}
  const b = $('callScreenBadge'); if (b) b.hidden = true;
  const sc = $('ccScreen'); if (sc) sc.classList.remove('active');
  renderCallGrid();
}
function setCallState(s) { const el = $('callState'); if (el) el.textContent = s; }

function makePeer(c) {
  const pc = new RTCPeerConnection(RTC_CFG);
  c.pc = pc;
  if (c.local) c.local.getTracks().forEach(t => { try { pc.addTrack(t, c.local); } catch (e) {} });
  pc.onicecandidate = e => {
    if (e.candidate && state.call && state.call.pc === pc) wsSend({ t: 'call_ice', chatId: c.chatId, candidate: e.candidate.toJSON() });
  };
  pc.ontrack = e => {
    if (!state.call || state.call.pc !== pc) return;
    const v = $('callRemote');
    v.srcObject = e.streams[0];
    v.play().catch(() => {});
    if (e.streams[0] && e.streams[0].getVideoTracks().length) {
      $('callRoot').classList.remove('audio-only');
      $('callAvatar').hidden = true;
    }
  };
  pc.onconnectionstatechange = () => {
    if (!state.call || state.call.pc !== pc) return;
    if (pc.connectionState === 'connected') callConnected();
    else if (pc.connectionState === 'failed') endCall('Связь потеряна', { send: false });
  };
  pc.onnegotiationneeded = async () => {
    /* первоначальный offer делаем сами; пересогласование — только после соединения */
    if (!c.readyNeg || !state.call || state.call.pc !== pc || c.negT) return;
    c.negT = true;
    try {
      const off = await pc.createOffer();
      await pc.setLocalDescription(off);
      wsSend({ t: 'call_offer', chatId: c.chatId, video: c.video, sdp: pc.localDescription.sdp });
    } catch (e) {} finally { c.negT = false; }
  };
  return pc;
}

function callConnected() {
  const c = state.call; if (!c || c.connectedAt) return;
  c.connectedAt = Date.now();
  c.state = 'active';
  c.readyNeg = true;
  ringStop(); clearTimeout(c.dialT); clearTimeout(c.joinT);
  setCallState('');
  $('callTime').hidden = false;
  c.timer = setInterval(() => { $('callTime').textContent = fmtDur(Math.floor((Date.now() - c.connectedAt) / 1000)); }, 500);
}

function logCall(c, text) {
  api('POST', `/api/chats/${c.chatId}/messages`, { type: 'call', text }).catch(() => {});
}

/* --- исходящий звонок --- */
async function startCall(video) {
  const chat = state.chatById[state.current];
  if (!chat) return;
  if (chat.type === 'group') return startGroupCall(video);
  if (chat.type !== 'dm') return;
  if (state.call) { toast('Уже идёт звонок', true); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Звонки не поддерживаются на этом устройстве', true); return; }
  const peer = callPeerOf(chat);
  if (peer && !peer.online) { toast('Собеседник не в сети', true); return; }
  let local;
  try {
    local = await navigator.mediaDevices.getUserMedia({ audio: true, video: video ? { width: 1280, height: 720, facingMode: 'user' } : false });
  } catch (e) { toast('Нет доступа к ' + (video ? 'камере' : 'микрофону'), true); return; }
  const c = state.call = {
    chatId: chat.id, peerName: chat.title,
    role: 'caller', video: !!video, cam: !!video, mic: true,
    local, pc: null, connectedAt: 0, state: 'dialing', readyNeg: false, negT: false,
    dialT: null, ringT: null, timer: null, pendingIce: [],
  };
  makePeer(c);
  try {
    const offer = await c.pc.createOffer();
    await c.pc.setLocalDescription(offer);
    wsSend({ t: 'call_invite', chatId: c.chatId, video: !!video, sdp: c.pc.localDescription.sdp });
  } catch (e) { console.error('[call] offer error', e); endCall('Ошибка вызова', { send: false }); return; }
  openCallWindow();
  ringStart('out');
  setCallState('Идёт вызов…');
  c.dialT = setTimeout(() => {
    if (state.call === c && c.state === 'dialing') endCall('Никто не ответил', { logMissed: true });
  }, 45000);
}

/* --- групповой звонок (mesh: каждый участник соединяется с каждым) --- */
async function startGroupCall(video) {
  const chat = state.chatById[state.current];
  if (!chat || chat.type !== 'group') return;
  if (state.call) { toast('Уже идёт звонок', true); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Звонки не поддерживаются на этом устройстве', true); return; }
  let local;
  try {
    local = await navigator.mediaDevices.getUserMedia({ audio: true, video: video ? { width: 1280, height: 720, facingMode: 'user' } : false });
  } catch (e) { toast('Нет доступа к ' + (video ? 'камере' : 'микрофону'), true); return; }
  const c = state.call = {
    group: true, chatId: chat.id, title: chat.title,
    role: 'host', isHost: true, video: !!video, cam: !!video, mic: true,
    local, peers: {}, connectedAt: 0, state: 'dialing',
    dialT: null, ringT: null, timer: null, joinT: null, pendingIce: [],
  };
  try { wsSend({ t: 'call_gstart', chatId: c.chatId, video: !!video }); } catch (e) {}
  openCallWindow();
  ringStart('out');
  setCallState('Приглашаю участников…');
  c.dialT = setTimeout(() => {
    if (state.call === c && !c.connectedAt) {
      const n = Object.keys(c.peers).length;
      endCall(n ? 'Не удалось связаться' : 'Никто не ответил');
    }
  }, 45000);
}
function onGroupCallStart(m) {
  const chat = state.chatById[m.chatId];
  if (!chat) return;
  if (state.call) {
    if (state.call.group && state.call.chatId === m.chatId) return;   /* уже в этом звонке */
    try { wsSend({ t: 'call_greject', chatId: m.chatId, reason: 'занят(а) в другом звонке' }); } catch (e) {}
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { try { wsSend({ t: 'call_greject', chatId: m.chatId, reason: 'устройство не поддерживает звонки' }); } catch (e) {} return; }
  const c = state.call = {
    group: true, chatId: m.chatId, title: chat.title,
    role: 'callee', isHost: false, video: !!m.video, cam: !!m.video, mic: true,
    local: null, peers: {}, connectedAt: 0, state: 'ringing',
    dialT: null, ringT: null, timer: null, joinT: null, pendingIce: [],
  };
  ringStart('in');
  openModal(`
    <div class="call-in">
      <div class="call-in-ava">${esc(initials(chat.title))}</div>
      <div class="call-in-name">${esc(chat.title)}</div>
      <div class="call-in-sub">👥 Групповой ${c.video ? 'видео' : ''}звонок</div>
      <div class="call-in-btns">
        <button class="btn danger" id="ciReject">Отклонить</button>
        <button class="btn primary" id="ciAccept">Ответить</button>
      </div>
    </div>`);
  $('ciAccept').onclick = acceptGroupCall;
  $('ciReject').onclick = () => rejectGroupCall('не принял(а) звонок');
  if (document.hidden && window.Notification && Notification.permission === 'granted') {
    try { new Notification(chat.title, { body: 'Групповой звонок', icon: 'icon.png' }); } catch (e) {}
  }
  c.ringT = setTimeout(() => { if (state.call === c && c.state === 'ringing') rejectGroupCall('не ответил(а)'); }, 45000);
}
async function acceptGroupCall() {
  const c = state.call; if (!c || !c.group || c.role !== 'callee') return;
  closeModal(); ringStop(); clearTimeout(c.ringT);
  try {
    c.local = await navigator.mediaDevices.getUserMedia({ audio: true, video: c.video ? { width: 1280, height: 720, facingMode: 'user' } : false });
  } catch (e) {
    try { wsSend({ t: 'call_greject', chatId: c.chatId, reason: 'нет доступа к микрофону' }); } catch (e2) {}
    state.call = null; closeModal(); hideCallWindow();
    toast('Нет доступа к микрофону', true);
    return;
  }
  c.state = 'connecting';
  try { wsSend({ t: 'call_gjoin', chatId: c.chatId }); } catch (e) {}
  openCallWindow();
  setCallState('Присоединяюсь…');
  c.joinT = setTimeout(() => { if (state.call === c && !c.connectedAt) endCall('Не удалось связаться'); }, 20000);
}
function rejectGroupCall(reason) {
  const c = state.call; if (!c) return;
  try { wsSend({ t: 'call_greject', chatId: c.chatId, reason: reason || '' }); } catch (e) {}
  ringStop(); clearTimeout(c.ringT); clearTimeout(c.dialT);
  state.call = null;
  closeModal(); hideCallWindow();
}
function peerNameIn(c, pid) {
  const chat = state.chatById[c.chatId];
  const u = chat && (chat.members || []).find(x => x.id === pid);
  if (u) return u.name;
  return pid === (state.me && state.me.id) ? 'Ты' : 'Участник';
}
function makeGroupPeer(c, pid) {
  if (c.peers[pid]) return c.peers[pid];
  const p = { pc: new RTCPeerConnection(RTC_CFG), name: peerNameIn(c, pid), initialDone: false, negT: false, pendingIce: [], stream: null, connected: false };
  c.peers[pid] = p;
  if (c.local) c.local.getTracks().forEach(t => { try { p.pc.addTrack(t, c.local); } catch (e) {} });
  p.pc.onicecandidate = e => {
    if (e.candidate && state.call && state.call.peers[pid] === p) wsSend({ t: 'call_ice', chatId: c.chatId, to: pid, candidate: e.candidate.toJSON() });
  };
  p.pc.ontrack = e => {
    if (!state.call || state.call.peers[pid] !== p) return;
    p.stream = e.streams[0] || new MediaStream([e.track]);
    if (p.stream) p.stream.onremovetrack = () => renderCallGrid();
    renderCallGrid();
  };
  p.pc.onconnectionstatechange = () => {
    if (!state.call || state.call.peers[pid] !== p) return;
    if (p.pc.connectionState === 'connected') { p.connected = true; callConnected(); }
    else if (p.pc.connectionState === 'failed') { closeGroupPeer(state.call, pid); toast('Связь с участником потеряна', true); }
  };
  p.pc.onnegotiationneeded = async () => {
    if (!state.call || state.call.peers[pid] !== p) return;
    if (!p.initialDone || p.negT || p.pc.signalingState !== 'stable') return;
    p.negT = true;
    try {
      const off = await p.pc.createOffer();
      await p.pc.setLocalDescription(off);
      wsSend({ t: 'call_offer', chatId: c.chatId, to: pid, video: state.call.video, sdp: p.pc.localDescription.sdp });
    } catch (e) {} finally { p.negT = false; }
  };
  return p;
}
function closeGroupPeer(c, pid) {
  const p = c.peers[pid]; if (!p) return;
  delete c.peers[pid];
  try { p.pc.onconnectionstatechange = null; p.pc.ontrack = null; p.pc.close(); } catch (e) {}
  renderCallGrid();
}
function renderCallGrid() {
  const c = state.call;
  const grid = $('callGrid'); if (!grid) return;
  if (!c || !c.group) { grid.hidden = true; grid.innerHTML = ''; return; }
  grid.hidden = false;
  const ids = Object.keys(c.peers);
  if (!ids.length) {
    grid.dataset.n = '1';
    grid.innerHTML = '<div class="call-tile"><div class="tile-ava">👥</div><div class="tile-name">Жду участников…</div></div>';
    return;
  }
  grid.dataset.n = String(Math.min(ids.length, 4));
  grid.innerHTML = ids.map(pid => {
    const p = c.peers[pid];
    const hasVideo = !!(p.stream && p.stream.getVideoTracks().length);
    return `<div class="call-tile"><video autoplay playsinline${hasVideo ? '' : ' hidden'}></video><div class="tile-ava">${esc(initials(p.name || '?'))}</div><div class="tile-name">${esc(p.name || 'Участник')}</div></div>`;
  }).join('');
  const tiles = grid.querySelectorAll('.call-tile');
  ids.forEach((pid, i) => {
    const p = c.peers[pid];
    const v = tiles[i] && tiles[i].querySelector('video');
    if (v && p.stream) { v.hidden = false; v.srcObject = p.stream; v.play().catch(() => {}); }
  });
}
async function onGroupCallEvent(m, c) {
  if (m.t === 'call_screen') {
    c.peerScreen = !!m.on;
    refreshScreenBadge();
    if (m.on) toast('🖥 ' + (peerNameIn(c, m.from) || 'Собеседник') + ' показывает экран');
    return;
  }
  if (m.t === 'call_gpeers') {
    for (const pid of (m.peers || [])) {
      if (pid === (state.me && state.me.id) || c.peers[pid]) continue;
      const p = makeGroupPeer(c, pid);
      try {
        const off = await p.pc.createOffer();
        await p.pc.setLocalDescription(off);
        p.initialDone = true;
        wsSend({ t: 'call_offer', chatId: c.chatId, to: pid, video: c.video, sdp: p.pc.localDescription.sdp });
      } catch (e) {}
    }
    return;
  }
  if (m.t === 'call_gjoined') { if (c.state === 'dialing' || c.state === 'connecting') setCallState('Соединяемся…'); return; }
  if (m.t === 'call_ggone') { endCall('Звонок уже закончили', { send: false }); return; }
  if (m.t === 'call_greject') {
    const nm = peerNameIn(c, m.from) || 'Участник';
    toast(nm + (m.reason ? ': ' + m.reason : ' не участвует'), true);
    return;
  }
  if (m.t === 'call_gleave') {
    const nm = peerNameIn(c, m.from);
    closeGroupPeer(c, m.from);
    if (!Object.keys(c.peers).length && c.connectedAt) { endCall('Все вышли из звонка', { send: false }); return; }
    if (nm) toast(nm + ' вышел(ла) из звонка');
    return;
  }
  if (m.t === 'call_offer') {
    (async () => {
      const p = makeGroupPeer(c, m.from);
      if (p.pc.signalingState !== 'stable') return;
      try {
        await p.pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
        for (const cand of (p.pendingIce || [])) { try { await p.pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (e) {} }
        p.pendingIce = [];
        const ans = await p.pc.createAnswer();
        await p.pc.setLocalDescription(ans);
        p.initialDone = true;
        wsSend({ t: 'call_answer', chatId: c.chatId, to: m.from, video: c.video, sdp: p.pc.localDescription.sdp });
        renderCallGrid();
      } catch (e) {}
    })();
    return;
  }
  if (m.t === 'call_answer') {
    (async () => {
      const p = c.peers[m.from]; if (!p) return;
      if (p.pc.signalingState !== 'have-local-offer') return;
      try {
        await p.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
        for (const cand of (p.pendingIce || [])) { try { await p.pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (e) {} }
        p.pendingIce = [];
      } catch (e) {}
    })();
    return;
  }
  if (m.t === 'call_ice') {
    const p = c.peers[m.from]; if (!p) return;
    if (p.pc.remoteDescription) p.pc.addIceCandidate(new RTCIceCandidate(m.candidate)).catch(() => {});
    else p.pendingIce.push(m.candidate);
    return;
  }
}

/* --- входящий звонок --- */
function onCallInvite(m) {
  const chat = state.chatById[m.chatId];
  if (state.call) {
    if (state.call.chatId === m.chatId && state.call.state === 'ringing') return;  /* дубль — уже звоним */
    wsSend({ t: 'call_busy', chatId: m.chatId, reason: 'Занято' });
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { wsSend({ t: 'call_busy', chatId: m.chatId, reason: 'Не поддерживается' }); return; }
  const peer = callPeerOf(chat);
  const c = state.call = {
    chatId: m.chatId, peerName: (peer && peer.name) || (chat ? chat.title : 'Звонок'),
    role: 'callee', video: !!m.video, cam: !!m.video, mic: true,
    offerSdp: m.sdp, local: null, pc: null, connectedAt: 0, state: 'ringing',
    readyNeg: false, negT: false, dialT: null, ringT: null, timer: null, pendingIce: [],
  };
  ringStart('in');
  openModal(`
    <div class="call-in">
      <div class="call-in-ava">${esc(initials(c.peerName))}</div>
      <div class="call-in-name">${esc(c.peerName)}</div>
      <div class="call-in-sub">${c.video ? '📹 Входящий видеозвонок' : '🎙 Входящий звонок'}</div>
      <div class="call-in-btns">
        <button class="btn danger" id="ciReject">Отклонить</button>
        <button class="btn primary" id="ciAccept">Ответить</button>
      </div>
    </div>`);
  $('ciAccept').onclick = acceptCall;
  $('ciReject').onclick = () => rejectCall('Звонок отклонён');
  if (document.hidden && window.Notification && Notification.permission === 'granted') {
    try { new Notification(c.peerName, { body: c.video ? 'Видеозвонок' : 'Звонок', icon: 'icon.png' }); } catch (e) {}
  }
  c.ringT = setTimeout(() => { if (state.call === c && c.state === 'ringing') rejectCall('Пропущенный звонок'); }, 45000);
}

async function acceptCall() {
  const c = state.call; if (!c || c.role !== 'callee') return;
  closeModal(); ringStop(); clearTimeout(c.ringT);
  try {
    c.local = await navigator.mediaDevices.getUserMedia({ audio: true, video: c.video ? { width: 1280, height: 720, facingMode: 'user' } : false });
  } catch (e) {
    wsSend({ t: 'call_busy', chatId: c.chatId, reason: 'Нет доступа к ' + (c.video ? 'камере' : 'микрофону') });
    state.call = null;
    toast('Нет доступа к ' + (c.video ? 'камере' : 'микрофону'), true);
    return;
  }
  c.state = 'connecting';
  makePeer(c);
  try {
    await c.pc.setRemoteDescription({ type: 'offer', sdp: c.offerSdp });
    for (const cand of (c.pendingIce || [])) { try { await c.pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (e) {} }
    c.pendingIce = [];
    const ans = await c.pc.createAnswer();
    await c.pc.setLocalDescription(ans);
    wsSend({ t: 'call_answer', chatId: c.chatId, video: c.video, sdp: c.pc.localDescription.sdp });
  } catch (e) { console.error('[call] accept error', e); endCall('Ошибка соединения', { send: false }); return; }
  c.readyNeg = true;
  openCallWindow();
  setCallState('Соединяемся…');
}

function rejectCall(reason) {
  const c = state.call; if (!c) return;
  wsSend({ t: 'call_reject', chatId: c.chatId, reason: reason || 'Отклонён' });
  ringStop(); clearTimeout(c.dialT); clearTimeout(c.ringT);
  state.call = null;
  closeModal(); hideCallWindow();
}

function endCall(reason, opts = {}) {
  const c = state.call; if (!c) return;
  if (opts.send !== false) {
    try { wsSend(c.group ? { t: 'call_gleave', chatId: c.chatId } : { t: 'call_end', chatId: c.chatId, reason: reason || '' }); } catch (e) {}
  }
  ringStop();
  clearTimeout(c.dialT); clearTimeout(c.ringT); clearTimeout(c.joinT);
  if (c.timer) { clearInterval(c.timer); c.timer = null; }
  try { c.pc && c.pc.close(); } catch (e) {}
  if (c.peers) Object.values(c.peers).forEach(p => { try { p.pc.onconnectionstatechange = null; p.pc.close(); } catch (e) {} });
  /* остановить трансляцию экрана, если шла — иначе ОС продолжит захват */
  if (c.screenTrack) { try { c.screenTrack.onended = null; c.screenTrack.stop(); } catch (e) {} c.screenTrack = null; c.screen = false; }
  if (c.local) c.local.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
  state.call = null;
  closeModal();
  hideCallWindow();
  const dur = c.connectedAt ? Math.round((Date.now() - c.connectedAt) / 1000) : 0;
  if (reason) toast(reason);
  if (c.group) { if (c.connectedAt) logCall(c, `Групповой ${c.video ? 'видео' : ''}звонок · ${fmtDur(dur)}`); }
  else if (c.role === 'caller' && dur > 0) logCall(c, `${c.video ? 'Видеозвонок' : 'Аудиозвонок'} · ${fmtDur(dur)}`);
  else if (c.role === 'caller' && opts.logMissed) logCall(c, 'Пропущенный звонок');
}

function onCallEvent(m) {
  const c = state.call;
  if (m.t === 'call_invite') return onCallInvite(m);
  if (m.t === 'call_gstart') return onGroupCallStart(m);
  if (!c || c.chatId !== m.chatId) return;
  if (c.group) return onGroupCallEvent(m, c);
  if (m.t === 'call_answer') {
    if (!c.pc) {   /* принято на другом устройстве — замолкаем */
      if (c.state === 'ringing') { ringStop(); clearTimeout(c.ringT); state.call = null; closeModal(); }
      return;
    }
    (async () => {
      if (!c.pc) return;
      if (c.pc.signalingState !== 'have-local-offer') return;   /* защита от повторного ответа */
      try {
        await c.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
        c.state = 'connecting';
        setCallState('Соединяемся…');
      } catch (e) { console.error('[call] answer error', e); endCall('Ошибка соединения', { send: false }); }
    })();
    return;
  }
  if (m.t === 'call_offer') {   /* пересогласование: собеседник включил камеру */
    (async () => {
      if (!c.pc || c.pc.signalingState !== 'stable') return;
      try {
        await c.pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
        const a = await c.pc.createAnswer();
        await c.pc.setLocalDescription(a);
        wsSend({ t: 'call_answer', chatId: c.chatId, video: c.video, sdp: c.pc.localDescription.sdp });
        if (m.video) {
          c.video = true;
          $('callRoot').classList.remove('audio-only');
          $('callAvatar').hidden = true;
        }
      } catch (e) { console.error('[call] renegotiation error', e); }
    })();
    return;
  }
  if (m.t === 'call_ice') {
    if (c.pc) c.pc.addIceCandidate(new RTCIceCandidate(m.candidate)).catch(() => {});
    else c.pendingIce.push(m.candidate);
    return;
  }
  if (m.t === 'call_screen') {   /* собеседник начал/остановил трансляцию экрана */
    c.peerScreen = !!m.on;
    refreshScreenBadge();
    if (m.on) toast('🖥 ' + c.peerName + ' показывает экран');
    return;
  }
  if (m.t === 'call_reject') { endCall('Звонок отклонён', { send: false, logMissed: c.role === 'caller' }); return; }
  if (m.t === 'call_busy') { endCall(m.reason || 'Абонент занят', { send: false }); return; }
  if (m.t === 'call_end') { endCall(m.reason || 'Звонок завершён', { send: false }); return; }
}

/* --- кнопки --- */
$('btnCallAudio').onclick = () => startCall(false);
$('btnCallVideo').onclick = () => startCall(true);
$('ccEnd').onclick = () => endCall('Звонок завершён');
$('ccMic').onclick = () => {
  const c = state.call; if (!c || !c.local) return;
  const t = c.local.getAudioTracks()[0]; if (!t) return;
  t.enabled = !t.enabled; c.mic = t.enabled;
  $('ccMic').classList.toggle('off', !c.mic);
  $('ccMic').textContent = c.mic ? '🎤' : '🔇';
};
$('ccCam').onclick = async () => {
  const c = state.call; if (!c) return;
  if (c.screen) { toast('Сначала останови трансляцию экрана 🖥', true); return; }
  try {
    if (!c.local || !c.local.getVideoTracks().length) {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, facingMode: 'user' } });
      const vt = s.getVideoTracks()[0];
      c.local.addTrack(vt);
      c.cam = true; c.video = true;
      if (c.group) { for (const p of Object.values(c.peers)) { try { p.pc.addTrack(vt, c.local); } catch (e) {} } }
      else if (c.pc) c.pc.addTrack(vt, c.local);
      $('callRoot').classList.remove('audio-only');
      $('callAvatar').hidden = true;
      const lv = $('callLocal');
      lv.hidden = false; lv.srcObject = c.local; lv.play().catch(() => {});
    } else {
      const vt = c.local.getVideoTracks()[0];
      vt.enabled = !vt.enabled; c.cam = vt.enabled;
      $('callLocal').hidden = !c.cam;
    }
    $('ccCam').classList.toggle('off', !c.cam);
  } catch (e) { toast('Камера недоступна', true); }
};

/* --- трансляция экрана в звонке --- */
function refreshScreenBadge() {
  const b = $('callScreenBadge'); if (!b) return;
  const c = state.call;
  const local = !!(c && c.screen), peer = !!(c && c.peerScreen);
  if (local && peer) { b.hidden = false; b.textContent = '🖥 Вы оба показываете экран'; }
  else if (local) { b.hidden = false; b.textContent = '🖥 Ты показываешь экран — собеседник видит его'; }
  else if (peer) { b.hidden = false; b.textContent = '🖥 ' + (c.peerName || c.title || 'Собеседник') + ' показывает экран'; }
  else b.hidden = true;
}
async function stopScreenShare() {
  const c = state.call;
  if (!c || !c.screenTrack) return;
  const st = c.screenTrack;
  c.screenTrack = null; c.screen = false;
  try { st.onended = null; st.stop(); } catch (e) {}
  const cam = c.local && c.local.getVideoTracks().find(t => t !== st);
  const sender = c.pc && (c.pc.getSenders().find(x => x.track === st) ||
    c.pc.getSenders().find(x => x.track && x.track.kind === 'video'));
  try {
    if (c.group) {                            /* mesh: возвращаем камеру в каждом соединении */
      for (const p of Object.values(c.peers)) {
        const s = p.pc.getSenders().find(x => x.track === st);
        if (!s) continue;
        if (cam) await s.replaceTrack(cam);
        else p.pc.removeTrack(s);
      }
    } else if (c._screenAdded) {              /* экран добавляли как новый трек — снимаем его */
      if (c.local) c.local.removeTrack(st);
      if (sender && c.pc) c.pc.removeTrack(sender);   /* уйдёт пересогласование */
    } else if (sender && cam) {
      await sender.replaceTrack(cam);           /* вернули камеру без пересогласования */
    }
  } catch (e) {}
  c._screenAdded = false;
  const lv = $('callLocal');
  if (cam && c.cam) { lv.hidden = false; lv.srcObject = c.local; lv.play().catch(() => {}); }
  else lv.hidden = true;
  const btn = $('ccScreen'); if (btn) btn.classList.remove('active');
  refreshScreenBadge();
  try { wsSend({ t: 'call_screen', chatId: c.chatId, on: false }); } catch (e) {}
}
$('ccScreen').onclick = async () => {
  const c = state.call; if (!c) return;
  if (c.screen) { stopScreenShare(); toast('🖥 Трансляция остановлена'); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    toast('Этот браузер не умеет транслировать экран — попробуй на компьютере', true); return;
  }
  let s;
  try { s = await navigator.mediaDevices.getDisplayMedia({ video: true }); }
  catch (e) { if (!e || e.name !== 'NotAllowedError') toast('Не удалось запустить трансляцию', true); return; }
  const st = s.getVideoTracks()[0]; if (!st) return;
  c.screenTrack = st; c.screen = true;
  try {
    if (c.group) {                             /* mesh: экран каждому участнику */
      for (const p of Object.values(c.peers)) {
        const s = p.pc.getSenders().find(x => x.track && x.track.kind === 'video');
        if (s) await s.replaceTrack(st);
        else p.pc.addTrack(st, c.local);
      }
      c.video = true;
    } else {
      const sender = c.pc && c.pc.getSenders().find(x => x.track && x.track.kind === 'video');
      if (sender) {
        await sender.replaceTrack(st);            /* мгновенно, без пересогласования */
        c._screenAdded = false;
      } else {
        c.local.addTrack(st);                     /* звонок был без видео */
        if (c.pc) c.pc.addTrack(st, c.local);     /* onnegotiationneeded уйдёт offer */
        c._screenAdded = true;
        c.video = true;
        $('callRoot').classList.remove('audio-only');
        $('callAvatar').hidden = true;
      }
    }
  } catch (e) { toast('Не удалось включить трансляцию', true); c.screen = false; c.screenTrack = null; try { st.stop(); } catch (e2) {} return; }
  st.onended = () => { stopScreenShare(); toast('🖥 Трансляция остановлена'); };
  const lv = $('callLocal');
  lv.hidden = false; lv.srcObject = new MediaStream([st]); lv.play().catch(() => {});
  const btn = $('ccScreen'); if (btn) btn.classList.add('active');
  refreshScreenBadge();
  try { wsSend({ t: 'call_screen', chatId: c.chatId, on: true }); } catch (e) {}
  toast('🖥 Трансляция экрана запущена');
};

function handleEvent(m) {
  if (typeof m.t === 'string' && m.t.indexOf('call_') === 0) { onCallEvent(m); return; }
  if (m.t === 'msg') {
    const chat = state.chatById[m.chatId];
    const isMine = m.msg.userId === state.me.id;
    if (state.current === m.chatId && document.querySelector('.chat-view:not([hidden])')) {
      appendMsg(m.msg, true);
      if (!isMine) api('POST', `/api/chats/${m.chatId}/read`, { before: m.msg.id }).catch(() => {});
    }
    refreshChatFromMsg(m.chatId, m.msg);
    if (!isMine && m.chatId !== state.current) {
      const title = chat ? chat.title : 'TeleFamily';
      const body = m.msg.type === 'text' ? m.msg.text : ({ image: '📷 Фото', video: '📹 Видео', voice: '🎤 Голосовое', videonote: '⭕ Кружок', file: '📄 Файл', call: '📞 ' + (m.msg.text || 'Звонок') }[m.msg.type] || '');
      notify(`${m.msg.authorName}${chat && chat.type === 'group' ? ' @ ' + title : ''}`, body.slice(0, 120));
    }
    if (!isMine) beep();
    renderChatList();
    return;
  }
  if (m.t === 'msg_update') {
    replaceMsg(m.msg);
    const c = state.chatById[m.msg.chatId];
    if (c && c.last && c.last.id === m.msg.id) { c.last = m.msg; renderChatList(); }
    return;
  }
  if (m.t === 'chat_update') {
    const existed = !!state.chatById[m.chat.id];
    upsertChat(m.chat);
    state.typing[m.chat.id] = m.chat.typing || [];
    if (state.current === m.chat.id) renderChatSub();
    renderChatList();
    if (!existed && m.chat.last === null) { /* новый чат */ }
    return;
  }
  if (m.t === 'chat_deleted') {
    removeChat(m.chatId);
    if (commentsOpenId && state.msgs && !state.msgs.find(x => x.id === commentsOpenId)) { commentsOpenId = null; closeModal(); }
    return;
  }
  if (m.t === 'comments') {
    state.comments = state.comments || {};
    state.comments[m.msgId] = m.comments;
    if (commentsOpenId === m.msgId) renderComments(m.msgId, m.comments);
    return;
  }
  if (m.t === 'typing') {
    const arr = state.typing[m.chatId] = state.typing[m.chatId] || [];
    if (m.on && !arr.includes(m.userId)) arr.push(m.userId);
    if (!m.on) { const i = arr.indexOf(m.userId); if (i >= 0) arr.splice(i, 1); }
    if (state.current === m.chatId) renderTypingBar();
    renderChatList();
    return;
  }
  if (m.t === 'presence') {
    for (const c of state.chats) for (const u of c.members) if (u.id === m.userId) u.online = m.online;
    if (state.current) renderChatSub();
    renderChatList();
    return;
  }
  if (m.t === 'user_update') {
    if (m.user.id === state.me.id) { state.me = m.user; renderMe(); }
    for (const c of state.chats) for (const u of c.members) if (u.id === m.user.id) Object.assign(u, m.user);
    if (state.current) renderChatHeader();
    renderChatList();
    return;
  }
}
function refreshChatFromMsg(chatId, msg) {
  const c = state.chatById[chatId];
  if (!c) { loadChats(); return; }
  c.last = msg;
  if (state.current !== chatId) c.unread = (c.unread || 0) + 1;
  sortChats();
}

/* -------------------------------------------------------------- чат */
async function openChat(id) {
  const chat = state.chatById[id];
  if (!chat) return;
  state.current = id;
  state.replyTo = null; $('replyBar').hidden = true;
  $('emptyState').hidden = true; $('chatView').hidden = false;
  $('app').classList.add('chat-open');
  renderChatHeader();
  renderChatList();
  $('messages').innerHTML = '<div style="margin:auto;color:var(--muted)">Загрузка…</div>';
  try {
    const d = await api('GET', `/api/chats/${id}/messages?limit=60`);
    state.msgs = d.messages;
    renderMessages();
    markRead(id);
  } catch (e) { toast(e.message, true); }
  renderTypingBar();
}
function markRead(id) {
  const c = state.chatById[id]; if (!c) return;
  const before = c.last ? c.last.id : 0;
  api('POST', `/api/chats/${id}/read`, { before }).then(() => { c.unread = 0; renderChatList(); }).catch(() => {});
}
function renderChatHeader() {
  const c = state.chatById[state.current]; if (!c) return;
  const other = c.type === 'dm' ? c.members.find(u => u.id !== state.me.id) : null;
  $('chatTitle').textContent = c.title;
  $('btnCallAudio').hidden = c.type !== 'dm' && c.type !== 'group';
  $('btnCallVideo').hidden = c.type !== 'dm' && c.type !== 'group';
  $('chatAvatar').outerHTML = c.avatar || (other && other.avatar)
    ? `<img id="chatAvatar" class="avatar" src="${esc(c.avatar || other.avatar)}">`
    : `<div id="chatAvatar" class="avatar">${esc(initials(c.title))}</div>`;
  renderChatSub();
}
function renderChatSub() {
  const c = state.chatById[state.current]; if (!c) return;
  const typing = state.typing[c.id] || [];
  const sub = $('chatSub');
  if (typing.length) {
    sub.textContent = typing.length === 1 ? 'печатает…' : `${typing.length} печатают…`;
    sub.classList.add('live');
    return;
  }
  sub.classList.remove('live');
  if (c.type === 'group') sub.textContent = `${c.members.length} участников`;
  else {
    const other = c.members.find(u => u.id !== state.me.id);
    sub.textContent = other ? (other.online ? 'в сети' : 'был(а) ' + ago(other.lastSeen)) : '';
  }
}
function renderTypingBar() {
  const arr = state.typing[state.current] || [];
  const bar = $('typingBar');
  if (!arr.length) { bar.hidden = true; return; }
  const names = arr.map(id => state.users[id]?.name || 'кто-то');
  bar.hidden = false;
  bar.innerHTML = `<span class="typing-dots"><i></i><i></i><i></i></span> ${esc(names.join(', '))} печатает…`;
}

function renderMessages() {
  const box = $('messages');
  if (!state.msgs.length) {
    box.innerHTML = `<div style="margin:auto;text-align:center;color:var(--muted);max-width:320px">
      <div style="font-size:42px">👋</div><p>Пока сообщений нет. Напиши первым!</p></div>`;
    return;
  }
  let html = '', prev = null, prevDay = '';
  for (const m of state.msgs) {
    const day = fmtDay(m.createdAt);
    if (day !== prevDay) { html += `<div class="day-sep">${day}</div>`; prev = null; prevDay = day; }
    const gap = !prev || prev.userId !== m.userId || (m.createdAt - prev.createdAt > 5 * 60000);
    html += msgHTML(m, gap);
    prev = m;
  }
  box.innerHTML = html;
  scrollBottom(true);
}
function msgHTML(m, gap) {
  const mine = m.userId === state.me.id;
  const c = state.chatById[m.chatId];
  const showAuthor = c && c.type === 'group' && !mine && gap;
  const reply = m.replyTo ? state.msgs.find(x => x.id === m.replyTo) : null;
  let inner = '';
  if (m.deleted) inner += `<div class="msg-text">🗑 Сообщение удалено</div>`;
  else {
    if (reply) inner += `<div class="reply-quote" data-goto="${reply.id}"><b>${esc(reply.authorName)}</b>${esc((reply.text || ({ image: 'Фото', video: 'Видео', voice: 'Голосовое', videonote: 'Кружок', file: 'Файл', call: '📞 Звонок' }[reply.type] || '')).slice(0, 80))}</div>`;
    if (m.type === 'image') inner += `<div class="msg-media" data-view="${esc(m.url)}"><img src="${esc(m.url)}" loading="lazy" alt=""></div>`;
    else if (m.type === 'video') inner += `<div class="msg-media" data-viewvideo="${esc(m.url)}"><video src="${esc(m.url)}" controls preload="metadata"></video></div>`;
    else if (m.type === 'videonote') inner += `<div class="videonote" data-viewvideo="${esc(m.url)}"><video src="${esc(m.url)}" muted playsinline preload="metadata"></video><div class="note-play">▶</div></div>`;
    else if (m.type === 'voice') inner += voiceHTML(m);
    else if (m.type === 'file') inner += `<a class="file-chip" href="${esc(m.url)}" download="${esc(m.fileName || 'file')}"><span class="file-ico">📄</span><span><span class="file-name">${esc(m.fileName || 'Файл')}</span><br><span class="file-size">${fmtSize(m.fileSize)}</span></span></a>`;
    else if (m.type === 'call') inner += `<div class="msg-call">📞 ${esc(m.text || 'Звонок')}</div>`;
    if (m.text) inner += `<div class="msg-text">${linkify(m.text)}</div>`;
  }
  const reactions = Object.entries(m.reactions || {}).map(([e, arr]) =>
    `<button class="reaction" data-react="${esc(e)}">${esc(e)} ${arr.length}</button>`).join('');
  return `<div class="msg ${mine ? 'out' : 'in'} ${gap ? 'gap' : ''} ${m.deleted ? 'deleted' : ''}" data-id="${m.id}">
    ${!mine ? (gap ? avatarEl(m.authorAvatar, m.authorName, 'avatar sm') : '<span style="width:30px;flex:none"></span>') : ''}
    <div class="bubble">
      <div class="msg-tools">
        <button data-act="reply" title="Ответить">↩</button>
        <button data-act="react" title="Реакция">😀</button>
        ${!m.deleted ? `<button data-act="comments" title="Комментарии">💬${m.commentsCount ? ' ' + m.commentsCount : ''}</button>` : ''}
        ${mine && !m.deleted && (m.type === 'text') ? '<button data-act="edit" title="Изменить">✏️</button>' : ''}
        ${(mine || (state.me && state.me.owner)) && !m.deleted ? '<button data-act="del" title="Удалить">🗑</button>' : ''}
      </div>
      ${showAuthor ? `<div class="msg-author">${esc(m.authorName)} ${m.authorPremium ? '<span class="plus-star">★</span>' : ''}</div>` : ''}
      ${inner}
      ${reactions ? `<div class="reactions">${reactions}</div>` : ''}
      <div class="msg-meta">${m.edited ? '<span class="edited">изменено</span>' : ''}<span>${fmtTime(m.createdAt)}</span>
      ${m.commentsCount ? `<button class="cm-badge" data-act="comments" title="Открыть комментарии">💬 ${m.commentsCount}</button>` : ''}
      ${mine ? `<span class="ticks">${m.readBy && m.readBy.length ? '✓✓' : '✓'}</span>` : ''}</div>
    </div>
  </div>`;
}
function linkify(t) {
  return esc(t).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline">$1</a>');
}
function voiceHTML(m) {
  let bars = '';
  const seed = Number(String(m.id).replace(/\D/g, '').slice(-4)) || 7;
  for (let i = 0; i < 34; i++) bars += `<i style="height:${20 + ((seed * (i + 3) * 17) % 70)}%"></i>`;
  return `<div class="msg-media voice" data-voice="${esc(m.url)}" data-dur="${m.duration || 1}">
    <button class="play-btn">▶</button><span class="wave">${bars}</span><span class="voice-time">${fmtDur(m.duration || 0)}</span>
    <audio src="${esc(m.url)}" preload="none" hidden></audio></div>`;
}
function appendMsg(m, scroll) {
  if (state.msgs.find(x => x.id === m.id)) return replaceMsg(m);
  const prev = state.msgs[state.msgs.length - 1];
  state.msgs.push(m);
  const box = $('messages');
  if (box.querySelector('.msg')) {
    const gap = !prev || prev.userId !== m.userId || (m.createdAt - prev.createdAt > 5 * 60000);
    const day = fmtDay(m.createdAt);
    const lastDay = box.querySelector('.day-sep:last-of-type');
    if (!lastDay || lastDay.textContent !== day) box.insertAdjacentHTML('beforeend', `<div class="day-sep">${day}</div>`);
    box.insertAdjacentHTML('beforeend', msgHTML(m, gap));
  } else renderMessages();
  if (scroll) scrollBottom();
}
function replaceMsg(m) {
  const i = state.msgs.findIndex(x => x.id === m.id);
  if (i < 0) return;
  state.msgs[i] = m;
  const el = document.querySelector(`.msg[data-id="${m.id}"]`);
  if (!el) return;
  const prevEl = el.previousElementSibling;
  const gap = !prevEl || !prevEl.classList.contains('msg') ||
    prevEl.querySelector('.msg-author') !== null || (m.createdAt - Number(prevEl.dataset.ts || 0) > 5 * 60000);
  el.outerHTML = msgHTML(m, el.classList.contains('gap'));
}
function scrollBottom(force) {
  const box = $('messages');
  if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
}

/* -------------------------------------------------------------- отправка */
async function sendMessage(payload) {
  if (!state.current) return;
  try {
    const d = await api('POST', `/api/chats/${state.current}/messages`, payload);
    appendMsg(d.msg, true);
    const c = state.chatById[state.current];
    if (c) { c.last = d.msg; c.unread = 0; renderChatList(); }
  } catch (e) { toast(e.message, true); }
}
function sendText() {
  const text = $('input').value.trim();
  if (!text) return;
  /* секретная команда 🎬 клипов */
  if (/^\/(clip|clips|клип|клипы)$/i.test(text)) {
    $('input').value = ''; autoGrow();
    if (clipsUnlocked()) openClips(); else toast('🔒 Секретная команда… Говорят, кто-то5 раз тапал логотип', true);
    return;
  }
  const payload = { type: 'text', text };
  if (state.replyTo) payload.replyTo = state.replyTo;
  $('input').value = ''; autoGrow(); cancelReply();
  wsSend({ t: 'typing', chatId: state.current, on: false });
  sendMessage(payload);
}
async function sendFileAs(file, type, duration) {
  if (!file) return;
  const limit = (PLAN_SIZE[(state.me || {}).plan] || 25) * 1024 * 1024;
  if (file.size > limit) return toast(`Файл ${fmtSize(file.size)} больше лимита ${(limit / 1048576).toFixed(0)} МБ`, true);
  toast('Загрузка файла…');
  try {
    const up = await upload(file);
    const payload = { type, url: up.url, fileName: file.name, fileSize: up.size };
    if (duration) payload.duration = duration;
    if (state.replyTo) payload.replyTo = state.replyTo;
    cancelReply();
    await sendMessage(payload);
  } catch (e) { toast(e.message, true); }
}

function autoGrow() {
  const el = $('input');
  el.style.height = 'auto';
  el.style.height = Math.min(132, el.scrollHeight) + 'px';
}
$('input').addEventListener('input', () => {
  autoGrow();
  wsSend({ t: 'typing', chatId: state.current, on: true });
});
$('input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(pointer:fine)').matches) { e.preventDefault(); sendText(); }
});
$('btnSend').addEventListener('click', sendText);

$('btnAttach').addEventListener('click', () => {
  const box = openModal(`<h3>Прикрепить</h3>
    <div class="list-scroll">
      <div class="search-result" data-a="image">🖼 <div><div class="sr-name">Картинку</div><div class="sr-nick">JPG, PNG, GIF, WebP</div></div></div>
      <div class="search-result" data-a="video">🎞 <div><div class="sr-name">Видео</div><div class="sr-nick">MP4, WebM</div></div></div>
      <div class="search-result" data-a="file">📎 <div><div class="sr-name">Любой файл</div><div class="sr-nick">до 25 МБ (до 512 МБ на тарифах)</div></div></div>
    </div>`);
  box.onclick = e => {
    const r = e.target.closest('.search-result'); if (!r) return;
    closeModal();
    if (r.dataset.a === 'image') $('fileImage').click();
    if (r.dataset.a === 'video') $('fileVideo').click();
    if (r.dataset.a === 'file') $('fileAny').click();
  };
});
$('fileImage').onchange = e => { sendFileAs(e.target.files[0], 'image'); e.target.value = ''; };
$('fileVideo').onchange = e => { sendFileAs(e.target.files[0], 'video'); e.target.value = ''; };
$('fileAny').onchange = e => { sendFileAs(e.target.files[0], 'file'); e.target.value = ''; };

/* -------------------------------------------------------------- эмодзи */
const EMOJI = '😀 😂 🥰 😍 😎 🤔 😴 😭 😡 👍 👎 🙏 👏 💪 🔥 ✨ 🎉 ❤️ 🧡 💛 💚 💙 💜 ⭐ 🌙 ☀️ 🌈 ⚡ 🍕 🎮 ⚽ 🎵 🤖 👻 💀 🐱 🐶 🦊 🐻 🚀 🛸 💻 📱 ☕ 🍀 🌊 🏔️'.split(' ');
let emojiPanel = null;
$('btnEmoji').addEventListener('click', () => {
  if (emojiPanel) { emojiPanel.remove(); emojiPanel = null; return; }
  emojiPanel = document.createElement('div');
  emojiPanel.className = 'emoji-panel';
  emojiPanel.innerHTML = EMOJI.map(e => `<button type="button">${e}</button>`).join('');
  emojiPanel.addEventListener('click', ev => {
    const b = ev.target.closest('button'); if (!b) return;
    const el = $('input');
    el.value += b.textContent; el.focus(); autoGrow();
  });
  $('chatView').appendChild(emojiPanel);
  setTimeout(() => document.addEventListener('click', function h(ev) {
    if (emojiPanel && !emojiPanel.contains(ev.target) && ev.target !== $('btnEmoji')) {
      emojiPanel.remove(); emojiPanel = null; document.removeEventListener('click', h);
    }
  }), 0);
});

/* -------------------------------------------------------------- действия с сообщениями */
$('messages').addEventListener('click', async e => {
  const msgEl = e.target.closest('.msg');
  const goto = e.target.closest('[data-goto]');
  if (goto) {
    const target = document.querySelector(`.msg[data-id="${goto.dataset.goto}"]`);
    if (target) { target.scrollIntoView({ block: 'center' }); target.style.outline = '2px solid var(--accent2)'; setTimeout(() => target.style.outline = '', 1200); }
    return;
  }
  const voice = e.target.closest('[data-voice]');
  if (voice && e.target.closest('.play-btn')) return toggleVoice(voice);
  const view = e.target.closest('[data-view]');
  if (view) return showViewer(`<img src="${view.dataset.view}">`);
  const viewV = e.target.closest('[data-viewvideo]');
  if (viewV && !e.target.closest('video, .play-btn')) return;
  if (viewV && e.target.closest('.note-play')) return showViewer(`<video src="${viewV.dataset.viewvideo}" controls autoplay>`);
  const react = e.target.closest('[data-react]');
  if (react) return addReaction(msgEl.dataset.id, react.dataset.react);
  const tool = e.target.closest('[data-act]');
  if (tool && msgEl) return msgAction(tool.dataset.act, msgEl.dataset.id);
});
function toggleVoice(box) {
  const audio = box.querySelector('audio');
  const btn = box.querySelector('.play-btn');
  document.querySelectorAll('.msg-media.voice audio').forEach(a => { if (a !== audio) { a.pause(); a.previousElementSibling.querySelector('.play-btn').textContent = '▶'; } });
  if (audio.paused) {
    audio.play().then(() => { btn.textContent = '⏸'; audio.ontimeupdate = () => { box.querySelector('.voice-time').textContent = fmtDur(audio.currentTime); }; })
      .catch(() => toast('Не удалось воспроизвести', true));
    audio.onended = () => { btn.textContent = '▶'; box.querySelector('.voice-time').textContent = fmtDur(audio.duration || 0); };
  } else { audio.pause(); btn.textContent = '▶'; }
}
function showViewer(html) {
  $('viewerBody').innerHTML = html;
  $('mediaViewer').hidden = false;
}
$('viewerClose').onclick = () => { $('mediaViewer').hidden = true; $('viewerBody').innerHTML = ''; };
$('mediaViewer').addEventListener('click', e => { if (e.target === $('mediaViewer')) $('viewerClose').click(); });

const REACTIONS = ['❤️', '👍', '🔥', '😂', '😮', '😢'];
async function addReaction(id, emoji) {
  try { const d = await api('POST', `/api/messages/${id}/react`, { emoji }); replaceMsg(d.msg); } catch (e) { toast(e.message, true); }
}
async function msgAction(act, id) {
  const m = state.msgs.find(x => x.id === id); if (!m) return;
  if (act === 'reply') {
    state.replyTo = id;
    $('replyName').textContent = m.authorName;
    $('replyText').textContent = m.text || ({ image: 'Фото', video: 'Видео', voice: 'Голосовое', videonote: 'Кружок', file: 'Файл' }[m.type] || '');
    $('replyBar').hidden = false; $('input').focus();
  }
  if (act === 'react') {
    const msgEl = document.querySelector(`.msg[data-id="${id}"]`);
    if (msgEl.querySelector('.reactions-inline')) { msgEl.querySelector('.reactions-inline').remove(); return; }
    const row = document.createElement('div');
    row.className = 'reactions reactions-inline';
    row.style.cssText = 'position:absolute;right:0;top:-38px;background:var(--panel);border:1px solid var(--line);padding:4px 6px;border-radius:999px;z-index:9;box-shadow:var(--shadow)';
    row.innerHTML = REACTIONS.map(r => `<button class="reaction" data-react="${r}">${r}</button>`).join('');
    msgEl.appendChild(row);
    setTimeout(() => document.addEventListener('click', function h(ev) {
      if (!row.contains(ev.target)) { row.remove(); document.removeEventListener('click', h); }
    }), 0);
  }
  if (act === 'edit') {
    const box = openModal(`<h3>Изменить сообщение</h3>
      <div class="field"><textarea id="editText" rows="4">${esc(m.text)}</textarea></div>
      <div class="modal-actions"><button class="btn ghost" id="editCancel">Отмена</button><button class="btn primary" id="editSave">Сохранить</button></div>`);
    $('editCancel').onclick = closeModal;
    $('editSave').onclick = async () => {
      try { const d = await api('POST', `/api/messages/${id}/edit`, { text: $('editText').value }); replaceMsg(d.msg); closeModal(); }
      catch (e) { toast(e.message, true); }
    };
  }
  if (act === 'comments') openComments(id);
  if (act === 'del') {
    const someoneElses = m.userId !== (state.me && state.me.id);
    const box = openModal(`<h3>Удалить сообщение?</h3><p class="sub">${someoneElses ? 'Это чужое сообщение — как владелец, ты удалишь его у всех участников чата.' : 'Оно исчезнет у всех участников чата.'}</p>
      <div class="modal-actions"><button class="btn ghost" id="delNo">Отмена</button><button class="btn danger" id="delYes">Удалить</button></div>`);
    $('delNo').onclick = closeModal;
    $('delYes').onclick = async () => {
      try { await api('DELETE', `/api/messages/${id}`); closeModal(); } catch (e) { toast(e.message, true); }
    };
  }
}
/* -------------------------------------------------------------- комментарии */
let commentsOpenId = null;
function cmQuote(m) {
  return (m.text || ({ image: '📷 Фото', video: '📹 Видео', voice: '🎤 Голосовое', videonote: '⭕ Кружок', file: '📄 Файл', call: '📞 Звонок' }[m.type] || 'Сообщение')).slice(0, 70);
}
async function openComments(id) {
  const m = state.msgs.find(x => x.id === id); if (!m) return;
  commentsOpenId = id;
  openModal(`<h3>💬 Комментарии</h3>
    <div class="cm-quote">${linkify(cmQuote(m))}</div>
    <div class="list-scroll" id="cmList" style="max-height:36vh"><div class="cm-empty">Загрузка…</div></div>
    <div class="field"><textarea id="cmText" rows="2" placeholder="Написать комментарий…"></textarea></div>
    <div class="modal-actions"><button class="btn ghost" id="cmClose">Закрыть</button><button class="btn primary" id="cmSend">Отправить</button></div>`);
  $('cmClose').onclick = () => { commentsOpenId = null; closeModal(); };
  $('cmSend').onclick = sendComment;
  $('cmText').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendComment(); }
  });
  $('cmList').addEventListener('click', e => {
    const btn = e.target.closest('[data-cdel]'); if (!btn) return;
    const cid = btn.dataset.cdel;
    api('DELETE', `/api/messages/${id}/comments/${cid}`)
      .then(() => renderComments(id, (state.comments[id] || []).filter(x => x.id !== cid)))
      .catch(err => toast(err.message, true));
  });
  try {
    const d = await api('GET', `/api/messages/${id}/comments`);
    if (commentsOpenId === id) renderComments(id, d.comments);
  } catch (e) { toast(e.message, true); }
}
async function sendComment() {
  const id = commentsOpenId; if (!id) return;
  const ta = $('cmText'); const text = ta.value.trim();
  if (!text) { ta.focus(); return; }
  ta.disabled = true;
  try {
    const d = await api('POST', `/api/messages/${id}/comments`, { text });
    ta.value = '';
    renderComments(id, [...(state.comments[id] || []), d.comment]);
    ta.focus();
  } catch (e) { toast(e.message, true); }
  finally { ta.disabled = false; }
}
function renderComments(id, comments) {
  state.comments = state.comments || {};
  state.comments[id] = comments;
  const list = $('cmList');
  if (!list || commentsOpenId !== id) return;
  list.innerHTML = comments.length ? comments.map(c => `
    <div class="cm-item">
      <div class="cm-body">
        <div class="cm-head"><b>${esc(c.authorName)}</b><span class="cm-time">${fmtTime(c.createdAt)}</span></div>
        <div class="cm-text">${linkify(c.text)}</div>
      </div>
      ${c.userId === (state.me && state.me.id) || (state.me && state.me.owner) ? `<button class="cm-del" data-cdel="${c.id}" title="Удалить комментарий">🗑</button>` : ''}
    </div>`).join('') : '<div class="cm-empty">Пока нет комментариев — напиши первый</div>';
}
function cancelReply() { state.replyTo = null; $('replyBar').hidden = true; }
$('btnCancelReply').onclick = cancelReply;

/* -------------------------------------------------------------- голос и кружок */
async function startVoice() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      if (state.recording && state.recording.canceled) { stopRecUI(); return; }
      const dur = Math.max(1, Math.round((Date.now() - state.recording.start) / 1000));
      sendFileAs(new File([blob], 'voice.webm', { type: blob.type }), 'voice', dur);
      stopRecUI();
    };
    rec.start();
    state.recording = { rec, start: Date.now(), kind: 'voice' };
    showRecBar('🎤 запись голосового…');
    tickRec();
  } catch (e) { toast('Нет доступа к микрофону', true); }
}
function showRecBar(hint) {
  $('recBar').hidden = false;
  $('composer').hidden = true;
  $('recHint').textContent = hint;
  $('recTime').textContent = '0:00';
}
function stopRecUI() { $('recBar').hidden = true; $('composer').hidden = false; clearInterval(state.recTimer); state.recording = null; }
function tickRec() {
  clearInterval(state.recTimer);
  state.recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - (state.recording ? state.recording.start : Date.now())) / 1000);
    $('recTime').textContent = fmtDur(s);
    if (s >= 60 && state.recording && state.recording.kind === 'voice') finishVoice(true);
  }, 250);
}
function finishVoice(cancel) {
  if (!state.recording) return;
  if (cancel) state.recording.canceled = true;
  try { state.recording.rec.stop(); } catch (e) {}
}
$('btnMic').onclick = () => (state.recording ? finishVoice(true) : startVoice());
$('btnRecCancel').onclick = () => finishVoice(true);
$('btnRecSend').onclick = () => finishVoice(false);

let videoStream = null, videoRec = null, videoStart = 0;
$('btnCam').onclick = async () => {
  if (state.recording) return;
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({ video: { width: 720, height: 720, facingMode: 'user' }, audio: true });
    $('videoPreview').srcObject = videoStream;
    $('videoRec').hidden = false;
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm';
    videoRec = new MediaRecorder(videoStream, { mimeType: mime });
    const chunks = [];
    videoRec.ondataavailable = e => e.data.size && chunks.push(e.data);
    videoRec.onstop = async () => {
      const dur = Math.round((Date.now() - videoStart) / 1000);
      const cancelled = $('videoRec').dataset.cancel === '1';
      delete $('videoRec').dataset.cancel;
      videoStream.getTracks().forEach(t => t.stop());
      $('videoRec').hidden = true;
      if (!cancelled && chunks.length) {
        const blob = new Blob(chunks, { type: 'video/webm' });
        await sendFileAs(new File([blob], 'note.webm', { type: 'video/webm' }), 'videonote', dur);
      }
      state.recording = null;
    };
    videoRec.start();
    videoStart = Date.now();
    state.recording = { kind: 'video' };
    const t = setInterval(() => {
      const s = Math.round((Date.now() - videoStart) / 1000);
      $('videoRecTime').textContent = '⭕ ' + fmtDur(s);
      if (s >= 60) { clearInterval(t); try { videoRec.stop(); } catch (e) {} }
      if ($('videoRec').hidden) clearInterval(t);
    }, 300);
    window._videoTimer = t;
  } catch (e) { toast('Нет доступа к камере', true); }
};
$('btnVideoCancel').onclick = () => { $('videoRec').dataset.cancel = '1'; try { videoRec.stop(); } catch (e) {} };
$('btnVideoSend').onclick = () => { clearInterval(window._videoTimer); try { videoRec.stop(); } catch (e) {} };

/* -------------------------------------------------------------- меню */
$('btnMenu').onclick = () => { $('menuDrawer').hidden = false; };
$('menuDrawer').addEventListener('click', e => {
  if (e.target === $('menuDrawer')) { $('menuDrawer').hidden = true; return; }
  const item = e.target.closest('.drawer-item'); if (!item) return;
  $('menuDrawer').hidden = true;
  const act = item.dataset.act;
  if (act === 'profile') profileModal();
  if (act === 'plus') premiumModal();
  if (act === 'group') groupModal();
  if (act === 'theme') {
    const next = (localStorage.getItem('tg_theme') || 'dark') === 'dark' ? 'light' : 'dark';
    localStorage.setItem('tg_theme', next); document.body.dataset.theme = next;
    toast(next === 'dark' ? 'Тёмная тема' : 'Светлая тема');
  }
  if (act === 'help') helpModal();
  if (act === 'server') serverModal();
  if (act === 'clips') openClips();
  if (act === 'logout') logout();
});
function serverModal() {
  const box = openModal(`<h3>🌐 Адрес сервера</h3>
    <p class="sub">Приложение TeleFamily общается через сервер. Если адрес изменился — вставь новый (например https://xxx.trycloudflare.com).</p>
    <div class="field"><label>HTTPS-адрес сервера</label><input id="srvUrl" value="${esc(localStorage.getItem('tf_server') || window.__TFSERVER__ || '')}" placeholder="https://....trycloudflare.com"></div>
    <div class="modal-actions"><button class="btn ghost" id="srvCancel">Отмена</button><button class="btn primary" id="srvSave">Сохранить</button></div>`);
  $('srvCancel').onclick = closeModal;
  $('srvSave').onclick = () => {
    let v = $('srvUrl').value.trim().replace(/\/+$/, '');
    if (v && !/^https?:\/\//.test(v)) v = 'https://' + v;
    localStorage.setItem('tf_server', v);
    closeModal();
    toast('Адрес сохранён, переподключаемся…');
    setTimeout(() => location.reload(), 600);
  };
}
$('btnProfile').onclick = profileModal;

function profileModal() {
  const m = state.me;
  const box = openModal(`<h3>Мой профиль</h3>
    <div class="avatar-edit">
      ${avatarEl(m.avatar, m.name, 'avatar big')}
      <div><button class="btn ghost" id="pickAvatar" style="padding:9px 14px">🖼 Сменить аватар</button>
      <div class="sr-nick" style="margin-top:6px">@${esc(m.username)} ${m.owner ? '· <b style="color:#ffb547">👑 Владелец</b>' : (m.premium ? '· <b style="color:#ffb547">тариф «' + esc(PLAN_LABEL[m.plan] || 'Плюс') + '» ⭐</b>' : '')}</div></div>
    </div>
    <input type="file" id="avatarFile" accept="image/*" hidden>
    <div class="field"><label>Имя</label><input id="pfName" value="${esc(m.name)}"></div>
    <div class="field"><label>О себе</label><textarea id="pfBio" rows="2" placeholder="Пара слов о себе">${esc(m.bio || '')}</textarea></div>
    <div class="field"><label>Новый пароль (необязательно)</label><input id="pfPass" type="password" placeholder="оставь пустым, если не меняешь"></div>
    <div class="modal-actions"><button class="btn ghost" id="pfCancel">Отмена</button><button class="btn primary" id="pfSave">Сохранить</button></div>
    <div class="modal-actions" style="margin-top:8px">
      <button class="btn ghost" id="pfSwitch" style="flex:1">🔄 Поменять аккаунт</button>
      <button class="btn danger" id="pfLogout" style="flex:1">🚪 Выйти из аккаунта</button>
    </div>
    ${m.premium && !m.owner ? '<div style="text-align:center;margin-top:14px"><button class="btn danger" id="pfUnsub" style="padding:8px 16px">Отменить подписку</button></div>' : ''}`);
  $('pickAvatar').onclick = () => $('avatarFile').click();
  $('avatarFile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const url = await downscale(f, 320);
      await api('PATCH', '/api/me', { avatar: url });
      const d = await api('GET', '/api/me'); state.me = d.user; renderMe(); closeModal(); profileModal();
      toast('Аватар обновлён');
    } catch (err) { toast(err.message, true); }
  };
  $('pfCancel').onclick = closeModal;
  $('pfSwitch').onclick = accountsModal;
  $('pfLogout').onclick = () => {
    openModal(`<h3>Выйти из аккаунта?</h3><p class="sub">Аккаунт @${esc(state.me.username)} перестанет быть запомненным на этом телефоне — войти придётся заново.</p>
      <div class="modal-actions"><button class="btn ghost" id="loNo">Отмена</button><button class="btn danger" id="loYes">Выйти</button></div>`);
    $('loNo').onclick = closeModal;
    $('loYes').onclick = () => { forgetAccount(state.me.username); closeModal(); logout(); };
  };
  $('pfSave').onclick = async () => {
    try {
      const body = { name: $('pfName').value, bio: $('pfBio').value };
      const p = $('pfPass').value; if (p) body.password = p;
      await api('PATCH', '/api/me', body);
      const d = await api('GET', '/api/me'); state.me = d.user; renderMe(); closeModal();
      toast('Профиль сохранён');
    } catch (err) { toast(err.message, true); }
  };
  if ($('pfUnsub')) $('pfUnsub').onclick = async () => {
    await api('POST', '/api/unsubscribe', {});
    const d = await api('GET', '/api/me'); state.me = d.user; renderMe(); closeModal(); toast('Подписка отключена');
  };
}
function downscale(file, size) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      const k = Math.min(1, size / Math.max(img.width, img.height));
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      res(c.toDataURL('image/jpeg', .85));
    };
    img.onerror = () => rej(new Error('Не удалось прочитать картинку'));
    img.src = URL.createObjectURL(file);
  });
}

async function refreshMe() {
  const d = await api('GET', '/api/me');
  state.me = d.user; renderMe();
  return d;
}

function fmtCardNum(v) {
  return v.replace(/\D/g, '').slice(0, 16).replace(/(.{4})/g, '$1 ').trim();
}
function cardInputHandler(el) {
  el.addEventListener('input', () => {
    const pos = el.value.length === el.selectionStart;
    el.value = fmtCardNum(el.value);
    if (pos) el.setSelectionRange(el.value.length, el.value.length);
  });
}

function premiumModal() {
  api('GET', '/api/plans').then(renderPlans).catch(e => toast(e.message, true));
}

function renderPlans(d) {
  const cur = d.current || { active: false, plan: 'free' };
  let sel = d.owner ? 'pro' : (cur.active && cur.plan !== 'free' ? cur.plan : 'plus');
  let cards = d.cards || [];

  const planCards = d.plans.map(p => `
    <div class="plan ${p.id === sel ? 'active' : ''}" data-plan="${p.id}">
      ${p.id === cur.plan && cur.active ? '<div class="cur-tag">твой тариф</div>' : ''}
      <div class="plan-name">${esc(p.name)}</div>
      <div class="price">${p.price ? p.price + ' ₽' : '0 ₽'}</div>
      <div class="per">${p.price ? 'в месяц' : 'навсегда'}</div>
      <div class="plan-feats">${p.feats.map(f => `<div><span class="ok">✓</span> ${esc(f)}</div>`).join('')}</div>
    </div>`).join('');

  const cardsLine = cards.length
    ? cards.map(c => `<span class="chip">${c.brand} ••${c.last4}<a class="chip-del" data-del="${c.id}" title="Удалить карту">✕</a></span>`).join(' ')
    : '<span class="muted">карт пока нет — привяжи первую</span>';

  const box = openModal(`<h3>💳 Тарифы TeleFamily</h3>
    <p class="sub">Подписка платная: привязываешь карту один раз — списание идёт автоматически каждый месяц, пока не отменишь.</p>
    ${d.owner ? '<div class="owner-banner">👑 Карта владельца активна — любые тарифы для тебя бесплатны</div>' : ''}
    <div class="plan-grid five">${planCards}</div>
    <div class="saved-cards"><span class="sc-label">Привязанные карты:</span> ${cardsLine}</div>
    <div class="modal-actions">
      <button class="btn ghost" id="plOwner">🔑 Карта владельца</button>
      <button class="btn ghost" id="plCancel">Закрыть</button>
      <button class="btn primary" id="plBuy"></button>
    </div>`);

  const upd = () => {
    const price = PLAN_PRICE[sel];
    box.querySelectorAll('.plan').forEach(x => x.classList.toggle('active', x.dataset.plan === sel));
    $('plBuy').textContent = d.owner ? `Активировать «${PLAN_LABEL[sel]}» — бесплатно`
      : (cards.length ? `Оплатить ${price} ₽ картой ••${cards[0].last4}` : `Привязать карту и оплатить ${price} ₽`);
    $('plBuy').disabled = (sel === cur.plan && cur.active && !d.owner);
    if ($('plBuy').disabled) $('plBuy').textContent = `Тариф «${PLAN_LABEL[sel]}» уже подключён`;
  };

  box.querySelectorAll('.plan').forEach(p => p.onclick = () => { sel = p.dataset.plan; upd(); });
  upd();

  box.querySelectorAll('.chip-del').forEach(a => a.onclick = async () => {
    try {
      await api('POST', '/api/card/delete', { id: a.dataset.del });
      const nd = await api('GET', '/api/plans');
      renderPlans(nd);
      toast('Карта отвязана');
    } catch (e) { toast(e.message, true); }
  });

  $('plCancel').onclick = closeModal;
  $('plOwner').onclick = ownerModal;
  $('plBuy').onclick = async () => {
    if (d.owner) {
      const b = $('plBuy'); b.disabled = true;
      try {
        await api('POST', '/api/subscribe', { plan: sel });
        await refreshMe(); closeModal();
        toast(`Тариф «${PLAN_LABEL[sel]}» активирован 👑`);
      } catch (e) { toast(e.message, true); b.disabled = false; }
      return;
    }
    if (cards.length) {
      const b = $('plBuy'); b.disabled = true; b.textContent = 'Обработка платежа…';
      try {
        const r = await api('POST', '/api/subscribe', { plan: sel, cardId: cards[0].id });
        await refreshMe(); closeModal();
        toast(`Тариф «${PLAN_LABEL[sel]}» оплачен — ${r.paidWith} ✓`);
      } catch (e) { toast(e.message, true); b.disabled = false; upd(); }
      return;
    }
    cardModal(sel);
  };
}

function cardModal(planId) {
  const price = PLAN_PRICE[planId];
  const box = openModal(`<h3>💳 Привязка карты</h3>
    <p class="sub">Оплата тарифа «${PLAN_LABEL[planId]}» — ${price} ₽ в месяц. Номер не хранится: остаются только последние 4 цифры (как в банках).</p>
    <div class="field"><label>Номер карты</label><input id="cdNum" inputmode="numeric" placeholder="0000 0000 0000 0000" autocomplete="cc-number"></div>
    <div class="card-row">
      <div class="field"><label>Срок действия</label><input id="cdExp" placeholder="ММ/ГГ" maxlength="5" inputmode="numeric" autocomplete="cc-exp"></div>
      <div class="field"><label>CVC</label><input id="cdCvc" type="password" placeholder="•••" maxlength="3" inputmode="numeric" autocomplete="cc-csc"></div>
      <div class="field"><label>Держатель</label><input id="cdName" placeholder="ALEXEY IVANOV" autocomplete="cc-name"></div>
    </div>
    <div class="muted" style="font-size:12px">Оплата в демо-режиме TeleFamily: настоящие деньги не списываются, карта проверяется по алгоритму Луна.</div>
    <div class="modal-actions">
      <button class="btn ghost" id="cdBack">Назад</button>
      <button class="btn primary" id="cdPay">Привязать и оплатить ${price} ₽</button>
    </div>`);

  cardInputHandler($('cdNum'));
  $('cdExp').addEventListener('input', () => {
    let v = $('cdExp').value.replace(/\D/g, '').slice(0, 4);
    if (v.length >= 3) v = v.slice(0, 2) + '/' + v.slice(2);
    $('cdExp').value = v;
  });
  $('cdCvc').addEventListener('input', () => { $('cdCvc').value = $('cdCvc').value.replace(/\D/g, '').slice(0, 3); });

  $('cdBack').onclick = premiumModal;
  $('cdPay').onclick = async () => {
    const num = $('cdNum').value.replace(/\D/g, '');
    const exp = $('cdExp').value, cvc = $('cdCvc').value, holder = $('cdName').value.trim();
    if (!luhnValid(num)) return toast('Номер карты неверен — проверь цифры', true);
    if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(exp)) return toast('Срок действия в формате ММ/ГГ', true);
    if (cvc.length < 3) return toast('CVC — 3 цифры', true);
    if (holder.length < 2) return toast('Укажи имя держателя карты', true);
    const b = $('cdPay'); b.disabled = true; b.textContent = 'Проверяем карту в банке…';
    try {
      const c = await api('POST', '/api/card', { number: num, exp, cvc, holder });
      b.textContent = 'Списание средств…';
      const r = await api('POST', '/api/subscribe', { plan: planId, cardId: c.card.id });
      await refreshMe(); closeModal();
      toast(`Тариф «${PLAN_LABEL[planId]}» оплачен — ${r.paidWith} ✓`);
    } catch (e) {
      toast(e.message, true); b.disabled = false; b.textContent = `Привязать и оплатить ${price} ₽`;
    }
  };
  setTimeout(() => $('cdNum').focus(), 80);
}

function ownerModal() {
  const box = openModal(`<h3>🔑 Карта владельца</h3>
    <p class="sub">Спец-карта TeleFamily. Вводишь один раз — навсегда открываются любые тарифы без оплаты и списаний.</p>
    <div class="field"><label>Номер карты владельца</label><input id="owNum" inputmode="numeric" placeholder="0000 0000 0000 0000"></div>
    <div class="modal-actions">
      <button class="btn ghost" id="owCancel">Назад</button>
      <button class="btn primary" id="owOk">Активировать</button>
    </div>`);
  cardInputHandler($('owNum'));
  $('owCancel').onclick = premiumModal;
  $('owOk').onclick = async () => {
    const b = $('owOk'); b.disabled = true; b.textContent = 'Проверка…';
    try {
      await api('POST', '/api/owner', { number: $('owNum').value.replace(/\D/g, '') });
      await refreshMe(); closeModal();
      toast('👑 Владелец подтверждён — любые тарифы доступны бесплатно');
      premiumModal();
    } catch (e) { toast(e.message, true); b.disabled = false; b.textContent = 'Активировать'; }
  };
}

function newChatModal() {
  const box = openModal(`<h3>Новый чат</h3>
    <div class="field"><label>Юзернейм собеседника</label><input id="ncName" placeholder="@username" autocapitalize="none"></div>
    <div class="modal-actions"><button class="btn ghost" id="ncCancel">Отмена</button><button class="btn primary" id="ncGo">Начать чат</button></div>`);
  $('ncCancel').onclick = closeModal;
  $('ncGo').onclick = async () => {
    try {
      const d = await api('POST', '/api/chats', { type: 'dm', username: $('ncName').value });
      upsertChat(d.chat); renderChatList(); closeModal(); openChat(d.chat.id);
    } catch (e) { toast(e.message, true); }
  };
}
function groupModal() {
  const box = openModal(`<h3>Новая группа</h3>
    <div class="field"><label>Название</label><input id="grName" placeholder="Например: Друзья"></div>
    <div class="field"><label>Участники (юзернеймы или имена через запятую)</label><input id="grMembers" placeholder="alex, maria, Наталья"></div>
    <div class="modal-actions"><button class="btn ghost" id="grCancel">Отмена</button><button class="btn primary" id="grCreate">Создать</button></div>`);
  $('grCancel').onclick = closeModal;
  $('grCreate').onclick = () => withBusy($('grCreate'), async () => {
    const name = $('grName').value.trim();
    if (!name) { toast('Назови группу', true); throw new Error('skip'); }
    const members = $('grMembers').value.split(',').map(s => s.trim()).filter(Boolean);
    try {
      const d = await api('POST', '/api/chats', { type: 'group', name, members });
      upsertChat(d.chat); renderChatList(); closeModal(); openChat(d.chat.id);
      if (d.missing && d.missing.length) toast('⚠ Не нашли: ' + d.missing.join(', '), true);
      else toast('Группа создана');
    } catch (e) { if (e.message !== 'skip') toast(e.message, true); throw e; }
  }).catch(() => {});
}
function helpModal() {
  openModal(`<h3>💡 Как пользоваться TeleFamily</h3>
    <div class="plus-list" style="font-size:14px">
      <div>💬 <b>Общение</b> — пиши сообщения, жми Enter для отправки</div>
      <div>🖼 <b>Картинки и видео</b> — кнопка 📎 слева в поле ввода</div>
      <div>🎤 <b>Голосовое</b> — кнопка микрофона, отменить можно «Отмена»</div>
      <div>⭕ <b>Видеосообщение-кружок</b> — кнопка с кружком, до 60 секунд</div>
      <div>↩️ <b>Ответ</b> — наведи на сообщение и нажми стрелку</div>
      <div>😀 <b>Реакции</b> — наведи на сообщение и нажми смайлик</div>
      <div>💬 <b>Комментарии</b> — кнопка 💬 у сообщения (счётчик виден под текстом)</div>
      <div>🗑 <b>Удаление</b> — свои сообщения может удалить любой, чужие — владелец</div>
      <div>👥 <b>Группа</b> — меню ☰ → Новая группа; в группе есть 📞 общий звонок, ✏️ переименование и 🗑 удаление (в ⓘ чата)</div>
      <div>💳 <b>Тарифы</b> — меню ☰ → Тарифы и подписка</div>
      <div>🤫 <b>Секрет</b> — говорят, если5 раз тапнуть логотип➤ в шапке…</div>
    </div>
    <div class="modal-actions"><button class="btn primary" id="hOk">Понятно</button></div>`);
  $('hOk').onclick = closeModal;
}
$('btnNewChat').onclick = newChatModal;
$('btnBack').onclick = () => { state.current = null; $('app').classList.remove('chat-open'); $('chatView').hidden = true; $('emptyState').hidden = false; renderChatList(); };
$('btnChatInfo').onclick = () => {
  const c = state.chatById[state.current]; if (!c) return;
  const canDel = c.type === 'group' && (c.ownerId === (state.me && state.me.id) || (state.me && state.me.owner));
  openModal(`<h3>${esc(c.title)}</h3>
    <p class="sub">${c.type === 'group' ? 'Группа' : 'Личный чат'} · ${c.members.length} участник(ов)</p>
    <div class="list-scroll">${c.members.map(u => `<div class="search-result">
      <div class="avatar-wrap">${avatarEl(u.avatar, u.name, 'avatar sm')}${u.online ? '<span class="online-dot" style="border-color:var(--panel)"></span>' : ''}</div>
      <div><div class="sr-name">${esc(u.name)} ${u.premium ? '⭐' : ''}</div><div class="sr-nick">@${esc(u.username)}${u.id === state.me.id ? ' · это ты' : ''}</div></div>
    </div>`).join('')}</div>
    <div class="modal-actions">
      ${canDel ? '<button class="btn ghost" id="ciRen">✏️ Переименовать</button>' : ''}
      ${canDel ? '<button class="btn danger" id="ciDel">🗑 Удалить группу</button>' : ''}
      <button class="btn primary" id="ciOk">Закрыть</button>
    </div>`);
  $('ciOk').onclick = closeModal;
  if (canDel) {
    $('ciRen').onclick = () => renameGroupModal(c);
    $('ciDel').onclick = () => confirmDeleteGroup(c);
  }
};
function renameGroupModal(c) {
  openModal(`<h3>Переименовать группу</h3>
    <div class="field"><label>Новое название</label><input id="rnName" value="${esc(c.title)}" maxlength="60" placeholder="Название группы"></div>
    <div class="modal-actions"><button class="btn ghost" id="rnNo">Отмена</button><button class="btn primary" id="rnYes">Сохранить</button></div>`);
  $('rnNo').onclick = closeModal;
  const inp = $('rnName'); if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  $('rnYes').onclick = () => withBusy($('rnYes'), async () => {
    const name = ($('rnName').value || '').trim();
    if (!name) { toast('Пустое название', true); throw new Error('skip'); }
    try {
      await api('POST', `/api/chats/${c.id}/rename`, { name });
      closeModal();
      toast('Группа переименована');
    } catch (e) { if (e.message !== 'skip') toast(e.message, true); throw e; }
  }).catch(() => {});
}
function confirmDeleteGroup(c) {
  openModal(`<h3>Удалить группу?</h3>
    <p class="sub">«${esc(c.title)}» и все её сообщения исчезнут у всех участников. Отменить будет нельзя.</p>
    <div class="modal-actions"><button class="btn ghost" id="dgNo">Отмена</button><button class="btn danger" id="dgYes">Удалить навсегда</button></div>`);
  $('dgNo').onclick = closeModal;
  $('dgYes').onclick = async () => {
    const btn = $('dgYes');
    btn.disabled = true; btn.textContent = 'Удаляю…';
    try {
      await api('DELETE', `/api/chats/${c.id}`);
      removeChat(c.id);
      closeModal();
      toast('Группа удалена');
    } catch (e) { btn.disabled = false; btn.textContent = 'Удалить навсегда'; toast(e.message, true); }
  };
}

/* ------------------------------------------------🎬 КЛИПЫ (секретный раздел) */
const CLIPS_PIN = '3141';
let clipsMuted = true;
let clipsState = null;               /* { list, i } */
let safeBuf = '', safeFails = 0, safeLockT = 0, brandTaps = 0, brandTapT = 0;

function clipsUnlocked() { try { return localStorage.getItem('tf_clips') === '1'; } catch (e) { return false; } }
function updateClipsMenu() { const el = $('menuItemClips'); if (el) el.hidden = !clipsUnlocked(); }

/* ритуал активации: 5 кликов по логотипу в шапке сайдбара (за 1.5 сек между тапами) */
const brandEl = document.querySelector('.brand');
if (brandEl) brandEl.addEventListener('click', () => {
  const now = Date.now();
  brandTaps = (now - brandTapT > 1500) ? 1 : brandTaps + 1;
  brandTapT = now;
  if (brandTaps >= 5) { brandTaps = 0; openSafe(); }
});

function openSafe() {
  if (Date.now() < safeLockT) { toast('🔒 Сейф остыл — подожди немного', true); return; }
  safeBuf = '';
  const box = openModal(`<div class="safe">
    <h3>🔐 Сейф TeleFamily</h3>
    <p class="sub">Введи код из четырёх цифр</p>
    <div class="safe-dots" id="safeDots"><i></i><i></i><i></i><i></i></div>
    <div class="safe-pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button type="button" data-n="${n}">${n}</button>`).join('')}
      <button type="button" data-n="C">C</button><button type="button" data-n="0">0</button><button type="button" data-n="B">⌫</button></div>
    <div class="modal-actions"><button class="btn ghost" id="safeClose">Закрыть</button></div></div>`);
  $('safeClose').onclick = closeModal;
  box.querySelector('.safe').addEventListener('click', e => {
    const b = e.target.closest('[data-n]'); if (!b) return;
    safePress(b.dataset.n);
  });
}
function safeRender() {
  const dots = $('safeDots'); if (!dots) return;
  [...dots.children].forEach((d, i) => d.classList.toggle('on', i < safeBuf.length));
}
function safeShake() {
  const d = $('safeDots'); if (!d) return;
  d.classList.add('shake');
  setTimeout(() => { const x = $('safeDots'); if (x) x.classList.remove('shake'); }, 460);
}
/* короткие звуки клавиатуры и салют при открытии */
function sfx(f, dur, when = 0, vol = 0.07) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ctx = sfx._c || (sfx._c = new AC());
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t0 = ctx.currentTime + when;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(f, t0);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(ctx.destination);
    o.start(t0); o.stop(t0 + dur + 0.03);
  } catch (e) {}
}
function confettiBurst() {
  const host = document.body;
  for (let i = 0; i < 26; i++) {
    const s = document.createElement('span');
    s.className = 'confetti';
    s.textContent = ['🎉', '🎬', '🎟️', '✨', '🍿', '❤️'][i % 6];
    s.style.left = (6 + Math.random() * 88) + '%';
    s.style.animationDelay = (Math.random() * 0.45) + 's';
    s.style.animationDuration = (0.9 + Math.random() * 0.8) + 's';
    host.appendChild(s);
    setTimeout(() => s.remove(), 2600);
  }
}
function safePress(n) {
  if (n === 'C') safeBuf = '';
  else if (n === 'B') safeBuf = safeBuf.slice(0, -1);
  else if (safeBuf.length < 4) safeBuf += n;
  sfx(n === 'B' ? 360 : n === 'C' ? 300 : 600 + Number(n || 0) * 20, 0.05);
  safeRender();
  if (safeBuf.length < 4) return;
  if (safeBuf === CLIPS_PIN) {
    try { localStorage.setItem('tf_clips', '1'); } catch (e) {}
    updateClipsMenu();
    sfx(784, 0.12, 0); sfx(988, 0.12, 0.13); sfx(1319, 0.24, 0.26);   /* фанфара */
    confettiBurst();
    closeModal();
    toast('🔓 Секретный раздел «Клипы» открыт!');
    setTimeout(openClips, 900);
    return;
  }
  safeFails++;
  if (safeFails >= 5) {
    safeFails = 0; safeLockT = Date.now() + 30000;
    sfx(140, 0.5);
    closeModal();
    toast('🔒 Слишком много попыток — сейф закрыт на 30 секунд', true);
    return;
  }
  safeBuf = ''; safeRender(); safeShake();
  sfx(160, 0.28);
  toast('❌ Не тот код', true);
}

async function openClips() {
  if (!clipsUnlocked()) { toast('🔒 Это секретный раздел — найди сейф', true); return; }
  let list;
  try { list = (await api('GET', '/api/clips')).clips; } catch (e) { toast(e.message, true); return; }
  if (!list || !list.length) { toast('Клипов пока нет 🙈', true); return; }
  clipsState = { list, i: 0 };
  let root = $('clipsRoot');
  if (!root) {
    root = document.createElement('div');
    root.id = 'clipsRoot'; root.className = 'clips-root'; root.hidden = true;
    document.body.appendChild(root);
  }
  root.hidden = false;
  document.addEventListener('keydown', clipsKeys, true);
  renderClip();
}
function closeClips() {
  clipsState = null;
  const root = $('clipsRoot');
  if (root) { root.hidden = true; root.innerHTML = ''; }
  document.removeEventListener('keydown', clipsKeys, true);
}
function clipsKeys(e) {
  if (!clipsState) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeClips(); }
  else if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); clipGo(1); }
  else if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); clipGo(-1); }
  else if (e.key === ' ') {
    e.preventDefault();
    const v = $('clipVideo');
    if (v) { if (v.paused) v.play().catch(() => {}); else v.pause(); }
  }
}
function clipGo(d) {
  if (!clipsState) return;
  const n = clipsState.list.length;
  clipsState.i = (clipsState.i + d + n) % n;
  renderClip();
}
function renderClip() {
  const st = clipsState; if (!st) return;
  const c = st.list[st.i];
  const root = $('clipsRoot'); if (!root) return;
  root.innerHTML = `
    <div class="clip-head">
      <span class="clip-brand">🎬 TeleTok</span>
      <span class="clip-count">${st.i + 1} / ${st.list.length}</span>
      <button class="clip-x" id="clipClose" title="Закрыть">✕</button>
    </div>
    <div class="clip-stage" id="clipStage">
      <video id="clipVideo" src="${esc(c.url)}" autoplay loop playsinline muted></video>
      <div class="clip-float" id="clipFloat">❤️</div>
      <div class="clip-info"><b>${esc(c.title)}</b><span>${esc(c.author)} · ${esc(c.src)}</span></div>
      <div class="clip-hint">свайп ↑↓ или стрелки</div>
    </div>
    <div class="clip-rail">
      <button class="clip-like ${c.liked ? 'liked' : ''}" id="clipLike" title="Лайк">${c.liked ? '❤️' : '🤍'}</button>
      <div class="clip-likes" id="clipLikes">${c.likes}</div>
      <button class="clip-mini" id="clipMute" title="Звук">${clipsMuted ? '🔇' : '🔊'}</button>
      <button class="clip-mini" id="clipUp" title="Предыдущий">⬆️</button>
      <button class="clip-mini" id="clipDown" title="Следующий">⬇️</button>
    </div>`;
  const video = $('clipVideo');
  video.muted = clipsMuted;
  video.play().catch(() => {});
  /* автоплей может быть заблокирован — показываем ▶, тап по экрану стартует */
  const stage = $('clipStage');
  const syncPlay = () => stage.classList.toggle('need-play', !!video.paused);
  video.addEventListener('play', syncPlay);
  video.addEventListener('playing', syncPlay);
  video.addEventListener('pause', syncPlay);
  setTimeout(syncPlay, 700);
  stage.addEventListener('click', () => {
    if (video.paused) video.play().catch(() => {}); else video.pause();
  });
  $('clipClose').onclick = closeClips;
  $('clipLike').onclick = () => clipLike(c);
  $('clipMute').onclick = () => {
    clipsMuted = !clipsMuted;
    video.muted = clipsMuted;
    $('clipMute').textContent = clipsMuted ? '🔇' : '🔊';
  };
  $('clipUp').onclick = () => clipGo(-1);
  $('clipDown').onclick = () => clipGo(1);
  /* двойной тап = лайк с анимацией */
  let lastTap = 0;
  stage.addEventListener('touchend', () => {
    const now = Date.now();
    if (now - lastTap < 320) clipLike(c, true);
    lastTap = now;
  }, { passive: true });
  stage.addEventListener('dblclick', () => clipLike(c, true));
  /* свайп вверх/вниз = следующий/предыдущий */
  let sy = null;
  stage.addEventListener('touchstart', e => { sy = e.touches[0].clientY; }, { passive: true });
  stage.addEventListener('touchend', e => {
    if (sy === null) return;
    const dy = e.changedTouches[0].clientY - sy; sy = null;
    if (dy < -45) clipGo(1); else if (dy > 45) clipGo(-1);
  }, { passive: true });
  /* колесо мыши */
  let wheelT = 0;
  stage.addEventListener('wheel', e => {
    const now = Date.now();
    if (Math.abs(e.deltaY) < 8 || now - wheelT < 450) return;
    wheelT = now;
    clipGo(e.deltaY > 0 ? 1 : -1);
  }, { passive: true });
}
async function clipLike(c, withFloat) {
  try {
    const d = await api('POST', '/api/clips/' + encodeURIComponent(c.file));
    c.likes = d.likes; c.liked = d.liked;
    const btn = $('clipLike'), cnt = $('clipLikes');
    if (btn) { btn.textContent = c.liked ? '❤️' : '🤍'; btn.classList.toggle('liked', c.liked); }
    if (cnt) cnt.textContent = c.likes;
    if (c.liked && withFloat) {
      const f = $('clipFloat');
      if (f) { f.classList.remove('pop'); void f.offsetWidth; f.classList.add('pop'); }
    }
  } catch (e) { toast(e.message, true); }
}
updateClipsMenu();

/* -------------------------------------------------------------- прочее */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); $('viewerClose').click(); cancelReply(); }
});
window.addEventListener('online', () => toast('Соединение восстановлено'));
window.addEventListener('offline', () => toast('Нет интернета — подключаемся…', true));
setInterval(() => { if (state.current) renderChatSub(); }, 30000);
setInterval(() => wsSend({ t: 'ping' }), 25000);

// долгое нажатие для тач-устройств (открыть действия сообщения)
document.addEventListener('touchstart', e => {
  const m = e.target.closest('.msg'); if (!m) return;
  m._lt = setTimeout(() => m.classList.add('show-tools'), 420);
}, { passive: true });
document.addEventListener('touchend', e => {
  const m = e.target.closest('.msg'); if (m) clearTimeout(m._lt);
  setTimeout(() => document.querySelectorAll('.show-tools').forEach(x => { if (!x.matches(':hover')) x.classList.remove('show-tools'); }), 2500);
}, { passive: true });

const extraStyle = document.createElement('style');
extraStyle.textContent = '.msg.show-tools .msg-tools{display:flex} .msg{user-select:text}';
document.head.appendChild(extraStyle);

/* -------------------------------------------------------------- старт */
(async function boot() {
  document.body.dataset.theme = localStorage.getItem('tg_theme') || 'dark';
  if (!state.token) {
    /* телефон помнит последний аккаунт — входим автоматически */
    let last = null;
    try { last = localStorage.getItem('tf_last'); } catch (e) {}
    const acc = last ? getAccounts().find(x => x.username === last) : null;
    if (acc && acc.token) { state.token = acc.token; localStorage.setItem('tg_token', acc.token); }
  }
  if (!state.token) { $('auth').hidden = false; return; }
  startApp();
})();
