/* チキンレース: 子(プレイヤー)画面。親の状態を表示し、自分の番に投球を送る。 */
(function () {
  'use strict';
  const CG = window.CG;
  const U = CG.ui;
  const esc = U.esc;
  const $ = (id) => document.getElementById(id);
  const ssKey = (r) => 'cg-player-' + r;

  let room = null;
  let net = null;
  let state = null;
  let me = null; // 自分のプレイヤーID
  let spectator = false;
  let joinPending = null; // {pid, at}
  let sent = null; // 送信済みの投球 {key, at}
  let lastRejectN = null;
  let lastLive = 0;
  let panelVer = -1;
  let board = null;
  const csim = new CG.ClientSim();

  function turnKey(st) {
    return st.epoch + ':' + st.q + ':' + st.turn;
  }

  function onState(st) {
    if (!st || st.app !== CG.APP) return;
    const first = !state;
    state = st;
    csim.push(st, performance.now());

    if (first) lastRejectN = st.reject ? st.reject.n : null;
    const target = joinPending ? joinPending.pid : me;
    if (st.reject && st.reject.n !== lastRejectN) {
      lastRejectN = st.reject.n;
      if (st.reject.pid === target) {
        U.toast(st.reject.msg, 'bad');
        sent = null;
        joinPending = null;
      }
    }
    if (joinPending && CG.playerById(st, joinPending.pid)) {
      me = joinPending.pid;
      joinPending = null;
      sessionStorage.setItem(ssKey(room), me);
      heartbeat();
    }
    if (me && !CG.playerById(st, me)) {
      me = null; // 親に削除された
      sessionStorage.removeItem(ssKey(room));
    }
    render();
  }

  function heartbeat() {
    if (net && me) net.send({ t: 'hb', pid: me });
  }

  function canShoot() {
    if (!state || !me || state.phase !== 'shoot' || state.queue[state.turn] !== me) return false;
    return !(sent && sent.key === turnKey(state) && performance.now() - sent.at < 4000);
  }

  /* ---------- 表示 ---------- */

  function statusBanner() {
    const st = state;
    const mine = me ? CG.playerById(st, me) : null;
    if (st.phase === 'lobby') return '<div class="banner">' + (mine ? '参加しました。ゲーム開始を待っています。' : '参加受付中です。') + '</div>';
    if (st.phase === 'judge') return '<div class="banner">第' + st.q + '問 — 正誤判定を待っています。</div>';
    if (st.phase === 'result') {
      const rows = CG.ranking(st.players, csim.cur ? csim.cur.balls : st.sim.balls);
      if (!rows.length) return '<div class="banner win">ゲーム終了</div>';
      return '<div class="banner win">優勝: ' + U.chip(rows[0].p.color) + esc(rows[0].p.name) +
        (rows[0].best === null ? '<div class="muted small-text">盤上にボールが残っていないため、事前順位で決定</div>' : '') + '</div>';
    }
    const cur = CG.playerById(st, st.queue[st.turn]);
    if (!mine) return '<div class="banner">' + (cur ? esc(cur.name) + ' の投球待ちです。' : '全員が投球しました。') + '</div>';
    const idx = st.queue.indexOf(me);
    if (idx < 0) return '<div class="banner">今回は不正解のため投球はありません。' + (cur ? '(' + esc(cur.name) + ' の番)' : '') + '</div>';
    if (idx < st.turn) return '<div class="banner">' + (st.passed && st.passed[me] ? 'パスになりました。' : '投球済みです。') + (cur ? '(' + esc(cur.name) + ' の番)' : '') + '</div>';
    if (idx === st.turn) {
      return canShoot()
        ? '<div class="banner turn">あなたの番です! 発射ライン付近を押したまま下に引っ張り、離すと発射します。</div>'
        : '<div class="banner turn">投球を送信しました…</div>';
    }
    return '<div class="banner">正解! あなたの投球は ' + (idx - st.turn) + ' 人後です。(' + esc(cur ? cur.name : '') + ' の番)</div>';
  }

  function rankHtml() {
    const balls = csim.cur ? csim.cur.balls : state.sim.balls;
    return U.rankTable(state, balls, {
      me: me,
      extraTitle: state.phase === 'shoot' ? '投球' : '',
      extra: state.phase === 'shoot' ? (r) => U.shootStatus(state, r.p.id) : null,
    });
  }

  function renderPanel() {
    const st = state;
    let h = statusBanner();
    if (st.phase === 'shoot' && st.queue.length) {
      h += '<div><h3>投球順</h3><div class="queue" style="margin-top:6px">';
      st.queue.forEach((pid, i) => {
        const p = CG.playerById(st, pid);
        if (!p) return;
        h += '<span class="q' + (i < st.turn ? ' done' : i === st.turn ? ' cur' : '') + '">' + U.chip(p.color) + esc(p.name) + '</span>';
      });
      h += '</div></div>';
    }
    h += '<div><h3>順位</h3><div id="rankBox" style="margin-top:6px">' + rankHtml() + '</div></div>';
    $('panel').innerHTML = h;
    panelVer = csim.ver;
  }

  function render() {
    const showEnter = !room;
    const showApp = !!room && !!state && (!!me || spectator);
    const showJoin = !!room && !showApp;
    $('enter').hidden = !showEnter;
    $('join').hidden = !showJoin;
    $('app').hidden = !showApp;

    if (showJoin) {
      $('joinRoom').textContent = room;
      if (!state) {
        $('joinMsg').textContent = '親(ホスト)に接続中です… 親がルームを開いているか確認してください。';
        $('joinForm').hidden = true;
      } else {
        $('joinMsg').textContent = joinPending ? '参加処理中…' : U.phaseLabel(state) + '(' + state.players.length + ' / ' + CG.MAX_PLAYERS + ' 人)';
        $('joinForm').hidden = false;
        $('joinGo').disabled = !!joinPending || state.players.length >= CG.MAX_PLAYERS;
        const box = $('resumeBox');
        box.innerHTML = state.players.length
          ? '<h3 class="muted small-text">参加済みのプレイヤーとして再開する</h3>' +
            state.players.map((p) => '<button class="btn" data-pid="' + esc(p.id) + '">' + U.chip(p.color) + esc(p.name) + '</button>').join('')
          : '';
      }
      return;
    }
    if (!showApp) return;

    const mine = me ? CG.playerById(state, me) : null;
    $('roomCode').textContent = room;
    $('meInfo').innerHTML = mine ? U.chip(mine.color) + esc(mine.name) : '<span class="muted">観戦中</span>';
    $('phase').textContent = U.phaseLabel(state);
    document.title = (canShoot() ? '★あなたの番 ' : '') + 'チキンレース(子)';
    renderPanel();
  }

  function frame() {
    if (state && !$('app').hidden) {
      const now = performance.now();
      const balls = csim.update(now) || [];
      const mine = me ? CG.playerById(state, me) : null;
      const aimOn = canShoot();
      board.render({
        cfg: csim.cfg || state.cfg,
        balls: balls,
        players: state.players,
        me: me,
        aim: aimOn && mine ? { color: mine.color, label: mine.name } : null,
      });
      // 盤面が変わっていれば順位表を更新(動いている間は間引き、停止時は必ず最終位置で更新)
      if (csim.ver !== panelVer && (!csim.moving() || now - lastLive > 250)) {
        lastLive = now;
        renderPanel();
      }
      if (sent && now - sent.at >= 4000 && sent.key === turnKey(state)) {
        sent = null; // 応答がなければ再度投げられるようにする
        render();
      }
    }
    requestAnimationFrame(frame);
  }

  /* ---------- 起動 ---------- */

  async function start(code) {
    room = code;
    if (location.hash !== '#room=' + room) history.replaceState(null, '', location.pathname + location.search + '#room=' + room);
    me = sessionStorage.getItem(ssKey(room));
    render();
    try {
      net = await CG.connect(room, 'client', {
        onState: onState,
        onStatus: (ok) => ($('offline').hidden = ok),
        onError: (err) => U.toast('通信エラー: ' + (err && err.message ? err.message : err), 'bad'),
      });
    } catch (err) {
      U.toast('接続できません: ' + err.message, 'bad');
      return;
    }
    heartbeat();
    setInterval(heartbeat, 4000);
    setInterval(() => {
      if (joinPending && Date.now() - joinPending.at > 6000) {
        joinPending = null;
        U.toast('親から応答がありません。もう一度お試しください。', 'bad');
        render();
      }
    }, 1000);
  }

  board = CG.createBoard($('board'), {
    onShot: (s) => {
      if (!canShoot()) return;
      net.send({ t: 'shot', pid: me, q: state.q, x: s.x, vx: s.vx, vy: s.vy });
      sent = { key: turnKey(state), at: performance.now() };
      render();
    },
    onBlocked: () => U.toast('発射位置に他のボールがあります。位置をずらしてください。', 'bad'),
  });
  requestAnimationFrame(frame);

  function join() {
    const name = $('nameInput').value.trim().slice(0, 12);
    if (!name) {
      U.toast('名前を入力してください', 'bad');
      return;
    }
    if (!net || joinPending) return;
    joinPending = { pid: 'P' + CG.randomId(10), at: Date.now() };
    spectator = false;
    net.send({ t: 'join', pid: joinPending.pid, name: name });
    render();
  }

  $('joinGo').addEventListener('click', join);
  $('nameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') join();
  });
  $('resumeBox').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pid]');
    if (!b) return;
    me = b.dataset.pid;
    spectator = false;
    sessionStorage.setItem(ssKey(room), me);
    heartbeat();
    render();
  });
  $('watchGo').addEventListener('click', () => {
    spectator = true;
    render();
  });
  $('leave').addEventListener('click', () => {
    me = null;
    spectator = false;
    sent = null;
    sessionStorage.removeItem(ssKey(room));
    render();
  });
  function enterRoom() {
    const v = $('roomInput').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (v.length >= 4) start(v);
    else U.toast('ルームコードを入力してください', 'bad');
  }
  $('roomGo').addEventListener('click', enterRoom);
  $('roomInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') enterRoom();
  });

  const initial = U.roomFromHash();
  if (initial) start(initial);
  else render();
})();
