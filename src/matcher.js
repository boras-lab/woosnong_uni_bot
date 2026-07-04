// src/matcher.js
// Умный поиск ответа — порт Python-алгоритма на JavaScript.
//
// Алгоритм:
// 1. Нормализация: строчные, казахские символы → русские аналоги, убрать пунктуацию
// 2. Токенизация: разбить на слова, убрать стоп-слова
// 3. Оценка каждой FAQ-записи по трём метрикам:
//    a) % слов запроса, найденных в ключевых словах (query-side overlap)
//    b) % ключевых слов, найденных в запросе (kw-side overlap)
//    c) нечёткое совпадение с текстом вопроса (fuzzball)
// 4. Вернуть лучший ответ, если оценка >= порога

'use strict'

const fuzz = require('fuzzball')
const { FAQ_RU, FAQ_KZ } = require('./knowledgeBase')

// ──────────────────────────────────────────────────────────────
// Казахские символы → русские аналоги
// ──────────────────────────────────────────────────────────────
const KAZ_MAP = {
  қ: 'к', Қ: 'к',
  ң: 'н', Ң: 'н',
  ғ: 'г', Ғ: 'г',
  ү: 'у', Ү: 'у',
  ұ: 'у', Ұ: 'у',
  ө: 'о', Ө: 'о',
  і: 'и', І: 'и',
  ә: 'а', Ә: 'а',
}

const STOP_WORDS = new Set([
  // Русские
  'и', 'в', 'не', 'на', 'с', 'по', 'для', 'из', 'к', 'о', 'от',
  'до', 'но', 'или', 'а', 'же', 'бы', 'ли', 'у', 'за', 'со',
  'при', 'что', 'как', 'это', 'так', 'он', 'она', 'они', 'мне',
  'мы', 'вы', 'ты', 'я', 'есть', 'если', 'то',
  // Казахские (упрощённые)
  'де', 'ме', 'ба', 'ма', 'ше', 'бе', 'не', 'да',
  'ол', 'бул', 'осы', 'немесе', 'бар', 'жок', 'болады', 'алады',
])

/**
 * Нормализует строку:
 * - строчные буквы
 * - казахские символы → русские аналоги
 * - убирает пунктуацию
 * - сжимает пробелы
 */
function normalize(text) {
  let s = text.toLowerCase()
  for (const [kaz, rus] of Object.entries(KAZ_MAP)) {
    s = s.replaceAll(kaz, rus)
  }
  // Нормализуем латинскую 'i' внутри кириллических слов → 'и'
  // (казахи иногда вводят тiл вместо тіл)
  s = s.replace(/([а-яё])i([а-яё])/g, '$1и$2')
  s = s.replace(/([а-яё])i\b/g, '$1и')
  s = s.replace(/\bi([а-яё])/g, 'и$1')
  s = s.replace(/[^\wа-яёa-z0-9\s]/gi, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

/**
 * Токенизирует нормализованный текст.
 * Возвращает Set значимых токенов (длина > 2, не стоп-слова).
 */
function tokenize(text) {
  const tokens = normalize(text).split(' ')
  return new Set(tokens.filter(t => t.length > 2 && !STOP_WORDS.has(t)))
}

/**
 * Пересечение двух Set
 */
function intersectionSize(a, b) {
  let count = 0
  for (const v of a) if (b.has(v)) count++
  return count
}

/**
 * Вычисляет оценку совпадения запроса с одной FAQ-записью.
 * Возвращает число [0, 1].
 */
function scoreEntry(query, entry) {
  const queryNorm = normalize(query)
  const queryTokens = tokenize(query)

  // Нормализованные ключевые слова (flat set из всех слов всех keyword-фраз)
  const kwTokens = new Set()
  for (const kw of entry.keywords) {
    for (const t of normalize(kw).split(' ')) {
      if (t.length > 2) kwTokens.add(t)
    }
  }

  const scores = []

  // ── 1. Перекрытие ключевых слов (с обеих сторон) ───────────
  if (kwTokens.size > 0 && queryTokens.size > 0) {
    const inter = intersectionSize(queryTokens, kwTokens)
    const querySide = inter / queryTokens.size   // % слов запроса, найденных в KW
    const kwSide    = inter / kwTokens.size      // % KW, найденных в запросе
    scores.push(Math.min(Math.max(querySide, kwSide) * 1.7, 1.0))
  }

  // ── 2. Нечёткое совпадение с текстом вопроса ───────────────
  const qNorm = normalize(entry.question)
  const partialRatio   = fuzz.partial_ratio(queryNorm, qNorm) / 100
  const tokenSetRatio  = fuzz.token_set_ratio(queryNorm, qNorm) / 100
  scores.push(Math.max(partialRatio, tokenSetRatio) * 0.60)

  // ── 3. Вхождение длинных ключевых слов как подстрок ─────────
  const longKws = [...kwTokens].filter(kw => kw.length > 3)
  if (longKws.length > 0) {
    const hits = longKws.filter(kw => queryNorm.includes(kw)).length
    scores.push(hits / longKws.length)
  }

  // ── 4. Якорные слова: уникальные сигналы данной записи ───────
  // Если хотя бы одно якорное слово встречается в запросе — запись
  // сразу получает высокий балл и побеждает над конкурентами.
  const anchors = entry.anchors || []
  if (anchors.some(a => queryNorm.includes(normalize(a)))) {
    scores.push(1.01) // Превышает максимум keyword-балла → однозначная победа
  }

  return scores.length ? Math.max(...scores) : 0
}

/**
 * Ищет наиболее подходящий ответ на вопрос пользователя.
 *
 * @param {string} userQuery  - текст вопроса
 * @param {string} lang       - 'ru' или 'kz'
 * @param {number} [threshold=0.28] - минимальный порог оценки
 * @returns {string|null}     - текст ответа или null
 */
function findBestAnswer(userQuery, lang, threshold = 0.38) {
  const faq = lang === 'ru' ? FAQ_RU : FAQ_KZ

  let bestScore = 0
  let bestAnswer = null

  for (const entry of faq) {
    const score = scoreEntry(userQuery, entry)
    if (score > bestScore) {
      bestScore = score
      bestAnswer = entry.answer
    }
  }

  return bestScore >= threshold ? bestAnswer : null
}

module.exports = { findBestAnswer, normalize }
