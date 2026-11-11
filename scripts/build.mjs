/* Gera a pasta dist/ publicada pela Netlify.
   O index.html do app não é alterado no repositório: aqui ele é copiado e recebe
   o módulo de servidor (ms-cloud.js), que faz login e grava os dados no Neon.
   Assim você pode continuar substituindo o index.html por versões novas do app. */
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(raiz, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
if (existsSync(join(raiz, 'public'))) cpSync(join(raiz, 'public'), dist, { recursive: true });

let html = readFileSync(join(raiz, 'index.html'), 'utf8');
const avisos = [];
const trocar = (re, novo, nome) => { if (re.test(html)) html = html.replace(re, novo); else avisos.push(nome); };

/* 1. carrega o módulo de servidor antes de qualquer script do app */
trocar(/<head[^>]*>/i, (m) => m + '\n<script src="/ms-cloud.js"></script>', 'tag <head>');
/* 2. links de votação e de crachá passam a usar o endereço do próprio site */
trocar(/const URNA_BASE_PADRAO = '[^']*';/, "const URNA_BASE_PADRAO = location.origin + '/';", 'URNA_BASE_PADRAO');
/* 3. rótulo da versão */

trocar(/ · Local \(este computador\)/g, ' · Servidor', 'rótulo de versão');
writeFileSync(join(dist, 'index.html'), html);
if (avisos.length) console.warn('Aviso: trechos não encontrados no index.html (o app ainda funciona): ' + avisos.join('; '));
if (avisos.includes('tag <head>')) { console.error('Erro: não foi possível incluir o ms-cloud.js.'); process.exit(1); }
console.log('dist/ gerado (' + Math.round(html.length / 1024) + ' KB).');
