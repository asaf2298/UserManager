/**
 * api/kodi.js used to ignore userKey entirely and always score with the fixed
 * "kodi" profile, so per-user USER_CONFIGS entries set up for Kodi callers
 * (e.g. one user on "everything", another on "friends_light") had no effect.
 * resolveKodiProfile() now mirrors the Stremio path's per-userKey profile
 * lookup, with a capable-client overlay applied on top unconditionally.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveKodiProfile } from '../api/kodi.js';

test('resolveKodiProfile fully swaps to a configured user profile, with capable overlay', () => {
  process.env.USER_CONFIGS = JSON.stringify({
    kodi_user1: { profile: 'everything' },
    kodi_user2: { profile: 'friends_light' },
  });

  const everything = resolveKodiProfile('kodi_user1');
  assert.equal(everything.profileName, 'everything');
  assert.equal(everything.profile.target, 30);
  assert.equal(everything.profile.diversity.provider, 2.00);
  assert.equal(everything.profile.clientClass, 'capable');
  assert.ok(everything.profile.timeoutMs >= 9500);
  assert.ok(everything.profile.collectionCutoffMs >= 7000);

  const friendsLight = resolveKodiProfile('kodi_user2');
  assert.equal(friendsLight.profileName, 'friends_light');
  assert.equal(friendsLight.profile.target, 10);
  assert.equal(friendsLight.profile.diversity.provider, 4.00);
  assert.equal(friendsLight.profile.clientClass, 'capable');
  // friends_light's own timeoutMs (9000) / collectionCutoffMs (5500) must be
  // widened, not left as-is, since the capable overlay is a floor.
  assert.ok(friendsLight.profile.timeoutMs >= 9500);
  assert.ok(friendsLight.profile.collectionCutoffMs >= 7000);

  delete process.env.USER_CONFIGS;
});

test('resolveKodiProfile falls back to the fixed "kodi" profile for missing/unknown userKey', () => {
  delete process.env.USER_CONFIGS;
  const noKey = resolveKodiProfile(undefined);
  assert.equal(noKey.profileName, 'kodi');
  assert.equal(noKey.profile.target, 100);
  assert.equal(noKey.profile.clientClass, 'capable');

  process.env.USER_CONFIGS = JSON.stringify({ someone_else: { profile: 'family' } });
  const unknownKey = resolveKodiProfile('not_configured');
  assert.equal(unknownKey.profileName, 'kodi');
  delete process.env.USER_CONFIGS;
});
