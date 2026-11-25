# Definições estatísticas (versão 1)

Fonte primária: [API Headless oficial](https://github.com/haxball/haxball-issues/wiki/Headless-Host). Todos os tempos abaixo usam `getScores().time`, que não avança durante pausa. A atribuição de autoria e assistência é inferência do bot, não dado nativo do HaxBall.

| Métrica | Fonte e regra | Classe | Confiança |
| --- | --- | --- | --- |
| Placar | `onTeamGoal` e snapshot de `getScores()` | Observada | Alta |
| Toques | Um incremento por `onPlayerBallKick` em jogador de campo | Observada | Alta |
| Tempo em campo | Soma dos deltas de `getScores().time` em `onGameTick` enquanto `team` é 1 ou 2, máximo de 0,2 s por tick | Estimativa amostrada | Média |
| AFK | Fração do tempo em campo depois de `AFK_TIMEOUT_SECONDS` sem `onPlayerActivity` | Inferida | Baixa |
| Gol atribuído | Último toque nos 8 segundos antes de `onTeamGoal`; sem toque, autor desconhecido | Inferida | Média ou baixa |
| Gol contra | Último toque na janela por jogador do time que sofreu | Inferida | Média |
| Assistência | Último toque anterior de colega distinto na mesma janela; nenhum adversário pode estar entre ele e o autor | Inferida | Média |

A cadeia de toques é limpa no início, após gol, reset de posições, mudança de time e saída. Só os 16 toques mais recentes são mantidos. Estatísticas de posse, passes concluídos, defesas e distância ainda não são calculadas; os eventos oficiais não as fornecem diretamente. `validForRating` exige vitória, duração mínima configurada e quantidade igual de participantes majoritários por time. A versão de definição acompanha cada snapshot.
