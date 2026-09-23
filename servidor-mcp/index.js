import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  McpServer,
  createMcpHandler,
  createRequestStateCodec,
  fromJsonSchema,
  inputRequired,
} from '@modelcontextprotocol/server';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const salas = JSON.parse(await readFile(resolve(root, 'dados/salas.json'), 'utf8'));
const reservas = JSON.parse(await readFile(resolve(root, 'dados/reservas.json'), 'utf8'));
const politicaTexto = await readFile(resolve(root, 'dados/politica-de-uso.md'), 'utf8');
const politica = politicaTexto.match(/^versao:\s*(.+)$/m)?.[1] ?? 'desconhecida';
const secret = process.env.REQUEST_STATE_SECRET;
if (!secret || Buffer.byteLength(secret) < 32) {
  throw new Error('REQUEST_STATE_SECRET deve ter ao menos 32 bytes.');
}
const stateCodec = createRequestStateCodec({ key: secret, ttlSeconds: 600 });

const salaSchema = fromJsonSchema({ type: 'object', properties: {}, additionalProperties: false });
const reservaSchema = fromJsonSchema({
  type: 'object', required: ['sala', 'inicio', 'fim', 'responsavel'], additionalProperties: false,
  properties: { sala: { type: 'string' }, inicio: { type: 'string' }, fim: { type: 'string' }, responsavel: { type: 'string' } },
});
const disponibilidadeSchema = fromJsonSchema({
  type: 'object', required: ['sala', 'inicio', 'fim'], additionalProperties: false,
  properties: { sala: { type: 'string' }, inicio: { type: 'string' }, fim: { type: 'string' } },
});

function toolError(text) {
  return { isError: true, content: [{ type: 'text', text }] };
}
function textAndStructured(structuredContent) {
  return { structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] };
}
function validar({ sala, inicio, fim }) {
  if (!salas.some((item) => item.id === sala)) return 'Sala inexistente: ' + sala;
  const inicioData = new Date(inicio);
  const fimData = new Date(fim);
  if (!Number.isFinite(inicioData.valueOf()) || !Number.isFinite(fimData.valueOf()) || fimData <= inicioData) {
    return 'Intervalo invalido: fim deve ser posterior a inicio';
  }
  const horaInicio = inicioData.getUTCHours() - 3;
  const horaFim = fimData.getUTCHours() - 3;
  if (horaInicio < 8 || horaFim > 20 || (horaFim === 20 && fimData.getUTCMinutes() !== 0)) {
    return 'Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00';
  }
  if (fimData - inicioData > 2 * 60 * 60 * 1000) return 'Duracao acima do limite: a politica permite no maximo 2 horas';
  return undefined;
}
function conflitos(sala, inicio, fim) {
  const de = new Date(inicio).valueOf();
  const ate = new Date(fim).valueOf();
  return reservas.filter((r) => r.sala === sala && new Date(r.inicio).valueOf() < ate && new Date(r.fim).valueOf() > de);
}
function alternativas(sala, inicio, fim) {
  const capacidade = salas.find((item) => item.id === sala).capacidade;
  return salas.filter((item) => item.id !== sala && item.capacidade >= capacidade && conflitos(item.id, inicio, fim).length === 0)
    .sort((a, b) => a.capacidade - b.capacidade || a.id.localeCompare(b.id)).slice(0, 3).map((item) => item.id);
}
function criarReserva({ sala, inicio, fim, responsavel }) {
  const reserva = { id: `res-${String(reservas.length + 1).padStart(4, '0')}`, sala, inicio, fim, responsavel };
  reservas.push(reserva);
  return textAndStructured({ reserva: reserva.id, reservado: true, sala, inicio, fim, responsavel, politica });
}

function criarServidor() {
  const server = new McpServer({ name: 'central-de-salas-mcp', version: '1.0.0' }, { requestState: { verify: stateCodec.verify } });
  server.registerResource('politica-de-uso', 'politica://uso', { mimeType: 'text/markdown' }, async () => ({
    contents: [{ uri: 'politica://uso', mimeType: 'text/markdown', text: politicaTexto }],
  }));
  server.registerTool('listar_salas', { inputSchema: salaSchema, outputSchema: fromJsonSchema({ type: 'object' }) }, async () => textAndStructured({ salas }));
  server.registerTool('consultar_disponibilidade', { inputSchema: disponibilidadeSchema, outputSchema: fromJsonSchema({ type: 'object' }) }, async (args) => {
    const erro = validar(args);
    if (erro) return toolError(erro);
    const emConflito = conflitos(args.sala, args.inicio, args.fim);
    return textAndStructured({ sala: args.sala, inicio: args.inicio, fim: args.fim, livre: emConflito.length === 0, conflitos: emConflito });
  });
  server.registerTool('reservar_sala', { inputSchema: reservaSchema, outputSchema: fromJsonSchema({ type: 'object' }) }, async (args, ctx) => {
    const sealed = ctx.mcpReq.requestState();
    if (sealed && typeof sealed === 'object') {
      const response = ctx.mcpReq.inputResponses?.[sealed.key];
      if (response?.action === 'decline' || response?.action === 'cancel') {
        return textAndStructured({ reservado: false, motivo: 'Alternativas recusadas' });
      }
      const escolhida = response?.action === 'accept' ? response.content?.sala : undefined;
      if (!sealed.alternativas.includes(escolhida)) {
        return inputRequired({ requestState: await stateCodec.mint(sealed), inputRequests: {
          [sealed.key]: inputRequired.elicit({ mode: 'form', message: 'A sala pedida esta ocupada nesse intervalo. Escolha uma alternativa.', requestedSchema: { type: 'object', properties: { sala: { type: 'string', enum: sealed.alternativas } }, required: ['sala'] } }),
        } });
      }
      return criarReserva({ ...sealed.pedido, sala: escolhida });
    }
    const erro = validar(args);
    if (erro) return toolError(erro);
    if (conflitos(args.sala, args.inicio, args.fim).length === 0) return criarReserva(args);
    const opcoes = alternativas(args.sala, args.inicio, args.fim);
    if (opcoes.length === 0) return toolError('Sem alternativas disponiveis no intervalo');
    const payload = { pedido: args, alternativas: opcoes, key: `escolha-${crypto.randomUUID()}` };
    return inputRequired({ requestState: await stateCodec.mint(payload), inputRequests: {
      [payload.key]: inputRequired.elicit({ mode: 'form', message: 'A sala pedida esta ocupada nesse intervalo. Escolha uma alternativa.', requestedSchema: { type: 'object', properties: { sala: { type: 'string', enum: opcoes } }, required: ['sala'] } }),
    } });
  });
  return server;
}

const handler = createMcpHandler(criarServidor, { legacy: 'reject', responseMode: 'json' });
http.createServer(async (req, res) => {
  if (req.url !== '/mcp' || req.method !== 'POST') { res.writeHead(404).end(); return; }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  let json;
  try { json = JSON.parse(body.toString()); } catch { json = {}; }
  console.error(JSON.stringify({ method: json.method, id: json.id, traceparent: json.params?._meta?.traceparent }));
  try {
    const request = new Request(`http://${req.headers.host ?? 'localhost:7301'}${req.url}`, { method: 'POST', headers: req.headers, body, duplex: 'half' });
    const response = await handler.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: json.id ?? null, error: { code: -32603, message: 'Internal error' } }));
  }
}).listen(Number(process.env.MCP_PORT ?? 7301), () => console.error('MCP em http://localhost:7301/mcp'));
