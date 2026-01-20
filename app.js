// Otaku Syndicate - app.js
// Features:
// - Trending / latest anime from AniList
// - Live search with dropdown suggestions (images + full title)
// - Anime detail modal with description & embedded YouTube trailer
// - Anime News from Anime News Network (ANN) RSS
// - Schedule (attempts to fetch SubsPlease weekly schedule; falls back gracefully)
// - Skeleton loaders and Telegram Web App user info detection
// NOTE: Some third-party endpoints (SubsPlease, ANN, AniList) may block CORS. Use a proxy if needed.

const AniListURL = 'https://graphql.anilist.co';
const ANN_RSS = 'https://www.animenewsnetwork.com/all/rss.xml';
const SubsPleaseURL = 'https://subsplease.org/'; // may require proxy

/* ---------- simple DOM helpers ---------- */
const $ = (s, ctx=document) => ctx.querySelector(s);
const $$ = (s, ctx=document) => Array.from(ctx.querySelectorAll(s));

/* ---------- refs ---------- */
const tabs = $$('.tab');
const pages = $$('.page');
const trendingList = $('#trending-list');
const trendingSort = $('#trending-sort');
const refreshTrendingBtn = $('#refresh-trending');

const searchInput = $('#search-input');
const searchDropdown = $('#search-dropdown');
const searchResults = $('#search-results');

const newsList = $('#news-list');
const refreshNewsBtn = $('#refresh-news');

const sourceTz = $('#source-timezone');
const targetTz = $('#target-timezone');
const scheduleContent = $('#schedule-content');
const todayBtn = $('#today-btn');
const weekBtn = $('#week-btn');

const modal = $('#modal');
const modalBackdrop = $('#modal-backdrop');
const modalBody = $('#modal-body');
const modalCloseBtn = $('#modal-close-btn');

const userNameEl = $('#user-name');
const userAvatarSkel = $('#user-avatar-skel');

/* ---------- state ---------- */
let userProfile = {name: 'Guest', avatar: ''};
let searchDebounce = null;

/* ---------- initialization ---------- */
document.addEventListener('click', (e)=> {
  if (!e.target.closest('#search-dropdown') && !e.target.closest('#search-input')) {
    searchDropdown.classList.add('hidden');
  }
});
tabs.forEach(t => t.addEventListener('click', (e) => {
  tabs.forEach(x=>x.classList.remove('active'));
  e.currentTarget.classList.add('active');
  const page = e.currentTarget.dataset.page;
  pages.forEach(p => p.classList.toggle('hidden', p.id !== page));
}));

modalBackdrop.addEventListener('click', hideModal);
modalCloseBtn.addEventListener('click', hideModal);

/* ---------- Telegram user detection ---------- */
function initTelegramUser() {
  try {
    const tg = window.Telegram?.WebApp;
    if (tg) {
      tg.expand?.();
      const init = tg.initDataUnsafe ?? null;
      const user = init?.user ?? null;
      if (user) {
        userProfile.name = user.first_name + (user.last_name ? (' ' + user.last_name) : '');
        // Telegram doesn't expose a stable avatar url for all, leave blank if not possible
        userProfile.avatar = '';
      }
    }
  } catch(e){}
  renderUser();
}
function renderUser(){
  userNameEl.textContent = userProfile.name || 'Guest';
  if (userProfile.avatar) {
    const img = document.createElement('img');
    img.src = userProfile.avatar;
    img.alt = 'avatar';
    img.width = 36;
    img.height = 36;
    const wrap = document.getElementById('user-avatar-wrap');
    wrap.innerHTML = '';
    wrap.appendChild(img);
  } else {
    // keep skeleton avatar
    userAvatarSkel.classList.remove('hidden');
  }
}

/* ---------- AniList GraphQL helper ---------- */
async function aniListQuery(query, variables = {}) {
  const res = await fetch(AniListURL, {
    method: 'POST',
    headers: {'Content-Type':'application/json','Accept':'application/json'},
    body: JSON.stringify({query, variables})
  });
  if (!res.ok) throw new Error('AniList error: ' + res.status);
  return res.json();
}

/* ---------- Trending / Home ---------- */
const TRENDING_QUERY = `
query ($page: Int, $perPage: Int, $sort: [MediaSort]) {
  Page(page: $page, perPage: $perPage) {
    media(sort: $sort, type: ANIME) {
      id
      title { romaji english native userPreferred }
      coverImage { large medium color }
      bannerImage
      episodes
      season
      seasonYear
      averageScore
      popularity
      status
      genres
      description(asHtml: true)
      trailer { id site thumbnail }
      studios { nodes { name } }
    }
  }
}
`;

async function loadTrending(){
  trendingList.innerHTML = '';
  for (let i=0;i<8;i++){
    const s = document.createElement('div');
    s.className = 'card card-skel skeleton';
    trendingList.appendChild(s);
  }
  try {
    const sort = trendingSort.value || 'TRENDING_DESC';
    const res = await aniListQuery(TRENDING_QUERY, {page:1, perPage:18, sort:[sort]});
    const media = res.data.Page.media;
    trendingList.innerHTML = '';
    media.forEach(m => trendingList.appendChild(createCard(m)));
  } catch (err) {
    trendingList.innerHTML = `<div class="news-item"><div>Error loading trending: ${err.message}</div></div>`;
    console.error(err);
  }
}
function createCard(m){
  const card = document.createElement('div');
  card.className = 'card';
  card.tabIndex = 0;
  card.innerHTML = `
    <img src="${m.coverImage.large || m.coverImage.medium}" alt="${escapeHtml(m.title.userPreferred)}" loading="lazy">
    <div>
      <strong>${escapeHtml(m.title.userPreferred)}</strong>
      <div class="meta">
        <span>${m.season ? (m.season + ' ' + (m.seasonYear || '')) : ''}</span>
        <span>${m.averageScore ? m.averageScore + '★' : ''}</span>
      </div>
    </div>
  `;
  card.addEventListener('click', ()=> openDetails(m.id));
  card.addEventListener('keypress', (e)=> { if (e.key === 'Enter') openDetails(m.id); });
  return card;
}

/* ---------- Search (live with dropdown) ---------- */
const SEARCH_QUERY = `
query ($search: String, $page: Int, $perPage: Int) {
  Page(page:$page, perPage:$perPage) {
    media(search:$search, type: ANIME) {
      id
      title { userPreferred romaji english native }
      coverImage { medium large }
      format
      episodes
      season
      seasonYear
    }
  }
}
`;
searchInput.addEventListener('input', (e)=>{
  const q = e.target.value.trim();
  if (searchDebounce) clearTimeout(searchDebounce);
  if (!q) {
    searchDropdown.classList.add('hidden');
    searchResults.innerHTML = '';
    return;
  }
  searchDebounce = setTimeout(()=> doSearch(q), 220);
});

async function doSearch(q){
  searchDropdown.innerHTML = '';
  searchDropdown.classList.remove('hidden');
  // lightweight skeletons
  for (let i=0;i<4;i++){
    const sk = document.createElement('div');
    sk.className = 'dropdown-item skeleton';
    sk.style.height = '84px';
    searchDropdown.appendChild(sk);
  }
  try {
    const res = await aniListQuery(SEARCH_QUERY, {search:q, page:1, perPage:8});
    const items = res.data.Page.media;
    searchDropdown.innerHTML = '';
    if (!items.length){
      const no = document.createElement('div');
      no.className = 'dropdown-item';
      no.textContent = 'No results';
      searchDropdown.appendChild(no);
      return;
    }
    items.forEach(it => {
      const di = document.createElement('div');
      di.className = 'dropdown-item';
      di.tabIndex = 0;
      di.innerHTML = `
        <img src="${it.coverImage.medium}" alt="${escapeHtml(it.title.userPreferred)}">
        <div>
          <div class="title">${escapeHtml(it.title.userPreferred)}</div>
          <div class="sub">${it.format || ''} • ${it.episodes ? it.episodes + ' eps' : ''} ${it.season ? '• ' + it.season + ' ' + (it.seasonYear || '') : ''}</div>
        </div>
      `;
      di.addEventListener('click', ()=>{ searchDropdown.classList.add('hidden'); searchInput.value=''; openDetails(it.id); });
      di.addEventListener('keypress', (e)=>{ if (e.key === 'Enter'){ searchDropdown.classList.add('hidden'); searchInput.value=''; openDetails(it.id); }});
      searchDropdown.appendChild(di);
    });

    // Also render a grid with those results below
    searchResults.innerHTML = '';
    items.forEach(it => {
      const c = createCard(it);
      searchResults.appendChild(c);
    });
  } catch (err) {
    console.error(err);
    searchDropdown.innerHTML = `<div class="dropdown-item">Error: ${err.message}</div>`;
  }
}

/* ---------- Anime details modal ---------- */
const DETAILS_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    title { romaji english native userPreferred }
    coverImage { large medium }
    bannerImage
    description(asHtml:true)
    episodes
    duration
    season
    seasonYear
    averageScore
    popularity
    status
    genres
    trailer { id site thumbnail }
    studios { nodes { name } }
    relations { edges { node { id title { userPreferred } } } }
  }
}
`;

async function openDetails(id){
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden','false');
  modalBody.innerHTML = `<div class="modal-close-placeholder skeleton card-skel" style="height:320px"></div>`;
  try {
    const r = await aniListQuery(DETAILS_QUERY, {id: id});
    const m = r.data.Media;
    renderModal(m);
  } catch (err) {
    modalBody.innerHTML = `<div class="news-item">Error loading details: ${err.message}</div>`;
    console.error(err);
  }
}

function hideModal(){
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden','true');
  modalBody.innerHTML = '';
}

function renderModal(m){
  const trailerEmbed = (m.trailer && m.trailer.site && m.trailer.site.toLowerCase() === 'youtube' && m.trailer.id)
    ? `<div class="trailer-wrap"><iframe src="https://www.youtube.com/embed/${encodeURIComponent(m.trailer.id)}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen style="width:100%;height:380px;border-radius:8px"></iframe></div>`
    : '';

  const studios = m.studios?.nodes?.map(s=>escapeHtml(s.name)).join(', ') || '';
  const genres = (m.genres || []).map(g=> `<span class="meta-pill">${escapeHtml(g)}</span>`).join(' ');

  modalBody.innerHTML = `
    <div>
      <div style="display:flex;gap:12px;flex-direction:column">
        <div class="modal-body-grid">
          <div>
            <img src="${m.coverImage.large || m.coverImage.medium}" alt="${escapeHtml(m.title.userPreferred)}">
            <div style="margin-top:8px">
              ${genres}
            </div>
          </div>
          <div>
            <h2 id="modal-title">${escapeHtml(m.title.userPreferred)}</h2>
            <div style="color:var(--muted);margin-bottom:8px">
              ${studios ? `Studios: ${studios} • ` : ''}${m.season ? (m.season + ' ' + (m.seasonYear||'')) : ''} ${m.episodes ? ('• ' + m.episodes + ' eps') : ''}
            </div>
            <div style="color:var(--muted)">${m.averageScore ? 'Score: ' + m.averageScore + ' ★' : ''} ${m.popularity ? ' • Pop: ' + m.popularity : ''}</div>
            <div style="margin-top:10px">${m.description || ''}</div>
            ${trailerEmbed}
          </div>
        </div>
      </div>
    </div>
  `;
}

/* ---------- Anime News (ANN RSS) ---------- */
async function loadNews(){
  newsList.innerHTML = '';
  // skeletons
  for (let i=0;i<3;i++){
    const sk = document.createElement('div');
    sk.className = 'news-item skeleton';
    sk.style.height = '96px';
    newsList.appendChild(sk);
  }
  try {
    // ANN RSS may block CORS. If blocked, use a proxy.
    const res = await fetch(ANN_RSS);
    if (!res.ok) throw new Error('ANN RSS error ' + res.status);
    const text = await res.text();
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const items = Array.from(doc.querySelectorAll('item')).slice(0,12);
    newsList.innerHTML = '';
    items.forEach(it => {
      const title = it.querySelector('title')?.textContent || 'No title';
      const link = it.querySelector('link')?.textContent || '#';
      const desc = it.querySelector('description')?.textContent || '';
      const pub = it.querySelector('pubDate')?.textContent || '';
      const img = (it.querySelector('enclosure')?.getAttribute('url')) || '';
      const node = document.createElement('a');
      node.className = 'news-item';
      node.href = link;
      node.target = '_blank';
      node.rel = 'noopener noreferrer';
      node.innerHTML = `
        ${img ? `<img src="${img}" alt="${escapeHtml(title)}">` : ''}
        <div class="news-body">
          <h3>${escapeHtml(title)}</h3>
          <p class="muted">${escapeHtml(stripHtml(desc)).slice(0,200)}${desc.length>200?'...':''}</p>
          <div style="color:var(--muted);font-size:13px;margin-top:6px">${escapeHtml(pub)}</div>
        </div>
      `;
      newsList.appendChild(node);
    });
  } catch (err) {
    newsList.innerHTML = `<div class="news-item">Error loading news: ${err.message}. Try using a proxy if CORS blocked.</div>`;
    console.error(err);
  }
}

/* ---------- Schedule (SubsPlease) ---------- */
// Strategy:
// - Try to fetch SubsPlease page and parse schedule (fragile & may be blocked by CORS).
// - If fails, show friendly message with manual timezone conversion UI.
// - Allow choosing source timezone (default Asia/Tokyo) and your timezone (detected).

function populateTimezones(){
  const zones = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : ([
    'UTC','Europe/London','Asia/Tokyo','America/New_York','America/Los_Angeles'
  ]);
  zones.forEach(z => {
    const opt1 = document.createElement('option'); opt1.value = z; opt1.textContent = z;
    const opt2 = document.createElement('option'); opt2.value = z; opt2.textContent = z;
    sourceTz.appendChild(opt1);
    targetTz.appendChild(opt2);
  });
  // defaults
  sourceTz.value = 'Asia/Tokyo';
  targetTz.value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

async function loadSchedule(onlyToday = false){
  scheduleContent.innerHTML = '';
  const sk = document.createElement('div');
  sk.className = 'news-item skeleton';
  sk.style.height = '120px';
  scheduleContent.appendChild(sk);

  try {
    // Attempt to fetch schedule HTML and parse. This is best-effort and may fail due to CORS.
    const res = await fetch(SubsPleaseURL);
    if (!res.ok) throw new Error('SubsPlease fetch failed ' + res.status);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // Try common patterns: subsplease often has schedule table (class includes 'schedule')
    let schedule = [];
    // attempt 1: find elements with class 'schedule' or id 'weekly-schedule'
    const scheduleContainers = doc.querySelectorAll('[id*="schedule"], [class*="schedule"], table');
    if (scheduleContainers.length){
      // naive parse: find links with episode titles and time text nearby
      scheduleContainers.forEach(c => {
        const links = c.querySelectorAll('a');
        links.forEach(a => {
          const title = a.textContent?.trim();
          if (!title) return;
          // find sibling text nodes for time or parent node
          const parent = a.parentElement;
          let timeText = '';
          if (parent) {
            timeText = parent.textContent.replace(title, '').trim();
          }
          // push
          schedule.push({title: title, timeRaw: timeText || 'TBA', url: a.href});
        });
      });
    }

    // Fallback: try parsing JSON embedded in page (rare)
    if (!schedule.length){
      // look for scripts that include json schedules
      const scripts = Array.from(doc.querySelectorAll('script')).map(s => s.textContent);
      for (const s of scripts) {
        if (s && s.includes('schedule')) {
          const match = s.match(/schedule\s*[:=]\s*(\[[\s\S]*?\])/);
          if (match) {
            try {
              const arr = JSON.parse(match[1]);
              arr.forEach(it => {
                schedule.push({title: it.title || it.name, timeRaw: it.time || 'TBA', url: it.url || ''});
              });
            } catch(e){}
          }
        }
      }
    }

    scheduleContent.innerHTML = '';
    if (!schedule.length) {
      scheduleContent.innerHTML = `<div class="news-item">Couldn't reliably parse SubsPlease schedule from the site. This is often blocked by CORS or page structure differences. Consider using a proxy or an official API.</div>`;
      return;
    }

    // Optionally filter for today (best-effort)
    const tzFrom = sourceTz.value || 'Asia/Tokyo';
    const tzTo = targetTz.value || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const today = new Date();

    schedule.forEach(it => {
      // Try to extract a time like "2026-01-20 00:30 JST" or "Mon 00:30" etc.
      const parsed = parseTimeGuess(it.timeRaw, tzFrom);
      const displayTime = parsed ? convertToTZString(parsed, tzTo) : (it.timeRaw || 'TBA');
      const el = document.createElement('a');
      el.className = 'news-item';
      el.href = it.url || '#';
      el.target = '_blank';
      el.innerHTML = `
        <div style="flex:1">
          <h3>${escapeHtml(it.title)}</h3>
          <div style="color:var(--muted)">${escapeHtml(it.timeRaw)}</div>
        </div>
        <div style="text-align:right;color:var(--muted)"><div>${escapeHtml(displayTime)}</div><div style="font-size:12px">(${tzTo})</div></div>
      `;
      if (onlyToday && parsed) {
        const sameDay = isSameLocalDay(parsed, today, tzFrom);
        if (sameDay) scheduleContent.appendChild(el);
      } else if (onlyToday && !parsed) {
        // unknown: show
      } else {
        scheduleContent.appendChild(el);
      }
    });

  } catch (err) {
    scheduleContent.innerHTML = `<div class="news-item">Error loading schedule: ${err.message}. Try using a proxy if CORS blocked.</div>`;
    console.error(err);
  }
}

function parseTimeGuess(raw, tz='Asia/Tokyo'){
  // Very naive: find a datetime in ISO-ish format or hh:mm
  if (!raw) return null;
  // ISO-like
  const iso = raw.match(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(:\d{2})?/);
  if (iso) {
    try {
      // attach timezone if missing by using tz offset via Intl
      let ds = iso[0];
      // if no timezone offset, assume tz and build an ISO with offset
      if (!/Z|[+\-]\d{2}:?\d{2}/.test(raw)) {
        // build with assumption: create date from parts using Date constructor in target zone is tricky.
        // Simpler: return a Date parsed as if in UTC then compensate using timezone offsets (approx).
        return new Date(ds);
      } else {
        return new Date(ds);
      }
    } catch(e){}
  }
  // hh:mm pattern
  const hm = raw.match(/(\d{1,2}):(\d{2})/);
  if (hm) {
    const now = new Date();
    // Construct a date in the tz by creating a date string like YYYY-MM-DDTHH:MM:00 and trusting Date to parse (may be local)
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth()+1).padStart(2,'0');
    const dd = String(now.getDate()).padStart(2,'0');
    const ds = `${yyyy}-${mm}-${dd}T${hm[1].padStart(2,'0')}:${hm[2]}:00`;
    return new Date(ds);
  }
  return null;
}
function isSameLocalDay(dateObj, compareDate, timeZone){
  // compare dates by year/month/day using locale in timezone
  const fmt = new Intl.DateTimeFormat('en-US',{timeZone, year:'numeric',month:'2-digit',day:'2-digit'});
  return fmt.format(dateObj) === fmt.format(compareDate);
}
function convertToTZString(dateObj, tz){
  try {
    const fmt = new Intl.DateTimeFormat(undefined, {timeZone: tz, hour:'2-digit', minute:'2-digit', day:'2-digit', month:'short'});
    return fmt.format(dateObj);
  } catch(e){
    return dateObj.toString();
  }
}

/* ---------- utilities ---------- */
function escapeHtml(s){
  if (!s) return '';
  return s.replaceAll?.('&','&amp;').replaceAll?.('<','&lt;').replaceAll?.('>','&gt;') || s;
}
function stripHtml(html){
  const d = new DOMParser().parseFromString(html,'text/html');
  return d.body.textContent || '';
}

/* ---------- wire controls ---------- */
refreshTrendingBtn.addEventListener('click', loadTrending);
trendingSort.addEventListener('change', loadTrending);

refreshNewsBtn.addEventListener('click', loadNews);

todayBtn.addEventListener('click', ()=> loadSchedule(true));
weekBtn.addEventListener('click', ()=> loadSchedule(false));

/* ---------- startup ---------- */
initTelegramUser();
populateTimezones();
loadTrending();
loadNews();
loadSchedule(false);

/* ---------- final notes logged to console ---------- */
console.log('Otaku Syndicate initialized. If you see CORS errors when fetching AniList/ANN/SubsPlease, deploy a small proxy (Cloudflare Worker, Netlify/Vercel function) to forward requests with Access-Control-Allow-Origin: *.');