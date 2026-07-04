// index.js
// WhatsApp автоответчик — Woosong University Kazakhstan
// Использует Baileys (@whiskeysockets/baileys)
//
// Запуск:  node index.js
// При первом запуске в терминале появится QR-код — отсканируй в WhatsApp:
//   Настройки → Связанные устройства → Привязать устройство

'use strict'

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
} = require('@whiskeysockets/baileys')

const { Boom } = require('@hapi/boom')
const path = require('path')
const fs = require('fs')
const QRCode = require('qrcode')
const qrcodeTerminal = require('qrcode-terminal')
const pino = require('pino')

const { findBestAnswer } = require('./src/matcher')

// ──────────────────────────────────────────────────────────────
// Папка для хранения сессии (после первой авторизации QR не нужен)
// ──────────────────────────────────────────────────────────────
const AUTH_DIR = path.join(__dirname, 'auth_info')

// ──────────────────────────────────────────────────────────────
// Язык пользователя: Map<jid, 'ru'|'kz'>
// ──────────────────────────────────────────────────────────────
const userLang = new Map()

// ──────────────────────────────────────────────────────────────
// Тексты интерфейса
// ──────────────────────────────────────────────────────────────
const LANG_SELECT =
  '🌐 *Выберите язык / Тілді таңдаңыз:*\n\n' +
  '1️⃣  Русский\n' +
  '2️⃣  Қазақша\n\n' +
  '_Напишите 1 или 2 / 1 немесе 2 жазыңыз_'

const WELCOME = {
  ru:
    '👋 *Добро пожаловать в бот Woosong University Kazakhstan!*\n\n' +
    'Задайте любой вопрос об университете — отвечу.\n\n' +
    '💬 Примеры:\n' +
    '• Какие документы нужно подать?\n' +
    '• Нужен ли IELTS?\n' +
    '• Есть ли гранты?\n' +
    '• Какие специальности есть?\n\n' +
    '_Сменить язык: напишите_ *!язык*',
  kz:
    '👋 *Woosong University Kazakhstan ботына қош келдіңіз!*\n\n' +
    'Университет туралы кез келген сұрақ қойыңыз — жауап беремін.\n\n' +
    '💬 Мысалдар:\n' +
    '• Қандай құжаттар керек?\n' +
    '• IELTS міндетті ме?\n' +
    '• Грант бар ма?\n' +
    '• Қандай мамандықтар бар?\n\n' +
    '_Тілді ауыстыру: жазыңыз_ *!тіл*',
}

const NOT_FOUND = {
  ru:
    '� Бот не может ответить на этот вопрос.\n\n' +
    'Пожалуйста, ожидайте ответа приёмной комиссии 📞\n\n' +
    '_Либо спросите о: документах, IELTS, ЕНТ, грантах, специальностях._',
  kz:
    '🤖 Бот бұл сұраққа жауап бере алмайды.\n\n' +
    'Қабылдау комиссиясының жауабын күтіңіз 📞\n\n' +
    '_Немесе мыналар туралы сұраңыз: құжаттар, IELTS, ҰБТ, гранттар, мамандықтар._',
}

const FAREWELL_REPLY = {
  ru:
    '😊 Пожалуйста! Удачи с поступлением в Woosong University Kazakhstan! 🎓\n\n' +
    'Если появятся вопросы — возвращайтесь, всегда помогу. 👋',
  kz:
    '😊 Woosong University Kazakhstan-ға түсуде сәттілік тілейміз! 🎓\n\n' +
    'Сұрақтар туса — қайта жаз, әрқашан көмектесемін. 👋',
  default:
    '😊 Сәттілік! / Удачи! 🎓👋',
}

// Токены прощания (казахский ориг. + русская клавиатура + русский)
const _FAREWELL_TOKENS = new Set([
  'рахмет', 'рақмет', 'рахметті', 'рахметтi',
  'сауболынз', 'сауболыныз', 'сауболунiз', 'сауболыниз',
  'кошбол', 'кошболыныз', 'кошболунiз',
  'кездескенше',
  'спасибо', 'спасиб', 'спс', 'благодарю', 'благодарен', 'благодарна',
  'пока', 'досвидания', 'дасвидания',
])
// Подстроки прощания (проверяем в нормализованном тексте)
const _FAREWELL_PHRASES = [
  'рахмет', 'рақмет',
  'сау болыңыз', 'сау болыниз', 'сау болыныз',
  'қош бол', 'кош бол',
  'спасибо', 'спасиб', 'благодар',
  'пока', 'до свидания',
]

// Слова-блокировщики: если они есть после прощания — это вопрос, не прощание
const _FAREWELL_BLOCKERS = [
  'сурак', 'сурагым', 'сурагы', 'сурагыма',   // вопрос (каз.)
  'бiрак', 'бирак', 'алайда', 'дегенмен',       // но/однако (каз.)
  'грант', 'убт', 'ielts', 'айлтс', 'кужат',   // FAQ-тема
  'мамандык', 'колледж', 'балл',
  'но ', 'однако', 'кстати', 'вопрос',          // рус. связки
]

function _isFarewell(text) {
  if (text.length > 70) return false
  const n = text.toLowerCase()
    .replace(/[қҚ]/g, 'к').replace(/[ңҢ]/g, 'н').replace(/[ғҒ]/g, 'г')
    .replace(/[үҮ]/g, 'у').replace(/[ұҰ]/g, 'у').replace(/[өӨ]/g, 'о')
    .replace(/[іІ]/g, 'и').replace(/[әӘ]/g, 'а')
    .replace(/[^\wа-яёa-z0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim()

  // Если есть слово-блокировщик — это вопрос, а не прощание
  if (_FAREWELL_BLOCKERS.some(b => n.includes(b))) return false

  for (const t of n.split(' ')) if (_FAREWELL_TOKENS.has(t)) return true
  for (const p of _FAREWELL_PHRASES) if (n.includes(p)) return true
  return false
}

// ──────────────────────────────────────────────────────────────
// Обработка входящего сообщения
// ──────────────────────────────────────────────────────────────
async function handleMessage(sock, jid, text) {
  const trimmed = text.trim()
  const lower = trimmed.toLowerCase()
  const lang = userLang.get(jid)

  // ── Команды смены языка ───────────────────────────────────────
  if (['!язык', '!тіл', '!тил', '!language'].includes(lower)) {
    userLang.delete(jid)
    await sendText(sock, jid, LANG_SELECT)
    return
  }

  // ── Прощание ─────────────────────────────────────────────────
  if (_isFarewell(trimmed)) {
    await sendText(sock, jid, lang ? FAREWELL_REPLY[lang] : FAREWELL_REPLY.default)
    userLang.delete(jid)   // Сбрасываем язык — следующий диалог начнётся заново
    return
  }

  // ── Язык ещё не выбран ────────────────────────────────────────
  if (!lang) {
    if (trimmed === '1') {
      userLang.set(jid, 'ru')
      await sendText(sock, jid, WELCOME.ru)
    } else if (trimmed === '2') {
      userLang.set(jid, 'kz')
      await sendText(sock, jid, WELCOME.kz)
    } else {
      await sendText(sock, jid, LANG_SELECT)
    }
    return
  }

  // ── Поиск ответа ────────────────────────────────────────────
  let answer = findBestAnswer(trimmed, lang)

  // Если не нашли в текущем языке — пробуем во втором
  // (пользователь мог написать на другом языке)
  if (!answer) {
    const other = lang === 'ru' ? 'kz' : 'ru'
    answer = findBestAnswer(trimmed, other)
  }

  await sendText(sock, jid, answer || NOT_FOUND[lang])
}

// ──────────────────────────────────────────────────────────────
// Отправка текстового сообщения
// ──────────────────────────────────────────────────────────────
async function sendText(sock, jid, text) {
  await sock.sendMessage(jid, { text })
}

// ──────────────────────────────────────────────────────────────
// Сохранение QR-кода в PNG (рядом со скриптом)
// ──────────────────────────────────────────────────────────────
async function saveQRImage(qrData) {
  const filePath = path.join(__dirname, 'whatsapp-qr.png')
  await QRCode.toFile(filePath, qrData, { width: 512 })
  console.log('\n📸 QR-код сохранён в файл: ' + filePath)
  console.log('   Открой его и отсканируй через WhatsApp → Связанные устройства\n')
}

// ──────────────────────────────────────────────────────────────
// Вспомогательная задержка
// ──────────────────────────────────────────────────────────────
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// ──────────────────────────────────────────────────────────────
// Запуск бота (с экспоненциальным backoff при переподключении)
// ──────────────────────────────────────────────────────────────
async function startBot(attempt = 0) {
  const MAX_ATTEMPTS = 5
  const RETRY_DELAY_MS = Math.min(3000 * Math.pow(2, attempt), 60000) // 3s, 6s, 12s, 24s, 60s

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Woosong Bot', 'Chrome', '1.0.0'],
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    retryRequestDelayMs: 2000,
  })

  // ── Сохраняем учётные данные ──────────────────────────────
  sock.ev.on('creds.update', saveCreds)

  // ── Статус подключения + QR ──────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      // QR в терминале
      console.log('\n📱 Отсканируй QR-код в WhatsApp → Связанные устройства:\n')
      qrcodeTerminal.generate(qr, { small: true })
      // Также сохраняем PNG
      try { await saveQRImage(qr) } catch (_) {}
    }

    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      const isLoggedOut = code === DisconnectReason.loggedOut

      if (isLoggedOut) {
        console.log('� Устройство отвязано от WhatsApp. Удаляю сессию...')
        fs.rmSync(AUTH_DIR, { recursive: true, force: true })
        console.log('🔄 Генерирую новый QR-код — отсканируй снова...\n')
        await delay(2000)
        startBot(0)   // Перезапуск с нуля — покажет новый QR автоматически
      } else if (attempt < MAX_ATTEMPTS) {
        console.log(`🔄 Переподключение через ${RETRY_DELAY_MS / 1000}с... (попытка ${attempt + 1}/${MAX_ATTEMPTS})`)
        await delay(RETRY_DELAY_MS)
        startBot(attempt + 1)
      } else {
        console.error(`❌ Не удалось подключиться после ${MAX_ATTEMPTS} попыток. Перезапусти бота вручную.`)
        process.exit(1)
      }
    } else if (connection === 'open') {
      console.log('✅ Бот подключён к WhatsApp и готов к работе!')
      // Сбрасываем счётчик попыток при успешном подключении
      attempt = 0
    }
  })

  // ── Входящие сообщения ────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      // Пропускаем: нет сообщения, отправлено нами, широковещательный канал
      if (!msg.message || msg.key.fromMe) continue
      if (isJidBroadcast(msg.key.remoteJid)) continue

      const jid = msg.key.remoteJid
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        ''

      if (!text.trim()) continue

      console.log(`📨 [${jid}] ${text.slice(0, 80)}`)

      try {
        await handleMessage(sock, jid, text)
      } catch (err) {
        console.error('Ошибка обработки сообщения:', err)
      }
    }
  })
}

// ──────────────────────────────────────────────────────────────
startBot().catch(console.error)
