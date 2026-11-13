/* チキンレース: 盤面の描画と投球操作(引っ張って離す) */
(function (global) {
  'use strict';
  const CG = (global.CG = global.CG || {});
  const FONT = '"Segoe UI","Hiragino Kaku Gothic ProN","Yu Gothic UI",Meiryo,sans-serif';

  function isLight(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return 0.299 * r + 0.587 * g + 0.114 * b > 150;
  }

  // view: { cfg, balls, players, me, aim: {color, label} | null }
  // opts: { onShot({x, vx, vy}), onBlocked() }
  CG.createBoard = function (canvas, opts) {
    opts = opts || {};
    const ctx = canvas.getContext('2d');
    let cw = 0;
    let ch = 0;
    let dpr = 1;
    let g = { s: 1, ox: 0, oy: 0 };
    let view = null;
    let drag = null;

    function fit() {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const d = global.devicePixelRatio || 1;
      if (w !== cw || h !== ch || d !== dpr) {
        cw = w;
        ch = h;
        dpr = d;
        canvas.width = Math.max(1, Math.round(w * d));
        canvas.height = Math.max(1, Math.round(h * d));
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function layout(cfg) {
      const pl = 46;
      const pr = 18;
      const pt = 36;
      const pb = 60; // 発射位置から下へ引っ張るための余白
      const s = Math.max(0.01, Math.min((cw - pl - pr) / cfg.tableW, (ch - pt - pb) / cfg.tableL));
      g = {
        s: s,
        ox: pl + (cw - pl - pr - cfg.tableW * s) / 2,
        oy: pt + (ch - pt - pb - cfg.tableL * s) / 2,
      };
    }

    const X = (x) => g.ox + x * g.s;
    const Y = (y) => g.oy + y * g.s;

    function calcShot() {
      const cfg = view.cfg;
      const dx = (drag.cx - drag.sx) / g.s;
      const dy = (drag.cy - drag.sy) / g.s;
      const len = Math.sqrt(dx * dx + dy * dy);
      let power = dy > 0 ? Math.min(len / cfg.pullDist, 1) : 0;
      if (len < 12) power = 0;
      const maxA = (cfg.maxAngle * Math.PI) / 180;
      let ang = len > 0 && dy > 0 ? Math.atan2(-dx, dy) : 0; // 0 = 対辺へまっすぐ
      ang = Math.max(-maxA, Math.min(maxA, ang));
      const dirx = Math.sin(ang);
      const diry = -Math.cos(ang);
      const speed = power * cfg.maxSpeed;
      return {
        x: drag.x,
        vx: speed * dirx,
        vy: speed * diry,
        power: power,
        dirx: dirx,
        diry: diry,
        blocked: CG.launchBlocked(view.balls, cfg, drag.x),
      };
    }

    function pos(e) {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    canvas.addEventListener('pointerdown', (e) => {
      if (!view || !view.aim || drag) return;
      if (e.button !== undefined && e.button !== 0) return;
      const p = pos(e);
      const cfg = view.cfg;
      const tx = (p.x - g.ox) / g.s;
      const x = Math.max(cfg.radius + 1, Math.min(cfg.tableW - cfg.radius - 1, tx));
      drag = { id: e.pointerId, x: x, sx: p.x, sy: p.y, cx: p.x, cy: p.y };
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (err) {
        /* 一部環境では失敗するが操作は続行できる */
      }
      e.preventDefault();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const p = pos(e);
      drag.cx = p.x;
      drag.cy = p.y;
    });

    function finish(e, fire) {
      if (!drag || e.pointerId !== drag.id) return;
      const shot = fire && view && view.aim ? calcShot() : null;
      drag = null;
      if (!shot || shot.power < 0.03) return;
      if (shot.blocked) {
        if (opts.onBlocked) opts.onBlocked();
        return;
      }
      if (opts.onShot) opts.onShot({ x: shot.x, vx: shot.vx, vy: shot.vy });
    }
    canvas.addEventListener('pointerup', (e) => finish(e, true));
    canvas.addEventListener('pointercancel', (e) => finish(e, false));

    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function drawTable(cfg) {
      const x0 = g.ox;
      const y0 = g.oy;
      const w = cfg.tableW * g.s;
      const h = cfg.tableL * g.s;

      ctx.fillStyle = 'rgba(0,0,0,.4)';
      roundRect(x0 + 5, y0 + 8, w, h, 6);
      ctx.fill();

      const grad = ctx.createLinearGradient(0, y0, 0, y0 + h);
      grad.addColorStop(0, '#34445f');
      grad.addColorStop(1, '#263146');
      ctx.fillStyle = grad;
      roundRect(x0, y0, w, h, 6);
      ctx.fill();

      const dz = Math.min(h, 140 * g.s);
      const dg = ctx.createLinearGradient(0, y0, 0, y0 + dz);
      dg.addColorStop(0, 'rgba(255,90,90,.28)');
      dg.addColorStop(1, 'rgba(255,90,90,0)');
      ctx.fillStyle = dg;
      ctx.fillRect(x0, y0, w, dz);

      ctx.font = '11px ' + FONT;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 1;
      for (let d = 100; d < cfg.tableL; d += 100) {
        const y = Math.round(Y(d)) + 0.5;
        ctx.strokeStyle = d % 500 === 0 ? 'rgba(255,255,255,.2)' : 'rgba(255,255,255,.08)';
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x0 + w, y);
        ctx.stroke();
        ctx.fillStyle = '#8492ab';
        ctx.fillText(String(d), x0 - 7, y);
      }
      ctx.fillStyle = '#8492ab';
      ctx.fillText('0', x0 - 7, y0);

      // 発射ライン
      const yl = Math.round(Y(CG.launchY(cfg))) + 0.5;
      ctx.save();
      ctx.setLineDash([4, 6]);
      ctx.strokeStyle = 'rgba(255,255,255,.3)';
      ctx.beginPath();
      ctx.moveTo(x0, yl);
      ctx.lineTo(x0 + w, yl);
      ctx.stroke();
      ctx.restore();
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = 'rgba(255,255,255,.4)';
      ctx.fillText('発射ライン', x0 + w - 6, yl - 3);

      ctx.strokeStyle = '#7a89a6';
      ctx.lineWidth = 2;
      roundRect(x0, y0, w, h, 6);
      ctx.stroke();

      // 対辺の警告帯
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0 - 9, w, 8);
      ctx.clip();
      ctx.fillStyle = '#ffc83d';
      ctx.fillRect(x0, y0 - 9, w, 8);
      ctx.fillStyle = '#1b1f2a';
      for (let sx = x0 - 16; sx < x0 + w + 16; sx += 16) {
        ctx.beginPath();
        ctx.moveTo(sx, y0 - 1);
        ctx.lineTo(sx + 8, y0 - 1);
        ctx.lineTo(sx + 16, y0 - 9);
        ctx.lineTo(sx + 8, y0 - 9);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.font = 'bold 12px ' + FONT;
      ctx.fillStyle = '#ffc83d';
      ctx.fillText('▲ 対辺(近いほど上位・越えると落下)', x0 + w / 2, y0 - 15);
    }

    function drawBall(b, cfg, color, label, ring) {
      let rr = cfg.radius * g.s;
      let alpha = 1;
      if (b.f) {
        const k = Math.max(0, 1 - b.f / CG.FALL_TICKS);
        rr *= k;
        alpha = k;
      }
      if (rr <= 0.2) return;
      const x = X(b.x);
      const y = Y(b.y);
      ctx.globalAlpha = alpha;
      if (!b.f) {
        ctx.fillStyle = 'rgba(0,0,0,.35)';
        ctx.beginPath();
        ctx.arc(x + rr * 0.15, y + rr * 0.25, rr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.fill();
      const hl = ctx.createRadialGradient(x - rr * 0.35, y - rr * 0.4, rr * 0.05, x, y, rr);
      hl.addColorStop(0, 'rgba(255,255,255,.55)');
      hl.addColorStop(0.5, 'rgba(255,255,255,0)');
      hl.addColorStop(1, 'rgba(0,0,0,.25)');
      ctx.fillStyle = hl;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.stroke();
      if (ring) {
        ctx.lineWidth = ring === 'lead' ? 2.5 : 1.5;
        ctx.strokeStyle = ring === 'lead' ? '#ffd24a' : 'rgba(255,255,255,.9)';
        ctx.beginPath();
        ctx.arc(x, y, rr + (ring === 'lead' ? 3.5 : 2.5), 0, Math.PI * 2);
        ctx.stroke();
      }
      if (label && rr >= 6) {
        ctx.font = 'bold ' + Math.round(rr * 1.05) + 'px ' + FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = isLight(color) ? '#1b1f2a' : '#ffffff';
        ctx.fillText(label, x, y + rr * 0.06);
      }
      ctx.globalAlpha = 1;
    }

    function drawAim(cfg, now) {
      const aim = view.aim;
      const x0 = g.ox;
      const w = cfg.tableW * g.s;
      const ly = CG.launchY(cfg);

      if (!drag) {
        const pulse = 0.16 + 0.1 * Math.sin(now / 260);
        ctx.globalAlpha = pulse;
        ctx.fillStyle = aim.color;
        ctx.fillRect(x0, Y(ly - cfg.radius), w, cfg.radius * 2 * g.s);
        ctx.globalAlpha = 1;
        return;
      }

      const shot = calcShot();
      const bx = X(shot.x);
      const by = Y(ly);
      const rr = cfg.radius * g.s;

      // 引っ張りの線
      ctx.strokeStyle = 'rgba(255,255,255,.45)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(drag.sx, drag.sy);
      ctx.lineTo(drag.cx, drag.cy);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.6)';
      ctx.beginPath();
      ctx.arc(drag.sx, drag.sy, 4, 0, Math.PI * 2);
      ctx.fill();

      // 方向ガイド(停止位置は示さない)
      if (cfg.guideLen > 0 && shot.power > 0) {
        ctx.save();
        ctx.setLineDash([6, 6]);
        ctx.strokeStyle = 'rgba(255,255,255,.85)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + shot.dirx * cfg.guideLen * g.s, by + shot.diry * cfg.guideLen * g.s);
        ctx.stroke();
        ctx.restore();
      }

      // 発射位置のボール
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = aim.color;
      ctx.beginPath();
      ctx.arc(bx, by, rr, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2;
      ctx.strokeStyle = shot.blocked ? '#ff5252' : '#ffffff';
      ctx.stroke();

      // パワー表示
      // パワー表示(再現できないよう数値・目盛りは出さず、バーのみ)
      const bw = 130;
      const px = Math.max(8, Math.min(cw - bw - 8, bx - bw / 2));
      const py = by - rr - 30;
      const msg = shot.blocked ? '発射位置にボールあり' : shot.power > 0 ? '' : '下に引っ張る';
      ctx.fillStyle = 'rgba(12,16,24,.85)';
      roundRect(px - 8, py - (msg ? 26 : 8), bw + 16, msg ? 42 : 24, 8);
      ctx.fill();
      if (msg) {
        ctx.font = 'bold 13px ' + FONT;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = shot.blocked ? '#ff7b7b' : '#ffffff';
        ctx.fillText(msg, px, py - 8);
      }
      ctx.fillStyle = 'rgba(255,255,255,.18)';
      ctx.fillRect(px, py, bw, 8);
      ctx.fillStyle = '#ffc83d';
      ctx.fillRect(px, py, bw * shot.power, 8);
    }

    function render(v) {
      view = v;
      if (!view.aim) drag = null;
      fit();
      ctx.clearRect(0, 0, cw, ch);
      const cfg = view.cfg;
      layout(cfg);
      drawTable(cfg);

      const byId = {};
      view.players.forEach((p) => (byId[p.id] = p));
      const rows = CG.ranking(view.players, view.balls);
      const lead = rows.length && rows[0].ballId !== null ? rows[0].ballId : null;

      const now = performance.now();
      if (view.aim) drawAim(cfg, now);

      for (let i = 0; i < view.balls.length; i++) {
        const b = view.balls[i];
        const p = byId[b.o];
        const color = p ? p.color : '#888888';
        const label = p ? Array.from(p.name)[0] || '' : '';
        const ring = b.f ? null : b.id === lead ? 'lead' : view.me && b.o === view.me ? 'me' : null;
        drawBall(b, cfg, color, label, ring);
      }

      ctx.font = '12px ' + FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      const yb = Y(cfg.tableL);
      if (view.aim) {
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 13px ' + FONT;
        ctx.fillText(view.aim.label + ':発射ライン付近を押したまま下に引っ張り、離して発射', g.ox + (cfg.tableW * g.s) / 2, yb + 22);
      } else {
        ctx.fillStyle = '#8492ab';
        ctx.fillText('手前(発射側)', g.ox + (cfg.tableW * g.s) / 2, yb + 20);
      }
    }

    return { render: render };
  };
})(window);
