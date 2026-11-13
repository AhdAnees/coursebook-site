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

  var state = { session: null, user: null, account: null, channel: null, pendingCode: null };

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
      h('button', { class: 'btn plain small', type: 'button', onclick: async function () { stopChannel(); await sb.auth.signOut(); location.hash = '#/'; } }, 'Sign out'));
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
          emailRedirectTo: location.origin + location.pathname,
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
        var r = await sb.auth.resend({ type: 'signup', email: email });
        r.error ? setError(err, new Error(friendly(r.error.message))) : toast('We sent a new code.');
      } }, 'send a new code'), '.'));
    show(authShell('Check your email', 'We sent a code to ' + email + '.', form));
    code.focus();
  }

  function viewReset(prefill) {
    var email = h('input', { type: 'email', autocomplete: 'email', required: true, value: prefill || '' });
    var err = errorBox();
    var btn = h('button', { class: 'btn block', type: 'submit' }, 'Send me a code');
    var form = h('form', { onsubmit: async function (e) {
      e.preventDefault(); setError(err, null); busy(btn, true, ['Send me a code', 'Sending…']);
      try { var r = await sb.auth.resetPasswordForEmail(email.value.trim()); fail(r.error); viewResetCode(email.value.trim()); }
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
    var courses, requests = [];
    try {
      courses = await myCourses();
      var jr = await sb.rpc('my_join_requests'); if (!jr.error) requests = (jr.data || []).filter(function (q) { return q.status === 'pending'; });
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

    show(topBar(), h('main', { class: 'page' },
      h('h1', null, 'My courses'),
      h('p', { class: 'sub' }, 'Open a course to see its Library and chat. Your private notebook stays in the phone app for now.'),
      courses.length ? h('div', { class: 'courses' }, courses.map(function (c) {
        return h('a', { class: 'course', href: '#/c/' + c.id, style: '--c:' + (/^#[0-9a-f]{3,8}$/i.test(c.color || '') ? c.color : '') },
          h('div', { class: 'stripe' }),
          h('div', { class: 'in' },
            h('div', null, h('span', { class: 'pill' }, TYPE[c.type] || 'Course'), c.role === 'owner' ? h('span', { class: 'pill' }, 'Owner') : null),
            h('h3', null, c.title),
            h('p', null, [c.location, [fmtDate(c.start_date), c.end_date ? fmtDate(c.end_date) : ''].filter(Boolean).join(' – ')].filter(Boolean).join(' · '))));
      })) : h('div', { class: 'card empty' }, h('p', null, 'You’re not in any course yet. Join one with the invite code from your trainer.')),
      requests.length ? h('p', { class: 'note-line' }, 'Waiting for approval: ', requests.map(function (q) { return q.title; }).join(', ')) : null,
      h('div', { class: 'card', style: 'margin-top:20px' }, h('h2', null, 'Join a course'), join, err)));
  }

  // ---------- A course: header and tabs ----------

  async function loadCourse(id) {
    var c = await sb.from('courses').select('*').eq('id', id).maybeSingle(); fail(c.error);
    if (!c.data) throw new Error('This course isn’t available. You may not be a member.');
    var m = await sb.from('course_members').select('user_id, display_name, role').eq('course_id', id); fail(m.error);
    var names = new Map((m.data || []).map(function (x) { return [x.user_id, x.display_name || 'Member']; }));
    return { course: c.data, names: names };
  }

  function courseFrame(ctx, tab, body) {
    var c = ctx.course;
    return [topBar('#/'),
      h('div', { class: 'course-head' }, h('h1', null, c.title),
        h('p', null, [c.location, fmtDate(c.start_date) + (c.end_date ? ' – ' + fmtDate(c.end_date) : ''), ctx.names.size + ' members'].filter(Boolean).join(' · '))),
      h('nav', { class: 'tabs', 'aria-label': 'Course' },
        h('a', { href: '#/c/' + c.id + '/library', 'aria-current': tab === 'library' ? 'page' : null }, 'Library'),
        h('a', { href: '#/c/' + c.id + '/chat', 'aria-current': tab === 'chat' ? 'page' : null }, 'Chat')),
      h('div', { class: 'tab-body' }, body)];
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

  // ---------- Routing ----------

  var courseCache = { id: null, ctx: null };

  async function route() {
    stopChannel();
    var hash = location.hash.replace(/^#\/?/, '');
    var parts = hash.split('/').filter(Boolean);
    if (parts[0] === 'join' && parts[1]) state.pendingCode = parts[1].toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

    if (!state.session) return viewSignIn();
    if (!state.account) { try { await loadAccount(); } catch (x) { return show(topBar(), h('main', { class: 'page' }, h('p', { class: 'error' }, x.message))); } }
    if (state.account.banned) return viewBanned();
    if (!state.account.rulesAccepted) return viewRules();

    if (parts[0] === 'c' && parts[1]) {
      try {
        if (courseCache.id !== parts[1]) { courseCache = { id: parts[1], ctx: await loadCourse(parts[1]) }; }
      } catch (x) { courseCache = { id: null, ctx: null }; return show(topBar('#/'), h('main', { class: 'page' }, h('div', { class: 'card empty' }, x.message))); }
      if (parts[2] === 'chat') return viewChat(courseCache.ctx, parts[3]);
      return viewLibrary(courseCache.ctx);
    }
    if (parts[0] === 'join' && location.hash !== '#/') { history.replaceState(null, '', '#/'); }
    return viewCourses();
  }

  var started = false;
  sb.auth.onAuthStateChange(function (_event, session) {
    var was = state.session ? state.session.user.id : null, now = session ? session.user.id : null;
    state.session = session; state.user = session ? session.user : null;
    if (!started || now !== was) { started = true; state.account = null; courseCache = { id: null, ctx: null }; setTimeout(route, 0); }
  });
  // The first auth event (INITIAL_SESSION) also draws the first screen.
  window.addEventListener('hashchange', route);
})();
