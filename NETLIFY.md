# Publicar o My Safety na Netlify com banco Neon

O sistema passa a ter **login próprio (e-mail e senha)** e os dados ficam num banco **Postgres no Neon**. Todos os usuários usam o mesmo endereço (ex.: `https://mysafety.netlify.app`) e enxergam só as empresas liberadas para eles.

## Como está organizado

| Arquivo | O que faz |
|---|---|
| `index.html` | O app, **sem alterações**. Você pode continuar substituindo este arquivo por versões novas. |
| `public/ms-cloud.js` | Tela de login, menu da conta, **Contas de acesso** e a ligação do app com o servidor. |
| `netlify/functions/api.mjs` | O servidor: login, contas, gravação e leitura dos dados, arquivos e votação da CIPA. |
| `netlify/lib/escopo.mjs` | Regras de acesso: quem pode ler e gravar cada dado. |
| `scripts/build.mjs` | Na publicação, copia o `index.html` para `dist/` e inclui o `ms-cloud.js`. |

As tabelas do banco são criadas sozinhas no primeiro acesso.

## Passo a passo

### 1. Criar o banco no Neon
1. Crie uma conta em <https://neon.tech> e um projeto (região: **São Paulo (sa-east-1)**, se houver).
2. Copie a **connection string**. Ela começa com `postgresql://` e termina com `?sslmode=require`.

> Também dá para criar o banco pela própria Netlify (extensão **Neon**). Nesse caso a variável `NETLIFY_DATABASE_URL` é criada automaticamente e o passo 3 não precisa de `DATABASE_URL`.

### 2. Criar o site na Netlify
1. Em <https://app.netlify.com>, abra **Add new site › Import an existing project › GitHub** e escolha este repositório.
2. Escolha o branch que vai ser publicado.
3. Não mude as configurações de build: elas vêm do `netlify.toml` (comando `node scripts/build.mjs`, pasta `dist`).

### 3. Configurar as variáveis de ambiente
Em **Site configuration › Environment variables**, crie:

| Variável | Valor |
|---|---|
| `DATABASE_URL` | a connection string do Neon |
| `SESSION_SECRET` | um texto aleatório com **pelo menos 32 caracteres**. Para gerar um, use `openssl rand -hex 32` ou um gerador de senhas. Não compartilhe. |
| `ADMIN_EMAIL` | o **seu** e-mail. Só ele pode criar a conta de administrador. |

Depois de salvar as variáveis, vá em **Deploys › Trigger deploy**.

### 4. Criar o administrador
Abra o endereço do site. No primeiro acesso aparece **"Criar o administrador"**: informe seu nome, o e-mail de `ADMIN_EMAIL` e uma senha. Essa tela não aparece de novo.

### 5. Trazer os dados que você já tem
1. Na versão atual (claude.ai), abra **Administrador › Backup › Baixar backup**.
2. No site novo, abra **Administrador › Backup › Restaurar backup** e selecione o arquivo.

O backup não carrega:
- **Fotos e arquivos anexados** (fotos de EPI, assinaturas, PDFs). Será preciso anexá-los de novo.
- **Vínculos de conta**. Os cadastros de afiliados e usuários voltam, mas as contas de acesso são novas. Vincule cada pessoa de novo (passo 6).
- **Endereço da votação.** Se você tinha mudado o endereço-base da votação ou do QR Code, confira se ele ainda aponta para o claude.ai e troque pelo endereço do site.

## 6. Cadastrar usuários
1. Clique no **botão com o seu nome**, no canto inferior direito, e abra **Contas de acesso**.
2. Crie a conta: nome, e-mail e senha inicial (o botão **Gerar senha** cria uma).
3. Vincule a conta conforme o tipo de usuário:
   - **Gestor de um cliente:** em **Cadastro de Afiliados**, cadastre o gestor, marque as matrizes do cliente e, em *Conta de acesso*, busque a pessoa pelo nome ou e-mail.
   - **Usuário comum:** em **Empregados / Usuários › Cadastro de Usuários e Responsáveis**, vincule a conta e marque as empresas e abas.
4. Envie à pessoa o endereço do site, o e-mail e a senha inicial. Ela troca a senha no botão com o nome dela.

Os **gestores (afiliados)** também veem **Contas de acesso**. Eles criam logins para a equipe deles e veem só as contas que eles mesmos criaram.

Se alguém esquecer a senha, abra **Contas de acesso › Nova senha**. Não há envio de e-mail. Para bloquear alguém, use **Desativar**: a pessoa sai do sistema na hora.

## Regras de acesso (aplicadas no servidor)
- **Administrador:** vê e altera tudo.
- **Gestor (afiliado) ativo:** vê e altera só as matrizes liberadas, as filiais delas e os dados ligados a essas empresas. Cadastra usuários só nessas empresas. Quando a validade vence ou o gestor fica inativo, o acesso é cortado.
- **Usuário comum:** vê e altera só as empresas marcadas no cadastro dele. Não muda as próprias permissões.
- **Conta sem vínculo:** entra, mas vê "Acesso não liberado".
- **Votação da CIPA** (link ou QR Code `#votar=`): funciona **sem login**. O servidor confere se a pessoa é eleitora e aceita um único voto.
- **Crachá por QR Code** (`#cracha=`): exige login, porque mostra dados do empregado.
- **Catálogos** (EPIs, treinamentos, perigos × exames) e **tabelas de configuração** (HRN, Quadro I, Anexo II etc.) são compartilhados entre todos, como já eram.

## Limites
- Arquivos anexados de até **4,5 MB** cada (limite das funções da Netlify).
- As alterações de outros usuários aparecem em até ~5 segundos, sem recarregar a página.
- O plano gratuito do Neon e da Netlify atende bem um volume pequeno ou médio. Acompanhe o uso nos painéis deles.

## Testar no seu computador (opcional)
Precisa de Node 20+ e de um Postgres local:

```bash
npm install
```

```bash
node scripts/build.mjs
```

```bash
DATABASE_URL=postgres://usuario:senha@localhost:5432/mysafety MS_PG_DRIVER=pg SESSION_SECRET=troque-por-um-texto-de-32-caracteres-ou-mais ADMIN_EMAIL=voce@exemplo.com node scripts/dev-server.mjs
```

Abra <http://localhost:8888>. Para rodar os testes das regras de acesso, use um **banco vazio** e o servidor acima ligado:

```bash
ADMIN_EMAIL=voce@exemplo.com node scripts/test-api.mjs
```
