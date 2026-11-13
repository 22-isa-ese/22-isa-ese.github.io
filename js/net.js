/* チキンレース: 通信層。
   - firebase: Firebase Realtime Database を中継に使うオンライン対戦
   - local   : BroadcastChannel を使う同一ブラウザ内のお試しモード(設定不要)
   親は状態(JSON文字列)を配信し、子は操作(action)を親へ送る。 */
(function (global) {
  'use strict';
  const CG = (global.CG = global.CG || {});
  const FB_VER = '10.12.2';
  const FB_BASE = 'https://www.gstatic.com/firebasejs/' + FB_VER + '/';

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('スクリプトを読み込めません: ' + src));
      document.head.appendChild(s);
    });
  }

  CG.netMode = function () {
    const forceLocal = /[?&]local=1/.test(global.location.search);
    const cfg = global.CG_FIREBASE_CONFIG;
    return !forceLocal && cfg && cfg.databaseURL ? 'firebase' : 'local';
  };

  function connectLocal(room, role, h) {
    const ch = new BroadcastChannel('chickengame-' + room);
    if (role === 'host') {
      ch.onmessage = (e) => {
        const m = e.data;
        if (m.t === 'action') h.onAction(m.a);
        else if (m.t === 'req') h.onRequest();
      };
    } else {
      ch.onmessage = (e) => {
        const m = e.data;
        if (m.t === 'state') h.onState(JSON.parse(m.s));
      };
      ch.postMessage({ t: 'req' });
    }
    if (h.onStatus) h.onStatus(true);
    return {
      mode: 'local',
      publish: (str) => ch.postMessage({ t: 'state', s: str }),
      send: (a) => ch.postMessage({ t: 'action', a: a }),
      fetchState: () => Promise.resolve(null),
      destroy: () => Promise.resolve(),
      close: () => ch.close(),
    };
  }

  async function connectFirebase(room, role, h) {
    if (!global.firebase || !global.firebase.database) {
      await loadScript(FB_BASE + 'firebase-app-compat.js');
      await loadScript(FB_BASE + 'firebase-database-compat.js');
    }
    const fb = global.firebase;
    const app = fb.apps.length ? fb.app() : fb.initializeApp(global.CG_FIREBASE_CONFIG);
    const db = fb.database(app);
    const ref = db.ref('rooms/' + room);
    const stateRef = ref.child('state');
    const actRef = ref.child('actions');

    db.ref('.info/connected').on('value', (snap) => {
      if (h.onStatus) h.onStatus(!!snap.val());
    });

    if (role === 'host') {
      actRef.on('child_added', (snap) => {
        let a = null;
        try {
          a = JSON.parse(snap.val());
        } catch (err) {
          a = null;
        }
        snap.ref.remove();
        if (a) h.onAction(a);
      });
    } else {
      stateRef.on('value', (snap) => {
        const v = snap.val();
        if (!v) return;
        try {
          h.onState(JSON.parse(v));
        } catch (err) {
          console.error(err);
        }
      });
    }

    return {
      mode: 'firebase',
      publish: (str) => stateRef.set(str).catch((err) => h.onError && h.onError(err)),
      send: (a) => actRef.push(JSON.stringify(a)).catch((err) => h.onError && h.onError(err)),
      fetchState: () =>
        stateRef.get().then((snap) => {
          const v = snap.val();
          return v ? JSON.parse(v) : null;
        }),
      destroy: () => ref.remove(),
      close: () => {
        stateRef.off();
        actRef.off();
      },
    };
  }

  // role: 'host' | 'client'
  // handlers: host → onAction(a), onRequest() / client → onState(state) / 共通 → onStatus(bool), onError(err)
  CG.connect = function (room, role, handlers) {
    if (CG.netMode() === 'firebase') return connectFirebase(room, role, handlers);
    return Promise.resolve(connectLocal(room, role, handlers));
  };
})(window);
