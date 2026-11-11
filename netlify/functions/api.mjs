/* API do Super Gerenciador My Safety (Netlify Functions + Neon).
   Rotas: login e contas de acesso, sincronização dos dados, gravação, arquivos e votação pública da CIPA. */
import { q } from '../lib/db.mjs';
import { hashSenha, conferirSenha, cookieSessao, cookieSair, lerSessao, novoId } from '../lib/auth.mjs';
import { montarContexto, chaveEscopo, podeLer, podeGravar, SOB_DEMANDA } from '../lib/escopo.mjs';

export const config = { path: ['/api/*', '/_blob/*'] };

const PAGINA = 1500;
const MAX_BYTES_RESP = 3_500_000;
const MAX_ASSET = 4_500_000;
const MAX_OPS = 300;
const RE_COL = /^[A-Za-z0-9_]{1,40}$/;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const json = (status, obj, headers = {}) => new Response(JSON.stringify(obj), {
  status, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, headers)
});
const erro = (status, codigo, mensagem) => json(status, { erro: codigo, mensagem: mensagem || codigo });
const email = (s) => String(s || '').trim().toLowerCase();
const pub = (c) => ({ id: c.id, nome: c.nome, email: c.email, isOwner: !!c.is_owner, ativo: !!c.ativo, criadoEm: c.criado_em, ultimoAcesso: c.ultimo_acesso, criadoPor: c.criado_por || '' });

async function corpo(req) { try { return await req.json(); } catch (e) { return {}; } }

async function contaDaSessao(req) {
  const s = lerSessao(req);
  if (!s) return null;
  const [c] = await q('select * from ms_contas where id = $1', [s.u]);
  if (!c || !c.ativo || c.sv !== s.v) return null;
  return c;
}

async function contexto(conta) {
  if (conta.is_owner) return montarContexto(conta, [], [], []);
  const rows = await q("select col, id, data from ms_docs where not deleted and col in ('empresas', 'gestores', 'usuarios')");
  const by = { empresas: [], gestores: [], usuarios: [] };
  rows.forEach((r) => by[r.col].push(Object.assign({ id: r.id }, r.data)));
  return montarContexto(conta, by.empresas, by.gestores, by.usuarios);
}

/* ---------- login ---------- */
async function bloqueado(chave) {
  const [t] = await q('select n, ate > now() as ativo from ms_tentativas where chave = $1', [chave]);
  return !!(t && t.ativo && t.n >= 8);
}
async function falhou(chave) {
  await q(`insert into ms_tentativas (chave, n, ate) values ($1, 1, now() + interval '15 minutes')
           on conflict (chave) do update set n = case when ms_tentativas.ate > now() then ms_tentativas.n + 1 else 1 end,
           ate = now() + interval '15 minutes'`, [chave]);
}

async function rotaMe(req) {
  const c = await contaDaSessao(req);
  if (!c) {
    const [n] = await q('select count(*)::int as n from ms_contas');
    return json(401, { erro: 'sem_sessao', setup: n.n === 0 });
  }
  const ctx = await contexto(c);
  return json(200, { conta: pub(c), podeGerirContas: ctx.owner || ctx.gestor, liberado: ctx.liberado });
}

async function rotaSetup(req, seguro) {
  const b = await corpo(req);
  const [n] = await q('select count(*)::int as n from ms_contas');
  if (n.n > 0) return erro(409, 'ja_configurado', 'O administrador já foi criado.');
  const em = email(b.email), admin = email(process.env.ADMIN_EMAIL);
  if (!admin) return erro(500, 'config', 'Defina a variável ADMIN_EMAIL na Netlify antes de criar o administrador.');
  if (em !== admin) return erro(403, 'email_admin', 'Use o e-mail definido em ADMIN_EMAIL na Netlify.');
  const v = validarConta(b, true);
  if (v) return erro(400, 'invalido', v);
  const conta = { id: novoId('u_'), sv: 1 };
  await q('insert into ms_contas (id, email, nome, senha, is_owner, ultimo_acesso) values ($1, $2, $3, $4, true, now())', [conta.id, em, String(b.nome).trim(), hashSenha(b.senha)]);
  return json(200, { ok: true }, { 'set-cookie': cookieSessao(conta, seguro) });
}

async function rotaLogin(req, seguro) {
  const b = await corpo(req);
  const em = email(b.email), chave = 'login:' + em;
  if (!em || !b.senha) return erro(400, 'invalido', 'Informe e-mail e senha.');
  if (await bloqueado(chave)) return erro(429, 'bloqueado', 'Muitas tentativas. Aguarde 15 minutos e tente de novo.');
  const [c] = await q('select * from ms_contas where email = $1', [em]);
  if (!c || !conferirSenha(b.senha, c.senha)) { await falhou(chave); return erro(401, 'credenciais', 'E-mail ou senha incorretos.'); }
  if (!c.ativo) return erro(403, 'inativo', 'Esta conta está desativada. Fale com o administrador.');
  await q('delete from ms_tentativas where chave = $1', [chave]);
  await q('update ms_contas set ultimo_acesso = now() where id = $1', [c.id]);
  return json(200, { ok: true }, { 'set-cookie': cookieSessao(c, seguro) });
}

async function rotaSenha(req, conta, seguro) {
  const b = await corpo(req);
  if (!conferirSenha(b.atual, conta.senha)) return erro(400, 'senha_atual', 'A senha atual não confere.');
  if (String(b.nova || '').length < 8) return erro(400, 'invalido', 'A nova senha precisa ter pelo menos 8 caracteres.');
  const [c] = await q('update ms_contas set senha = $2, sv = sv + 1, atualizado_em = now() where id = $1 returning *', [conta.id, hashSenha(b.nova)]);
  return json(200, { ok: true }, { 'set-cookie': cookieSessao(c, seguro) });
}

function validarConta(b, comSenha) {
  if (String(b.nome || '').trim().length < 2) return 'Informe o nome.';
  if (!RE_EMAIL.test(email(b.email))) return 'Informe um e-mail válido.';
  if (comSenha && String(b.senha || '').length < 8) return 'A senha precisa ter pelo menos 8 caracteres.';
  return '';
}

/* ---------- contas de acesso (administrador e gestores/afiliados) ---------- */
async function rotaContas(req, conta, partes) {
  const ctx = await contexto(conta);
  if (!ctx.owner && !ctx.gestor) return erro(403, 'sem_permissao', 'Somente o administrador ou o gestor da empresa gerencia contas.');
  if (req.method === 'GET') {
    const rows = ctx.owner ? await q('select * from ms_contas order by nome') : await q('select * from ms_contas where criado_por = $1 order by nome', [conta.id]);
    return json(200, { contas: rows.map(pub) });
  }
  if (req.method === 'POST' && !partes[1]) {
    const b = await corpo(req);
    const v = validarConta(b, true);
    if (v) return erro(400, 'invalido', v);
    const [ja] = await q('select id from ms_contas where email = $1', [email(b.email)]);
    if (ja) return erro(409, 'email_existe', 'Já existe uma conta com este e-mail.');
    const [c] = await q('insert into ms_contas (id, email, nome, senha, criado_por) values ($1, $2, $3, $4, $5) returning *', [novoId('u_'), email(b.email), String(b.nome).trim(), hashSenha(b.senha), conta.id]);
    return json(200, { conta: pub(c) });
  }
  if (req.method === 'PATCH' && partes[1]) {
    const [alvo] = await q('select * from ms_contas where id = $1', [partes[1]]);
    if (!alvo || (!ctx.owner && alvo.criado_por !== conta.id)) return erro(404, 'nao_encontrada', 'Conta não encontrada.');
    const b = await corpo(req);
    const sets = [], vals = [alvo.id];
    let derruba = false;
    if (b.nome !== undefined) { if (String(b.nome).trim().length < 2) return erro(400, 'invalido', 'Informe o nome.'); vals.push(String(b.nome).trim()); sets.push('nome = $' + vals.length); }
    if (b.email !== undefined) {
      const em = email(b.email);
      if (!RE_EMAIL.test(em)) return erro(400, 'invalido', 'Informe um e-mail válido.');
      const [ja] = await q('select id from ms_contas where email = $1 and id <> $2', [em, alvo.id]);
      if (ja) return erro(409, 'email_existe', 'Já existe uma conta com este e-mail.');
      vals.push(em); sets.push('email = $' + vals.length);
    }
    if (b.ativo !== undefined) {
      if (alvo.id === conta.id) return erro(400, 'propria_conta', 'Você não pode desativar a sua própria conta.');
      vals.push(!!b.ativo); sets.push('ativo = $' + vals.length); if (!b.ativo) derruba = true;
    }
    if (b.senha !== undefined) {
      if (String(b.senha).length < 8) return erro(400, 'invalido', 'A senha precisa ter pelo menos 8 caracteres.');
      vals.push(hashSenha(b.senha)); sets.push('senha = $' + vals.length); derruba = true;
    }
    if (!sets.length) return json(200, { conta: pub(alvo) });
    if (derruba) sets.push('sv = sv + 1');
    const [c] = await q('update ms_contas set ' + sets.join(', ') + ', atualizado_em = now() where id = $1 returning *', vals);
    return json(200, { conta: pub(c) });
  }
  return erro(405, 'metodo');
}

async function rotaBusca(url, conta) {
  const termo = String(url.searchParams.get('q') || '').trim();
  if (termo.length < 2) return json(200, { contas: [] });
  const ctx = await contexto(conta);
  const like = '%' + termo.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
  let rows;
  if (ctx.owner) rows = await q('select id, nome, email from ms_contas where ativo and (nome ilike $1 or email ilike $1) order by nome limit 20', [like]);
  else if (ctx.gestor) rows = await q('select id, nome, email from ms_contas where ativo and (criado_por = $2 or id = $2) and (nome ilike $1 or email ilike $1) order by nome limit 20', [like, conta.id]);
  else rows = await q('select id, nome, email from ms_contas where id = $2 and (nome ilike $1 or email ilike $1)', [like, conta.id]);
  return json(200, { contas: rows.map((r) => ({ id: r.id, name: r.nome, email: r.email })) });
}

async function rotaPerfis(url) {
  const ids = String(url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 300);
  if (!ids.length) return json(200, { perfis: {} });
  const rows = await q('select id, nome from ms_contas where id = any($1)', [ids]);
  const out = {};
  rows.forEach((r) => { out[r.id] = { name: r.nome }; });
  return json(200, { perfis: out });
}

/* ---------- dados ---------- */
async function rotaSync(url, conta) {
  const ctx = await contexto(conta);
  const chave = chaveEscopo(ctx);
  const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
  const completa = since === 0 || url.searchParams.get('full') === '1';
  if (!completa && url.searchParams.get('escopo') !== chave) return json(200, { reset: true, escopo: chave });
  const rows = await q(
    `select col, id, data, deleted, seq::text as seq, (atualizado_em > now() - interval '3 seconds') as recente
       from ms_docs where seq > $1 and not (col = any($2))` + (completa ? ' and not deleted' : '') + ` order by seq limit ${PAGINA}`,
    [since, Array.from(SOB_DEMANDA)]);
  const docs = [];
  let cursor = since, travado = false, mais = rows.length === PAGINA, bytes = 0;
  for (const r of rows) {
    if (bytes > MAX_BYTES_RESP) { mais = true; break; }
    const ok = !r.deleted && podeLer(ctx, r.col, r.id, r.data);
    if (ok) { const item = { c: r.col, id: r.id, d: r.data }; docs.push(item); bytes += JSON.stringify(r.data).length + 64; }
    else if (!completa) docs.push({ c: r.col, id: r.id, d: null });
    if (!travado) { if (r.recente) travado = true; else cursor = Number(r.seq); }
  }
  return json(200, { cursor, mais: mais && !travado, escopo: chave, liberado: ctx.liberado, docs });
}

async function rotaDoc(url, conta) {
  const c = url.searchParams.get('c') || '', id = url.searchParams.get('id') || '';
  if (!RE_COL.test(c) || !id) return erro(400, 'invalido');
  const ctx = await contexto(conta);
  const [r] = await q('select data from ms_docs where col = $1 and id = $2 and not deleted', [c, id]);
  if (!r || !podeLer(ctx, c, id, r.data)) return json(200, { existe: false });
  return json(200, { existe: true, d: r.data });
}

async function rotaWrite(req, conta) {
  const b = await corpo(req);
  const ops = Array.isArray(b.ops) ? b.ops.slice(0, MAX_OPS) : [];
  if (!ops.length) return json(200, { resultados: [] });
  const ctx = await contexto(conta);
  const chaves = Array.from(new Set(ops.filter((o) => o && RE_COL.test(o.c || '') && o.id).map((o) => o.c + '\u0001' + o.id)));
  const antigos = {};
  if (chaves.length) {
    const rows = await q("select col, id, data from ms_docs where not deleted and (col || chr(1) || id) = any($1)", [chaves]);
    rows.forEach((r) => { antigos[r.col + '\u0001' + r.id] = r.data; });
  }
  const estado = {}, mudou = new Set(), resultados = [];
  for (const o of ops) {
    if (!o || !RE_COL.test(o.c || '') || typeof o.id !== 'string' || !o.id || o.id.length > 300) { resultados.push('invalido'); continue; }
    const k = o.c + '\u0001' + o.id;
    const base = k in estado ? estado[k] : (antigos[k] || null);
    let novo;
    if (o.t === 'del') novo = null;
    else if (o.d && typeof o.d === 'object' && !Array.isArray(o.d)) novo = o.t === 'merge' ? Object.assign({}, base || {}, o.d) : o.d;
    else { resultados.push('invalido'); continue; }
    if (!podeGravar(ctx, o.c, o.id, antigos[k] || null, novo)) { resultados.push('permission_denied'); continue; }
    estado[k] = novo; mudou.add(k); resultados.push('ok');
  }
  if (mudou.size) {
    const cs = [], is = [], ds = [], del = [];
    mudou.forEach((k) => { const [c, id] = k.split('\u0001'); cs.push(c); is.push(id); ds.push(estado[k] ? JSON.stringify(estado[k]) : null); del.push(!estado[k]); });
    await q(`insert into ms_docs (col, id, data, deleted, seq, atualizado_em, atualizado_por)
             select c, i, d::jsonb, dl, nextval('ms_docs_seq'), now(), $5 from unnest($1::text[], $2::text[], $3::text[], $4::boolean[]) as t(c, i, d, dl)
             on conflict (col, id) do update set data = excluded.data, deleted = excluded.deleted, seq = excluded.seq,
               atualizado_em = excluded.atualizado_em, atualizado_por = excluded.atualizado_por`, [cs, is, ds, del, conta.id]);
  }
  return json(200, { resultados });
}

/* ---------- arquivos (fotos, PDFs, assinaturas) ---------- */
async function rotaAssets(req, conta, partes) {
  if (req.method === 'POST') {
    const buf = Buffer.from(await req.arrayBuffer());
    if (!buf.length) return erro(400, 'vazio', 'Arquivo vazio.');
    if (buf.length > MAX_ASSET) return erro(413, 'grande', 'Arquivo maior que 4,5 MB.');
    const tipo = String(req.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().slice(0, 100) || 'application/octet-stream';
    const id = novoId();
    await q('insert into ms_assets (id, tipo, tamanho, dados, criado_por) values ($1, $2, $3, $4, $5)', [id, tipo, buf.length, buf.toString('base64'), conta.id]);
    return json(200, { id, url: '/_blob/' + id, sizeBytes: buf.length, contentType: tipo });
  }
  if (req.method === 'GET') {
    const rows = conta.is_owner ? await q('select id, tipo, tamanho from ms_assets order by criado_em desc limit 2000') : await q('select id, tipo, tamanho from ms_assets where criado_por = $1 order by criado_em desc limit 2000', [conta.id]);
    return json(200, { assets: rows.map((r) => ({ id: r.id, url: '/_blob/' + r.id, sizeBytes: r.tamanho, contentType: r.tipo })) });
  }
  if (req.method === 'DELETE' && partes[1]) {
    if (conta.is_owner) await q('delete from ms_assets where id = $1', [partes[1]]);
    else await q('delete from ms_assets where id = $1 and criado_por = $2', [partes[1], conta.id]);
    return json(200, { ok: true });
  }
  return erro(405, 'metodo');
}

async function rotaBlob(id, conta) {
  if (!conta) return new Response('Faça login para ver este arquivo.', { status: 401 });
  const [r] = await q('select tipo, dados from ms_assets where id = $1', [id]);
  if (!r) return new Response('Arquivo não encontrado.', { status: 404 });
  const inline = /^(image\/(png|jpeg|webp|gif)|application\/pdf)$/.test(r.tipo);
  return new Response(Buffer.from(r.dados, 'base64'), {
    status: 200,
    headers: {
      'content-type': r.tipo,
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      'content-disposition': inline ? 'inline' : 'attachment'
    }
  });
}

/* ---------- votação pública da CIPA (sem login) ---------- */
async function urnaPorId(id) {
  const [r] = await q("select data from ms_docs where col = 'urnas' and id = $1 and not deleted", [id]);
  return r ? r.data : null;
}

async function rotaPublica(req, partes) {
  if (req.method === 'GET' && partes[1] === 'urna' && partes[2]) {
    const u = await urnaPorId(partes[2]);
    return json(200, u ? { existe: true, d: u } : { existe: false });
  }
  if (req.method === 'GET' && partes[1] === 'part' && partes[2]) {
    const [r] = await q("select 1 from ms_docs where col = 'urnaPart' and id = $1 and not deleted", [partes[2]]);
    return json(200, { existe: !!r });
  }
  if (req.method === 'POST' && partes[1] === 'votar') {
    const b = await corpo(req);
    const u = b.urnaId ? await urnaPorId(String(b.urnaId)) : null;
    if (!u || u.status !== 'aberta') return erro(400, 'fechada', 'A votação não está aberta.');
    const partId = String(b.partId || ''), pref = String(b.urnaId) + '_';
    const chave = partId.startsWith(pref) ? partId.slice(pref.length) : '';
    if (chave.length < 16 || !(u.eleitores || []).some((h) => String(h).startsWith(chave))) return erro(403, 'eleitor', 'Eleitor não encontrado.');
    if (!(u.candidatos || []).some((c) => c.id === b.candidatoId)) return erro(400, 'candidato', 'Candidato inválido.');
    const ins = await q(`insert into ms_docs (col, id, data) values ('urnaPart', $1, $2::jsonb)
                         on conflict (col, id) do update set data = excluded.data, deleted = false, seq = nextval('ms_docs_seq'), atualizado_em = now()
                         where ms_docs.deleted returning id`, [partId, JSON.stringify({ urnaId: u.id || b.urnaId, dia: String(b.dia || '').slice(0, 10) })]);
    if (!ins.length) return json(200, { ja: true });
    await q("insert into ms_docs (col, id, data) values ('urnaVotos', $1, $2::jsonb)", [novoId(), JSON.stringify({ urnaId: u.id || b.urnaId, candidatoId: b.candidatoId })]);
    return json(200, { ok: true });
  }
  return erro(404, 'rota');
}

export default async (req) => {
  const url = new URL(req.url);
  const seguro = url.protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
  try {
    if (url.pathname.startsWith('/_blob/')) return await rotaBlob(decodeURIComponent(url.pathname.slice(7)), await contaDaSessao(req));
    const partes = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const rota = partes[0] || '';
    /* proteção contra envio de formulários de outros sites: toda gravação exige este cabeçalho */
    if (req.method !== 'GET' && req.headers.get('x-ms') !== '1') return erro(403, 'csrf');
    if (rota === 'public') return await rotaPublica(req, partes);
    if (rota === 'me' && req.method === 'GET') return await rotaMe(req);
    if (rota === 'setup' && req.method === 'POST') return await rotaSetup(req, seguro);
    if (rota === 'login' && req.method === 'POST') return await rotaLogin(req, seguro);
    if (rota === 'logout' && req.method === 'POST') return json(200, { ok: true }, { 'set-cookie': cookieSair(seguro) });
    const conta = await contaDaSessao(req);
    if (!conta) return erro(401, 'sem_sessao', 'Sua sessão terminou. Entre novamente.');
    if (rota === 'senha' && req.method === 'POST') return await rotaSenha(req, conta, seguro);
    if (rota === 'contas') return await rotaContas(req, conta, partes);
    if (rota === 'busca') return await rotaBusca(url, conta);
    if (rota === 'perfis') return await rotaPerfis(url);
    if (rota === 'sync') return await rotaSync(url, conta);
    if (rota === 'doc') return await rotaDoc(url, conta);
    if (rota === 'write' && req.method === 'POST') return await rotaWrite(req, conta);
    if (rota === 'assets') return await rotaAssets(req, conta, partes);
    return erro(404, 'rota');
  } catch (e) {
    console.error(e);
    if (e && e.code === 'config') return erro(500, 'config', e.message);
    return erro(500, 'interno', 'Erro interno no servidor.');
  }
};
