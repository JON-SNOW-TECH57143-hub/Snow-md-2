const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// ─── EXPRESS + SOCKET.IO ─────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', (_, res) => res.json({ status: 'alive', bot: config.botName, uptime: process.uptime() }));

// ─── SELF PING ───────────────────────────
const selfPing = () => {
  const url = process.env.RENDER_EXTERNAL_URL || process.env.RAILWAY_STATIC_URL || `http://localhost:${process.env.PORT || 3000}`;
  setInterval(async () => {
    try {
      const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
      await fetch(`${url}/health`);
      console.log(`✅ Self-ping OK — uptime: ${Math.floor(process.uptime())}s`);
    } catch (e) {
      console.warn('⚠️ Self-ping failed:', e.message);
    }
  }, 4 * 60 * 1000);
};

const store = makeInMemoryStore({ logger: pino({ level: 'silent' }) });

let sock = null;
let botReady = false;

// ─── START BOT ───────────────────────────
async function startBot(phoneNumber, socketId) {
  const emit = (event, data) => io.to(socketId).emit(event, data);

  // Clear old session if exists
  if (fs.existsSync(config.sessionFolder)) {
    fs.rmSync(config.sessionFolder, { recursive: true, force: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(config.sessionFolder);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: ['SNOW MD', 'Chrome', '120.0.0'],
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 20000,
    retryRequestDelayMs: 2000,
  });

  store.bind(sock.ev);

  // Request pairing code
  if (!sock.authState.creds.registered) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const code = await sock.requestPairingCode(phoneNumber);
      const formatted = code.match(/.{1,4}/g).join('-');
      console.log(`\n🔑 Pairing Code: ${formatted}\n`);
      emit('pairing_code', { code: formatted });
    } catch (err) {
      emit('error', { message: 'Failed to get pairing code: ' + err.message });
    }
  }

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log('❌ Connection closed, code:', code);
      if (shouldReconnect) {
        console.log('🔄 Reconnecting...');
        emit('status', { message: '🔄 Reconnecting...', type: 'warning' });
        setTimeout(() => reconnectBot(), 5000);
      } else {
        emit('status', { message: '🚪 Logged out. Please restart.', type: 'error' });
        botReady = false;
      }
    } else if (connection === 'open') {
      console.log(`✅ ${config.botName} connected!`);
      botReady = true;
      emit('connected', { message: `✅ ${config.botName} connected successfully!` });

      // Auto-follow newsletter
      try {
        await sock.followNewsletter(config.newsletter);
        console.log('📢 Auto-followed newsletter');
      } catch (_) {}

      // Notify dev
      try {
        await sock.sendMessage(`${config.devNumber}@s.whatsapp.net`, {
          text: `╔══════════════════════╗\n║  ✅ ${config.botName} ONLINE ║\n╚══════════════════════╝\n\n🟢 Bot connected!\n⏰ ${new Date().toLocaleString()}`,
        });
      } catch (_) {}
    } else if (connection === 'connecting') {
      emit('status', { message: '🔗 Connecting to WhatsApp...', type: 'info' });
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ─── MESSAGE HANDLER ───────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const from = msg.key.remoteJid;
      const isGroup = from.endsWith('@g.us');
      const body =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption || '';

      const prefix = config.prefix;
      if (!body.startsWith(prefix)) continue;

      const args = body.slice(prefix.length).trim().split(/\s+/);
      const cmd = args.shift().toLowerCase();
      const text = args.join(' ');

      const reply = async (content) => {
        if (typeof content === 'string') {
          await sock.sendMessage(from, { text: content }, { quoted: msg });
        } else {
          await sock.sendMessage(from, content, { quoted: msg });
        }
      };

      const isOwner = (msg.key.participant || from).replace('@s.whatsapp.net', '') === config.devNumber;

      try {
        await handleCommand(cmd, args, text, from, msg, reply, isGroup, isOwner, sock);
      } catch (err) {
        console.error(`❌ Command [${cmd}] error:`, err.message);
        await reply(`❌ Error: ${err.message}`);
      }
    }
  });
}

// ─── RECONNECT (keep session) ────────────
async function reconnectBot() {
  const { state, saveCreds } = await useMultiFileAuthState(config.sessionFolder);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: ['SNOW MD', 'Chrome', '120.0.0'],
    markOnlineOnConnect: true,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 20000,
  });

  store.bind(sock.ev);
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => reconnectBot(), 5000);
      }
    } else if (connection === 'open') {
      console.log('✅ Reconnected!');
      botReady = true;
      try { await sock.followNewsletter(config.newsletter); } catch (_) {}
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const from = msg.key.remoteJid;
      const isGroup = from.endsWith('@g.us');
      const body =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption || '';
      const prefix = config.prefix;
      if (!body.startsWith(prefix)) continue;
      const args = body.slice(prefix.length).trim().split(/\s+/);
      const cmd = args.shift().toLowerCase();
      const text = args.join(' ');
      const reply = async (content) => {
        if (typeof content === 'string') {
          await sock.sendMessage(from, { text: content }, { quoted: msg });
        } else {
          await sock.sendMessage(from, content, { quoted: msg });
        }
      };
      const isOwner = (msg.key.participant || from).replace('@s.whatsapp.net', '') === config.devNumber;
      try {
        await handleCommand(cmd, args, text, from, msg, reply, isGroup, isOwner, sock);
      } catch (err) {
        await reply(`❌ Error: ${err.message}`);
      }
    }
  });
}

// ─── COMMANDS ────────────────────────────
async function handleCommand(cmd, args, text, from, msg, reply, isGroup, isOwner, sock) {
  const now = new Date();

  switch (cmd) {

    // ══════════════════════════════════════
    //  GENERAL
    // ══════════════════════════════════════
    case 'menu':
    case 'help': {
      await reply(`╔═══════════════════════════╗
║       *${config.botName}*        ║
╚═══════════════════════════╝

👑 *Dev:* ${config.devName}
🔗 *Channel:* ${config.channelLink}
⚙️ *Prefix:* ${config.prefix}

╔══ 🌐 GENERAL ══╗
▸ ${config.prefix}menu / help
▸ ${config.prefix}ping
▸ ${config.prefix}alive
▸ ${config.prefix}info
▸ ${config.prefix}time
▸ ${config.prefix}date
▸ ${config.prefix}uptime
▸ ${config.prefix}follow

╔══ 🎲 FUN ══╗
▸ ${config.prefix}joke
▸ ${config.prefix}quote
▸ ${config.prefix}fact
▸ ${config.prefix}8ball <question>
▸ ${config.prefix}roll <sides>
▸ ${config.prefix}flip
▸ ${config.prefix}rate <thing>
▸ ${config.prefix}ship <name1> <name2>
▸ ${config.prefix}choose <a|b|c>
▸ ${config.prefix}rps <rock/paper/scissors>
▸ ${config.prefix}lucky
▸ ${config.prefix}roast
▸ ${config.prefix}compliment
▸ ${config.prefix}riddle
▸ ${config.prefix}truth
▸ ${config.prefix}dare

╔══ 🛠️ TOOLS ══╗
▸ ${config.prefix}calc <expr>
▸ ${config.prefix}touppercase <text>
▸ ${config.prefix}tolowercase <text>
▸ ${config.prefix}reverse <text>
▸ ${config.prefix}count <text>
▸ ${config.prefix}repeat <n> <text>
▸ ${config.prefix}ascii <text>
▸ ${config.prefix}base64enc <text>
▸ ${config.prefix}base64dec <text>
▸ ${config.prefix}password <length>
▸ ${config.prefix}uuid
▸ ${config.prefix}colorhex
▸ ${config.prefix}poll <question|opt1|opt2>
▸ ${config.prefix}tinyurl <url>
▸ ${config.prefix}define <word>
▸ ${config.prefix}weather <city>
▸ ${config.prefix}translate <lang> <text>
▸ ${config.prefix}currency <amt> <from> <to>

╔══ 👥 GROUP ══╗
▸ ${config.prefix}kick @user
▸ ${config.prefix}promote @user
▸ ${config.prefix}demote @user
▸ ${config.prefix}mute
▸ ${config.prefix}unmute
▸ ${config.prefix}groupinfo
▸ ${config.prefix}invite
▸ ${config.prefix}setname <name>
▸ ${config.prefix}setdesc <desc>
▸ ${config.prefix}hidetag <msg>
▸ ${config.prefix}everyone
▸ ${config.prefix}welcome on/off

╔══ 🤖 AI ══╗
▸ ${config.prefix}ai <question>
▸ ${config.prefix}gpt <question>
▸ ${config.prefix}imagine <prompt>
▸ ${config.prefix}lyrics <song>
▸ ${config.prefix}story <topic>
▸ ${config.prefix}poem <topic>
▸ ${config.prefix}roastme

╔══ 👑 OWNER ONLY ══╗
▸ ${config.prefix}broadcast <msg>
▸ ${config.prefix}block @user
▸ ${config.prefix}unblock @user
▸ ${config.prefix}restart
▸ ${config.prefix}clearchat

_© ${config.botName} — ${config.devName}_`);
      break;
    }

    case 'ping': {
      const start = Date.now();
      await reply('🏓 Pong!');
      const ms = Date.now() - start;
      await sock.sendMessage(from, { text: `⚡ Speed: *${ms}ms*` }, { quoted: msg });
      break;
    }

    case 'alive': {
      await reply(`╔══════════════════════╗
║  ✅ BOT IS ALIVE!  ║
╚══════════════════════╝

🤖 *${config.botName}* is running!
⏱️ Uptime: *${formatUptime(process.uptime())}*
🌐 Node: *${process.version}*
💾 RAM: *${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB*`);
      break;
    }

    case 'info': {
      await reply(`╔══════════════════════╗
║    BOT INFORMATION   ║
╚══════════════════════╝

🤖 *Name:* ${config.botName}
👑 *Dev:* ${config.devName}
📞 *Contact:* wa.me/${config.devNumber}
🔗 *Channel:* ${config.channelLink}
⚙️ *Prefix:* ${config.prefix}
📦 *Version:* 1.0.0
🟢 *Status:* Online`);
      break;
    }

    case 'time': {
      await reply(`🕐 *Current Time*\n${now.toLocaleTimeString('en-US', { hour12: true })}`);
      break;
    }

    case 'date': {
      await reply(`📅 *Today's Date*\n${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`);
      break;
    }

    case 'uptime': {
      await reply(`⏱️ *Bot Uptime*\n${formatUptime(process.uptime())}`);
      break;
    }

    case 'follow': {
      try {
        await sock.followNewsletter(config.newsletter);
        await reply(`✅ Successfully followed *${config.botName}* official channel!\n🔗 ${config.channelLink}`);
      } catch (_) {
        await reply(`🔗 Follow our channel:\n${config.channelLink}`);
      }
      break;
    }

    // ══════════════════════════════════════
    //  FUN
    // ══════════════════════════════════════
    case 'joke': {
      const jokes = [
        "Why don't scientists trust atoms? Because they make up everything! 😂",
        "I told my wife she was drawing her eyebrows too high. She looked surprised. 😂",
        "Why can't you give Elsa a balloon? Because she'll let it go! 😂",
        "What do you call a fake noodle? An impasta! 😂",
        "Why did the scarecrow win an award? He was outstanding in his field! 😂",
        "I'm reading a book about anti-gravity. It's impossible to put down! 😂",
        "What do you call cheese that isn't yours? Nacho cheese! 😂",
        "Why did the math book look so sad? Because it had too many problems! 😂",
        "What do you call a sleeping dinosaur? A dino-snore! 😂",
        "Why don't eggs tell jokes? They'd crack each other up! 😂",
      ];
      await reply(`😂 *Joke of the Moment*\n\n${jokes[Math.floor(Math.random() * jokes.length)]}`);
      break;
    }

    case 'quote': {
      const quotes = [
        '"The only way to do great work is to love what you do." — Steve Jobs',
        '"Life is what happens when you\'re busy making other plans." — John Lennon',
        '"The future belongs to those who believe in the beauty of their dreams." — Eleanor Roosevelt',
        '"It is during our darkest moments that we must focus to see the light." — Aristotle',
        '"Spread love everywhere you go." — Mother Teresa',
        '"When you reach the end of your rope, tie a knot in it and hang on." — Franklin D. Roosevelt',
        '"Don\'t judge each day by the harvest you reap but by the seeds that you plant." — R.L. Stevenson',
        '"You only live once, but if you do it right, once is enough." — Mae West',
        '"In three words I can sum up everything I\'ve learned about life: it goes on." — Robert Frost',
        '"An unexamined life is not worth living." — Socrates',
      ];
      await reply(`💬 *Quote*\n\n${quotes[Math.floor(Math.random() * quotes.length)]}`);
      break;
    }

    case 'fact': {
      const facts = [
        "🧠 Honey never spoils. Archaeologists have found 3,000-year-old honey in Egyptian tombs.",
        "🐙 Octopuses have three hearts and blue blood.",
        "🌍 A day on Venus is longer than a year on Venus.",
        "🦈 Sharks are older than trees. They've existed for about 400 million years.",
        "🐘 Elephants are the only animals that can't jump.",
        "🍌 Bananas are berries, but strawberries are not.",
        "🌊 The ocean covers about 71% of Earth's surface.",
        "⚡ Lightning strikes the Earth about 100 times per second.",
        "🦋 Butterflies taste with their feet.",
        "🧊 Hot water can freeze faster than cold water (Mpemba effect).",
      ];
      await reply(`💡 *Random Fact*\n\n${facts[Math.floor(Math.random() * facts.length)]}`);
      break;
    }

    case '8ball': {
      if (!text) return reply(`❓ Usage: ${config.prefix}8ball <question>`);
      const answers = [
        '✅ It is certain.', '✅ Without a doubt.', '✅ Yes, definitely!',
        '✅ You may rely on it.', '✅ Most likely.', '🤔 Reply hazy, try again.',
        '🤔 Ask again later.', '🤔 Cannot predict now.', '❌ Don\'t count on it.',
        '❌ My reply is no.', '❌ Very doubtful.', '❌ Outlook not so good.',
      ];
      await reply(`🎱 *Magic 8-Ball*\n\n❓ ${text}\n\n${answers[Math.floor(Math.random() * answers.length)]}`);
      break;
    }

    case 'roll': {
      const sides = parseInt(args[0]) || 6;
      const result = Math.floor(Math.random() * sides) + 1;
      await reply(`🎲 *Dice Roll (D${sides})*\n\nResult: *${result}*`);
      break;
    }

    case 'flip': {
      const result = Math.random() < 0.5 ? '🪙 HEADS' : '🪙 TAILS';
      await reply(`*Coin Flip*\n\nResult: *${result}*`);
      break;
    }

    case 'rate': {
      if (!text) return reply(`Usage: ${config.prefix}rate <thing>`);
      const rating = Math.floor(Math.random() * 11);
      const bar = '█'.repeat(rating) + '░'.repeat(10 - rating);
      await reply(`⭐ *Rating: ${text}*\n\n[${bar}] ${rating}/10`);
      break;
    }

    case 'ship': {
      if (args.length < 2) return reply(`Usage: ${config.prefix}ship <name1> <name2>`);
      const name1 = args[0], name2 = args[1];
      const love = Math.floor(Math.random() * 101);
      const bar = '❤️'.repeat(Math.floor(love / 10)) + '🖤'.repeat(10 - Math.floor(love / 10));
      await reply(`💕 *Love Ship*\n\n${name1} + ${name2}\n\n${bar}\n💞 *${love}% compatible!*`);
      break;
    }

    case 'choose': {
      if (!text) return reply(`Usage: ${config.prefix}choose <option1|option2|option3>`);
      const options = text.split('|').map(o => o.trim()).filter(Boolean);
      if (options.length < 2) return reply('Please provide at least 2 options separated by |');
      const chosen = options[Math.floor(Math.random() * options.length)];
      await reply(`🤔 *I choose...*\n\n✅ *${chosen}*`);
      break;
    }

    case 'rps': {
      if (!text) return reply(`Usage: ${config.prefix}rps <rock/paper/scissors>`);
      const choices = ['rock', 'paper', 'scissors'];
      const emojis = { rock: '🪨', paper: '📄', scissors: '✂️' };
      const userChoice = text.toLowerCase();
      if (!choices.includes(userChoice)) return reply('Choose: rock, paper, or scissors');
      const botChoice = choices[Math.floor(Math.random() * 3)];
      let result;
      if (userChoice === botChoice) result = "It's a draw! 🤝";
      else if ((userChoice === 'rock' && botChoice === 'scissors') ||
               (userChoice === 'paper' && botChoice === 'rock') ||
               (userChoice === 'scissors' && botChoice === 'paper')) result = 'You win! 🎉';
      else result = 'Bot wins! 🤖';
      await reply(`🎮 *Rock Paper Scissors*\n\nYou: ${emojis[userChoice]} ${userChoice}\nBot: ${emojis[botChoice]} ${botChoice}\n\n${result}`);
      break;
    }

    case 'lucky': {
      const num = Math.floor(Math.random() * 1000) + 1;
      await reply(`🍀 *Your Lucky Number Today*\n\n✨ *${num}* ✨`);
      break;
    }

    case 'roast': {
      const roasts = [
        "You're the human equivalent of a participation trophy. 🏆",
        "I'd agree with you, but then we'd both be wrong. 😂",
        "You have the charisma of a wet sock. 🧦",
        "Your WiFi password is probably 'password123'. 💻",
        "You're proof that evolution can go in reverse. 🦧",
      ];
      await reply(`🔥 *Roast*\n\n${roasts[Math.floor(Math.random() * roasts.length)]}`);
      break;
    }

    case 'compliment': {
      const compliments = [
        "You're more fun than bubble wrap! 🫧",
        "You're smarter than Google! 🧠",
        "Your smile could light up a city! 😊",
        "You make the world a better place just by being in it! 🌍",
        "You're a true gem and the world is lucky to have you! 💎",
      ];
      await reply(`💝 *Compliment*\n\n${compliments[Math.floor(Math.random() * compliments.length)]}`);
      break;
    }

    case 'riddle': {
      const riddles = [
        { q: "I speak without a mouth and hear without ears. I have no body, but I come alive with the wind. What am I?", a: "An Echo" },
        { q: "The more you take, the more you leave behind. What am I?", a: "Footsteps" },
        { q: "I have cities, but no houses live there. I have mountains, but no trees grow there. What am I?", a: "A Map" },
        { q: "What has hands but can't clap?", a: "A Clock" },
        { q: "What gets wetter the more it dries?", a: "A Towel" },
      ];
      const r = riddles[Math.floor(Math.random() * riddles.length)];
      await reply(`🧩 *Riddle*\n\n${r.q}\n\n||Answer: ${r.a}||`);
      break;
    }

    case 'truth': {
      const truths = [
        "What is your biggest fear?",
        "What's the most embarrassing thing you've done?",
        "Who was your first crush?",
        "What's a secret you've never told anyone?",
        "What's the biggest lie you've ever told?",
        "Have you ever cheated on a test?",
        "What's your most embarrassing childhood memory?",
      ];
      await reply(`🫣 *Truth*\n\n${truths[Math.floor(Math.random() * truths.length)]}`);
      break;
    }

    case 'dare': {
      const dares = [
        "Send a voice note saying 'I love you' to the last person you called.",
        "Change your status to 'I eat socks for breakfast' for 1 hour.",
        "Send a funny GIF to 3 people in your contacts.",
        "Do 10 pushups right now.",
        "Send a selfie with a funny face to this chat.",
        "Call someone and sing Happy Birthday even if it's not their birthday.",
      ];
      await reply(`😈 *Dare*\n\n${dares[Math.floor(Math.random() * dares.length)]}`);
      break;
    }

    // ══════════════════════════════════════
    //  TOOLS
    // ══════════════════════════════════════
    case 'calc':
    case 'calculate': {
      if (!text) return reply(`Usage: ${config.prefix}calc <expression>\nExample: ${config.prefix}calc 2+2*10`);
      try {
        const result = Function('"use strict"; return (' + text.replace(/[^0-9+\-*/.()%^ ]/g, '') + ')')();
        await reply(`🧮 *Calculator*\n\n📥 Input: ${text}\n📤 Result: *${result}*`);
      } catch {
        await reply('❌ Invalid expression!');
      }
      break;
    }

    case 'touppercase':
    case 'upper': {
      if (!text) return reply(`Usage: ${config.prefix}upper <text>`);
      await reply(`🔠 ${text.toUpperCase()}`);
      break;
    }

    case 'tolowercase':
    case 'lower': {
      if (!text) return reply(`Usage: ${config.prefix}lower <text>`);
      await reply(`🔡 ${text.toLowerCase()}`);
      break;
    }

    case 'reverse': {
      if (!text) return reply(`Usage: ${config.prefix}reverse <text>`);
      await reply(`🔄 ${text.split('').reverse().join('')}`);
      break;
    }

    case 'count': {
      if (!text) return reply(`Usage: ${config.prefix}count <text>`);
      await reply(`📊 *Text Stats*\n\nCharacters: *${text.length}*\nWords: *${text.split(/\s+/).length}*\nSentences: *${(text.match(/[.!?]+/g) || []).length || 1}*`);
      break;
    }

    case 'repeat': {
      const n = parseInt(args[0]) || 1;
      const t = args.slice(1).join(' ');
      if (!t) return reply(`Usage: ${config.prefix}repeat <number> <text>`);
      if (n > 20) return reply('Maximum 20 repetitions!');
      await reply(Array(n).fill(t).join('\n'));
      break;
    }

    case 'base64enc': {
      if (!text) return reply(`Usage: ${config.prefix}base64enc <text>`);
      await reply(`🔐 *Base64 Encoded*\n\n${Buffer.from(text).toString('base64')}`);
      break;
    }

    case 'base64dec': {
      if (!text) return reply(`Usage: ${config.prefix}base64dec <text>`);
      try {
        await reply(`🔓 *Base64 Decoded*\n\n${Buffer.from(text, 'base64').toString('utf8')}`);
      } catch {
        await reply('❌ Invalid Base64 string!');
      }
      break;
    }

    case 'password': {
      const len = Math.min(parseInt(args[0]) || 12, 64);
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()';
      const pwd = Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      await reply(`🔑 *Generated Password (${len} chars)*\n\n\`${pwd}\`\n\n⚠️ _Don't share this with anyone!_`);
      break;
    }

    case 'uuid': {
      const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
      await reply(`🆔 *Generated UUID*\n\n\`${uuid}\``);
      break;
    }

    case 'colorhex': {
      const hex = '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0').toUpperCase();
      await reply(`🎨 *Random Color*\n\nHEX: \`${hex}\`\n\nVisit: https://www.color-hex.com/color/${hex.slice(1)}`);
      break;
    }

    case 'poll': {
      if (!text || !text.includes('|')) return reply(`Usage: ${config.prefix}poll <question|option1|option2>\nExample: ${config.prefix}poll Favourite color?|Red|Blue|Green`);
      const parts = text.split('|').map(p => p.trim());
      const question = parts[0];
      const options = parts.slice(1);
      const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
      const optText = options.map((o, i) => `${emojis[i]} ${o}`).join('\n');
      await reply(`📊 *POLL*\n\n❓ *${question}*\n\n${optText}\n\n_Vote by replying with the number!_`);
      break;
    }

    case 'ascii': {
      if (!text) return reply(`Usage: ${config.prefix}ascii <text>`);
      const map = { A:'/-\\', B:'|3', C:'(', D:'|)', E:'3', F:'|=', G:'6', H:'|-|', I:'|', J:'_|', K:'|<', L:'|_', M:'|V|', N:'|\\|', O:'0', P:'|D', Q:'0_', R:'|2', S:'5', T:'+', U:'|_|', V:'\\/', W:'\\/\\/', X:'><', Y:'`/', Z:'2' };
      const res = text.toUpperCase().split('').map(c => map[c] || c).join(' ');
      await reply(`🔡 *ASCII Art*\n\n${res}`);
      break;
    }

    case 'story': {
      if (!text) return reply(`Usage: ${config.prefix}story <topic>`);
      const stories = [
        `Once upon a time, in a world where ${text} ruled everything, a young hero named Alex set out on an epic journey. With nothing but courage and a dream, Alex faced every obstacle head-on. In the end, ${text} became a symbol of hope for all. The end. 📖`,
        `In a land filled with ${text}, there lived a mysterious stranger. Nobody knew where they came from, but they changed everything. Thanks to the power of ${text}, the world was never the same again. 🌟`,
      ];
      await reply(`📖 *Mini Story: ${text}*\n\n${stories[Math.floor(Math.random() * stories.length)]}`);
      break;
    }

    case 'poem': {
      if (!text) return reply(`Usage: ${config.prefix}poem <topic>`);
      await reply(`📜 *Poem: ${text}*\n\nIn the land of ${text} so bright,\nWhere dreams take shape and stars ignite.\nThrough every storm and darkest night,\n${text} remains our guiding light.\n\nSo hold it close within your heart,\nA timeless, ever-glowing art.\nFor ${text} is where all journeys start,\nA masterpiece, a work of art.\n\n_— ${config.botName}_`);
      break;
    }

    case 'ai':
    case 'gpt': {
      if (!text) return reply(`Usage: ${config.prefix}ai <question>`);
      await reply(`🤖 *AI Response*\n\n_Processing your question about "${text}"..._\n\n💡 This feature requires an AI API key. Contact ${config.devName} to enable it!\n📞 wa.me/${config.devNumber}`);
      break;
    }

    case 'lyrics': {
      if (!text) return reply(`Usage: ${config.prefix}lyrics <song name>`);
      await reply(`🎵 *Lyrics: ${text}*\n\n_Searching for lyrics..._\n\nThis feature uses a lyrics API. Make sure GENIUS_API_KEY is set in your environment.\n\nContact: wa.me/${config.devNumber}`);
      break;
    }

    case 'imagine': {
      if (!text) return reply(`Usage: ${config.prefix}imagine <prompt>`);
      await reply(`🎨 *Image Generation*\n\nPrompt: _${text}_\n\nThis feature requires an image generation API. Contact ${config.devName}!\n📞 wa.me/${config.devNumber}`);
      break;
    }

    case 'roastme': {
      const roastmes = [
        "You look like you were drawn with the wrong hand. 😂",
        "Your search history is probably the scariest thing on the internet. 😅",
        "You're the reason God created the mute button. 🔇",
        "You must have been born on a highway, because that's where most accidents happen. 💀",
      ];
      await reply(`🔥 *Roast incoming...*\n\n${roastmes[Math.floor(Math.random() * roastmes.length)]}`);
      break;
    }

    // ══════════════════════════════════════
    //  GROUP COMMANDS
    // ══════════════════════════════════════
    case 'groupinfo': {
      if (!isGroup) return reply('❌ This command is for groups only!');
      try {
        const groupMeta = await sock.groupMetadata(from);
        await reply(`👥 *Group Info*\n\n📛 Name: ${groupMeta.subject}\n👤 Members: ${groupMeta.participants.length}\n📝 Description: ${groupMeta.desc || 'None'}\n👑 Owner: ${groupMeta.owner || 'Unknown'}`);
      } catch {
        await reply('❌ Could not fetch group info!');
      }
      break;
    }

    case 'invite': {
      if (!isGroup) return reply('❌ Groups only!');
      try {
        const link = await sock.groupInviteCode(from);
        await reply(`🔗 *Group Invite Link*\n\nhttps://chat.whatsapp.com/${link}`);
      } catch {
        await reply('❌ I need to be admin to get the invite link!');
      }
      break;
    }

    case 'everyone':
    case 'hidetag': {
      if (!isGroup) return reply('❌ Groups only!');
      try {
        const groupMeta = await sock.groupMetadata(from);
        const members = groupMeta.participants.map(p => p.id);
        const msgText = text || '📢 Everyone!';
        await sock.sendMessage(from, {
          text: msgText,
          mentions: members,
        });
      } catch {
        await reply('❌ Could not mention everyone!');
      }
      break;
    }

    case 'kick': {
      if (!isGroup) return reply('❌ Groups only!');
      if (!isOwner) return reply('❌ Owner only command!');
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      if (!mentioned.length) return reply(`Usage: ${config.prefix}kick @user`);
      try {
        await sock.groupParticipantsUpdate(from, mentioned, 'remove');
        await reply(`✅ Successfully removed ${mentioned.length} member(s)!`);
      } catch {
        await reply('❌ I need admin privileges to kick members!');
      }
      break;
    }

    case 'promote': {
      if (!isGroup) return reply('❌ Groups only!');
      if (!isOwner) return reply('❌ Owner only command!');
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      if (!mentioned.length) return reply(`Usage: ${config.prefix}promote @user`);
      try {
        await sock.groupParticipantsUpdate(from, mentioned, 'promote');
        await reply(`✅ Successfully promoted ${mentioned.length} member(s) to admin!`);
      } catch {
        await reply('❌ Need admin privileges!');
      }
      break;
    }

    case 'demote': {
      if (!isGroup) return reply('❌ Groups only!');
      if (!isOwner) return reply('❌ Owner only command!');
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      if (!mentioned.length) return reply(`Usage: ${config.prefix}demote @user`);
      try {
        await sock.groupParticipantsUpdate(from, mentioned, 'demote');
        await reply(`✅ Successfully demoted ${mentioned.length} member(s)!`);
      } catch {
        await reply('❌ Need admin privileges!');
      }
      break;
    }

    case 'mute': {
      if (!isGroup) return reply('❌ Groups only!');
      if (!isOwner) return reply('❌ Owner only command!');
      try {
        await sock.groupSettingUpdate(from, 'announcement');
        await reply('🔇 Group muted! Only admins can send messages now.');
      } catch {
        await reply('❌ Need admin privileges!');
      }
      break;
    }

    case 'unmute': {
      if (!isGroup) return reply('❌ Groups only!');
      if (!isOwner) return reply('❌ Owner only command!');
      try {
        await sock.groupSettingUpdate(from, 'not_announcement');
        await reply('🔊 Group unmuted! Everyone can send messages now.');
      } catch {
        await reply('❌ Need admin privileges!');
      }
      break;
    }

    case 'setname': {
      if (!isGroup) return reply('❌ Groups only!');
      if (!isOwner) return reply('❌ Owner only command!');
      if (!text) return reply(`Usage: ${config.prefix}setname <new name>`);
      try {
        await sock.groupUpdateSubject(from, text);
        await reply(`✅ Group name changed to: *${text}*`);
      } catch {
        await reply('❌ Need admin privileges!');
      }
      break;
    }

    case 'setdesc': {
      if (!isGroup) return reply('❌ Groups only!');
      if (!isOwner) return reply('❌ Owner only command!');
      if (!text) return reply(`Usage: ${config.prefix}setdesc <description>`);
      try {
        await sock.groupUpdateDescription(from, text);
        await reply(`✅ Group description updated!`);
      } catch {
        await reply('❌ Need admin privileges!');
      }
      break;
    }

    // ══════════════════════════════════════
    //  OWNER COMMANDS
    // ══════════════════════════════════════
    case 'broadcast': {
      if (!isOwner) return reply('❌ Owner only command!');
      if (!text) return reply(`Usage: ${config.prefix}broadcast <message>`);
      await reply(`📢 Broadcast sent!\n\nMessage: ${text}\n\n_Note: Broadcast requires contacts list access._`);
      break;
    }

    case 'block': {
      if (!isOwner) return reply('❌ Owner only command!');
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      if (!mentioned.length) return reply(`Usage: ${config.prefix}block @user`);
      try {
        await sock.updateBlockStatus(mentioned[0], 'block');
        await reply(`✅ User blocked!`);
      } catch {
        await reply('❌ Could not block user!');
      }
      break;
    }

    case 'unblock': {
      if (!isOwner) return reply('❌ Owner only command!');
      const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
      if (!mentioned.length) return reply(`Usage: ${config.prefix}unblock @user`);
      try {
        await sock.updateBlockStatus(mentioned[0], 'unblock');
        await reply(`✅ User unblocked!`);
      } catch {
        await reply('❌ Could not unblock user!');
      }
      break;
    }

    case 'restart': {
      if (!isOwner) return reply('❌ Owner only command!');
      await reply('🔄 Restarting bot...');
      process.exit(0);
      break;
    }

    case 'clearchat': {
      if (!isOwner) return reply('❌ Owner only command!');
      await reply('🗑️ This command would clear chat history. Feature coming soon!');
      break;
    }

    // ══════════════════════════════════════
    //  DEFAULT
    // ══════════════════════════════════════
    default: {
      await reply(`❌ Unknown command: *${config.prefix}${cmd}*\n\nType *${config.prefix}menu* to see all commands.`);
    }
  }
}

// ─── HELPERS ─────────────────────────────
function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${d}d ${h}h ${m}m ${s}s`;
}

// ─── SOCKET.IO EVENTS ────────────────────
io.on('connection', (socket) => {
  console.log('🌐 Web client connected:', socket.id);

  socket.on('start_bot', async ({ phone }) => {
    if (!phone) return socket.emit('error', { message: 'Phone number is required!' });
    const clean = phone.replace(/[^0-9]/g, '');
    if (clean.length < 7) return socket.emit('error', { message: 'Invalid phone number!' });
    console.log(`📱 Starting bot for: ${clean}`);
    socket.emit('status', { message: '🚀 Starting bot...', type: 'info' });
    try {
      await startBot(clean, socket.id);
    } catch (err) {
      socket.emit('error', { message: err.message });
    }
  });

  socket.on('disconnect', () => {
    console.log('🌐 Web client disconnected:', socket.id);
  });
});

// ─── START SERVER ────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════╗`);
  console.log(`║   🌨️  SNOW MD BOT SERVER      ║`);
  console.log(`║   🌐 Port: ${PORT}               ║`);
  console.log(`╚══════════════════════════════╝\n`);
  selfPing();
});
