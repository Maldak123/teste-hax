# ADR 0001 — Serviço local e página oficial

## Decisão

Executar a API Headless na [página oficial](https://html5.haxball.com/headless). `npm run room` gera o bundle, sobe o serviço e o injeta no Chrome por DevTools; colar o bundle no console permanece como alternativa manual. O serviço escuta apenas `127.0.0.1`, valida `Origin`, mantém segredos no ambiente e grava replay/estado em disco. Não usamos wrapper Headless de terceiros.

## Consequências

Um navegador precisa permanecer aberto. A recaptcha pode exigir intervenção humana, salvo token válido. A comunicação entre página HTTPS e loopback HTTP depende das políticas do navegador; teste em Chrome recente antes de operar. O serviço não expõe administração remota. O estado JSON atômico serve para uma instância; múltiplas instâncias exigem banco transacional e migração.

Webhooks Discord não oferecem garantia transacional compartilhada com o armazenamento local. Após timeout ou reinício durante envio, a outbox fica `uncertain` para reconciliação manual, evitando republicação automática potencialmente duplicada.
