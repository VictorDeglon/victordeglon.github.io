/**
 * FEROX has moved — the hand-off from the old address to the new one.
 *
 * FEROX used to live at https://victordeglon.github.io/FEROX/ and now lives
 * at https://feroxfitness.web.app. A signed-in athlete's log is in their
 * Google account and follows them; a guest's log is in this browser's
 * localStorage, which belongs to this origin alone, so it has to be handed to
 * the new origin or it is stranded here. This script does that and nothing
 * else. It never deletes the log at this address.
 *
 * The move protocol, v1 (the receiver is /move.html on the new address):
 *   1. On a click, open NEW/move.html in a named window.
 *   2. The receiver says {type:'ferox-move-ready', v:1} to its opener.
 *   3. This page answers {type:'ferox-move', v:1, data, prefs} — data is the
 *      raw 'ferox.v2' string, prefs the stored theme, palette and unit.
 *   4. The receiver imports (or declines) and says
 *      {type:'ferox-move-done', v:1, ok, counts | reason}.
 * Every message is checked for both origin and source window, and every
 * message sent names its target origin.
 *
 * After a successful move this address forwards straight on; '#move' on any
 * bridge URL brings the move card back (see AGAIN below).
 *
 * Everything shown is built with textContent; nothing read from storage or a
 * message ever reaches innerHTML.
 */

/* 127.0.0.1 is the local test bench; nothing else is. */
const DEV = location.hostname === '127.0.0.1';
const NEW = DEV ? 'http://localhost:5190' : 'https://feroxfitness.web.app';
const NEW_HOST = new URL(NEW).host;

const KEY = 'ferox.v2';
const SESSION_KEY = 'ferox.v2.session';
const MOVED_KEY = 'ferox.v2.movedAt';
const PREF_KEYS = { theme: 'ferox.v2.theme', palette: 'ferox.v2.palette', unit: 'ferox.v2.unit' };

/** How long the new address has to say it is ready before the fallback shows. */
const READY_TIMEOUT_MS = 20_000;

/** Every page the app has ever had, so an old bookmark lands on its new twin. */
const PAGES = new Set([
  'index', 'dashboard', 'workouts', 'nutrition', 'progress', 'records', 'medals',
  'seasons', 'friends', 'profile', 'docs', 'onboarding', 'u', '404',
]);

/*
 * '#move' on any bridge URL shows the move card again even after a move.
 * Once moved, this address otherwise forwards on sight, which would leave
 * the copy here (never deleted) out of reach if the new address ever lost it:
 * cleared site data, another browser profile, a regretted "Use the log you
 * brought". It is the bridge's own word, so it is not carried to the new address.
 */
const AGAIN = location.hash === '#move';

/* ------------------------------------------------------------------ target */

/** The same page on the new address, query and hash included (u.html?h=…). */
function targetURL() {
  const last = location.pathname.split('/').pop() || 'index.html';
  const name = last.replace(/\.html$/i, '');
  const path = !PAGES.has(name) || name === 'index' ? '/' : `/${name}.html`;
  return NEW + path + location.search + (AGAIN ? '' : location.hash);
}
const TARGET = targetURL();

/* ----------------------------------------------------------------- storage */

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function parseObject(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}
const countOf = (log, k) => (Array.isArray(log?.[k]) ? log[k].length : 0);

/* ---------------------------------------------------- retire the old app */

/*
 * The old app's service worker served its shell cache-first, so while it is
 * registered it keeps showing the old app instead of this page. sw.js in this
 * folder retires it on the browser's next update check; this is the same job
 * done from the page, for anyone who reaches it first. Only FEROX's own scope
 * and caches: this origin is shared with the rest of victordeglon.github.io.
 */
async function retireOldApp() {
  const scope = location.origin + location.pathname.replace(/[^/]*$/, '');
  const jobs = [];
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) if (r.scope.startsWith(scope)) jobs.push(r.unregister());
    }
  } catch { /* not available here (private mode, insecure context) */ }
  try {
    if ('caches' in self) {
      const keys = await caches.keys();
      for (const k of keys) if (/^ferox/i.test(k)) jobs.push(caches.delete(k));
    }
  } catch { /* same */ }
  await Promise.allSettled(jobs);
}
/** Cleanup is quick, but a redirect must never wait on a hung browser API. */
const retired = Promise.race([retireOldApp(), new Promise(r => setTimeout(r, 1500))]);

/* --------------------------------------------------------------------- DOM */

const $ = id => document.getElementById(id);
const statusEl = $('status');
const actionsEl = $('actions');
const noteEl = $('note');

/** A tiny element builder. Children are nodes or strings (text, never HTML). */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : String(v));
  }
  el.append(...children.flat().filter(c => c != null && c !== false));
  return el;
}
const button = (label, onClick, primary = false) =>
  h('button', { type: 'button', class: primary ? 'btn btn-primary' : 'btn', on: { click: onClick } }, label);
const link = (label, href, cls = 'btn') => h('a', { class: cls, href }, label);

/**
 * Swap what the card says. Focus is kept in the action area when the button
 * that had it is replaced, so a keyboard user is never dropped to <body>.
 */
function render({ tone = '', message = [], actions = [] }) {
  const hadFocus = actionsEl.contains(document.activeElement);
  if (tone) statusEl.dataset.tone = tone; else delete statusEl.dataset.tone;
  statusEl.replaceChildren(...message.filter(Boolean));
  actionsEl.replaceChildren(...actions.filter(Boolean));
  if (hadFocus) actionsEl.querySelector('button, a')?.focus();
}

const nf = new Intl.NumberFormat();
const plural = (n, one, many = `${one}s`) => `${nf.format(n)} ${n === 1 ? one : many}`;
/** "20 sessions, 268 meals and 22 weigh-ins" — the parts that are not zero. */
function inventory({ sessions = 0, meals = 0, weights = 0 }) {
  const parts = [];
  if (sessions > 0) parts.push(plural(sessions, 'session'));
  if (meals > 0) parts.push(plural(meals, 'meal'));
  if (weights > 0) parts.push(plural(weights, 'weigh-in'));
  if (parts.length < 2) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/* ---------------------------------------------------------------- download */

function localDay(d = new Date()) {
  const x = new Date(d);
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 10);
}

/** The log as a file, in the same pretty JSON the app's own export writes. */
function download() {
  const log = parseObject(read(KEY));
  if (!log) {
    noteEl.replaceChildren('There is no log in this browser to download.');
    return;
  }
  const name = `ferox-log-${localDay()}.json`;
  const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  noteEl.replaceChildren(...(signedIn
    // Importing replaces the whole log, and a signed-in athlete's real log is
    // the account's — this browser's copy may be older. Keep, don't import.
    ? ['Saved ', h('span', { class: 'file' }, name), ' — a copy of what this browser held. ',
      'Your account\'s log on ', h('strong', {}, NEW_HOST), ' is the one to keep using; ',
      'importing this file there would replace it.']
    : ['Saved ', h('span', { class: 'file' }, name), '. To bring it in: on ',
      h('strong', {}, NEW_HOST), ', finish the short setup, then open ',
      h('strong', {}, 'Profile → Data → Import'), ' and choose this file.']));
}

/* -------------------------------------------------------------------- move */

/** The one move in flight, if any: its window and how far it has got. */
let attempt = null;

function endAttempt() {
  if (!attempt) return;
  clearTimeout(attempt.timer);
  clearInterval(attempt.poll);
  attempt.over = true;
}

function move() {
  endAttempt();   // a fresh start: the window keeps its name, so it is reused
  // Straight from the click, so the browser counts it as the person's own.
  const w = window.open(`${NEW}/move.html`, 'ferox-move');
  if (!w) {
    attempt = null;
    return showProblem('blocked');
  }
  const mine = attempt = { w, sent: false, done: false, over: false };
  // The fallback shows, but the attempt stays open: a slow "ready" or "done"
  // that arrives afterwards still finishes the move.
  mine.timer = setTimeout(() => { if (!mine.sent && attempt === mine) showProblem('timeout'); }, READY_TIMEOUT_MS);
  // Reading `closed` is allowed across origins; it is the only way to notice
  // the tab was shut before the move finished.
  mine.poll = setInterval(() => {
    if (attempt !== mine || mine.over) return clearInterval(mine.poll);
    let closed = false;
    try { closed = w.closed; } catch { /* treat as open */ }
    if (closed) { endAttempt(); showProblem('closed'); }
  }, 700);
  render({
    message: [h('p', { class: 'headline' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), `Opening ${NEW_HOST}…`),
      h('p', {}, 'A new tab is opening at the new address. Keep this one open until it is done.')],
    actions: [button('Download a copy', download)],
  });
}

function onMessage(event) {
  const mine = attempt;
  if (!mine || event.origin !== NEW || event.source !== mine.w) return;
  const msg = event.data;
  if (!msg || typeof msg !== 'object' || msg.v !== 1) return;

  if (msg.type === 'ferox-move-ready') {
    // A late "ready" (after the timeout) still goes through: the click asked
    // for the move, and the fallback stays one button away either way.
    if (mine.over) return;
    const data = read(KEY);
    if (!parseObject(data)) { endAttempt(); return showProblem('empty'); }
    const prefs = {};
    for (const [k, key] of Object.entries(PREF_KEYS)) prefs[k] = read(key);
    try { mine.w.postMessage({ type: 'ferox-move', v: 1, data, prefs }, NEW); }
    catch { endAttempt(); return showProblem('closed'); }
    mine.sent = true;
    clearTimeout(mine.timer);
    render({
      message: [h('p', { class: 'headline' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), 'Handing your log over…'),
        h('p', {}, 'If the new tab asks you anything, answer it there.')],
      actions: [button('Download a copy', download)],
    });
    return;
  }

  if (msg.type === 'ferox-move-done') {
    if (mine.over) return;
    mine.done = true;
    endAttempt();
    if (msg.ok === true) {
      write(MOVED_KEY, new Date().toISOString());
      return showMoved(msg.counts);
    }
    return showProblem(typeof msg.reason === 'string' ? msg.reason : 'failed');
  }
}
addEventListener('message', onMessage);

/* ------------------------------------------------------------------ states */

function showMoved(counts) {
  const c = counts && typeof counts === 'object' ? counts : {};
  const num = v => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const what = inventory({ sessions: num(c.sessions), meals: num(c.meals), weights: num(c.weights) });
  render({
    tone: 'ok',
    message: [
      h('p', { class: 'headline' }, 'Your log is on the new address — FEROX is open in the other tab.'),
      h('p', {}, what ? [h('strong', {}, what), ' made the trip. '] : '', 'From now on, use ',
        h('strong', {}, NEW_HOST), ' — this old address only sends you there.'),
    ],
    actions: [link('Open FEROX', TARGET, 'btn btn-primary')],
  });
}

const PROBLEMS = {
  blocked: ['Your browser blocked the new tab.',
    'Allow pop-ups for this page and press Move again — or download a copy and import it on the new address.'],
  timeout: [`${NEW_HOST} did not answer.`,
    'It may still be loading in the other tab. Try again, or download a copy and import it there instead.'],
  closed: ['The new tab closed before the move finished.',
    'Nothing was changed on either address. Try again, or download a copy and import it there.'],
  'signed-in': ['You are signed in to a FEROX account on the new address.',
    'Your log was not copied over the account\'s. Sign out there and press Move again — or keep the account\'s log and download this one as a copy.'],
  kept: ['You kept the log that was already on the new address.',
    'Nothing was copied. Changed your mind? Press Move again, or download a copy.'],
  empty: ['There is no log left in this browser to move.', ''],
  // The receiver's own refusal codes worth their own words; the rest get the
  // general sentence with the code alongside.
  'not-saved': ['The new address could not save your log.',
    'Private windows and blocked site data do this. Download a copy, then import it there in a normal window.'],
  'too-large': ['Your log is bigger than a move can carry.',
    'Download a copy and import it on the new address instead.'],
};

function showProblem(reason) {
  const known = Object.prototype.hasOwnProperty.call(PROBLEMS, reason) ? PROBLEMS[reason] : null;
  const [headline, detail] = known ?? [`The new address could not take your log${
    reason && reason !== 'failed' ? ` (${String(reason).slice(0, 80)})` : ''}.`,
  'Nothing here was changed. Try again, or download a copy and import it there instead.'];
  render({
    tone: reason === 'kept' ? '' : 'bad',   // keeping their log was a choice, not a failure
    message: [h('p', { class: 'headline' }, headline), detail ? h('p', {}, detail) : null],
    actions: reason === 'empty' ? [link('Go to FEROX', TARGET, 'btn btn-primary')] : [
      button('Move my log', move, true),
      button('Download a copy', download),
      link('Skip — go to the new address', TARGET, 'quiet'),
    ],
  });
}

/** A stored ISO stamp as a date in the reader's locale, or null if it is not one. */
function dayOf(iso) {
  const d = new Date(iso ?? NaN);
  return Number.isNaN(d.getTime()) ? null
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

/** `movedAt` is set only when '#move' brought the card back after a move. */
function showGuest(log, movedAt = null) {
  const what = inventory({ sessions: countOf(log, 'sessions'), meals: countOf(log, 'meals'), weights: countOf(log, 'weights') });
  const has = movedAt ? 'still has' : 'has';
  const when = movedAt ? dayOf(movedAt) : null;
  render({
    message: [
      h('p', { class: 'headline' }, what
        ? [`This browser ${has} `, h('strong', {}, what), ' saved at the old address.']
        : `This browser ${has} your FEROX profile saved at the old address.`),
      h('p', {}, 'Move it and carry on where you left off. It opens the new address in a new tab and copies your log there.'),
    ],
    actions: [
      button('Move my log', move, true),
      button('Download a copy', download),
      link('Skip — go to the new address', TARGET, 'quiet'),
    ],
  });
  noteEl.replaceChildren(...(movedAt
    ? [`You moved it once already${when ? `, on ${when}` : ''}. If the new address has a log now, it asks before replacing it. `]
    : []), 'Nothing is deleted from this browser — moving only copies.');
}

function showSignedIn() {
  render({
    message: [
      h('p', { class: 'headline' }, 'Your log is in your Google account.'),
      h('p', {}, 'Sign in again on ', h('strong', {}, NEW_HOST), ' with the same account and everything is there.'),
    ],
    actions: [
      link('Go to FEROX', TARGET, 'btn btn-primary'),
      button('Download a copy', download),
    ],
  });
}

/* -------------------------------------------------------------------- boot */

// The plain fallback link (shown only if this script fails) goes to the twin page too.
$('go')?.setAttribute('href', TARGET);

const theme = read(PREF_KEYS.theme);
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;

const log = parseObject(read(KEY));
const hasLog = Boolean(log) && (Boolean(log.onboarded)
  || ['sessions', 'meals', 'weights', 'checkIns'].some(k => countOf(log, k) > 0));
const session = parseObject(read(SESSION_KEY));
const signedIn = Boolean(session?.verified && session.user && session.user.provider !== 'guest');

const movedAt = read(MOVED_KEY);

if (!hasLog || (movedAt && !AGAIN)) {
  document.documentElement.dataset.state = 'redirect';
  retired.then(() => location.replace(TARGET));
} else {
  document.documentElement.dataset.state = signedIn ? 'signed-in' : 'guest';
  if (signedIn) showSignedIn(); else showGuest(log, movedAt);
}
