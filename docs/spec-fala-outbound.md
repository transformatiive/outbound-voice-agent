# Spec de fala — agente de voz outbound

Aprovado para o bot que **liga** (nunca o Alice inbound da Alfa Seguros).
Um bot, muitos objectivos. A forma de falar é partilhada. O objectivo é **dados**
(mesa, marcação, recado), não um segundo bot. Só há bot à parte quando o fluxo,
as ferramentas ou a persona são diferentes.

Voz e modelo (Grok/ara, GPT-Live, ElevenLabs, OpenAI Realtime) ficam à escolha.
Não fazem parte desta regra. Trocar a voz não corrige um erro de guião.

## Primeira frase

A primeira frase falada é uma linha **fixa e curta** que acaba em pausa ou em
pergunta. **Não** é montada a partir da persona nem do objectivo.

Reserva de restaurante (exemplo aprovado):

> Boa tarde. Tem mesa para hoje?

(«Boa tarde» segue a hora de Lisboa: Bom dia / Boa tarde / Boa noite.)

A primeira frase **não** contém o nome do sítio, a hora, o número de pessoas
nem o nome do conviva. Nunca «Sou a cliente. Marcar mesa para 2 pessoas hoje
às 21:00, em nome de Nuno Barreto.»

## Objectivo = lista de factos

O objectivo não é texto para ler em voz alta. É uma lista de factos. **Um
facto por turno**, e só depois de responder ao que a pessoa acabou de dizer.
Nunca dois factos na mesma frase.

Ordem para uma mesa, quando a pessoa **não** pergunta — só diz «diga» ou
espera:

1. que se quer uma mesa
2. o número de pessoas
3. a hora
4. o nome

Entre factos, espera. Nunca dois factos na mesma frase nem no mesmo turno.
Se a pessoa perguntar (quantas pessoas, que horas, em que nome), **responde
a isso primeiro**, um facto, e só no turno seguinte continua a lista pelo
que ainda faltar — sem repetir o pedido da mesa se já se falou de pessoas,
hora ou nome.

## Tomada de turno

- Espera até a pessoa acabar.
- Um «hum», «ah» ou «ok» sozinho não é fim de turno e não é interrupção.
- Não fiques em silêncio à volta de dois segundos: ou respondes, ou, se a
  pessoa só esperou, avanças o próximo facto.
- Uma ou duas frases curtas.
- Só português europeu de Portugal.
- Preenchimentos naturais (olá, pois, ok, hum) sem os empilhar.
- Nunca ditas que a chamada está a ser gravada.
- Agradeces antes de desligar.

## Como confirmar numa chamada

`POST /api/outbound` com `language: "pt-PT"`, `waitForCallee: true`, um
`objective` de mesa (pessoas, hora, nome) e o `tts_provider` que quiseres.
A primeira linha ouvida tem de ser o cumprimento de hora + «Tem mesa para
hoje?» — sem pessoas, hora nem nome. Se a casa perguntar «para quantas?», a
segunda fala responde só a isso. Se só disser «diga» ou ficar à espera, a
segunda fala é que se quer uma mesa — e pára.
