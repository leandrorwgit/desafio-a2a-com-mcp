import http from 'node:http';
import crypto from 'node:crypto';

const mcpUrl = process.env.MCP_URL ?? 'http://localhost:7301/mcp';
const port = Number(process.env.AGENT_PORT ?? 7300);
const protocolVersion = '2026-07-28';
const tasks = new Map();
const pendingByTask = new Map();
let toolsDiscovered = false;
let policyVersion = undefined;

function id(prefix) { return `${prefix}-${crypto.randomUUID()}`; }
function message(text, task) { return { messageId: id('msg'), role: 'ROLE_AGENT', parts: [{ text }], taskId: task.id, contextId: task.contextId }; }
function setStatus(task, state, text) { const entry = message(text, task); task.status = { state, message: entry }; task.history.push(entry); return task; }
function taskResponse(task) { return { task }; }
function rpcError(idValue, code, text) { return { jsonrpc: '2.0', id: idValue ?? null, error: { code, message: text } }; }
function traceForMcp(traceparent) {
  if (!traceparent) return undefined;
  const fields = traceparent.split('-');
  return fields.length === 4 ? `00-${fields[1]}-${crypto.randomBytes(8).toString('hex')}-${fields[3]}` : traceparent;
}
async function mcp(method, params, name, traceparent) {
  const meta = { 'io.modelcontextprotocol/protocolVersion': protocolVersion, 'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } } };
  if (traceparent) meta.traceparent = traceForMcp(traceparent);
  const request = { jsonrpc: '2.0', id: crypto.randomUUID(), method, params: { ...params, _meta: meta } };
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': protocolVersion, 'Mcp-Method': method };
  if (name) headers['Mcp-Name'] = name;
  const response = await fetch(mcpUrl, { method: 'POST', headers, body: JSON.stringify(request) });
  return response.json();
}
async function discover() {
  if (toolsDiscovered) return;
  const listed = await mcp('tools/list', {});
  const names = new Set((listed.result?.tools ?? []).map((tool) => tool.name));
  if (!names.has('reservar_sala')) throw new Error('Tool reservar_sala nao descoberta');
  const resource = await mcp('resources/read', { uri: 'politica://uso' }, 'politica://uso');
  policyVersion = resource.result?.contents?.[0]?.text?.match(/^versao:\s*(.+)$/m)?.[1];
  toolsDiscovered = true;
}
function parseReservation(text) {
  const fields = Object.fromEntries([...text.matchAll(/(sala|inicio|fim|responsavel)=([^\s]+)/g)].map((item) => [item[1], item[2]]));
  return fields.sala && fields.inicio && fields.fim && fields.responsavel ? fields : undefined;
}
function alternatives(result) {
  const [key, request] = Object.entries(result.inputRequests ?? {})[0] ?? [];
  const field = request?.params?.requestedSchema?.properties?.sala ?? {};
  return { key, rooms: field.enum ?? (field.const ? [field.const] : []) };
}
async function reserve(task, args, traceparent) {
  const response = await mcp('tools/call', { name: 'reservar_sala', arguments: args }, 'reservar_sala', traceparent);
  return applyMcp(task, response, traceparent);
}
function artifact(task, data) {
  task.artifacts.push({ artifactId: id('art'), name: 'reserva', parts: [{ text: JSON.stringify(data) }] });
}
async function applyMcp(task, response, traceparent) {
  if (response.error || response.result?.isError) {
    const text = response.error?.message ?? response.result?.content?.map((part) => part.text ?? '').join(' ') ?? 'Falha na reserva';
    return setStatus(task, 'TASK_STATE_FAILED', text);
  }
  const result = response.result ?? {};
  if (result.resultType === 'input_required') {
    const data = alternatives(result);
    // requestState pertence ao estado privado do host MCP, nunca ao objeto Task
    // que e serializado para o cliente A2A.
    pendingByTask.set(task.id, { requestState: result.requestState, key: data.key, alternatives: data.rooms, args: task.args, traceparent });
    return setStatus(task, 'TASK_STATE_INPUT_REQUIRED', `alternativas: ${data.rooms.join(', ')}`);
  }
  const data = result.structuredContent ?? {};
  if (data.reservado === false) return setStatus(task, 'TASK_STATE_CANCELED', data.motivo ?? 'Reserva cancelada');
  pendingByTask.delete(task.id);
  artifact(task, data);
  return setStatus(task, 'TASK_STATE_COMPLETED', `Reserva ${data.reserva} confirmada na ${data.sala}.`);
}
async function sendMessage(messageInput, traceparent) {
  const taskId = messageInput.taskId;
  const userText = messageInput.parts?.map((part) => part.text ?? '').join(' ') ?? '';
  if (!taskId) {
    const task = { id: id('task'), contextId: id('ctx'), status: { state: 'TASK_STATE_SUBMITTED' }, history: [messageInput], artifacts: [], args: parseReservation(userText) };
    tasks.set(task.id, task);
    setStatus(task, 'TASK_STATE_WORKING', 'Processando reserva.');
    if (!task.args) return setStatus(task, 'TASK_STATE_FAILED', 'Pedido de reserva invalido');
    await discover();
    await reserve(task, task.args, traceparent);
    return taskResponse(task);
  }
  const task = tasks.get(taskId);
  if (!task) throw new Error('Task inexistente');
  if (['TASK_STATE_COMPLETED', 'TASK_STATE_CANCELED', 'TASK_STATE_FAILED'].includes(task.status.state)) throw new Error('Task em estado terminal');
  task.history.push(messageInput);
  const pending = pendingByTask.get(task.id);
  if (!pending) throw new Error('Task sem continuacao pendente');
  const choice = userText.match(/^escolha=(\S+)$/)?.[1];
  if (!choice || !pending.alternatives.includes(choice) && choice !== 'recusar') return taskResponse(task);
  const action = choice === 'recusar' ? 'decline' : 'accept';
  const continuation = await mcp('tools/call', { name: 'reservar_sala', arguments: pending.args, inputResponses: { [pending.key]: action === 'accept' ? { action, content: { sala: choice } } : { action } }, requestState: pending.requestState }, 'reservar_sala', traceparent ?? pending.traceparent);
  await applyMcp(task, continuation, traceparent ?? pending.traceparent);
  return taskResponse(task);
}
const card = { name: 'Central de Salas', description: 'Reserva salas de reuniao da Hill Valley Tech.', provider: { organization: 'Hill Valley Tech', url: 'https://hillvalley.example' }, version: '1.0.0', supportedInterfaces: [{ url: `http://localhost:${port}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }], capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false }, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [{ id: 'reservar-sala', name: 'Reservar sala', description: 'Reserva uma sala em um intervalo.', tags: ['salas', 'agenda'], inputModes: ['text/plain'], outputModes: ['text/plain'] }] };
http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(card)); return; }
  if (req.method !== 'POST' || req.url !== '/a2a') { res.writeHead(404).end(); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { body = undefined; }
  if (!body) { res.writeHead(400).end(); return; }
  try {
    let result;
    if (body.method === 'SendMessage') result = await sendMessage(body.params?.message ?? {}, req.headers.traceparent);
    else if (body.method === 'GetTask') { const task = tasks.get(body.params?.id); if (!task) throw new Error('Task inexistente'); result = taskResponse(task); }
    else { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(rpcError(body.id, -32601, 'Method not found'))); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  } catch (error) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(rpcError(body.id, -32602, error.message))); }
}).listen(port, () => console.error(`Agente em http://localhost:${port}/a2a`));
