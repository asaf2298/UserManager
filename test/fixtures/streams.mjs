/**
 * Sanitized stream fixtures.
 *
 * Shapes are copied from real upstream responses (Torrentio, Comet, MediaFusion,
 * Yastream, Kan-Box, Knaben) with tokens and hostnames scrubbed. They exist to pin
 * behavior on the cases that historically broke ranking: fake 4K, packs vs
 * episodes, cross-provider duplicates, VIP, Hebrew releases, and malformed rows.
 */

export const TORRENTIO = 'https://torrentio.strem.fun/cfg000000000000000000000000';
export const COMET = 'https://comet.elfhosted.com/cfg111111111111111111111111';
export const MEDIAFUSION = 'https://mediafusion.elfhosted.com';
export const YASTREAM = 'https://yastream.example.net';
export const KANBOX = 'https://kan-box-addon.vercel.app';
export const PERSONAL_TELEGRAM = 'https://advantage-shot-petition-crucial.trycloudflare.com/As123456';
export const KNABEN = 'https://knaben.example.org';
export const UNKNOWN_HOST = 'https://random-indexer.example.com';

/** Attach source + provenance the way the retrieval stage does. */
export function withSource(stream, sourceBaseUrl, queryMode = 'canonical_id', extra = {}) {
  return {
    ...stream,
    _sourceBaseUrl: sourceBaseUrl,
    _provenance: {
      providerId: sourceBaseUrl,
      queryMode,
      queryHash: 'testhash01',
      episodeMappingVerified: true,
      responseStatus: 200,
      latencyMs: 120,
      ...extra,
    },
  };
}

/** Confirmed-cached 4K remux on a real debrid link: the strongest realistic row. */
export const cachedRemux4k = withSource({
  name: '[TB+] Torrentio\n4k',
  title: 'Dune Part Two 2024 2160p UHD BluRay REMUX DV HDR10 HEVC TrueHD Atmos 7.1-FraMeSToR\n👤 84 💾 71.2 GB',
  url: 'https://cdn.example.net/dl/aaa111/dune.mkv',
  infoHash: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
  // 71.2 GB, the trusted structured size field rather than the text estimate.
  behaviorHints: { videoSize: 76455165952, filename: 'dune.part.two.2024.remux.mkv' },
}, TORRENTIO);

/** Same release offered by a second provider — must collapse into one cluster. */
export const cachedRemux4kDuplicate = withSource({
  name: '[RD⚡] Comet 2160p',
  title: 'Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.DV.HDR10.HEVC.TrueHD.Atmos.7.1-FraMeSToR\n👤 79 💾 71.2 GB',
  url: 'https://cdn.example.net/dl/bbb222/dune.mkv',
  infoHash: 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555',
}, COMET);

/** Fake 4K: HDR claimed on an 8-bit x264 web rip. Credibility must drop. */
export const fake4k = withSource({
  name: 'Torrentio 4k',
  title: 'Dune Part Two 2024 2160p HDR WEBRip x264 AAC\n👤 12 💾 1.9 GB',
  infoHash: '1111aaaa2222bbbb3333cccc4444dddd5555eeee',
}, TORRENTIO);

/** Self-declared AI upscale. */
export const upscaled = withSource({
  name: 'Torrentio 4k',
  title: 'Old.Movie.1979.2160p.AI-Upscaled.BluRay.x265-GROUP\n👤 6 💾 22.0 GB',
  infoHash: '2222aaaa3333bbbb4444cccc5555dddd6666eeee',
}, TORRENTIO);

/** Healthy uncached P2P torrent: availability driven by the seeder band. */
export const uncachedHealthyP2P = withSource({
  name: 'Knaben 1080p',
  title: 'Dune.Part.Two.2024.1080p.BluRay.x264-SPARKS\n👤 220 💾 12.4 GB',
  infoHash: '3333aaaa4444bbbb5555cccc6666dddd7777eeee',
}, KNABEN);

/** Dead swarm: same claimed quality, far lower availability. */
export const uncachedDeadP2P = withSource({
  name: 'Knaben 1080p',
  title: 'Dune.Part.Two.2024.1080p.BluRay.x264-OTHERGRP\n👤 0 💾 11.8 GB',
  infoHash: '4444aaaa5555bbbb6666cccc7777dddd8888eeee',
}, KNABEN);

/** Bare [TB] means "will download to debrid", i.e. queued, not cached. */
export const queuedDebrid = withSource({
  name: '[TB] Yastream',
  title: 'Not cached stream [TB] click will download stream to TorBox | Dune Part Two 2024 1080p WEB-DL\n👤 31 💾 8.1 GB',
  infoHash: '5555aaaa6666bbbb7777cccc8888dddd9999eeee',
}, YASTREAM);

/** Kan-Box: host-authoritative VIP, direct owner link. */
export const vipKanBox = withSource({
  name: 'Kan-Box',
  title: 'דיון חלק שני',
  url: 'https://kan-box-addon.vercel.app/play/il_12345.m3u8',
}, KANBOX);

/** Personal Telegram addon: VIP via host-authoritative registry entry. */
export const vipPersonalTelegram = withSource({
  name: 'Personal Telegram',
  title: 'Dune Part Two 2024 1080p WEB-DL x264',
  url: 'https://advantage-shot-petition-crucial.trycloudflare.com/stream/tgfile_abc123.mkv',
}, PERSONAL_TELEGRAM);

/** MediaFusion telegram_bot title is not VIP without a host-authoritative provider. */
export const vipTelegram = withSource({
  name: 'MediaFusion',
  title: 'telegram_bot | Dune Part Two 2024 1080p WEB-DL x264',
  url: 'https://mediafusion.elfhosted.com/stream/direct/999.mkv',
}, MEDIAFUSION);

/** Same "telegram_bot" text from an unknown host must NOT become VIP. */
export const fakeVipUnknownHost = withSource({
  name: 'Random Indexer',
  title: 'telegram_bot your media Dune Part Two 2024 1080p WEB-DL',
  url: 'https://random-indexer.example.com/stream/1.mkv',
}, UNKNOWN_HOST);

/** ElfCache link: IP-locked, structurally unplayable through a proxy. */
export const ipLocked = withSource({
  name: 'MediaFusion',
  title: 'your media | Dune Part Two 2024 2160p',
  url: 'https://mediafusion.elfhosted.com/elfmagic/abc/dune.mkv',
}, MEDIAFUSION);

/** Hebrew release with Hebrew script in the title. */
export const hebrewRelease = withSource({
  name: '[TB+] Torrentio 1080p',
  title: 'דיון חלק שני 2024 1080p WEB-DL עברית HebDub\n👤 18 💾 7.4 GB',
  url: 'https://cdn.example.net/dl/heb1/dune.he.mkv',
  infoHash: '6666aaaa7777bbbb8888cccc9999dddd0000eeee',
}, TORRENTIO);

/** Wrong show entirely: must be dropped on content conflict. */
export const wrongShow = withSource({
  name: 'Torrentio 1080p',
  title: 'Revolutionary.Girl.Utena.S01E05.1080p.BluRay.x265-GROUP\n👤 9 💾 1.4 GB',
  infoHash: '7777aaaa8888bbbb9999cccc0000dddd1111eeee',
}, TORRENTIO);

/** Season pack: total size must not be read as one episode's size. */
export const seasonPack = withSource({
  name: 'Torrentio 1080p',
  title: 'Breaking.Bad.S03.COMPLETE.SEASON.1080p.BluRay.x265-GROUP\n👤 44 💾 62.0 GB',
  infoHash: '8888aaaa9999bbbb0000cccc1111dddd2222eeee',
}, TORRENTIO);

/** Single episode from the same torrent hash as the pack, different file. */
export const singleEpisode = withSource({
  name: 'Torrentio 1080p',
  title: 'Breaking.Bad.S03E05.1080p.BluRay.x265-GROUP\n👤 44 💾 2.1 GB',
  infoHash: '8888aaaa9999bbbb0000cccc1111dddd2222eeee',
  fileIdx: 5,
}, TORRENTIO);

/** Different episode, same hash: must stay separate from singleEpisode. */
export const otherEpisodeSameHash = withSource({
  name: 'Torrentio 1080p',
  title: 'Breaking.Bad.S03E06.1080p.BluRay.x265-GROUP\n👤 44 💾 2.2 GB',
  infoHash: '8888aaaa9999bbbb0000cccc1111dddd2222eeee',
  fileIdx: 6,
}, TORRENTIO);

/** CAM: family/light profiles must reject it outright. */
export const camRip = withSource({
  name: 'Torrentio 720p',
  title: 'Dune.Part.Two.2024.720p.HDCAM.x264-CAMGRP\n👤 55 💾 2.0 GB',
  infoHash: '9999aaaa0000bbbb1111cccc2222dddd3333eeee',
}, TORRENTIO);

/** No locator at all: ineligible. */
export const noLocator = withSource({
  name: 'Broken Provider',
  title: 'Dune Part Two 2024 1080p',
}, UNKNOWN_HOST);

/** Notice row masquerading as a stream. */
export const noticeRow = withSource({
  name: 'Comet',
  title: 'Unable to get metadata.',
  url: 'https://comet.elfhosted.com/',
}, COMET);

/** Garbled metadata: nothing parseable, but no conflict either. */
export const garbled = withSource({
  name: '???',
  title: '\u0000\u0001 ???? ####',
  url: 'https://cdn.example.net/dl/garbled/file.mkv',
}, UNKNOWN_HOST);

/** Externally-played row. */
export const externalOnly = withSource({
  name: 'Some Addon',
  title: 'Dune Part Two 2024 1080p WEB-DL',
  externalUrl: 'https://player.example.com/watch/123',
}, UNKNOWN_HOST);

export const DUNE_TITLES = ['Dune Part Two', 'Dune: Part Two', 'דיון חלק שני'];
export const BREAKING_BAD_TITLES = ['Breaking Bad'];

/** Everything except the intentionally-broken rows. */
export const MOVIE_SET = [
  cachedRemux4k, cachedRemux4kDuplicate, fake4k, upscaled, uncachedHealthyP2P,
  uncachedDeadP2P, queuedDebrid, vipKanBox, vipPersonalTelegram, vipTelegram, fakeVipUnknownHost,
  hebrewRelease, camRip, externalOnly,
];
