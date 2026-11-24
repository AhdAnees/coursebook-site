// Liyaa Note in the browser: sign in, courses, the class Library and chat.
// Talks to the same Supabase project as the phone app; row-level security decides what each person can see.
// Everything a user typed is put on the page as text (textContent), never as HTML.
(function () {
  'use strict';

  var cfg = window.COURSEBOOK_SUPABASE;
  var sb = window.supabase.createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  var root = document.getElementById('app');

  var CHAT_BUCKET = 'chat';
  var PAGE = 50;
  var IMAGE_MAX = 1600;
  var MAX_CHAT_FILE = 10 * 1024 * 1024; // the chat bucket's limit
  var RULES = [
    ['Be yourself', 'Use your real name. Do not pretend to be someone else — a leader, an official, a trainer or a classmate.'],
    ['Be respectful', 'No bullying, harassment, threats or hate towards anyone, inside or outside the course.'],
    ['Keep it about learning', 'Share notes, files and memories that belong to the course. No spam, scams or advertising.'],
    ['Respect privacy', 'Only share photos of people who are happy to be shared, and never share someone’s private details.'],
    ['Nothing illegal or harmful', 'Do not post content that breaks the law, mocks people to hurt them, or is sexual or violent.'],
    ['Report problems', 'If something is wrong, use Report. The course owner and Liyaa Note can remove content and accounts.'],
  ];

  var state = { session: null, user: null, account: null, channel: null, pendingCode: null, recovery: false };
  var WEB_RETURN = location.origin + location.pathname;

  // Arriving from a link in an email: Supabase puts the result in the address (#access_token=… or #error=…).
  var landing = (function () {
    var p = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (!p.get('access_token') && !p.get('error') && !p.get('error_description')) return null;
    return { type: p.get('type') || '', error: p.get('error_description') || p.get('error') || '', code: p.get('error_code') || '' };
  })();
  function cleanAddress() { history.replaceState(null, '', location.pathname + '#/'); }

  // ---------- Small helpers ----------

  /** h('a', { href: '#' , onclick: fn }, 'text', child…) — strings become text nodes. */
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(function (x) { add(el, x); });
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  function show() { root.replaceChildren.apply(root, arguments); window.scrollTo(0, 0); }
  function toast(msg) {
    var t = h('div', { class: 'toast', role: 'status' }, msg);
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }
  function fail(error) { if (error) throw new Error(friendly(error.message || String(error))); }
  function friendly(m) {
    if (/Invalid login credentials/i.test(m)) return 'That email and password don’t match. Check them and try again.';
    if (/Email not confirmed/i.test(m)) return 'Confirm your email first: enter the code we sent you.';
    if (/invalid invite code/i.test(m)) return 'That invite code doesn’t match any course.';
    if (/expired|invalid.*otp|token/i.test(m)) return 'That code is wrong or has expired. Ask for a new one.';
    if (/rate limit|too many/i.test(m)) return 'Too many tries. Wait a minute and try again.';
    if (/Failed to fetch|NetworkError/i.test(m)) return 'Can’t reach Liyaa Note. Check your internet connection.';
    return m;
  }
  function busy(btn, on, label) { btn.disabled = on; if (label) btn.textContent = on ? label[1] : label[0]; }
  function errorBox() { return h('p', { class: 'error', role: 'alert', hidden: true }); }
  function setError(box, e) { box.textContent = e ? (e.message || String(e)) : ''; box.hidden = !e; }
  function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
  function fmtTime(iso) { return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
  function dayLabel(iso) {
    var d = new Date(iso), today = new Date(), y = new Date(); y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }
  function safeUrl(u) { try { var x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch (e) { return null; } }
  function safeName(n) { return (n || 'file').replace(/[\\/:*?"<>|#%]+/g, '_').slice(-120); }
  function uuid() { return crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }); }
  function initials(name) { return (name || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase(); }
  function stopChannel() { if (state.channel) { sb.removeChannel(state.channel); state.channel = null; } }
  async function signedUrls(paths) {
    var out = new Map();
    if (!paths.length) return out;
    var r = await sb.storage.from(CHAT_BUCKET).createSignedUrls(paths, 3600);
    (r.data || []).forEach(function (d) { if (d.path && d.signedUrl) out.set(d.path, d.signedUrl); });
    return out;
  }
  function topBar(backHref) {
    var name = (state.user && state.user.user_metadata && state.user.user_metadata.display_name) || (state.user && state.user.email) || '';
    return h('header', { class: 'bar' },
      backHref ? h('a', { class: 'back', href: backHref, 'aria-label': 'Back' }, '←') : null,
      h('a', { class: 'brand', href: '#/' }, h('img', { src: '../img/icon.png', alt: '' }), 'Liyaa Note'),
      h('span', { class: 'grow' }),
      h('span', { class: 'who' }, name),
      h('button', { class: 'btn plain small', type: 'button', onclick: async function () { stopChannel(); forgetNotesKey(); await sb.auth.signOut(); location.hash = '#/'; } }, 'Sign out'));
  }

  // ---------- Signing in ----------

  function authShell(title, sub, body) {
    return h('main', { class: 'page narrow' },
      h('div', { class: 'auth-head' }, h('img', { src: '../img/icon.png', alt: '' })),
      h('div', { class: 'card' }, h('h1', null, title), sub ? h('p', { class: 'sub' }, sub) : null, body));
  }

  function viewSignIn(prefill) {
    var email = h('input', { type: 'email', autocomplete: 'email', required: true, value: prefill || '' });
    var pass = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    var err = errorBox();
    var btn = h('button', { class: 'btn block', type: 'submit' }, 'Sign in');
    var form = h('form', { onsubmit: async function (e) {
      e.preventDefault(); setError(err, null); busy(btn, true, ['Sign in', 'Signing in…']);
      try { var r = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value }); fail(r.error); }
      catch (x) { setError(err, x); busy(btn, false, ['Sign in', '']); }
    } },
      h('label', { class: 'field' }, h('span', null, 'Email'), email),
      h('label', { class: 'field' }, h('span', null, 'Password'), pass),
      btn, err,
      h('p', { class: 'switch' }, h('a', { href: '#', onclick: function (e) { e.preventDefault(); viewReset(email.value); } }, 'Forgot your password?')),
      h('p', { class: 'switch' }, 'New to Liyaa Note? ', h('a', { href: '#', onclick: function (e) { e.preventDefault(); viewSignUp(email.value); } }, 'Create an account')));
    show(authShell('Sign in', 'Use the same email and password as in the app.', form));
    email.value ? pass.focus() : email.focus();
  }

  function viewSignUp(prefill) {
    var name = h('input', { type: 'text', autocomplete: 'name', required: true, maxlength: '60' });
    var email = h('input', { type: 'email', autocomplete: 'email', required: true, value: prefill || '' });
    var pass = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8' });
    var agree = h('input', { type: 'checkbox', required: true });
    var err = errorBox();
    var btn = h('button', { class: 'btn block', type: 'submit' }, 'Create account');
    var form = h('form', { onsubmit: async function (e) {
      e.preventDefault(); setError(err, null);
      if (pass.value.length < 8) return setError(err, new Error('Use at least 8 characters for your password.'));
      busy(btn, true, ['Create account', 'Creating…']);
      try {
        var reserved = await sb.rpc('name_is_reserved', { p_name: name.value.trim() });
        if (reserved.data === true) throw new Error('Please use your own name, not a title like President or Admin.');
        var r = await sb.auth.signUp({ email: email.value.trim(), password: pass.value, options: {
          data: { display_name: name.value.trim(), full_name: '', phone: '', rules_accepted: 'true' },
          emailRedirectTo: WEB_RETURN,
        } });
        fail(r.error);
        if (r.data.user && !r.data.session && r.data.user.identities && r.data.user.identities.length === 0) throw new Error('There is already an account with this email. Sign in instead.');
        if (!r.data.session) viewVerify(email.value.trim());
      } catch (x) { setError(err, x); busy(btn, false, ['Create account', '']); }
    } },
      h('label', { class: 'field' }, h('span', null, 'Your name (as classmates know you)'), name),
      h('label', { class: 'field' }, h('span', null, 'Email'), email),
      h('label', { class: 'field' }, h('span', null, 'Password (8 or more characters)'), pass),
      h('ul', { class: 'rules' }, RULES.map(function (r) { return h('li', null, h('b', null, r[0] + ': '), r[1]); })),
      h('label', { class: 'check' }, agree, h('span', null, 'I agree to the community rules above.')),
      btn, err,
      h('p', { class: 'switch' }, 'Already have an account? ', h('a', { href: '#', onclick: function (e) { e.preventDefault(); viewSignIn(email.value); } }, 'Sign in')));
    show(authShell('Create your account', 'One account works in the app and here.', form));
    name.focus();
  }

  function viewVerify(email) {
    var code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', required: true, maxlength: '10' });
    var err = errorBox();
    var btn = h('button', { class: 'btn block', type: 'submit' }, 'Confirm');
    var form = h('form', { onsubmit: async function (e) {
      e.preventDefault(); setError(err, null); busy(btn, true, ['Confirm', 'Checking…']);
      try { var r = await sb.auth.verifyOtp({ email: email, token: code.value.trim(), type: 'signup' }); fail(r.error); }
      catch (x) { setError(err, x); busy(btn, false, ['Confirm', '']); }
    } },
      h('label', { class: 'field' }, h('span', null, 'Code from the email'), code), btn, err,
      h('p', { class: 'switch' }, 'No email? Check spam, or ', h('a', { href: '#', onclick: async function (e) {
        e.preventDefault();
        var r = await sb.auth.resend({ type: 'signup', email: email, options: { emailRedirectTo: WEB_RETURN } });
        r.error ? setError(err, new Error(friendly(r.error.message))) : toast('We sent a new code.');
      } }, 'send a new code'), '.'));
    form.appendChild(h('div', { class: 'rules', style: 'margin-top:16px' },
      h('b', null, 'Email has a link instead of a code? '),
      'Tap the link: it confirms your account. Then come back here and sign in.'));
    form.appendChild(h('button', { class: 'btn soft block', type: 'button', onclick: function () { viewSignIn(email); } }, 'I tapped the link: sign in'));
    show(authShell('Check your email', 'We sent a code to ' + email + '.', form));
    code.focus();
  }

  function viewReset(prefill) {
    var email = h('input', { type: 'email', autocomplete: 'email', required: true, value: prefill || '' });
    var err = errorBox();
    var btn = h('button', { class: 'btn block', type: 'submit' }, 'Send me a code');
    var form = h('form', { onsubmit: async function (e) {
      e.preventDefault(); setError(err, null); busy(btn, true, ['Send me a code', 'Sending…']);
      try { var r = await sb.auth.resetPasswordForEmail(email.value.trim(), { redirectTo: WEB_RETURN }); fail(r.error); viewResetCode(email.value.trim()); }
      catch (x) { setError(err, x); busy(btn, false, ['Send me a code', '']); }
    } }, h('label', { class: 'field' }, h('span', null, 'Email'), email), btn, err,
      h('p', { class: 'switch' }, h('a', { href: '#', onclick: function (e) { e.preventDefault(); viewSignIn(email.value); } }, 'Back to sign in')));
    show(authShell('Reset your password', 'We’ll email you a code.', form));
    email.focus();
  }

  function viewResetCode(email) {
    var code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', required: true });
    var pass = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8' });
    var err = errorBox();
    var btn = h('button', { class: 'btn block', type: 'submit' }, 'Save new password');
    var form = h('form', { onsubmit: async function (e) {
      e.preventDefault(); setError(err, null);
      if (pass.value.length < 8) return setError(err, new Error('Use at least 8 characters for your password.'));
      busy(btn, true, ['Save new password', 'Saving…']);
      try {
        var r = await sb.auth.verifyOtp({ email: email, token: code.value.trim(), type: 'recovery' }); fail(r.error);
        var u = await sb.auth.updateUser({ password: pass.value });
        if (u.error) { await sb.auth.signOut(); fail(u.error); }
        toast('Password changed.');
      } catch (x) { setError(err, x); busy(btn, false, ['Save new password', '']); }
    } },
      h('label', { class: 'field' }, h('span', null, 'Code from the email'), code),
      h('label', { class: 'field' }, h('span', null, 'New password (8 or more characters)'), pass), btn, err);
    show(authShell('Enter the code', 'We sent it to ' + email + '.', form));
    code.focus();
  }

  function viewNewPassword() {
    var pass = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8' });
    var err = errorBox();
    var btn = h('button', { class: 'btn block', type: 'submit' }, 'Save new password');
    var form = h('form', { onsubmit: async function (e) {
      e.preventDefault(); setError(err, null);
      if (pass.value.length < 8) return setError(err, new Error('Use at least 8 characters for your password.'));
      busy(btn, true, ['Save new password', 'Saving…']);
      try { var u = await sb.auth.updateUser({ password: pass.value }); fail(u.error); state.recovery = false; toast('Password changed.'); route(); }
      catch (x) { setError(err, x); busy(btn, false, ['Save new password', '']); }
    } }, h('label', { class: 'field' }, h('span', null, 'New password (8 or more characters)'), pass), btn, err);
    show(authShell('Choose a new password', null, form));
    pass.focus();
  }

  // ---------- Account checks ----------

  async function loadAccount() {
    var r = await sb.rpc('my_account');
    fail(r.error);
    var a = (r.data || [])[0] || {};
    state.account = { banned: !!a.banned, banReason: a.ban_reason || '', rulesAccepted: !!a.rules_accepted };
  }

  function viewBanned() {
    show(topBar(), h('main', { class: 'page narrow' }, h('div', { class: 'card' },
      h('h1', null, 'Your account is suspended'),
      h('p', { class: 'sub' }, state.account.banReason || 'It broke the community rules.'),
      h('p', null, 'If you think this is a mistake, write to ', h('a', { href: 'mailto:support@liyaanote.app' }, 'support@liyaanote.app'), '.'))));
  }

  function viewRules() {
    var err = errorBox();
    var btn = h('button', { class: 'btn block', type: 'button', onclick: async function () {
      busy(btn, true, ['I agree', 'Saving…']);
      try {
        var r = await sb.from('profiles').update({ rules_accepted_at: new Date().toISOString() }).eq('id', state.user.id); fail(r.error);
        state.account.rulesAccepted = true; route();
      } catch (x) { setError(err, x); busy(btn, false, ['I agree', '']); }
    } }, 'I agree');
    show(topBar(), h('main', { class: 'page narrow' }, h('div', { class: 'card' },
      h('h1', null, 'Community rules'), h('p', { class: 'sub' }, 'Everyone in Liyaa Note agrees to these.'),
      h('ul', { class: 'rules' }, RULES.map(function (r) { return h('li', null, h('b', null, r[0] + ': '), r[1]); })), btn, err)));
  }

  // ---------- My courses ----------

  var TYPE = { course: 'Course', session: 'Session', workshop: 'Workshop', program: 'Program', class: 'Class' };

  async function myCourses() {
    var r = await sb.from('course_members').select('role, courses(*)').eq('user_id', state.user.id);
    fail(r.error);
    return (r.data || []).filter(function (m) { return m.courses; }).map(function (m) { var c = m.courses; c.role = m.role; return c; })
      .sort(function (a, b) { return (b.start_date || '').localeCompare(a.start_date || ''); });
  }

  async function viewCourses() {
    show(topBar(), h('main', { class: 'page' }, h('p', { class: 'note-line' }, 'Loading your courses…')));
    var courses, requests = [], canCreate = false;
    try {
      courses = await myCourses();
      var jr = await sb.rpc('my_join_requests'); if (!jr.error) requests = (jr.data || []).filter(function (q) { return q.status === 'pending'; });
      var cc = await sb.rpc('can_create_courses'); canCreate = !cc.error && cc.data === true;
    } catch (x) { return show(topBar(), h('main', { class: 'page' }, h('p', { class: 'error' }, x.message))); }

    var code = h('input', { type: 'text', placeholder: 'Invite code', autocomplete: 'off', maxlength: '8', 'aria-label': 'Invite code', value: state.pendingCode || '' });
    state.pendingCode = null;
    var err = errorBox();
    var jbtn = h('button', { class: 'btn', type: 'submit' }, 'Join');
    var join = h('form', { class: 'join', onsubmit: async function (e) {
      e.preventDefault(); setError(err, null);
      var c = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (c.length !== 8) return setError(err, new Error('Invite codes have 8 letters and numbers.'));
      busy(jbtn, true, ['Join', 'Joining…']);
      try {
        var r = await sb.rpc('request_join', { p_code: c }); fail(r.error);
        var row = (r.data || [])[0];
        if (row && row.status === 'member') { location.hash = '#/c/' + row.course_id; return; }
        toast('Request sent. You’ll get in when the course owner approves you.'); viewCourses();
      } catch (x) { setError(err, x); busy(jbtn, false, ['Join', '']); }
    } }, code, jbtn);

    // Search your courses (title, place or kind), like the app.
    function courseCard(c) {
      return h('a', { class: 'course', href: '#/c/' + c.id, style: '--c:' + (/^#[0-9a-f]{3,8}$/i.test(c.color || '') ? c.color : '') },
        h('div', { class: 'stripe' }),
        h('div', { class: 'in' },
          h('div', null, h('span', { class: 'pill' }, TYPE[c.type] || 'Course'), c.role === 'owner' ? h('span', { class: 'pill' }, 'Owner') : null),
          h('h3', null, c.title),
          h('p', null, [c.location, [fmtDate(c.start_date), c.end_date ? fmtDate(c.end_date) : ''].filter(Boolean).join(' – ')].filter(Boolean).join(' · '))));
    }
    var courseGrid = h('div', { class: 'courses' });
    var courseSearch = h('input', { type: 'search', class: 'page-search', placeholder: 'Search your courses', 'aria-label': 'Search your courses' });
    function drawCourses() {
      var q = courseSearch.value.trim().toLowerCase();
      var shown = courses.filter(function (c) { return !q || [c.title, c.location, TYPE[c.type] || ''].some(function (x) { return String(x || '').toLowerCase().indexOf(q) >= 0; }); });
      courseGrid.replaceChildren.apply(courseGrid, shown.length ? shown.map(courseCard) : [h('p', { class: 'empty' }, 'No course matches that search.')]);
    }
    courseSearch.addEventListener('input', drawCourses);
    drawCourses();

    show(topBar(), h('main', { class: 'page' },
      h('h1', null, 'My courses'),
      h('p', { class: 'sub' }, 'Open a course to see your notebook, the class Library and chat.'),
      courses.length > 1 ? courseSearch : null,
      courses.length ? courseGrid : null,
      courses.length ? null : h('div', { class: 'card empty' }, h('p', null, 'You’re not in any course yet. Join one with the invite code from your trainer.')),
      requests.length ? h('p', { class: 'note-line' }, 'Waiting for approval: ', requests.map(function (q) { return q.title; }).join(', ')) : null,
      h('div', { class: 'card', style: 'margin-top:20px' }, h('h2', null, 'Join a course'), join, err),
      canCreate
        ? h('div', { class: 'card', style: 'margin-top:20px' }, h('h2', null, 'Run a course'), h('p', { class: 'sub', style: 'margin-bottom:14px' }, 'Create a course, then share its invite link with your class.'),
            h('button', { class: 'btn', type: 'button', onclick: createCourseForm }, '＋ Create a course'))
        : h('p', { class: 'note-line', style: 'margin-top:20px' }, 'Want to run a course? Write to ', h('a', { href: 'mailto:support@liyaanote.app?subject=Start%20a%20course%20on%20Liyaa%20Note' }, 'support@liyaanote.app'), ' and we’ll switch on course creation for your account.')));
  }

  var ACCENTS = ['#4F6DF5', '#7C5CFA', '#E5484D', '#F2994A', '#30A46C', '#12A4B6', '#D6409F', '#64748B'];
  function isoDay(d) { return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }

  function createCourseForm() {
    var start = new Date(), end = new Date(); end.setDate(end.getDate() + 7);
    formDialog({
      title: 'Create a course', submit: 'Create course',
      fields: [
        { key: 'type', label: 'Kind', options: [['course', 'Course'], ['workshop', 'Workshop'], ['session', 'Session'], ['program', 'Program']] },
        { key: 'title', label: 'Title', placeholder: 'e.g. Inspector Course 8', required: true, max: '120' },
        { key: 'location', label: 'Location', placeholder: 'City, venue or Online', max: '120' },
        { key: 'start', label: 'Start date', type: 'date', value: isoDay(start), required: true },
        { key: 'end', label: 'End date', type: 'date', value: isoDay(end), required: true },
        { key: 'details', label: 'Details (optional)', placeholder: 'What is it about, schedule, what to bring…', multiline: true, max: '2000' },
      ],
      onSubmit: async function (v) {
        if (v.end < v.start) throw new Error('The end date must be on or after the start date.');
        var r = await sb.rpc('create_course', { p_type: v.type, p_title: v.title, p_location: v.location, p_start_date: v.start, p_end_date: v.end, p_details: v.details, p_color: ACCENTS[Math.floor(Math.random() * ACCENTS.length)], p_sample: false });
        fail(r.error);
        courseCache = { id: null, ctx: null };
        toast('Course created. Share its invite link from “Invite & members”.');
        location.hash = '#/c/' + r.data.id + '/notebook';
      },
    });
  }

  // ---------- A course: header and tabs ----------

  async function loadCourse(id) {
    var c = await sb.from('courses').select('*').eq('id', id).maybeSingle(); fail(c.error);
    if (!c.data) throw new Error('This course isn’t available. You may not be a member.');
    var m = await sb.from('course_members').select('user_id, display_name, role').eq('course_id', id); fail(m.error);
    var names = new Map((m.data || []).map(function (x) { return [x.user_id, x.display_name || 'Member']; }));
    var isOwner = (m.data || []).some(function (x) { return x.user_id === state.user.id && x.role === 'owner'; });
    return { course: c.data, names: names, isOwner: isOwner };
  }

  function courseFrame(ctx, tab, body) {
    var c = ctx.course;
    return [topBar('#/'),
      h('div', { class: 'course-head' }, ctx.isOwner ? h('button', { class: 'btn soft small owner-btn', type: 'button', onclick: function () { ownerPanel(ctx); } }, 'Invite & members') : null, h('h1', null, c.title),
        h('p', null, [c.location, fmtDate(c.start_date) + (c.end_date ? ' – ' + fmtDate(c.end_date) : ''), ctx.names.size + ' members'].filter(Boolean).join(' · '))),
      h('nav', { class: 'tabs', 'aria-label': 'Course' },
        h('a', { href: '#/c/' + c.id + '/notebook', 'aria-current': tab === 'notebook' ? 'page' : null }, 'Notebook'),
        h('a', { href: '#/c/' + c.id + '/library', 'aria-current': tab === 'library' ? 'page' : null }, 'Library'),
        h('a', { href: '#/c/' + c.id + '/chat', 'aria-current': tab === 'chat' ? 'page' : null }, 'Chat')),
      h('div', { class: 'tab-body' }, body)];
  }

  // ---------- Owner: invite link, approvals, join requests ----------

  function inviteLink(c) { return 'https://liyaanote.app/join.html?code=' + encodeURIComponent(c.invite_code) + '&course=' + encodeURIComponent(c.title); }

  async function ownerPanel(ctx) {
    var c = ctx.course, link = inviteLink(c);
    var reqBox = h('div', null, h('p', { class: 'note-line' }, 'Loading join requests…'));
    var approve = h('input', { type: 'checkbox' }); approve.checked = !!c.require_approval;
    approve.addEventListener('change', async function () {
      var r = await sb.from('courses').update({ require_approval: approve.checked }).eq('id', c.id);
      if (r.error) { approve.checked = !approve.checked; return toast(friendly(r.error.message)); }
      c.require_approval = approve.checked; toast(approve.checked ? 'New members now wait for your approval.' : 'People with the code now join straight away.');
    });
    var copyBtn = h('button', { class: 'btn small', type: 'button', onclick: async function () {
      try { await navigator.clipboard.writeText(link); copyBtn.textContent = 'Copied'; setTimeout(function () { copyBtn.textContent = 'Copy link'; }, 1600); }
      catch (e) { prompt('Copy this invite link:', link); }
    } }, 'Copy link');
    var shareBtn = navigator.share ? h('button', { class: 'btn soft small', type: 'button', onclick: function () {
      navigator.share({ title: 'Join ' + c.title + ' on Liyaa Note', text: 'Join ' + c.title + ' on Liyaa Note. Your invite code is ' + c.invite_code + '.', url: link }).catch(function () {});
    } }, 'Share…') : null;
    var d = h('dialog', { 'aria-label': 'Invite and members' },
      h('div', { class: 'dh' }, h('span', null, 'Invite & members'), h('button', { class: 'btn plain small', type: 'button', onclick: function () { d.close(); } }, 'Close')),
      h('div', { class: 'db', style: 'white-space:normal' },
        h('h2', null, 'Invite your class'),
        h('p', { class: 'note-line', style: 'margin-top:0' }, 'Send this link on WhatsApp or by email. It walks each person through installing the app (or using it in the browser) and joining.'),
        h('div', { class: 'invite-code', 'aria-label': 'Invite code' }, c.invite_code),
        h('div', { class: 'nb-actions', style: 'margin:0 0 6px' }, copyBtn, shareBtn),
        h('p', { class: 'note-line', style: 'overflow-wrap:anywhere' }, link),
        h('label', { class: 'check', style: 'margin-top:14px' }, approve, h('span', null, h('b', null, 'Approve new members'), ' — people with the link wait until you let them in.')),
        h('h2', { style: 'margin-top:18px' }, 'Join requests'), reqBox,
        h('p', { class: 'note-line' }, ctx.names.size + ' member(s). Remove members or end the course in the phone app.')));
    d.addEventListener('close', function () { d.remove(); if (d.dataset.changed) { courseCache = { id: null, ctx: null }; route(); } });
    document.body.appendChild(d); d.showModal();

    async function drawRequests() {
      var r = await sb.rpc('course_join_requests', { p_course_id: c.id });
      if (r.error) return reqBox.replaceChildren(h('p', { class: 'error' }, friendly(r.error.message)));
      var list = r.data || [];
      if (!list.length) return reqBox.replaceChildren(h('p', { class: 'note-line' }, 'No one is waiting.'));
      reqBox.replaceChildren.apply(reqBox, list.map(function (q) {
        var row = h('div', { class: 'req' },
          h('span', { class: 'av' }, initials(q.display_name)),
          h('div', { class: 'grow' }, h('b', null, q.display_name || 'Member'),
            h('span', { class: 'm' }, [q.full_name && q.full_name !== q.display_name ? q.full_name : '', q.email, q.phone].filter(Boolean).join(' · ')),
            h('span', { class: 'm' }, 'Asked ' + fmtDate(q.requested_at))),
          h('button', { class: 'btn small', type: 'button', onclick: function () { answer(true); } }, 'Approve'),
          h('button', { class: 'btn plain small', type: 'button', onclick: function () { answer(false); } }, 'Decline'));
        async function answer(yes) {
          row.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
          var a = await sb.rpc('answer_join_request', { p_course_id: c.id, p_user_id: q.user_id, p_approve: yes });
          if (a.error) { toast(friendly(a.error.message)); row.querySelectorAll('button').forEach(function (b) { b.disabled = false; }); return; }
          d.dataset.changed = '1'; toast(yes ? (q.display_name || 'They') + ' can now open the course.' : 'Request declined.'); drawRequests();
        }
        return row;
      }));
    }
    drawRequests();
  }

  // ---------- Library ----------

  var MAT_ICON = { document: '📄', video: '🎬', link: '🔗', note: '📝', image: '🖼️', audio: '🎧' };

  async function viewLibrary(ctx) {
    var panel = h('section', { class: 'panel' }, h('p', { class: 'empty' }, 'Loading the Library…'));
    show.apply(null, courseFrame(ctx, 'library', panel));
    var r = await sb.from('library_items').select('*').eq('course_id', ctx.course.id).order('created_at', { ascending: false });
    if (r.error) { panel.replaceChildren(h('p', { class: 'empty error' }, friendly(r.error.message))); return; }
    var items = r.data || [];
    var search = h('input', { type: 'search', placeholder: 'Search name, subject, topic or tag', 'aria-label': 'Search the Library' });
    var list = h('div');
    function draw() {
      var q = search.value.trim().toLowerCase();
      var shown = items.filter(function (i) {
        return !q || [i.title, i.section, i.topic, i.description, i.file_name || ''].concat(i.tags || []).some(function (s) { return (s || '').toLowerCase().indexOf(q) >= 0; });
      });
      if (!shown.length) return list.replaceChildren(h('p', { class: 'empty' }, items.length ? 'Nothing matches that search.' : 'The Library is empty. Slides, handouts and links your trainer adds will appear here.'));
      var groups = new Map();
      shown.forEach(function (i) { var s = i.section || 'General'; if (!groups.has(s)) groups.set(s, []); groups.get(s).push(i); });
      list.replaceChildren.apply(list, Array.from(groups.entries()).map(function (g) {
        return h('div', { class: 'section' }, h('h2', null, g[0]), g[1].map(function (i) {
          return h('button', { class: 'item', type: 'button', onclick: function () { openItem(i); } },
            h('span', { class: 'ico', 'aria-hidden': 'true' }, MAT_ICON[i.material] || '📄'),
            h('span', null,
              h('span', { class: 't' }, i.title || i.file_name || 'Untitled'),
              h('span', { class: 'm' }, [i.topic, 'Added by ' + (i.added_by_name || 'a member'), fmtDate(i.created_at)].filter(Boolean).join(' · ')),
              i.description ? h('span', { class: 'm' }, i.description) : null,
              (i.tags || []).length ? h('span', { class: 'tags' }, i.tags.map(function (t) { return h('span', { class: 'pill' }, '#' + t); })) : null));
        }));
      }));
    }
    search.addEventListener('input', draw);
    panel.replaceChildren(h('div', { class: 'lib-tools' }, search), list);
    draw();
  }

  async function openItem(i) {
    try {
      if (i.kind === 'link') { var u = safeUrl(i.url); if (!u) throw new Error('This link can’t be opened.'); window.open(u, '_blank', 'noopener'); return; }
      if (i.kind === 'note') return noteDialog(i.title || 'Note', i.note_body || '');
      var s = await sb.storage.from(CHAT_BUCKET).createSignedUrl(i.file_path, 3600); fail(s.error);
      if ((i.mime_type || '').indexOf('image/') === 0) return photoDialog(s.data.signedUrl, i.title);
      window.open(s.data.signedUrl, '_blank', 'noopener');
    } catch (x) { toast(x.message); }
  }

  function noteDialog(title, body) {
    var d = h('dialog', { 'aria-label': title },
      h('div', { class: 'dh' }, h('span', null, title), h('button', { class: 'btn plain small', type: 'button', onclick: function () { d.close(); } }, 'Close')),
      h('div', { class: 'db' }, body));
    d.addEventListener('close', function () { d.remove(); });
    document.body.appendChild(d); d.showModal();
  }
  function photoDialog(url, alt) {
    var d = h('dialog', { class: 'photo', 'aria-label': alt || 'Photo', onclick: function () { d.close(); } }, h('img', { src: url, alt: alt || '' }));
    d.addEventListener('close', function () { d.remove(); });
    document.body.appendChild(d); d.showModal();
  }

  // ---------- Chat ----------

  async function listRooms(courseId, names) {
    var res = await Promise.all([
      sb.from('chat_rooms').select('id, kind, name, created_at').eq('course_id', courseId),
      sb.from('chat_room_members').select('room_id, user_id').eq('course_id', courseId),
      sb.rpc('chat_overview', { p_course_id: courseId }),
    ]);
    res.forEach(function (x) { fail(x.error); });
    var members = new Map();
    (res[1].data || []).forEach(function (m) { members.set(m.room_id, (members.get(m.room_id) || []).concat(m.user_id)); });
    var stats = new Map();
    (res[2].data || []).forEach(function (o) { stats.set(o.room_id, o); });
    var me = state.user.id;
    function sum(id, kind, name) { var o = stats.get(id) || {}; return { id: id, kind: kind, name: name, lastText: o.last_text, lastKind: o.last_kind, lastSender: o.last_sender, lastAt: o.last_at, unread: o.unread || 0, isMember: id === null || stats.has(id) || (members.get(id) || []).indexOf(me) >= 0 }; }
    var others = (res[0].data || []).map(function (r) {
      if (r.kind === 'group') return sum(r.id, 'group', r.name);
      var other = (members.get(r.id) || []).filter(function (u) { return u !== me; })[0];
      return sum(r.id, 'direct', (other && names.get(other)) || 'Member');
    }).filter(function (r) { return r.isMember; });
    others.sort(function (a, b) { return (b.lastAt || '').localeCompare(a.lastAt || '') || a.name.localeCompare(b.name); });
    return [sum(null, 'everyone', 'Everyone')].concat(others);
  }

  function preview(r) {
    if (!r.lastAt) return 'No messages yet';
    var what = r.lastText || (r.lastKind === 'image' ? 'Photo' : r.lastKind === 'file' ? 'File' : r.lastKind === 'note' ? 'Shared note' : 'Message');
    return (r.lastSender ? r.lastSender + ': ' : '') + what;
  }

  async function viewChat(ctx, roomKey) {
    var wrap = h('section', { class: 'panel chat' + (roomKey ? ' open' : '') });
    show.apply(null, courseFrame(ctx, 'chat', wrap));
    var rooms;
    try { rooms = await listRooms(ctx.course.id, ctx.names); } catch (x) { wrap.replaceChildren(h('p', { class: 'empty error' }, x.message)); return; }
    var roomId = roomKey && roomKey !== 'everyone' ? roomKey : null;
    var current = roomKey ? rooms.filter(function (r) { return r.id === roomId; })[0] : null;

    var roomList = h('nav', { class: 'rooms', 'aria-label': 'Chats' }, rooms.map(function (r) {
      return h('a', { class: 'room', href: '#/c/' + ctx.course.id + '/chat/' + (r.id || 'everyone'), 'aria-current': current && current.id === r.id ? 'true' : null },
        h('span', { class: 'av', 'aria-hidden': 'true' }, r.kind === 'everyone' ? '📣' : r.kind === 'group' ? '👥' : initials(r.name)),
        h('span', { class: 'txt' }, h('span', { class: 'n' }, r.name), h('span', { class: 'l' }, preview(r))),
        r.unread ? h('span', { class: 'badge', 'aria-label': r.unread + ' unread' }, r.unread > 99 ? '99+' : r.unread) : null);
    }));
    var thread = h('div', { class: 'thread' });
    wrap.replaceChildren(roomList, thread);
    if (!current) { thread.replaceChildren(h('div', { class: 'pick' }, roomKey ? 'This chat isn’t available.' : 'Pick a chat on the left.')); return; }
    openThread(ctx, current, thread);
  }

  async function openThread(ctx, room, thread) {
    var courseId = ctx.course.id, me = state.user.id;
    var msgsEl = h('div', { class: 'msgs', role: 'log', 'aria-label': 'Messages' });
    var seen = new Set(), oldest = null, lastDay = null;
    var urlCache = new Map();

    function filterRoom(q) { return room.id ? q.eq('room_id', room.id) : q.is('room_id', null); }
    async function page(before) {
      var q = sb.from('chat_messages').select('*').eq('course_id', courseId).order('created_at', { ascending: false }).limit(PAGE);
      q = filterRoom(q); if (before) q = q.lt('created_at', before);
      var r = await q; fail(r.error);
      return (r.data || []).reverse();
    }
    async function urlsFor(rows) {
      var need = rows.map(function (m) { return m.attachment_url; }).filter(function (p) { return p && !urlCache.has(p); });
      (await signedUrls(need)).forEach(function (v, k) { urlCache.set(k, v); });
    }
    function bubble(m) {
      var mine = m.sender_id === me;
      var kids = [];
      if (m.attachment_type === 'image' && m.attachment_url) {
        var u = urlCache.get(m.attachment_url);
        if (u) kids.push(h('img', { src: u, alt: 'Photo from ' + (m.sender_name || 'a member'), loading: 'lazy', onclick: function () { photoDialog(u, 'Photo'); } }));
      } else if (m.attachment_type === 'file' && m.attachment_url) {
        var fu = urlCache.get(m.attachment_url), fname = decodeURIComponent(m.attachment_url.split('/').pop() || 'file');
        kids.push(fu ? h('a', { class: 'file', href: fu, target: '_blank', rel: 'noopener' }, '📎 ', fname) : h('span', { class: 'file' }, '📎 ', fname));
      }
      if (m.shared && m.shared.type === 'note') kids.push(h('div', { class: 'shared' }, h('b', null, '📝 ' + (m.shared.title || 'Note')), '\n', (m.shared.body || '').slice(0, 1200)));
      if (m.text) kids.push(document.createTextNode(m.text));
      return h('div', { class: 'msg' + (mine ? ' me' : ''), 'data-id': m.id },
        !mine && room.kind !== 'direct' ? h('div', { class: 'who' }, m.sender_name || 'Member') : null,
        h('div', { class: 'bubble' }, kids),
        h('div', { class: 'time' }, fmtTime(m.created_at)));
    }
    function append(m) {
      if (seen.has(m.id)) return;
      seen.add(m.id);
      var d = dayLabel(m.created_at);
      if (d !== lastDay) { msgsEl.appendChild(h('div', { class: 'day' }, d)); lastDay = d; }
      var stick = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 120;
      msgsEl.appendChild(bubble(m));
      if (stick || m.sender_id === me) msgsEl.scrollTop = msgsEl.scrollHeight;
    }

    // Compose
    var text = h('textarea', { rows: '1', placeholder: 'Message', 'aria-label': 'Message', maxlength: '4000' });
    var fileIn = h('input', { type: 'file', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
    var sendBtn = h('button', { class: 'btn icon', type: 'submit', 'aria-label': 'Send' }, '➤');
    var attachBtn = h('button', { class: 'btn soft icon', type: 'button', 'aria-label': 'Send a photo or file', onclick: function () { fileIn.click(); } }, '📎');
    text.addEventListener('input', function () { text.style.height = 'auto'; text.style.height = Math.min(140, text.scrollHeight) + 'px'; });
    text.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
    async function insert(row) {
      var r = await sb.from('chat_messages').insert(Object.assign({ course_id: courseId, room_id: room.id, sender_id: me, mentions: [] }, row)).select('*').single();
      fail(r.error); return r.data;
    }
    var form = h('form', { class: 'compose', onsubmit: async function (e) {
      e.preventDefault();
      var t = text.value.trim(); if (!t) return;
      sendBtn.disabled = true;
      try { var m = await insert({ id: uuid(), text: t }); text.value = ''; text.style.height = ''; append(m); }
      catch (x) { toast(x.message); }
      sendBtn.disabled = false; text.focus();
    } }, attachBtn, fileIn, text, sendBtn);
    fileIn.addEventListener('change', async function () {
      var f = fileIn.files && fileIn.files[0]; fileIn.value = ''; if (!f) return;
      attachBtn.disabled = true;
      try {
        var id = uuid(), isImg = /^image\/(jpeg|png|webp|gif|heic|heif)$/i.test(f.type), body = f, name = f.name, type = f.type || 'application/octet-stream';
        if (isImg && f.type !== 'image/gif') { body = await shrinkImage(f); name = name.replace(/\.[^.]+$/, '') + '.jpg'; type = 'image/jpeg'; }
        if (body.size > MAX_CHAT_FILE) throw new Error('Chat files can be up to 10 MB. For bigger files, put them in Google Drive or OneDrive and send the link.');
        var path = room.id ? courseId + '/r/' + room.id + '/' + id + '/' + safeName(name) : courseId + '/' + id + '/' + safeName(name);
        var up = await sb.storage.from(CHAT_BUCKET).upload(path, body, { contentType: type }); fail(up.error);
        try {
          var m = await insert({ id: id, text: text.value.trim() || null, attachment_type: isImg ? 'image' : 'file', attachment_url: path });
          text.value = ''; await urlsFor([m]); append(m);
        } catch (x) { await sb.storage.from(CHAT_BUCKET).remove([path]); throw x; }
      } catch (x) { toast(x.message); }
      attachBtn.disabled = false;
    });

    thread.replaceChildren(
      h('div', { class: 'thread-head' }, h('a', { class: 'back', href: '#/c/' + courseId + '/chat', 'aria-label': 'All chats' }, '←'), room.name),
      msgsEl, form);

    try {
      var first = await page();
      await urlsFor(first);
      if (first.length === PAGE) {
        var more = h('button', { class: 'btn soft small more', type: 'button', onclick: async function () {
          more.disabled = true;
          try {
            var older = await page(oldest); await urlsFor(older);
            if (older.length) {
              var h0 = msgsEl.scrollHeight, frag = document.createDocumentFragment(), prevDay = null;
              older.forEach(function (m) { if (seen.has(m.id)) return; seen.add(m.id); var d = dayLabel(m.created_at); if (d !== prevDay) { frag.appendChild(h('div', { class: 'day' }, d)); prevDay = d; } frag.appendChild(bubble(m)); });
              more.after(frag); oldest = older[0].created_at; msgsEl.scrollTop += msgsEl.scrollHeight - h0;
            }
            if (older.length < PAGE) more.remove(); else more.disabled = false;
          } catch (x) { toast(x.message); more.disabled = false; }
        } }, 'Show earlier messages');
        msgsEl.appendChild(more);
      }
      if (first.length) oldest = first[0].created_at;
      first.forEach(append);
      if (!first.length) msgsEl.appendChild(h('p', { class: 'empty' }, 'No messages yet. Say hello!'));
      msgsEl.scrollTop = msgsEl.scrollHeight;
      sb.rpc('mark_chat_read', { p_course_id: courseId, p_room_id: room.id });
    } catch (x) { msgsEl.replaceChildren(h('p', { class: 'empty error' }, x.message)); }

    // New and deleted messages, live.
    stopChannel();
    state.channel = sb.channel('web-chat-' + courseId)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: 'course_id=eq.' + courseId }, async function (p) {
        var m = p.new; if ((m.room_id || null) !== room.id || seen.has(m.id)) return;
        var empty = msgsEl.querySelector('.empty'); if (empty) empty.remove();
        await urlsFor([m]); append(m);
        if (m.sender_id !== me) sb.rpc('mark_chat_read', { p_course_id: courseId, p_room_id: room.id });
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'chat_messages' }, function (p) {
        var el = p.old && msgsEl.querySelector('[data-id="' + String(p.old.id).replace(/"/g, '') + '"]'); if (el) el.remove();
      })
      .subscribe();
    text.focus();
  }

  /** Photos go out as JPEG no larger than 1600 px on the long side, like the app. */
  function shrinkImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var s = Math.min(1, IMAGE_MAX / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error('This photo can’t be sent.')); }, 'image/jpeg', 0.8);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('This photo can’t be opened in the browser. Try a JPEG or PNG.')); };
      img.src = url;
    });
  }

  // ---------- Notebook (end-to-end encrypted notes sync) ----------
  // Same format as the phone app (src/lib/notesCrypto.ts): AES-256-GCM, "v1.<iv>.<ciphertext+tag>", the notebook key
  // wrapped with PBKDF2-SHA256 from the notes password. The unlocked key lives only in this tab's session storage.

  var KEY_AAD = 'liyaa-notes-key', ITER = 210000, enc = new TextEncoder(), dec = new TextDecoder();
  var SUBJECT_COLORS = ['#4F6DF5', '#E5484D', '#30A46C', '#F76B15', '#8E4EC6', '#0091FF', '#D6409F', '#12A594'];
  var notesKey = null; // CryptoKey for AES-GCM
  var NK_STORE = 'liyaa.notesKey';

  function b64(bytes) { var s = ''; bytes = new Uint8Array(bytes); for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
  function unb64(s) { var bin = atob(s), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  function forgetNotesKey() { notesKey = null; try { sessionStorage.removeItem(NK_STORE); } catch (e) { /* storage unavailable */ } }
  async function kekFrom(password, salt, iterations) {
    var base = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function seal(key, plain, aad) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: enc.encode(aad) }, key, plain);
    return 'v1.' + b64(iv) + '.' + b64(ct);
  }
  async function unseal(key, sealed, aad) {
    var p = String(sealed).split('.');
    if (p[0] !== 'v1' || !p[1] || !p[2]) throw new Error('Unknown encrypted format.');
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(p[1]), additionalData: enc.encode(aad) }, key, unb64(p[2])));
  }
  async function useRawKey(raw) {
    notesKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    try { sessionStorage.setItem(NK_STORE, state.user.id + ':' + b64(raw)); } catch (e) { /* storage unavailable */ }
  }
  async function restoreNotesKey() {
    if (notesKey) return true;
    try {
      var s = sessionStorage.getItem(NK_STORE) || '', i = s.indexOf(':');
      if (i > 0 && s.slice(0, i) === state.user.id) { await useRawKey(unb64(s.slice(i + 1))); return true; }
    } catch (e) { /* storage unavailable */ }
    return false;
  }
  async function wrappedKeyRow() {
    var r = await sb.from('notes_keys').select('salt, iterations, wrapped_key').eq('user_id', state.user.id).maybeSingle(); fail(r.error);
    return r.data;
  }
  async function unlockNotes(password) {
    var w = await wrappedKeyRow(); if (!w) throw new Error('Notes sync isn’t set up yet.');
    var kek = await kekFrom(password, unb64(w.salt), w.iterations), raw;
    try { raw = await unseal(kek, w.wrapped_key, KEY_AAD); } catch (e) { throw new Error('That notes password isn’t right.'); }
    await useRawKey(raw);
  }
  async function setUpNotes(password) {
    if (await wrappedKeyRow()) throw new Error('Notes sync is already set up. Enter your notes password instead.');
    var raw = crypto.getRandomValues(new Uint8Array(32)), salt = crypto.getRandomValues(new Uint8Array(16));
    var wrapped = await seal(await kekFrom(password, salt, ITER), raw, KEY_AAD);
    var r = await sb.from('notes_keys').insert({ user_id: state.user.id, salt: b64(salt), iterations: ITER, wrapped_key: wrapped }); fail(r.error);
    await useRawKey(raw);
  }
  async function encryptItem(id, kind, data) { return seal(notesKey, enc.encode(JSON.stringify(data)), id + ':' + kind); }
  async function decryptItem(id, kind, sealed) { return JSON.parse(dec.decode(await unseal(notesKey, sealed, id + ':' + kind))); }
  async function saveItem(courseId, id, kind, data) {
    var at = new Date().toISOString(); data.updatedAt = at;
    var r = await sb.from('notes_sync').upsert({ id: id, user_id: state.user.id, course_id: courseId, kind: kind, payload: await encryptItem(id, kind, data), deleted: false, client_updated_at: at }, { onConflict: 'id' });
    fail(r.error);
  }
  async function deleteItem(id, kind) {
    var r = await sb.from('notes_sync').upsert({ id: id, user_id: state.user.id, kind: kind, payload: null, deleted: true, client_updated_at: new Date().toISOString() }, { onConflict: 'id' });
    fail(r.error);
  }

  /** The course's notebook from the server, decrypted: subjects, topics and everything inside them. */
  async function loadNotebook(courseId) {
    var r = await sb.from('notes_sync').select('id, kind, payload').eq('course_id', courseId).eq('deleted', false).limit(10000); fail(r.error);
    var nb = { subjects: [], topics: [], note: [], link: [], task: [], reminder: [], attachment: [], unreadable: 0 };
    for (var i = 0; i < (r.data || []).length; i++) {
      var row = r.data[i];
      try {
        var d = await decryptItem(row.id, row.kind, row.payload); d.id = row.id;
        (row.kind === 'subject' ? nb.subjects : row.kind === 'topic' ? nb.topics : nb[row.kind] || []).push(d);
      } catch (e) { nb.unreadable++; }
    }
    var byOrder = function (a, b) { return (a.orderIndex || 0) - (b.orderIndex || 0) || String(a.title).localeCompare(String(b.title)); };
    nb.subjects.sort(byOrder); nb.topics.sort(byOrder);
    var subjectIds = new Set(nb.subjects.map(function (s) { return s.id; }));
    nb.topics = nb.topics.filter(function (t) { return subjectIds.has(t.subjectId); });
    return nb;
  }

  /** "#week 1, intro,  #Intro" → ["week 1", "intro"] (like the app: up to 10, 30 characters each). */
  function tagsFrom(text) {
    var out = [];
    String(text || '').split(/[,\n]/).forEach(function (t) {
      var tag = t.trim().replace(/^#+/, '').trim().slice(0, 30);
      if (tag && !out.some(function (o) { return o.toLowerCase() === tag.toLowerCase(); })) out.push(tag);
    });
    return out.slice(0, 10);
  }
  var tagsText = function (list) { return (list || []).join(', '); };

  /** A small form in a dialog. fields: [{ key, label, value, placeholder, hint, required, multiline, type, max }]. */
  function formDialog(o) {
    var inputs = {};
    var err = errorBox();
    var save = h('button', { class: 'btn', type: 'submit' }, o.submit || 'Save');
    var form = h('form', { class: 'db', style: 'white-space:normal', onsubmit: async function (e) {
      e.preventDefault(); setError(err, null);
      var v = {}; Object.keys(inputs).forEach(function (k) { v[k] = inputs[k].value.trim(); });
      var missing = o.fields.filter(function (f) { return f.required && !v[f.key]; })[0];
      if (missing) return setError(err, new Error('Fill in: ' + missing.label.replace(/ \(.*\)$/, '')));
      save.disabled = true;
      try { await o.onSubmit(v); d.close(); } catch (x) { setError(err, x); save.disabled = false; }
    } },
      o.intro ? h('p', { class: 'note-line', style: 'margin-top:0' }, o.intro) : null,
      o.fields.map(function (f) {
        var el = f.options ? h('select', null, f.options.map(function (o) { return h('option', { value: o[0] }, o[1]); })) : f.multiline ? h('textarea', { rows: '3', maxlength: f.max || '1000' }) : h('input', { type: f.type === 'url' ? 'text' : f.type || 'text', inputmode: f.type === 'url' ? 'url' : null, autocapitalize: f.type === 'url' ? 'off' : null, spellcheck: f.type === 'url' ? 'false' : null, maxlength: f.max || '200' });
        if (!f.options || f.value) el.value = f.value || ''; if (f.placeholder) el.placeholder = f.placeholder;
        inputs[f.key] = el;
        return h('label', { class: 'field' }, h('span', null, f.label), el, f.hint ? h('small', { class: 'note-line' }, f.hint) : null);
      }),
      err,
      h('div', { class: 'nb-actions' }, o.danger || null, h('span', { class: 'grow' }), save));
    var d = h('dialog', { 'aria-label': o.title },
      h('div', { class: 'dh' }, h('span', null, o.title), h('button', { class: 'btn plain small', type: 'button', onclick: function () { d.close(); } }, 'Close')), form);
    d.addEventListener('close', function () { d.remove(); });
    document.body.appendChild(d); d.showModal();
    var first = inputs[o.fields[0].key]; if (first) first.focus();
    return d;
  }

  function noteTitle(n) { var first = String(n.content || '').split('\n').map(function (l) { return l.replace(/^[#>\-*\s]+|\*\*|__|\+\+|\{[^}]*\}|\[[ xX]\]\s*/g, '').trim(); }).filter(Boolean)[0]; return first ? first.slice(0, 80) : 'Empty note'; }

  // Decrypted attachment files, as object URLs (kept for the visit).
  var fileUrls = new Map();
  async function attachmentUrl(a) {
    if (fileUrls.has(a.id)) return fileUrls.get(a.id);
    if (!a.blob) throw new Error('This file is only on the phone it was added on (it is over 20 MB).');
    var dl = await sb.storage.from('notes-files').download(a.blob); fail(dl.error);
    var sealed = new Uint8Array(await dl.data.arrayBuffer());
    if (sealed[0] !== 1) throw new Error('Unknown encrypted file format.');
    var plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(1, 13), additionalData: enc.encode(a.id + ':file') }, notesKey, sealed.subarray(13));
    var url = URL.createObjectURL(new Blob([plain], { type: a.mimeType || 'application/octet-stream' }));
    fileUrls.set(a.id, url);
    return url;
  }
  async function uploadAttachment(courseId, topic, file, meta) {
    if (file.size > 20 * 1024 * 1024) throw new Error('Files can be up to 20 MB. For bigger files, put them in Google Drive or OneDrive and add the link instead.');
    var id = uuid(), path = state.user.id + '/' + id;
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: enc.encode(id + ':file') }, notesKey, await file.arrayBuffer()));
    var sealed = new Uint8Array(13 + ct.length); sealed[0] = 1; sealed.set(iv, 1); sealed.set(ct, 13);
    var up = await sb.storage.from('notes-files').upload(path, sealed, { contentType: 'application/octet-stream', upsert: true }); fail(up.error);
    var mime = file.type || 'application/octet-stream';
    var type = /^image\//.test(mime) ? 'image' : /^video\//.test(mime) ? 'video' : /^audio\//.test(mime) ? 'audio' : mime === 'application/pdf' ? 'pdf' : 'file';
    try {
      await saveItem(courseId, id, 'attachment', { topicId: topic.id, type: type, fileName: withExt(meta.name, file.name || 'file'), mimeType: mime, fileSize: file.size, durationMs: null, keywords: meta.tags, caption: meta.caption || '', createdAt: new Date().toISOString(), blob: path });
    } catch (x) { await sb.storage.from('notes-files').remove([path]); throw x; }
  }

  /** A display name keeps the original file's extension ("Day 1" + "IMG_4017.jpeg" → "Day 1.jpeg"). */
  function withExt(name, original) {
    var ext = (/\.[A-Za-z0-9]{1,8}$/.exec(original) || [''])[0];
    name = String(name || '').trim().replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 100);
    if (!name) return original;
    return ext && name.toLowerCase().slice(-ext.length) !== ext.toLowerCase() ? name + ext : name;
  }
  var stripExt = function (n) { return String(n || '').replace(/\.[A-Za-z0-9]{1,8}$/, ''); };

  /** Removes items (and, for attachments, their stored files) everywhere. */
  async function deleteAll(items) {
    for (var i = 0; i < items.length; i++) {
      await deleteItem(items[i].id, items[i].kind);
      if (items[i].kind === 'attachment' && items[i].blob) await sb.storage.from('notes-files').remove([items[i].blob]);
    }
  }

  async function viewNotebook(ctx, topicId) {
    var panel = h('section', { class: 'panel' }, h('p', { class: 'empty' }, 'Opening your notebook…'));
    show.apply(null, courseFrame(ctx, 'notebook', panel));
    try {
      if (!(await restoreNotesKey())) {
        var w = await wrappedKeyRow();
        return panel.replaceChildren(notesGate(ctx, !!w));
      }
      var nb = await loadNotebook(ctx.course.id);
      panel.replaceChildren(notebookBody(ctx, nb, topicId));
    } catch (x) { panel.replaceChildren(h('p', { class: 'empty error' }, x.message)); }
  }

  /** Unlock form, or first-time setup for people without the phone app. */
  function notesGate(ctx, isSetUp) {
    var pw = h('input', { type: 'password', autocomplete: 'off', required: true, 'aria-label': 'Notes password' });
    var pw2 = isSetUp ? null : h('input', { type: 'password', autocomplete: 'off', required: true, 'aria-label': 'Type it again' });
    var err = errorBox();
    var label = isSetUp ? 'Unlock' : 'Turn on notes';
    var btn = h('button', { class: 'btn', type: 'submit' }, label);
    var form = h('form', { onsubmit: async function (e) {
      e.preventDefault(); setError(err, null);
      if (!isSetUp && pw.value.length < 8) return setError(err, new Error('Use at least 8 characters.'));
      if (!isSetUp && pw.value !== pw2.value) return setError(err, new Error('The two passwords don’t match.'));
      busy(btn, true, [label, 'Unlocking…']);
      try { isSetUp ? await unlockNotes(pw.value) : await setUpNotes(pw.value); viewNotebook(ctx); }
      catch (x) { setError(err, x); busy(btn, false, [label, '']); }
    } },
      h('label', { class: 'field' }, h('span', null, isSetUp ? 'Notes password' : 'Choose a notes password (8 or more characters)'), pw),
      pw2 ? h('label', { class: 'field' }, h('span', null, 'Type it again'), pw2) : null,
      btn, err);
    return h('div', { class: 'gate' },
      h('h2', null, isSetUp ? 'Unlock your notebook' : 'Start your notebook'),
      h('p', { class: 'sub' }, isSetUp
        ? 'Your notebook is locked with your notes password, so only you can read it.'
        : 'Choose a notes password to keep your notes, photos, files, links and tasks here, locked so only you can read them. Already using the phone app? Turn on Notes on the web there (Profile & Settings) and use the same notes password.'),
      isSetUp ? null : h('p', { class: 'note-line' }, 'If you forget the notes password, your synced notebook can’t be recovered. Nobody, not even Liyaa Note, can open it.'),
      form);
  }

  var openSubjects = new Set();
  var FILTERS = [['all', 'All'], ['notes', 'Notes'], ['docs', 'Docs'], ['image', 'Photos'], ['audio', 'Audio'], ['video', 'Video'], ['links', 'Links'], ['tasks', 'Tasks']];
  var DOC_ICON = { pdf: '📕', file: '📄' };

  function notebookBody(ctx, nb, topicId) {
    var courseId = ctx.course.id;
    var topic = nb.topics.filter(function (t) { return t.id === topicId; })[0] || null;
    function reopen(id) { viewNotebook(ctx, id === undefined ? topicId : id); }
    function inTopic(list, t) { return list.filter(function (x) { return x.topicId === t.id; }); }
    function countFor(t) { return inTopic(nb.note, t).length + inTopic(nb.link, t).length + inTopic(nb.attachment, t).length + nb.task.filter(function (k) { return k.parentType === 'topic' && k.parentId === t.id; }).length + inTopic(nb.reminder, t).length; }

    // Search the notebook: subject and topic names, and everything inside topics.
    function topicText(t) {
      var inT = function (list) { return list.filter(function (x) { return x.topicId === t.id; }); };
      return [].concat(
        inT(nb.note).map(function (x) { return x.content; }),
        inT(nb.link).map(function (x) { return [x.title, x.url, x.area, x.note].concat(x.keywords || []).join(' '); }),
        inT(nb.attachment).map(function (x) { return [x.fileName, x.caption].concat(x.keywords || []).join(' '); }),
        inT(nb.reminder).map(function (x) { return x.title; }),
        nb.task.filter(function (k) { return k.parentType === 'topic' && k.parentId === t.id; }).map(function (k) { return k.title; }));
    }
    function matchesIn(t, q) {
      return topicText(t).filter(function (txt) { return String(txt || '').toLowerCase().indexOf(q) >= 0; }).length;
    }
    var nbSearch = h('input', { type: 'search', class: 'nb-search', placeholder: 'Search subjects and topics', 'aria-label': 'Search subjects and topics' });
    var subjectList = h('div', { class: 'nb-subjects' });
    function drawSubjects() {
      var q = nbSearch.value.trim().toLowerCase();
      var parts = nb.subjects.map(function (s) {
        var ts = nb.topics.filter(function (t) { return t.subjectId === s.id; });
        var hits = null;
        if (q) {
          var subjectHit = String(s.title).toLowerCase().indexOf(q) >= 0;
          hits = new Map();
          ts.forEach(function (t) {
            var n = matchesIn(t, q) + ((String(t.title) + ' ' + (t.keywords || []).join(' ')).toLowerCase().indexOf(q) >= 0 ? 1 : 0);
            if (n || subjectHit) hits.set(t.id, n);
          });
          if (!subjectHit && !hits.size) return null;
          ts = ts.filter(function (t) { return hits.has(t.id); });
        }
        return subjectRow(s, ts, hits);
      }).filter(Boolean);
      subjectList.replaceChildren.apply(subjectList, parts.length ? parts
        : [h('p', { class: 'note-line', style: 'padding:8px' }, q ? 'Nothing in this notebook matches “' + nbSearch.value.trim() + '”.' : 'No subjects yet.')]);
    }
    nbSearch.addEventListener('input', drawSubjects);

    function subjectRow(s, ts, hits) {
        if (topic && topic.subjectId === s.id) openSubjects.add(s.id); // the subject of the open topic stays open
        var open = !!hits || openSubjects.has(s.id);
        var list = h('div', { class: 'nb-topics', id: 'topics-' + s.id, hidden: !open },
          ts.length ? ts.map(function (t) {
            return h('a', { class: 'nb-topic', href: '#/c/' + courseId + '/notebook/' + t.id, 'aria-current': topic && topic.id === t.id ? 'true' : null }, t.title, h('span', { class: 'm' }, hits ? (hits.get(t.id) ? hits.get(t.id) + (hits.get(t.id) === 1 ? ' match' : ' matches') : '') : String(countFor(t))));
          }) : h('p', { class: 'note-line', style: 'padding:4px 10px 4px 26px;margin:0' }, 'No topics yet. Use ＋ to add one.'));
        var toggle = h('button', { class: 'nb-sh-toggle', type: 'button', 'aria-expanded': String(open), 'aria-controls': 'topics-' + s.id, onclick: function () {
          var nowOpen = list.hidden;
          list.hidden = !nowOpen; toggle.setAttribute('aria-expanded', String(nowOpen));
          if (nowOpen) openSubjects.add(s.id); else openSubjects.delete(s.id);
        } },
          h('span', { class: 'chev', 'aria-hidden': 'true' }, '›'),
          h('span', { class: 'dot', style: 'background:' + (/^#[0-9a-f]{3,8}$/i.test(s.color || '') ? s.color : '#4F6DF5') }),
          h('b', null, s.title),
          h('span', { class: 'm' }, ts.length + (ts.length === 1 ? ' topic' : ' topics')));
        return h('div', { class: 'nb-subject' },
          h('div', { class: 'nb-sh' }, toggle,
            h('button', { class: 'btn plain small', type: 'button', 'aria-label': 'Add a topic to ' + s.title, onclick: function () { addTopic(s, ts.length); } }, '＋'),
            h('button', { class: 'btn plain small', type: 'button', 'aria-label': 'Rename or delete ' + s.title, onclick: function () { editSubject(s); } }, '⋯')),
          list);
    }

    var side = h('nav', { class: 'nb-side', 'aria-label': 'Subjects and topics' },
      nb.subjects.length ? nbSearch : null,
      subjectList,
      h('button', { class: 'btn soft small', type: 'button', style: 'margin:8px', onclick: addSubject }, '＋ New subject'),
      h('button', { class: 'btn plain small', type: 'button', onclick: function () { forgetNotesKey(); viewNotebook(ctx); } }, '🔒 Lock notebook'),
      nb.unreadable ? h('p', { class: 'note-line', style: 'padding:8px' }, nb.unreadable + ' item(s) couldn’t be unlocked with this key.') : null);

    drawSubjects();
    var main = h('div', { class: 'nb-main' });
    if (!topic) main.appendChild(h('div', { class: 'pick' }, nb.subjects.length ? 'Pick a topic to see what’s in it.' : 'Start with a subject (like a module or day), then add topics.'));
    else main.appendChild(topicPage(topic));

    /** Everything inside a topic, for deleting it. */
    function topicContents(t) {
      var mine = function (list, kind) { return list.filter(function (x) { return x.topicId === t.id; }).map(function (x) { return { id: x.id, kind: kind, blob: x.blob }; }); };
      return [].concat(mine(nb.note, 'note'), mine(nb.link, 'link'), mine(nb.attachment, 'attachment'), mine(nb.reminder, 'reminder'),
        nb.task.filter(function (k) { return k.parentType === 'topic' && k.parentId === t.id; }).map(function (k) { return { id: k.id, kind: 'task' }; }));
    }
    function editSubject(s) {
      var ts = nb.topics.filter(function (t) { return t.subjectId === s.id; });
      var inside = ts.reduce(function (n, t) { return n + 1 + topicContents(t).length; }, 0);
      var d = formDialog({
        title: 'Subject',
        fields: [{ key: 'title', label: 'Subject name', value: s.title, required: true, max: '80' }],
        onSubmit: async function (v) { await saveItem(courseId, s.id, 'subject', Object.assign({}, s, { id: undefined, title: v.title })); reopen(); },
        danger: h('button', { class: 'btn plain', type: 'button', style: 'color:var(--danger)', onclick: async function () {
          if (!confirm('Delete “' + s.title + '”' + (inside ? ' and the ' + inside + ' topic(s) and item(s) in it' : '') + '? It also disappears from your phone. This can’t be undone.')) return;
          try {
            var all = [];
            ts.forEach(function (t) { all = all.concat(topicContents(t), [{ id: t.id, kind: 'topic' }]); });
            all = all.concat(nb.task.filter(function (k) { return k.parentType === 'subject' && k.parentId === s.id; }).map(function (k) { return { id: k.id, kind: 'task' }; }));
            await deleteAll(all.concat([{ id: s.id, kind: 'subject' }]));
            d.close(); location.hash = '#/c/' + courseId + '/notebook'; reopen(null);
          } catch (x) { toast(x.message); }
        } }, 'Delete subject'),
      });
    }
    function editTopic(t) {
      var inside = topicContents(t).length;
      var d = formDialog({
        title: 'Topic',
        fields: [
          { key: 'title', label: 'Topic name', value: t.title, required: true, max: '80' },
          { key: 'tags', label: '#Tags (separate with commas)', value: tagsText(t.keywords), placeholder: 'e.g. week 1, exam' },
        ],
        onSubmit: async function (v) { await saveItem(courseId, t.id, 'topic', Object.assign({}, t, { id: undefined, title: v.title, keywords: tagsFrom(v.tags) })); reopen(); },
        danger: h('button', { class: 'btn plain', type: 'button', style: 'color:var(--danger)', onclick: async function () {
          if (!confirm('Delete the topic “' + t.title + '”' + (inside ? ' and the ' + inside + ' item(s) in it' : '') + '? It also disappears from your phone. This can’t be undone.')) return;
          try { await deleteAll(topicContents(t).concat([{ id: t.id, kind: 'topic' }])); d.close(); location.hash = '#/c/' + courseId + '/notebook'; }
          catch (x) { toast(x.message); }
        } }, 'Delete topic'),
      });
    }

    async function addSubject() {
      var title = (prompt('Name of the new subject (e.g. Day 1 or Module 2):') || '').trim(); if (!title) return;
      try {
        var now = new Date().toISOString();
        await saveItem(courseId, uuid(), 'subject', { courseId: courseId, title: title.slice(0, 80), color: SUBJECT_COLORS[nb.subjects.length % SUBJECT_COLORS.length], orderIndex: nb.subjects.length, createdAt: now, updatedAt: now });
        reopen();
      } catch (x) { toast(x.message); }
    }
    async function addTopic(s, n) {
      var title = (prompt('Name of the new topic in ' + s.title + ':') || '').trim(); if (!title) return;
      try {
        var id = uuid(), now = new Date().toISOString();
        await saveItem(courseId, id, 'topic', { subjectId: s.id, title: title.slice(0, 80), keywords: [], orderIndex: n, createdAt: now, updatedAt: now });
        openSubjects.add(s.id);
        location.hash = '#/c/' + courseId + '/notebook/' + id;
      } catch (x) { toast(x.message); }
    }

    /** The topic, like the app: tags, search, filters with counts, then everything in it, newest first. */
    function topicPage(t) {
      var notes = inTopic(nb.note, t), links = inTopic(nb.link, t), atts = inTopic(nb.attachment, t), rems = inTopic(nb.reminder, t);
      var tasks = nb.task.filter(function (k) { return k.parentType === 'topic' && k.parentId === t.id; });
      var feed = [].concat(
        notes.map(function (x) { return { kind: 'note', f: 'notes', at: x.updatedAt || x.createdAt, x: x, text: x.content }; }),
        atts.map(function (x) { return { kind: 'attachment', f: x.type === 'pdf' || x.type === 'file' ? 'docs' : x.type, at: x.createdAt, x: x, text: [x.fileName, x.caption].concat(x.keywords || []).join(' ') }; }),
        links.map(function (x) { return { kind: 'link', f: 'links', at: x.updatedAt || x.createdAt, x: x, text: [x.title, x.url, x.note, x.area].concat(x.keywords || []).join(' ') }; }),
        tasks.map(function (x) { return { kind: 'task', f: 'tasks', at: x.createdAt, x: x, text: x.title }; }),
        rems.map(function (x) { return { kind: 'reminder', f: 'tasks', at: x.createdAt, x: x, text: x.title }; }));
      feed.sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
      var counts = { all: feed.length }; feed.forEach(function (i) { counts[i.f] = (counts[i.f] || 0) + 1; });
      var filter = 'all';
      var search = h('input', { type: 'search', placeholder: 'Search this topic', 'aria-label': 'Search this topic' });
      var chips = h('div', { class: 'nb-chips', role: 'tablist', 'aria-label': 'Show' });
      var list = h('div', { class: 'nb-feed' });
      function drawChips() {
        chips.replaceChildren.apply(chips, FILTERS.filter(function (f) { return f[0] === 'all' || counts[f[0]]; }).map(function (f) {
          return h('button', { class: 'chip', type: 'button', role: 'tab', 'aria-selected': String(filter === f[0]), onclick: function () { filter = f[0]; drawChips(); draw(); } }, f[1] + ' ' + (counts[f[0]] || 0));
        }));
      }
      function draw() {
        var q = search.value.trim().toLowerCase();
        var shown = feed.filter(function (i) { return (filter === 'all' || i.f === filter) && (!q || String(i.text || '').toLowerCase().indexOf(q) >= 0); });
        if (!shown.length) return list.replaceChildren(h('p', { class: 'empty' }, feed.length ? 'Nothing matches.' : 'Nothing here yet. Use ＋ Add.'));
        list.replaceChildren.apply(list, shown.map(card));
      }
      search.addEventListener('input', draw);
      drawChips(); draw();
      return h('div', null,
        h('div', { class: 'nb-head' }, h('a', { class: 'back', href: '#/c/' + courseId + '/notebook', 'aria-label': 'All topics' }, '←'),
          h('div', { class: 'nb-title' }, h('h2', null, t.title), (t.keywords || []).length ? h('div', null, t.keywords.map(function (k) { return h('span', { class: 'pill' }, '#' + k); })) : null),
          h('button', { class: 'btn plain small', type: 'button', 'aria-label': 'Rename, tags or delete this topic', onclick: function () { editTopic(t); } }, '⋯'),
          addMenu(t)),
        h('div', { class: 'nb-tools' }, search, chips),
        list);
    }

    function card(i) {
      var x = i.x;
      if (i.kind === 'note') return h('button', { class: 'nb-note', type: 'button', onclick: function () { editNote(x); } },
        h('b', null, noteTitle(x)), h('span', { class: 'm' }, String(x.content || '').slice(0, 260)), h('span', { class: 'm small' }, 'Note · ' + fmtDate(x.updatedAt)));
      if (i.kind === 'link') {
        var u = safeUrl(x.url);
        return h('div', { class: 'nb-card' }, h('span', { class: 'ico' }, '🔗'),
          h('div', { class: 'grow' }, u ? h('a', { href: u, target: '_blank', rel: 'noopener', class: 't' }, x.title || u) : h('span', { class: 't' }, x.title),
            h('span', { class: 'm' }, [x.area, u ? new URL(u).hostname : ''].filter(Boolean).join(' · ')), x.note ? h('span', { class: 'm' }, x.note) : null,
            (x.keywords || []).length ? h('span', null, x.keywords.map(function (k) { return h('span', { class: 'pill' }, '#' + k); })) : null),
          edit(function () { linkForm(topic, x); }), del(x, 'link'));
      }
      if (i.kind === 'task') {
        var box = h('input', { type: 'checkbox', 'aria-label': 'Done: ' + x.title });
        box.checked = !!x.done;
        box.addEventListener('change', async function () {
          try { await saveItem(courseId, x.id, 'task', Object.assign({}, x, { id: undefined, done: box.checked })); x.done = box.checked; }
          catch (e) { box.checked = !box.checked; toast(e.message); }
        });
        return h('label', { class: 'nb-card task' + (x.done ? ' done' : '') }, box,
          h('div', { class: 'grow' }, h('span', { class: 't' }, x.title), x.dueDate ? h('span', { class: 'm' }, 'Due ' + fmtDate(x.dueDate)) : null), del(x, 'task'));
      }
      if (i.kind === 'reminder') return h('div', { class: 'nb-card' }, h('span', { class: 'ico' }, '⏰'),
        h('div', { class: 'grow' }, h('span', { class: 't' }, x.title), h('span', { class: 'm' }, new Date(x.remindAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))), del(x, 'reminder'));
      return mediaCard(x);
    }

    function mediaCard(a) {
      var label = a.caption || a.fileName;
      var body = h('div', { class: 'nb-media-body' }, h('span', { class: 'ico' }, a.type === 'image' ? '🖼️' : a.type === 'video' ? '🎬' : a.type === 'audio' ? '🎧' : DOC_ICON[a.type] || '📄'));
      var el = h('div', { class: 'nb-card media ' + a.type },
        body,
        h('div', { class: 'grow' }, h('span', { class: 't' }, label), h('span', { class: 'm' }, [a.fileName !== label ? a.fileName : '', a.fileSize ? Math.max(1, Math.round(a.fileSize / 1024)) + ' KB' : '', !a.blob ? 'on the phone only' : ''].filter(Boolean).join(' · ')),
          (a.keywords || []).length ? h('span', null, a.keywords.map(function (k) { return h('span', { class: 'pill' }, '#' + k); })) : null),
        h('div', { class: 'nb-row-actions' }, edit(function () { fileDetails(a); }), del(a, 'attachment')));
      async function load() {
        try {
          var url = await attachmentUrl(a);
          if (a.type === 'image') body.replaceChildren(h('img', { src: url, alt: label, onclick: function () { photoDialog(url, label); } }));
          else if (a.type === 'video') body.replaceChildren(h('video', { src: url, controls: true, preload: 'metadata' }));
          else if (a.type === 'audio') body.replaceChildren(h('audio', { src: url, controls: true }));
          else window.open(url, '_blank', 'noopener');
        } catch (x) { toast(x.message); }
      }
      if (a.blob) {
        if (a.type === 'image') load();
        else body.appendChild(h('button', { class: 'btn soft small', type: 'button', onclick: load }, a.type === 'video' || a.type === 'audio' ? '▶ Play' : 'Open'));
      }
      return el;
    }

    function edit(fn) {
      return h('button', { class: 'btn plain small del', type: 'button', 'aria-label': 'Edit details', onclick: function (e) { e.preventDefault(); e.stopPropagation(); fn(); } }, '✎');
    }
    function fileDetails(a) {
      formDialog({
        title: 'Details',
        fields: [
          { key: 'name', label: 'Name', value: stripExt(a.fileName), placeholder: stripExt(a.fileName), max: '100' },
          { key: 'tags', label: '#Tags (at least one, separate with commas)', value: tagsText(a.keywords), required: true },
          { key: 'caption', label: 'Caption (optional)', value: a.caption || '', placeholder: 'What is this?', multiline: true, max: '500' },
        ],
        onSubmit: async function (v) {
          var tags = tagsFrom(v.tags); if (!tags.length) throw new Error('Add at least one tag so you can find this later.');
          await saveItem(courseId, a.id, 'attachment', Object.assign({}, a, { id: undefined, fileName: withExt(v.name, a.fileName), keywords: tags, caption: v.caption }));
          reopen();
        },
      });
    }
    function linkForm(t, x) {
      formDialog({
        title: x ? 'Edit link' : 'Add a link',
        fields: [
          { key: 'url', label: 'Web address', value: x ? x.url : '', placeholder: 'https://…', type: 'url', required: true, max: '2000' },
          { key: 'title', label: 'Title', value: x ? x.title : '', placeholder: 'What is it?', max: '120' },
          { key: 'area', label: 'Area (optional)', value: x ? x.area : '', placeholder: 'e.g. Case study', max: '60' },
          { key: 'tags', label: '#Tags (at least one, separate with commas)', value: x ? tagsText(x.keywords) : tagsText((t.keywords || []).slice(0, 1)), required: true },
          { key: 'note', label: 'Note (optional)', value: x ? x.note : '', placeholder: 'Why is it useful?', multiline: true, max: '1000' },
        ],
        onSubmit: async function (v) {
          var url = safeUrl(/^https?:\/\//i.test(v.url) ? v.url : 'https://' + v.url);
          if (!url) throw new Error('That doesn’t look like a web link. Copy the full link, starting with https://');
          var tags = tagsFrom(v.tags); if (!tags.length) throw new Error('Add at least one tag so you can find this later.');
          var now = new Date().toISOString();
          await saveItem(courseId, x ? x.id : uuid(), 'link', { topicId: t.id, url: url, title: (v.title || new URL(url).hostname).slice(0, 120), area: v.area, keywords: tags, note: v.note, createdAt: x ? x.createdAt : now, updatedAt: now });
          reopen();
        },
      });
    }

    function del(x, kind) {
      return h('button', { class: 'btn plain small del', type: 'button', 'aria-label': 'Delete', onclick: async function (e) {
        e.preventDefault(); e.stopPropagation();
        if (!confirm('Delete this? It will also disappear from your phone.')) return;
        try { await deleteItem(x.id, kind); if (kind === 'attachment' && x.blob) await sb.storage.from('notes-files').remove([x.blob]); reopen(); }
        catch (er) { toast(er.message); }
      } }, '🗑');
    }

    function addMenu(t) {
      var fileIn = h('input', { type: 'file', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true', multiple: true });
      fileIn.addEventListener('change', async function () {
        var files = Array.prototype.slice.call(fileIn.files || []); fileIn.value = ''; if (!files.length) return;
        var one = files.length === 1;
        var what = function (f) { return /^image\//.test(f.type) ? 'photo' : /^video\//.test(f.type) ? 'video' : /^audio\//.test(f.type) ? 'recording' : 'file'; };
        formDialog({
          title: one ? 'Add ' + what(files[0]) : 'Add ' + files.length + ' files',
          intro: files.map(function (f) { return f.name + ' (' + Math.max(1, Math.round(f.size / 1024)) + ' KB)'; }).join(', '),
          fields: [].concat(
            one ? [{ key: 'name', label: 'Name (optional)', placeholder: stripExt(files[0].name), hint: 'Leave empty to keep the file’s own name.', max: '100' }] : [],
            [{ key: 'tags', label: '#Tags (at least one, separate with commas)', value: tagsText((t.keywords || []).slice(0, 1)), placeholder: 'e.g. lecture, week 1', required: true },
             { key: 'caption', label: 'Caption (optional)', placeholder: 'What is this?', multiline: true, max: '500' }]),
          onSubmit: async function (v) {
            var tags = tagsFrom(v.tags); if (!tags.length) throw new Error('Add at least one tag so you can find this later.');
            for (var i = 0; i < files.length; i++) await uploadAttachment(courseId, t, files[i], { name: one ? v.name : '', tags: tags, caption: v.caption });
            reopen();
          },
        });
      });
      var menu = h('div', { class: 'nb-menu', hidden: true, role: 'menu' },
        item('📝 Note', function () { editNote(null); }),
        item('🖼️ Photo, video, recording or file', function () { fileIn.click(); }),
        item('🔗 Link', function () { linkForm(t, null); }),
        item('✅ Task', addTask),
        item('⏰ Reminder', addReminder));
      function item(label, fn) { return h('button', { type: 'button', role: 'menuitem', onclick: function () { menu.hidden = true; fn(); } }, label); }
      var btn = h('button', { class: 'btn small', type: 'button', 'aria-haspopup': 'menu', onclick: function (e) { e.stopPropagation(); menu.hidden = !menu.hidden; } }, '＋ Add');
      document.addEventListener('click', function () { menu.hidden = true; });
      return h('div', { class: 'nb-add' }, btn, menu, fileIn);

      async function addTask() {
        var title = (prompt('What needs doing?') || '').trim(); if (!title) return;
        try { await saveItem(courseId, uuid(), 'task', { parentType: 'topic', parentId: t.id, title: title.slice(0, 200), done: false, dueDate: null, reminderAt: null, createdAt: new Date().toISOString() }); reopen(); }
        catch (x) { toast(x.message); }
      }
      function addReminder() {
        var title = h('input', { type: 'text', required: true, maxlength: '120', 'aria-label': 'Reminder' });
        var when = h('input', { type: 'datetime-local', required: true, 'aria-label': 'When' });
        var err = errorBox();
        var d = h('dialog', { 'aria-label': 'New reminder' },
          h('div', { class: 'dh' }, h('span', null, 'New reminder · ' + t.title), h('button', { class: 'btn plain small', type: 'button', onclick: function () { d.close(); } }, 'Close')),
          h('form', { class: 'db', style: 'white-space:normal', onsubmit: async function (e) {
            e.preventDefault(); setError(err, null);
            var at = new Date(when.value);
            if (!title.value.trim() || isNaN(at)) return setError(err, new Error('Add a title and a date and time.'));
            try { await saveItem(courseId, uuid(), 'reminder', { topicId: t.id, title: title.value.trim(), remindAt: at.toISOString(), notified: false, createdAt: new Date().toISOString() }); d.close(); reopen(); }
            catch (x) { setError(err, x); }
          } },
            h('label', { class: 'field' }, h('span', null, 'Remind me to'), title),
            h('label', { class: 'field' }, h('span', null, 'When'), when),
            h('p', { class: 'note-line' }, 'Your phone shows the notification once it has synced.'),
            h('button', { class: 'btn', type: 'submit' }, 'Save'), err));
        d.addEventListener('close', function () { d.remove(); });
        document.body.appendChild(d); d.showModal(); title.focus();
      }
    }

    function editNote(n) {
      var area = h('textarea', { class: 'nb-editor', 'aria-label': 'Note text', maxlength: '30000', placeholder: 'Write your note…' });
      area.value = n ? n.content || '' : '';
      var err = errorBox();
      var save = h('button', { class: 'btn', type: 'button', onclick: async function () {
        if (!area.value.trim()) return setError(err, new Error('Write something first.'));
        save.disabled = true;
        try {
          var now = new Date().toISOString();
          await saveItem(courseId, n ? n.id : uuid(), 'note', { topicId: topic.id, content: area.value, createdAt: n ? n.createdAt : now, updatedAt: now });
          d.close(); reopen();
        } catch (x) { setError(err, x); save.disabled = false; }
      } }, 'Save');
      var delBtn = n ? h('button', { class: 'btn plain', type: 'button', style: 'color:var(--danger)', onclick: async function () {
        if (!confirm('Delete this note? It will also disappear from your phone.')) return;
        try { await deleteItem(n.id, 'note'); d.close(); reopen(); } catch (x) { setError(err, x); }
      } }, 'Delete') : null;
      var d = h('dialog', { 'aria-label': n ? 'Edit note' : 'New note' },
        h('div', { class: 'dh' }, h('span', null, (n ? 'Edit note' : 'New note') + ' · ' + topic.title), h('button', { class: 'btn plain small', type: 'button', onclick: function () { d.close(); } }, 'Close')),
        h('div', { class: 'db', style: 'white-space:normal' }, area, err,
          h('div', { class: 'nb-actions' }, delBtn, h('span', { class: 'grow' }), save),
          h('p', { class: 'note-line' }, 'Locked with your notes password before it leaves this browser. It appears on your phone at its next sync.')));
      d.addEventListener('close', function () { d.remove(); });
      document.body.appendChild(d); d.showModal(); area.focus();
    }

    return h('div', { class: 'nb' + (topic ? ' open' : '') }, side, main);
  }

  // ---------- Routing ----------

  var courseCache = { id: null, ctx: null };

  async function route() {
    stopChannel();
    var hash = location.hash.replace(/^#\/?/, '');
    var parts = hash.split('/').filter(Boolean);
    if (parts[0] === 'join' && parts[1]) state.pendingCode = parts[1].toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

    if (!state.session) {
      viewSignIn();
      if (landing && landing.error) {
        var box = root.querySelector('.error');
        setError(box, new Error(/expired|invalid/i.test(landing.code + landing.error) ? 'That email link has expired or was already used. If you confirmed your account, sign in. Otherwise create it again.' : landing.error));
        landing = null;
      }
      return;
    }
    if (state.recovery) return viewNewPassword();
    if (!state.account) { try { await loadAccount(); } catch (x) { return show(topBar(), h('main', { class: 'page' }, h('p', { class: 'error' }, x.message))); } }
    if (state.account.banned) return viewBanned();
    if (!state.account.rulesAccepted) return viewRules();

    if (parts[0] === 'c' && parts[1]) {
      try {
        if (courseCache.id !== parts[1]) { courseCache = { id: parts[1], ctx: await loadCourse(parts[1]) }; }
      } catch (x) { courseCache = { id: null, ctx: null }; return show(topBar('#/'), h('main', { class: 'page' }, h('div', { class: 'card empty' }, x.message))); }
      if (parts[2] === 'chat') return viewChat(courseCache.ctx, parts[3]);
      if (parts[2] === 'notebook') return viewNotebook(courseCache.ctx, parts[3]);
      return viewLibrary(courseCache.ctx);
    }
    if (parts[0] === 'join' && location.hash !== '#/') { history.replaceState(null, '', '#/'); }
    return viewCourses();
  }

  var started = false;
  sb.auth.onAuthStateChange(function (event, session) {
    if (event === 'PASSWORD_RECOVERY' || (landing && landing.type === 'recovery' && session)) { state.recovery = true; setTimeout(route, 0); }
    if (landing && (session || landing.error)) { if (!landing.error) landing = null; cleanAddress(); }
    var was = state.session ? state.session.user.id : null, now = session ? session.user.id : null;
    state.session = session; state.user = session ? session.user : null;
    if (!started || now !== was) { started = true; state.account = null; courseCache = { id: null, ctx: null }; setTimeout(route, 0); }
  });
  // The first auth event (INITIAL_SESSION) also draws the first screen.
  window.addEventListener('hashchange', route);
})();
