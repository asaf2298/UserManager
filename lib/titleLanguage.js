/**
 * Title language / origin helpers for alias selection.
 * Manami synonyms are untagged — detect script and prefer origin-country languages.
 */

const HIRAGANA = /[\u3040-\u309f]/;
const KATAKANA = /[\u30a0-\u30ff\uff66-\uff9d]/;
const KANJI = /[\u3400-\u9fff]/;
const KO_HANGUL = /[\uac00-\ud7af]/;
const CYRILLIC = /[\u0400-\u04ff]/;
const HEBREW = /[\u0590-\u05ff]/;
const ARABIC = /[\u0600-\u06ff]/;
const THAI = /[\u0e00-\u0e7f]/;
const GREEK = /[\u0370-\u03ff]/;

/** Detect primary script/language of a title string. */
export function detectTitleLanguage(title) {
  const t = String(title || '');
  if (!t.trim()) return null;
  // Kana ⇒ Japanese (even when mixed with kanji)
  if (HIRAGANA.test(t) || KATAKANA.test(t)) return 'ja';
  if (KO_HANGUL.test(t)) return 'ko';
  if (CYRILLIC.test(t)) return 'ru';
  if (HEBREW.test(t)) return 'he';
  if (ARABIC.test(t)) return 'ar';
  if (THAI.test(t)) return 'th';
  if (GREEK.test(t)) return 'el';
  // Pure Han without kana — Chinese (or kanji-only JP); treat as zh for synonym tagging
  if (KANJI.test(t)) return 'zh';
  if (/^[\x20-\x7E]+$/.test(t)) return 'latin';
  return 'other';
}

/**
 * Infer ISO origin countries from Manami tags.
 * Priority: Korean production → Chinese/donghua → Japanese (default empty if unknown).
 */
export function inferOriginCountriesFromManamiTags(tags) {
  const t = new Set((tags || []).map(x => String(x).toLowerCase()));

  if (
    t.has('korean animation') ||
    t.has('south korean production') ||
    t.has('north korean production')
  ) {
    return ['KR'];
  }
  if (t.has('taiwanese production')) return ['TW'];
  if (
    t.has('chinese animation') ||
    t.has('chinese production') ||
    t.has('donghua')
  ) {
    return ['CN'];
  }
  if (t.has('sino-japanese co-production')) return ['JP', 'CN'];
  if (t.has('korean-japanese co-production')) return ['JP', 'KR'];
  if (t.has('japanese production') || t.has('japan')) return ['JP'];
  return [];
}

/**
 * Preferred alias languages for a title row.
 * Uses origin_countries when set; anime with unknown origin falls back to Japanese.
 */
export function preferredAliasLanguages(row) {
  const countries = Array.isArray(row?.origin_countries)
    ? row.origin_countries.map(c => String(c).toUpperCase())
    : [];
  const langs = [];

  if (countries.includes('JP')) langs.push('ja');
  if (countries.includes('KR') || countries.includes('KP')) langs.push('ko');
  if (countries.includes('CN') || countries.includes('TW') || countries.includes('HK')) {
    langs.push('zh');
  }
  if (countries.includes('RU')) langs.push('ru');
  if (countries.includes('IL')) langs.push('he');

  // Unknown anime origin → Japanese majority default (do NOT force ja when KR/CN set)
  if (!langs.length && row?.category === 'anime') langs.push('ja');

  return [...new Set(langs)];
}

/**
 * True for ASCII titles that look like Japanese romanization (useful torrent search).
 */
export function isRomajiLike(title) {
  const t = String(title || '').trim();
  if (!/^[\x20-\x7E]+$/.test(t)) return false;
  if (t.length < 6) return false;
  if (/\b(no|wa|ga|wo|ni|kara|made|tachi|chan|kun|san|sama|senpai)\b/i.test(t)) return true;
  if (/[A-Z][a-z]+\s+[A-Z][a-z]+/.test(t) && /[aeiou]{2}|shi|chi|tsu|kyo|ryu|jou|shou/i.test(t)) {
    return true;
  }
  if (/^Re[:\.]/i.test(t)) return true;
  return false;
}

function isCleanLatin(title) {
  const t = String(title || '').trim();
  if (!/^[\x20-\x7E]+$/.test(t) || t.length < 3) return false;
  if (/[àáâãäåæçèéêëìíîïñòóôõöøùúûüýÿžščćđ]/i.test(t)) return false;
  return true;
}

/** Ingest weight for a synonym given detected language + kind. */
export function aliasIngestWeight(kind, language, preferredLangs = []) {
  if (kind === 'display') return 25;
  if (preferredLangs.includes(language)) return 40;
  if (language === 'ja' || language === 'ko' || language === 'zh') return 30;
  if (language === 'latin') return 12;
  return 3;
}

/**
 * Keep this synonym for an anime title?
 * Prefers origin-native scripts (ja/ko/zh) + clean romanization; drops random EU/ME translations.
 */
export function shouldKeepAnimeAlias(kind, language, title, preferredLangs = ['ja']) {
  if (kind === 'display') return true;
  if (preferredLangs.includes(language)) return true;

  if (language === 'latin') {
    if (preferredLangs.includes('ja') && isRomajiLike(title)) return true;
    // Korean / Chinese romanization (pinyin / revised romanization) — clean ASCII only
    if (
      (preferredLangs.includes('ko') || preferredLangs.includes('zh')) &&
      isCleanLatin(title)
    ) {
      return true;
    }
  }
  return false;
}
