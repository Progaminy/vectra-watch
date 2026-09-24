# Vectra Watch

Plataforma mobile-first de monitoria audiovisual com missões, carteira, depósitos, levantamentos e programa de afiliados.

## Estado atual

Esta versão substitui o protótipo que guardava utilizadores, PINs, saldo, missões e transações no `localStorage`.

### Regras de segurança já aplicadas

- saldo e transações ficam no PostgreSQL/Supabase;
- PIN é transformado com `bcrypt` no servidor;
- autenticação usa JWT com expiração;
- depósitos **não** creditam saldo apenas porque o utilizador digitou um código;
- códigos de transação são únicos;
- depósito entra como `pending` e só é creditado após aprovação administrativa;
- comissão de afiliado (10%) só nasce quando um depósito do convidado é aprovado;
- levantamentos retiram o valor do saldo disponível e movem para saldo bloqueado;
- rejeitar levantamento devolve o valor ao disponível;
- missão só pode pagar uma vez por missão/dia;
- recompensa de missão é creditada por uma função atómica no banco;
- o ciclo diário usa `Africa/Maputo`;
- o bónus promocional de 50 MT é separado do saldo levantável;
- rotas sensíveis têm rate-limit.

> Importante: a validação de depósito é manual nesta primeira versão. Não existe código que finja confirmação automática de M-Pesa/E-Mola. Quando existir API oficial/fornecedor de pagamentos, a aprovação deve ser ligada a webhooks assinados.

## Estrutura

```
vectra-watch/
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── src/
│   └── server.js
├── supabase/
│   └── schema.sql
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## 1. Criar a base de dados

1. Crie/abra um projeto Supabase.
2. Abra **SQL Editor**.
3. Execute todo o conteúdo de `supabase/schema.sql`.

O script cria:

- `users`
- `wallets`
- `missions`
- `mission_runs`
- `mission_completions`
- `transactions`
- funções atómicas para recompensa, depósito e levantamento.

## 2. Configurar variáveis

Copie `.env.example` para `.env`.

```bash
cp .env.example .env
```

Preencha:

```env
PORT=3000
SUPABASE_URL=https://SEU-PROJETO.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
JWT_SECRET=...
ADMIN_TOKEN=...
APP_ORIGIN=http://localhost:3000

# opcionais
COLLECTOR_PHONE=870573840
COLLECTOR_NAME=Vectra Watch
COLLECTOR_OPERATOR=E-Mola
```

Nunca coloque `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET` ou `ADMIN_TOKEN` no frontend ou no GitHub.

## 3. Executar

```bash
npm install
npm run dev
```

Abra:

```
http://localhost:3000
```

## Fluxo de depósitos

O utilizador:

1. escolhe o valor;
2. faz a transferência para a carteira configurada;
3. informa o número remetente e o ID real da transação;
4. a API cria uma transação `deposit/pending`;
5. o saldo permanece inalterado;
6. após conferência real, o administrador aprova;
7. só então o banco credita o saldo e, quando aplicável, a comissão do patrocinador.

### Aprovar depósito

```bash
curl -X POST \
  -H "x-admin-token: SEU_ADMIN_TOKEN" \
  https://SEU_DOMINIO/api/admin/deposits/ID_DA_TRANSACAO/approve
```

### Rejeitar depósito

```bash
curl -X POST \
  -H "x-admin-token: SEU_ADMIN_TOKEN" \
  https://SEU_DOMINIO/api/admin/deposits/ID_DA_TRANSACAO/reject
```

## Fluxo de levantamento

Ao pedir levantamento, o banco faz a operação de forma atómica:

```
available -= valor
locked    += valor
```

Se aprovado:

```
locked -= valor
status = approved
```

Se rejeitado:

```
locked    -= valor
available += valor
status = rejected
```

### Aprovar/rejeitar

```bash
curl -X POST \
  -H "x-admin-token: SEU_ADMIN_TOKEN" \
  https://SEU_DOMINIO/api/admin/withdrawals/ID/approve
```

ou:

```bash
curl -X POST \
  -H "x-admin-token: SEU_ADMIN_TOKEN" \
  https://SEU_DOMINIO/api/admin/withdrawals/ID/reject
```

## Missões

Ao clicar em **Iniciar**, o servidor cria uma execução (`mission_run`).

O botão de conclusão só é liberado visualmente após 10 segundos de reprodução, mas a regra importante também existe no servidor/banco. Chamar a função JavaScript diretamente não é suficiente para creditar saldo.

Ainda assim, o YouTube não fornece prova infalível de atenção humana. Para campanhas remuneradas reais, deve-se definir com clareza o critério de validação e respeitar as políticas da plataforma de vídeo e dos anunciantes.

## Deploy

A aplicação precisa de um runtime Node.js. Um deploy estático isolado não executará `src/server.js`.

Comando de build:

```
npm install
```

Comando de start:

```
npm start
```

Depois configure as variáveis de ambiente no fornecedor de hospedagem.

## Próximos passos recomendados

1. painel administrativo visual para depósitos e levantamentos;
2. webhooks oficiais do fornecedor de pagamento;
3. recuperação segura de PIN;
4. auditoria administrativa;
5. idempotency keys para todas as operações financeiras;
6. testes automatizados;
7. consentimento/termos e regras transparentes de recompensa;
8. substituir vídeos de demonstração por catálogo verificado e autorizado.
