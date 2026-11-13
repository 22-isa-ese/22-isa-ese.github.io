/* チキンレース: 親子共通の UI 部品 */
(function (global) {
  'use strict';
  const CG = (global.CG = global.CG || {});
  const U = (CG.ui = {});

  U.esc = function (s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  };

  let toastTimer = null;
  U.toast = function (msg, kind) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = 'show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.className = ''), 3200);
  };

  function modal(html, onReady) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'modal-ov';
      ov.innerHTML = '<div class="modal">' + html + '</div>';
      const done = (v) => {
        ov.remove();
        resolve(v);
      };
      document.body.appendChild(ov);
      onReady(ov, done);
    });
  }

  U.confirm = function (msg, okLabel) {
    return modal(
      '<p>' + U.esc(msg) + '</p><div class="row end"><button class="btn" data-x="0">キャンセル</button>' +
        '<button class="btn primary" data-x="1">' + U.esc(okLabel || 'OK') + '</button></div>',
      (ov, done) => {
        ov.addEventListener('click', (e) => {
          const b = e.target.closest('[data-x]');
          if (b) done(b.dataset.x === '1');
        });
      }
    );
  };

  U.prompt = function (msg, def) {
    return modal(
      '<p>' + U.esc(msg) + '</p><input class="inp" maxlength="12" value="' + U.esc(def || '') + '">' +
        '<div class="row end"><button class="btn" data-x="0">キャンセル</button><button class="btn primary" data-x="1">OK</button></div>',
      (ov, done) => {
        const inp = ov.querySelector('input');
        inp.focus();
        inp.select();
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') done(inp.value);
        });
        ov.addEventListener('click', (e) => {
          const b = e.target.closest('[data-x]');
          if (b) done(b.dataset.x === '1' ? inp.value : null);
        });
      }
    );
  };

  U.copy = function (text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        () => true,
        () => false
      );
    }
    return Promise.resolve(false);
  };

  U.chip = function (color) {
    return '<span class="chip" style="background:' + U.esc(color) + '"></span>';
  };

  U.phaseLabel = function (st) {
    const total = st.cfg.questions;
    if (st.phase === 'lobby') return '参加受付中';
    if (st.phase === 'judge') return '第' + st.q + '問 / 全' + total + '問 ・ 正誤判定';
    if (st.phase === 'shoot') return '第' + st.q + '問 / 全' + total + '問 ・ 投球';
    return '最終結果';
  };

  // 投球フェーズでの各プレイヤーの状態
  U.shootStatus = function (st, pid) {
    if (st.phase !== 'shoot') return '';
    const idx = st.queue.indexOf(pid);
    if (idx < 0) return '<span class="muted">不正解</span>';
    if (idx < st.turn) return st.passed && st.passed[pid] ? '<span class="muted">パス</span>' : '<span class="done">投球済</span>';
    if (idx === st.turn) return '<b class="now">投球の番</b>';
    return '<span class="muted">待ち ' + (idx - st.turn) + '</span>';
  };

  /* 順位表。opt: { me, extraTitle, extra(row) → html } */
  U.rankTable = function (st, balls, opt) {
    opt = opt || {};
    const rows = CG.ranking(st.players, balls);
    let h =
      '<table class="rank"><thead><tr><th>順位</th><th>プレイヤー</th><th class="num">対辺まで</th><th class="num">球</th>' +
      (opt.extra ? '<th>' + U.esc(opt.extraTitle || '') + '</th>' : '') +
      '</tr></thead><tbody>';
    rows.forEach((r) => {
      h +=
        '<tr class="' + (opt.me && r.p.id === opt.me ? 'me' : '') + '"><td class="rk">' + r.rank + '</td><td class="nm">' +
        U.chip(r.p.color) + '<span>' + U.esc(r.p.name) + '</span>' +
        (opt.conn ? '<i class="conn" data-conn="' + U.esc(r.p.id) + '"></i>' : '') +
        '</td><td class="num">' + (r.best === null ? '—' : r.best.toFixed(1) + ' mm') + '</td><td class="num">' + r.count + '</td>' +
        (opt.extra ? '<td class="ex">' + opt.extra(r) + '</td>' : '') +
        '</tr>';
    });
    if (!rows.length) h += '<tr><td colspan="5" class="muted">プレイヤーがいません</td></tr>';
    return h + '</tbody></table>';
  };

  U.roomFromHash = function () {
    const m = /room=([A-Za-z0-9]+)/.exec(global.location.hash);
    return m ? m[1].toUpperCase() : null;
  };
})(window);
