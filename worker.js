// ====================== НАСТРОЙКИ ======================
const BOT_TOKEN = "9121745622:AAFmjOcDXlvI3Rf6OOR8d7_JB3aeDih-Jc0";
const MAX_ACTIVE_PER_USER = 5;
// =======================================================

function tgApi(env, method, params) {
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params || {}),
  }).then((r) => r.json());
}

function send(env, chat_id, text, extra) {
  return tgApi(env, "sendMessage", {
    chat_id,
    text,
    parse_mode: "HTML",
    ...extra,
  });
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function pretty(minutes) {
  minutes = Math.round(minutes);
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  const parts = [];
  if (d) parts.push(`${d} д.`);
  if (h) parts.push(`${h} ч.`);
  if (m || !parts.length) parts.push(`${m} мин.`);
  return parts.join(" ");
}

function parseDuration(s) {
  const m = s.trim().toLowerCase().match(/^(\d+)\s*([a-zа-я]*)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  let mult;
  if (["", "м", "мин", "m", "min"].includes(unit)) mult = 1;
  else if (["ч", "час", "часа", "часов", "h"].includes(unit)) mult = 60;
  else if (["д", "дн", "день", "дня", "дней", "d"].includes(unit)) mult = 1440;
  else return null;
  const minutes = n * mult;
  return minutes >= 1 && minutes <= 43200 ? minutes : null;
}

// ---------- Работа с KV-хранилищем ----------
async function getJSON(env, key, fallback) {
  const v = await env.CONTEST_KV.get(key, "json");
  return v === null ? fallback : v;
}
function setJSON(env, key, value) {
  return env.CONTEST_KV.put(key, JSON.stringify(value));
}

async function getState(env, uid) {
  return getJSON(env, `state:${uid}`, null);
}
function setState(env, uid, state) {
  if (state === null) return env.CONTEST_KV.delete(`state:${uid}`);
  return setJSON(env, `state:${uid}`, state);
}

async function nextId(env) {
  const cur = (await getJSON(env, "counter", 0)) + 1;
  await setJSON(env, "counter", cur);
  return cur;
}

async function getGiveaway(env, gid) {
  return getJSON(env, `gw:${gid}`, null);
}
function setGiveaway(env, gid, data) {
  return setJSON(env, `gw:${gid}`, data);
}

async function getOwnerList(env, uid) {
  return getJSON(env, `owner:${uid}`, []);
}
async function addToOwnerList(env, uid, gid) {
  const list = await getOwnerList(env, uid);
  list.push(gid);
  await setJSON(env, `owner:${uid}`, list);
}

async function getParticipants(env, gid) {
  return getJSON(env, `parts:${gid}`, {});
}
function setParticipants(env, gid, obj) {
  return setJSON(env, `parts:${gid}`, obj);
}

async function getTimersList(env) {
  return getJSON(env, "timers", []);
}
async function addTimer(env, gid, endTs) {
  const list = await getTimersList(env);
  list.push({ gid, endTs });
  await setJSON(env, "timers", list);
}
async function removeTimer(env, gid) {
  const list = await getTimersList(env);
  await setJSON(env, "timers", list.filter((t) => t.gid !== gid));
}

// ---------- Вспомогательное ----------
const BTN_NEW = "🎁 Создать конкурс";
const BTN_LIST = "📋 Мои конкурсы";
const BTN_HELP = "❓ Помощь";
const BUTTON_TO_CMD = { [BTN_NEW]: "/new", [BTN_LIST]: "/list", [BTN_HELP]: "/help" };
const CANCEL_ROW = [{ text: "❌ Отмена", callback_data: "abort" }];

function menu() {
  return {
    keyboard: [[{ text: BTN_NEW }, { text: BTN_LIST }], [{ text: BTN_HELP }]],
    resize_keyboard: true,
  };
}

function joinKeyboard(gid, count) {
  return {
    inline_keyboard: [[{ text: `🎉 Участвовать (${count})`, callback_data: `join:${gid}` }]],
  };
}

function buildPost(d) {
  let text = `🎁 <b>${escapeHtml(d.title)}</b>\n\n`;
  if (d.text) text += `${escapeHtml(d.text)}\n\n`;
  text += `🏆 Победителей: ${d.winners}\n⏰ Итоги через: ${pretty(d.minutes)}\n\nНажми кнопку ниже, чтобы участвовать 👇`;
  return text;
}

const HELP = `Привет! Я бот для конкурсов 🎁

Я помогу провести конкурс в <b>твоём</b> канале.

<b>Как начать:</b>
1. Добавь меня в свой канал администратором (право публиковать сообщения).
2. Нажми «🎁 Создать конкурс» и ответь на несколько вопросов.
3. Я опубликую пост с кнопкой «Участвовать» и сам подведу итоги.

«📋 Мои конкурсы» покажет твои активные конкурсы с кнопками «Итоги» и «Отмена».

Чтобы просто участвовать в чужом конкурсе, нажми «Участвовать» под постом в канале.`;

// ---------- Проверка канала ----------
function resolveChatRef(text) {
  const t = text.trim();
  if (/^-?\d{5,}$/.test(t)) return parseInt(t, 10);
  const m = t.match(/t\.me\/([A-Za-z0-9_+]+)/);
  if (m) {
    const name = m[1];
    if (name.startsWith("+") || ["joinchat", "c"].includes(name)) return null;
    return "@" + name;
  }
  if (t.startsWith("@") && t.length > 2) return t;
  if (/^[A-Za-z][A-Za-z0-9_]{4,}$/.test(t)) return "@" + t;
  return null;
}

async function checkChannel(env, uid, ref, botId) {
  const res = await tgApi(env, "getChat", { chat_id: ref });
  if (!res.ok) {
    return [null, "Не нашёл такой канал. Проверь название. Если канал приватный, добавь меня в него админом и перешли сюда любой пост из канала."];
  }
  const chat = res.result;
  if (!["channel", "supergroup"].includes(chat.type)) {
    return [null, "Это не канал. Пришли канал или группу."];
  }
  const cid = chat.id;

  const me = await tgApi(env, "getChatMember", { chat_id: cid, user_id: uid });
  if (!me.ok || !["creator", "administrator"].includes(me.result.status)) {
    return [null, "Ты не администратор этого канала. Конкурсы можно проводить только в своих каналах."];
  }

  const bot = await tgApi(env, "getChatMember", { chat_id: cid, user_id: botId });
  const b = bot.ok ? bot.result : {};
  if (b.status !== "administrator") {
    return [null, "Я не администратор канала. Добавь меня админом с правом публиковать сообщения и пришли канал ещё раз."];
  }
  if (chat.type === "channel" && !b.can_post_messages) {
    return [null, "У меня нет права публиковать сообщения. Включи его и пришли канал ещё раз."];
  }

  return [{ id: cid, title: chat.title || String(cid) }, null];
}

// ---------- Шаги создания ----------
function askWinners(env, chat_id) {
  const rows = [
    [1, 2, 3].map((n) => ({ text: String(n), callback_data: `w:${n}` })),
    [5, 10, 20].map((n) => ({ text: String(n), callback_data: `w:${n}` })),
    CANCEL_ROW,
  ];
  return send(env, chat_id, "<b>Шаг 4/5.</b> Сколько будет победителей?\nВыбери кнопкой или напиши число.", {
    reply_markup: { inline_keyboard: rows },
  });
}

function askDuration(env, chat_id) {
  const opts = [["30 мин", 30], ["1 час", 60], ["3 часа", 180], ["12 часов", 720], ["1 день", 1440], ["3 дня", 4320]];
  const rows = [
    opts.slice(0, 3).map(([t, m]) => ({ text: t, callback_data: `d:${m}` })),
    opts.slice(3).map(([t, m]) => ({ text: t, callback_data: `d:${m}` })),
    CANCEL_ROW,
  ];
  return send(env, chat_id,
    "<b>Шаг 5/5.</b> Через сколько подвести итоги?\nВыбери кнопкой или напиши своё время: <code>45</code> (минуты), <code>2ч</code>, <code>5д</code>",
    { reply_markup: { inline_keyboard: rows } });
}

async function showPreview(env, chat_id, uid, st) {
  st.step = "confirm";
  await setState(env, uid, st);
  await send(env, chat_id, `Канал: <b>${escapeHtml(st.data.chat_title)}</b>\nТак будет выглядеть пост:`);
  await send(env, chat_id, buildPost(st.data), {
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ Опубликовать", callback_data: "pub" },
        { text: "❌ Отмена", callback_data: "abort" },
      ]],
    },
  });
}

// ---------- Обработка сообщений ----------
async function handleMessage(env, msg, botId) {
  if (msg.chat.type !== "private") return;
  const uid = msg.from.id;
  const chat_id = msg.chat.id;
  let text = (msg.text || "").trim();
  let st = await getState(env, uid);

  if (BUTTON_TO_CMD[text]) text = BUTTON_TO_CMD[text];

  if (text.startsWith("/")) {
    const parts = text.split(/\s+/);
    const cmd = parts[0].split("@")[0].toLowerCase();
    return handleCommand(env, cmd, parts.slice(1), uid, chat_id);
  }

  if (st && st.step === "channel") {
    return handleChannelStep(env, st, msg, text, uid, chat_id, botId);
  }
  if (!text) return;
  if (st) return handleStep(env, st, text, uid, chat_id);
}

async function activeCount(env, uid) {
  const list = await getOwnerList(env, uid);
  let count = 0;
  for (const gid of list) {
    const g = await getGiveaway(env, gid);
    if (g && !g.finished) count++;
  }
  return count;
}

async function handleCommand(env, cmd, args, uid, chat_id) {
  if (cmd === "/start" || cmd === "/help") {
    return send(env, chat_id, HELP, { reply_markup: menu() });
  }

  if (cmd === "/new") {
    if ((await activeCount(env, uid)) >= MAX_ACTIVE_PER_USER) {
      return send(env, chat_id, `У тебя уже ${MAX_ACTIVE_PER_USER} активных конкурса. Заверши или отмени один из них («📋 Мои конкурсы»).`);
    }
    await setState(env, uid, { step: "channel", data: {} });
    return send(env, chat_id,
      "Создаём конкурс.\n\n<b>Шаг 1/5.</b> В каком канале проводим?\nСначала добавь меня в канал <b>администратором</b> (право публиковать сообщения). Потом пришли @название канала или перешли сюда любой пост из него.",
      { reply_markup: { inline_keyboard: [CANCEL_ROW] } });
  }

  if (cmd === "/list") {
    const list = await getOwnerList(env, uid);
    const active = [];
    for (const gid of list) {
      const g = await getGiveaway(env, gid);
      if (g && !g.finished) active.push([gid, g]);
    }
    if (!active.length) return send(env, chat_id, "У тебя нет активных конкурсов.");
    for (const [gid, g] of active) {
      const parts = await getParticipants(env, gid);
      const count = Object.keys(parts).length;
      const left = Math.max(0, Math.round((g.endTs - Date.now() / 1000) / 60));
      await send(env, chat_id,
        `<b>#${gid} — ${escapeHtml(g.title)}</b>\nКанал: ${escapeHtml(g.chat_title)}\nУчастников: ${count}\nОсталось: ${pretty(left)}`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: "🏁 Итоги сейчас", callback_data: `fin:${gid}` },
              { text: "🚫 Отменить", callback_data: `can:${gid}` },
            ]],
          },
        });
    }
    return;
  }

  if (cmd === "/finish" || cmd === "/cancel") {
    if (cmd === "/cancel" && !args.length) {
      const st = await getState(env, uid);
      if (st) {
        await setState(env, uid, null);
        return send(env, chat_id, "Создание конкурса отменено.");
      }
      return send(env, chat_id, "Нечего отменять. Чтобы отменить конкурс: <code>/cancel НОМЕР</code>");
    }
    const gid = parseInt(args[0], 10);
    if (!gid) return send(env, chat_id, `Пример: <code>${cmd} 1</code>`);
    const g = await getGiveaway(env, gid);
    if (!g || g.owner_id !== uid) return send(env, chat_id, "Это не твой конкурс или он не найден.");
    const ok = await finishGiveaway(env, gid, cmd === "/cancel");
    return send(env, chat_id, ok ? "Готово." : "Конкурс уже завершён.");
  }

  return send(env, chat_id, "Не знаю такой команды. Нажми «❓ Помощь».");
}

async function handleChannelStep(env, st, msg, text, uid, chat_id, botId) {
  let ref = null;
  const origin = msg.forward_origin;
  if (origin && origin.type === "channel") ref = origin.chat.id;
  else if (msg.forward_from_chat) ref = msg.forward_from_chat.id;
  else if (text) ref = resolveChatRef(text);

  if (ref === null) {
    return send(env, chat_id, "Не понял. Пришли @название канала, ссылку t.me/... или перешли любой пост из канала.");
  }
  const [info, err] = await checkChannel(env, uid, ref, botId);
  if (err) return send(env, chat_id, err);

  st.data.chat_id = info.id;
  st.data.chat_title = info.title;
  st.step = "title";
  await setState(env, uid, st);
  return send(env, chat_id,
    `Канал: <b>${escapeHtml(info.title)}</b> ✅\n\n<b>Шаг 2/5.</b> Напиши название конкурса:`,
    { reply_markup: { inline_keyboard: [CANCEL_ROW] } });
}

async function handleStep(env, st, text, uid, chat_id) {
  const d = st.data;

  if (st.step === "title") {
    d.title = text.slice(0, 100);
    st.step = "text";
    await setState(env, uid, st);
    return send(env, chat_id, "<b>Шаг 3/5.</b> Напиши, что разыгрываем и условия.", {
      reply_markup: { inline_keyboard: [[{ text: "Пропустить", callback_data: "skip" }], CANCEL_ROW] },
    });
  }

  if (st.step === "text") {
    d.text = text.slice(0, 1000);
    st.step = "winners";
    await setState(env, uid, st);
    return askWinners(env, chat_id);
  }

  if (st.step === "winners") {
    const n = parseInt(text, 10);
    if (!n || n < 1 || n > 50) return send(env, chat_id, "Напиши число от 1 до 50 или выбери кнопкой.");
    d.winners = n;
    st.step = "duration";
    await setState(env, uid, st);
    return askDuration(env, chat_id);
  }

  if (st.step === "duration") {
    const minutes = parseDuration(text);
    if (!minutes) {
      return send(env, chat_id,
        "Не понял время. Примеры: <code>30</code>, <code>2ч</code>, <code>1д</code> (максимум 30 дней). Или выбери кнопкой.");
    }
    d.minutes = minutes;
    return showPreview(env, chat_id, uid, st);
  }

  if (st.step === "confirm") {
    return send(env, chat_id, "Нажми «Опубликовать» или «Отмена» под превью.");
  }
}

// ---------- Кнопки ----------
async function handleCallback(env, cb, botId) {
  const cid = cb.id;
  const user = cb.from;
  const uid = user.id;
  const data = cb.data || "";

  const alert = (t, show = true) => tgApi(env, "answerCallbackQuery", { callback_query_id: cid, text: t, show_alert: show });

  const isAdminAction = ["pub", "abort", "skip"].includes(data) ||
    /^(w:|d:|fin:|can:)/.test(data);

  if (isAdminAction) {
    const chat_id = cb.message.chat.id;
    let st = await getState(env, uid);

    if (data === "abort") {
      await setState(env, uid, null);
      await alert("Отменено.", false);
      return send(env, chat_id, "Создание конкурса отменено.");
    }

    if (data.startsWith("fin:") || data.startsWith("can:")) {
      const gid = parseInt(data.split(":")[1], 10);
      const g = await getGiveaway(env, gid);
      if (!g || g.owner_id !== uid) return alert("Это не твой конкурс.");
      const ok = await finishGiveaway(env, gid, data.startsWith("can:"));
      return alert(ok ? "Готово." : "Конкурс уже завершён.");
    }

    if (data === "skip") {
      if (!st || st.step !== "text") return alert("Кнопка устарела. Нажми «Создать конкурс».");
      st.data.text = "";
      st.step = "winners";
      await setState(env, uid, st);
      await alert("", false);
      return askWinners(env, chat_id);
    }

    if (data.startsWith("w:")) {
      if (!st || st.step !== "winners") return alert("Кнопка устарела. Нажми «Создать конкурс».");
      st.data.winners = parseInt(data.split(":")[1], 10);
      st.step = "duration";
      await setState(env, uid, st);
      await alert("", false);
      return askDuration(env, chat_id);
    }

    if (data.startsWith("d:")) {
      if (!st || st.step !== "duration") return alert("Кнопка устарела. Нажми «Создать конкурс».");
      st.data.minutes = parseInt(data.split(":")[1], 10);
      await alert("", false);
      return showPreview(env, chat_id, uid, st);
    }

    if (data === "pub") {
      if (!st || st.step !== "confirm") return alert("Это превью устарело. Нажми «Создать конкурс».");
      if ((await activeCount(env, uid)) >= MAX_ACTIVE_PER_USER) {
        return alert(`Уже ${MAX_ACTIVE_PER_USER} активных конкурса. Заверши один из них.`);
      }
      const d = st.data;
      const [info, err] = await checkChannel(env, uid, d.chat_id, botId);
      if (err) {
        await alert("Не получилось.", false);
        return send(env, chat_id, err);
      }
      const endTs = Math.floor(Date.now() / 1000) + d.minutes * 60;
      const gid = await nextId(env);
      const res = await send(env, d.chat_id, buildPost(d), { reply_markup: joinKeyboard(gid, 0) });
      if (!res.ok) {
        await alert("Не получилось.", false);
        return send(env, chat_id,
          `Не смог опубликовать: ${res.description}\nПроверь, что я админ канала с правом публиковать. Потом нажми «Опубликовать» ещё раз.`);
      }
      await setGiveaway(env, gid, {
        owner_id: uid, chat_id: d.chat_id, chat_title: d.chat_title,
        title: d.title, text: d.text, winners: d.winners, endTs,
        message_id: res.result.message_id, finished: false,
      });
      await addToOwnerList(env, uid, gid);
      await addTimer(env, gid, endTs);
      await setParticipants(env, gid, {});
      await setState(env, uid, null);
      await alert("Опубликовано!", false);
      return send(env, chat_id, `✅ Конкурс #${gid} опубликован в канале «${escapeHtml(d.chat_title)}»!`);
    }
  }

  if (data.startsWith("join:")) {
    const gid = parseInt(data.split(":")[1], 10);
    const g = await getGiveaway(env, gid);
    if (!g) return alert("Конкурс не найден.");
    if (g.finished || Date.now() / 1000 >= g.endTs) return alert("Конкурс уже завершён.");

    const res = await tgApi(env, "getChatMember", { chat_id: g.chat_id, user_id: uid });
    const status = res.ok ? res.result.status : null;
    if (!["member", "administrator", "creator"].includes(status)) {
      return alert("Сначала подпишись на канал!");
    }

    const parts = await getParticipants(env, gid);
    if (parts[uid]) return alert("Ты уже участвуешь ✅");
    const name = `${user.first_name || ""} ${user.last_name || ""}`.trim() || "Участник";
    parts[uid] = name;
    await setParticipants(env, gid, parts);

    await alert("Ты в игре! Удачи 🍀");
    await tgApi(env, "editMessageReplyMarkup", {
      chat_id: g.chat_id, message_id: g.message_id,
      reply_markup: joinKeyboard(gid, Object.keys(parts).length),
    });
  }
}

// ---------- Итоги ----------
async function finishGiveaway(env, gid, cancelled) {
  const g = await getGiveaway(env, gid);
  if (!g || g.finished) return false;
  g.finished = true;
  await setGiveaway(env, gid, g);
  await removeTimer(env, gid);

  let text;
  if (cancelled) {
    text = `🚫 Конкурс «${escapeHtml(g.title)}» отменён.`;
  } else {
    const parts = await getParticipants(env, gid);
    const entries = Object.entries(parts);
    if (!entries.length) {
      text = `😔 Конкурс «${escapeHtml(g.title)}» завершён, но никто не участвовал.`;
    } else {
      const shuffled = entries.sort(() => Math.random() - 0.5);
      const winners = shuffled.slice(0, g.winners);
      const lines = winners.map(([uid, name], i) => `${i + 1}. <a href="tg://user?id=${uid}">${escapeHtml(name)}</a>`);
      text = `🏆 <b>Итоги конкурса «${escapeHtml(g.title)}»</b>\n\nУчастников: ${entries.length}\n\nПобедители:\n${lines.join("\n")}\n\nПоздравляем! 🎉`;
    }
  }

  if (g.message_id) {
    await send(env, g.chat_id, text, { reply_to_message_id: g.message_id });
    await tgApi(env, "editMessageReplyMarkup", { chat_id: g.chat_id, message_id: g.message_id, reply_markup: { inline_keyboard: [] } });
  } else {
    await send(env, g.chat_id, text);
  }
  return true;
}

async function checkTimers(env) {
  const list = await getTimersList(env);
  const now = Date.now() / 1000;
  for (const t of list) {
    if (t.endTs <= now) await finishGiveaway(env, t.gid, false);
  }
}

// ---------- Точка входа ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/check-timers") {
      await checkTimers(env);
      return new Response("ok");
    }

    if (request.method !== "POST") {
      return new Response("Bot is running");
    }

    let update;
    try {
      update = await request.json();
    } catch (e) {
      return new Response("bad request", { status: 400 });
    }

    let botId = parseInt(BOT_TOKEN.split(":")[0], 10);

    try {
      if (update.message) {
        await handleMessage(env, update.message, botId);
      } else if (update.callback_query) {
        await handleCallback(env, update.callback_query, botId);
      }
    } catch (e) {
      console.error("Error:", e);
    }

    return new Response("ok");
  },

  async scheduled(event, env, ctx) {
    await checkTimers(env);
  },
};
