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
  // Pure Han without kana — usually Chinese synonym in Manami dumps
  if (KANJI.test(t)) return 'zh';
  if (/^[\x20-\x7E]+$/.test(t)) return 'latin';
  return 'other';
}

/**
 * Preferred alias languages for a title row.
 * Anime defaults to Japanese even when origin_countries is empty.
 */
export function preferredAliasLanguages(row) {
  const countries = Array.isArray(row?.origin_countries)
    ? row.origin_countries.map(c => String(c).toUpperCase())
    : [];
  const langs = [];

  if (countries.includes('JP') || row?.category === 'anime') langs.push('ja');
  if (countries.includes('KR')) langs.push('ko');
  if (countries.includes('CN') || countries.includes('TW') || countries.includes('HK')) langs.push('zh');
  if (countries.includes('RU')) langs.push('ru');
  if (countries.includes('IL')) langs.push('he');

  // Dedupe
  return [...new Set(langs)];
}

/**
 * True for ASCII titles that look like Japanese romanization (useful torrent search).
 * Heuristic: latin words + common romaji particles / longish multi-token titles.
 */
export function isRomajiLike(title) {
  const t = String(title || '').trim();
  if (!/^[\x20-\x7E]+$/.test(t)) return false;
  if (t.length < 6) return false;
  // Common romaji particles / patterns
  if (/\b(no|wa|ga|wo|ni|kara|made|tachi|chan|kun|san|sama|senpai)\b/i.test(t)) return true;
  if (/[A-Z][a-z]+\s+[A-Z][a-z]+/.test(t) && /[aeiou]{2}|shi|chi|tsu|kyo|ryu|jou|shou/i.test(t)) return true;
  // Titles with colon / Re: style often romaji anime names
  if (/^Re[:\.]/i.test(t)) return true;
  return false;
}

/** Ingest weight for a synonym given detected language + kind. */
export function aliasIngestWeight(kind, language) {
  if (kind === 'display') return 25;
  if (language === 'ja') return 40;
  if (language === 'ko' || language === 'zh') return 35;
  if (language === 'latin') return 12;
  return 3; // foreign translations — keep low / usually filtered at ingest
}

/** Keep this synonym for anime (JP) pool? Prefer native + romaji, drop random EU translations. */
export function shouldKeepAnimeAlias(kind, language, title) {
  if (kind === 'display') return true;
  if (language === 'ja') return true;
  // Latin synonyms: only romaji-like (particles / anime romanization), not translated Romance titles
  if (language === 'latin' && isRomajiLike(title)) return true;
  return false;
}
