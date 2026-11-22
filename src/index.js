// Planner bot: a private Telegram task planner on Cloudflare Workers.
// - Tasks are stored AES-GCM encrypted in D1 and shown only as short codes (e.g. K7).
// - Morning cron: open tasks + ask for today's plan. Night cron: review (Done / Not yet).
// - Tapping a code reveals the real text in a popup that leaves nothing in the chat.

const MAX_ROWS = 30;           // Telegram keyboards are limited to ~100 buttons
const MAX_TASK_LEN = 500;
const KEEP_CLOSED_DAYS = 7;    // closed tasks are kept this long so /undo works
const REVEAL_SECONDS = 20;     // long reveals are sent as a message and deleted after this

// ---------- Telegram ----------

async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({ ok: false }));
  if (!data.ok) console.log(`Telegram ${method} failed: ${JSON.stringify(data)}`);
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Encryption (AES-GCM, key from ENC_KEY secret) ----------

function bytesToB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

let cachedKey = null;
function getKey(env) {
  if (!cachedKey) {
    const raw = b64ToBytes(env.ENC_KEY);
    if (raw.length !== 32) throw new Error('ENC_KEY must be 32 bytes, base64-encoded');
    cachedKey = crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  return cachedKey;
}

async function encrypt(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await getKey(env), new TextEncoder().encode(text))
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return bytesToB64(out);
}

async function decrypt(env, b64) {
  const data = b64ToBytes(b64);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: data.slice(0, 12) },
    await getKey(env),
    data.slice(12)
  );
  return new TextDecoder().decode(pt);
}

// ---------- Codes ----------

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O
const DIGITS = '23456789';                  // no 0 / 1

function pick(chars) {
  const n = crypto.getRandomValues(new Uint32Array(1))[0];
  return chars[n % chars.length];
}

function newCode(used) {
  for (let len = 1; len <= 3; len++) {
    for (let i = 0; i < 60; i++) {
      let code = pick(LETTERS);
      for (let j = 0; j < len; j++) code += pick(DIGITS);
      if (!used.has(code)) {
        used.add(code);
        return code;
      }
    }
  }
  throw new Error('Could not generate a unique code');
}

// ---------- Database ----------

async function openTasks(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, code FROM tasks WHERE status = 'open' ORDER BY id"
  ).all();
  return results;
}

async function openTasksByIds(env, ids) {
  if (!ids.length) return [];
  const qs = ids.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT id, code FROM tasks WHERE status = 'open' AND id IN (${qs}) ORDER BY id`
  ).bind(...ids).all();
  return results;
}

async function getTask(env, id) {
  return env.DB.prepare('SELECT id, code, enc, status FROM tasks WHERE id = ?').bind(id).first();
}

async function addTasks(env, lines) {
  const used = new Set((await openTasks(env)).map((t) => t.code));
  const now = Date.now();
  const codes = [];
  const stmts = [];
  for (const line of lines) {
    const code = newCode(used);
    codes.push(code);
    stmts.push(
      env.DB.prepare("INSERT INTO tasks (code, enc, status, created_at) VALUES (?, ?, 'open', ?)")
        .bind(code, await encrypt(env, line), now)
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  return codes;
}

async function closeTask(env, id) {
  await env.DB.prepare("UPDATE tasks SET status = 'done', closed_at = ? WHERE id = ? AND status = 'open'")
    .bind(Date.now(), id).run();
}

async function undoLast(env) {
  const t = await env.DB.prepare(
    "SELECT id, code FROM tasks WHERE status = 'done' ORDER BY closed_at DESC LIMIT 1"
  ).first();
  if (!t) return null;
  const used = new Set((await openTasks(env)).map((x) => x.code));
  const code = used.has(t.code) ? newCode(used) : t.code;
  await env.DB.prepare("UPDATE tasks SET status = 'open', closed_at = NULL, code = ? WHERE id = ?")
    .bind(code, t.id).run();
  return code;
}

async function purgeClosed(env) {
  const cutoff = Date.now() - KEEP_CLOSED_DAYS * 24 * 3600 * 1000;
  await env.DB.prepare("DELETE FROM tasks WHERE status = 'done' AND closed_at < ?").bind(cutoff).run();
}

async function getMeta(env, key) {
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

async function setMeta(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(key, value).run();
}

// ---------- Task list messages ----------
// mode: 'm' = morning, 'n' = night review, 'l' = plain list (/open)

function renderList(mode, tasks, total = tasks.length) {
  const n = tasks.length;
  let text;
  if (mode === 'm') {
    text = '☀️ Good morning!\n\n' +
      (n ? `Open tasks: ${total}` : 'No open tasks.') +
      "\n\nWhat's the plan for today? Send your tasks as a message, one per line.";
  } else if (mode === 'n') {
    text = n
      ? `🌙 Night review\n\nOpen tasks: ${total}. Mark what you finished today.`
      : '🌙 Night review\n\nAll reviewed. Anything still open will show up again in the morning.';
  } else {
    text = n ? `📋 Open tasks: ${total}` : '📋 No open tasks. 🎉';
  }
  if (total > n) text += `\n\n(Showing ${n} of ${total}. Close some to see the rest.)`;
  if (n) text += '\n\nTap a 🔒 code to reveal it.';

  const rows = tasks.map((t) => {
    const row = [
      { text: `🔒 ${t.code}`, callback_data: `r:${t.id}` },
      { text: '✅ Done', callback_data: `d:${t.id}` },
    ];
    if (mode === 'n') row.push({ text: '⏳ Not yet', callback_data: `l:${t.id}` });
    return row;
  });
  if (n) rows.push([{ text: '👁 Reveal all', callback_data: `ra:${mode}` }]);

  return { text, reply_markup: { inline_keyboard: rows } };
}

// Sends a fresh list and deletes the previous one so only one live list stays in the chat.
async function sendList(env, chatId, mode) {
  const all = await openTasks(env);
  const { text, reply_markup } = renderList(mode, all.slice(0, MAX_ROWS), all.length);
  const prev = await getMeta(env, 'list_msg');
  const sent = await tg(env, 'sendMessage', { chat_id: chatId, text, reply_markup, protect_content: true });
  if (prev) await tg(env, 'deleteMessage', { chat_id: chatId, message_id: Number(prev) });
  if (sent.ok) await setMeta(env, 'list_msg', String(sent.result.message_id));
}

// Reads which tasks and mode a list message currently shows, straight from its buttons.
function parseListMessage(msg) {
  const kb = (msg && msg.reply_markup && msg.reply_markup.inline_keyboard) || [];
  const ids = [];
  let mode = 'l';
  for (const row of kb) {
    for (const b of row) {
      const d = b.callback_data || '';
      if (d.startsWith('r:')) ids.push(Number(d.slice(2)));
      if (d.startsWith('ra:')) mode = d.slice(3);
    }
  }
  return { ids, mode };
}

async function refreshList(env, msg, ids, mode) {
  const tasks = await openTasksByIds(env, ids);
  const { text, reply_markup } = renderList(mode, tasks);
  await tg(env, 'editMessageText', {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    text,
    reply_markup,
  });
}

// Short text: popup alert (nothing stays in the chat). Long text: temporary message.
async function reveal(env, ctx, cq, text) {
  if (text.length <= 190) {
    await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: true });
    return;
  }
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const chatId = cq.message.chat.id;
  const sent = await tg(env, 'sendMessage', {
    chat_id: chatId,
    text: `${text}\n\n(disappears in ${REVEAL_SECONDS} s)`,
    disable_notification: true,
    protect_content: true,
  });
  if (sent.ok) {
    ctx.waitUntil(
      sleep(REVEAL_SECONDS * 1000).then(() =>
        tg(env, 'deleteMessage', { chat_id: chatId, message_id: sent.result.message_id })
      )
    );
  }
}

// ---------- Handlers ----------

const HELP = [
  '🗒 Planner bot',
  '',
  '• Send tasks as a message, one per line. They are saved encrypted and shown only as codes.',
  '• Every morning: your open tasks, plus a prompt for today\'s plan.',
  '• Every night: review each task as ✅ Done or ⏳ Not yet.',
  '• Tap a 🔒 code to see the real text in a popup. Nothing readable stays in the chat.',
  '',
  '/open – show open tasks',
  '/review – start the night review now',
  '/undo – reopen the last task you marked done',
  '/help – this message',
].join('\n');

function parseLines(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter(Boolean)
    .map((l) => l.slice(0, MAX_TASK_LEN));
}

async function onMessage(env, msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!text) return;

  const first = text.split(/\s+/)[0];
  const cmd = first.startsWith('/') ? first.split('@')[0].toLowerCase() : null;

  switch (cmd) {
    case '/start':
    case '/help':
      await tg(env, 'sendMessage', { chat_id: chatId, text: HELP });
      return;
    case '/open':
      await sendList(env, chatId, 'l');
      return;
    case '/review':
      await sendList(env, chatId, 'n');
      return;
    case '/morning':
      await sendList(env, chatId, 'm');
      return;
    case '/undo': {
      const code = await undoLast(env);
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: code ? `↩️ Reopened ${code}` : 'Nothing to undo.',
      });
      return;
    }
    case '/add':
    case null: {
      const body = cmd ? text.slice(first.length) : text;
      const lines = parseLines(body);
      if (!lines.length) {
        await tg(env, 'sendMessage', { chat_id: chatId, text: 'Send tasks one per line.' });
        return;
      }
      const codes = await addTasks(env, lines);
      // Remove the plain-text message from the chat history.
      await tg(env, 'deleteMessage', { chat_id: chatId, message_id: msg.message_id });
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: `➕ Added ${codes.length}: ${codes.join(', ')}`,
        disable_notification: true,
      });
      return;
    }
    default:
      await tg(env, 'sendMessage', { chat_id: chatId, text: 'Unknown command. Send /help.' });
  }
}

async function onCallback(env, ctx, cq) {
  const msg = cq.message;
  if (!msg) return;
  const [action, arg] = (cq.data || '').split(':');
  const { ids, mode } = parseListMessage(msg);

  if (action === 'r') {
    const t = await getTask(env, Number(arg));
    if (!t || t.status !== 'open') {
      await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'This task is already closed.' });
      await refreshList(env, msg, ids, mode);
      return;
    }
    await reveal(env, ctx, cq, `${t.code}: ${await decrypt(env, t.enc)}`);
    return;
  }

  if (action === 'ra') {
    const lines = [];
    for (const id of ids) {
      const t = await getTask(env, id);
      if (t && t.status === 'open') lines.push(`${t.code}: ${await decrypt(env, t.enc)}`);
    }
    if (!lines.length) {
      await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'No open tasks here.' });
      return;
    }
    await reveal(env, ctx, cq, lines.join('\n'));
    return;
  }

  if (action === 'd') {
    await closeTask(env, Number(arg));
    await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: '✅ Done' });
    await refreshList(env, msg, ids.filter((id) => id !== Number(arg)), mode);
    return;
  }

  if (action === 'l') {
    await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: '⏳ Kept for tomorrow' });
    await refreshList(env, msg, ids.filter((id) => id !== Number(arg)), mode);
    return;
  }

  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
}

// Strips stray whitespace, line breaks or a BOM that can sneak in when the secret is set.
function allowedChatId(env) {
  return String(env.ALLOWED_CHAT_ID || '').replace(/[^\d-]/g, '');
}

async function handleUpdate(env, ctx, update) {
  const msg = update.message;
  const cq = update.callback_query;
  const chat = msg ? msg.chat : cq && cq.message ? cq.message.chat : null;
  if (!chat || chat.type !== 'private') return;

  // Before ALLOWED_CHAT_ID is set, the bot only tells you your chat ID.
  if (!allowedChatId(env)) {
    if (msg) {
      await tg(env, 'sendMessage', {
        chat_id: chat.id,
        text: `Your chat ID is ${chat.id}\n\nSet it with:\nnpx wrangler secret put ALLOWED_CHAT_ID`,
      });
    }
    return;
  }
  if (String(chat.id) !== allowedChatId(env)) return; // ignore everyone else

  if (msg) await onMessage(env, msg);
  else if (cq) await onCallback(env, ctx, cq);
}

// ---------- Entry points ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/webhook') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      try {
        await handleUpdate(env, ctx, await request.json());
      } catch (err) {
        console.log('Error handling update:', err && err.stack ? err.stack : err);
      }
      return new Response('ok'); // always 200 so Telegram doesn't retry
    }

    if (url.pathname === '/setup') {
      if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const webhook = await tg(env, 'setWebhook', {
        url: `${url.origin}/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: true,
      });
      const commands = await tg(env, 'setMyCommands', {
        commands: [
          { command: 'open', description: 'Show open tasks' },
          { command: 'review', description: 'Start the night review now' },
          { command: 'undo', description: 'Reopen the last completed task' },
          { command: 'help', description: 'How to use the bot' },
        ],
      });
      return Response.json({ webhook, commands });
    }

    return new Response('Planner bot is running.');
  },

  async scheduled(controller, env, ctx) {
    const chatId = allowedChatId(env);
    if (!chatId) return;
    const mode = controller.cron === env.MORNING_CRON ? 'm' : 'n';
    ctx.waitUntil(
      (async () => {
        await sendList(env, chatId, mode);
        if (mode === 'm') await purgeClosed(env);
      })()
    );
  },
};
