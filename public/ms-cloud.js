/* My Safety · modo servidor (Netlify + Neon)
   Carregado antes do app. Faz o login, guarda os dados no servidor e oferece ao app a mesma interface
   (window.claude.use('db' | 'user' | 'assets' | 'downloads')) que ele já usava. */
(function () {
  'use strict';
  if (window.claude) return;

  var POLL_VISIVEL = 5000, POLL_OCULTO = 30000, LOTE_MS = 150, LOTE_MAX = 200, LOTE_BYTES = 2000000;
  var cp = function (o) { return o == null ? o : JSON.parse(JSON.stringify(o)); };
  var nid = function () { var a = new Uint8Array(16); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  function api(metodo, caminho, corpo, extra) {
    var o = { method: metodo, credentials: 'same-origin', headers: { 'x-ms': '1' } };
    if (corpo instanceof Blob) { o.body = corpo; o.headers['content-type'] = (extra && extra.type) || corpo.type || 'application/octet-stream'; }
    else if (corpo !== undefined) { o.body = JSON.stringify(corpo); o.headers['content-type'] = 'application/json'; }
    return fetch(caminho, o).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.mensagem || ('Erro ' + r.status)); e.code = j.erro || ('http_' + r.status); e.status = r.status; e.body = j; throw e; }
        return j;
      });
    });
  }

  /* ---------- window.claude: as capacidades ficam prontas depois do login ---------- */
  var caps = {}, esperando = [];
  function liberar(c) { caps = c; esperando.splice(0).forEach(function (f) { f(); }); }
  window.claude = {
    use: function (nome) {
      return new Promise(function (res) {
        var ok = function () { res(caps[nome] || null); };
        if (caps.__pronto) ok(); else esperando.push(ok);
      });
    }
  };

  /* ---------- banco de dados (espelho em memória sincronizado com o servidor) ---------- */
  var mem = {}, subs = [], cursor = 0, escopo = '', pronto = false, filaPronto = [], pend = {}, fila = [], timerFila = null, enviando = false, timerSync = null, sincronizando = false, sessaoCaiu = false;
  var SOB_DEMANDA = { entAssin: 1 };
  function col(n) { return mem[n] || (mem[n] = {}); }
  function dsnap(n, id) { var v = col(n)[id]; return { id: id, exists: v !== undefined, data: function () { return cp(v); } }; }
  function quandoPronto(f) { if (pronto) f(); else filaPronto.push(f); }
  function consulta(n, wh, lim) {
    var L = Object.keys(col(n)).filter(function (id) { var x = col(n)[id]; return wh.every(function (w) { return x && x[w[0]] === w[2]; }); }).map(function (id) { return dsnap(n, id); });
    if (lim && lim < 1000) L = L.slice(0, lim); /* limites de 1.000+ eram da plataforma anterior: aqui vêm todos */
    return { docs: L, size: L.length, empty: !L.length, forEach: function (f) { L.forEach(f); } };
  }
  function avisar(cols) { subs.forEach(function (s) { if (cols[s.n]) setTimeout(s.fire, 0); }); }
  function assinar(s) { subs.push(s); quandoPronto(function () { setTimeout(s.fire, 0); }); return function () { subs = subs.filter(function (x) { return x !== s; }); }; }

  function aplicarDocs(docs, cols) {
    docs.forEach(function (x) {
      var k = x.c + '\u0001' + x.id;
      if (pend[k]) return; /* há gravação local pendente deste documento: vale a versão local */
      var c = col(x.c), atual = c[x.id];
      if (x.d == null) { if (atual !== undefined) { delete c[x.id]; cols[x.c] = 1; } return; }
      if (atual === undefined || JSON.stringify(atual) !== JSON.stringify(x.d)) { c[x.id] = x.d; cols[x.c] = 1; }
    });
  }

  function carregarTudo() {
    var novo = {}, cur = 0;
    function pagina() {
      return api('GET', '/api/sync?full=1&since=' + cur).then(function (r) {
        r.docs.forEach(function (x) { (novo[x.c] || (novo[x.c] = {}))[x.id] = x.d; });
        cur = r.cursor; escopo = r.escopo;
        if (r.mais) return pagina();
      });
    }
    return pagina().then(function () {
      var cols = {};
      Object.keys(mem).concat(Object.keys(novo)).forEach(function (n) { cols[n] = 1; });
      /* mantém o que ainda está sendo gravado */
      Object.keys(pend).forEach(function (k) { var p = k.split('\u0001'); if (mem[p[0]] && p[1] in mem[p[0]]) (novo[p[0]] || (novo[p[0]] = {}))[p[1]] = mem[p[0]][p[1]]; });
      mem = novo; cursor = cur;
      return cols;
    });
  }

  function sincronizar() {
    if (sincronizando || sessaoCaiu) return Promise.resolve();
    sincronizando = true;
    var cols = {};
    function passo() {
      return api('GET', '/api/sync?since=' + cursor + '&escopo=' + encodeURIComponent(escopo)).then(function (r) {
        if (r.reset) return carregarTudo().then(function (c) { Object.assign(cols, c); });
        aplicarDocs(r.docs, cols); cursor = r.cursor;
        if (r.mais) return passo();
      });
    }
    return passo().then(function () { avisar(cols); }, function (e) { if (e.status === 401) sessaoEncerrada(); })
      .then(function () { sincronizando = false; agendarSync(); });
  }
  function agendarSync(ms) {
    clearTimeout(timerSync);
    timerSync = setTimeout(sincronizar, ms != null ? ms : (document.hidden ? POLL_OCULTO : POLL_VISIVEL));
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && pronto) agendarSync(200); });

  function gravar(op) {
    var k = op.c + '\u0001' + op.id;
    pend[k] = (pend[k] || 0) + 1;
    return new Promise(function (res, rej) {
      fila.push({ op: op, k: k, res: res, rej: rej });
      if (!timerFila) timerFila = setTimeout(enviarFila, LOTE_MS);
    });
  }
  function enviarFila() {
    timerFila = null;
    if (enviando || !fila.length) return;
    var lote = [], bytes = 0;
    while (fila.length && lote.length < LOTE_MAX) {
      var tam = JSON.stringify(fila[0].op).length;
      if (lote.length && bytes + tam > LOTE_BYTES) break;
      lote.push(fila.shift()); bytes += tam;
    }
    enviando = true;
    api('POST', '/api/write', { ops: lote.map(function (x) { return x.op; }) }).then(function (r) {
      var negou = false;
      lote.forEach(function (x, i) {
        var st = (r.resultados || [])[i];
        if (st === 'ok') x.res(); else { negou = true; var e = new Error('Gravação recusada pelo servidor (' + st + ')'); e.code = st || 'erro'; x.rej(e); }
      });
      return negou;
    }, function (e) {
      if (e.status === 401) sessaoEncerrada();
      lote.forEach(function (x) { x.rej(e); });
      return true;
    }).then(function (recarregar) {
      lote.forEach(function (x) { if (!--pend[x.k]) delete pend[x.k]; });
      enviando = false;
      if (recarregar) { escopo = '#'; } /* força recarga completa: desfaz o que o servidor recusou */
      if (fila.length) enviarFila(); else agendarSync(400);
    });
  }

  function Q(n, wh, lim) {
    return {
      where: function (f, op, v) { return Q(n, wh.concat([[f, op, v]]), lim); },
      limit: function (k) { return Q(n, wh, k); },
      orderBy: function () { return Q(n, wh, lim); },
      get: function () { return new Promise(function (res) { quandoPronto(function () { res(consulta(n, wh, lim)); }); }); },
      onSnapshot: function (cb) { return assinar({ n: n, fire: function () { cb(consulta(n, wh, lim)); } }); },
      doc: function (id) {
        id = String(id);
        return {
          id: id,
          get: function () {
            if (SOB_DEMANDA[n] && col(n)[id] === undefined) {
              return api('GET', '/api/doc?c=' + encodeURIComponent(n) + '&id=' + encodeURIComponent(id)).then(function (r) { if (r.existe) col(n)[id] = r.d; return dsnap(n, id); });
            }
            return new Promise(function (res) { quandoPronto(function () { res(dsnap(n, id)); }); });
          },
          set: function (v, o) {
            var merge = !!(o && o.merge);
            col(n)[id] = (merge && col(n)[id]) ? Object.assign({}, col(n)[id], cp(v)) : cp(v);
            avisar({ [n]: 1 });
            return gravar({ c: n, id: id, t: merge ? 'merge' : 'set', d: cp(v) });
          },
          update: function (v) {
            col(n)[id] = Object.assign({}, col(n)[id] || {}, cp(v));
            avisar({ [n]: 1 });
            return gravar({ c: n, id: id, t: 'merge', d: cp(v) });
          },
          delete: function () { delete col(n)[id]; avisar({ [n]: 1 }); return gravar({ c: n, id: id, t: 'del' }); },
          onSnapshot: function (cb) { return assinar({ n: n, fire: function () { cb(dsnap(n, id)); } }); }
        };
      }
    };
  }
  var dbApi = { collection: function (n) { return Q(String(n), [], 0); } };

  /* ---------- banco de dados público: só a votação online da CIPA (sem login) ---------- */
  function dbPublico() {
    var cache = {}, partPend = null;
    var vazio = { docs: [], size: 0, empty: true, forEach: function () {} };
    var negado = function () { var e = new Error('Faça login para continuar.'); e.code = 'permission_denied'; return Promise.reject(e); };
    function PQ(n) {
      return {
        where: function () { return PQ(n); }, limit: function () { return PQ(n); }, orderBy: function () { return PQ(n); },
        get: function () { return Promise.resolve(vazio); },
        onSnapshot: function (cb) { setTimeout(function () { cb(vazio); }, 0); return function () {}; },
        doc: function (id) {
          id = String(id);
          var snap = function (d) { return { id: id, exists: d !== undefined && d !== null, data: function () { return cp(d); } }; };
          return {
            id: id,
            get: function () {
              if (n === 'urnas') return api('GET', '/api/public/urna/' + encodeURIComponent(id)).then(function (r) { return snap(r.existe ? r.d : null); });
              if (n === 'urnaPart') return api('GET', '/api/public/part/' + encodeURIComponent(id)).then(function (r) { return snap(r.existe || cache[id] ? {} : null); });
              return Promise.resolve(snap(null));
            },
            set: function (v) {
              if (n === 'urnaPart') { partPend = { id: id, v: v }; return Promise.resolve(); }
              if (n === 'urnaVotos' && partPend) {
                var p = partPend; partPend = null;
                return api('POST', '/api/public/votar', { urnaId: v.urnaId, partId: p.id, candidatoId: v.candidatoId, dia: p.v && p.v.dia }).then(function (r) {
                  cache[p.id] = 1;
                  if (r.ja) { var e = new Error('Este empregado já votou.'); e.code = 'ja_votou'; throw e; }
                });
              }
              return negado();
            },
            update: negado, delete: negado,
            onSnapshot: function (cb) { setTimeout(function () { cb(snap(null)); }, 0); return function () {}; }
          };
        }
      };
    }
    return { collection: function (n) { return PQ(String(n)); } };
  }

  /* ---------- usuário, arquivos e downloads ---------- */
  var EU = null, perfisCache = {};
  var userApi = {
    me: function () { return Promise.resolve({ id: EU.id, name: EU.nome, email: EU.email, isOwner: EU.isOwner }); },
    id: function () { return Promise.resolve(EU.id); },
    isOwner: function () { return Promise.resolve(EU.isOwner); },
    canEdit: function () { return Promise.resolve(true); },
    can: function () { return Promise.resolve(true); },
    profiles: function (ids) {
      ids = (ids || []).filter(Boolean);
      var falta = ids.filter(function (i) { return !(i in perfisCache); });
      var p = falta.length ? api('GET', '/api/perfis?ids=' + encodeURIComponent(falta.join(','))).then(function (r) { falta.forEach(function (i) { perfisCache[i] = (r.perfis[i] && r.perfis[i].name) || ''; }); }, function () {}) : Promise.resolve();
      return p.then(function () { var o = {}; ids.forEach(function (i) { o[i] = { name: perfisCache[i] || '' }; }); return o; });
    },
    search: function (q) { return api('GET', '/api/busca?q=' + encodeURIComponent(q || '')).then(function (r) { r.contas.forEach(function (c) { perfisCache[c.id] = c.name; }); return r.contas; }, function () { return []; }); }
  };
  var urls = {};
  window.__MS_ASSET_URLS = urls;
  var assetsApi = {
    upload: function (blob, o) {
      var b = (o && o.type && blob.type !== o.type) ? new Blob([blob], { type: o.type }) : blob;
      return api('POST', '/api/assets', b, { type: b.type }).then(function (r) { urls[r.id] = r.url; return r; });
    },
    delete: function (id) { return api('DELETE', '/api/assets/' + encodeURIComponent(id)).then(function () {}); },
    list: function () { return api('GET', '/api/assets').then(function (r) { return { assets: r.assets, usage: {} }; }); }
  };
  var dlApi = { save: function (o) { var b = o.data instanceof Blob ? o.data : new Blob([o.data]); var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = o.filename || 'arquivo'; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000); return Promise.resolve(); } };

  /* ---------- interface: login, menu da conta e contas de acesso ---------- */
  var CSS = '' +
    '.mscl-ov{position:fixed;inset:0;z-index:2147483000;background:#F3F7FB;display:flex;align-items:center;justify-content:center;padding:16px;font-family:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;color:#0B2545;overflow:auto}' +
    '.mscl-card{background:#fff;border:1px solid #D5E0EC;border-radius:14px;box-shadow:0 8px 30px rgba(11,37,69,.08);width:100%;max-width:400px;padding:28px}' +
    '.mscl-brand small{display:block;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#4A5D75}.mscl-brand b{font-size:22px}' +
    '.mscl-card h1{font-size:18px;margin:18px 0 6px}.mscl-card p{font-size:14px;color:#4A5D75;margin:0 0 16px;line-height:1.45}' +
    '.mscl-f{display:flex;flex-direction:column;gap:4px;margin-bottom:12px}.mscl-f label{font-size:13px;font-weight:600}' +
    '.mscl-f input{font:inherit;font-size:15px;padding:10px 12px;border:1px solid #B8C7D9;border-radius:8px;background:#fff;color:#0B2545}' +
    '.mscl-f input:focus{outline:2px solid #1B6FD8;outline-offset:1px;border-color:#1B6FD8}' +
    '.mscl-btn{font:inherit;font-size:14px;font-weight:600;border-radius:8px;padding:10px 16px;border:1px solid transparent;cursor:pointer;background:#1B6FD8;color:#fff}' +
    '.mscl-btn[disabled]{opacity:.6;cursor:default}.mscl-btn.g{background:#fff;color:#0B2545;border-color:#B8C7D9}.mscl-btn.sm{padding:6px 10px;font-size:13px}.mscl-btn.d{background:#fff;color:#B42318;border-color:#F0B4AE}' +
    '.mscl-err{background:#FEF3F2;color:#B42318;border:1px solid #F0B4AE;border-radius:8px;padding:10px 12px;font-size:14px;margin-bottom:12px}' +
    '.mscl-ok{background:#ECFDF3;color:#067647;border:1px solid #ABEFC6;border-radius:8px;padding:10px 12px;font-size:14px;margin-bottom:12px}' +
    '.mscl-pill{position:fixed;right:16px;bottom:16px;z-index:2147482000;font-family:"IBM Plex Sans",system-ui,sans-serif;font-size:13px;font-weight:600;background:#0B2545;color:#fff;border:0;border-radius:999px;padding:9px 14px;cursor:pointer;box-shadow:0 4px 14px rgba(11,37,69,.25);max-width:calc(100vw - 32px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.mscl-menu{position:fixed;right:16px;bottom:62px;z-index:2147482001;background:#fff;border:1px solid #D5E0EC;border-radius:12px;box-shadow:0 8px 30px rgba(11,37,69,.15);min-width:240px;padding:6px;font-family:"IBM Plex Sans",system-ui,sans-serif;color:#0B2545}' +
    '.mscl-menu .who{padding:10px 12px;border-bottom:1px solid #E6EDF5;margin-bottom:4px;font-size:13px}.mscl-menu .who b{display:block;font-size:14px}' +
    '.mscl-menu button{display:block;width:100%;text-align:left;font:inherit;font-size:14px;background:none;border:0;padding:9px 12px;border-radius:8px;cursor:pointer;color:inherit}.mscl-menu button:hover{background:#F3F7FB}' +
    '.mscl-modal{position:fixed;inset:0;z-index:2147482500;background:rgba(11,37,69,.45);display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;overflow:auto;font-family:"IBM Plex Sans",system-ui,sans-serif;color:#0B2545}' +
    '.mscl-modal .box{background:#fff;border-radius:14px;width:100%;max-width:760px;padding:24px}.mscl-modal h2{margin:0 0 4px;font-size:18px}' +
    '.mscl-modal .top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px}' +
    '.mscl-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:0 12px}' +
    '.mscl-tab{width:100%;border-collapse:collapse;font-size:14px;margin-top:8px}.mscl-tab th,.mscl-tab td{text-align:left;padding:8px 6px;border-bottom:1px solid #E6EDF5;vertical-align:top}.mscl-tab th{font-size:12px;color:#4A5D75;font-weight:600}' +
    '.mscl-tag{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;background:#ECFDF3;color:#067647}.mscl-tag.off{background:#F2F4F7;color:#475467}.mscl-tag.adm{background:#EFF4FF;color:#1B4FD8}' +
    '.mscl-act{display:flex;flex-wrap:wrap;gap:6px}.mscl-small{font-size:13px;color:#4A5D75}' +
    '@media (max-width:600px){.mscl-tab thead{display:none}.mscl-tab tr{display:block;border-bottom:1px solid #E6EDF5;padding:8px 0}.mscl-tab td{display:block;border:0;padding:3px 0}}';
  function css() { if (document.getElementById('mscl-css')) return; var s = document.createElement('style'); s.id = 'mscl-css'; s.textContent = CSS; (document.head || document.documentElement).appendChild(s); }
  function noBody(f) { if (document.body) f(); else document.addEventListener('DOMContentLoaded', f); }
  var MARCA = '<div class="mscl-brand"><small>Super Gerenciador</small><b>My Safety</b></div>';

  function telaLogin(modo, aviso) {
    noBody(function () {
      css();
      var ov = document.getElementById('mscl-login') || document.createElement('div');
      ov.id = 'mscl-login'; ov.className = 'mscl-ov';
      var setup = modo === 'setup';
      ov.innerHTML = '<form class="mscl-card" novalidate>' + MARCA +
        '<h1>' + (setup ? 'Criar o administrador' : 'Entrar') + '</h1>' +
        '<p>' + (setup ? 'Primeiro acesso ao sistema. Crie a conta do administrador com o e-mail definido em ADMIN_EMAIL na Netlify.' : 'Use o e-mail e a senha que o administrador cadastrou para você.') + '</p>' +
        (aviso ? '<div class="mscl-err" role="alert">' + esc(aviso) + '</div>' : '') +
        '<div class="mscl-err" role="alert" hidden data-err></div>' +
        (setup ? '<div class="mscl-f"><label for="mscl-nome">Nome</label><input id="mscl-nome" name="nome" autocomplete="name" required></div>' : '') +
        '<div class="mscl-f"><label for="mscl-email">E-mail</label><input id="mscl-email" name="email" type="email" autocomplete="username" required></div>' +
        '<div class="mscl-f"><label for="mscl-senha">Senha</label><input id="mscl-senha" name="senha" type="password" autocomplete="' + (setup ? 'new-password' : 'current-password') + '" required minlength="' + (setup ? 8 : 1) + '"></div>' +
        '<button class="mscl-btn" type="submit" style="width:100%;margin-top:4px">' + (setup ? 'Criar e entrar' : 'Entrar') + '</button>' +
        (setup ? '' : '<p class="mscl-small" style="margin:14px 0 0">Esqueceu a senha? Peça ao administrador ou ao gestor da sua empresa para definir uma nova.</p>') +
        '</form>';
      if (!ov.parentNode) document.body.appendChild(ov);
      var f = ov.querySelector('form'), errBox = ov.querySelector('[data-err]'), btn = f.querySelector('button');
      setTimeout(function () { var i = f.querySelector('input'); if (i) i.focus(); }, 0);
      f.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var dados = { email: f.email.value, senha: f.senha.value };
        if (setup) dados.nome = f.nome.value;
        btn.disabled = true; errBox.hidden = true;
        api('POST', setup ? '/api/setup' : '/api/login', dados).then(function () { location.reload(); }, function (e) {
          btn.disabled = false; errBox.textContent = e.message; errBox.hidden = false;
        });
      });
    });
  }

  function sessaoEncerrada() {
    if (sessaoCaiu) return;
    sessaoCaiu = true; clearTimeout(timerSync);
    telaLogin('login', 'Sua sessão terminou. Entre novamente para continuar; o que não foi salvo pode precisar ser refeito.');
  }

  var podeGerir = false;
  function menuConta() {
    noBody(function () {
      css();
      var b = document.createElement('button');
      b.className = 'mscl-pill'; b.type = 'button'; b.setAttribute('aria-haspopup', 'menu');
      b.textContent = EU.nome;
      b.title = 'Sua conta';
      document.body.appendChild(b);
      var menu = null;
      function fechar() { if (menu) { menu.remove(); menu = null; b.setAttribute('aria-expanded', 'false'); } }
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (menu) return fechar();
        menu = document.createElement('div'); menu.className = 'mscl-menu'; menu.setAttribute('role', 'menu');
        menu.innerHTML = '<div class="who"><b>' + esc(EU.nome) + '</b>' + esc(EU.email) + (EU.isOwner ? '<br><span class="mscl-tag adm">Administrador</span>' : '') + '</div>' +
          (podeGerir ? '<button role="menuitem" data-a="contas">Contas de acesso</button>' : '') +
          '<button role="menuitem" data-a="senha">Alterar minha senha</button><button role="menuitem" data-a="sair">Sair</button>';
        document.body.appendChild(menu); b.setAttribute('aria-expanded', 'true');
        menu.addEventListener('click', function (e2) {
          var a = e2.target.closest('[data-a]'); if (!a) return;
          e2.stopPropagation(); fechar();
          if (a.dataset.a === 'sair') api('POST', '/api/logout', {}).then(function () { location.reload(); }, function () { location.reload(); });
          if (a.dataset.a === 'senha') modalSenha();
          if (a.dataset.a === 'contas') modalContas();
        });
      });
      document.addEventListener('click', fechar);
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') fechar(); });
    });
  }

  function abrirModal(html) {
    var m = document.createElement('div'); m.className = 'mscl-modal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true');
    m.innerHTML = '<div class="box">' + html + '</div>';
    document.body.appendChild(m);
    var fechar = function () { m.remove(); document.removeEventListener('keydown', k); };
    var k = function (e) { if (e.key === 'Escape') fechar(); };
    document.addEventListener('keydown', k);
    m.addEventListener('click', function (e) { if (e.target === m || e.target.closest('[data-fechar]')) fechar(); });
    return { el: m, fechar: fechar };
  }

  function modalSenha() {
    var m = abrirModal('<div class="top"><div><h2>Alterar minha senha</h2><div class="mscl-small">Mínimo de 8 caracteres.</div></div><button class="mscl-btn g sm" data-fechar>Fechar</button></div>' +
      '<form novalidate><div class="mscl-err" hidden data-err></div><div class="mscl-ok" hidden data-ok></div>' +
      '<div class="mscl-f"><label for="mscl-sa">Senha atual</label><input id="mscl-sa" type="password" name="atual" autocomplete="current-password"></div>' +
      '<div class="mscl-f"><label for="mscl-sn">Nova senha</label><input id="mscl-sn" type="password" name="nova" autocomplete="new-password"></div>' +
      '<button class="mscl-btn" type="submit">Salvar nova senha</button></form>');
    var f = m.el.querySelector('form'), er = f.querySelector('[data-err]'), ok = f.querySelector('[data-ok]');
    f.addEventListener('submit', function (ev) {
      ev.preventDefault(); er.hidden = true; ok.hidden = true;
      api('POST', '/api/senha', { atual: f.atual.value, nova: f.nova.value }).then(function () { ok.textContent = 'Senha alterada.'; ok.hidden = false; f.reset(); }, function (e) { er.textContent = e.message; er.hidden = false; });
    });
  }

  function modalContas() {
    var m = abrirModal('<div class="top"><div><h2>Contas de acesso</h2><div class="mscl-small">' +
      (EU.isOwner ? 'Crie aqui o login de cada pessoa. Depois vincule a conta em <b>Cadastro de Afiliados</b> (gestor de cliente) ou em <b>Empregados / Usuários › Cadastro de Usuários e Responsáveis</b>, escolhendo as empresas e abas que ela pode ver.'
        : 'Crie aqui o login das pessoas da sua empresa. Depois vincule a conta em <b>Empregados / Usuários › Cadastro de Usuários e Responsáveis</b>, escolhendo as empresas e abas que ela pode ver.') +
      '</div></div><button class="mscl-btn g sm" data-fechar>Fechar</button></div>' +
      '<form novalidate data-novo style="border:1px solid #E6EDF5;border-radius:10px;padding:14px;margin-bottom:8px"><b style="display:block;margin-bottom:10px">Nova conta</b>' +
      '<div class="mscl-err" hidden data-err></div><div class="mscl-ok" hidden data-ok></div><div class="mscl-grid">' +
      '<div class="mscl-f"><label for="mscl-cn">Nome</label><input id="mscl-cn" name="nome" autocomplete="off"></div>' +
      '<div class="mscl-f"><label for="mscl-ce">E-mail</label><input id="mscl-ce" name="email" type="email" autocomplete="off"></div>' +
      '<div class="mscl-f"><label for="mscl-cs">Senha inicial</label><input id="mscl-cs" name="senha" type="text" autocomplete="off" placeholder="mínimo 8 caracteres"></div></div>' +
      '<div class="mscl-act"><button class="mscl-btn" type="submit">Criar conta</button><button class="mscl-btn g" type="button" data-gerar>Gerar senha</button></div>' +
      '<div class="mscl-small" style="margin-top:8px">Envie o endereço do sistema, o e-mail e a senha inicial para a pessoa. Ela pode trocar a senha depois, no botão com o nome dela.</div></form>' +
      '<div data-lista><div class="mscl-small">Carregando…</div></div>');
    var f = m.el.querySelector('[data-novo]'), er = f.querySelector('[data-err]'), ok = f.querySelector('[data-ok]'), lista = m.el.querySelector('[data-lista]');
    var gerar = function () { var cs = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789', a = new Uint8Array(10), s = ''; crypto.getRandomValues(a); a.forEach(function (x) { s += cs[x % cs.length]; }); return s; };
    f.querySelector('[data-gerar]').addEventListener('click', function () { f.senha.value = gerar(); });
    function carregar() {
      api('GET', '/api/contas').then(function (r) {
        if (!r.contas.length) { lista.innerHTML = '<div class="mscl-small">Nenhuma conta criada ainda.</div>'; return; }
        lista.innerHTML = '<table class="mscl-tab"><thead><tr><th>Nome</th><th>E-mail</th><th>Situação</th><th>Último acesso</th><th></th></tr></thead><tbody>' +
          r.contas.map(function (c) {
            return '<tr><td>' + esc(c.nome) + (c.isOwner ? ' <span class="mscl-tag adm">Administrador</span>' : '') + '</td><td>' + esc(c.email) + '</td>' +
              '<td>' + (c.ativo ? '<span class="mscl-tag">Ativa</span>' : '<span class="mscl-tag off">Desativada</span>') + '</td>' +
              '<td class="mscl-small">' + (c.ultimoAcesso ? new Date(c.ultimoAcesso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'Nunca entrou') + '</td>' +
              '<td><div class="mscl-act">' + (c.id === EU.id ? '' : '<button class="mscl-btn g sm" data-senha="' + esc(c.id) + '" data-nome="' + esc(c.nome) + '">Nova senha</button>' +
              '<button class="mscl-btn sm ' + (c.ativo ? 'd' : 'g') + '" data-ativo="' + (c.ativo ? '0' : '1') + '" data-id="' + esc(c.id) + '">' + (c.ativo ? 'Desativar' : 'Reativar') + '</button>') + '</div></td></tr>';
          }).join('') + '</tbody></table>';
      }, function (e) { lista.innerHTML = '<div class="mscl-err">' + esc(e.message) + '</div>'; });
    }
    lista.addEventListener('click', function (ev) {
      var s = ev.target.closest('[data-senha]'), a = ev.target.closest('[data-ativo]');
      if (s) {
        var nova = window.prompt('Nova senha para ' + s.dataset.nome + ' (mínimo 8 caracteres):', gerar());
        if (!nova) return;
        api('PATCH', '/api/contas/' + encodeURIComponent(s.dataset.senha), { senha: nova }).then(function () { ok.textContent = 'Senha de ' + s.dataset.nome + ' alterada para: ' + nova; ok.hidden = false; er.hidden = true; }, function (e) { er.textContent = e.message; er.hidden = false; ok.hidden = true; });
      }
      if (a) {
        if (a.dataset.ativo === '0' && !window.confirm('Desativar esta conta? A pessoa sai do sistema na hora e não consegue mais entrar.')) return;
        api('PATCH', '/api/contas/' + encodeURIComponent(a.dataset.id), { ativo: a.dataset.ativo === '1' }).then(carregar, function (e) { er.textContent = e.message; er.hidden = false; });
      }
    });
    f.addEventListener('submit', function (ev) {
      ev.preventDefault(); er.hidden = true; ok.hidden = true;
      var d = { nome: f.nome.value, email: f.email.value, senha: f.senha.value };
      api('POST', '/api/contas', d).then(function (r) {
        ok.textContent = 'Conta criada: ' + r.conta.email + ' · senha inicial: ' + d.senha; ok.hidden = false; f.reset(); carregar();
      }, function (e) { er.textContent = e.message; er.hidden = false; });
    });
    carregar();
  }

  /* ---------- início ---------- */
  var votacao = /(?:^|[#&?])votar=/.test(String(location.hash || '') + String(location.search || ''));
  api('GET', '/api/me').then(function (r) {
    EU = r.conta; podeGerir = !!r.podeGerirContas;
    menuConta();
    return carregarTudo().then(function () {
      pronto = true; filaPronto.splice(0).forEach(function (f) { f(); });
      liberar({ __pronto: true, db: dbApi, user: userApi, assets: assetsApi, downloads: dlApi });
      agendarSync();
    });
  }, function (e) {
    if (e.status === 401 && votacao) { liberar({ __pronto: true, db: dbPublico() }); return; }
    if (e.status === 401) { telaLogin(e.body && e.body.setup ? 'setup' : 'login'); return; }
    telaLogin('login', e.code === 'config' ? 'O servidor não está configurado: ' + e.message : 'Não foi possível conectar ao servidor (' + e.message + '). Tente recarregar a página.');
  }).catch(function (e) {
    telaLogin('login', 'Não foi possível carregar os dados (' + (e && e.message) + '). Recarregue a página.');
  });
})();
