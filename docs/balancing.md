# Balanceamento (versão 1)

Capacidade em campo: `TEAM_SIZE` por time. A sala aceita até `ROOM_MAX_PLAYERS` (máximo 30); os excedentes ficam como espectadores. A seleção usa ordem de espera, e o planejador divide os escolhidos com diferença de quantidade no máximo 1. Força prevista é o rating persistido após cinco partidas; antes disso, usa prior 1000. O custo é `abs(somaVermelho - somaAzul)`. Uma alocação gulosa por força seguida de trocas locais reduz esse custo de forma determinística. Não há sorteio escondido.

No lobby, `setPlayerTeam` é confirmado por `onPlayerTeamChange` ou reconciliação após três segundos. Após três falhas, o bot suspende o balanceamento até `!balance` do owner. Durante a partida, uma vaga é preenchida por espectador no próximo reset de posições. Times de mesmo tamanho só trocam um par após duas observações consecutivas com diferença de força de pelo menos 250, melhora mínima de 100 e cooldown global de 30 segundos. Cada jogador tem cooldown de 120 segundos; há no máximo quatro movimentos durante a partida. O custo antes/depois é auditado.

Rating muda apenas uma vez por identidade e partida válida. A versão 1 usa +16 na vitória e -16 na derrota. Partidas paradas, curtas, com gols divergentes ou participantes que jogaram nos dois times não alteram rating. Este rating é heurístico e não mede habilidade com incerteza estatística calibrada.
