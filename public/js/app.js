/* Shared helpers used by every page: fetch, formatting, nav, footer, dialogs. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const qs = (key) => new URLSearchParams(location.search).get(key);

let SETTINGS = { currency: 'Rs' };

/** Fetch wrapper that surfaces the server's own error message. */
async function api(url, options = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: options.body ? { 'Content-Type': 'application/json' } : {},
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new Error('Cannot reach the server. Check your connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* ---------- notifications ---------- */

function toast(message, type = '') {
  let stack = $('.toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    document.body.appendChild(stack);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

/** Styled replacement for window.confirm. Resolves true/false. */
function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', danger = true }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.innerHTML = `
      <div class="modal slim">
        <div class="modal-head"><h3>${esc(title)}</h3>
          <button class="x-close" data-no title="Close">&times;</button></div>
        <div class="modal-body"><p class="muted" style="margin:0;white-space:pre-line">${esc(message)}</p></div>
        <div class="modal-foot">
          <button class="btn ghost" data-no>Cancel</button>
          <button class="btn ${danger ? 'danger' : ''}" data-yes>${esc(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(back);

    const done = (value) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(value); };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    document.addEventListener('keydown', onKey);

    back.addEventListener('click', (e) => { if (e.target === back) done(false); });
    $$('[data-no]', back).forEach((b) => b.addEventListener('click', () => done(false)));
    $('[data-yes]', back).addEventListener('click', () => done(true));
    $('[data-yes]', back).focus();
  });
}

/* ---------- loading states ---------- */

/** Disables a button and shows a spinner while an async action runs. */
async function withBusy(button, label, fn) {
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="spin"></span>${esc(label)}`;
  try { return await fn(); }
  finally { button.disabled = false; button.innerHTML = original; }
}

const skeletonCards = (n = 8) => Array.from({ length: n }, () => `
  <div class="sk-card">
    <div class="sk sk-poster"></div>
    <div class="sk sk-line"></div>
    <div class="sk sk-line short"></div>
  </div>`).join('');

const skeletonRows = (n = 5) => Array.from({ length: n }, () => '<div class="sk sk-row"></div>').join('');

/* ---------- formatting ---------- */

const money = (n) => `${SETTINGS.currency} ` + Math.round(Number(n) || 0).toLocaleString('en-PK');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * A poster can be an uploaded file ("/uploads/x.jpg"), an external URL,
 * or a "#hex,#hex" pair drawn as a gradient placeholder.
 */
function posterStyle(poster, title = '') {
  if (poster && /^(https?:\/\/|\/uploads\/)/.test(poster)) {
    // Not encodeURI: Storage URLs are already encoded, and encoding them again
    // turns %2F into %252F. Only characters that could break out of the style attribute matter.
    const safe = poster.replace(/[()"']/g, (c) => '%' + c.charCodeAt(0).toString(16));
    return `background-image:url('${safe}')`;
  }
  const [a = '', b = ''] = String(poster || '').split(',');
  const seed = [...title].reduce((s, c) => s + c.charCodeAt(0), 0);
  const c1 = a.startsWith('#') ? a : `hsl(${seed % 360} 40% 22%)`;
  const c2 = b.startsWith('#') ? b : `hsl(${(seed + 60) % 360} 45% 42%)`;
  return `background-image:linear-gradient(150deg, ${c1}, ${c2})`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const toDate = (sqlTime) => new Date(String(sqlTime).replace(' ', 'T'));

function fmtTime(sqlTime) {
  const d = toDate(sqlTime);
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
}

function fmtDate(sqlTime) {
  const d = toDate(sqlTime);
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

const fmtDateTime = (sqlTime) => `${fmtDate(sqlTime)} · ${fmtTime(sqlTime)}`;

const isoDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const runtime = (mins) => `${Math.floor(mins / 60)}h ${mins % 60}m`;

const stars = (rating) => {
  const n = Math.round(Number(rating) || 0);
  return '★'.repeat(n) + '☆'.repeat(5 - n);
};

/* ---------- movie card (used on several pages) ---------- */

function movieCard(m, rank = null) {
  return `
    <div class="movie-card" onclick="location.href='movie.html?id=${m.id}'"
         role="link" tabindex="0" onkeydown="if(event.key==='Enter')location.href='movie.html?id=${m.id}'">
      <div class="poster" style="${posterStyle(m.poster_url, m.title)}">
        ${rank ? `<span class="rank">${rank}</span>` : ''}
        ${esc(m.title)}
      </div>
      <div class="movie-body">
        <div class="t" title="${esc(m.title)}">${esc(m.title)}</div>
        <div class="movie-meta">
          ${m.avg_rating ? `<span class="badge gold">${m.avg_rating}/5</span>` : ''}
          <span class="badge">${esc(m.certificate || 'U/A')}</span>
        </div>
        <div class="movie-meta" style="margin-top:6px">
          <span>${esc(m.language || '')}</span><span>·</span><span>${runtime(m.duration_min || 0)}</span>
        </div>
        <div class="movie-meta dim" style="margin-top:4px">${esc(m.genre || '')}</div>
      </div>
    </div>`;
}

/* ---------- navbar + footer ---------- */

let CURRENT_USER = null;

const LOGO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="18" rx="2"/>
  <path d="M7 3v18M17 3v18M2 9h5M2 15h5M17 9h5M17 15h5"/></svg>`;

/*
 * The whole site sits behind a login: a visitor who is not signed in is sent to
 * the login page first and brought back here afterwards. Only the pages needed
 * to get in stay open. The page is hidden until the check finishes, so nothing
 * flashes on screen before the redirect.
 */
const OPEN_PAGES = ['login.html', 'reset-password.html'];
const PAGE_NAME = location.pathname.split('/').pop() || 'index.html';
const LOGIN_GATED = !OPEN_PAGES.includes(PAGE_NAME);
if (LOGIN_GATED) document.documentElement.style.visibility = 'hidden';

async function renderNav(active = '') {
  try { CURRENT_USER = (await api('/api/auth/me')).user; } catch { CURRENT_USER = null; }

  if (LOGIN_GATED && !CURRENT_USER) {
    location.replace('login.html?next=' + encodeURIComponent(location.pathname + location.search));
    return new Promise(() => {});   // stop the page's own loading while the redirect happens
  }
  document.documentElement.style.visibility = '';

  const links = [
    ['index.html', 'Home'],
    ['movies.html', 'Movies'],
    ['cinemas.html', 'Cinemas'],
    ['bookings.html', 'My Bookings'],
  ];
  if (CURRENT_USER?.role === 'admin') links.push(['admin.html', 'Admin']);

  const right = CURRENT_USER
    ? `<span class="muted who">Hi, ${esc(CURRENT_USER.name.split(' ')[0])}</span>
       <button class="btn ghost sm" id="logoutBtn">Logout</button>`
    : `<a class="btn sm" href="login.html">Login</a>`;

  const nav = document.createElement('nav');
  nav.className = 'nav';
  nav.innerHTML = `
    <a class="brand" href="index.html">${LOGO}CINE<span>PLEX</span></a>
    <div class="nav-links" id="navLinks">
      ${links.map(([href, label]) =>
        `<a href="${href}" class="${active === href ? 'active' : ''}">${label}</a>`).join('')}
    </div>
    <div class="nav-user">${right}</div>
    <button class="nav-toggle" id="navToggle" aria-label="Menu" aria-expanded="false">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M3 6h18M3 12h18M3 18h18"/></svg>
    </button>`;
  document.body.prepend(nav);

  const toggle = $('#navToggle');
  toggle.addEventListener('click', () => {
    const open = $('#navLinks').classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  $('#logoutBtn')?.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.href = 'index.html';
  });

  return CURRENT_USER;
}

function renderFooter() {
  const year = new Date().getFullYear();
  const footer = document.createElement('footer');
  footer.className = 'footer';
  footer.innerHTML = `
    <div class="footer-inner">
      <div>
        <div class="brand" style="margin-bottom:12px">${LOGO}CINE<span>PLEX</span></div>
        <p class="about">Book cinema tickets across Karachi, Lahore and Islamabad.
          Pick your seats, pay online and walk straight in.</p>
      </div>
      <div>
        <h4>Browse</h4>
        <ul>
          <li><a href="index.html">Home</a></li>
          <li><a href="movies.html">All Movies</a></li>
          <li><a href="movies.html?status=coming_soon">Coming Soon</a></li>
          <li><a href="cinemas.html">Cinemas</a></li>
        </ul>
      </div>
      <div>
        <h4>Account</h4>
        <ul>
          <li><a href="bookings.html">My Bookings</a></li>
          <li><a href="bookings.html#profile">Profile</a></li>
          <li><a href="login.html">Login or Register</a></li>
        </ul>
      </div>
      <div>
        <h4>Support</h4>
        <ul>
          <li>help@cineplex.example</li>
          <li>021-111-222-333</li>
          <li>Daily, 10am - 2am</li>
        </ul>
      </div>
    </div>
    <div class="footer-bottom">
      <span>&copy; ${year} Cineplex. Demo project - no real payments are taken.</span>
      <span>Seats are held for a few minutes while you pay.</span>
    </div>`;
  document.body.appendChild(footer);
}

/**
 * Reads a picked image as a data URL ready for upload, shrinking large photos
 * first. Posters never need more than about 1400px, and a phone photo can be
 * several MB, far more than the database should hold per image.
 */
const UPLOAD_TARGET_BYTES = 600 * 1024;

async function readImageForUpload(file) {
  const asDataUrl = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read ' + (file.name || 'that file')));
    reader.readAsDataURL(blob);
  });

  if (file.size <= UPLOAD_TARGET_BYTES) return asDataUrl(file);   // small enough; keeps GIF animation too

  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('That file is not an image this browser can open'));
    el.src = URL.createObjectURL(file);
  });

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  for (const [maxSide, quality] of [[1400, 0.85], [1200, 0.78], [1000, 0.72], [800, 0.65], [600, 0.6]]) {
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    ctx.fillStyle = '#0b0d12';                     // transparent areas of a PNG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = canvas.toDataURL('image/jpeg', quality);
    if (out.length * 0.75 <= UPLOAD_TARGET_BYTES) { URL.revokeObjectURL(img.src); return out; }
  }
  URL.revokeObjectURL(img.src);
  throw new Error('This image is too large even after shrinking. Please use a smaller picture.');
}

/** Sends the visitor to login and returns them here afterwards. */
function requireLogin() {
  if (CURRENT_USER) return true;
  location.href = 'login.html?next=' + encodeURIComponent(location.pathname + location.search);
  return false;
}

/** Booking progress indicator. `current` is 1-based. */
function stepsBar(current) {
  const labels = ['Movie', 'Cinema & Show', 'Seats', 'Summary', 'Payment', 'Ticket'];
  return `<div class="steps">${labels.map((label, i) => {
    const n = i + 1;
    const cls = n < current ? 'done' : n === current ? 'active' : '';
    return `${i ? '<span class="step-line"></span>' : ''}
      <div class="step ${cls}">
        <span class="dot">${n < current ? '✓' : n}</span>
        <span class="lbl">${label}</span>
      </div>`;
  }).join('')}</div>`;
}

/* ---------- live updates ---------- */

let liveSource = null;

/**
 * Re-runs `onChange(collection)` whenever the server says that collection
 * changed, so lists stay current without a page reload.
 *
 *   subscribeLive(['movies', 'shows'], () => load());
 *
 * The browser reconnects on its own if the stream drops.
 */
function subscribeLive(collections, onChange) {
  if (!window.EventSource) return () => {};
  liveSource?.close();

  const wanted = new Set(collections);
  const src = new EventSource('/api/events');
  liveSource = src;

  src.addEventListener('change', (e) => {
    let payload;
    try { payload = JSON.parse(e.data); } catch { return; }
    if (!wanted.has(payload.collection)) return;
    // Skip while a dialog is open, so a refresh never yanks a form away.
    if (document.querySelector('.modal-backdrop')) return;
    onChange(payload.collection);
  });

  /*
   * When the stream is refused outright (the deployed site answers 204), fall
   * back to checking every 20 seconds. '*' means "anything may have changed".
   * Paused while the tab is hidden so idle tabs cost nothing.
   */
  src.onerror = () => {
    if (src.readyState !== EventSource.CLOSED || src._polling) return;
    src._polling = setInterval(() => {
      if (document.hidden || document.querySelector('.modal-backdrop')) return;
      onChange('*');
    }, 20_000);
  };

  const stop = () => { src.close(); clearInterval(src._polling); };
  window.addEventListener('beforeunload', stop);
  return stop;
}

/** Loads shared money/format settings once per page. */
async function loadSettings() {
  try {
    const s = await api('/api/payment-methods');
    SETTINGS = { ...SETTINGS, ...s, currency: s.currency || 'Rs' };
  } catch { /* falls back to the defaults above */ }
  return SETTINGS;
}
