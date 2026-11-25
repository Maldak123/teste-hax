# Bot HaxBall Headless

Host para a API Headless oficial com estatísticas auditáveis, times automáticos, replay e publicação em webhook Discord. Requer Node.js 22+ e navegador com acesso à página oficial do HaxBall. O host suporta até 30 conexões; `TEAM_SIZE` limita jogadores em campo por time.

## Instalação e execução

1. `npm ci` (não há dependências externas).
2. Copie `.env.example` para `.env`, preencha `HMAC_KEY`, `OWNER_AUTH`, `ADMIN_PASSWORD` e `DISCORD_WEBHOOK_URL`, e ajuste a sala. A senha de admin deve ter de 12 a 128 bytes e não conter espaços. `npm start` e `npm run build` carregam `.env` automaticamente quando ele existe; variáveis já exportadas no shell também funcionam.
3. Execute `npm run room`. O comando gera o bundle, inicia o serviço local, abre o Chrome com perfil separado e carrega o bot na [página Headless oficial](https://html5.haxball.com/headless). Resolva a recaptcha na janela quando solicitada. `ROOM_TOKEN`, se usado, expira em minutos.

Se o Chrome não for encontrado, defina `CHROME_PATH` com o executável. Em WSL, o comando procura também o Chrome do Windows e controla o DevTools pelo PowerShell no próprio Windows; por padrão usa uma porta livre e um perfil temporário. `CHROME_PROFILE_DIR`, quando usado, deve ser um caminho Windows exclusivo do bot, como `C:\Users\seu-usuario\AppData\Local\bot-haxball-chrome`. `CHROME_DEBUG_PORT` fixa a porta caso necessário. `CHROME_HEADLESS=true` oculta a janela e exige um token válido para evitar a recaptcha interativa. A automação usa a interface [DevTools do Chrome](https://chromedevtools.github.io/devtools-protocol/) e pode precisar de ajustes após atualizações do navegador. Como alternativa manual, execute `npm run build` e `npm start` em terminais separados e cole `dist/bootstrap.js` no console da página oficial.

O navegador deve ficar aberto. A URL da sala aparece na página oficial; o serviço local não a registra. Para Chrome em VPS, veja o parâmetro de WebRTC na [documentação oficial](https://github.com/haxball/haxball-issues/wiki/Headless-Host). Não desative recursos de segurança do navegador sem entender o ambiente.

`http://127.0.0.1:8787/health` expõe contagens locais de partidas e estados da outbox, sem tokens nem nomes de jogadores.

## Verificações

- `npm test`: testes unitários e integração com sala falsa.
- `npm run check`: sintaxe JavaScript, JSON e espaços.
- `npm run build`: valida e gera `dist/bootstrap.js`.

## Configuração e operação

`OWNER_AUTH` é o ID público da conta owner configurada fora do chat. `!login SENHA` concede acesso admin por duas horas à sessão atual, inclusive quando o HaxBall retorna `auth: null`; nesse caso, o acesso não persiste ao sair da sala. `!logout` encerra o acesso. Após cinco tentativas erradas por identidade, o login bloqueia novas tentativas por 15 minutos; há também um limite global de 50 tentativas no período. A senha é validada no serviço local e não é gravada na auditoria. O comando é filtrado antes de chegar aos demais jogadores, e todas as respostas de login são privadas via `sendAnnouncement` com o ID do jogador, conforme a [API oficial](https://github.com/haxball/haxball-issues/wiki/Headless-Host). `HMAC_KEY` pseudonimiza `auth` e `conn` em disco. Proteja `.env` e `data/`; não publique replays reais. O Discord recebe `allowed_mentions` vazio. O estado fica em `data/state.json` e os replays em `data/replays/`. Replays publicados expiram após `REPLAY_RETENTION_DAYS`; replays pendentes de publicação são preservados para reconciliação. Faça backup com o processo parado.

O `!help` público mostra apenas `!help`, `!status`, `!stats` e `!meme`. Depois do login, `!adminhelp` mostra em privado `!balance`, `!start`, `!pause`, `!end` e `!logout`. Comandos são ocultados do chat público. As mensagens do bot usam cor e os estilos `bold` ou `small-bold` oferecidos pela API Headless. O bot tenta iniciar automaticamente com um jogador ou mais, após confirmar e reconciliar as mudanças de time; se o início falhar, tenta novamente até três vezes. O replay e o placar são enviados ao webhook após a finalização.

HTTP 429 gera retentativa. Outbox `uncertain` indica timeout, HTTP 5xx ou reinício durante envio: confira o canal Discord antes de alterar esse item para `pending` manualmente com o serviço parado. Isso evita duplicatas automáticas, mas exige operação humana para entrega final. Partidas interrompidas por reinício ficam em `interruptedMatches`, sem resultado fabricado. Replay acima do limite configurado é omitido com aviso na mensagem.

Consulte [definições estatísticas](docs/statistics.md), [balanceamento](docs/balancing.md), [runbook](docs/runbook.md) e [decisão de arquitetura](docs/adr/0001-local-service.md). Se a gravação do resultado falhar, a sala libera o lobby e tenta novamente a cada cinco segundos. O aviso aparece uma vez, apenas para admins conectados; o erro fica no console do navegador como `persist_match_failed`. Até 50 resultados ficam pendentes em memória. Mantenha o navegador aberto enquanto houver pendências: reiniciar a página antes da recuperação do serviço perde esses resultados. A publicação exatamente uma vez após resultado HTTP ambíguo, recuperação automática de partida interrompida e métricas de posse/passe/defesa não estão disponíveis nesta implementação.
