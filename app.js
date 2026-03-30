(function () {
  const API = '/api';
  const tokenKey = 'stackit_token';
  const themeKey = 'stackit_theme';
  let token = localStorage.getItem(tokenKey) || '';
  let me = null;
  let currentQuestion = null;
  let currentSort = 'newest';
  let currentSearch = '';
  let authMode = 'login';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function setThemeButtonLabel(theme) {
    const btn = $('#themeToggleBtn');
    if (!btn) return;
    btn.textContent = theme === 'dark' ? 'Light Mode' : 'Dark Mode';
  }

  function applyTheme(theme) {
    const normalized = theme === 'dark' ? 'dark' : 'light';
    document.body.setAttribute('data-theme', normalized);
    localStorage.setItem(themeKey, normalized);
    setThemeButtonLabel(normalized);
  }

  function toggleTheme() {
    const current = document.body.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  }

  function initTheme() {
    const saved = localStorage.getItem(themeKey) || 'dark';
    applyTheme(saved);
  }

  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`${API}${path}`, { ...options, headers });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      throw new Error((data && data.error) || 'Request failed');
    }
    return data;
  }

  function formatTime(ts) {
    const ms = Date.now() - new Date(ts).getTime();
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }

  function safeExcerpt(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    return (div.textContent || '').slice(0, 180);
  }

  function avatarBg(name) {
    const colors = ['var(--accent)', 'var(--blue)', 'var(--green)', 'var(--accent2)', '#9b67d8'];
    const code = (name || 'u').charCodeAt(0) || 0;
    return colors[code % colors.length];
  }

  function setAuthButtons() {
    const loginBtn = $('#loginBtn');
    const registerBtn = $('#registerBtn');
    const logoutBtn = $('#logoutBtn');
    const userBadge = $('#userBadge');
    const adminBtn = $('#adminNavBtn');
    const askNavBtn = $('#askNavBtn');

    if (!loginBtn || !registerBtn || !logoutBtn || !userBadge) return;

    const isLogged = Boolean(me);
    loginBtn.style.display = isLogged ? 'none' : 'inline-flex';
    registerBtn.style.display = isLogged ? 'none' : 'inline-flex';
    logoutBtn.style.display = isLogged ? 'inline-flex' : 'none';
    userBadge.style.display = isLogged ? 'inline-flex' : 'none';
    userBadge.textContent = isLogged ? `@${me.username} (${me.role})` : '';

    if (adminBtn) {
      adminBtn.style.display = me && me.role === 'admin' ? 'inline-flex' : 'none';
    }

    if (askNavBtn && !me) {
      askNavBtn.textContent = 'Login to Ask';
    }
    if (askNavBtn && me) {
      askNavBtn.textContent = 'Ask Question';
    }
  }

  function setAuthMessage(message, type = '') {
    const msg = $('#authMsg');
    if (!msg) return;
    msg.className = 'auth-msg';
    if (type) msg.classList.add(type);
    msg.textContent = message || '';
  }

  function switchAuthTab(mode) {
    authMode = mode === 'register' ? 'register' : 'login';
    const loginTab = $('#authTabLogin');
    const registerTab = $('#authTabRegister');
    const loginForm = $('#authLoginForm');
    const registerForm = $('#authRegisterForm');
    const title = $('#authTitle');
    const sub = $('#authSub');

    if (loginTab) loginTab.classList.toggle('active', authMode === 'login');
    if (registerTab) registerTab.classList.toggle('active', authMode === 'register');
    if (loginForm) loginForm.classList.toggle('active', authMode === 'login');
    if (registerForm) registerForm.classList.toggle('active', authMode === 'register');

    if (title) title.textContent = authMode === 'login' ? 'Welcome Back' : 'Create Account';
    if (sub) {
      sub.textContent =
        authMode === 'login'
          ? 'Login to ask questions, post answers, vote, and manage notifications.'
          : 'Sign up to join the StackIt community and start contributing.';
    }

    setAuthMessage('');
  }

  function openAuth(mode = 'login') {
    switchAuthTab(mode);
    showView('auth');
  }

  function collectAskTags() {
    return $$('#tagsBox .tag-chip').map((chip) => chip.textContent.replace('×', '').trim());
  }

  async function refreshQuestions() {
    const list = await api(`/questions?sort=${encodeURIComponent(currentSort)}&search=${encodeURIComponent(currentSearch)}`);
    const listEl = $('#questionList');
    const countEl = $('#questionCount');
    if (!listEl) return;

    countEl.textContent = `${list.length.toLocaleString()} questions across all topics`;

    listEl.innerHTML = list
      .map((q) => {
        const answered = Number(q.answers_count) > 0 ? 'answered' : '';
        const tags = (q.tags || [])
          .map((t) => `<span class="tag">${t}</span>`)
          .join('');
        const initial = (q.username || 'U')[0].toUpperCase();
        return `
          <div class="q-card ${answered}" onclick="openQuestion(${q.id})">
            <div class="q-stats">
              <div class="q-stat ${answered ? 'accepted' : ''}"><div class="q-stat-num">${q.votes}</div><div class="q-stat-label">votes</div></div>
              <div class="q-stat-div"></div>
              <div class="q-stat ${answered ? 'accepted' : ''}"><div class="q-stat-num">${q.answers_count}</div><div class="q-stat-label">answers</div></div>
            </div>
            <div class="q-body">
              <div class="q-title">${q.title}</div>
              <div class="q-excerpt">${safeExcerpt(q.description)}</div>
              <div class="q-meta">
                ${tags}
                <div class="q-footer">
                  <div class="avatar-sm" style="background:${avatarBg(q.username)}">${initial}</div>
                  ${q.username} · ${formatTime(q.created_at)}
                </div>
              </div>
            </div>
          </div>`;
      })
      .join('');

    const hot = $('.right-panel .widget');
    if (hot) {
      const top = list.slice(0, 5)
        .map(
          (q, idx) => `
          <div class="hot-q" onclick="openQuestion(${q.id})">
            <div class="hot-num">${idx + 1}</div>
            <div class="hot-title">${q.title}</div>
          </div>`
        )
        .join('');
      hot.innerHTML = `<div class="widget-title">Hot This Week</div>${top}`;
    }
  }

  async function openQuestion(id) {
    const q = await api(`/questions/${id}`);
    currentQuestion = q;

    const view = $('#view-question');
    if (!view) return;

    const tags = (q.tags || []).map((t) => `<span class="tag">${t.name}</span>`).join('');
    const answersHtml = (q.answers || [])
      .map((a) => {
        const accepted = a.is_accepted ? 'accepted' : '';
        const canAccept = me && me.id === q.user_id;
        return `
          <div class="answer-card ${accepted}">
            ${a.is_accepted ? '<div class="accepted-badge">Accepted Answer</div>' : ''}
            <div class="answer-meta">
              <div class="avatar" style="background:${avatarBg(a.username)}">${a.username[0].toUpperCase()}</div>
              <div class="answer-user">${a.username}</div>
              <div class="answer-time" style="margin-left:6px">· answered ${formatTime(a.created_at)}</div>
              <div style="margin-left:auto;display:flex;align-items:center;gap:8px;">
                <div style="background:var(--surface2);color:var(--text-muted);font-size:12px;padding:2px 10px;border-radius:20px;">▲ ${a.votes}</div>
              </div>
            </div>
            <div class="q-content" style="margin-bottom:12px;">${a.body}</div>
            <div style="display:flex;align-items:center;gap:8px;">
              <button class="vote-btn up ${a.myVote === 1 ? 'active-up' : ''}" onclick="voteAnswer(${a.id}, 1)">▲ Helpful</button>
              <button class="vote-btn down ${a.myVote === -1 ? 'active-down' : ''}" onclick="voteAnswer(${a.id}, -1)">▼</button>
              ${
                canAccept
                  ? `<button class="accept-btn ${accepted}" onclick="acceptAnswer(${a.id})">${accepted ? 'Accepted' : 'Accept'}</button>`
                  : ''
              }
            </div>
          </div>`;
      })
      .join('');

    view.innerHTML = `
      <button class="back-btn" onclick="showView('home')">Back to Questions</button>
      <div class="q-detail-header">
        <div class="q-detail-title">${q.title}</div>
        <div class="q-detail-meta">
          <span>Asked ${formatTime(q.created_at)}</span>
          <span>${q.answers_count} answers</span>
          <span style="margin-left:auto;display:flex;align-items:center;gap:6px;">
            <div class="avatar" style="background:${avatarBg(q.username)}">${q.username[0].toUpperCase()}</div>
            Asked by <strong style="color:var(--text)">${q.username}</strong>
          </span>
        </div>
      </div>

      <div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;">${tags}</div>

      <div class="q-content">${q.description}</div>

      <div class="vote-row">
        <button class="vote-btn up ${q.myQuestionVote === 1 ? 'active-up' : ''}" onclick="voteQuestion(${q.id}, 1)">Upvote · ${q.votes}</button>
        <button class="vote-btn down ${q.myQuestionVote === -1 ? 'active-down' : ''}" onclick="voteQuestion(${q.id}, -1)">Downvote</button>
      </div>

      <div class="answers-section">
        <div class="answers-title">Answers <span class="answers-count">${q.answers_count}</span></div>
        ${answersHtml || '<div class="q-content">No answers yet. Be the first to answer.</div>'}

        <div class="answer-form">
          <div class="answer-form-title">Your Answer</div>
          <div class="editor-box">
            <div class="editor-toolbar">
              <button class="tb-btn" title="Bold" onclick="execCmd('bold',this)"><strong>B</strong></button>
              <button class="tb-btn" title="Italic" onclick="execCmd('italic',this)"><em>I</em></button>
              <button class="tb-btn" title="Strikethrough" onclick="execCmd('strikeThrough',this)"><s>S</s></button>
              <div class="tb-sep"></div>
              <button class="tb-btn" title="Ordered List" onclick="execCmd('insertOrderedList',this)">1.</button>
              <button class="tb-btn" title="Bullet List" onclick="execCmd('insertUnorderedList',this)">•</button>
              <div class="tb-sep"></div>
              <button class="tb-btn" title="Align Left" onclick="execCmd('justifyLeft',this)">L</button>
              <button class="tb-btn" title="Align Center" onclick="execCmd('justifyCenter',this)">C</button>
              <button class="tb-btn" title="Align Right" onclick="execCmd('justifyRight',this)">R</button>
              <div class="tb-sep"></div>
              <button class="tb-btn" title="Insert Link" onclick="insertLink()">Link</button>
              <button class="tb-btn" title="Insert Emoji" onclick="insertEmoji()">😊</button>
            </div>
            <div class="editor-area" contenteditable="true" id="answerEditor" data-placeholder="Write your answer here"></div>
          </div>
          <div style="display:flex;justify-content:flex-end;margin-top:12px;">
            <button class="btn btn-primary" onclick="submitAnswer()">Post Answer</button>
          </div>
        </div>
      </div>
    `;

    document.querySelectorAll('.editor-area').forEach((area) => {
      area.addEventListener('focus', () => {
        window.activeEditor = area;
      });
    });

    showView('question');
  }

  async function voteQuestion(questionId, value) {
    if (!token) return alert('Please login to vote.');
    await api(`/questions/${questionId}/vote`, {
      method: 'POST',
      body: JSON.stringify({ value })
    });
    await openQuestion(questionId);
    await refreshQuestions();
  }

  async function voteAnswer(answerId, value) {
    if (!token) return alert('Please login to vote.');
    await api(`/answers/${answerId}/vote`, {
      method: 'POST',
      body: JSON.stringify({ value })
    });
    if (currentQuestion) await openQuestion(currentQuestion.id);
  }

  async function acceptAnswer(answerId) {
    if (!token || !currentQuestion) return alert('Unauthorized');
    await api(`/answers/${answerId}/accept`, { method: 'POST' });
    await openQuestion(currentQuestion.id);
    await refreshQuestions();
  }

  async function submitAnswer() {
    if (!token) return alert('Only logged-in users can post answers.');
    if (!currentQuestion) return;
    const editor = $('#answerEditor');
    const body = editor ? editor.innerHTML.trim() : '';
    if (!body) return alert('Answer is required.');

    await api('/answers', {
      method: 'POST',
      body: JSON.stringify({ questionId: currentQuestion.id, body })
    });

    await openQuestion(currentQuestion.id);
    await refreshQuestions();
    await refreshNotifications();
  }

  async function refreshNotifications() {
    const badge = $('#notifBadge');
    const drop = $('#notifDrop');
    if (!badge || !drop) return;

    if (!token) {
      badge.textContent = '0';
      const list = $('#notifList');
      if (list) list.innerHTML = '<div class="notif-item"><div><div class="notif-item-text">Login to see notifications.</div></div></div>';
      return;
    }

    const data = await api('/notifications');
    badge.textContent = String(data.unread);

    const list = $('#notifList');
    if (!list) return;
    list.innerHTML = data.items.length
      ? data.items
          .map(
            (n) => `
          <div class="notif-item ${n.is_read ? '' : 'unread'}" onclick="notificationOpen(${n.question_id || 0})">
            ${n.is_read ? '<div style="width:7px;flex-shrink:0"></div>' : '<div class="notif-dot"></div>'}
            <div>
              <div class="notif-item-text">${n.text}</div>
              <div class="notif-time">${formatTime(n.created_at)}</div>
            </div>
          </div>`
          )
          .join('')
      : '<div class="notif-item"><div><div class="notif-item-text">No notifications yet.</div></div></div>';
  }

  async function notificationOpen(questionId) {
    if (questionId) await openQuestion(questionId);
    closeNotif();
  }

  async function markNotificationsRead() {
    if (!token) return;
    await api('/notifications/read-all', { method: 'POST' });
    await refreshNotifications();
  }

  async function submitAuthForm(mode) {
    const isRegister = mode === 'register';
    const usernameInput = $(isRegister ? '#registerUsername' : '#loginUsername');
    const passwordInput = $(isRegister ? '#registerPassword' : '#loginPassword');
    const username = usernameInput ? usernameInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';

    if (!username || username.length < 3) {
      setAuthMessage('Username must be at least 3 characters.', 'error');
      if (usernameInput) usernameInput.focus();
      return;
    }

    if (!password || password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      setAuthMessage('Password must be 8+ chars and include at least one letter and one number.', 'error');
      if (passwordInput) passwordInput.focus();
      return;
    }

    const data = await api(`/auth/${isRegister ? 'register' : 'login'}`, {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });

    token = data.token;
    localStorage.setItem(tokenKey, token);
    me = data.user;
    setAuthButtons();
    setAuthMessage(isRegister ? 'Account created. You are now logged in.' : 'Login successful.', 'success');

    if (usernameInput) usernameInput.value = '';
    if (passwordInput) passwordInput.value = '';

    showView('home');
    await refreshQuestions();
    await refreshNotifications();
  }

  function logoutFlow() {
    token = '';
    me = null;
    localStorage.removeItem(tokenKey);
    setAuthButtons();
    setAuthMessage('');
    refreshNotifications().catch(() => {});
  }

  async function submitQuestion() {
    if (!token) {
      alert('Only logged-in users can post questions.');
      return;
    }

    const titleEl = $('#qTitle');
    const title = titleEl ? titleEl.value.trim() : '';
    const askEditor = $('#askEditor');
    const description = askEditor ? askEditor.innerHTML.trim() : '';
    const tags = collectAskTags();

    if (!title) {
      if (titleEl) {
        titleEl.style.borderColor = 'var(--accent2)';
        titleEl.focus();
      }
      return;
    }
    if (!description) return alert('Description is required');
    if (!tags.length) return alert('Please add at least one tag');

    await api('/questions', {
      method: 'POST',
      body: JSON.stringify({ title, description, tags })
    });

    if (titleEl) titleEl.value = '';
    if (askEditor) askEditor.innerHTML = '';
    showView('home');
    await refreshQuestions();
  }

  async function ensureMe() {
    if (!token) return;
    try {
      const data = await api('/me');
      me = data.user;
    } catch {
      token = '';
      me = null;
      localStorage.removeItem(tokenKey);
    }
  }

  function bindEvents() {
    const search = $('#searchInput');
    let t = null;
    if (search) {
      search.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => {
          currentSearch = search.value.trim();
          refreshQuestions().catch((err) => alert(err.message));
        }, 300);
      });
    }

    $$('.filter-bar .filter-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const map = {
          newest: 'newest',
          active: 'active',
          unanswered: 'unanswered',
          'most voted': 'votes'
        };
        const key = (btn.textContent || '').trim().toLowerCase();
        if (map[key]) {
          currentSort = map[key];
          refreshQuestions().catch((err) => alert(err.message));
        }
      });
    });

    const clearBtn = $('#notifClear');
    if (clearBtn) clearBtn.addEventListener('click', () => markNotificationsRead().catch((e) => alert(e.message)));

    const loginBtn = $('#loginBtn');
    const registerBtn = $('#registerBtn');
    const logoutBtn = $('#logoutBtn');
    const themeBtn = $('#themeToggleBtn');
    const askNavBtn = $('#askNavBtn');
    if (loginBtn) loginBtn.addEventListener('click', () => openAuth('login'));
    if (registerBtn) registerBtn.addEventListener('click', () => openAuth('register'));
    if (logoutBtn) logoutBtn.addEventListener('click', logoutFlow);
    if (themeBtn) themeBtn.addEventListener('click', toggleTheme);
    if (askNavBtn) {
      askNavBtn.addEventListener('click', (e) => {
        if (!me) {
          e.preventDefault();
          e.stopPropagation();
          openAuth('login');
        }
      });
    }

    const adminBtn = $('#adminNavBtn');
    if (adminBtn) {
      adminBtn.addEventListener('click', (e) => {
        if (!me || me.role !== 'admin') {
          e.preventDefault();
          e.stopPropagation();
          alert('Admin access only. Login as admin/admin123');
        }
      });
    }
  }

  window.openQuestion = (id) => openQuestion(id).catch((err) => alert(err.message));
  window.voteQuestion = (id, v) => voteQuestion(id, v).catch((err) => alert(err.message));
  window.voteAnswer = (id, v) => voteAnswer(id, v).catch((err) => alert(err.message));
  window.acceptAnswer = (id) => acceptAnswer(id).catch((err) => alert(err.message));
  window.submitAnswer = () => submitAnswer().catch((err) => alert(err.message));
  window.notificationOpen = (qid) => notificationOpen(qid).catch((err) => alert(err.message));
  window.submitQuestion = () => submitQuestion().catch((err) => alert(err.message));
  window.switchAuthTab = (mode) => switchAuthTab(mode);
  window.submitAuth = (event, mode) => {
    if (event) event.preventDefault();
    submitAuthForm(mode).catch((err) => setAuthMessage(err.message, 'error'));
  };
  window.formatTime = formatTime;

  document.addEventListener('DOMContentLoaded', async () => {
    try {
      initTheme();
      await ensureMe();
      setAuthButtons();
      bindEvents();
      await refreshQuestions();
      await refreshNotifications();
    } catch (err) {
      // Keep existing static UI if API is unavailable.
      console.error(err);
    }
  });
})();
