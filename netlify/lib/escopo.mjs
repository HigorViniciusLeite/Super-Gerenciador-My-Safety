/* Regras de acesso aos dados, aplicadas no servidor.
   Reproduzem as mesmas regras que o app usa para filtrar a tela (escopoIds / escopo no index.html),
   para que um usuário não consiga ler nem gravar dados de empresas que não foram liberadas para ele. */

const hojeBR = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

export function gestorAtivo(g) {
  if (!g) return false;
  const hoje = hojeBR();
  if (g.situacao === 'inativo') return false;
  if (g.inicio && g.inicio > hoje) return false;
  if (g.validade && g.validade < hoje) return false;
  return true;
}

/* Coleções sem vínculo direto com empresa: qualquer conta liberada lê e grava. */
export const ABERTAS = new Set(['config', 'urnaPart', 'urnaVotos', 'entAssin']);
/* Coleções que não são enviadas em bloco na sincronização: lidas documento a documento. */
export const SOB_DEMANDA = new Set(['entAssin']);
const CATALOGOS = new Set(['epis', 'treinamentos', 'pxRiscos']);

/* Monta o contexto de acesso de uma conta a partir dos cadastros de empresas, gestores e usuários. */
export function montarContexto(conta, empresas, gestores, usuarios) {
  const uid = conta.id;
  if (conta.is_owner) return { uid, owner: true, gestor: true, ids: null, liberado: true };
  const mats = new Set(), ids = new Set();
  const meus = gestores.filter((g) => g && g.contaId === uid && gestorAtivo(g));
  meus.forEach((g) => (Array.isArray(g.matrizes) ? g.matrizes : []).forEach((id) => mats.add(id)));
  empresas.forEach((e) => { if (e && e.gestorConta === uid) { if (e.tipo === 'filial' && e.matrizId) ids.add(e.id); else mats.add(e.id); } });
  empresas.forEach((e) => { if (e && (mats.has(e.id) || (e.matrizId && mats.has(e.matrizId)))) ids.add(e.id); });
  usuarios.filter((u) => u && u.situacao !== 'inativo' && u.contaId === uid).forEach((u) => (Array.isArray(u.empresas) ? u.empresas : []).forEach((id) => ids.add(id)));
  const gestor = meus.length > 0;
  return { uid, owner: false, gestor, ids, liberado: gestor || ids.size > 0 };
}

export function chaveEscopo(ctx) {
  if (ctx.owner) return 'owner';
  return (ctx.gestor ? 'g:' : 'u:') + Array.from(ctx.ids).sort().join(',');
}

export function podeLer(ctx, col, id, d) {
  if (ctx.owner) return true;
  if (!d || !ctx.liberado) return false;
  const ids = ctx.ids;
  if (ABERTAS.has(col)) return true;
  if (col === 'gestores') return d.contaId === ctx.uid;
  if (col === 'empresas') return ids.has(id);
  if (col === 'usuarios') return (Array.isArray(d.empresas) && d.empresas.some((x) => ids.has(x))) || d.contaId === ctx.uid;
  if (col === 'riscos') return ids.has(d.filialId || d.matrizId);
  if (col === 'cadris' || col === 'mtrs') return ids.has(d.geradorId);
  if (CATALOGOS.has(col)) return !d.empresaId || ids.has(d.empresaId);
  return ids.has(d.empresaId);
}

/* antigo = documento atual no banco (ou null); novo = documento depois da gravação (ou null se excluído). */
export function podeGravar(ctx, col, id, antigo, novo) {
  if (ctx.owner) return true;
  if (!ctx.liberado) return false;
  if (col === 'gestores') return false;
  if (antigo && !podeLer(ctx, col, id, antigo)) return false;
  if (!novo) return true;
  if (col === 'usuarios') {
    /* somente o gestor (afiliado) cadastra usuários, e apenas nas empresas liberadas para ele */
    if (!ctx.gestor) return false;
    const emps = Array.isArray(novo.empresas) ? novo.empresas : [];
    return emps.length > 0 && emps.every((x) => ctx.ids.has(x));
  }
  if (col === 'empresas') {
    if (ctx.ids.has(id)) return true;
    if (novo.matrizId && ctx.ids.has(novo.matrizId)) return true;
    return !antigo && ctx.gestor && novo.gestorConta === ctx.uid;
  }
  if (CATALOGOS.has(col) && !novo.empresaId) return !antigo || !antigo.empresaId;
  return podeLer(ctx, col, id, novo);
}
