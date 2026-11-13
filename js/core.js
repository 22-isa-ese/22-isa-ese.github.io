/* チキンレース: 物理シミュレーション・順位計算・表示側の同期(親子共通) */
(function (global) {
  'use strict';
  const CG = (global.CG = global.CG || {});

  CG.APP = 'chickengame';
  CG.HZ = 120; // 物理の固定ステップ数/秒
  CG.DT = 1 / CG.HZ;
  CG.FALL_TICKS = 54; // 落下演出の長さ(tick)
  CG.MAX_PLAYERS = 12;

  CG.COLORS = [
    '#ff4d4d', '#ff9a2e', '#ffe14d', '#b6f04a', '#2fbf5b', '#3fd6e8',
    '#4d7dff', '#a05cff', '#ff5fd2', '#ffc2d9', '#f4f4f4', '#b07a45',
  ];

  // 試合中でも変更できる設定。長さは mm、時間は秒。
  CG.CFG_FIELDS = [
    { key: 'questions', label: '問題数', unit: '問', min: 1, max: 30, step: 1, def: 6 },
    { key: 'friction', label: '摩擦(減速度)', unit: 'mm/s²', min: 10, max: 3000, step: 10, def: 260 },
    { key: 'restitution', label: '反発係数', unit: '', min: 0, max: 1, step: 0.05, def: 0.9 },
    { key: 'maxSpeed', label: '最大初速(パワー100%)', unit: 'mm/s', min: 100, max: 4000, step: 10, def: 900 },
    { key: 'maxAngle', label: '最大発射角度', unit: '度', min: 0, max: 85, step: 1, def: 60 },
    { key: 'minShotInterval', label: '最短投球間隔', unit: '秒', min: 0, max: 10, step: 0.1, def: 1 },
    { key: 'radius', label: 'ボール半径', unit: 'mm', min: 5, max: 60, step: 1, def: 18 },
    { key: 'tableW', label: 'テーブル幅', unit: 'mm', min: 200, max: 2000, step: 10, def: 600 },
    { key: 'tableL', label: 'テーブル奥行', unit: 'mm', min: 300, max: 3000, step: 10, def: 1000 },
    { key: 'launchOffset', label: '発射位置(手前の辺からの距離)', unit: 'mm', min: 0, max: 1000, step: 10, def: 200 },
    { key: 'pullDist', label: '最大パワーになる引き距離', unit: 'mm', min: 100, max: 800, step: 10, def: 320 },
    { key: 'guideLen', label: '照準ガイドの長さ', unit: 'mm', min: 0, max: 1000, step: 10, def: 160 },
  ];

  CG.defaultCfg = function () {
    const c = {};
    CG.CFG_FIELDS.forEach((f) => (c[f.key] = f.def));
    return c;
  };

  CG.sanitizeCfg = function (src) {
    const c = {};
    CG.CFG_FIELDS.forEach((f) => {
      let v = Number(src ? src[f.key] : NaN);
      if (!isFinite(v)) v = f.def;
      v = Math.min(f.max, Math.max(f.min, v));
      if (f.step >= 1) v = Math.round(v);
      c[f.key] = v;
    });
    return c;
  };

  CG.clone = function (o) {
    return JSON.parse(JSON.stringify(o));
  };

  CG.newSim = function () {
    return { tick: 0, nextId: 1, balls: [] };
  };

  /* ボール: {id, o:持ち主ID, x, y, vx, vy, q:投げた問題番号, f:落下演出カウンタ(0=盤上)}
     座標: x は 0..tableW、y は 0(対辺)..tableL(手前)。
     親子で同じ結果になるよう、四則演算と sqrt だけで計算する。 */
  CG.stepSim = function (sim, cfg) {
    const balls = sim.balls;
    const n = balls.length;
    const dt = CG.DT;
    const dv = cfg.friction * dt;
    const r = cfg.radius;
    const W = cfg.tableW;
    const L = cfg.tableL;
    const e = cfg.restitution;
    let removed = false;

    for (let i = 0; i < n; i++) {
      const b = balls[i];
      if (b.f) {
        b.f++;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        if (b.f > CG.FALL_TICKS) removed = true;
        continue;
      }
      if (b.vx !== 0 || b.vy !== 0) {
        const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
        if (sp <= dv) {
          b.vx = 0;
          b.vy = 0;
        } else {
          const k = (sp - dv) / sp;
          b.vx *= k;
          b.vy *= k;
          b.x += b.vx * dt;
          b.y += b.vy * dt;
        }
      }
    }

    const dmin = 2 * r;
    const d2min = dmin * dmin;
    for (let i = 0; i < n; i++) {
      const a = balls[i];
      if (a.f) continue;
      for (let j = i + 1; j < n; j++) {
        const b = balls[j];
        if (b.f) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= d2min) continue;
        let d = Math.sqrt(d2);
        let nx = 1;
        let ny = 0;
        if (d > 1e-9) {
          nx = dx / d;
          ny = dy / d;
        } else {
          d = 0;
        }
        const half = (dmin - d) / 2;
        a.x -= nx * half;
        a.y -= ny * half;
        b.x += nx * half;
        b.y += ny * half;
        const vn = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
        if (vn > 0) {
          const imp = (vn * (1 + e)) / 2;
          a.vx -= imp * nx;
          a.vy -= imp * ny;
          b.vx += imp * nx;
          b.vy += imp * ny;
        }
      }
    }

    for (let i = 0; i < n; i++) {
      const b = balls[i];
      if (!b.f && (b.x < 0 || b.x > W || b.y < 0 || b.y > L)) b.f = 1;
    }
    if (removed) sim.balls = balls.filter((b) => !(b.f > CG.FALL_TICKS));
    sim.tick++;
  };

  CG.simMoving = function (sim) {
    const balls = sim.balls;
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (b.f || b.vx !== 0 || b.vy !== 0) return true;
    }
    return false;
  };

  CG.launchY = function (cfg) {
    // 手前の辺から launchOffset だけ奥。ボールが辺からはみ出さない範囲に収める。
    const off = Math.max(cfg.radius + 1, cfg.launchOffset);
    return Math.max(cfg.radius, cfg.tableL - off);
  };

  // 発射位置に盤上のボールが重なっているか
  CG.launchBlocked = function (balls, cfg, x) {
    const y = CG.launchY(cfg);
    const d2min = 4 * cfg.radius * cfg.radius;
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (b.f) continue;
      const dx = b.x - x;
      const dy = b.y - y;
      if (dx * dx + dy * dy < d2min) return true;
    }
    return false;
  };

  /* 順位: ①盤上で最も対辺に近いボールの距離が小さい順 ②事前順位(players の並び順)。
     盤上にボールがないプレイヤーは、ボールがあるプレイヤーより下位。 */
  CG.ranking = function (players, balls) {
    const best = {};
    const count = {};
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (b.f) continue;
      count[b.o] = (count[b.o] || 0) + 1;
      if (!best[b.o] || b.y < best[b.o].y) best[b.o] = b;
    }
    const rows = players.map((p, i) => ({
      p: p,
      seed: i,
      best: best[p.id] ? best[p.id].y : null,
      ballId: best[p.id] ? best[p.id].id : null,
      count: count[p.id] || 0,
    }));
    rows.sort((a, b) => {
      const ay = a.best === null ? Infinity : a.best;
      const by = b.best === null ? Infinity : b.best;
      if (ay !== by) return ay < by ? -1 : 1;
      return a.seed - b.seed;
    });
    rows.forEach((r, i) => (r.rank = i + 1));
    return rows;
  };

  CG.playerById = function (state, pid) {
    for (let i = 0; i < state.players.length; i++) if (state.players[i].id === pid) return state.players[i];
    return null;
  };

  CG.randomId = function (len) {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    const buf = new Uint32Array(len);
    (global.crypto || global.msCrypto).getRandomValues(buf);
    for (let i = 0; i < len; i++) s += abc[buf[i] % abc.length];
    return s;
  };

  /* 子(表示側)の同期。
     親は投球・停止・設定変更のたびに「その tick 時点の全ボール状態」を配信する。
     子は少し遅らせて同じ物理計算を再生し、配信された tick に達したらその状態へ差し替える。
     遅れて届いた場合はその状態から早送りで追いつく。 */
  const DELAY_TICKS = Math.round(0.25 * CG.HZ);

  function ClientSim() {
    this.cur = null;
    this.cfg = null;
    this.pending = [];
    this.last = null;
    this.epoch = null;
    this.prevNow = null;
    this.ver = 0; // cur が変わるたびに増える(表示更新の判定用)
  }

  ClientSim.prototype.push = function (state, now) {
    const kf = {
      tick: state.sim.tick,
      running: CG.simMoving(state.sim),
      sim: CG.clone(state.sim),
      cfg: state.cfg,
      recv: now,
    };
    this.last = kf;
    if (this.epoch !== state.epoch || !this.cur) {
      this.epoch = state.epoch;
      this.cur = CG.clone(state.sim);
      this.cfg = state.cfg;
      this.pending = [];
      this.ver++;
      return;
    }
    this.pending.push(kf);
  };

  ClientSim.prototype._apply = function () {
    while (this.pending.length && this.pending[0].tick <= this.cur.tick) {
      const kf = this.pending.shift();
      this.cur = CG.clone(kf.sim);
      this.cfg = kf.cfg;
      this.ver++;
    }
  };

  ClientSim.prototype.update = function (now) {
    if (!this.cur) return null;
    const L = this.last;
    if (this.prevNow === null) this.prevNow = now;
    const frameTicks = ((now - this.prevNow) * CG.HZ) / 1000;
    this.prevNow = now;
    this._apply();
    const target = L.running ? L.tick + ((now - L.recv) * CG.HZ) / 1000 - DELAY_TICKS : L.tick;
    const want = Math.floor(target) - this.cur.tick;
    if (want > 0) {
      let n = want > CG.HZ * 2 ? want : Math.min(want, Math.ceil(frameTicks * 1.5));
      n = Math.min(n, CG.HZ * 40);
      for (let i = 0; i < n; i++) {
        CG.stepSim(this.cur, this.cfg);
        this._apply();
      }
      if (n > 0) this.ver++;
    }
    return this.cur.balls;
  };

  ClientSim.prototype.moving = function () {
    return !!this.cur && (CG.simMoving(this.cur) || this.pending.length > 0);
  };

  CG.ClientSim = ClientSim;
})(typeof window !== 'undefined' ? window : globalThis);
