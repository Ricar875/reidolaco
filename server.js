// Rei do Laço — atendimento automático no Instagram + impressão ESC/POS (Bematech MP-4200 TH)
// Sem dependências: só Node 18+.  Rode:  node server.js
const http = require('http'), crypto = require('crypto'), fs = require('fs'), net = require('net');
const os = require('os'), path = require('path'), { exec } = require('child_process');

// ---------- .env ----------
try { fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
  if (m && !l.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}); } catch (e) {}
const E = process.env, PORT = +E.PORT || 3000;

// ---------- cardápio (edite aqui) ----------
const SIZES = { 1: { n: 'Pequena', p: 19, c: 2 }, 2: { n: 'Média', p: 23, c: 3 }, 3: { n: 'Grande', p: 27, c: 4 } };
const ESPETOS = { 1: { n: 'Espeto 1 (individual)', p: 43 }, 2: { n: 'Espeto 2 (serve 2)', p: 72 }, 3: { n: 'Espeto 3 (serve 3)', p: 91 } };
const CARNES = ['Contrafilé assado', 'Frango assado', 'Toscana', 'Frango ao molho', 'Bife acebolado',
  'Panqueca de frango ao molho branco', 'Panqueca de frango ao molho vermelho', 'Frango à parmegiana',
  'Frango empanado', 'Bife em tirinhas acebolado'];
const DIA = 'CARDÁPIO DO DIA\n\nAcompanhamentos: feijão tropeiro, feijão de caldo, arroz temperado, arroz branco, macarrão.\n\nCarnes: ' +
  CARNES.join(', ') + '.\n\nSaladas: vinagrete, maionese, alface com tomate e cebola.';
const INFO = 'Rei do Laço — Churrascaria & Marmitaria\nSegunda a domingo, das 10:30 às 16:00h\nAv. Otaviano Leandro de Morais, 293, Centro, Paulo Afonso - BA';
const brl = n => 'R$ ' + n.toFixed(2).replace('.', ',');

// ---------- pedidos (número sequencial salvo em orders.json) ----------
const ORD = path.join(__dirname, 'orders.json');
function nextNumber() {
  let n = 0; try { n = JSON.parse(fs.readFileSync(ORD, 'utf8')).last || 0; } catch (e) {}
  n++; fs.writeFileSync(ORD, JSON.stringify({ last: n })); return n;
}

// ---------- impressão ESC/POS (80 mm = 48 colunas) ----------
const strip = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '?');
function wrap(s, w, ind = '') {
  const out = []; let cur = '';
  for (const word of strip(s).split(/\s+/)) {
    if ((cur + ' ' + word).trim().length > w) { out.push(cur); cur = ind + word; } else cur = (cur + ' ' + word).trim();
  }
  if (cur) out.push(cur); return out;
}
function ticket(o) {
  const W = 48, B = [];
  const cmd = (...b) => B.push(Buffer.from(b));
  const line = (s = '') => B.push(Buffer.from(strip(s) + '\n', 'latin1'));
  const sep = () => line('-'.repeat(W));
  const lr = (a, b) => line(strip(a).slice(0, W - b.length - 1).padEnd(W - b.length) + b);
  cmd(0x1b, 0x40);                       // iniciar
  cmd(0x1b, 0x61, 1); cmd(0x1d, 0x21, 0x11);   // centro + fonte dupla
  line('REI DO LACO'); cmd(0x1d, 0x21, 0x00);
  line('Churrascaria & Marmitaria'); line();
  cmd(0x1d, 0x21, 0x11); line('PEDIDO #' + o.num); cmd(0x1d, 0x21, 0x00);
  line(new Date(o.at).toLocaleString('pt-BR', { timeZone: 'America/Bahia' }));
  line('Instagram: ' + (o.user ? '@' + o.user : 'cliente'));
  cmd(0x1b, 0x61, 0); sep();
  o.items.forEach(it => {
    cmd(0x1b, 0x45, 1); lr('1x ' + it.name, brl(it.price)); cmd(0x1b, 0x45, 0);
    if (it.det) wrap(it.det, W - 3, '   ').forEach(l => line('   ' + l.trimStart()));
  });
  sep(); cmd(0x1d, 0x21, 0x01); lr('TOTAL', brl(o.total)); cmd(0x1d, 0x21, 0x00); sep();
  cmd(0x1b, 0x45, 1); line('Cliente: ' + (o.nome || '-')); line('Tipo: ' + o.tipo.toUpperCase()); cmd(0x1b, 0x45, 0);
  if (o.end) wrap('Endereco: ' + o.end, W).forEach(line);
  line('Pagamento: ' + o.pag);
  if (o.tipo === 'Entrega') line('(taxa de entrega a combinar)');
  line(); line(); line(); cmd(0x1d, 0x56, 0x42, 0x00);   // avança e corta
  return Buffer.concat(B);
}
function sendToPrinter(buf) {
  return new Promise((ok, ko) => {
    const mode = E.PRINT_MODE || 'windows';
    if (mode === 'network') {
      const s = net.connect(+E.PRINTER_PORT || 9100, E.PRINTER_IP, () => s.end(buf));
      s.setTimeout(8000, () => { s.destroy(); ko(new Error('timeout na impressora')); });
      s.on('close', () => ok()); s.on('error', ko);
    } else if (mode === 'file') {
      fs.writeFile(E.PRINT_FILE || 'print.bin', buf, e => e ? ko(e) : ok());
    } else {   // windows: copia os bytes direto para a impressora compartilhada
      const f = path.join(os.tmpdir(), 'ticket-' + Date.now() + '.bin'); fs.writeFileSync(f, buf);
      exec(`copy /b "${f}" "\\\\localhost\\${E.PRINTER_SHARE || 'MP4200'}"`, e => { fs.unlink(f, () => {}); e ? ko(e) : ok(); });
    }
  });
}
async function printOrder(o, tries = 0) {
  try { await sendToPrinter(ticket(o)); console.log('🖨️  pedido #' + o.num + ' impresso'); }
  catch (e) { console.error('Falha ao imprimir #' + o.num + ':', e.message); if (tries < 5) setTimeout(() => printOrder(o, tries + 1), 15000 * (tries + 1)); }
}

// ---------- Instagram: enviar mensagem / ler nome ----------
const G = 'https://graph.instagram.com/v21.0';
async function say(id, text) {
  if (E.DRY_RUN) return console.log('  → [' + id + '] ' + text.replace(/\n/g, '\n     '));
  const r = await fetch(G + '/me/messages', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + E.IG_TOKEN },
    body: JSON.stringify({ recipient: { id }, message: { text: text.slice(0, 950) } }) });
  if (!r.ok) console.error('Erro ao enviar:', r.status, await r.text());
}
async function profile(id) {
  try { const r = await fetch(`${G}/${id}?fields=name,username`, { headers: { Authorization: 'Bearer ' + E.IG_TOKEN } });
    return r.ok ? await r.json() : {}; } catch (e) { return {}; }
}

// ---------- conversa ----------
const S = new Map();
const MENU = 'Responda com um número:\n\n1 - Pedir marmita\n2 - Pedir espeto\n3 - Cardápio do dia\n4 - Horário e endereço\n5 - Falar com atendente';
const HELLO = 'Olá! 👋 Bem-vindo ao Rei do Laço 🔥\nSou o atendimento automático.\n\n' + MENU;
const total = c => c.reduce((s, i) => s + i.price, 0);
const resumo = c => c.map((i, k) => `${k + 1}) ${i.name} — ${brl(i.price)}${i.det ? '\n   ' + i.det : ''}`).join('\n');
const fresh = () => ({ st: 'menu', cart: [], cur: {}, t: Date.now() });

function step(s, raw) {   // devolve { msgs: [...], done?: true }
  const t = raw.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (['menu', 'oi', 'ola', 'inicio', 'comecar', 'bom dia', 'boa tarde', 'boa noite'].includes(t)) { Object.assign(s, fresh()); return { msgs: [HELLO] }; }
  if (t === 'cancelar') { Object.assign(s, fresh()); return { msgs: ['Pedido cancelado. Para recomeçar, mande "menu".'] }; }
  if (s.st === 'human') return { msgs: [] };
  const n = parseInt(t, 10);
  switch (s.st) {
    case 'menu':
      if (n === 1) { s.st = 'size'; return { msgs: ['Qual o tamanho da marmita?\n\n' + Object.entries(SIZES).map(([k, v]) => `${k} - ${v.n} (${v.c} carnes) ${brl(v.p)}`).join('\n')] }; }
      if (n === 2) { s.st = 'espeto'; return { msgs: ['Qual espeto?\n\n' + Object.entries(ESPETOS).map(([k, v]) => `${k} - ${v.n} ${brl(v.p)}`).join('\n') + '\n\nAcompanha tropeiro, arroz, macarrão e vinagrete.'] }; }
      if (n === 3) return { msgs: [DIA, MENU] };
      if (n === 4) return { msgs: [INFO, MENU] };
      if (n === 5) { s.st = 'human'; return { msgs: ['Certo! Um atendente vai te responder em instantes. 🙏\n(Para voltar ao atendimento automático, mande "menu".)'] }; }
      return { msgs: [HELLO] };
    case 'size':
      if (!SIZES[n]) return { msgs: ['Digite 1, 2 ou 3 para escolher o tamanho.'] };
      s.cur = { size: SIZES[n] }; s.st = 'carnes';
      return { msgs: [`Marmita ${s.cur.size.n}: escolha ${s.cur.size.c} carnes.\n\n` + CARNES.map((c, i) => `${i + 1} - ${c}`).join('\n') +
        `\n\nMande os números separados por vírgula. Exemplo: 1,3` + (s.cur.size.c > 2 ? ',5' : '')] };
    case 'carnes': {
      const nums = [...new Set((t.match(/\d+/g) || []).map(Number))].filter(x => x >= 1 && x <= CARNES.length);
      if (nums.length !== s.cur.size.c) return { msgs: [`A marmita ${s.cur.size.n} leva ${s.cur.size.c} carnes diferentes. Mande os números separados por vírgula.`] };
      s.cur.carnes = nums.map(x => CARNES[x - 1]); s.st = 'obs';
      return { msgs: ['Alguma observação? Ex.: sem cebola, sem feijão, mais arroz.\nSe não, digite 0.'] };
    }
    case 'obs': {
      const obs = t === '0' ? '' : raw.trim().slice(0, 160);
      s.cart.push({ name: 'Marmita ' + s.cur.size.n, price: s.cur.size.p, det: 'Carnes: ' + s.cur.carnes.join(', ') + (obs ? ' | Obs: ' + obs : '') });
      s.st = 'more'; return { msgs: ['✅ Adicionado!\n\n' + resumo(s.cart) + '\n\nTotal: ' + brl(total(s.cart)) + '\n\n1 - Adicionar outro item\n2 - Finalizar pedido'] };
    }
    case 'espeto':
      if (!ESPETOS[n]) return { msgs: ['Digite 1, 2 ou 3 para escolher o espeto.'] };
      s.cart.push({ name: ESPETOS[n].n, price: ESPETOS[n].p, det: '' }); s.st = 'more';
      return { msgs: ['✅ Adicionado!\n\n' + resumo(s.cart) + '\n\nTotal: ' + brl(total(s.cart)) + '\n\n1 - Adicionar outro item\n2 - Finalizar pedido'] };
    case 'more':
      if (n === 1) { s.st = 'menu'; return { msgs: [MENU] }; }
      if (n === 2) { s.st = 'tipo'; return { msgs: ['Como prefere receber?\n\n1 - Retirar no local\n2 - Entrega'] }; }
      return { msgs: ['Digite 1 para adicionar outro item ou 2 para finalizar.'] };
    case 'tipo':
      if (n === 1) { s.tipo = 'Retirar no local'; s.end = ''; s.st = 'pag'; return { msgs: ['Forma de pagamento?\n\n1 - Pix\n2 - Dinheiro\n3 - Cartão'] }; }
      if (n === 2) { s.tipo = 'Entrega'; s.st = 'end'; return { msgs: ['Qual o endereço de entrega? (rua, número e bairro)'] }; }
      return { msgs: ['Digite 1 para retirar ou 2 para entrega.'] };
    case 'end':
      if (raw.trim().length < 6) return { msgs: ['Pode mandar o endereço completo? (rua, número e bairro)'] };
      s.end = raw.trim().slice(0, 160); s.st = 'pag'; return { msgs: ['Forma de pagamento?\n\n1 - Pix\n2 - Dinheiro\n3 - Cartão'] };
    case 'pag':
      if (![1, 2, 3].includes(n)) return { msgs: ['Digite 1 (Pix), 2 (Dinheiro) ou 3 (Cartão).'] };
      s.pag = ['Pix', 'Dinheiro', 'Cartão'][n - 1]; s.st = 'confirm';
      return { msgs: ['Confira seu pedido:\n\n' + resumo(s.cart) + '\n\nTotal: ' + brl(total(s.cart)) + '\n' + s.tipo + (s.end ? '\nEndereço: ' + s.end : '') +
        '\nPagamento: ' + s.pag + (s.tipo === 'Entrega' ? '\n(taxa de entrega combinada com o atendente)' : '') + '\n\n1 - Confirmar\n2 - Cancelar'] };
    case 'confirm':
      if (n === 1) return { msgs: [], done: true };
      if (n === 2) { Object.assign(s, fresh()); return { msgs: ['Pedido cancelado. Para recomeçar, mande "menu".'] }; }
      return { msgs: ['Digite 1 para confirmar ou 2 para cancelar.'] };
  }
  return { msgs: [HELLO] };
}

const seen = new Set();
async function onText(id, text) {
  let s = S.get(id);
  if (!s || Date.now() - s.t > 2 * 3600e3) { s = fresh(); S.set(id, s); if (!/^(menu|oi|ola)/i.test(text.trim())) { await say(id, HELLO); return; } }
  s.t = Date.now();
  const r = step(s, text);
  for (const m of r.msgs) await say(id, m);
  if (r.done) {
    const p = await profile(id);
    const o = { num: nextNumber(), at: Date.now(), user: p.username || '', nome: p.name || p.username || 'Cliente',
      items: s.cart, total: total(s.cart), tipo: s.tipo, end: s.end, pag: s.pag };
    fs.appendFileSync(path.join(__dirname, 'orders.log'), JSON.stringify(o) + '\n');
    printOrder(o);
    await say(id, `✅ Pedido #${o.num} confirmado e enviado para a cozinha! Obrigado, ${o.nome.split(' ')[0]}. 🔥\nPara fazer outro pedido, mande "menu".`);
    S.set(id, fresh());
  }
}

// ---------- servidor / webhook ----------
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/webhook' && req.method === 'GET') {   // verificação da Meta
    if (u.searchParams.get('hub.verify_token') === E.VERIFY_TOKEN) return res.end(u.searchParams.get('hub.challenge'));
    res.statusCode = 403; return res.end();
  }
  if (u.pathname === '/webhook' && req.method === 'POST') {
    const parts = []; req.on('data', c => parts.push(c)).on('end', () => {
      const raw = Buffer.concat(parts);
      if (E.APP_SECRET) {
        const sig = 'sha256=' + crypto.createHmac('sha256', E.APP_SECRET).update(raw).digest('hex'), got = req.headers['x-hub-signature-256'] || '';
        if (got.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(sig))) { res.statusCode = 401; return res.end(); }
      }
      res.end('ok');
      try {
        for (const en of JSON.parse(raw).entry || []) for (const m of en.messaging || []) {
          const msg = m.message; if (!msg || msg.is_echo || !msg.text || m.sender.id === en.id || seen.has(msg.mid)) continue;
          seen.add(msg.mid); if (seen.size > 500) seen.clear();
          onText(m.sender.id, msg.text).catch(e => console.error(e));
        }
      } catch (e) { console.error(e); }
    }); return;
  }
  if (u.pathname === '/health') return res.end('ok');
  res.statusCode = 404; res.end();
}).listen(PORT, () => console.log(`Rei do Laço bot no ar: http://localhost:${PORT}/webhook  (impressão: ${E.PRINT_MODE || 'windows'})`));
