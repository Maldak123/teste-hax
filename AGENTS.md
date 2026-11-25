# AGENTS.md — Bot de sala HaxBall Headless

## 1. Objetivo e autoridade deste guia

Este repositório deve produzir um host HaxBall Headless estável para uma sala com até 30 jogadores. O escopo inicial inclui estatísticas individuais auditáveis, balanceamento automático durante e entre partidas, gravação de replay, publicação do resultado e do replay no Discord, comandos administrativos com autorização e memes no chat com antispam.

Este arquivo orienta agentes de codificação em todo o repositório. Um `AGENTS.md` mais próximo de um arquivo pode complementar estas regras, sem enfraquecer requisitos de segurança, privacidade, confiabilidade ou testes daqui.

A implementação inicial usa JavaScript ES modules e Node.js 22+ para o serviço local; o bundle da sala roda na página oficial Headless. Antes de codificar, inspecione o repositório e preserve decisões já registradas em código, manifestos, ADRs e README.

## 2. Fonte de verdade e limites da API

Use como referência primária a documentação oficial:

- API Headless: <https://github.com/haxball/haxball-issues/wiki/Headless-Host>
- changelog: <https://github.com/haxball/haxball-issues/wiki/Headless-Host-Changelog>
- token do host, referenciado pela documentação: <https://www.haxball.com/headlesstoken>

Ao depender de um método, evento ou campo, confira a documentação oficial vigente e registre a referência no código ou ADR. Não invente callbacks nem trate inferências como dados nativos da API.

Limitações que devem orientar a implementação:

- `HBInit` expõe uma API JavaScript no ambiente Headless. A arquitetura deve isolar esse adaptador do domínio; execução em navegador automatizado ou wrapper Node de terceiros é decisão de implantação, não capacidade oficial presumida.
- Configure `noPlayer: true`. Eventos provocados pelo host podem receber `byPlayer === null`; todo handler aplicável deve aceitar esse caso.
- Operações que alteram o estado do jogo são assíncronas. Não chame, por exemplo, `setPlayerTeam` e presuma que `getPlayerList()` refletirá a mudança imediatamente. Confirme por evento (`onPlayerTeamChange`) ou por reconciliação posterior com prazo definido.
- `onGameTick` ocorre 60 vezes por segundo somente durante jogo ativo e não pausado. O handler deve ser síncrono, barato e sem I/O. Agregue dados em memória e persista fora do caminho crítico.
- `getScores()` e `getBallPosition()` retornam `null` fora de uma partida. A posição de jogador também pode ser `null` fora de campo.
- A API oferece `onPlayerBallKick` e `onTeamGoal`, mas o gol não traz autor ou assistência. Gol, assistência, gol contra, defesa, posse, passe e distância são inferências do bot e precisam de definições explícitas, janela temporal/espacial, nível de confiança e testes. Não os apresente como fatos fornecidos pelo HaxBall.
- `startRecording()` inicia a gravação; `stopRecording()` precisa sempre ser chamado e retorna `Uint8Array` ou `null`. Esquecer de parar causa vazamento de memória segundo a documentação.
- `onGameStop` não equivale necessariamente a vitória; `onTeamVictory` representa vitória. A finalização deve ser idempotente e lidar com ambos em qualquer ordem observada.
- `PlayerObject.id` identifica apenas aquela entrada na sala. `auth` é um ID público, pode ser `null` e só está disponível em `onPlayerJoin`; a documentação afirma que ele ajuda a validar identidade declarada, mas não prova que a conexão não pertence a outra pessoa e não basta para bans. `conn` identifica a conexão/rede e também só está disponível no join; é dado sensível e compartilhável por jogadores na mesma rede.
- Chat pode ser filtrado retornando `false` em `onPlayerChat`. Mensagens do host sem jogador devem usar preferencialmente `sendAnnouncement`, que funciona com `noPlayer: true`.
- Métodos como `setScoreLimit`, `setTimeLimit` e troca de estádio não surtem efeito durante uma partida. Aplique configuração no estado correto e verifique o resultado.
- Integração Discord, banco, armazenamento de arquivo, filas, relógio e sistema de arquivos não fazem parte da API Headless; mantenha-os atrás de portas próprias.

Se uma métrica ou automação não puder ser implementada com os eventos e leituras documentados, abra uma decisão técnica descrevendo a lacuna e entregue uma aproximação rotulada ou retire a métrica. Nunca simule suporte inexistente.

## 3. Estrutura recomendada

Mantenha a raiz para metadados e documentação. O layout atual usa `src/domain/` para regras puras, `src/app/` para o adaptador da sala, `src/server/` para persistência e Discord, `tests/` para testes e `docs/` para definições/ADRs. A organização por responsabilidade abaixo orienta futuras divisões:

```text
src/
  headless/       # único adaptador direto de HBInit/RoomObject e tradução de eventos
  match/          # máquina de estados e ciclo de vida da partida
  statistics/     # coleta, atribuição, confiança e agregação
  balancing/      # rating, fairness, fila e plano de trocas
  commands/       # parser, catálogo, autorização e cooldown
  chat/           # anúncios, memes, moderação e antispam
  recording/      # ciclo do replay, validação e armazenamento
  discord/        # fila/outbox, upload e mensagens de resultado
  persistence/    # repositórios, migrações e transações
  config/         # schema, defaults seguros e validação no boot
  observability/  # logs, métricas operacionais e correlação
  app/            # composição e inicialização
tests/
  unit/
  integration/
  contract/
  fixtures/
assets/           # estádios e conteúdo não secreto, se houver
docs/             # ADRs, definições de métricas e runbooks
```

Não crie um módulo monolítico de callbacks. O adaptador Headless deve normalizar os callbacks em eventos internos pequenos e encaminhá-los a serviços de domínio. Dependências apontam do domínio para interfaces; integrações implementam essas interfaces.

JavaScript ES modules evita dependências externas nesta etapa; `npm run build` gera o bundle para colar no console da página oficial. O serviço Node mantém estado JSON e outbox para uma instância. Antes de adotar biblioteca não oficial para executar fora do navegador, documente maturidade, manutenção, compatibilidade e diferença em relação à API oficial.

## 4. Estados e fluxo da sala

Modele explicitamente a sala, sem espalhar booleanos:

```text
BOOTING -> LOBBY -> PREPARING -> PLAYING <-> PAUSED -> FINALIZING -> LOBBY
                         |                         \-> ABORTED ----^
                         \-> LOBBY (falha segura)
```

- `BOOTING`: validar configuração, persistência, diretórios e dependências obrigatórias; criar sala e aguardar `onRoomLink`.
- `LOBBY`: aceitar jogadores, manter fila/espectadores e permitir alterações seguras de configuração.
- `PREPARING`: congelar a escalação lógica, gerar o plano de times, emitir movimentos e aguardar confirmações; iniciar replay imediatamente antes/início da partida de forma determinística.
- `PLAYING`: coletar eventos e amostras; não executar rede, disco, consultas pesadas nem rebalanceamento impulsivo no tick.
- `PAUSED`: não acumular tempo de jogo; registrar motivo e autor quando disponíveis.
- `FINALIZING`: aceitar uma única finalização, congelar snapshot, parar replay em bloco `finally`, persistir partida e estatísticas atomicamente, enfileirar publicação no Discord e liberar a próxima partida.
- `ABORTED`: registrar causa, marcar estatísticas conforme política de validade, salvar replay parcial quando possível e retornar a um estado seguro.

Cada partida recebe `matchId` único. Handlers tardios, duplicados ou pertencentes a outro `matchId` devem ser ignorados com log estruturado. Transições inválidas falham fechadas e não corrompem totais.

## 5. Eventos Headless a tratar

Centralize o registro de callbacks e, no mínimo, trate:

- `onPlayerJoin` e `onPlayerLeave`: criar/encerrar sessão, capturar `auth` e `conn` no join, reconciliar times e limpar cooldowns efêmeros;
- `onPlayerTeamChange`: confirmar movimentos solicitados e registrar mudanças manuais com `byPlayer` anulável;
- `onPlayerAdminChange` e `onPlayerKicked`: auditoria administrativa;
- `onGameStart`, `onGamePause`, `onGameUnpause`, `onGameStop` e `onTeamVictory`: máquina de estados e duração válida;
- `onPlayerBallKick`, `onTeamGoal` e `onPositionsReset`: cadeia de toques e atribuições de gol;
- `onGameTick`: amostras mínimas de posição necessárias às métricas documentadas;
- `onPlayerActivity`: AFK; não confundir ausência desse evento com desconexão;
- `onPlayerChat`: comandos, memes e filtro antispam;
- `onStadiumChange`, `onTeamsLockChange` e `onKickRateLimitSet`: auditoria/reconciliação quando a funcionalidade for usada;
- `onRoomLink`: prontidão da sala, sem vazar URL privada em logs públicos.

Handlers devem capturar exceções no limite, acrescentar `matchId`/`playerSessionId` ao log e preservar o loop do host. Um handler não deve impedir o registro dos demais.

## 6. Modelos de dados mínimos

Use IDs internos imutáveis e datas UTC. Versione o schema e as definições de métricas.

- `PlayerIdentity`: `playerId` interno, `displayNameLast`, `authHash?`, `createdAt`, `updatedAt`. Não use nome como chave. Não armazene `auth` cru sem necessidade documentada.
- `PlayerSession`: `sessionId`, `roomPlayerId`, `playerId?`, `displayNameAtJoin`, `connHash?`, `joinedAt`, `leftAt`, `teamTimeline`, `adminTimeline`.
- `Match`: `matchId`, `state`, `startedAt`, `endedAt`, `stadium`, limites, placar, vencedor, motivo de término, versão do algoritmo, `validForRating`, `replayStatus`, `publicationStatus`.
- `Participation`: intervalos por jogador/time, segundos ativos, segundos AFK, entradas, saídas e elegibilidade estatística/rating.
- `MatchEvent`: sequência monotônica, tipo, tempo de jogo, tempo de parede, ator/time, payload mínimo, origem e `confidence` quando inferido.
- `PlayerMatchStats`: gols, assistências, gols contra, chutes/toques, participação, AFK, posse estimada e demais métricas, cada grupo com `definitionVersion`.
- `Rating`: valor, incerteza ou quantidade de partidas, versão e histórico de alterações.
- `ReplayArtifact`: checksum, tamanho, localização, data de retenção e estado; nunca guarde o binário dentro do log.
- `AdminGrant`: identidade, papel, escopo, emissor, criação, expiração/revogação.
- `AuditEntry`: comando normalizado, ator, alvo, resultado e correlação, sem segredo ou mensagem privada desnecessária.
- `OutboxItem`: tipo, chave idempotente, payload/referência, tentativas, próxima tentativa e último erro sanitizado.

Imponha unicidade para finalização de `matchId`, aplicação de rating por `matchId` e publicação Discord por chave idempotente. Totais de carreira devem ser derivados de partidas válidas ou atualizados na mesma transação, nunca por incrementos soltos sem deduplicação.

## 7. Estatísticas confiáveis

Crie `docs/statistics.md` antes ou junto da primeira métrica. Para cada estatística, documente fonte, fórmula, unidade, janela, casos-limite, custo e se é `observada` ou `inferida`.

Regras mínimas:

- Mantenha uma cadeia ordenada de toques a partir de `onPlayerBallKick`, enriquecida somente com amostras necessárias. Limpe-a em início, gol, reset de posições, troca relevante de time e expiração da janela.
- Atribua gol ao último toque elegível apenas pela regra versionada. Se o último toque foi do time que sofreu, classifique como gol contra conforme essa regra; caso contrário, deixe autor desconhecido quando não houver evidência suficiente.
- Assistência exige penúltimo toque elegível de colega distinto e janela definida. Não conte assistência cruzando reset, adversário, troca de time ou expiração.
- `onPlayerBallKick` prova um chute/toque detectado pelo evento, não necessariamente chute ao gol, passe completo ou defesa.
- Posse é estimativa. Defina, por exemplo, controle por proximidade e continuidade, com raio e histerese testados; publique como “posse estimada”. Não acumule durante pausa, reset ou bola sem controlador.
- Presença em campo vem da linha do tempo de times e do relógio efetivo da partida. Jogador no espectador não acumula minutos em campo.
- Métricas geométricas precisam considerar amostragem, estádio e posições nulas. Não armazene 60 snapshots por segundo indefinidamente; agregue ou reduza a frequência com justificativa.
- Registre `confidence` (`high`, `medium`, `low` ou equivalente) para atribuições inferidas. Rankings oficiais devem usar somente níveis definidos pela política.
- Uma partida abortada, curta demais, com dados incompletos ou equipes fora da política deve ser marcada `validForRating: false`; preserve o registro para auditoria.

Valide invariantes ao finalizar: soma de gols do placar, eventos de gol, tempos não negativos, intervalos sem sobreposição impossível e no máximo um time por jogador no mesmo instante. Divergência não deve ser silenciosamente “corrigida”: registre-a e degrade a confiança/validade.

## 8. Balanceamento e fairness

O objetivo é minimizar desequilíbrio sem transformar jogadores em peças trocadas a cada gol.

- Use rating persistido somente após amostra mínima; para novatos, use prior neutro com incerteza alta. Não derive força apenas de gols.
- O plano deve considerar número de jogadores, força agregada, incerteza e, quando houver dados suficientes, posição/função. Publique a função de custo e sua versão.
- Para até 30 presentes, separe “jogadores em campo” de espectadores/fila conforme capacidade do estádio e modo. Nunca coloque 30 em campo só porque a sala comporta 30.
- Entre partidas, gere times com diferença de tamanho no máximo 1 e minimize custo por busca determinística ou heurística testada. Desempates usam fila/tempo de espera e uma semente registrada, nunca favoritismo oculto.
- Durante a partida, reavalie apenas em pontos seguros: saída/desconexão, intervalo/reset previsto ou desequilíbrio persistente acima de limiar configurado. Não mova jogador em jogada ativa nem imediatamente após uma amostra isolada.
- Aplique cooldown global e por jogador, limite de trocas por partida e proteção contra “pingue-pongue”. Prefira preencher vaga com espectador elegível antes de trocar jogadores ativos.
- Uma troca no meio da partida precisa de justificativa calculável, anúncio breve e trilha de auditoria com custo antes/depois.
- Admin pode suspender ou forçar novo balanceamento via comando autorizado; a ação fica auditada. Override não reescreve rating nem estatísticas passadas.
- Se uma série de `setPlayerTeam` não for confirmada, pare, reconcilie o estado real e gere novo plano. Não empilhe comandos baseados em leitura obsoleta.

Métricas de fairness a testar: diferença de quantidade, diferença de força prevista, tempo médio de espera, quantidade de trocas, distribuição de escolhas ao longo de várias partidas e estabilidade frente a join/leave repetido.

## 9. Comandos, permissões e chat

Implemente parser explícito: prefixo configurável, nome normalizado, argumentos com limites de tamanho e resposta privada quando houver erro sensível. O catálogo define papel mínimo, estado permitido, cooldown e função. Exemplos de famílias, não uma API obrigatória: ajuda/status, estatísticas, fila, balanceamento, início/pausa/fim, kick/ban e meme.

- Papéis recomendados: `player`, `moderator`, `admin`, `owner`; conceda o menor privilégio.
- Não use apenas `player.admin`, nome, `roomPlayerId`, `auth` isolado ou `conn` isolado como autorização durável. Mapeie identidade previamente cadastrada para papel, trate `auth === null` como não autenticado e permita bootstrap do owner somente por configuração segura fora do chat.
- Toda mutação privilegiada deve verificar papel e estado no servidor, não apenas ocultar o comando da ajuda.
- Comandos administrativos geram auditoria de sucesso e recusa. Redija tokens, senhas e identificadores de conexão.
- Mensagens iniciadas pelo prefixo devem retornar `false` em `onPlayerChat` para não expor argumentos; mensagens normais seguem a política de moderação.
- Memes vêm de catálogo local/configurado, não de avaliação de código nem HTML remoto. Use cooldown por jogador, cooldown global, token bucket para rajadas e limite de tamanho. Aplique o limite antes de escolher/enviar conteúdo.
- Antispam deve limitar também comandos inválidos e respostas do bot, usar relógio monotônico e limpar estado ao sair. Após exceder: suprimir, avisar de forma limitada e escalar somente pela política configurada.
- Escape/sanitize conteúdo inserido em Discord, logs e armazenamento. Menções Discord devem ser desativadas por padrão (`allowed_mentions` vazio/equivalente).

## 10. Replay e publicação no Discord

Trate gravação e publicação como etapas independentes e recuperáveis.

1. Em cada início válido, chame `startRecording()` exatamente uma vez e marque o estado em memória.
2. Em toda saída de partida — vitória, parada manual, aborto ou exceção — execute `stopRecording()` exatamente uma vez em `finally`.
3. Se o retorno não for `null`, valide tamanho máximo/mínimo razoável, calcule checksum, grave de forma atômica com nome baseado em `matchId` e extensão apropriada, e registre metadados.
4. Confirme persistência antes de marcar o replay como disponível. Falha no replay não deve perder resultado/estatísticas; fica visível e retentável quando aplicável.
5. Na mesma transação lógica da finalização, crie item de outbox com chave `match-result:<matchId>`. Um worker separado envia placar, duração, equipes, resumo de estatísticas, motivo de término e replay/link.
6. Respeite limite de upload da configuração/Discord. Se exceder, use armazenamento autorizado com URL expirada; se não existir, publique o resumo e sinalize o replay como grande demais. Não descarte silenciosamente.
7. Retente erros transitórios e HTTP 429 honrando `Retry-After`, com backoff exponencial e jitter. Não retente indefinidamente erros permanentes. Reinício do processo deve retomar a outbox sem duplicar postagem.

Webhook/bot token, channel ID privado e token Headless entram por variáveis de ambiente ou gerenciador de segredos, nunca no repositório, replay, mensagem de chat ou log.

## 11. Configuração, privacidade e segredos

Adicione schema validado no boot e `.env.example` somente com nomes e valores fictícios. Separe:

- sala: nome, visibilidade, `maxPlayers` (máximo operacional 30), estádio e limites;
- jogo: tamanho dos times, duração, placar e validade mínima;
- estatística: janelas, raios, frequência de amostra e níveis de confiança;
- fairness: limiares, cooldowns, pesos e versão;
- chat: prefixo, limites, catálogo e política de sanção;
- integrações: destino Discord, timeouts, limites de upload e armazenamento;
- retenção: logs, eventos, replays, auditoria e identificadores pseudonimizados.

Falhe no boot para configuração inválida ou segredo obrigatório ausente. Não registre o objeto completo de ambiente.

Colete o mínimo necessário. Prefira hash/HMAC com chave rotacionável para `auth` e `conn`, quando correlação for necessária; hash simples de identificador de baixa entropia não garante anonimato. Restrinja acesso, defina prazo de retenção e implemente procedimento documentado de exclusão/exportação quando aplicável. Replays e chat podem conter dados pessoais; informe a gravação e a finalidade na entrada da sala e/ou regras acessíveis.

## 12. Logging, observabilidade e resiliência

Use logs estruturados com `timestamp`, `level`, `event`, `roomInstanceId`, `matchId`, `sessionId`, `correlationId`, resultado e erro sanitizado. Não registre segredo, `auth`/`conn` crus, payload binário do replay ou todo tick.

Métricas operacionais mínimas: jogadores conectados, estado da sala, partidas iniciadas/finalizadas/abortadas, divergências estatísticas, duração de handlers, fila/outbox pendente, tentativas/falhas Discord, replay salvo/falho, comandos recusados e supressões antispam. Alertas devem ser acionáveis.

- Isole chamadas de Discord/armazenamento com timeout e retentativa limitada; a sala deve continuar funcional durante indisponibilidade externa.
- Limite filas em memória e aplique backpressure/degradação explícita. Nunca acumule ticks, chats ou binários sem limite.
- Em encerramento do processo, pare novas partidas, finalize replay quando possível, drene persistências por prazo limitado e deixe a outbox recuperável.
- No boot, recupere itens da outbox e marque partidas interrompidas; não fabrique resultado final.
- Use relógio monotônico para duração/cooldown e UTC para persistência. Injete relógio e gerador de IDs nos testes.
- Disponibilize runbook para recaptcha/token expirado, perda da sala, disco cheio, banco indisponível, replay nulo e rate limit do Discord.

## 13. Build, execução e desenvolvimento

Com Node.js 22+, use `npm ci`, `npm test`, `npm run check` e `npm run build`. Para iniciar, exporte as variáveis de `.env.example` e rode `npm start`; o `README.md` documenta a inicialização na página oficial. Ao evoluir a stack:

- adicione manifestos e lockfile versionado;
- fixe versão suportada do runtime e dependências importantes;
- ofereça comandos únicos e repetíveis para instalar, executar localmente, checar tipos/formatar/lintar, testar e gerar build;
- documente esses comandos e a configuração mínima no `README.md`;
- permita executar todas as verificações de um checkout limpo sem ferramenta global não documentada;
- mantenha configuração de desenvolvimento separada de produção e forneça mocks/fakes para Headless, relógio, persistência, Discord e armazenamento.

Não escolha framework, ORM, banco ou provedor apenas por conveniência do agente. Registre decisões com custo operacional relevante em `docs/adr/`.

## 14. Estilo e qualidade de código

Use o formatter e o linter configurados para a linguagem; adicione-os com os primeiros arquivos. Em TypeScript, prefira modo estrito, tipos de domínio, `unknown` em limites externos e validação de runtime. Evite `any`, estado global mutável e números mágicos.

- Nomeie módulos pela responsabilidade e funções por comportamento.
- Mantenha funções de domínio puras sempre que possível.
- Diferencie eventos observados, inferências e comandos nos tipos.
- Expresse unidades nos nomes/tipos (`elapsedSeconds`, `cooldownMs`).
- Comentários explicam decisões, invariantes e limitações da API, não repetem código.
- Nunca engula exceção. Converta-a em resultado tratável ou registre e degrade com segurança.
- Não misture refatoração ampla a uma mudança funcional sem justificativa.

## 15. Estratégia de testes

Adicione testes automatizados com o primeiro código que tenha comportamento. Nomes devem descrever o comportamento; fixtures devem ser pequenas, determinísticas e sem credenciais/replays reais de jogadores.

### Unitários

- parser, autorização, cooldown/token bucket e sanitização;
- máquina de estados, incluindo eventos duplicados e fora de ordem;
- cadeia de toques e atribuição de gol/assistência/gol contra com expiração, reset e troca de time;
- relógio de participação, pausa, AFK e posição nula;
- otimizador de times, desempate determinístico, limites de troca e invariantes de fairness;
- idempotência de finalização, replay e outbox.

### Propriedades e cenários gerados

- nenhum jogador aparece nos dois times;
- diferença de quantidade é no máximo 1 quando matematicamente possível;
- toda pessoa elegível é alocada uma vez ou permanece explicitamente na fila;
- totais nunca diminuem ou duplicam por reprocessamento;
- qualquer sequência de eventos deixa a máquina em estado válido e `stopRecording` ocorre no máximo uma vez.

### Integração/contrato

- adaptador com `RoomObject` falso que reproduza mutações assíncronas e callbacks com `byPlayer === null`;
- banco real efêmero com migrações, transação e recuperação após falha entre persistência e publicação;
- servidor HTTP falso para sucesso, timeout, 429, 4xx/5xx e duplicidade do Discord;
- gravação com `Uint8Array`, `null`, erro de armazenamento, reinício e arquivo acima do limite;
- contrato do subconjunto da API Headless usado pelo projeto, validado periodicamente em ambiente controlado.

### Carga e longa duração

Simule 30 conexões, join/leave, chat em rajada, ticks por várias partidas e indisponibilidade do Discord. Verifique latência de handler, memória limitada, ausência de I/O no tick e recuperação. Teste de ambiente real deve usar sala privada e contas autorizadas; não automatize abuso nem contorne recaptcha.

Todo bug corrigido recebe teste de regressão. Execute o conjunto completo antes de abrir PR.

## 16. Critérios de aceite do escopo inicial

Uma entrega inicial só está pronta quando todos os itens aplicáveis são demonstráveis:

- a sala inicia com configuração validada, `noPlayer: true`, suporta até 30 conectados e mantém comportamento previsível com lotação;
- join/leave/rejoin não mistura identidades nem perde `auth`/`conn` necessários capturados no join;
- ciclo completo e aborto transitam por estados válidos, finalizam uma vez e sobrevivem a eventos duplicados;
- placar e estatísticas observadas batem com a sequência de eventos; inferências exibem definição/versão/confiança e casos ambíguos não viram certeza;
- participação exclui espectador e pausa; partida inválida não altera rating;
- balanceamento entre partidas respeita tamanho, fila e função de custo; balanceamento em andamento obedece gatilhos, cooldowns e confirma movimentos assíncronos;
- comandos não autorizados não alteram estado; ações autorizadas e recusadas ficam auditadas sem dados sensíveis;
- spam de chat/meme é limitado por jogador e globalmente, sem o próprio bot amplificar a rajada;
- toda partida iniciada tenta encerrar a gravação; replay válido é persistido com checksum ou falha fica explícita e recuperável;
- resultado e replay são publicados no canal configurado uma única vez; indisponibilidade/429 gera retentativa persistente sem bloquear a sala;
- reinício recupera outbox e partidas interrompidas sem duplicar estatísticas/rating/publicação;
- logs e artefatos não contêm tokens nem identificadores crus proibidos;
- testes unitários, integração/contrato, lint/formatação, tipos e build documentados passam em checkout limpo;
- README explica execução, configuração, métricas, limitações conhecidas e operação básica.

## 17. Commits e pull requests

Como não há histórico útil para inferir convenção, use assuntos curtos, imperativos e focados, por exemplo: `Adiciona ciclo de gravação da partida`. Separe mudanças sem relação e não inclua arquivos gerados, segredos, bancos locais, logs ou replays reais.

Cada PR deve informar:

- problema e solução;
- módulos e decisões afetados;
- como foi testado, com comandos e cenários;
- mudanças de schema/configuração e plano de migração/rollback;
- impacto em métricas, fairness, privacidade, memória e integrações;
- limitações restantes e evidências relevantes.

Antes de concluir, revise o diff completo, execute todas as verificações documentadas e atualize README, exemplos, ADRs, definições estatísticas e este guia quando a estrutura real divergir da recomendação.

<!-- trail:start -->
## Trail — repo context graph

This repo is indexed in `.trail/cache/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `trail map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `trail ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `trail grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `trail skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `trail callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `.trail/cache/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `trail ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `trail build` (deterministic,
no API key, $0).
<!-- trail:end -->
