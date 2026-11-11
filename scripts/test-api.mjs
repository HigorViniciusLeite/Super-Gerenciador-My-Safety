/* Teste das regras da API contra um servidor local (scripts/dev-server.mjs) com banco vazio.
   Uso: BASE=http://localhost:8888 node scripts/test-api.mjs */
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:8888';
const ADMIN = process.env.ADMIN_EMAIL || 'admin@teste.com';

function cliente() {
  let cookie = '';
  return async (metodo, caminho, corpo, semCsrf) => {
    const h = { 'content-type': 'application/json' };
    if (!semCsrf) h['x-ms'] = '1';
    if (cookie) h.cookie = cookie;
    const r = await fetch(BASE + caminho, { method: metodo, headers: h, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, j: await r.json().catch(() => ({})) };
  };
}
const ok = (nome) => console.log('ok  ' + nome);

const adm = cliente(), ana = cliente(), bia = cliente(), anon = cliente();
let r = await adm('POST', '/api/setup', { nome: 'Adm', email: 'outro@x.com', senha: '12345678' });
assert.equal(r.status, 403); ok('setup recusa e-mail diferente de ADMIN_EMAIL');
r = await adm('POST', '/api/setup', { nome: 'Adm', email: ADMIN, senha: 'senhaforte1' });
assert.equal(r.status, 200); ok('setup cria administrador');
r = await anon('POST', '/api/setup', { nome: 'X', email: ADMIN, senha: 'senhaforte1' });
assert.equal(r.status, 409); ok('setup só funciona uma vez');
r = await adm('GET', '/api/me'); assert.equal(r.j.conta.isOwner, true); ok('me do administrador');
r = await anon('POST', '/api/login', { email: ADMIN, senha: 'senhaforte1' }, true);
assert.equal(r.status, 403); ok('gravação sem cabeçalho x-ms é recusada (CSRF)');

/* contas */
r = await adm('POST', '/api/contas', { nome: 'Ana Gestora', email: 'ana@cliente-a.com', senha: 'anasenha1' }); assert.equal(r.status, 200); const anaId = r.j.conta.id;
r = await adm('POST', '/api/contas', { nome: 'Bia Gestora', email: 'bia@cliente-b.com', senha: 'biasenha1' }); const biaId = r.j.conta.id;
r = await adm('POST', '/api/contas', { nome: 'Dup', email: 'ANA@cliente-a.com', senha: 'xxxxxxxx' }); assert.equal(r.status, 409); ok('e-mail duplicado recusado');
r = await ana('POST', '/api/login', { email: 'ana@cliente-a.com', senha: 'errada' }); assert.equal(r.status, 401);
r = await ana('POST', '/api/login', { email: 'ana@cliente-a.com', senha: 'anasenha1' }); assert.equal(r.status, 200);
await bia('POST', '/api/login', { email: 'bia@cliente-b.com', senha: 'biasenha1' }); ok('login');
r = await ana('GET', '/api/me'); assert.equal(r.j.liberado, false); assert.equal(r.j.podeGerirContas, false); ok('conta sem vínculo não é liberada');
r = await ana('GET', '/api/sync?since=0'); assert.equal(r.j.docs.length, 0);

/* administrador cadastra empresas e gestores (afiliados) */
r = await adm('POST', '/api/write', { ops: [
  { c: 'empresas', id: 'EA', t: 'set', d: { id: 'EA', razao: 'Cliente A', tipo: 'matriz' } },
  { c: 'empresas', id: 'EA1', t: 'set', d: { id: 'EA1', razao: 'Cliente A filial', tipo: 'filial', matrizId: 'EA' } },
  { c: 'empresas', id: 'EB', t: 'set', d: { id: 'EB', razao: 'Cliente B', tipo: 'matriz' } },
  { c: 'empregados', id: 'P1', t: 'set', d: { id: 'P1', nome: 'Empregado A', empresaId: 'EA1' } },
  { c: 'empregados', id: 'P2', t: 'set', d: { id: 'P2', nome: 'Empregado B', empresaId: 'EB' } },
  { c: 'gestores', id: anaId, t: 'set', d: { id: anaId, nome: 'Ana', contaId: anaId, matrizes: ['EA'], situacao: 'ativo' } },
  { c: 'gestores', id: biaId, t: 'set', d: { id: biaId, nome: 'Bia', contaId: biaId, matrizes: ['EB'], situacao: 'ativo', validade: '2000-01-01' } },
  { c: 'config', id: 'hrn', t: 'set', d: { id: 'hrn', levels: [1] } },
  { c: 'epis', id: 'X1', t: 'set', d: { id: 'X1', nome: 'Capacete' } }
] });
assert.deepEqual(r.j.resultados, Array(9).fill('ok')); ok('administrador grava tudo');

await new Promise((s) => setTimeout(s, 3200)); /* espera passar a janela de 3 s do cursor */
r = await ana('GET', '/api/me'); assert.equal(r.j.liberado, true); assert.equal(r.j.podeGerirContas, true);
r = await ana('GET', '/api/sync?since=0');
const ids = r.j.docs.map((d) => d.c + ':' + d.id).sort();
assert.deepEqual(ids, ['config:hrn', 'empregados:P1', 'empresas:EA', 'empresas:EA1', 'epis:X1', 'gestores:' + anaId].sort()); ok('gestora A vê só a matriz A, a filial e os dados delas');
const cursorAna = r.j.cursor, escAna = r.j.escopo;
r = await bia('GET', '/api/me'); assert.equal(r.j.liberado, false); ok('gestora com acesso vencido não é liberada');
r = await bia('GET', '/api/sync?since=0'); assert.equal(r.j.docs.length, 0);

/* gravações da gestora A */
r = await ana('POST', '/api/write', { ops: [
  { c: 'empregados', id: 'P3', t: 'set', d: { id: 'P3', nome: 'Novo', empresaId: 'EA' } },
  { c: 'empregados', id: 'P2', t: 'merge', d: { nome: 'Invadido' } },
  { c: 'empregados', id: 'P4', t: 'set', d: { id: 'P4', nome: 'Em B', empresaId: 'EB' } },
  { c: 'empregados', id: 'P1', t: 'merge', d: { empresaId: 'EB' } },
  { c: 'gestores', id: anaId, t: 'merge', d: { matrizes: ['EA', 'EB'] } },
  { c: 'empresas', id: 'EA2', t: 'set', d: { id: 'EA2', tipo: 'filial', matrizId: 'EA' } },
  { c: 'empresas', id: 'EB', t: 'merge', d: { gestorConta: anaId } },
  { c: 'usuarios', id: 'U1', t: 'set', d: { id: 'U1', nome: 'Usuário A', empresas: ['EA1'], contaId: 'u_x' } },
  { c: 'usuarios', id: 'U2', t: 'set', d: { id: 'U2', nome: 'Usuário B', empresas: ['EB'] } },
  { c: 'empregados', id: 'P3', t: 'del' }
] });
assert.deepEqual(r.j.resultados, ['ok', 'permission_denied', 'permission_denied', 'permission_denied', 'permission_denied', 'ok', 'permission_denied', 'ok', 'permission_denied', 'ok']);
ok('gestora A não grava nem move dados para a empresa B, nem altera o próprio acesso');

/* conta comum vinculada a um usuário */
r = await ana('POST', '/api/contas', { nome: 'Caio', email: 'caio@cliente-a.com', senha: 'caiosenha1' }); assert.equal(r.status, 200); const caioId = r.j.conta.id;
r = await ana('GET', '/api/contas'); assert.deepEqual(r.j.contas.map((c) => c.email), ['caio@cliente-a.com']); ok('gestora vê só as contas que criou');
r = await ana('GET', '/api/busca?q=gestora'); assert.deepEqual(r.j.contas.map((c) => c.id), [anaId]); ok('busca da gestora não mostra contas de outros clientes');
r = await adm('GET', '/api/busca?q=gestora'); assert.equal(r.j.contas.length, 2);
await ana('POST', '/api/write', { ops: [{ c: 'usuarios', id: 'U1', t: 'merge', d: { contaId: caioId } }] });
const caio = cliente();
await caio('POST', '/api/login', { email: 'caio@cliente-a.com', senha: 'caiosenha1' });
r = await caio('GET', '/api/sync?since=0');
assert.deepEqual(r.j.docs.filter((d) => d.c === 'empresas').map((d) => d.id), ['EA1']); ok('usuário comum vê só a empresa marcada');
r = await caio('POST', '/api/write', { ops: [{ c: 'usuarios', id: 'U1', t: 'merge', d: { empresas: ['EA1', 'EB'] } }] });
assert.deepEqual(r.j.resultados, ['permission_denied']); ok('usuário comum não amplia o próprio acesso');
r = await caio('GET', '/api/contas'); assert.equal(r.status, 403);

/* sincronização incremental */
await new Promise((s) => setTimeout(s, 3200));
r = await ana('GET', '/api/sync?since=' + cursorAna + '&escopo=' + encodeURIComponent(escAna));
assert.equal(r.j.reset, true); ok('escopo mudou (nova filial): servidor pede recarga completa');
r = await ana('GET', '/api/sync?since=0'); const c2 = r.j.cursor, e2 = r.j.escopo;
await ana('POST', '/api/write', { ops: [{ c: 'empregados', id: 'P5', t: 'set', d: { id: 'P5', nome: 'Novo', empresaId: 'EA2' } }, { c: 'empregados', id: 'P1', t: 'del' }] });
await new Promise((s) => setTimeout(s, 3200));
r = await ana('GET', '/api/sync?since=' + c2 + '&escopo=' + encodeURIComponent(e2));
assert.equal(r.j.reset, undefined);
const delta = r.j.docs.map((d) => d.c + ':' + d.id + (d.d ? '' : ' (excluído)')).sort();
assert.ok(delta.includes('empregados:P1 (excluído)') && delta.includes('empregados:P5'), delta.join()); ok('sincronização incremental traz alterações e exclusões');

/* desativar conta derruba a sessão */
r = await ana('PATCH', '/api/contas/' + caioId, { ativo: false }); assert.equal(r.status, 200);
r = await caio('GET', '/api/me'); assert.equal(r.status, 401); ok('conta desativada perde a sessão na hora');
r = await ana('PATCH', '/api/contas/' + biaId, { ativo: false }); assert.equal(r.status, 404); ok('gestora não mexe em contas de outros');

/* arquivos */
const up = await fetch(BASE + '/api/assets', { method: 'POST', headers: { 'x-ms': '1', 'content-type': 'image/png', cookie: '' }, body: new Uint8Array([1, 2, 3]) });
assert.equal(up.status, 401); ok('upload exige login');

/* votação pública */
await adm('POST', '/api/write', { ops: [{ c: 'urnas', id: 'G1', t: 'set', d: { id: 'G1', empresaId: 'EA', status: 'aberta', eleitores: ['a'.repeat(64)], candidatos: [{ id: 'C1', numero: 1, nome: 'Cand' }] } }] });
r = await anon('GET', '/api/public/urna/G1'); assert.equal(r.j.existe, true);
const part = 'G1_' + 'a'.repeat(40);
r = await anon('POST', '/api/public/votar', { urnaId: 'G1', partId: 'G1_' + 'b'.repeat(40), candidatoId: 'C1' }); assert.equal(r.status, 403); ok('voto de quem não é eleitor é recusado');
r = await anon('POST', '/api/public/votar', { urnaId: 'G1', partId: part, candidatoId: 'C1', dia: '2026-11-11' }); assert.equal(r.j.ok, true);
r = await anon('POST', '/api/public/votar', { urnaId: 'G1', partId: part, candidatoId: 'C1' }); assert.equal(r.j.ja, true); ok('votação pública: um voto por eleitor');
r = await anon('GET', '/api/sync?since=0'); assert.equal(r.status, 401); ok('dados exigem login');
console.log('\nTodos os testes passaram.');
