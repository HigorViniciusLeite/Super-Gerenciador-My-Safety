/* Senhas (scrypt) e sessão em cookie assinado (HMAC-SHA256). */
import crypto from 'node:crypto';

const COOKIE = 'ms_s';
const DIAS = 30;

function segredo() {
  const s = process.env.SESSION_SECRET || '';
  if (s.length < 32) throw Object.assign(new Error('SESSION_SECRET ausente ou curta (mínimo 32 caracteres)'), { code: 'config' });
  return s;
}

export function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(senha), salt, 64, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + salt.toString('base64') + '$' + h.toString('base64');
}

export function conferirSenha(senha, guardado) {
  try {
    const [alg, s, h] = String(guardado).split('$');
    if (alg !== 'scrypt') return false;
    const esperado = Buffer.from(h, 'base64');
    const calc = crypto.scryptSync(String(senha), Buffer.from(s, 'base64'), esperado.length, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(calc, esperado);
  } catch (e) { return false; }
}

const b64 = (b) => Buffer.from(b).toString('base64url');
const assinar = (txt) => crypto.createHmac('sha256', segredo()).update(txt).digest('base64url');

export function cookieSessao(conta, seguro) {
  const corpo = b64(JSON.stringify({ u: conta.id, v: conta.sv, e: Date.now() + DIAS * 864e5 }));
  const valor = corpo + '.' + assinar(corpo);
  return COOKIE + '=' + valor + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + DIAS * 86400 + (seguro ? '; Secure' : '');
}

export function cookieSair(seguro) {
  return COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (seguro ? '; Secure' : '');
}

/* Devolve { u, v } se o cookie for válido e não estiver vencido. */
export function lerSessao(req) {
  const raw = req.headers.get('cookie') || '';
  const m = raw.split(/;\s*/).find((p) => p.startsWith(COOKIE + '='));
  if (!m) return null;
  const [corpo, sig] = m.slice(COOKIE.length + 1).split('.');
  if (!corpo || !sig) return null;
  const esperado = assinar(corpo);
  const a = Buffer.from(sig), b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8'));
    if (!p || !p.u || !p.e || p.e < Date.now()) return null;
    return p;
  } catch (e) { return null; }
}

export const novoId = (pref = '') => pref + crypto.randomBytes(16).toString('hex');
