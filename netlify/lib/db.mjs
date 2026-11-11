/* Acesso ao banco Postgres (Neon).
   Em produção usa o driver HTTP do Neon; nos testes locais (MS_PG_DRIVER=pg) usa o driver "pg". */
import { neon } from '@neondatabase/serverless';

let runner = null;
let migrado = null;

async function getRunner() {
  if (runner) return runner;
  const url = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
  if (!url) throw Object.assign(new Error('DATABASE_URL não configurada'), { code: 'config' });
  if (process.env.MS_PG_DRIVER === 'pg') {
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({ connectionString: url, max: 4 });
    runner = async (text, params) => (await pool.query(text, params)).rows;
  } else {
    const sql = neon(url);
    runner = (text, params) => sql.query(text, params);
  }
  return runner;
}

const SCHEMA = [
  `create table if not exists ms_contas (
     id text primary key,
     email text not null unique,
     nome text not null,
     senha text not null,
     is_owner boolean not null default false,
     ativo boolean not null default true,
     sv integer not null default 1,
     criado_por text,
     criado_em timestamptz not null default now(),
     atualizado_em timestamptz not null default now(),
     ultimo_acesso timestamptz
   )`,
  `create sequence if not exists ms_docs_seq`,
  `create table if not exists ms_docs (
     col text not null,
     id text not null,
     data jsonb,
     deleted boolean not null default false,
     seq bigint not null default nextval('ms_docs_seq'),
     atualizado_em timestamptz not null default now(),
     atualizado_por text,
     primary key (col, id)
   )`,
  `create index if not exists ms_docs_seq_idx on ms_docs (seq)`,
  `create table if not exists ms_assets (
     id text primary key,
     tipo text not null,
     tamanho integer not null,
     dados text not null,
     criado_por text,
     criado_em timestamptz not null default now()
   )`,
  `create table if not exists ms_tentativas (
     chave text primary key,
     n integer not null default 0,
     ate timestamptz not null
   )`
];

export async function q(text, params = []) {
  const run = await getRunner();
  if (!migrado) migrado = (async () => { for (const s of SCHEMA) await run(s, []); })().catch((e) => { migrado = null; throw e; });
  await migrado;
  return run(text, params);
}
