# A Ponte: A2A por fora, MCP por dentro

Implementação do desafio de reserva de salas da Hill Valley Tech. Há dois processos separados: o servidor MCP em Streamable HTTP e o agente A2A, que se conecta a ele exclusivamente por HTTP. Não há LLM no caminho de execução.

## Como rodar

Pré-requisitos: Node.js 20+ e Python 3.10+.

```bash
git clone https://github.com/leandrorwgit/desafio-a2a-com-mcp.git
cd desafio-a2a-com-mcp
npm install
export REQUEST_STATE_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
```

Em um terminal, inicie o MCP:

```bash
npm run mcp
```

Em outro, inicie o agente:

```bash
npm run agente
```

Por fim, em um terceiro terminal, rode o validador:

```bash
python3 validador/validar.py --agente http://localhost:7300 --mcp http://localhost:7301
```

As portas padrão são 7300 para o agente e 7301 para o MCP. Elas podem ser alteradas por `AGENT_PORT`, `MCP_PORT` e `MCP_URL`.

## Onde a ponte acontece

No agente, `applyMcp` em `agente/index.js` converte o retorno MCP `resultType: input_required` em `TASK_STATE_INPUT_REQUIRED`: extrai apenas a lista de alternativas para a mensagem pública e guarda o `requestState` em `pendingByTask`, um mapa privado indexado pelo id da Task. Na continuação de `sendMessage`, o agente recupera esse estado privado, cria um novo request id e reenvia `inputResponses` e o mesmo `requestState` ao `tools/call` MCP. O agente nunca interpreta o conteúdo do token.

## Decisões técnicas

- O servidor usa `@modelcontextprotocol/server` 2.0.0 e seu `createRequestStateCodec`, que sela o payload com HMAC-SHA256 e expira em 600 segundos. A chave vem exclusivamente de `REQUEST_STATE_SECRET` e deve ter ao menos 32 bytes.
- Reservas ficam somente em memória no processo MCP. O payload assinado contém o pedido original e as alternativas, então um retry continua válido após reiniciar o MCP, desde que a mesma chave de ambiente seja usada.
- Tasks e seus históricos ficam em memória no agente. Os tokens MCP pendentes ficam em `pendingByTask`, fora do objeto serializado pela API A2A, evitando qualquer vazamento de `requestState`.
- O agente faz `tools/list` e `resources/read` antes da primeira reserva; a versão da política vem do resource, e o `traceparent` A2A é propagado ao `_meta` de cada request MCP.

## Saída do validador

```text
trace-id desta execucao: 1eb7bc79c0172a141d3e562b6981ac40
procure esse valor no stderr do servidor MCP para conferir a propagacao do traceparent.

PASS 01 tools/list traz as tres tools
PASS 02 toda tool tem inputSchema de objeto
PASS 03 listar_salas devolve structuredContent e o mesmo JSON em texto
PASS 04 _meta sem protocolVersion devolve -32602 e HTTP 400
PASS 05 _meta sem clientCapabilities devolve -32602 e HTTP 400
PASS 06 tool inexistente e recusada, por -32602 ou por isError
PASS 07 resources/read de politica://uso devolve a politica
PASS 08 resources/read de URI inexistente devolve -32602
PASS 09 sala inexistente devolve isError com a mensagem exata
PASS 10 fora da janela devolve isError com a mensagem exata
PASS 11 duracao acima de 2h devolve isError com a mensagem exata
PASS 12 intervalo invertido devolve isError com a mensagem exata
PASS 13 conflito devolve input_required com inputRequests e requestState
PASS 14 a elicitation e form mode e oferece as alternativas na ordem certa
PASS 15 conflito sem a capability elicitation devolve -32021 e HTTP 400
PASS 16 retry com inputResponses e requestState conclui a reserva
PASS 17 requestState adulterado e rejeitado com -32602
PASS 18 argumentos adulterados no retry nao tomam efeito
PASS 19 recusa conclui sem reservar e sem isError
PASS 20 conflito sem alternativa possivel devolve isError com a mensagem exata

PASS 21 agent card responde no well-known com JSON
PASS 22 o card declara a interface JSON-RPC com url e versao 1.0
PASS 23 o card declara a skill reservar-sala
PASS 24 SendMessage com sala livre conclui a Task
PASS 25 o artifact chama reserva e traz a versao da politica
PASS 26 GetTask devolve id, contextId e estado corrente
PASS 27 SendMessage com sala ocupada pausa a Task
PASS 28 a Task pausada lista as alternativas na ordem certa
PASS 29 escolha fora do enum mantem a Task pausada
PASS 30 a continuacao conclui a Task na sala escolhida
PASS 31 SendMessage em Task terminal e recusado
PASS 32 a recusa termina a Task em CANCELED
PASS 33 duas Tasks pausadas ao mesmo tempo concluem cada uma com a sua reserva
PASS 34 nenhuma resposta A2A carrega o requestState
PASS 35 sala inexistente termina a Task em FAILED com a mensagem da tool
PASS 36 o agente e deterministico: o mesmo pedido produz a mesma pausa

resumo: 36 passaram, 0 falharam, de 36 verificacoes
```
