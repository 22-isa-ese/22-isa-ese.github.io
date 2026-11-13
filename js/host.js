/* チキンレース: 親(司会)画面。ゲーム状態の正本を持ち、物理計算・進行・保存を行う。 */
(function () {
  'use strict';
  const CG = window.CG;
  const U = CG.ui;
  const esc = U.esc;
  const $ = (id) => document.getElementById(id);

  const LS_ROOMS = 'cg-host-rooms';
  const lsState = (r) => 'cg-host-state-' + r;
  const lsSnaps = (r) => 'cg-host-snaps-' + r;
  const MAX_SNAPS = 250;

  let room = null;
  let net = null;
  let state = null;
  let snaps = [];
  let board = null;
  let proxy = false; // 代理投球モード
  let pendingShot = null; // 最短投球間隔待ちの投球
  let tab = 'play';
  let lastStepAt = 0;
  let acc = 0;
  let lastPublish = 0;
  let lastLive = 0;
  let online = true;
  const lastSeen = {}; // pid → 最後に通信があった時刻

  /* ---------- 状態・保存 ---------- */

  function newState() {
    return {
      app: CG.APP,
      ver: 1,
      room: room,
      epoch: Date.now(),
      rev: 0,
      phase: 'lobby', // lobby → judge ⇄ shoot → result
      q: 0,
      players: [], // 並び順 = 事前順位
      judge: {},
      queue: [],
      turn: 0,
      passed: {},
      nextShotTick: 0,
      cfg: CG.defaultCfg(),
      sim: CG.newSim(),
      reject: null,
    };
  }

  function publishOnly() {
    state.rev++;
    const s = JSON.stringify(state);
    try {
      localStorage.setItem(lsState(room), s);
    } catch (err) {
      console.warn(err);
    }
    if (net) net.publish(s);
    lastPublish = performance.now();
  }

  function changed() {
    publishOnly();
    renderHeader();
    renderPanel(false);
  }

  function saveSnaps() {
    for (;;) {
      try {
        localStorage.setItem(lsSnaps(room), JSON.stringify(snaps));
        return;
      } catch (err) {
        if (snaps.length <= 10) return;
        snaps.splice(0, Math.ceil(snaps.length / 3)); // 容量超過時は古い履歴から削る
      }
    }
  }

  function snapshot(label) {
    snaps.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), label: label, at: Date.now(), s: JSON.stringify(state) });
    if (snaps.length > MAX_SNAPS) snaps.splice(0, snaps.length - MAX_SNAPS);
    saveSnaps();
  }

  async function restore(id) {
    const sn = snaps.find((x) => x.id === id);
    if (!sn) return;
    const ok = await U.confirm('「' + sn.label + '」の時点に戻します。\n全員の画面に反映されます(設定は現在の値を維持)。', '戻す');
    if (!ok) return;
    const s = JSON.parse(sn.s);
    const cur = state;
    s.cfg = cur.cfg;
    s.rev = cur.rev;
    s.room = room;
    s.epoch = Date.now();
    s.reject = null;
    cur.players.forEach((p) => {
      const old = s.players.find((x) => x.id === p.id);
      if (old) old.name = p.name;
      else s.players.push(p); // 後から参加した人は残す
    });
    state = s;
    pendingShot = null;
    proxy = false;
    lastStepAt = performance.now();
    acc = 0;
    changed();
    U.toast('「' + sn.label + '」に戻しました');
  }

  /* ---------- シミュレーションの進行 ---------- */

  function advance() {
    if (!state) return;
    const now = performance.now();
    if (!CG.simMoving(state.sim)) {
      lastStepAt = now;
      acc = 0;
      return;
    }
    acc += now - lastStepAt;
    lastStepAt = now;
    const tickMs = 1000 / CG.HZ;
    let n = Math.floor(acc / tickMs);
    acc -= n * tickMs;
    if (n > CG.HZ * 30) n = CG.HZ * 30;
    for (let i = 0; i < n; i++) {
      CG.stepSim(state.sim, state.cfg);
      if (pendingShot && state.sim.tick >= state.nextShotTick) firePending();
      if (!CG.simMoving(state.sim)) {
        onRest();
        break;
      }
    }
    if (CG.simMoving(state.sim) && now - lastPublish > 1000) publishOnly();
  }

  function firePending() {
    const p = pendingShot;
    pendingShot = null;
    doShot(p.pid, p.x, p.vx, p.vy);
  }

  function onRest() {
    if (pendingShot) {
      firePending();
      if (CG.simMoving(state.sim)) return;
    }
    if (!maybeEndQuestion()) changed();
  }

  /* ---------- 進行 ---------- */

  function startGame() {
    if (state.players.length < 1) {
      U.toast('プレイヤーがいません', 'bad');
      return;
    }
    state.phase = 'judge';
    state.q = 1;
    state.judge = {};
    state.queue = [];
    state.turn = 0;
    state.passed = {};
    state.sim = CG.newSim();
    state.epoch = Date.now();
    snapshot('第1問 正誤入力前(ゲーム開始)');
    changed();
  }

  function confirmJudge() {
    advance();
    if (state.phase !== 'judge') return;
    const rows = CG.ranking(state.players, state.sim.balls);
    // 順位が高い人(リードしている人)から投げる
    state.queue = rows.filter((r) => state.judge[r.p.id]).map((r) => r.p.id);
    state.turn = 0;
    state.passed = {};
    state.nextShotTick = 0;
    state.phase = 'shoot';
    snapshot('第' + state.q + '問 正誤確定(正解 ' + state.queue.length + ' 人)');
    if (!state.queue.length) U.toast('正解者なし。次の問題へ進みます');
    if (!maybeEndQuestion()) changed();
  }

  function endQuestion() {
    proxy = false;
    pendingShot = null;
    if (state.q >= state.cfg.questions) {
      state.phase = 'result';
      snapshot('最終結果');
    } else {
      state.q++;
      state.phase = 'judge';
      state.judge = {};
      state.queue = [];
      state.turn = 0;
      state.passed = {};
      snapshot('第' + state.q + '問 正誤入力前');
    }
    changed();
  }

  // 全員が投げ終わり、全ボールが止まったら自動で次へ
  function maybeEndQuestion() {
    if (state.phase === 'shoot' && state.turn >= state.queue.length && !CG.simMoving(state.sim)) {
      endQuestion();
      return true;
    }
    return false;
  }

  function requestShot(pid, x, vx, vy) {
    advance();
    if (state.phase !== 'shoot' || state.queue[state.turn] !== pid || pendingShot) return;
    if (![x, vx, vy].every(Number.isFinite) || !(vy < 0)) return;
    if (CG.simMoving(state.sim) && state.sim.tick < state.nextShotTick) {
      pendingShot = { pid: pid, x: x, vx: vx, vy: vy }; // 最短投球間隔に達したら発射
      return;
    }
    doShot(pid, x, vx, vy);
  }

  function doShot(pid, x, vx, vy) {
    const c = state.cfg;
    const p = CG.playerById(state, pid);
    if (!p || state.phase !== 'shoot' || state.queue[state.turn] !== pid) return;
    x = Math.max(c.radius, Math.min(c.tableW - c.radius, x));
    const sp = Math.sqrt(vx * vx + vy * vy);
    if (sp > c.maxSpeed) {
      vx *= c.maxSpeed / sp;
      vy *= c.maxSpeed / sp;
    }
    if (CG.launchBlocked(state.sim.balls, c, x)) {
      state.reject = { pid: pid, msg: '発射位置に他のボールがあります。位置をずらしてください。', n: Date.now() };
      changed();
      return;
    }
    snapshot('第' + state.q + '問 ' + p.name + ' の投球前');
    state.sim.balls.push({ id: state.sim.nextId++, o: pid, x: x, y: CG.launchY(c), vx: vx, vy: vy, q: state.q, f: 0 });
    state.turn++;
    state.nextShotTick = state.sim.tick + Math.round(c.minShotInterval * CG.HZ);
    proxy = false;
    changed();
  }

  function passTurn() {
    advance();
    if (state.phase !== 'shoot') return;
    const pid = state.queue[state.turn];
    const p = pid && CG.playerById(state, pid);
    if (!p) return;
    snapshot('第' + state.q + '問 ' + p.name + ' のパス前');
    state.passed[pid] = true;
    state.turn++;
    pendingShot = null;
    proxy = false;
    if (!maybeEndQuestion()) changed();
  }

  async function resetGame() {
    const ok = await U.confirm('ゲームをリセットしてロビーに戻ります。盤上のボールはすべて消えます(履歴からは戻せます)。', 'リセット');
    if (!ok) return;
    state.phase = 'lobby';
    state.q = 0;
    state.judge = {};
    state.queue = [];
    state.turn = 0;
    state.passed = {};
    state.sim = CG.newSim();
    state.epoch = Date.now();
    pendingShot = null;
    proxy = false;
    changed();
  }

  /* ---------- プレイヤー管理 ---------- */

  function addPlayer(pid, name) {
    const used = state.players.map((p) => p.color);
    const color = CG.COLORS.find((c) => used.indexOf(c) < 0) || CG.COLORS[state.players.length % CG.COLORS.length];
    state.players.push({ id: pid, name: name, color: color });
  }

  function addPlayerByHost() {
    const inp = $('addName');
    const name = inp ? inp.value.trim().slice(0, 12) : '';
    if (!name) return;
    if (state.players.length >= CG.MAX_PLAYERS) {
      U.toast('最大 ' + CG.MAX_PLAYERS + ' 人までです', 'bad');
      return;
    }
    addPlayer('H' + CG.randomId(8), name);
    inp.value = '';
    changed();
  }

  async function removePlayer(pid) {
    const p = CG.playerById(state, pid);
    if (!p) return;
    if (state.phase !== 'lobby') {
      const ok = await U.confirm(p.name + ' を削除します。盤上のボールも取り除かれます。', '削除');
      if (!ok) return;
    }
    advance();
    state.players = state.players.filter((x) => x.id !== pid);
    state.sim.balls = state.sim.balls.filter((b) => b.o !== pid);
    delete state.judge[pid];
    const qi = state.queue.indexOf(pid);
    if (qi >= 0) {
      state.queue.splice(qi, 1);
      if (qi < state.turn) state.turn--;
    }
    if (pendingShot && pendingShot.pid === pid) pendingShot = null;
    if (!maybeEndQuestion()) changed();
  }

  function movePlayer(pid, d) {
    const i = state.players.findIndex((p) => p.id === pid);
    const j = i + d;
    if (i < 0 || j < 0 || j >= state.players.length) return;
    const t = state.players[i];
    state.players[i] = state.players[j];
    state.players[j] = t;
    changed();
  }

  async function renamePlayer(pid) {
    const p = CG.playerById(state, pid);
    if (!p) return;
    const v = await U.prompt('プレイヤー名(12文字まで)', p.name);
    if (v === null) return;
    const name = v.trim().slice(0, 12);
    if (!name) return;
    p.name = name;
    changed();
  }

  function shufflePlayers() {
    const a = state.players;
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    changed();
  }

  /* ---------- 子からの操作 ---------- */

  function handleAction(a) {
    if (!state || !a || typeof a !== 'object') return;
    advance();
    const pid = String(a.pid || '');
    if (pid) lastSeen[pid] = Date.now();
    if (a.t === 'join') {
      const name = String(a.name || '').trim().slice(0, 12);
      if (!pid || !name || CG.playerById(state, pid)) return;
      if (state.players.length >= CG.MAX_PLAYERS) {
        state.reject = { pid: pid, msg: '満員です(最大 ' + CG.MAX_PLAYERS + ' 人)', n: Date.now() };
        changed();
        return;
      }
      addPlayer(pid, name);
      changed();
    } else if (a.t === 'shot') {
      if (a.q !== state.q) return;
      requestShot(pid, Number(a.x), Number(a.vx), Number(a.vy));
    }
    updateConn();
  }

  /* ---------- 表示 ---------- */

  function shareUrl() {
    const u = new URL('player.html', location.href);
    u.search = location.search;
    u.hash = 'room=' + room;
    return u.href;
  }

  function renderHeader() {
    $('roomCode').textContent = room;
    $('phase').textContent = U.phaseLabel(state);
    const m = $('mode');
    if (net.mode === 'firebase') {
      m.textContent = online ? 'オンライン' : '接続が切れています';
      m.className = 'badge' + (online ? '' : ' bad');
    } else {
      m.textContent = 'お試しモード(このブラウザ内のみ)';
      m.className = 'badge warn';
    }
  }

  function playRank() {
    if (state.phase === 'judge') {
      return U.rankTable(state, state.sim.balls, {
        conn: true,
        extraTitle: '正誤',
        extra: (r) => {
          const on = !!state.judge[r.p.id];
          return '<button class="btn small' + (on ? ' on' : '') + '" data-act="judge" data-pid="' + esc(r.p.id) + '">' + (on ? '○ 正解' : '× 不正解') + '</button>';
        },
      });
    }
    if (state.phase === 'shoot') {
      return U.rankTable(state, state.sim.balls, { conn: true, extraTitle: '投球', extra: (r) => U.shootStatus(state, r.p.id) });
    }
    return U.rankTable(state, state.sim.balls, { conn: true });
  }

  function playerRows(withOrder) {
    let h = '<div class="plist">';
    state.players.forEach((p, i) => {
      h +=
        '<div class="p"><span class="no">' + (i + 1) + '</span>' + U.chip(p.color) + '<span class="name">' + esc(p.name) +
        '<i class="conn" data-conn="' + esc(p.id) + '"></i></span>' +
        (withOrder
          ? '<button class="btn small" data-act="up" data-pid="' + esc(p.id) + '" title="上へ">▲</button>' +
            '<button class="btn small" data-act="down" data-pid="' + esc(p.id) + '" title="下へ">▼</button>'
          : '') +
        '<button class="btn small" data-act="rename" data-pid="' + esc(p.id) + '">名前</button>' +
        '<button class="btn small danger" data-act="remove" data-pid="' + esc(p.id) + '" title="削除">✕</button></div>';
    });
    if (!state.players.length) h += '<p class="muted small-text">まだ誰も参加していません。</p>';
    h += '</div>';
    h +=
      '<div class="row"><input class="inp grow" id="addName" data-keep maxlength="12" placeholder="プレイヤー名を入力して追加">' +
      '<button class="btn" data-act="add">追加</button></div>';
    return h;
  }

  function renderPlay() {
    const st = state;
    let h = '';
    if (st.phase === 'lobby') {
      h += '<h2>参加受付中(' + st.players.length + ' / ' + CG.MAX_PLAYERS + ' 人)</h2>';
      h += '<p class="muted small-text">参加URLを配って全員の参加を確認してください。並び順が事前順位です(上ほど上位)。</p>';
      h += playerRows(true);
      h += '<div class="row"><button class="btn" data-act="shuffle">事前順位をシャッフル</button></div>';
      h += '<button class="btn primary big" data-act="start">ゲーム開始</button>';
    } else if (st.phase === 'judge') {
      const k = st.players.filter((p) => st.judge[p.id]).length;
      h += '<h2>第' + st.q + '問 正誤入力</h2>';
      h += '<p class="muted small-text">正解者を○にして確定すると、順位の高い人(リードしている人)から順に投球が始まります。</p>';
      h += '<div id="rankBox">' + playRank() + '</div>';
      h += '<div class="row"><button class="btn small" data-act="allOk">全員○</button><button class="btn small" data-act="allNg">全員×</button></div>';
      h += '<button class="btn primary big" data-act="confirm">確定して投球へ(正解 ' + k + ' 人)</button>';
    } else if (st.phase === 'shoot') {
      const cur = CG.playerById(st, st.queue[st.turn]);
      h += '<h2>第' + st.q + '問 投球</h2>';
      h += '<div class="queue">';
      st.queue.forEach((pid, i) => {
        const p = CG.playerById(st, pid);
        if (!p) return;
        h += '<span class="q' + (i < st.turn ? ' done' : i === st.turn ? ' cur' : '') + '">' + U.chip(p.color) + esc(p.name) + '</span>';
      });
      h += '</div>';
      if (cur) {
        h += '<div class="banner turn">' + esc(cur.name) + ' の番です' + (pendingShot ? '(発射待ち)' : '') + '</div>';
        h +=
          '<div class="row"><button class="btn' + (proxy ? ' on' : '') + '" data-act="proxy">' + (proxy ? '代理投球 ON(盤面で操作)' : '代理投球する') + '</button>' +
          '<button class="btn" data-act="pass">パスさせる</button></div>';
      } else {
        h += '<div class="banner">全員が投球しました。ボールが止まると次の問題へ進みます。</div>';
      }
      h += '<div id="rankBox">' + playRank() + '</div>';
    } else {
      const rows = CG.ranking(st.players, st.sim.balls);
      h += '<h2>最終結果</h2>';
      if (rows.length) {
        h += '<div class="banner win">優勝: ' + U.chip(rows[0].p.color) + esc(rows[0].p.name) +
          (rows[0].best === null ? '<div class="muted small-text">盤上にボールが残っていないため、事前順位で決定</div>' : '') + '</div>';
      }
      h += '<div id="rankBox">' + playRank() + '</div>';
      h += '<button class="btn" data-act="reset">新しいゲーム(ロビーに戻る)</button>';
    }
    return h;
  }

  function cfgHint(c) {
    const reach = (c.maxSpeed * c.maxSpeed) / (2 * c.friction);
    const need = Math.sqrt(2 * c.friction * CG.launchY(c)) / c.maxSpeed;
    return (
      'パワー100%で転がる距離: 約 ' + Math.round(reach) + ' mm(発射位置から対辺まで ' + Math.round(CG.launchY(c)) + ' mm)<br>' +
      '対辺ちょうどで止まるパワー: ' + (need <= 1 ? '約 ' + (need * 100).toFixed(1) + '%' : '届きません(最大初速を上げるか摩擦を下げてください)')
    );
  }

  function renderConfig() {
    const c = state.cfg;
    let h = '<h2>設定</h2><p class="muted small-text">試合中でも変更できます。「適用」を押した時点から全員に反映されます。</p><div class="box"><div class="cfg">';
    CG.CFG_FIELDS.forEach((f) => {
      h +=
        '<label for="cfg_' + f.key + '">' + esc(f.label) + (f.unit ? '<small>' + esc(f.unit) + '</small>' : '') + '</label>' +
        '<input class="inp" type="number" id="cfg_' + f.key + '" min="' + f.min + '" max="' + f.max + '" step="' + f.step + '" value="' + c[f.key] + '">';
    });
    h += '</div><p class="muted small-text" id="cfgHint">' + cfgHint(c) + '</p></div>';
    h += '<div class="row"><button class="btn primary" data-act="cfgApply">適用</button><button class="btn" data-act="cfgDefault">既定値を入力</button></div>';
    return h;
  }

  function readCfgForm() {
    const src = {};
    CG.CFG_FIELDS.forEach((f) => {
      const el = $('cfg_' + f.key);
      if (el) src[f.key] = el.value;
    });
    return CG.sanitizeCfg(src);
  }

  function fmtTime(ms) {
    const d = new Date(ms);
    const z = (n) => String(n).padStart(2, '0');
    return z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds());
  }

  function renderHistory() {
    let h = '<h2>履歴(巻き戻し)</h2><p class="muted small-text">各フェーズの開始時と各投球の直前を自動保存しています。新しい順に表示。</p>';
    h += '<div class="snaps">';
    for (let i = snaps.length - 1; i >= 0; i--) {
      const s = snaps[i];
      h += '<div class="s"><span class="t">' + fmtTime(s.at) + '</span><span class="l">' + esc(s.label) + '</span>' +
        '<button class="btn small" data-act="restore" data-id="' + esc(s.id) + '">戻す</button></div>';
    }
    if (!snaps.length) h += '<p class="muted small-text">まだ履歴はありません。</p>';
    h += '</div>';
    h += '<h3>ファイル保存</h3><div class="row"><button class="btn" data-act="export">JSONに書き出す</button><button class="btn" data-act="import">JSONから読み込む</button></div>';
    return h;
  }

  function renderRoom() {
    let h = '<h2>ルーム ' + esc(room) + '</h2>';
    h += '<div class="box"><h3>参加URL(子に配る)</h3><input class="inp" readonly id="shareUrl" value="' + esc(shareUrl()) + '">' +
      '<p class="muted small-text">' +
      (net.mode === 'firebase'
        ? '子は player.html を開いてルームコードを入力しても参加できます。'
        : 'お試しモードです。このブラウザの別タブでのみ参加できます。オンライン対戦には firebase-config.js の設定が必要です(README 参照)。') +
      '</p></div>';
    h += '<h3>プレイヤー(' + state.players.length + ' / ' + CG.MAX_PLAYERS + ' 人)</h3>' + playerRows(state.phase === 'lobby');
    h += '<h3>操作</h3><div class="row"><button class="btn danger" data-act="reset">ゲームをリセット</button>' +
      '<button class="btn danger" data-act="closeRoom">ルームを閉じる</button></div>';
    return h;
  }

  function renderPanel(force) {
    if (tab === 'config' && !force) return; // 入力中の値を消さない
    const panel = $('panel');
    const keep = {};
    panel.querySelectorAll('input[data-keep]').forEach((el) => {
      keep[el.id] = { v: el.value, f: document.activeElement === el };
    });
    const scroll = panel.scrollTop;
    panel.innerHTML = tab === 'play' ? renderPlay() : tab === 'config' ? renderConfig() : tab === 'history' ? renderHistory() : renderRoom();
    Object.keys(keep).forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.value = keep[id].v;
      if (keep[id].f) el.focus();
    });
    panel.scrollTop = scroll;
    updateConn();
  }

  function updateConn() {
    const now = Date.now();
    document.querySelectorAll('[data-conn]').forEach((el) => {
      const t = lastSeen[el.dataset.conn];
      el.classList.toggle('live', !!t && now - t < 12000);
      el.title = t && now - t < 12000 ? '接続中' : '未接続';
    });
  }

  /* ---------- 書き出し・読み込み ---------- */

  function exportJson() {
    const data = { app: CG.APP, ver: 1, exportedAt: Date.now(), state: state, snaps: snaps };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date();
    const z = (n) => String(n).padStart(2, '0');
    a.href = URL.createObjectURL(blob);
    a.download = 'chickengame-' + room + '-' + d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes()) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function importJson(file) {
    const fr = new FileReader();
    fr.onload = async () => {
      let data = null;
      try {
        data = JSON.parse(fr.result);
      } catch (err) {
        data = null;
      }
      if (!data || data.app !== CG.APP || !data.state || !data.state.sim || !Array.isArray(data.state.players)) {
        U.toast('このツールの保存ファイルではありません', 'bad');
        return;
      }
      const ok = await U.confirm('ファイルの内容で現在のゲームを置き換えます。', '読み込む');
      if (!ok) return;
      const s = data.state;
      s.room = room;
      s.epoch = Date.now();
      s.rev = state.rev;
      s.cfg = CG.sanitizeCfg(s.cfg);
      s.reject = null;
      state = s;
      snaps = Array.isArray(data.snaps) ? data.snaps : [];
      saveSnaps();
      pendingShot = null;
      proxy = false;
      lastStepAt = performance.now();
      acc = 0;
      changed();
      renderPanel(true);
      U.toast('読み込みました');
    };
    fr.readAsText(file);
  }

  /* ---------- イベント ---------- */

  function onPanelClick(e) {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const pid = el.dataset.pid;
    switch (act) {
      case 'add': addPlayerByHost(); break;
      case 'remove': removePlayer(pid); break;
      case 'up': movePlayer(pid, -1); break;
      case 'down': movePlayer(pid, 1); break;
      case 'rename': renamePlayer(pid); break;
      case 'shuffle': shufflePlayers(); break;
      case 'start': startGame(); break;
      case 'judge':
        if (state.phase === 'judge') {
          state.judge[pid] = !state.judge[pid];
          changed();
        }
        break;
      case 'allOk':
      case 'allNg':
        if (state.phase === 'judge') {
          state.judge = {};
          if (act === 'allOk') state.players.forEach((p) => (state.judge[p.id] = true));
          changed();
        }
        break;
      case 'confirm': confirmJudge(); break;
      case 'proxy':
        proxy = !proxy;
        renderPanel(false);
        break;
      case 'pass': passTurn(); break;
      case 'reset': resetGame(); break;
      case 'cfgApply':
        advance();
        state.cfg = readCfgForm();
        changed();
        renderPanel(true);
        U.toast('設定を適用しました');
        break;
      case 'cfgDefault': {
        const d = CG.defaultCfg();
        CG.CFG_FIELDS.forEach((f) => ($('cfg_' + f.key).value = d[f.key]));
        $('cfgHint').innerHTML = cfgHint(d);
        break;
      }
      case 'restore': restore(el.dataset.id); break;
      case 'export': exportJson(); break;
      case 'import': $('importFile').click(); break;
      case 'closeRoom': closeRoom(); break;
    }
  }

  async function closeRoom() {
    const ok = await U.confirm('ルームを閉じ、このブラウザの保存データと中継サーバー上のデータを削除します。元に戻せません。', '閉じる');
    if (!ok) return;
    try {
      await net.destroy();
    } catch (err) {
      console.warn(err);
    }
    localStorage.removeItem(lsState(room));
    localStorage.removeItem(lsSnaps(room));
    saveRoomList(loadRoomList().filter((r) => r.room !== room));
    location.hash = '';
    location.reload();
  }

  function frame() {
    advance();
    const cur = state.phase === 'shoot' ? CG.playerById(state, state.queue[state.turn]) : null;
    board.render({
      cfg: state.cfg,
      balls: state.sim.balls,
      players: state.players,
      me: null,
      aim: proxy && cur && !pendingShot ? { color: cur.color, label: cur.name + '(代理)' } : null,
    });
    const now = performance.now();
    if (tab === 'play' && state.phase !== 'judge' && state.phase !== 'lobby' && CG.simMoving(state.sim) && now - lastLive > 250) {
      lastLive = now;
      const box = $('rankBox');
      if (box) {
        box.innerHTML = playRank();
        updateConn();
      }
    }
    requestAnimationFrame(frame);
  }

  /* ---------- 起動 ---------- */

  function loadRoomList() {
    try {
      return JSON.parse(localStorage.getItem(LS_ROOMS) || '[]');
    } catch (err) {
      return [];
    }
  }
  function saveRoomList(list) {
    localStorage.setItem(LS_ROOMS, JSON.stringify(list.slice(0, 8)));
  }

  function showSetup() {
    $('app').hidden = true;
    $('setup').hidden = false;
    $('setupMode').textContent =
      CG.netMode() === 'firebase'
        ? 'オンライン対戦モード(Firebase 経由)'
        : 'お試しモード: firebase-config.js が未設定のため、このブラウザの別タブ同士でのみ対戦できます。';
    const list = loadRoomList();
    $('savedRooms').innerHTML = list.length
      ? '<h3 class="muted small-text">前回のルームを再開</h3>' +
        list
          .map((r) => '<button class="btn" data-room="' + esc(r.room) + '">ルーム ' + esc(r.room) + ' <span class="muted small-text">(' + new Date(r.at).toLocaleString('ja-JP') + ')</span></button>')
          .join('')
      : '';
  }

  async function start(code) {
    room = code;
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(lsState(room)) || 'null');
    } catch (err) {
      saved = null;
    }
    try {
      snaps = JSON.parse(localStorage.getItem(lsSnaps(room)) || '[]');
    } catch (err) {
      snaps = [];
    }
    try {
      net = await CG.connect(room, 'host', {
        onAction: handleAction,
        onRequest: () => state && publishOnly(),
        onStatus: (ok) => {
          online = ok;
          if (state && net) renderHeader();
        },
        onError: (err) => U.toast('通信エラー: ' + (err && err.message ? err.message : err), 'bad'),
      });
    } catch (err) {
      U.toast('接続できません: ' + err.message, 'bad');
      showSetup();
      return;
    }
    state = saved && saved.app === CG.APP ? saved : null;
    if (!state) {
      try {
        const remote = await net.fetchState();
        if (remote && remote.app === CG.APP) state = remote; // 別のPCから同じルームを引き継ぐ
      } catch (err) {
        console.warn(err);
      }
    }
    if (!state) state = newState();
    state.room = room;
    state.cfg = CG.sanitizeCfg(state.cfg);
    state.passed = state.passed || {};
    state.epoch = Date.now();

    if (location.hash !== '#room=' + room) history.replaceState(null, '', location.pathname + location.search + '#room=' + room);
    saveRoomList([{ room: room, at: Date.now() }].concat(loadRoomList().filter((r) => r.room !== room)));

    $('setup').hidden = true;
    $('app').hidden = false;
    board = CG.createBoard($('board'), {
      onShot: (s) => {
        const pid = state.queue[state.turn];
        if (proxy && pid) requestShot(pid, s.x, s.vx, s.vy);
        renderPanel(false);
      },
      onBlocked: () => U.toast('発射位置に他のボールがあります。位置をずらしてください。', 'bad'),
    });
    lastStepAt = performance.now();
    changed();
    requestAnimationFrame(frame);
    setInterval(advance, 200); // タブが裏にあっても進行させる
    setInterval(updateConn, 2000);
  }

  $('panel').addEventListener('click', onPanelClick);
  $('panel').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'addName') addPlayerByHost();
  });
  $('panel').addEventListener('input', (e) => {
    if (e.target.id && e.target.id.indexOf('cfg_') === 0 && $('cfgHint')) $('cfgHint').innerHTML = cfgHint(readCfgForm());
  });
  $('panel').addEventListener('focusin', (e) => {
    if (e.target.id === 'shareUrl') e.target.select();
  });
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b || !state) return;
    tab = b.dataset.tab;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
    $('panel').scrollTop = 0;
    renderPanel(true);
  });
  $('copyUrl').addEventListener('click', async () => {
    const ok = await U.copy(shareUrl());
    U.toast(ok ? '参加URLをコピーしました' : 'コピーできませんでした。「ルーム」タブのURLを手動でコピーしてください。', ok ? '' : 'bad');
  });
  $('importFile').addEventListener('change', (e) => {
    if (e.target.files[0]) importJson(e.target.files[0]);
    e.target.value = '';
  });
  $('newRoom').addEventListener('click', () => start(CG.randomId(6)));
  $('openRoom').addEventListener('click', () => {
    const v = $('openCode').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (v.length >= 4) start(v);
    else U.toast('ルームコードを入力してください', 'bad');
  });
  $('savedRooms').addEventListener('click', (e) => {
    const b = e.target.closest('[data-room]');
    if (b) start(b.dataset.room);
  });

  const initial = U.roomFromHash();
  if (initial) start(initial);
  else showSetup();
})();
